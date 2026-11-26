/** Single-sample execution uses fixed simulators and persists raw evidence before grading. */
import { fsyncSync, writeSync } from 'node:fs';
import { calibration_visible_text } from './assessment_response.ts';
import type { GatewayResponse, GatewayStreamOptions } from './client.ts';
import { responses_stream_telemetry } from './responses_stream.ts';
import {
    assessment_sample_protocol,
    execution_protocol_hash,
    type AssessmentSampleConfig,
    type ExecutionProtocol
} from './run_protocol.ts';
import { assessment_hash, canonicalAssessmentJson, parseAssessmentJson, assessmentJsonNumberToken } from './assessment_json.ts';
import type { AssessmentPricing } from './bench_routes.ts';
import type { AssessmentGrade } from './assessment_tasks.ts';
import {
    SUBMIT_ANSWER_ACCEPTED,
    SUBMIT_ANSWER_INSTRUCTIONS,
    SUBMIT_ANSWER_TOOL_NAME,
    submit_answer_tool,
    task_answer_schema,
    no_submission_grade,
    submitted_grade,
    task_answer_protocol
} from './assessment_answer_protocol.ts';

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function error_name(error: unknown): string {
    return error instanceof Error ? error.name : 'Error';
}
/** Request and tool-turn limits, recorded verbatim in assessment provenance. */
export interface RunnerConfig extends AssessmentSampleConfig {}
/** Conservative budget reservation only; uncapped responses are never truncated at this size. */
export const ASSESSMENT_UNCAPPED_OUTPUT_RESERVATION_TOKENS = 32768;
/** Target identity does not itself verify upstream account or effective thinking. */
export interface AssessmentTarget {
    model: string;
    thinking: string;
}
/** Transport injection allows fully offline tests without live model requests. */
export interface AssessmentClient {
    post_responses_stream(
        body: Record<string, unknown>,
        timeout?: number,
        options?: GatewayStreamOptions
    ): GatewayResponse | Promise<GatewayResponse>;
}
/** Full released grades and minimal offline fixture grades share the same observation envelope. */
export type RunnerGrade = AssessmentGrade | Record<string, unknown>;
/** Fixed in-memory simulator; generated code is never executed. */
export interface RunnerSimulator {
    call(name: string, arguments_: unknown): Record<string, unknown>;
    grade(text: string): RunnerGrade;
}
/** Minimal task contract shared with the pinned bank and synthetic offline fixtures. */
export interface RunnerTask {
    id: string;
    domain: string;
    kind: string;
    prompt: string;
    grade?: (text: string) => RunnerGrade;
    make_simulator?: () => RunnerSimulator;
    tools?: unknown;
    [key: string]: unknown;
}
/** Synchronous journal writes must finish before grading or simulator execution. */
export interface AssessmentJournalWriter {
    write(record: Record<string, unknown>): void;
}
/** Budget adapters use synchronous event-loop-atomic reservations and settlements. */
export interface AssessmentBudgetController {
    admit(body: Record<string, unknown>, pricing: AssessmentPricing | null): number | null;
    settle(
        reservation: number,
        payload: unknown,
        pricing: AssessmentPricing | null,
        cap: number | undefined,
        transport_failed?: boolean,
        retain_unknown?: boolean,
        known_zero_usage?: boolean
    ): number | null;
}
/** Tool traces preserve the original argument string even when parsing fails. */
export interface AssessmentToolTrace {
    call_id: string;
    name: unknown;
    arguments: unknown;
    result: Record<string, unknown>;
}
/** Per-task result keeps execution failures ungraded rather than scoring them zero. */
export interface AssessmentObservation extends Record<string, unknown> {
    type: 'observation';
    task: string;
    domain: string;
    model: string;
    thinking: string;
    round: number;
    sample_id: string;
    ok: boolean;
    assessment_protocol_sha256: string;
    execution_protocol: ExecutionProtocol;
    execution_protocol_sha256: string;
    status: string;
    runner_error: string | null;
    grade: RunnerGrade | null;
    text: string;
    calls: string[];
    tool_trace: AssessmentToolTrace[];
    elapsed_seconds: number;
    usage: AssessmentUsage | null;
    estimated_uncached_cost_usd: number | null;
    /** Set when a call without returned usage was excluded from usage/cost, which are then known lower bounds. */
    usage_incomplete?: true;
}
/** Validated nonnegative integer usage; omitted or malformed counts remain null. */
export interface AssessmentUsage {
    input_tokens: number;
    output_tokens: number;
}
function assessment_usage(payload: unknown): AssessmentUsage | null {
    if (!record(payload) || !record(payload.usage)) return null;
    const { input_tokens, output_tokens } = payload.usage;
    if (
        typeof input_tokens !== 'number' ||
        !Number.isSafeInteger(input_tokens) ||
        input_tokens < 0 ||
        typeof output_tokens !== 'number' ||
        !Number.isSafeInteger(output_tokens) ||
        output_tokens < 0
    )
        return null;
    if (['input_tokens', 'output_tokens'].some(key => /[.eE]/.test(assessmentJsonNumberToken(payload.usage as object, key) ?? '')))
        return null;
    return { input_tokens, output_tokens };
}
/** Reject duplicate keys, nonfinite numbers, non-object arguments and excessive nesting. */
export function assessment_arguments(raw: unknown): Record<string, unknown> {
    if (typeof raw !== 'string' || raw.length > 100000) throw new TypeError('arguments must be a bounded JSON string');
    const value = parseAssessmentJson(raw, 21);
    if (!record(value)) throw new TypeError('arguments must be a JSON object');
    const pending: [unknown, number][] = [[value, 0]];
    while (pending.length) {
        const [node, depth] = pending.pop()!;
        if (depth > 20) throw new TypeError('tool arguments exceed nesting limit');
        if (node && typeof node === 'object') for (const child of Object.values(node)) pending.push([child, depth + 1]);
    }
    return value;
}
/** Reserve each call, including tool continuations, atomically before asynchronous transport. */
export class AssessmentBudget implements AssessmentBudgetController {
    spent = 0;
    reserved = 0;
    uncertain_cost = 0;
    requests = 0;
    missing_cost = 0;
    stop_reason: string | null = null;
    constructor(
        readonly cost_limit: number | null,
        readonly request_limit: number | null,
        readonly uncapped_output_reservation_tokens = ASSESSMENT_UNCAPPED_OUTPUT_RESERVATION_TOKENS,
        readonly continue_on_sample_failure = false
    ) {}
    admit(body: Record<string, unknown>, pricing: AssessmentPricing | null): number | null {
        if (this.stop_reason) return null;
        if (this.request_limit !== null && this.requests >= this.request_limit) {
            this.stop_reason = 'request_limit';
            return null;
        }
        if (pricing === null) {
            if (this.cost_limit !== null && Number.isFinite(this.cost_limit)) {
                this.stop_reason = 'missing_usage_cost';
                return null;
            }
            this.requests++;
            return 0;
        }
        // Python's historical serializer included a space after commas and colons.
        // Retaining that byte count keeps cost-reservation admission conservative and comparable.
        const serialized = canonicalAssessmentJson(body);
        let separators = 0,
            quoted = false,
            escaped = false;
        for (const character of serialized) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (quoted && character === '\\') {
                escaped = true;
                continue;
            }
            if (character === '"') quoted = !quoted;
            else if (!quoted && (character === ',' || character === ':')) separators++;
        }
        const reservation =
            (Buffer.byteLength(serialized) + separators + 2000) * pricing.prompt +
            (typeof body.max_output_tokens === 'number' ? body.max_output_tokens : this.uncapped_output_reservation_tokens) *
                pricing.completion;
        if (this.cost_limit !== null && this.spent + this.reserved + this.uncertain_cost + reservation > this.cost_limit) {
            this.stop_reason = 'cost_reservation_limit';
            return null;
        }
        this.reserved += reservation;
        this.requests++;
        return reservation;
    }
    settle(
        reservation: number,
        payload: unknown,
        pricing: AssessmentPricing | null,
        cap: number | undefined,
        transport_failed = false,
        retain_unknown = false,
        known_zero_usage = false
    ): number | null {
        const usage = assessment_usage(payload);
        const cost =
            usage && pricing !== null
                ? usage.input_tokens * pricing.prompt + usage.output_tokens * pricing.completion
                : !usage && known_zero_usage
                  ? 0
                  : null;
        this.reserved -= reservation;
        if (cost === null) {
            this.missing_cost++;
            if (retain_unknown) this.uncertain_cost += reservation;
            else if (!this.continue_on_sample_failure && (usage === null || (this.cost_limit !== null && Number.isFinite(this.cost_limit))))
                this.stop_reason = 'missing_usage_cost';
            if (cap !== undefined && usage && usage.output_tokens > cap) this.stop_reason = 'upstream_output_cap_exceeded';
        } else {
            this.spent += cost;
            if (usage && cap !== undefined && usage.output_tokens > cap) this.stop_reason = 'upstream_output_cap_exceeded';
            else if (this.cost_limit !== null && this.spent > this.cost_limit) this.stop_reason = 'observed_cost_exceeded';
        }
        if (transport_failed && !retain_unknown && !this.continue_on_sample_failure) this.stop_reason = 'transport_failure';
        return cost;
    }
}
/** Synchronous stream contract avoids losing raw evidence to buffered asynchronous writes. */
export interface AssessmentJournalStream {
    write(text: string): unknown;
    flush?(): unknown;
}
/** Append JSONL evidence synchronously; callers own and close the stream/file descriptor. */
export class AssessmentJournal implements AssessmentJournalWriter {
    constructor(readonly stream: AssessmentJournalStream | number) {}
    write(record_: Record<string, unknown>): void {
        const line = canonicalAssessmentJson(record_) + '\n';
        if (typeof this.stream === 'number') {
            const buffer = Buffer.from(line);
            let offset = 0;
            while (offset < buffer.length) offset += writeSync(this.stream, buffer, offset, buffer.length - offset);
            fsyncSync(this.stream);
        } else {
            const result = this.stream.write(line);
            if (result instanceof Promise) throw new Error('Assessment journal requires synchronous writes');
            const flushed = this.stream.flush?.();
            if (flushed instanceof Promise) throw new Error('Assessment journal requires synchronous flush');
        }
    }
}
/** HTTP 4xx responses other than 408 Request Timeout reject at the gateway entry before model inference. */
export function is_entry_rejection_status(status: number): boolean {
    return status >= 400 && status < 500 && status !== 408;
}
/** Retry transient API failures only; capability limits and permanent 4xx are not retried. */
export function retryable_api_status(status: number): boolean {
    return status === -1 || status === 408 || status === 429 || (status >= 500 && status <= 599);
}
/** Streamed `response.failed` error codes that mean the route is rate limited or out of quota; handled like HTTP 429. */
export const RATE_LIMIT_ERROR_CODES: ReadonlySet<string> = new Set(['rate_limit_exceeded', 'insufficient_quota']);
/** Upstream error code from a failed response payload, bounded for evidence; null when absent. */
export function upstream_error_code(payload: Record<string, unknown>): string | null {
    const error = payload.error;
    return record(error) && typeof error.code === 'string' && error.code.length ? error.code.slice(0, 80) : null;
}
/**
 * A streamed HTTP 200 can still end in `response.failed`. Upstream `server_error` (e.g. a gateway
 * losing its connection mid-reply) is transient like a 5xx, and rate-limit/quota codes are retried
 * like HTTP 429; other failure codes are not retried.
 */
