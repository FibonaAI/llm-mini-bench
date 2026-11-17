import type { AssessmentGrade, AssessmentSimulator, AssessmentTask } from './assessment_tasks.ts';
import { canonicalAssessmentJson } from './assessment_json.ts';

/** Declarative black-box rule identification with a bounded probe budget. */
export const ASSESSMENT_BLACKBOX_TASK_FORMAT = 'assessment-blackbox-v1';
type BlackboxObject = Record<string, unknown>;
type BlackboxConfig = { candidates: Record<string, { outputs: Record<string, unknown> }>; expected_candidate: string; query_limit: number };
type BlackboxHistory = { name: string; arguments: unknown; result: BlackboxObject }[];
const object = (value: unknown): value is BlackboxObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactFields = (value: BlackboxObject, fields: string[]) => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
function requireBlackbox(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error('Assessment black-box task ' + reason); }

function blackboxConfig(value: unknown): BlackboxConfig {
    requireBlackbox(object(value) && exactFields(value, ['candidates', 'expected_candidate', 'query_limit']), 'requires candidates, expected candidate and query limit');
    requireBlackbox(object(value.candidates) && Object.keys(value.candidates).length >= 2, 'requires at least two candidates');
    requireBlackbox(typeof value.expected_candidate === 'string' && Object.hasOwn(value.candidates, value.expected_candidate), 'expected candidate must be declared');
    requireBlackbox(typeof value.query_limit === 'number' && Number.isSafeInteger(value.query_limit) && value.query_limit > 0, 'query limit must be a positive integer');
    let cases: string[] | null = null;
    for (const [id, candidate] of Object.entries(value.candidates)) {
        requireBlackbox(/^[A-Za-z][A-Za-z0-9_]*$/.test(id) && object(candidate) && exactFields(candidate, ['outputs']) && object(candidate.outputs) && Object.keys(candidate.outputs).length > 0, 'has an invalid candidate: ' + id);
        const keys = Object.keys(candidate.outputs).sort();
        requireBlackbox(cases === null || JSON.stringify(cases) === JSON.stringify(keys), 'all candidates must cover the same cases');
        cases ??= keys;
    }
    return structuredClone(value) as BlackboxConfig;
}

/** Strict tools for probing public inputs and submitting one declared candidate rule. */
export function assessment_blackbox_tools(): BlackboxObject[] {
    return [
        { type: 'function', name: 'probe_case', description: 'Return the hidden output for one public case ID.', parameters: { type: 'object', properties: { case_id: { type: 'string' } }, required: ['case_id'], additionalProperties: false }, strict: true },
        { type: 'function', name: 'submit_candidate', description: 'Submit one candidate rule ID as the identified hidden rule.', parameters: { type: 'object', properties: { candidate_id: { type: 'string' } }, required: ['candidate_id'], additionalProperties: false }, strict: true }
    ];
}

/** Fixed candidate-output state machine; candidate rules are data, never executed. */
export class BlackboxAssessmentSimulator implements AssessmentSimulator {
    readonly config: BlackboxConfig;
    history: BlackboxHistory = [];
    invalid_attempts = 0;
    submissions = 0;

    constructor(config: unknown) { this.config = blackboxConfig(config); }

    call(name: string, args: unknown): BlackboxObject {
        let result: BlackboxObject;
        if (this.submissions > 0) {
            result = { ok: false, error: 'already_submitted' }; this.invalid_attempts++;
        } else if (this.history.length >= this.config.query_limit) {
            result = { ok: false, error: 'query_limit' }; this.invalid_attempts++;
        } else if (!object(args)) {
            result = { ok: false, error: 'arguments must be an object' }; this.invalid_attempts++;
        } else if (name === 'probe_case' && exactFields(args, ['case_id']) && typeof args.case_id === 'string') {
            const candidate = this.config.candidates[this.config.expected_candidate]!;
            if (!Object.hasOwn(candidate.outputs, args.case_id)) {
                result = { ok: false, error: 'unknown case' }; this.invalid_attempts++;
            } else result = { ok: true, case_id: args.case_id, output: structuredClone(candidate.outputs[args.case_id]) };
        } else if (name === 'submit_candidate' && exactFields(args, ['candidate_id']) && typeof args.candidate_id === 'string' && Object.hasOwn(this.config.candidates, args.candidate_id)) {
            this.submissions++;
            result = { ok: true, correct: args.candidate_id === this.config.expected_candidate };
        } else {
            result = { ok: false, error: 'unknown tool or invalid argument fields' }; this.invalid_attempts++;
        }
        this.history.push({ name, arguments: structuredClone(args), result: structuredClone(result) });
        return structuredClone(result);
    }

    grade(text: unknown): AssessmentGrade {
        const { assessment_result, parse_assessment_answer, _matches_answer } = require('./assessment_tasks.ts') as typeof import('./assessment_tasks.ts');
        const [obj, instructions, problem] = parse_assessment_answer(text);
        const submitted = this.history.filter(call => call.name === 'submit_candidate' && call.result.ok === true).at(-1);
        const candidateId = submitted && object(submitted.arguments) && typeof submitted.arguments.candidate_id === 'string' ? submitted.arguments.candidate_id : null;
        const candidate = candidateId === null ? null : this.config.candidates[candidateId] ?? null;
        const correct = candidateId === this.config.expected_candidate && submitted?.result.correct === true;
        const cases = Object.keys(this.config.candidates[this.config.expected_candidate]!.outputs).sort();
        const outputChecks: Record<string, boolean> = {};
        for (const id of cases) {
            const expected = this.config.candidates[this.config.expected_candidate]!.outputs[id];
            const actual = candidate?.outputs[id];
            const passed = candidate !== null && canonicalAssessmentJson(actual) === canonicalAssessmentJson(expected);
            outputChecks[id] = passed;
        }
        const expectedAnswer = { candidate_id: this.config.expected_candidate };
        const truthful = correct && problem === null && _matches_answer(obj, expectedAnswer);
        const within = this.history.length <= this.config.query_limit && this.invalid_attempts === 0;
        const used = this.history.some(call => call.name === 'probe_case' && call.result.ok === true);
        const checks = { identified_rule: correct, truthful_final: truthful };
        const result = assessment_result(checks, instructions, null, Number(truthful));
        result.content_checks = { ...checks, ...outputChecks };
        if (problem) result.outcome = problem;
        result.tool_checks = { used_probes: used, within_query_limit: within, single_submission: this.submissions === 1, correct_submission: correct, no_invalid_attempts: this.invalid_attempts === 0, final_report_truthful: truthful };
        result.tool_calls = this.history.length;
        return result;
    }
}

/** Attach a declarative black-box task without adding bank-version branches. */
export function configure_assessment_blackbox_task(card: AssessmentTask, config: unknown): AssessmentTask {
    blackboxConfig(config);
    card.kind = 'tool';
    card.tools = assessment_blackbox_tools();
    card.make_simulator = () => new BlackboxAssessmentSimulator(config);
    card.grade = () => ({ content_score: null, content_checks: {}, instruction_checks: {}, tool_checks: {}, outcome: 'ungradable', reason: 'Use the same black-box simulator instance that received real probes.' });
    return card;
}
