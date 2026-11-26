import { assessment_blackbox_tools } from './assessment_blackbox.ts';
import { assessment_data_expected } from './assessment_data.ts';
import { assessmentJsonNumberToken } from './assessment_json.ts';
import {
    _matches_answer,
    assessment_exact_fields,
    assessment_result,
    is_assessment_object,
    parse_assessment_answer,
    type AssessmentGrade,
    type AssessmentSimulator
} from './assessment_tasks.ts';

/** Finite binary fault isolation. The only public instrument returns a measured bit. */
export const ASSESSMENT_BLACKBOX_V2_TASK_FORMAT = 'assessment-blackbox-v2';

/** Candidate guesses are submitted as answers, never sent to a correctness oracle. */
export const assessment_blackbox_v2_tools = () => assessment_blackbox_tools().filter(tool => tool.name === 'probe_case');

type CandidateTable = Record<string, { outputs: Record<string, 0 | 1> }>;
type StaticGate = 'used_probes' | 'singleton' | 'valid_root_singleton';
type BlackboxFieldSpec =
    | { kind: 'first_probe' }
    | { kind: 'candidate'; require_valid_root?: boolean }
    | { kind: 'hamming_neighbors'; distance: number; require_distinct_count?: number }
    | { kind: 'static'; expected: unknown; gate: StaticGate };
type ProbeConfig = {
    candidates: CandidateTable;
    expected_candidate: string;
    query_limit: number;
    fields?: Record<string, BlackboxFieldSpec>;
};
const validId = (id: string) => /^[A-Za-z][A-Za-z0-9_]*$/.test(id);
const STATIC_GATES = new Set<StaticGate>(['used_probes', 'singleton', 'valid_root_singleton']);

function validateFields(value: unknown, queryLimit: number): Record<string, BlackboxFieldSpec> {
    if (!is_assessment_object(value) || !Object.keys(value).length)
        throw new Error('Assessment blackbox v2 fields must be a nonempty object');
    const out: Record<string, BlackboxFieldSpec> = {};
    for (const [key, spec] of Object.entries(value)) {
        if (!validId(key) || !is_assessment_object(spec) || typeof spec.kind !== 'string')
            throw new Error('Assessment blackbox v2 invalid field spec: ' + key);
        if (spec.kind === 'first_probe') {
            if (!assessment_exact_fields(spec, ['kind'])) throw new Error('Assessment blackbox v2 invalid first_probe field: ' + key);
            out[key] = { kind: 'first_probe' };
        } else if (spec.kind === 'candidate') {
            const allowed = Object.hasOwn(spec, 'require_valid_root') ? ['kind', 'require_valid_root'] : ['kind'];
            if (
                !assessment_exact_fields(spec, allowed) ||
                (Object.hasOwn(spec, 'require_valid_root') && typeof spec.require_valid_root !== 'boolean')
            )
                throw new Error('Assessment blackbox v2 invalid candidate field: ' + key);
            out[key] = Object.hasOwn(spec, 'require_valid_root')
                ? { kind: 'candidate', require_valid_root: spec.require_valid_root as boolean }
                : { kind: 'candidate' };
        } else if (spec.kind === 'hamming_neighbors') {
            const allowed = Object.hasOwn(spec, 'require_distinct_count') ? ['kind', 'distance', 'require_distinct_count'] : ['kind', 'distance'];
            const dist = spec.distance;
            const req = Object.hasOwn(spec, 'require_distinct_count') ? spec.require_distinct_count : queryLimit;
            if (
                !assessment_exact_fields(spec, allowed) ||
                typeof dist !== 'number' ||
                !Number.isSafeInteger(dist) ||
                dist < 1 ||
                dist > queryLimit ||
                typeof req !== 'number' ||
                !Number.isSafeInteger(req) ||
                req < dist ||
                req > queryLimit
            )
                throw new Error('Assessment blackbox v2 invalid hamming_neighbors field: ' + key);
            out[key] = { kind: 'hamming_neighbors', distance: dist, require_distinct_count: req };
        } else if (spec.kind === 'static') {
            if (
                !assessment_exact_fields(spec, ['kind', 'expected', 'gate']) ||
                typeof spec.gate !== 'string' ||
                !STATIC_GATES.has(spec.gate as StaticGate)
            )
                throw new Error('Assessment blackbox v2 invalid static field: ' + key);
            if (
                !(
                    is_assessment_object(spec.expected) &&
                    assessment_exact_fields(spec.expected, ['$valid_openers']) &&
                    spec.expected.$valid_openers === true
                )
            )
                assessment_data_expected(spec.expected);
            out[key] = { kind: 'static', expected: structuredClone(spec.expected), gate: spec.gate as StaticGate };
        } else {
            throw new Error('Assessment blackbox v2 unsupported field kind: ' + spec.kind);
        }
    }
    return out;
}

