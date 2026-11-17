import { answer_protocol_spec } from './assessment_answer_protocol.ts';
import { assessment_hash, assessmentJsonNumberToken } from './assessment_json.ts';

/** Explicit request configurations; default thinking omits reasoning entirely. */
export const EXECUTION_PROTOCOL_SCHEMA = 'mini-bench-execution-v1';
const RESERVED_THINKING = new Set(['default', 'mixed', 'unknown']);
/** Response request options recorded separately from model and account identity. */
export interface AssessmentRequestConfig {
    reasoning?: { effort: string };
    max_output_tokens?: number;
    stream?: true;
}
/** Per-question request provenance, independent of grading and model identity. */
export interface ExecutionProtocol {
    schema: typeof EXECUTION_PROTOCOL_SCHEMA;
    wire: 'responses';
    requests: Record<string, AssessmentRequestConfig>;
}
function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Preserve all advertised effort strings, including future levels. */
export function advertised_thinking_levels(model: unknown): string[] {
    const levels: string[] = [];
    if (!record(model)) return levels;
    for (const key of ['reasoning_levels', 'supported_reasoning_levels']) {
        const values = model[key];
        if (Array.isArray(values))
            for (const value of values) {
                if (typeof value === 'string' && value && !RESERVED_THINKING.has(value) && !levels.includes(value)) levels.push(value);
            }
    }
    return levels;
}
function request_config(config: unknown): AssessmentRequestConfig {
    if (!record(config) || Object.keys(config).some(key => !['reasoning', 'max_output_tokens', 'stream'].includes(key)))
        throw new TypeError('Execution protocol has unsupported request configuration');
    const result: AssessmentRequestConfig = {};
    if ('stream' in config) {
        if (config.stream !== true) throw new TypeError('Execution protocol has invalid streaming mode');
        result.stream = true;
    }
    if ('reasoning' in config) {
        const reasoning = config.reasoning;
        if (
            !record(reasoning) ||
            Object.keys(reasoning).length !== 1 ||
            typeof reasoning.effort !== 'string' ||
            !reasoning.effort ||
            RESERVED_THINKING.has(reasoning.effort)
        )
            throw new TypeError('Execution protocol has invalid explicit thinking effort');
        result.reasoning = { effort: reasoning.effort };
    }
    if ('max_output_tokens' in config) {
        const cap = config.max_output_tokens;
        if (
            typeof cap !== 'number' ||
            !Number.isSafeInteger(cap) ||
            cap <= 0 ||
            /[.eE]/.test(assessmentJsonNumberToken(config, 'max_output_tokens') ?? '')
        )
            throw new TypeError('Execution protocol has invalid output token budget');
        result.max_output_tokens = cap;
    }
    return result;
}
function protocol_for_requests(requests: unknown): ExecutionProtocol {
    if (!record(requests) || !Object.keys(requests).length || Object.keys(requests).some(key => !key))
        throw new TypeError('Execution protocol requires question request configurations');
    return {
        schema: EXECUTION_PROTOCOL_SCHEMA,
        wire: 'responses',
        requests: Object.fromEntries(Object.entries(requests).map(([key, value]) => [key, request_config(value)]))
    };
}
/** Hash only validated sent request options, never identities or scores. */
export function execution_protocol_hash(protocol: unknown): string {
    if (
        !record(protocol) ||
        Object.keys(protocol).sort().join(',') !== 'requests,schema,wire' ||
        protocol.schema !== EXECUTION_PROTOCOL_SCHEMA ||
        protocol.wire !== 'responses'
    )
        throw new TypeError('Execution protocol schema or wire is unsupported');
    return assessment_hash(protocol_for_requests(protocol.requests));
}
/** Sample policy fields are recorded verbatim; absent, undefined and null are not defaulted. */
export interface AssessmentSampleConfig {
    max_output_tokens?: number | null;
    max_turns: number | null;
    max_tool_calls: number | null;
    timeout: number;
    max_api_retries?: number;
    timeout_scope?: 'sample';
}

/** Assemble pure sample protocol identity without trusting any recorded hashes or sent options. */
export function assessment_sample_protocol(
    task: { id: string; [key: string]: unknown },
    thinking: string,
    config: AssessmentSampleConfig,
    stream: boolean
): { execution_protocol: ExecutionProtocol; assessment_protocol_sha256: string } {
    const outputCap = config.max_output_tokens ?? undefined;
    const protocol = target_execution_protocol(
        [{ id: task.id, ...(outputCap === undefined ? {} : { max_output_tokens: outputCap }) }],
        thinking,
        stream
    );
    const snapshot = Object.fromEntries(Object.entries(task).filter(([, value]) => typeof value !== 'function'));
    const configSnapshot = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
    const answer = answer_protocol_spec(task);
    return {
        execution_protocol: protocol,
        assessment_protocol_sha256: assessment_hash({
            task: snapshot,
            config: configSnapshot,
            request_protocol: protocol,
            ...(answer ? { answer_protocol: answer } : {})
        })
    };
}

/** Build request provenance from target thinking, never question effort. */
export function target_execution_protocol(
    questions: readonly { id: string; max_output_tokens?: number; [key: string]: unknown }[],
    thinking: unknown,
    stream = false
): ExecutionProtocol {
    if (typeof thinking !== 'string' || !thinking || thinking === 'mixed' || thinking === 'unknown')
        throw new TypeError('Target thinking must be default or an advertised effort');
    const requests: Record<string, AssessmentRequestConfig> = Object.create(null);
    for (const question of questions) {
        const config: AssessmentRequestConfig = thinking === 'default' ? {} : { reasoning: { effort: thinking } };
        if (stream) config.stream = true;
        if ('max_output_tokens' in question) config.max_output_tokens = question.max_output_tokens;
        requests[question.id] = config;
    }
    return protocol_for_requests(requests);
}
