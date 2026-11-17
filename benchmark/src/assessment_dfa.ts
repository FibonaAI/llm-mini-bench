import type { AssessmentGrade, AssessmentSimulator, AssessmentTask } from './assessment_tasks.ts';

/** Interactive DFA identification task format with bounded adaptive queries. */
export const ASSESSMENT_DFA_TASK_FORMAT = 'assessment-dfa-v1';
type DfaObject = Record<string, unknown>;
type DfaConfig = { states: string[]; start: string; alphabet: string[]; transitions: Record<string, Record<string, string>>; accepting_states: string[]; query_limit: number };
type DfaHistory = { name: string; arguments: unknown; result: DfaObject }[];
const object = (value: unknown): value is DfaObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactFields = (value: DfaObject, fields: string[]) => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
function requireDfa(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error('Assessment DFA task ' + reason); }

function dfaConfig(value: unknown): DfaConfig {
    requireDfa(object(value) && exactFields(value, ['states', 'start', 'alphabet', 'transitions', 'accepting_states', 'query_limit']), 'requires states, alphabet, transitions, accepting states and query limit');
    const states = value.states, alphabet = value.alphabet, accepting = value.accepting_states;
    requireDfa(Array.isArray(states) && states.length > 0 && states.every(state => typeof state === 'string' && state.length > 0 && new Set(states).size === states.length), 'states must be unique nonempty strings');
    requireDfa(typeof value.start === 'string' && states.includes(value.start), 'start must be a declared state');
    requireDfa(Array.isArray(alphabet) && alphabet.length > 0 && alphabet.every(symbol => typeof symbol === 'string' && symbol.length === 1 && new Set(alphabet).size === alphabet.length), 'alphabet must contain unique single characters');
    requireDfa(object(value.transitions) && Object.keys(value.transitions).length === states.length, 'transitions must cover every state');
    for (const state of states) {
        const row = value.transitions[state];
        requireDfa(object(row) && Object.keys(row).length === alphabet.length && alphabet.every(symbol => typeof row[symbol] === 'string' && states.includes(row[symbol])), 'transitions must be complete for state ' + state);
    }
    requireDfa(Array.isArray(accepting) && accepting.every(state => typeof state === 'string' && states.includes(state)), 'accepting_states must reference declared states');
    requireDfa(typeof value.query_limit === 'number' && Number.isSafeInteger(value.query_limit) && value.query_limit > 0, 'query_limit must be a positive integer');
    return structuredClone(value) as DfaConfig;
}