function readProbeConfig(value: unknown): ProbeConfig {
    const keys =
        is_assessment_object(value) && Object.hasOwn(value, 'fields')
            ? ['candidates', 'expected_candidate', 'query_limit', 'fields']
            : ['candidates', 'expected_candidate', 'query_limit'];
    if (
        !is_assessment_object(value) ||
        !assessment_exact_fields(value, keys) ||
        !is_assessment_object(value.candidates) ||
        typeof value.expected_candidate !== 'string' ||
        !Object.hasOwn(value.candidates, value.expected_candidate) ||
        typeof value.query_limit !== 'number' ||
        !Number.isSafeInteger(value.query_limit) ||
        value.query_limit < 1 ||
        value.query_limit > 8 ||
        Object.keys(value.candidates).length < 2 ||
        Object.keys(value.candidates).length > 16
    )
        throw new Error('Assessment blackbox v2 requires 2–16 candidates, a known active candidate and a limit of 1–8 probes');
    let probes: string[] | undefined;
    for (const [id, row] of Object.entries(value.candidates)) {
        if (!validId(id) || !is_assessment_object(row) || !assessment_exact_fields(row, ['outputs']) || !is_assessment_object(row.outputs))
            throw new Error('Assessment blackbox v2 invalid candidate: ' + id);
        probes ??= Object.keys(row.outputs);
        if (
            !probes.length ||
            probes.length > 12 ||
            !probes.every(validId) ||
            !assessment_exact_fields(row.outputs, probes) ||
            !Object.values(row.outputs).every(bit => bit === 0 || bit === 1)
        )
            throw new Error('Assessment blackbox v2 requires the same 1–12 binary probes for every candidate');
    }
    const config: ProbeConfig = {
        candidates: structuredClone(value.candidates) as CandidateTable,
        expected_candidate: value.expected_candidate,
        query_limit: value.query_limit
    };
    if (Object.hasOwn(value, 'fields')) config.fields = validateFields(value.fields, value.query_limit);
    return config;
}

function solvableFirstProbes(table: CandidateTable, limit: number): string[] {
    const all = Object.keys(table);
    const probes = Object.keys(table[all[0]!]!.outputs);
    const memo = new Map<string, boolean>();
    const branch = (ids: string[], p: string, bit: number) => ids.filter(id => table[id]!.outputs[p] === bit);
    function canFinish(ids: string[], left: number): boolean {
        if (ids.length <= 1) return true;
        if (ids.length > 2 ** left) return false;
        const key = `${left}:${ids.join(',')}`;
        if (!memo.has(key))
            memo.set(
                key,
                probes.some(p => {
                    const zero = branch(ids, p, 0);
                    return (
                        zero.length > 0 && zero.length < ids.length && canFinish(zero, left - 1) && canFinish(branch(ids, p, 1), left - 1)
                    );
                })
            );
        return memo.get(key)!;
    }
    return probes.filter(p => [0, 1].every(bit => canFinish(branch(all, p, bit), limit - 1)));
}

/** Certifies a safe opening and a singleton from the actual readings, not a written probe plan. */
export class BlackboxV2AssessmentSimulator implements AssessmentSimulator {
    readonly history: AssessmentSimulator['history'] = [];
    private readonly config: ProbeConfig;
    private readonly validRoots: string[];
    private invalidAttempts = 0;

    constructor(value: unknown) {
        this.config = readProbeConfig(value);
        this.validRoots = solvableFirstProbes(this.config.candidates, this.config.query_limit);
        if (!this.validRoots.length) throw new Error('Assessment blackbox v2 cannot identify all candidates within the probe limit');
    }

