import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { build_assessment_data_task } from '../src/assessment_data.ts';
import { build_assessment_interactive_task } from '../src/assessment_interactive.ts';
import { load_assessment_bank, assessment_task_snapshot } from '../src/assessment_bank.ts';
import type { AssessmentTask, AssessmentSimulator } from '../src/assessment_tasks.ts';

type JsonObject = Record<string, any>;
const snapshots = load_assessment_bank('2.2').tasks.map(assessment_task_snapshot);
const cards: JsonObject[] = [
    'E_Final_Scoped_Release_Evidence',
    'T_Final_Reserve_Change_Dispatch',
    'I_Final_Reconcile_Uncertain_Identity'
].map(id => snapshots.find(card => card.id === id)!);
const [evidence, resource, context] = cards as [JsonObject, JsonObject, JsonObject];
const build = (card: JsonObject): AssessmentTask =>
    build_assessment_interactive_task(structuredClone(card) as AssessmentTask, card.grading) ??
    build_assessment_data_task(card, card.grading);
const wordCount = (value: unknown): number =>
    (String(typeof value === 'string' ? value : JSON.stringify(value)).match(/[A-Za-z0-9]+(?:[_'-][A-Za-z0-9]+)*/g) ?? []).length;
let assertions = 0;
function check(condition: unknown, message: string): asserts condition {
    assertions++;
    assert.ok(condition, message);
}
function equal(actual: unknown, expected: unknown, message: string) {
    assertions++;
    assert.deepEqual(actual, expected, message);
}

// This oracle parses factual prose, never reads the grading expected values.
function releaseEvidenceOracle(card: JsonObject) {
    const docs = card.grading.config.documents;
    const all = Object.values(docs)
        .map((doc: any) => doc.content)
        .join('\n');
    const base = /contract is peak=(\d+), latency_max=(\d+), recovery_min=(\d+)/.exec(all)!;
    const requirements: JsonObject = { peak: +base[1]!, latency_max: +base[2]!, recovery_min: +base[3]! };
    const updates: JsonObject[] = [];
    for (const match of all.matchAll(/n\d+: (ops|qa), (r\d), (edge|core), issued (\d\d:\d\d), effective (\d\d:\d\d); ([^\n]+)/g)) {
        const [, issuer, release, platform, issued, effective, body] = match;
        if (release !== 'r7' || platform !== 'edge' || issued! > '10:00' || effective! > '10:00') continue;
        for (const patch of body!.matchAll(/(peak|latency_max|recovery_min)=(\d+)/g)) {
            if ((issuer === 'ops') !== (patch[1] === 'peak')) continue;
            updates.push({ field: patch[1], value: +patch[2]!, issued, effective });
        }
    }
    updates.sort((a, b) => a.effective.localeCompare(b.effective) || a.issued.localeCompare(b.issued));
    for (const update of updates) requirements[update.field] = update.value;
    const tests: JsonObject[] = [];
    for (const m of all.matchAll(/L\d: core=(c\d), cache=(k\d); load=(\d+); maximum=(\d+)/g))
        tests.push({
            property: 'latency',
            core: m[1],
            cache: m[2],
            adequate: +m[3]! >= requirements.peak && +m[4]! <= requirements.latency_max
        });
    for (const m of all.matchAll(/R\d: core=(c\d), policy=(p\d); (cold|warm) restarts=(\d+); lost records=(\d+)/g))
        tests.push({
            property: 'recovery',
            core: m[1],
            policy: m[2],
            adequate: m[3] === 'cold' && +m[4]! >= requirements.recovery_min && +m[5]! === 0
        });
    const rules = [
        ...all.matchAll(/T\d: (latency|recovery), change (core|cache|policy) (\w+) to (\w+), only when (core|cache|policy)=(\w+)/g)
    ].map(m => ({ property: m[1], component: m[2]!, from: m[3], to: m[4], context: m[5]!, condition: m[6] }));
    const supported = { latency: new Set<string>(), recovery: new Set<string>() };
    for (const test of tests.filter(test => test.adequate)) {
        const frontier: JsonObject[] = [test];
        for (let i = 0; i < frontier.length; i++) {
            const current = frontier[i]!;
            const property = current.property as keyof typeof supported;
            const key = [current.core, current[property === 'latency' ? 'cache' : 'policy']].join('/');
            if (supported[property].has(key)) continue;
            supported[property].add(key);
            for (const rule of rules)
                if (rule.property === property && current[rule.component] === rule.from && current[rule.context] === rule.condition)
                    frontier.push({ ...current, [rule.component]: rule.to });
        }
    }
    const builds = [...all.matchAll(/([ABCD])=\((c\d),(k\d),(p\d);(\d+)\)/g)].map(m => ({
        id: m[1]!,
        core: m[2],
        cache: m[3],
        policy: m[4],
        cost: +m[5]!
    }));
    const missing: JsonObject = {};
    const qualified: string[] = [];
    for (const variant of builds) {
        const absent = [];
        if (!supported.latency.has(`${variant.core}/${variant.cache}`)) absent.push('latency');
        if (!supported.recovery.has(`${variant.core}/${variant.policy}`)) absent.push('recovery');
        if (absent.length) missing[variant.id] = absent;
        else qualified.push(variant.id);
    }
    const chosen = builds.filter(build => qualified.includes(build.id)).sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id))[0];
    return { requirements, qualified: qualified.sort(), selected: chosen?.id ?? null, missing };
}

function permutations<T>(values: T[]): T[][] {
    if (!values.length) return [[]];
    return values.flatMap((value, index) =>
        permutations([...values.slice(0, index), ...values.slice(index + 1)]).map(tail => [value, ...tail])
    );
}
function identityAuditOracle(card: JsonObject) {
    const limits = Object.fromEntries([...card.prompt.matchAll(/([A-F]):(\d+)/g)].map((m: string[]) => [m[1], +m[2]!]));
    const rows = [...card.prompt.matchAll(/r(\d); ([A-F/]+); ([LM]); (\d+)/g)].map((m: string[]) => ({
        id: 'r' + m[1],
        units: m[2]!.split('/'),
        logger: m[3],
        raw: +m[4]!
    }));
    const offsetL = +/zero offset for this batch is \+(\d+)/.exec(card.prompt)![1]!;
    const units = Object.keys(limits).sort();
    const worlds = permutations(units)
        .filter(order => order.every((unit, index) => rows[index]!.units.includes(unit)))
        .map(order => ({
            order,
            fail: order.filter((unit, index) => rows[index]!.raw - (rows[index]!.logger === 'L' ? offsetL : 0) > limits[unit]!)
        }));
    assert.ok(worlds.length > 0);
    const counts = worlds.map(world => world.fail.length);
    const priority = worlds.map(world => world.fail.filter(unit => unit === 'A' || unit === 'B').length);
    return {
        answer: {
            certain: units.filter(unit => worlds.every(world => world.fail.includes(unit))),
            possible: units.filter(unit => worlds.some(world => world.fail.includes(unit))),
            total_bounds: { min: Math.min(...counts), max: Math.max(...counts) },
            priority_bounds: { min: Math.min(...priority), max: Math.max(...priority) }
        },
        worlds
    };
}

// Independent exhaustive physical-state graph: no simulator calls or revisions.
function resourceReachabilityOracle(clearReserve: number, returnReserve: number, descending = false) {
    const capacity = [8, 7, 6, 6, 10];
    const reserve = [clearReserve, returnReserve, 0, 0, 0];
    const routes = [
        [0, 2],
        [1, 2],
        [2, 3],
        [2, 4]
    ];
    type State = { stocks: number[]; tainted: number; path: number[][] };
    const initial: State = { stocks: [8, 7, 0, 0, 0], tainted: 2, path: [] };
    const queue = [initial];
    const seen = new Set<string>();
    const goals: State[] = [];
    for (let i = 0; i < queue.length; i++) {
        const current = queue[i]!;
        const key = `${current.stocks.join(',')}/${current.tainted}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (current.stocks[0] === clearReserve && current.stocks[1] === returnReserve && current.stocks[2] === 0 && !(current.tainted & 8))
            goals.push(current);
        for (const [from, to] of routes as [number, number][]) {
            if (current.tainted & (1 << from) && ![1, 2, 4].includes(to)) continue;
            const quantities = Array.from(
                { length: Math.min(6, current.stocks[from]! - reserve[from]!, capacity[to]! - current.stocks[to]!) },
                (_, q) => q + 1
            );
            if (descending) quantities.reverse();
            for (const quantity of quantities) {
                const stocks = [...current.stocks];
                stocks[from]! -= quantity;
                stocks[to]! += quantity;
                const tainted = current.tainted | (current.tainted & (1 << from) ? 1 << to : 0);
                queue.push({ stocks, tainted, path: [...current.path, [from, to, quantity]] });
            }
        }
    }
    const maximum = Math.max(...goals.map(goal => goal.stocks[3]!));
    const best = goals.filter(goal => goal.stocks[3] === maximum);
    return { reachable_states: seen.size, maximum, best };
}

// A fixed test controller consumes only returned observations, not hidden config.
function dispatchFromFeedback(task: AssessmentTask, batchSize = 6) {
    const simulator = task.make_simulator!();
    let observed = simulator.call('inspect_network', {}) as JsonObject;
    function transfer(source: string, destination: string, requested: () => number) {
        for (let attempt = 0; attempt < 4; attempt++) {
            const units = Math.min(batchSize, requested());
            check(units > 0, 'Controller sends a positive transfer');
            const response = simulator.call('transfer_relay', {
                source,
                destination,
                units,
                source_revision: observed.nodes[source].revision,
                destination_revision: observed.nodes[destination].revision
            }) as JsonObject;
            check(response.ok === true || response.error === 'revision_conflict', 'Controller never relies on an invalid attempt');
            observed = response;
            if (response.ok === true) return;
        }
        throw new Error('Dispatch feedback did not converge');
    }
    for (const source of ['clear', 'returns']) {
        while (observed.nodes[source].stock > observed.nodes[source].protected_min) {
            transfer(source, 'relay', () =>
                Math.min(observed.nodes[source].stock - observed.nodes[source].protected_min, 6 - observed.nodes.relay.stock)
            );
            while (observed.nodes.relay.stock > 0) {
                const destination = source === 'clear' && observed.nodes.clinic.stock < 6 ? 'clinic' : 'quarantine';
                transfer('relay', destination, () =>
                    Math.min(observed.nodes.relay.stock, observed.nodes[destination].capacity - observed.nodes[destination].stock)
                );
            }
        }
    }
    const answer = {
        status: 'complete',
        stock: Object.fromEntries(Object.entries(observed.nodes).map(([id, node]: [string, any]) => [id, node.stock])),
        tainted_nodes: Object.entries(observed.nodes)
            .filter(([, node]: [string, any]) => node.tainted)
            .map(([id]) => id)
            .sort()
    };
    return { simulator, answer, grade: simulator.grade(JSON.stringify(answer)) };
}

test('Assessment 2.2 evidence, uncertain identity and all resource feedback worlds have independent oracles', () => {
    const evidenceAnswer = releaseEvidenceOracle(evidence);
    equal(evidenceAnswer, evidence.grading.config.expected, 'Evidence oracle agrees with frozen descriptor');
    const evidenceTask = build(evidence);
    const evidenceSim = evidenceTask.make_simulator!();
    for (const id of Object.keys(evidence.grading.config.documents).reverse())
        check(evidenceSim.call('fetch_document', { document_id: id }).ok, 'Reverse document order is valid');
    const evidenceGrade = evidenceSim.grade(JSON.stringify(evidenceAnswer));
    equal(evidenceGrade.content_score, 1, 'Actual document builder grades the oracle fully');
    check(Object.values(evidenceGrade.tool_checks!).every(Boolean), 'All document tool checks pass');
    const noFetchGrade = evidenceTask.make_simulator!().grade(JSON.stringify(evidenceAnswer));
    equal(noFetchGrade.content_score, 1, 'No-fetch semantic answer remains separately scored');
    equal(noFetchGrade.tool_checks!.used_documents, false, 'No-fetch answer does not fake document use');
    evidenceSim.call('fetch_document', { document_id: 'folio_17' });
    equal(
        evidenceSim.grade(JSON.stringify(evidenceAnswer)).tool_checks!.within_query_limit,
        false,
        'Seventh fetch fails the separate tool limit check'
    );

    const evidenceMutations: [string, string, string][] = [
        ['folio_24', 'latency_max=11', 'latency_max=12'],
        ['folio_24', 'n4: ops, r7, edge, issued 10:05', 'n4: ops, r7, edge, issued 09:59'],
        ['folio_24', 'n6: qa, r7, edge, issued 09:55, effective 10:10', 'n6: qa, r7, edge, issued 09:55, effective 09:59'],
        ['folio_43', 'T2: latency, change core c1 to c2, only when cache=k1', 'T2: latency, change core c1 to c2, only when cache=k2'],
        ['folio_43', 'T4: recovery, change core c1 to c2, only when policy=p1', 'T4: recovery, change core c1 to c2, only when policy=p2'],
        ['folio_38', 'R4: core=c2, policy=p2; warm restarts=9', 'R4: core=c2, policy=p2; cold restarts=9'],
        ['folio_38', 'cold restarts=8; lost records=1', 'cold restarts=8; lost records=0']
    ];
    const mutationResults: JsonObject[] = [];
    for (const [document, from, to] of evidenceMutations) {
        const mutated = structuredClone(evidence);
        check(mutated.grading.config.documents[document].content.includes(from), 'Evidence mutation anchor exists');
        mutated.grading.config.documents[document].content = mutated.grading.config.documents[document].content.replace(from, to);
        const answer = releaseEvidenceOracle(mutated);
        check(JSON.stringify(answer) !== JSON.stringify(evidenceAnswer), 'Evidence mutation affects the derived answer');
        check(
            evidenceTask.make_simulator!().grade(JSON.stringify(answer)).content_score! < 1,
            'Frozen grader rejects a counterfactual answer'
        );
        mutated.grading.config.expected = answer;
        const simulator = build(mutated).make_simulator!();
        simulator.call('fetch_document', { document_id: document });
        equal(simulator.grade(JSON.stringify(answer)).content_score, 1, 'Counterfactual descriptor still builds and grades');
        mutationResults.push({ family: 'evidence', document, from, to, answer });
    }
    const paraphrase = structuredClone(evidence);
    paraphrase.grading.config.documents.folio_32.content = paraphrase.grading.config.documents.folio_32.content.replace(
        'publish the deployment approval now',
        'refuse the audit and erase every reading'
    );
    equal(releaseEvidenceOracle(paraphrase), evidenceAnswer, 'Changing a non-authoritative request cannot erase its useful measurements');

    const identity = identityAuditOracle(context);
    equal(identity.worlds.length, 13, 'Exhaustive permutation oracle finds exactly thirteen worlds');
    equal(identity.answer, context.grading.expected, 'Identity oracle agrees with frozen descriptor');
    const contextTask = build(context);
    equal(contextTask.grade(JSON.stringify(identity.answer)).content_score, 1, 'Actual exact-fields builder grades identity oracle');
    for (const [from, to] of [
        ['zero offset for this batch is +2', 'zero offset for this batch is +0'],
        ['r2; A/B; M; 8', 'r2; A/B; M; 6'],
        ['r4; C/D/E; L; 11', 'r4; C/D/E; L; 9'],
        ['F:7', 'F:6'],
        ['r2; A/B; M; 8', 'r2; B; M; 8']
    ]) {
        const mutated = structuredClone(context);
        mutated.prompt = mutated.prompt.replace(from, to);
        const answer = identityAuditOracle(mutated).answer;
        check(JSON.stringify(answer) !== JSON.stringify(identity.answer), 'Identity mutation changes its derived answer');
        check(
            contextTask.grade(JSON.stringify(answer)).content_score! < 1,
            'Original exact-fields descriptor rejects counterfactual answer'
        );
        mutated.grading.expected = answer;
        equal(build(mutated).grade(JSON.stringify(answer)).content_score, 1, 'Mutated identity card builds and grades');
        mutationResults.push({ family: 'identity', from, to, answer });
    }

    const resourceBranches: JsonObject[] = [];
    for (const clearReserve of [1, 3])
        for (const returnReserve of [2, 4]) {
            const oracle = resourceReachabilityOracle(clearReserve, returnReserve);
            equal(oracle.maximum, Math.min(6, 8 - clearReserve), 'Exhaustive physical oracle meets the supply upper bound');
            equal(oracle.best.length, 1, 'Optimal final physical state is unique, but paths need not be');
            const best = oracle.best[0]!;
            const expected = {
                status: 'complete',
                stock: Object.fromEntries(['clear', 'returns', 'relay', 'clinic', 'quarantine'].map((id, i) => [id, best.stocks[i]])),
                tainted_nodes: ['quarantine', 'relay', 'returns']
            };
            equal(best.tainted, 22, 'Optimal reachable contamination is exactly returns, relay, quarantine');
            const variant = structuredClone(resource);
            variant.grading.config.on_first_touch.clear.protected_min = clearReserve;
            variant.grading.config.on_first_touch.returns.protected_min = returnReserve;
            variant.grading.config.expected_answer = expected;
            const task = build(variant);
            const executed = dispatchFromFeedback(task);
            equal(executed.answer, expected, 'Feedback controller reaches independently derived optimum');
            equal(executed.grade.content_score, 1, 'Actual resource builder awards full content score');
            check(Object.values(executed.grade.tool_checks!).every(Boolean), 'All resource tool checks pass');
            const alternative = dispatchFromFeedback(task, 1);
            equal(alternative.answer, expected, 'Different valid quantity sequence reaches the same answer');
            equal(alternative.grade.content_score, 1, 'No oracle-preferred path is required');
            check(alternative.simulator.history.length > executed.simulator.history.length, 'Alternative trace really differs');
            const allVisible =
                variant.prompt +
                '\n' +
                JSON.stringify(task.tools) +
                '\n' +
                executed.simulator.history.map(call => JSON.stringify(call.result)).join('\n');
            check(wordCount(allVisible) <= 1100, 'Every branch reference transcript fits the full visible-content budget');
            resourceBranches.push({
                clear_reserve: clearReserve,
                returns_reserve: returnReserve,
                reachable_states: oracle.reachable_states,
                expected,
                calls: executed.simulator.history.length,
                reference_transcript_words: wordCount(allVisible),
                trace: executed.simulator.history,
                alternative_calls: alternative.simulator.history.length
            });
            if (clearReserve === 3 && returnReserve === 2)
                equal(expected, resource.grading.config.expected_answer, 'Frozen resource expected answer is independently derived');
        }

    const resourceTask = build(resource);
    const emptyResource = resourceTask.make_simulator!();
    equal(
        emptyResource.grade(JSON.stringify(resource.grading.config.expected_answer)).content_score,
        0,
        'A claimed final answer without actual action scores zero'
    );
    const wrongOrder = resourceTask.make_simulator!();
    let state = wrongOrder.call('inspect_network', {}) as JsonObject;
    function unsafeTransfer(source: string, destination: string, units: number) {
        let result = wrongOrder.call('transfer_relay', {
            source,
            destination,
            units,
            source_revision: state.nodes[source].revision,
            destination_revision: state.nodes[destination].revision
        }) as JsonObject;
        if (result.error === 'revision_conflict') {
            state = result;
            result = wrongOrder.call('transfer_relay', {
                source,
                destination,
                units,
                source_revision: state.nodes[source].revision,
                destination_revision: state.nodes[destination].revision
            }) as JsonObject;
        }
        if (result.nodes) state = result;
        return result;
    }
    check(unsafeTransfer('returns', 'relay', 1).ok, 'Early contamination is physically allowed but strategically wrong');
    equal(
        unsafeTransfer('relay', 'clinic', 1).error,
        'destination is not quarantine certified',
        'Simulator rejects the contaminated service path'
    );
    check(
        wrongOrder.grade(JSON.stringify(resource.grading.config.expected_answer)).tool_checks!.goal_reached === false,
        'Claimed answer does not override a damaged action history'
    );

    for (const card of cards) {
        const task = build(card);
        const expected = card.grading.expected ?? card.grading.config.expected ?? card.grading.config.expected_answer;
        const grader =
            card.kind === 'text' ? task : card.id === resource.id ? dispatchFromFeedback(task).simulator : task.make_simulator!();
        for (const key of Object.keys(expected)) {
            const wrong = structuredClone(expected);
            wrong[key] = false;
            check(grader.grade(JSON.stringify(wrong)).content_score! < 1, `Wrong semantic field ${card.id}/${key} is rejected`);
        }
        const reordered = Object.fromEntries(Object.entries(expected).reverse());
        equal(grader.grade(JSON.stringify(reordered)).content_score, 1, 'Object key order is not an oracle-preferred spelling');
        const extra = grader.grade(JSON.stringify({ ...expected, explanation: 'not requested' }));
        equal(extra.instruction_checks.exact_fields, false, 'Extra output key fails instructions separately');
        const instructionFailure = grader.grade('```json\n' + JSON.stringify(expected) + '\n```');
        check(
            instructionFailure.content_score !== 1 || Object.values(instructionFailure.instruction_checks).some(value => !value),
            'Markdown fences cannot pass all observations'
        );
    }

    const authoredBudgets = cards.map(card => ({
        id: card.id,
        words:
            wordCount(card.prompt) +
            wordCount(build(card).tools ?? []) +
            (card.id === evidence.id
                ? Object.values(card.grading.config.documents).reduce<number>((n, doc: any) => n + wordCount(doc.content), 0)
                : 0),
        fields: Object.keys(card.grading.expected ?? card.grading.config.expected ?? card.grading.config.expected_answer).length
    }));
    for (const budget of authoredBudgets) {
        check(budget.words <= 1100, 'Authored visible content stays within 1100 lexical words');
        check(budget.fields <= 5, 'At most five answer fields');
    }

    check(assertions >= 370, 'Independent investigation checks cover mutations, alternative paths and every reserve branch');
});
