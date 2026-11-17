import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { load_assessment_bank } from '../src/assessment_bank.ts';
import type { AssessmentTask } from '../src/assessment_tasks.ts';

// Two fixed-data offline oracles. Neither evaluates submitted/model-generated code.
type Triple = [number, number, number];
type CompilerInput = { pointers: Triple; heap: Triple; partition: number };
type VariantName = 'cache' | 'erase' | 'recover' | 'bundle' | 'omit_restore' | 'aggressive' | 'hoist';
type GuardField = 'cse_minimal_guards' | 'erase_minimal_guards' | 'handler_minimal_guards' | 'bundle_minimal_guards' | 'omit_restore_minimal_guards' | 'aggressive_minimal_guards';
type ExpectedAnswer = Record<GuardField, number[]> & { hoist_erase_equivalent: boolean };
type PromptContract = {
    values: number[]; pointers: Triple[]; dividend: number; increment: number; handlerFallback: number;
    predicates: { bit: number; expression: string }[]; variants: Record<VariantName, number>; program: string;
};
const fieldVariants: Record<GuardField, VariantName> = {
    cse_minimal_guards: 'cache', erase_minimal_guards: 'erase', handler_minimal_guards: 'recover',
    bundle_minimal_guards: 'bundle', omit_restore_minimal_guards: 'omit_restore', aggressive_minimal_guards: 'aggressive',
};
const flagBits: Record<string, number> = { C: 1, D: 2, H: 4, R: 8, O: 16 };
const normalized = (text: string) => text.replace(/\s+/g, ' ').trim();
function compilerTask(): AssessmentTask {
    const task = load_assessment_bank('2.1').tasks.find(candidate => candidate.id === 'C2_Compiler_Exception_Guards');
    if (!task) throw new Error('Assessment 2.1 is missing C2_Compiler_Exception_Guards');
    return task;
}
function requiredMatch(text: string, pattern: RegExp): RegExpMatchArray {
    const match = text.match(pattern);
    if (!match) throw new Error('Compiler oracle cannot read prompt contract: ' + pattern.source);
    return match;
}
function readPromptContract(prompt: string): PromptContract {
    const values = requiredMatch(prompt, /Initially each cell is independently in \{([^}]+)\}/)[1]!.split(',').map(Number);
    const pointers = [...prompt.matchAll(/P\d+=\((\d+),(\d+),(\d+)\)/g)].map(match => [Number(match[1]), Number(match[2]), Number(match[3])] as Triple);
    const program = requiredMatch(prompt, /  a := \*p\n[\s\S]*?  return \[h\[0\], h\[1\], h\[2\]\]/)[0];
    const dividends = [...program.matchAll(/t := (\d+) \/ /g)].map(match => Number(match[1]));
    const increments = [...program.matchAll(/a \+ (\d+)/g)].map(match => Number(match[1]));
    if (dividends.length !== 2 || dividends.some(value => value !== dividends[0]) || increments.length !== 2 || increments.some(value => value !== increments[0])) {
        throw new Error('Compiler oracle found inconsistent arithmetic constants');
    }
    const handlerFallback = Number(requiredMatch(program, /if R then a else (-?\d+)/)[1]);
    const predicates = [...prompt.matchAll(/^bit (\d+): (.+)$/gm)].map(match => ({ bit: Number(match[1]), expression: match[2]!.trim() }));
    const variantDescriptions = [...prompt.matchAll(/(?:^- |Also define )(cache|erase|recover|bundle|omit_restore|aggressive|hoist): (.+)$/gm)];
    const variants = {} as Record<VariantName, number>;
    for (const match of variantDescriptions) {
        const name = match[1] as VariantName, description = match[2]!;
        let mask = description === 'all five are true.' ? 31 : 0;
        for (const assignment of description.matchAll(/([CDHRO](?:=[CDHRO])*)=(true|false)/g)) {
            for (const flag of assignment[1]!.split('=')) {
                const bit = flagBits[flag]!;
                if (assignment[2] === 'true') mask |= bit;
                else mask &= ~bit;
            }
        }
        variants[name] = mask;
    }
    if (Object.keys(variants).length !== 7) throw new Error('Compiler oracle is missing a named variant');
    return { values, pointers, dividend: dividends[0]!, increment: increments[0]!, handlerFallback, predicates, variants, program };
}
function inputsFromContract(contract: PromptContract): CompilerInput[] {
    const inputs: CompilerInput[] = [];
    for (let partition = 0; partition < contract.pointers.length; partition++) {
        for (const first of contract.values) for (const second of contract.values) for (const third of contract.values) {
            inputs.push({ pointers: contract.pointers[partition]!, heap: [first, second, third], partition: partition + 1 });
        }
    }
    return inputs;
}