    call(name: string, args: unknown): Record<string, unknown> {
        const outputs = this.config.candidates[this.config.expected_candidate]!.outputs;
        let result: Record<string, unknown>;
        if (this.history.length >= this.config.query_limit) result = { ok: false, error: 'query_limit' };
        else if (
            name !== 'probe_case' ||
            !is_assessment_object(args) ||
            !assessment_exact_fields(args, ['case_id']) ||
            typeof args.case_id !== 'string' ||
            !Object.hasOwn(outputs, args.case_id)
        )
            result = { ok: false, error: 'invalid probe' };
        else result = { ok: true, case_id: args.case_id, output: outputs[args.case_id] };
        if (!result.ok) this.invalidAttempts++;
        this.history.push({ name, arguments: structuredClone(args), result: structuredClone(result) });
        return result;
    }

    grade(text: unknown): AssessmentGrade {
        const { candidates, expected_candidate, query_limit } = this.config;
        const readings = this.history.filter(call => call.name === 'probe_case' && call.result.ok === true).map(call => call.result);
        const within = this.history.length <= query_limit && this.invalidAttempts === 0;
        const first = readings[0]?.case_id;
        const validRoot = typeof first === 'string' && this.validRoots.includes(first);
        const survivors = Object.keys(candidates).filter(id =>
            readings.every(r => candidates[id]!.outputs[String(r.case_id)] === r.output)
        );
        const singleton = survivors.length === 1 && survivors[0] === expected_candidate;
        const [answer, instructions, problem] = parse_assessment_answer(text);
        const fields = this.config.fields;
        instructions.exact_fields = answer !== null && assessment_exact_fields(answer, fields ? Object.keys(fields) : ['candidate_id']);
        let grade: AssessmentGrade;
        if (problem || !answer) {
            grade = assessment_result({}, instructions, problem, problem === 'abstained' ? 0 : null);
        } else if (!fields) {
            grade = assessment_result(
                {
                    candidate_id: within && validRoot && singleton && answer.candidate_id === expected_candidate
                },
                instructions
            );
        } else {
            const checks: Record<string, boolean> = {};
            const sortedIds = Object.keys(candidates).sort();
            const distinctProbes = new Set(readings.map(r => String(r.case_id)));
            for (const [key, spec] of Object.entries(fields)) {
                const hasKey = Object.hasOwn(answer, key);
                const val = answer[key];
                if (!hasKey) {
                    checks[key] = false;
                } else if (spec.kind === 'first_probe') {
                    checks[key] = within && validRoot && readings.length > 0 && val === first;
                } else if (spec.kind === 'candidate') {
                    checks[key] = within && (!spec.require_valid_root || validRoot) && singleton && val === expected_candidate;
                } else if (spec.kind === 'hamming_neighbors') {
                    const req = spec.require_distinct_count ?? query_limit;
                    if (!within || readings.length !== req || distinctProbes.size !== req) {
                        checks[key] = false;
                    } else {
                        const neighbors = sortedIds.filter(id => {
                            let diff = 0;
                            for (const r of readings) {
                                if (candidates[id]!.outputs[String(r.case_id)] !== r.output) diff++;
                            }
                            return diff === spec.distance;
                        });
                        checks[key] = _matches_answer(val, neighbors);
                    }
                } else {
                    const gateOk =
                        within &&
                        (spec.gate === 'used_probes'
                            ? readings.length > 0
                            : spec.gate === 'singleton'
                              ? singleton
                              : validRoot && singleton);
                    const compiled =
                        is_assessment_object(spec.expected) &&
                        assessment_exact_fields(spec.expected, ['$valid_openers']) &&
                        spec.expected.$valid_openers === true
                            ? [...this.validRoots].sort()
                            : assessment_data_expected(spec.expected);
                    checks[key] = gateOk && _matches_answer(val, compiled, assessmentJsonNumberToken(answer, key));
                }
            }
            grade = assessment_result(checks, instructions);
        }
        grade.tool_checks = {
            used_probes: readings.length > 0,
            valid_first_probe: validRoot,
            singleton_certified: singleton,
            within_query_limit: within,
            no_invalid_attempts: this.invalidAttempts === 0
        };
        grade.tool_calls = this.history.length;
        return grade;
    }
}
