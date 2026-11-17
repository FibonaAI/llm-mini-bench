import { parseAssessmentJson } from './assessment_json.ts';

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
    private line = '';
    private skipLF = false;
    private firstCharacter = true;
    private data: string[] = [];
    private event = '';
    private rawFrame = '';
    constructor(
        readonly telemetry: ResponsesStreamTelemetry,
        private readonly elapsed: () => number,
        private readonly on_frame?: (text: string, elapsed_seconds: number) => void
    ) {}
    flush_pending(): void {
        if (!this.rawFrame) return;
        const text = this.rawFrame;
        this.rawFrame = '';
        this.on_frame?.(text, this.elapsed());
    }
    push(text: string): void {
        for (const character of text) {
            this.rawFrame += character;
            if (this.firstCharacter) {
                this.firstCharacter = false;
                if (character === '\uFEFF') continue;
            }
            if (this.skipLF) {
                this.skipLF = false;
                if (character === '\n') continue;
            }
            if (character === '\r' || character === '\n') {
                const line = this.line;
                this.line = '';
                this.skipLF = character === '\r';
                this.acceptLine(line);
            } else this.line += character;
            if (this.response !== null) return;
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
        try {
            value = parseAssessmentJson(data);
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
            this.response = value.response;
        } else return;
        this.terminal_event_data = data;
        this.telemetry.terminal_event = value.type;
        this.telemetry.termination = 'terminal';
    }
}