// Oracle A: imperative AST evaluation, mutable cells and precise exception control flow.
type PointerName = 'p' | 'q' | 'r';
type LocalName = 'a' | 't';
type ArithmeticExpression = number | { kind: 'local'; name: LocalName } | { kind: 'load'; pointer: PointerName }
    | { kind: 'add' | 'divide'; left: ArithmeticExpression; right: ArithmeticExpression };
type EqualityCondition = { left: ArithmeticExpression; right: ArithmeticExpression };
type Statement = { kind: 'assign'; name: LocalName; value: ArithmeticExpression }
    | { kind: 'store'; pointer: PointerName; value: ArithmeticExpression }
    | { kind: 'if'; condition: EqualityCondition; body: Statement[] }
    | { kind: 'try'; body: Statement[]; handler: Statement[] };
class CompilerDivisionByZero extends Error {}
function buildCompilerAst(mask: number, contract: PromptContract): Statement[] {
    const a: ArithmeticExpression = { kind: 'local', name: 'a' };
    const loadP: ArithmeticExpression = { kind: 'load', pointer: 'p' };
    const increment: ArithmeticExpression = { kind: 'add', left: a, right: contract.increment };
    const division = (denominator: ArithmeticExpression): Statement => ({ kind: 'assign', name: 't', value: { kind: 'divide', left: contract.dividend, right: denominator } });
    const body: Statement[] = [];
    if (mask & 4) body.push(division(a));
    if (!(mask & 2)) body.push({ kind: 'store', pointer: 'q', value: increment });
    if (!(mask & 4)) body.push(division(mask & 1 ? a : loadP));
    body.push({ kind: 'store', pointer: 'r', value: { kind: 'local', name: 't' } });
    if (!(mask & 16)) body.push({ kind: 'store', pointer: 'q', value: a });
    return [
        { kind: 'assign', name: 'a', value: loadP },
        { kind: 'try', body, handler: [
            { kind: 'store', pointer: 'r', value: mask & 8 ? a : contract.handlerFallback },
            { kind: 'if', condition: { left: { kind: 'load', pointer: 'q' }, right: increment }, body: [{ kind: 'store', pointer: 'q', value: a }] },
        ] },
    ];
}
function runCompilerAst(program: Statement[], input: CompilerInput): Triple {
    const heap: Triple = [...input.heap], references: Record<PointerName, number> = { p: input.pointers[0], q: input.pointers[1], r: input.pointers[2] };
    const locals: Partial<Record<LocalName, number>> = {};
    function expression(node: ArithmeticExpression): number {
        if (typeof node === 'number') return node;
        switch (node.kind) {
            case 'local': {
                const value = locals[node.name];
                if (value === undefined) throw new Error('Compiler AST read an unassigned local');
                return value;
            }
            case 'load': return heap[references[node.pointer]]!;
            case 'add': return expression(node.left) + expression(node.right);
            case 'divide': {
                const numerator = expression(node.left), denominator = expression(node.right);
                if (denominator === 0) throw new CompilerDivisionByZero();
                const quotient = Math.floor(Math.abs(numerator) / Math.abs(denominator));
                return (numerator < 0) !== (denominator < 0) ? -quotient : quotient;
            }
        }
    }
    function statements(block: Statement[]): void {
        for (const statement of block) switch (statement.kind) {
            case 'assign': locals[statement.name] = expression(statement.value); break;
            case 'store': heap[references[statement.pointer]] = expression(statement.value); break;
            case 'if': if (expression(statement.condition.left) === expression(statement.condition.right)) statements(statement.body); break;
            case 'try':
                try { statements(statement.body); }
                catch (error) { if (!(error instanceof CompilerDivisionByZero)) throw error; statements(statement.handler); }
                break;
        }
    }
    statements(program);
    return heap;
}

