import { parseAssessmentJson, canonicalAssessmentJson } from './assessment_json.ts';
import { _validate_route_url } from './bench_routes.ts';
import {
    ResponsesStreamDecoder,
    ResponsesStreamProtocolError,
    responses_stream_telemetry,
    type ResponsesStreamTelemetry
} from './responses_stream.ts';

/** Raw chunks are synchronously persisted before parsing; abort stops the in-flight request. */
export interface GatewayStreamOptions {
    signal?: AbortSignal;
    telemetry?: ResponsesStreamTelemetry;
    on_chunk?: (text: string, elapsed_seconds: number) => void;
}

/** Transport result preserves HTTP status and nullable/invalid raw payloads for journaling. */
export type GatewayResponse = [number, number, Record<string, string>, unknown, string?];
/** Model metadata is upstream data, not verified identity or pricing. */
export type GatewayCatalog = Record<string, Record<string, unknown>>;
/** Responses-only client; no redirects, retries, account switching or Chat Completions fallback. */
export class GatewayClient {
    readonly base_url: string;
    constructor(
        base_url: string,
        readonly api_key: string,
        readonly default_timeout = 150
    ) {
        if (!_validate_route_url(base_url)) throw new TypeError('Gateway endpoint must use HTTPS or loopback HTTP without URL credentials');
        if (typeof api_key !== 'string' || !api_key || /[\s\x00-\x1f\x7f]/u.test(api_key))
            throw new TypeError('Gateway credential is missing or invalid');
        const url = base_url.replace(/\/+$/, '');
        this.base_url = url.endsWith('/v1') ? url : url + '/v1';
    }
    _headers(): Record<string, string> {
        return { Authorization: `Bearer ${this.api_key}`, 'Content-Type': 'application/json' };
    }
    async fetch_models_catalog(): Promise<GatewayCatalog> {
        try {
            const response = await fetch(`${this.base_url}/models`, {
                method: 'GET',
                headers: this._headers(),
                redirect: 'manual',
                signal: AbortSignal.timeout(15000)
            });
            if (!response.ok) {
                await response.body?.cancel();
                return {};
            }
            const data = parseAssessmentJson(await response.text());
            if (!data || typeof data !== 'object' || !('data' in data) || !Array.isArray(data.data)) return {};
            return Object.fromEntries(
                data.data
                    .filter(
                        (model): model is Record<string, unknown> & { id: string } =>
                            model !== null && typeof model === 'object' && typeof model.id === 'string'
                    )
                    .map(model => [model.id, model])
            );
        } catch {
            return {};
        }
    }
    async post_responses_stream(
        body: Record<string, unknown>,
        timeout?: number,
        options: GatewayStreamOptions = {}
    ): Promise<GatewayResponse> {
        const start = performance.now();
        const duration = () => (performance.now() - start) / 1000;
        const telemetry = options.telemetry ?? responses_stream_telemetry();
        const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.ceil((timeout ?? this.default_timeout) * 1000)));
        const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let headers: Record<string, string> = {};
        let raw: string | undefined = options.on_chunk ? undefined : '';
        let journalError: unknown;
        const onFrame = options.on_chunk
            ? (text: string, time: number) => {
                  try {
                      options.on_chunk!(text, time);
                  } catch (error) {
                      journalError = error;
                      throw error;
                  }
              }
            : undefined;
        const decoder = new ResponsesStreamDecoder(telemetry, duration, onFrame);
        try {
            const response = await fetch(`${this.base_url}/responses`, {
                method: 'POST',
                body: canonicalAssessmentJson({ ...body, stream: true }),
                headers: { ...this._headers(), Accept: 'text/event-stream' },
                redirect: 'manual',
                signal
            });
            headers = Object.fromEntries(response.headers);
            telemetry.http_status = response.status;
            if (!response.ok) {
                telemetry.termination = 'http_error';
                const errorRaw = await response.text();
                let payload: unknown;
                try {
                    payload = parseAssessmentJson(errorRaw);
                } catch {
                    payload = { raw_error: errorRaw.slice(0, 400) };
                }
                return [response.status, duration(), headers, payload, errorRaw];
            }
            if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream' || !response.body) {
                await response.body?.cancel();
                throw new ResponsesStreamProtocolError('Responses stream requires text/event-stream');
            }
            reader = response.body.getReader();
            const utf8 = new TextDecoder('utf-8', { fatal: true });
            while (decoder.response === null) {
                const { value, done } = await reader.read();
                if (done) {
                    const tail = utf8.decode();
                    if (raw !== undefined) raw += tail;
                    decoder.push(tail);
                    decoder.finish();
                    break;
                }
                const time = duration();
                telemetry.first_byte_seconds ??= time;
                telemetry.last_byte_seconds = time;
                const text = utf8.decode(value, { stream: true });
                if (raw !== undefined) raw += text;
                decoder.push(text);
            }
            // A terminal event is sufficient; do not wait for a gateway to close a keep-alive body.
            return [response.status, duration(), headers, decoder.response, raw];
        } catch (error) {
            if (journalError !== undefined) throw journalError;
            decoder.flush_pending();
            telemetry.termination = signal.aborted
                ? signal.reason?.name === 'TimeoutError'
                    ? 'timeout'
                    : 'aborted'
                : error instanceof ResponsesStreamProtocolError
                  ? 'protocol_error'
                  : 'transport_error';
            return [-1, duration(), headers, { exception: error instanceof Error ? error.name : 'Error' }, raw];
        } finally {
            if (reader) {
                try {
                    await reader.cancel();
                } catch {}
                reader.releaseLock();
            }
        }
    }
    /** Explicit non-stream transport retained for controlled comparisons; assessment execution uses SSE. */
    async post_responses_non_stream(body: Record<string, unknown>, timeout?: number): Promise<GatewayResponse> {
        const start = performance.now();
        const duration = () => Math.round((performance.now() - start) / 10) / 100;
        try {
            const response = await fetch(`${this.base_url}/responses`, {
                method: 'POST',
                body: canonicalAssessmentJson(body),
                headers: this._headers(),
                redirect: 'manual',
                signal: AbortSignal.timeout(Math.max(1, Math.ceil((timeout || this.default_timeout) * 1000)))
            });
            const raw = await response.text();
            let payload: unknown;
            try {
                payload = parseAssessmentJson(raw);
            } catch {
                if (response.ok) return [-1, duration(), {}, { exception: 'Invalid gateway JSON response' }, raw];
                payload = { raw_error: raw.slice(0, 400) };
            }
            return [response.status, duration(), Object.fromEntries(response.headers), payload, raw];
        } catch (error) {
            // Exception messages may contain endpoint credentials; expose only a class name.
            return [-1, duration(), {}, { exception: error instanceof Error ? error.name : 'Error' }];
        }
    }
}
