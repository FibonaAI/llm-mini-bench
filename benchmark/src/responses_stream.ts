import { parseAssessmentJson } from './assessment_json.ts';
import { parseStrictJson, parseStrictJsonWithResponseUsage } from './bench_execution_storage.ts';

/** Stream timing is local receipt evidence, not proof of upstream computation or identity. */
export interface ResponsesStreamTelemetry {
    protocol: 'responses-sse-v1';
    http_status: number | null;
    first_byte_seconds: number | null;
    last_byte_seconds: number | null;
    first_event_seconds: number | null;
    first_output_seconds: number | null;
    last_progress_seconds: number | null;
    event_count: number;
    terminal_event: string | null;
    termination: 'pending' | 'terminal' | 'http_error' | 'timeout' | 'aborted' | 'transport_error' | 'protocol_error';
}
/** Fresh timing evidence for one HTTP attempt, never shared across retries. */
export function responses_stream_telemetry(): ResponsesStreamTelemetry {
    return {
        protocol: 'responses-sse-v1',
        http_status: null,
        first_byte_seconds: null,
        last_byte_seconds: null,
        first_event_seconds: null,
        first_output_seconds: null,
        last_progress_seconds: null,
        event_count: 0,
        terminal_event: null,
        termination: 'pending'
    };
}
/** Invalid or prematurely closed SSE is an infrastructure exception, not a completed answer. */
export class ResponsesStreamProtocolError extends Error {
    override name = 'ResponsesStreamProtocolError';
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Incremental SSE decoder accepts LF/CRLF/CR and requires an explicit Responses terminal event. */
export class ResponsesStreamDecoder {
    response: Record<string, unknown> | null = null;
    terminal_event_data: string | null = null;
    private lineParts: string[] = [];
    private skipLF = false;
    private firstCharacter = true;
    private data: string[] = [];
    private event = '';
    private rawFrameParts: string[] = [];
    constructor(
        readonly telemetry: ResponsesStreamTelemetry,
        private readonly elapsed: () => number,
        private readonly on_frame?: (text: string, elapsed_seconds: number) => void
    ) {}
    flush_pending(): void {
        if (!this.rawFrameParts.length) return;
        const text = this.rawFrameParts.length === 1 ? this.rawFrameParts[0]! : this.rawFrameParts.join('');
        this.rawFrameParts.length = 0;
        this.on_frame?.(text, this.elapsed());
    }
    push(text: string): void {
        let index = 0;
        const length = text.length;
        while (index < length && this.response === null) {
            if (this.firstCharacter) {
                this.firstCharacter = false;
                if (text.charCodeAt(index) === 0xfeff) {
                    if (this.on_frame) this.rawFrameParts.push('\uFEFF');
                    index++;
                    continue;
                }
            }
            if (this.skipLF) {
                this.skipLF = false;
                if (text.charCodeAt(index) === 0x0a) {
                    if (this.on_frame) this.rawFrameParts.push('\n');
                    index++;
                    continue;
                }
            }
            let end = index;
            while (end < length) {
                const code = text.charCodeAt(end);
                if (code === 0x0d || code === 0x0a) break;
                end++;
            }
            if (end > index) {
                const segment = index === 0 && end === length ? text : text.slice(index, end);
                if (this.on_frame) this.rawFrameParts.push(segment);
                this.lineParts.push(segment);
                index = end;
            }
            if (index < length) {
                const isCR = text.charCodeAt(index) === 0x0d;
                if (isCR && index + 1 < length && text.charCodeAt(index + 1) === 0x0a) {
                    if (this.on_frame) this.rawFrameParts.push('\r\n');
                    index += 2;
                    this.skipLF = false;
                } else {
                    if (this.on_frame) this.rawFrameParts.push(isCR ? '\r' : '\n');
                    index++;
                    this.skipLF = isCR;
                }
                const line = this.lineParts.length === 0 ? '' : this.lineParts.length === 1 ? this.lineParts[0]! : this.lineParts.join('');
                this.lineParts.length = 0;
                this.acceptLine(line);
            }
        }
    }
    finish(): void {
        if (this.response === null) throw new ResponsesStreamProtocolError('Responses stream ended before a terminal event');
    }
    private acceptLine(line: string): void {
        if (line === '') {
            this.flush_pending();
            this.dispatch();
            return;
        }
        if (line.startsWith(':')) return;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') this.data.push(value);
        else if (field === 'event') this.event = value;
    }
    private dispatch(): void {
        const data = this.data.join('\n'),
            event = this.event;
        const hasData = this.data.length > 0;
        this.data = [];
        this.event = '';
        if (!hasData) return;
        if (data === '[DONE]') throw new ResponsesStreamProtocolError('Responses stream DONE marker has no terminal response');
        let value: unknown;
        let usageJson: string | null = null;
        try {
            if (data.includes('"usage"')) {
                const parsed = parseStrictJsonWithResponseUsage(data);
                value = parsed.value;
                usageJson = parsed.usageJson;
            } else {
                value = parseStrictJson(data);
            }
        } catch {
            throw new ResponsesStreamProtocolError('Responses stream contains invalid JSON');
        }
        if (!object(value) || typeof value.type !== 'string' || !value.type || (event && event !== value.type))
            throw new ResponsesStreamProtocolError('Responses stream event type is invalid');
        const time = this.elapsed();
        this.telemetry.event_count++;
        this.telemetry.first_event_seconds ??= time;
        if (
            [
                'response.output_text.delta',
                'response.reasoning_text.delta',
                'response.reasoning_summary_text.delta',
                'response.function_call_arguments.delta'
            ].includes(value.type) &&
            typeof value.delta === 'string' &&
            value.delta.length > 0
        ) {
            this.telemetry.first_output_seconds ??= time;
            this.telemetry.last_progress_seconds = time;
        }
        if (value.type === 'error') {
            this.response = { error: value };
        } else if (['response.completed', 'response.failed', 'response.incomplete'].includes(value.type)) {
            if (!object(value.response) || value.response.status !== value.type.slice('response.'.length))
                throw new ResponsesStreamProtocolError('Responses stream terminal status is inconsistent');
            // Re-parse only the small usage object with parseAssessmentJson so integer/float token checks remain exact.
            if (usageJson !== null && object(value.response.usage)) {
                value.response.usage = parseAssessmentJson(usageJson);
            }
            this.response = value.response;
        } else return;
        this.terminal_event_data = data;
        this.telemetry.terminal_event = value.type;
        this.telemetry.termination = 'terminal';
    }
}