// Oracle B: algebraic path summaries and simultaneous last-writer selection.
// No AST construction, statement execution, exception control flow or division helper is reused.
function runCompilerLastWriter(mask: number, input: CompilerInput, contract: PromptContract): Triple {
    const [p, q, r] = input.pointers, entry = input.heap[p]!;
    const divisor = (mask & 7) !== 0 || p !== q ? entry : entry + contract.increment;
    const fault = divisor === 0;
    const temporaryWrite = !(mask & 2) && !(fault && (mask & 4));
    const prefix = input.heap.map((value, cell) => cell === q && temporaryWrite ? entry + contract.increment : value);
    if (fault) {
        const catchValue = mask & 8 ? entry : contract.handlerFallback;
        const afterR = prefix.map((value, cell) => cell === r ? catchValue : value);
        const restore = afterR[q] === entry + contract.increment;
        return afterR.map((value, cell) => cell === q && restore ? entry : value) as Triple;
    }
    let remaining = Math.abs(contract.dividend), quotient = 0;
    while (remaining >= Math.abs(divisor)) { remaining -= Math.abs(divisor); quotient++; }
    if ((contract.dividend < 0) !== (divisor < 0)) quotient = -quotient;
    return prefix.map((value, cell) => cell === q && !(mask & 16) ? entry : cell === r ? quotient : value) as Triple;
}
const sameTriple = (first: Triple, second: Triple) => first.every((value, index) => value === second[index]);