export function retryable_api_response(status: number, payload: Record<string, unknown>): boolean {
    if (retryable_api_status(status)) return true;
    if (status !== 200 || payload.status !== 'failed') return false;
    const code = upstream_error_code(payload);
    return code === 'server_error' || (code !== null && RATE_LIMIT_ERROR_CODES.has(code));
}
/** Backoff remains cancellable without resending any request after cancellation. */
async function wait_api_retry(milliseconds: number, cancelled?: () => boolean): Promise<void> {
    for (let remaining = milliseconds; remaining > 0 && !cancelled?.(); remaining -= 100)
        await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
}
/** Replay complete Responses output and matching call IDs; execute only fixed task simulators. */
export async function run_assessment_sample(
    client: AssessmentClient,
    task: RunnerTask,
    target: AssessmentTarget,
    round_number: number,
    config: RunnerConfig,
    pricing: AssessmentPricing | null,
    budget: AssessmentBudgetController,
    journal: AssessmentJournalWriter,
    cancelled?: () => boolean,
    retryWait = wait_api_retry
): Promise<AssessmentObservation> {
    const sample = { task: task.id, domain: task.domain, model: target.model, thinking: target.thinking, round: round_number };
    const outputCap = config.max_output_tokens ?? undefined;
    const sampleStarted = Date.now();
    const deadline = config.timeout_scope === 'sample' ? sampleStarted + config.timeout * 1000 : Infinity;
    const expired = () => Date.now() >= deadline;
    const { execution_protocol: protocol, assessment_protocol_sha256 } = assessment_sample_protocol(task, target.thinking, config, true);
    const sample_id = assessment_hash({ ...sample, assessment_protocol_sha256 }).slice(0, 24);
    const options = protocol.requests[task.id]!;
    let history: Record<string, unknown>[] = [{ role: 'user', content: task.prompt }];
    const simulator = task.kind === 'tool' ? task.make_simulator!() : null;
    // Tool-submitted answers: grade only the last valid submit_answer arguments, never visible text.
    const submitProtocol = task_answer_protocol(task) !== null;
    const requestTools = [
        ...(simulator && Array.isArray(task.tools) ? task.tools : []),
        ...(submitProtocol ? [submit_answer_tool(task_answer_schema(task))] : [])
    ];
    let submission: { call_id: string; answer: Record<string, unknown> } | null = null,
        submissions = 0;
    const gradeSubmission = (): RunnerGrade =>
        submission === null
            ? no_submission_grade()
            : submitted_grade(
                  simulator
                      ? simulator.grade(canonicalAssessmentJson(submission.answer))
                      : task.grade!(canonicalAssessmentJson(submission.answer))
              );
    const calls: string[] = [],
        trace: AssessmentToolTrace[] = [],
        costs: (number | null)[] = [],
        usages: (AssessmentUsage | null)[] = [];
    let elapsed = 0,
        text = '',
        grade: RunnerGrade | null = null,
        outcome = 'turn_limit',
        local_error: string | null = null;
    let last_http_status: number | null = null,
        last_error_code: string | null = null;
    let unknownCallUsage = false;
    const seen = new Set<string>();
    sampleTurns: for (let turn = 1; turn <= (config.max_turns ?? Infinity); turn++) {
        if (expired()) {
            outcome = 'api_failure';
            local_error = 'SampleTimeout';
            break;
        }
        if (cancelled?.()) {
            outcome = 'cancelled';
            break;
        }
        const body: Record<string, unknown> = { model: target.model, input: history, ...options };
        if (submitProtocol) Object.assign(body, { instructions: SUBMIT_ANSWER_INSTRUCTIONS, tools: requestTools });
        else if (simulator) Object.assign(body, { tools: task.tools });
        let payload: Record<string, unknown> = {},
            status = -1,
            turnCost: number | null = null,
            turnUsage: AssessmentUsage | null = null;
        let admitted = false,
            apiFailed = false;
        const retryPolicy = config.max_api_retries !== undefined;
        for (let retry = 0; retry <= (config.max_api_retries ?? 0); retry++) {
            if (expired()) {
                outcome = 'api_failure';
                local_error = 'SampleTimeout';
                break;
            }
            if (retry > 0 && cancelled?.()) {
                outcome = 'cancelled';
                break;
            }
            const reservation = budget.admit(body, pricing);
            if (reservation === null) {
                outcome = cancelled?.() ? 'cancelled' : 'budget_not_admitted';
                break;
            }
            admitted = true;
            const call_id = `${sample_id}:${turn}${retryPolicy ? ':' + (retry + 1) : ''}`;
            let duration: number,
                raw: unknown,
                raw_response_text: string | undefined,
                headers: Record<string, string> = {};
            let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
            let cancellationTimer: ReturnType<typeof setInterval> | undefined;
            const controller = new AbortController(),
                stream = responses_stream_telemetry();
            const started = Date.now();
            try {
                const remaining = deadline - Date.now();
                const call = Promise.resolve(
                    client.post_responses_stream(body, Math.min(config.timeout, remaining / 1000), {
                        signal: controller.signal,
                        telemetry: stream
                    })
                );
                const stopped = new Promise<GatewayResponse>(resolve => {
                    const stop = (name: string) => {
                        stream.termination = name === 'TimeoutError' ? 'timeout' : 'aborted';
                        controller.abort(new DOMException(name, name));
                        resolve([-1, (Date.now() - started) / 1000, {}, { exception: name }]);
                    };
                    if (Number.isFinite(remaining)) deadlineTimer = setTimeout(() => stop('TimeoutError'), Math.max(1, remaining));
                    if (cancelled)
                        cancellationTimer = setInterval(() => {
                            if (cancelled()) stop('AbortError');
                        }, 50);
                });
                [status, duration, headers, raw, raw_response_text] = await Promise.race([call, stopped]);
            } catch (error) {
                status = -1;
                duration = 0;
                raw = { error: error_name(error) };
            } finally {
                if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
                if (cancellationTimer !== undefined) clearInterval(cancellationTimer);
                controller.abort();
            }
            apiFailed = status !== 200;
            last_http_status = status;
            payload = record(raw) ? raw : { error: 'non-object response', received: raw ?? null };
            last_error_code = upstream_error_code(payload);
            const entryRejection = is_entry_rejection_status(status);
            const cost = budget.settle(reservation, payload, pricing, outputCap, status === -1, retryPolicy, entryRejection);
            const callUsage = assessment_usage(payload) ?? (entryRejection ? { input_tokens: 0, output_tokens: 0 } : null);
            turnCost = cost;
            turnUsage = callUsage;
            if (callUsage === null || (pricing !== null && cost === null)) unknownCallUsage = true;
            journal.write({
                type: 'call',
                ...sample,
                sample_id,
                call_id,
                turn,
                ...(retryPolicy ? { api_attempt: retry + 1 } : {}),
                request: body,
                http_status: status,
                elapsed_seconds: duration,
                estimated_uncached_cost_usd: cost,
                raw_response: payload,
                stream: structuredClone(stream),
                ...(typeof raw_response_text === 'string' && raw_response_text.length ? { raw_response_text } : {})
            });
            calls.push(call_id);
            elapsed += duration;
            text = calibration_visible_text(payload);
            if (cancelled?.()) {
                outcome = 'cancelled';
                break;
            }
            if (expired()) {
                outcome = 'api_failure';
                local_error = 'SampleTimeout';
                break;
            }
            if (retry >= (config.max_api_retries ?? 0) || !retryable_api_response(status, payload)) break;
            const retryAfter = Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
            const serverDelay =
                retryAfter === undefined
                    ? 0
                    : /^\d+(?:\.\d+)?$/.test(retryAfter)
                      ? Number(retryAfter) * 1000
                      : Math.max(0, Date.parse(retryAfter) - Date.now());
            const delay_ms = Math.max(1000 * 2 ** retry, Number.isFinite(serverDelay) ? serverDelay : 0);
            if (delay_ms > 300000) break; // Do not retry earlier than a long server cooldown.
            journal.write({ type: 'api_retry', ...sample, sample_id, turn, api_attempt: retry + 2, delay_ms });
            await retryWait(Math.min(delay_ms, deadline - Date.now()), () => Boolean(cancelled?.() || expired()));
            admitted = false;
        }
        if (cancelled?.()) {
            outcome = 'cancelled';
            break;
        }
        const cost = turnCost;
        const usage = turnUsage;
        if (usage !== null) {
            costs.push(cost);
            usages.push(usage);
        }
        if (expired()) {
            outcome = 'api_failure';
            local_error = 'SampleTimeout';
            break;
        }
        if (!admitted) {
            if (retryPolicy && apiFailed && outcome !== 'cancelled') outcome = 'api_failure';
            break;
        }
        if (status !== 200 || payload.error) {
            outcome = retryPolicy ? 'api_failure' : 'response_incomplete_or_error';
            break;
        }
        if (payload.status !== 'completed') {
            outcome = retryPolicy ? 'incomplete' : 'response_incomplete_or_error';
            break;
        }
        if (usage === null || (pricing !== null && cost === null) || (outputCap !== undefined && usage.output_tokens > outputCap)) {
            outcome = retryPolicy
                ? usage === null || (pricing !== null && cost === null)
                    ? 'api_failure'
                    : 'incomplete'
                : 'usage_or_cap_failure';
            break;
        }
        const output = Object.hasOwn(payload, 'output') ? payload.output : [];
        if (!Array.isArray(output) || !output.every(record)) {
            outcome = 'invalid_response_output';
            break;
        }
        const functions = output.filter(item => item.type === 'function_call');
        if (!functions.length) {
            if (submitProtocol) {
                // The agent ended its turn: the last submission is final; none submitted scores zero.
                try {
                    grade = gradeSubmission();
                } catch (error) {
                    outcome = 'grading_error';
                    local_error = error_name(error);
                    break;
                }
                outcome = 'completed';
                break;
            }
            if (!text.trim()) {
                outcome = 'empty_final_answer';
                break;
            }
            try {
                grade = simulator ? simulator.grade(text) : task.grade!(text);
            } catch (error) {
                outcome = 'grading_error';
                local_error = error_name(error);
                break;
            }
            outcome = 'completed';
            break;
        }
        if (!simulator && !submitProtocol) {
            outcome = 'unsupported_tool_sequence';
            break;
        }
        const wireIds = functions.map(call => call.call_id);
        if (wireIds.some(id => typeof id !== 'string' || !id || seen.has(id)) || new Set(wireIds).size !== wireIds.length) {
            outcome = 'invalid_tool_call_id';
            break;
        }
        if (config.max_tool_calls !== null && trace.length + functions.length > config.max_tool_calls) {
            outcome = 'tool_call_limit';
            break;
        }
        const results: Record<string, unknown>[] = [];
        for (const call of functions) {
            if (cancelled?.()) {
                outcome = 'cancelled';
                break sampleTurns;
            }
            if (expired()) {
                outcome = 'api_failure';
                local_error = 'SampleTimeout';
                break sampleTurns;
            }
            const wire_id = call.call_id as string;
            seen.add(wire_id);
            const name = call.name ?? null;
            let result: Record<string, unknown>;
            try {
                let arguments_: Record<string, unknown> | null = null,
                    parse_error: string | null = null;
                try {
                    arguments_ = assessment_arguments(call.arguments);
                } catch (error) {
                    parse_error = error instanceof Error ? error.message : 'invalid arguments';
                }
                if (submitProtocol && name === SUBMIT_ANSWER_TOOL_NAME) {
                    submissions++;
                    if (arguments_ !== null) {
                        submission = { call_id: wire_id, answer: arguments_ };
                        result = { ...SUBMIT_ANSWER_ACCEPTED };
                    } else result = { accepted: false, error: 'arguments must be one JSON object: ' + parse_error };
                } else if (!simulator) result = { error: 'unknown tool: only submit_answer is available' };
                else {
                    result = simulator.call(name as string, arguments_);
                    if (parse_error !== null) result = { ...result, argument_parse_error: parse_error };
                }
            } catch (error) {
                outcome = 'simulator_error';
                local_error = error_name(error);
                journal.write({ type: 'tool_result', sample_id, call_id: wire_id, name, runner_error: local_error });
                break sampleTurns;
            }
            const step = { call_id: wire_id, name, arguments: call.arguments ?? null, result };
            trace.push(step);
            journal.write({ type: 'tool_result', sample_id, ...step });
            results.push({ type: 'function_call_output', call_id: wire_id, output: canonicalAssessmentJson(result) });
        }
        history = [...history, ...output, ...results];
    }
    // A deadline or upstream failure after a valid submission still ends the agent: grade its last submission.
    let ended_after_submission: string | null = null;
    if (
        submitProtocol &&
        submission !== null &&
        grade === null &&
        ['api_failure', 'incomplete', 'turn_limit', 'tool_call_limit'].includes(outcome)
    ) {
        try {
            grade = gradeSubmission();
            ended_after_submission = local_error ?? outcome;
            outcome = 'completed';
        } catch (error) {
            outcome = 'grading_error';
            local_error = error_name(error);
        }
    }
    if (outcome !== 'completed' && ended_after_submission === null && local_error !== 'SampleTimeout' && unknownCallUsage) {
        if (
            ![
                'incomplete',
                'turn_limit',
                'tool_call_limit',
                'empty_final_answer',
                'unsupported_tool_sequence',
                'invalid_tool_call_id'
            ].includes(outcome)
        ) {
            costs.push(null);
            usages.push(null);
        }
    }
    // A timeout or post-submission abort keeps earlier turns' known usage, but the unanswered call may still have
    // consumed tokens upstream, so the retained totals are only lower bounds.
    const usageIncomplete = unknownCallUsage && (local_error === 'SampleTimeout' || ended_after_submission !== null);
    const completeUsage = usages.length > 0 && usages.every((value): value is AssessmentUsage => value !== null);
    const completeCosts = pricing !== null && costs.length > 0 && costs.every((value): value is number => value !== null);
    const observation: AssessmentObservation = {
        type: 'observation',
        ...sample,
        sample_id,
        ok: outcome === 'completed',
        assessment_protocol_sha256,
        execution_protocol: protocol,
        execution_protocol_sha256: execution_protocol_hash(protocol),
        status: outcome,
        runner_error: local_error,
        grade,
        text,
        calls,
        tool_trace: trace,
        elapsed_seconds: config.timeout_scope === 'sample' ? (Date.now() - sampleStarted) / 1000 : elapsed,
        usage: completeUsage
            ? usages.reduce(
                  (total, usage) => ({
                      input_tokens: total.input_tokens + usage!.input_tokens,
                      output_tokens: total.output_tokens + usage!.output_tokens
                  }),
                  { input_tokens: 0, output_tokens: 0 }
              )
            : null,
        estimated_uncached_cost_usd: completeCosts ? costs.reduce<number>((total, cost) => total + cost!, 0) : null
    };
    if (usageIncomplete) observation.usage_incomplete = true;
    if (simulator || submitProtocol) observation.tool_execution_policy = 'ordered-batch-v1';
    if (submitProtocol)
        observation.answer_submission = {
            protocol: task.answer_protocol,
            call_id: submission?.call_id ?? null,
            answer: submission ? structuredClone(submission.answer) : null,
            submissions,
            ended_after_submission
        };
    if (config.max_api_retries !== undefined)
        Object.assign(observation, {
            api_request_count: calls.length,
            last_http_status,
            ...(last_error_code !== null ? { last_error_code } : {})
        });
    journal.write(observation);
    console.log(task.id, target.model, target.thinking, round_number, outcome, grade?.content_score ?? null);
    return observation;
}