/** Strict tools for querying and submitting a hidden deterministic finite automaton. */
export function assessment_dfa_tools(config: unknown): DfaObject[] {
    const { states, alphabet } = dfaConfig(config);
    const stateSchema = { type: 'object', properties: Object.fromEntries(alphabet.map(symbol => [symbol, { type: 'string' }])), required: alphabet, additionalProperties: false };
    return [
        { type: 'function', name: 'test_word', description: 'Test whether the hidden DFA accepts a string.', parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'], additionalProperties: false }, strict: true },
        { type: 'function', name: 'submit_dfa', description: 'Submit the complete transition table and accepting states for the hidden DFA.', parameters: {
            type: 'object', properties: { transitions: { type: 'object', properties: Object.fromEntries(states.map(state => [state, stateSchema])), required: states, additionalProperties: false }, accepting_states: { type: 'array', items: { type: 'string' } } }, required: ['transitions', 'accepting_states'], additionalProperties: false }, strict: true }
    ];
}

/** Hidden DFA with bounded queries and one final submission. */
export class DfaAssessmentSimulator implements AssessmentSimulator {
    readonly config: DfaConfig;
    history: DfaHistory = [];
    invalid_attempts = 0;
    submissions = 0;

    constructor(config: unknown) { this.config = dfaConfig(config); }

    private accepted(word: string): boolean {
        let state = this.config.start;
        for (const symbol of word) state = this.config.transitions[state]![symbol]!;
        return this.config.accepting_states.includes(state);
    }

    private correct(value: unknown): boolean {
        if (!object(value) || !exactFields(value, ['transitions', 'accepting_states']) || !object(value.transitions)) return false;
        const states = new Set(this.config.states);
        if (Object.keys(value.transitions).length !== this.config.states.length || Object.keys(value.transitions).some(state => !states.has(state))) return false;
        for (const state of this.config.states) {
            const actual = value.transitions[state], expected = this.config.transitions[state]!;
            if (!object(actual) || Object.keys(actual).length !== this.config.alphabet.length) return false;
            for (const symbol of this.config.alphabet) if (actual[symbol] !== this.config.transitions[state]![symbol]) return false;
        }
        const accepting = value.accepting_states;
        return Array.isArray(accepting) && accepting.length === this.config.accepting_states.length
            && accepting.every(state => typeof state === 'string' && this.config.states.includes(state))
            && [...accepting].sort().every((state, index) => state === [...this.config.accepting_states].sort()[index]);
    }

    call(name: string, args: unknown): DfaObject {
        let result: DfaObject;
        if (this.history.length >= this.config.query_limit) {
            result = { ok: false, error: 'query_limit' }; this.invalid_attempts++;
        } else if (!object(args)) {
            result = { ok: false, error: 'arguments must be an object' }; this.invalid_attempts++;
        } else if (name === 'test_word' && exactFields(args, ['word']) && typeof args.word === 'string') {
            result = { ok: true, accepted: this.accepted(args.word) };
        } else if (name === 'submit_dfa' && exactFields(args, ['transitions', 'accepting_states'])) {
            this.submissions++;
            result = { ok: true, correct: this.correct(args) };
        } else {
            result = { ok: false, error: 'unknown tool or invalid argument fields' }; this.invalid_attempts++;
        }
        this.history.push({ name, arguments: structuredClone(args), result: structuredClone(result) });
        return structuredClone(result);
    }

    grade(text: unknown): AssessmentGrade {
        const { assessment_result, parse_assessment_answer, _matches_answer } = require('./assessment_tasks.ts') as typeof import('./assessment_tasks.ts');
        const [obj, instructions, problem] = parse_assessment_answer(text);
        const submitted = this.history.filter(call => call.name === 'submit_dfa').at(-1);
        const correct = submitted !== undefined && submitted.result.correct === true;
        const transitionChecks: Record<string, boolean> = {}, acceptanceChecks: Record<string, boolean> = {};
        let correctTransitions = 0, correctAcceptance = 0;
        if (submitted && object(submitted.arguments)) {
            const actualTransitions = submitted.arguments.transitions;
            for (const state of this.config.states) for (const symbol of this.config.alphabet) {
                const expected = this.config.transitions[state]![symbol]!, actual = object(actualTransitions) && object(actualTransitions[state]) ? actualTransitions[state]![symbol] : undefined;
                const passed = actual === expected;
                transitionChecks[state + '.' + symbol] = passed;
                if (passed) correctTransitions++;
            }
            const actualAccepting = new Set(Array.isArray(submitted.arguments.accepting_states) ? submitted.arguments.accepting_states : []);
            for (const state of this.config.states) {
                const expected = this.config.accepting_states.includes(state), actual = actualAccepting.has(state);
                acceptanceChecks[state] = actual === expected;
                if (actual === expected) correctAcceptance++;
            }
        }
        const transitionAccuracy = correctTransitions / (this.config.states.length * this.config.alphabet.length);
        const acceptanceAccuracy = correctAcceptance / this.config.states.length;
        const finalObject = { transitions: this.config.transitions, accepting_states: this.config.accepting_states };
        const truthful = correct && problem === null && _matches_answer(obj, finalObject);
        const checks = { identified_automaton: correct, truthful_final: truthful, within_query_limit: this.history.length <= this.config.query_limit && this.invalid_attempts === 0, used_queries: this.history.some(call => call.name === 'test_word') };
        const score = (transitionAccuracy + acceptanceAccuracy + Number(correct) + Number(truthful) + Number(checks.within_query_limit) + Number(checks.used_queries)) / 6;
        const result = assessment_result(checks, instructions, null, score);
        result.content_checks = { ...checks, ...transitionChecks, ...acceptanceChecks };
        if (problem) result.outcome = problem;
        result.tool_checks = { used_acceptance_queries: this.history.some(call => call.name === 'test_word'), single_submission: this.submissions === 1, correct_submission: correct, no_invalid_attempts: this.invalid_attempts === 0, final_report_truthful: truthful };
        result.tool_calls = this.history.length;
        return result;
    }
}

/** Attach a hidden DFA and its query/submission tools to a serializable task card. */
export function configure_assessment_dfa_task(card: AssessmentTask, config: unknown): AssessmentTask {
    dfaConfig(config);
    card.kind = 'tool';
    card.tools = assessment_dfa_tools(config);
    card.make_simulator = () => new DfaAssessmentSimulator(config);
    card.grade = () => ({ content_score: null, content_checks: {}, instruction_checks: {}, tool_checks: {}, outcome: 'ungradable', reason: 'Use the same DFA simulator instance that received real queries.' });
    return card;
}