// Independent guard interpretations: a truth bitset versus direct selected-atom evaluation.
function compilerGuardTruths(input: CompilerInput): number {
    const [p, q, r] = input.pointers, a = input.heap[p]!, valueQ = input.heap[q]!;
    return [p === q, q === r, p !== q, q !== r, a !== 0, a !== -1, valueQ === a, valueQ === a + 1, a === 0]
        .reduce((mask, value, index) => value ? mask | (1 << index) : mask, 0);
}
function compilerGuardHolds(mask: number, input: CompilerInput): boolean {
    for (let bit = 1; bit <= 256; bit *= 2) {
        if (!(mask & bit)) continue;
        const pointers = input.pointers, heap = input.heap;
        let holds: boolean;
        switch (bit) {
            case 1: holds = pointers[0] === pointers[1]; break;
            case 2: holds = pointers[1] === pointers[2]; break;
            case 4: holds = pointers[0] !== pointers[1]; break;
            case 8: holds = pointers[1] !== pointers[2]; break;
            case 16: holds = heap[pointers[0]] !== 0; break;
            case 32: holds = heap[pointers[0]] !== -1; break;
            case 64: holds = heap[pointers[1]] === heap[pointers[0]]; break;
            case 128: holds = heap[pointers[1]] === heap[pointers[0]]! + 1; break;
            case 256: holds = heap[pointers[0]] === 0; break;
            default: throw new Error('Compiler guard oracle encountered an unknown atom');
        }
        if (!holds) return false;
    }
    return true;
}
function minimalCompilerHittingSets(clauses: number[]): number[] {
    let candidates = new Set([0]);
    for (const clause of [...new Set(clauses)].sort((left, right) => left - right)) {
        const expanded = new Set<number>();
        for (const candidate of candidates) {
            if (candidate & clause) expanded.add(candidate);
            else for (let bit = 1; bit <= 256; bit *= 2) if (clause & bit) expanded.add(candidate | bit);
        }
        candidates = new Set([...expanded].filter(candidate => ![...expanded].some(other => other !== candidate && (other & candidate) === other)));
    }
    return [...candidates].sort((left, right) => left - right);
}
type GuardAudit = { matches: number[]; firstBad: number | undefined; status: 'unsatisfiable' | 'safe' | 'unsafe' };
type MinimalityCertificate = { mask: number; satisfyingInput: number; deletionWitnesses: { removedBit: number; input: number }[] };
type VariantAudit = { variant: number; guards: GuardAudit[]; formulaGuards: GuardAudit[]; minimal: number[]; hittingSets: number[]; certificates: MinimalityCertificate[] };
type CompilerReport = {
    contract: PromptContract; inputs: CompilerInput[]; ast: Triple[][]; formula: Triple[][];
    audits: Record<GuardField, VariantAudit>; expected: ExpectedAnswer; formulaExpected: ExpectedAnswer; digest: string;
};
let cachedReport: CompilerReport | undefined;
function compilerOracleReport(): CompilerReport {
    if (cachedReport) return cachedReport;
    const contract = readPromptContract(compilerTask().prompt), inputs = inputsFromContract(contract);
    const ast: Triple[][] = [], formula: Triple[][] = [], hash = createHash('sha256');
    for (let variant = 0; variant < 32; variant++) {
        const program = buildCompilerAst(variant, contract);
        ast[variant] = inputs.map(input => runCompilerAst(program, input));
        formula[variant] = inputs.map(input => runCompilerLastWriter(variant, input, contract));
        inputs.forEach((input, index) => hash.update(JSON.stringify({ variant, partition: input.partition, entry: input.heap, observation: ast[variant]![index] }) + '\n'));
    }
    const matches = Array.from({ length: 512 }, (_, mask) => inputs.flatMap((input, index) => (compilerGuardTruths(input) & mask) === mask ? [index] : []));
    const formulaMatches = Array.from({ length: 512 }, (_, mask) => inputs.flatMap((input, index) => compilerGuardHolds(mask, input) ? [index] : []));
    const audits = {} as Record<GuardField, VariantAudit>;
    const expected = {} as ExpectedAnswer, formulaExpected = {} as ExpectedAnswer;
    for (const [field, name] of Object.entries(fieldVariants) as [GuardField, VariantName][]) {
        const variant = contract.variants[name];
        const guards = matches.map(matching => {
            const firstBad = matching.find(index => !sameTriple(ast[variant]![index]!, ast[0]![index]!));
            return { matches: matching, firstBad, status: !matching.length ? 'unsatisfiable' : firstBad === undefined ? 'safe' : 'unsafe' } as GuardAudit;
        });
        const formulaGuards = formulaMatches.map(matching => {
            const firstBad = matching.find(index => !sameTriple(formula[variant]![index]!, formula[0]![index]!));
            return { matches: matching, firstBad, status: !matching.length ? 'unsatisfiable' : firstBad === undefined ? 'safe' : 'unsafe' } as GuardAudit;
        });
        const safe = guards.flatMap((guard, mask) => guard.status === 'safe' ? [mask] : []);
        const minimal = safe.filter(mask => !safe.some(other => other !== mask && (other & mask) === other));
        const clauses = inputs.flatMap((input, index) => {
            if (sameTriple(formula[variant]![index]!, formula[0]![index]!)) return [];
            let excludesInput = 0;
            for (let bit = 1; bit <= 256; bit *= 2) if (!compilerGuardHolds(bit, input)) excludesInput |= bit;
            return [excludesInput];
        });
        const hittingSets = minimalCompilerHittingSets(clauses).filter(mask => formulaMatches[mask]!.length > 0);
        const certificates = minimal.map(mask => {
            const satisfyingInput = guards[mask]!.matches[0];
            if (satisfyingInput === undefined) throw new Error('Compiler minimal guard is vacuously true');
            const deletionWitnesses: MinimalityCertificate['deletionWitnesses'] = [];
            for (let bit = 1; bit <= 256; bit *= 2) if (mask & bit) {
                const witness = guards[mask ^ bit]!.firstBad;
                if (witness === undefined) throw new Error('Compiler minimal guard has no predicate-deletion counterexample');
                deletionWitnesses.push({ removedBit: bit, input: witness });
            }
            return { mask, satisfyingInput, deletionWitnesses };
        });
        audits[field] = { variant, guards, formulaGuards, minimal, hittingSets, certificates };
        expected[field] = minimal;
        formulaExpected[field] = hittingSets;
    }
    expected.hoist_erase_equivalent = inputs.every((_, index) => sameTriple(ast[contract.variants.hoist]![index]!, ast[contract.variants.erase]![index]!));
    formulaExpected.hoist_erase_equivalent = inputs.every((_, index) => sameTriple(formula[contract.variants.hoist]![index]!, formula[contract.variants.erase]![index]!));
    return cachedReport = { contract, inputs, ast, formula, audits, expected, formulaExpected, digest: hash.digest('hex') };
}

describe('Assessment 2.1 compiler guard independent finite oracles', () => {
    test('the actual task prompt fixes the finite domain, arithmetic, predicates and complete program template', () => {
        const task = compilerTask(), contract = readPromptContract(task.prompt);
        expect(contract.values).toEqual([-2, -1, 0, 1, 2]);
        expect(contract.pointers).toEqual([[0, 0, 0], [0, 0, 1], [0, 1, 0], [0, 1, 1], [0, 1, 2]]);
        expect([contract.dividend, contract.increment, contract.handlerFallback]).toEqual([12, 1, -1]);
        expect(contract.predicates).toEqual([
            { bit: 1, expression: 'p==q' }, { bit: 2, expression: 'q==r' }, { bit: 4, expression: 'p!=q' }, { bit: 8, expression: 'q!=r' },
            { bit: 16, expression: 'A!=0' }, { bit: 32, expression: 'A!=-1' }, { bit: 64, expression: 'Q==A' }, { bit: 128, expression: 'Q==A+1' }, { bit: 256, expression: 'A==0' },
        ]);
        expect(contract.variants).toEqual({ cache: 1, erase: 2, recover: 8, bundle: 9, omit_restore: 16, aggressive: 31, hoist: 4 });
        expect(normalized(contract.program)).toBe(normalized(`a := *p
            try {
                if H then t := 12 / a
                if not D then *q := a + 1
                if not H then t := 12 / (if C then a else *p)
                *r := t
                if not O then *q := a
            } catch division_by_zero {
                *r := (if R then a else -1)
                if *q == a + 1 then *q := a
            }
            return [h[0], h[1], h[2]]`));
        for (const semantics of [
            'Arithmetic uses mathematical integers with no overflow', 'Integer division truncates toward zero.',
            'Previous stores remain visible; exceptions do not roll back memory.', 'Conditional expressions evaluate only their selected arm.',
            'No exception flag, local variable, read/write trace, or execution cost is observable.',
            'All predicates use the original input heap, before any program statement', 'no proper SUBMASK may itself be safe and admissible',
        ]) expect(task.prompt).toContain(semantics);
        expect(inputsFromContract(contract)).toHaveLength(625);
    });

    test('AST exceptions and algebraic last writers agree on all 20,000 complete observations', () => {
        const { inputs, ast, formula, digest } = compilerOracleReport();
        let comparisons = 0;
        for (let variant = 0; variant < 32; variant++) for (let input = 0; input < inputs.length; input++) {
            expect(ast[variant]![input]).toEqual(formula[variant]![input]);
            comparisons++;
        }
        expect(comparisons).toBe(20000);
        // Same variant/partition/heap ordering and compact JSONL encoding as the
        // independently executed Python audit; no 20,000-record fixture is needed.
        expect(digest).toBe('474ef6144f0ff6a61bd48c0683dc13ce1613431bab0f3b710e8d4d49ff26a167');
    });

    for (const field of Object.keys(fieldVariants) as GuardField[]) test(field + ' has independent complete guard and minimality certificates', () => {
        const { inputs, ast, formula, audits } = compilerOracleReport(), audit = audits[field];
        expect(audit.guards).toHaveLength(512);
        for (let mask = 0; mask < 512; mask++) expect(audit.guards[mask]).toEqual(audit.formulaGuards[mask]);
        expect(audit.minimal).toEqual(audit.hittingSets);
        for (const certificate of audit.certificates) {
            const guard = certificate.mask, positive = inputs[certificate.satisfyingInput]!;
            expect((compilerGuardTruths(positive) & guard) === guard).toBe(true);
            expect(compilerGuardHolds(guard, positive)).toBe(true);
            expect(audit.guards[guard]!.status).toBe('safe');
            expect(audit.formulaGuards[guard]!.status).toBe('safe');
            for (const deletion of certificate.deletionWitnesses) {
                const weaker = guard ^ deletion.removedBit, input = inputs[deletion.input]!;
                expect(compilerGuardHolds(weaker, input)).toBe(true);
                expect((compilerGuardTruths(input) & weaker) === weaker).toBe(true);
                expect(sameTriple(ast[audit.variant]![deletion.input]!, ast[0]![deletion.input]!)).toBe(false);
                expect(sameTriple(formula[audit.variant]![deletion.input]!, formula[0]![deletion.input]!)).toBe(false);
            }
        }
    });

    test('erase mask 6 covers all 125 p!=q,q==r inputs and both proper atoms have counterexamples', () => {
        const { inputs, ast, formula, audits } = compilerOracleReport(), audit = audits.erase_minimal_guards;
        expect(audit.minimal).toContain(6);
        expect(audit.guards[6]!.matches).toHaveLength(125);
        for (const index of audit.guards[6]!.matches) {
            const [p, q, r] = inputs[index]!.pointers;
            expect(p !== q && q === r).toBe(true);
            expect(ast[audit.variant]![index]).toEqual(ast[0]![index]);
            expect(formula[audit.variant]![index]).toEqual(formula[0]![index]);
        }
        for (const weaker of [0, 2, 4]) {
            const counterexample = audit.guards[weaker]!.firstBad;
            expect(counterexample).toBeDefined();
            if (counterexample === undefined) throw new Error('Missing erase mask 6 regression counterexample');
            expect(compilerGuardHolds(weaker, inputs[counterexample]!)).toBe(true);
            expect(ast[audit.variant]![counterexample]).not.toEqual(ast[0]![counterexample]);
            expect(formula[audit.variant]![counterexample]).not.toEqual(formula[0]![counterexample]);
        }
    });

    test('cache mask 128 remains predicate-inclusion minimal despite implying the different guard 4', () => {
        const { inputs, audits } = compilerOracleReport(), audit = audits.cse_minimal_guards;
        expect(audit.minimal).toContain(128);
        expect(audit.minimal).toContain(4);
        expect(audit.guards[128]!.matches.length).toBeGreaterThan(0);
        expect(audit.guards[128]!.matches.length).toBeLessThan(audit.guards[4]!.matches.length);
        for (const index of audit.guards[128]!.matches) expect(compilerGuardHolds(4, inputs[index]!)).toBe(true);
        expect((4 & 128) === 4).toBe(false);
        expect(audit.guards[0]!.status).toBe('unsafe');
        // Impossible conjunctions do not become safe by vacuity.
        for (const audit of Object.values(audits)) {
            expect(audit.guards[5]!.status).toBe('unsatisfiable');
            expect(audit.guards[272]!.status).toBe('unsatisfiable');
            expect(audit.minimal).not.toContain(5);
            expect(audit.hittingSets).not.toContain(272);
        }
    });

    test('all seven actual bank fields are independently derived and accepted by the grader', () => {
        const { expected, formulaExpected, audits } = compilerOracleReport();
        expect(expected).toEqual(formulaExpected);
        expect(Object.values(audits).reduce((count, audit) => count + audit.certificates.length, 0)).toBe(18);
        expect(Object.values(audits).reduce((count, audit) => count + audit.certificates.reduce((sum, certificate) => sum + certificate.deletionWitnesses.length, 0), 0)).toBe(34);
        const task = compilerTask();
        expect(task.grading).toEqual({ type: 'assessment-exact-fields-v1', name: 'grade', expected });
        expect(task.grade(JSON.stringify(expected))).toMatchObject({ content_score: 1, instruction_checks: { json_only: true, exact_fields: true } });
        expect(Object.values(task.grade(JSON.stringify(formulaExpected)).content_checks).every(Boolean)).toBe(true);
    });
});
