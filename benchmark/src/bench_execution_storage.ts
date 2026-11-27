import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { calibration_visible_text } from './assessment_response.ts';
import type { SessionEventRecord } from './bench_db.ts';

type RecordValue = Record<string, unknown>;
const uuid = () => randomUUID().replaceAll('-', '');
const clone = <T>(value: T): T => structuredClone(value);
const object = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, limit = 300): string | null => (typeof value === 'string' && value.length ? value.slice(0, limit) : null);
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const integer = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) ? value : null);

/** Truncate raw error diagnostics kept for failed turns so failures stay debuggable without bloating storage. */
export const MAX_RAW_ERROR_EXCERPT_CHARS = 32 * 1024;

/** Compare strings in Unicode code-point order without allocating intermediate arrays. */
function compareCodePoints(left: string, right: string): number {
    let i = 0,
        j = 0;
    while (i < left.length && j < right.length) {
        const a = left.codePointAt(i)!,
            b = right.codePointAt(j)!;
        if (a !== b) return a - b;
        i += a > 0xffff ? 2 : 1;
        j += b > 0xffff ? 2 : 1;
    }
    return left.length - i - (right.length - j);
}

function scanStrictJson(text: string, maxDepth: number, captureResponseUsage: boolean): string | null {
    if (typeof text !== 'string') throw new SyntaxError('Assessment JSON: input must be text');
    const len = text.length;
    let pos = 0;
    const fail = (): never => {
        throw new SyntaxError('Assessment JSON: invalid JSON syntax');
    };
    const skipWs = () => {
        while (pos < len) {
            const c = text.charCodeAt(pos);
            if (c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a) pos++;
            else break;
        }
    };
    const scanString = (decode: boolean): string => {
        const start = pos++;
        let hasEscape = false;
        while (pos < len) {
            const c = text.charCodeAt(pos++);
            if (c === 0x22) {
                if (!decode) return '';
                if (!hasEscape) return text.slice(start + 1, pos - 1);
                try {
                    return JSON.parse(text.slice(start, pos)) as string;
                } catch {
                    return fail();
                }
            }
            if (c === 0x5c) {
                hasEscape = true;
                if (pos >= len) return fail();
                pos++;
            } else if (c < 0x20) {
                return fail();
            }
        }
        return fail();
    };
    const scanNumber = () => {
        const start = pos;
        if (text.charCodeAt(pos) === 0x2d) pos++;
        if (pos >= len) fail();
        const first = text.charCodeAt(pos);
        if (first === 0x30) {
            pos++;
        } else if (first >= 0x31 && first <= 0x39) {
            pos++;
            while (pos < len) {
                const c = text.charCodeAt(pos);
                if (c >= 0x30 && c <= 0x39) pos++;
                else break;
            }
        } else {
            fail();
        }
        if (pos < len && text.charCodeAt(pos) === 0x2e) {
            pos++;
            if (pos >= len) fail();
            const frac = text.charCodeAt(pos);
            if (frac < 0x30 || frac > 0x39) fail();
            pos++;
            while (pos < len) {
                const c = text.charCodeAt(pos);
                if (c >= 0x30 && c <= 0x39) pos++;
                else break;
            }
        }
        let hasExp = false;
        if (pos < len) {
            const e = text.charCodeAt(pos);
            if (e === 0x65 || e === 0x45) {
                hasExp = true;
                pos++;
                if (pos < len) {
                    const sign = text.charCodeAt(pos);
                    if (sign === 0x2b || sign === 0x2d) pos++;
                }
                if (pos >= len) fail();
                const d = text.charCodeAt(pos);
                if (d < 0x30 || d > 0x39) fail();
                pos++;
                while (pos < len) {
                    const c = text.charCodeAt(pos);
                    if (c >= 0x30 && c <= 0x39) pos++;
                    else break;
                }
            }
        }
        if (hasExp || pos - start > 308) {
            const value = Number(text.slice(start, pos));
            if (!Number.isFinite(value)) throw new SyntaxError('Assessment JSON: nonfinite number');
        }
    };

    // Container stack: 0 = array, 1 = object.
    const kinds: number[] = [];
    const firstKeys: Array<string | null> = [];
    const keySets: Array<Set<string> | null> = [];
    let inResponse = false;
    let capturingUsage = false;
    let usageStart = -1;
    let usageEnd = -1;

    const readObjectKey = () => {
        if (pos >= len || text.charCodeAt(pos) !== 0x22) fail();
        const key = scanString(true);
        const top = kinds.length - 1;
        const first = firstKeys[top];
        if (first === null) {
            firstKeys[top] = key;
        } else {
            let set = keySets[top];
            if (!set) {
                if (first === key) throw new SyntaxError('Assessment JSON: duplicate object key');
                set = new Set<string>([first, key]);
                keySets[top] = set;
            } else {
                if (set.has(key)) throw new SyntaxError('Assessment JSON: duplicate object key');
                set.add(key);
            }
        }
        skipWs();
        if (pos >= len || text.charCodeAt(pos++) !== 0x3a) fail();
        if (captureResponseUsage) {
            if (kinds.length === 1) {
                inResponse = key === 'response';
            } else if (kinds.length === 2 && inResponse && key === 'usage') {
                skipWs();
                capturingUsage = true;
                usageStart = pos;
            }
        }
    };

    // State: expecting a value at current depth = kinds.length.
    for (;;) {
        if (kinds.length > maxDepth) throw new SyntaxError('Assessment JSON: nesting limit exceeded');
        skipWs();
        if (pos >= len) fail();
        const c = text.charCodeAt(pos);
        if (c === 0x7b || c === 0x5b) {
            const isObject = c === 0x7b;
            const endChar = isObject ? 0x7d : 0x5d;
            pos++;
            skipWs();
            if (pos < len && text.charCodeAt(pos) === endChar) {
                pos++;
                // Empty container finished; fall through to post-value transitions.
            } else {
                kinds.push(isObject ? 1 : 0);
                firstKeys.push(null);
                keySets.push(null);
                if (isObject) readObjectKey();
                continue;
            }
        } else if (c === 0x22) {
            scanString(false);
        } else if (c === 0x74) {
            if (!text.startsWith('true', pos)) fail();
            pos += 4;
        } else if (c === 0x66) {
            if (!text.startsWith('false', pos)) fail();
            pos += 5;
        } else if (c === 0x6e) {
            if (!text.startsWith('null', pos)) fail();
            pos += 4;
        } else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
            scanNumber();
        } else {
            fail();
        }

        // Completed a value; advance parent containers until we expect the next value or finish.
        let needValue = false;
        while (kinds.length > 0) {
            if (capturingUsage && kinds.length === 2) {
                usageEnd = pos;
                capturingUsage = false;
            }
            if (inResponse && kinds.length === 1) {
                inResponse = false;
            }
            skipWs();
            if (pos >= len) fail();
            const isObject = kinds[kinds.length - 1] === 1;
            const next = text.charCodeAt(pos++);
            if (next === 0x2c) {
                skipWs();
                if (isObject) readObjectKey();
                needValue = true;
                break;
            }
            if (next !== (isObject ? 0x7d : 0x5d)) fail();
            kinds.pop();
            firstKeys.pop();
            keySets.pop();
        }
        if (!needValue) break;
    }

    skipWs();
    if (pos !== len) fail();
    return usageStart >= 0 && usageEnd > usageStart ? text.slice(usageStart, usageEnd) : null;
}

/**
 * Strict JSON parser with identical validation semantics to parseAssessmentJson
 * (rejecting duplicate object keys, nonfinite numbers, and excessive nesting)
 * without allocating canonical strings, number-token WeakMaps, or full-tail slices.
 */
export function parseStrictJson(text: string, maxDepth = 100): unknown {
    scanStrictJson(text, maxDepth, false);
    return JSON.parse(text);
}

/** Strict JSON parser that also returns the raw JSON slice of `response.usage` when present. */
export function parseStrictJsonWithResponseUsage(text: string, maxDepth = 100): { value: unknown; usageJson: string | null } {
    const usageJson = scanStrictJson(text, maxDepth, true);
    return { value: JSON.parse(text), usageJson };
}

/** Allocation-lean serializer with byte-identical output and validation to canonicalAssessmentJson. */
export function canonicalStorageJson(value: unknown): string {
    const ancestors = new Set<object>();
    function serialize(node: unknown, depth: number): string {
        if (depth > 100) throw new Error('Assessment JSON: nesting limit exceeded');
        if (node === null) return 'null';
        const kind = typeof node;
        if (kind === 'boolean' || kind === 'string') return JSON.stringify(node);
        if (kind === 'number') {
            if (!Number.isFinite(node)) throw new Error('Assessment JSON: nonfinite number');
            return JSON.stringify(node);
        }
        if (kind !== 'object') throw new Error('Assessment JSON: unsupported value');
        const target = node as object;
        if (ancestors.has(target)) throw new Error('Assessment JSON: cyclic value');
        ancestors.add(target);
        try {
            if (Array.isArray(target)) {
                if (!target.length) return '[]';
                let out = '[';
                for (let i = 0; i < target.length; i++) {
                    if (i > 0) out += ',';
                    out += serialize(target[i], depth + 1);
                }
                return out + ']';
            }
            const proto = Object.getPrototypeOf(target);
            if (proto !== Object.prototype && proto !== null) throw new Error('Assessment JSON: object must be a plain record');
            const keys = Object.keys(target);
            if (!keys.length) return '{}';
            if (keys.length > 1) keys.sort(compareCodePoints);
            const record = target as RecordValue;
            let out = '{';
            for (let i = 0; i < keys.length; i++) {
                const key = keys[i]!;
                if (i > 0) out += ',';
                out += JSON.stringify(key) + ':' + serialize(record[key], depth + 1);
            }
            return out + '}';
        } finally {
            ancestors.delete(target);
        }
    }
    return serialize(value, 0);
}

/** Create private directories without changing permissions of existing ancestors. */
export function private_directory(path: string): void {
    if (!existsSync(dirname(path))) private_directory(dirname(path));
    mkdirSync(path, { mode: 0o700, recursive: true });
    chmodSync(path, 0o700);
}

/** Atomic private JSON write for exports, manifests, and standalone tools. */
export function save_execution_json(path: string, value: unknown): void {
    const temporary = join(dirname(path), '.tmp-' + uuid());
    let fd: number | undefined;
    try {
        fd = openSync(temporary, 'wx', 0o600);
        writeFileSync(fd, canonicalStorageJson(value) + '\n');
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temporary, path);
    } finally {
        if (fd !== undefined) closeSync(fd);
        if (existsSync(temporary)) unlinkSync(temporary);
    }
}

/** Redact configured upstream secrets before writing any diagnostic or session evidence. */
export class SecretRedactor {
    readonly secrets: string[];
    constructor(secrets: string[]) {
        this.secrets = [...new Set(secrets.filter(value => value && value.length >= 4))].sort((a, b) => b.length - a.length);
    }
    redactString(value: string): string {
        let out = value;
        for (const secret of this.secrets) if (out.includes(secret)) out = out.replaceAll(secret, '[REDACTED]');
        return out;
    }
    redactTracked(value: unknown, state: { changed: boolean }): unknown {
        if (typeof value === 'string') {
            const next = this.redactString(value);
            if (next !== value) state.changed = true;
            return next;
        }
        if (Array.isArray(value)) return value.map(item => this.redactTracked(item, state));
        if (object(value))
            return Object.fromEntries(
                Object.entries(value).map(([key, item]) => [this.redactTracked(key, state), this.redactTracked(item, state)])
            );
        return value;
    }
    redact(value: unknown): unknown {
        if (!this.secrets.length) return value;
        if (typeof value === 'string') return this.redactString(value);
        if (Array.isArray(value)) return value.map(item => this.redact(item));
        if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.redact(key), this.redact(item)]));
        return value;
    }
    redactRawText(raw: string): string {
        const out = this.redactString(raw);
        if (!out.includes('\\')) return out;
        return out.replace(/"(?:\\[\s\S]|[^"\\])*"/g, token => {
            if (!token.includes('\\')) return token;
            try {
                const decoded: unknown = JSON.parse(token);
                const redacted = typeof decoded === 'string' ? this.redactString(decoded) : this.redact(decoded);
                return redacted === decoded ? token : JSON.stringify(redacted);
            } catch {
                return token;
            }
        });
    }
    redactRecord(record: RecordValue, cloneUnredacted = true): RecordValue {
        if (!this.secrets.length) return cloneUnredacted ? clone(record) : { ...record };
        const result: RecordValue = { ...record };
        const state = { changed: false };
        for (const key of ['raw_response', 'text', 'tool_trace', 'runner_error', 'result', 'arguments', 'request', 'answer_submission'])
            if (key in result) result[key] = this.redactTracked(result[key], state);
        for (const field of ['raw_response_text', 'raw_stream_text'])
            if (typeof result[field] === 'string') {
                const before = result[field];
                const after = this.redactRawText(before);
                if (after !== before) {
                    result[field] = after;
                    state.changed = true;
                }
            }
        if (record.type === 'tool_result') {
            for (const key of ['name', 'call_id']) if (key in result) result[key] = this.redactTracked(result[key], state);
        }
        if (state.changed) result.redaction_applied = true;
        return result;
    }
}

function extractReasoningSummary(raw: RecordValue): string[] {
    if (!Array.isArray(raw.output)) return [];
    const summaries: string[] = [];
    for (const item of raw.output) {
        if (!object(item) || item.type !== 'reasoning') continue;
        if (Array.isArray(item.summary)) {
            for (const part of item.summary) {
                if (object(part) && typeof part.text === 'string' && part.text.length > 0) summaries.push(part.text);
            }
        }
    }
    return summaries;
}

function extractToolCalls(raw: RecordValue): Array<{ call_id: string | null; name: string | null; arguments: unknown }> {
    if (!Array.isArray(raw.output)) return [];
    const calls: Array<{ call_id: string | null; name: string | null; arguments: unknown }> = [];
    for (const item of raw.output) {
        if (!object(item) || item.type !== 'function_call') continue;
        calls.push({
            call_id: text(item.call_id, 200),
            name: text(item.name, 200),
            arguments: item.arguments ?? null
        });
    }
    return calls;
}

function extractRawErrorExcerpt(record: RecordValue, raw: RecordValue): string | null {
    if (typeof record.raw_response_text === 'string' && record.raw_response_text.length > 0) {
        return record.raw_response_text.slice(0, MAX_RAW_ERROR_EXCERPT_CHARS);
    }
    if (typeof raw.raw_error === 'string' && raw.raw_error.length > 0) {
        return raw.raw_error.slice(0, MAX_RAW_ERROR_EXCERPT_CHARS);
    }
    if (raw.error !== undefined && raw.error !== null) {
        try {
            const serialized = typeof raw.error === 'string' ? raw.error : JSON.stringify(raw.error);
            if (serialized.length > 0) return serialized.slice(0, MAX_RAW_ERROR_EXCERPT_CHARS);
        } catch {
            /* Ignore unserializable error fragments. */
        }
    }
    return null;
}

/**
 * Project one runner or legacy journal record into a compact Pi Session-style SQLite event.
 * Raw SSE stream chunks and repeated conversation histories are intentionally excluded.
 */
export function build_session_event(
    record: RecordValue,
    run_id: string,
    seq: number,
    fallbackAttemptId?: string
): SessionEventRecord | null {
    const type = record.type;
    if (type === 'stream_chunk' || typeof type !== 'string') return null;

    const sample_id = String(record.sample_id ?? '');
    const attempt_id =
        typeof record.attempt_id === 'string' && record.attempt_id.length > 0
            ? record.attempt_id
            : (fallbackAttemptId ?? `${run_id}:${sample_id}:1`);
    const created_at = typeof record.created_at === 'string' ? record.created_at : new Date().toISOString();

    if (type === 'call') {
        const raw = object(record.raw_response) ? record.raw_response : {};
        const stream = object(record.stream) ? record.stream : {};
        const error = raw.error;
        const usageObj = object(raw.usage) ? raw.usage : null;
        const input_tokens = usageObj ? integer(usageObj.input_tokens) : null;
        const output_tokens = usageObj ? integer(usageObj.output_tokens) : null;
        const usage_known = input_tokens !== null && input_tokens >= 0 && output_tokens !== null && output_tokens >= 0;
        const http_status = finite(record.http_status);
        const response_status = text(raw.status, 40);
        const error_code = object(error)
            ? (text(error.code, 80) ?? text(error.type, 80))
            : typeof error === 'string'
              ? text(error, 80)
              : null;
        const error_message = object(error) ? text(error.message, 300) : null;
        const local_exception = text(raw.exception, 80);

        const payload: RecordValue = {};
        const assistantText = calibration_visible_text(raw);
        if (assistantText.length > 0) payload.assistant_text = assistantText;
        const reasoningSummary = extractReasoningSummary(raw);
        if (reasoningSummary.length > 0) payload.reasoning_summary = reasoningSummary;
        const toolCalls = extractToolCalls(raw);
        if (toolCalls.length > 0) payload.tool_calls = toolCalls;
        if (Object.keys(stream).length > 0) payload.stream = stream;
        if (record.redaction_applied === true) payload.redaction_applied = true;

        const failedTurn = http_status !== 200 || response_status !== 'completed' || error_code !== null || local_exception !== null;
        if (failedTurn) {
            const excerpt = extractRawErrorExcerpt(record, raw);
            if (excerpt !== null) payload.raw_error_excerpt = excerpt;
        }

        return {
            run_id,
            sample_id,
            attempt_id,
            seq,
            kind: 'llm_turn',
            call_id: String(record.call_id ?? ''),
            turn: finite(record.turn),
            api_attempt: finite(record.api_attempt),
            http_status,
            elapsed_seconds: finite(record.elapsed_seconds),
            usage_known,
            input_tokens: usage_known ? input_tokens : null,
            output_tokens: usage_known ? output_tokens : null,
            estimated_cost_usd: finite(record.estimated_uncached_cost_usd),
            response_status,
            error_code,
            error_message,
            local_exception,
            terminal_event: text(stream.terminal_event, 80),
            termination: text(stream.termination, 40),
            first_output_seconds: finite(stream.first_output_seconds),
            last_progress_seconds: finite(stream.last_progress_seconds),
            payload: Object.keys(payload).length > 0 ? payload : null,
            created_at
        };
    }

    if (type === 'tool_result') {
        const payload: RecordValue = {
            name: record.name ?? null,
            ...(Object.hasOwn(record, 'arguments') ? { arguments: record.arguments ?? null } : {}),
            ...(Object.hasOwn(record, 'result') ? { result: record.result ?? null } : {}),
            ...(typeof record.runner_error === 'string' ? { runner_error: record.runner_error } : {}),
            ...(record.redaction_applied === true ? { redaction_applied: true } : {})
        };
        return {
            run_id,
            sample_id,
            attempt_id,
            seq,
            kind: 'tool_result',
            call_id: text(record.call_id, 200),
            payload,
            created_at
        };
    }

    if (type === 'api_retry') {
        return {
            run_id,
            sample_id,
            attempt_id,
            seq,
            kind: 'api_retry',
            turn: finite(record.turn),
            api_attempt: finite(record.api_attempt),
            payload: { delay_ms: finite(record.delay_ms) },
            created_at
        };
    }

    if (type === 'observation') {
        const grade = object(record.grade) ? record.grade : null;
        const payload: RecordValue = {
            status: String(record.status ?? ''),
            ok: record.ok === true,
            ...(record.runner_error !== undefined ? { runner_error: record.runner_error } : {}),
            ...(grade ? { outcome: grade.outcome ?? null, content_score: grade.content_score ?? null } : {}),
            ...(object(record.answer_submission) ? { answer_submission: record.answer_submission } : {}),
            ...(record.redaction_applied === true ? { redaction_applied: true } : {})
        };
        return {
            run_id,
            sample_id,
            attempt_id,
            seq,
            kind: 'grade',
            elapsed_seconds: finite(record.elapsed_seconds),
            estimated_cost_usd: finite(record.estimated_uncached_cost_usd),
            payload,
            created_at
        };
    }

    if (type === 'worker_error') {
        return {
            run_id,
            sample_id,
            attempt_id,
            seq,
            kind: 'worker_error',
            payload: {
                runner_error: typeof record.runner_error === 'string' ? record.runner_error : 'Error',
                ...(record.redaction_applied === true ? { redaction_applied: true } : {})
            },
            created_at
        };
    }

    return null;
}

export interface SessionEventSink {
    insert_session_event(event: SessionEventRecord): void;
}

/** Synchronous Pi Session-style event journal writing redacted events straight into SQLite. */
export class SessionJournal {
    readonly redactor: SecretRedactor;
    private readonly attemptSeq = new Map<string, number>();

    constructor(
        private readonly sink: SessionEventSink,
        readonly run_id: string,
        secrets: string[]
    ) {
        this.redactor = new SecretRedactor(secrets);
    }

    redact(value: unknown): unknown {
        return this.redactor.redact(value);
    }

    redact_record(record: RecordValue): RecordValue {
        return this.redactor.redactRecord(record);
    }

    write(record: RecordValue, alreadyRedacted = false): void {
        if (record.type === 'stream_chunk') return;
        const prepared = alreadyRedacted ? record : this.redactor.redactRecord(record);
        const attemptKey =
            typeof prepared.attempt_id === 'string' && prepared.attempt_id.length > 0
                ? prepared.attempt_id
                : `${this.run_id}:${String(prepared.sample_id ?? '')}`;
        const seq = (this.attemptSeq.get(attemptKey) ?? 0) + 1;
        this.attemptSeq.set(attemptKey, seq);
        const event = build_session_event(prepared, this.run_id, seq, attemptKey);
        if (event) this.sink.insert_session_event(event);
    }

    close(): void {
        /* Database lifecycle is owned by the execution service. */
    }
}

/** Project a call's raw_response down to only fields retained by build_session_event before redaction. */
function compactCallRawResponse(raw: unknown): unknown {
    if (!object(raw)) return raw;
    const compact: RecordValue = {};
    if (raw.status !== undefined) compact.status = raw.status;
    if (object(raw.usage)) {
        compact.usage = {
            ...(raw.usage.input_tokens !== undefined ? { input_tokens: raw.usage.input_tokens } : {}),
            ...(raw.usage.output_tokens !== undefined ? { output_tokens: raw.usage.output_tokens } : {})
        };
    }
    if (raw.error !== undefined) compact.error = raw.error;
    if (raw.exception !== undefined) compact.exception = raw.exception;
    if (raw.raw_error !== undefined) compact.raw_error = raw.raw_error;
    if (typeof raw.output_text === 'string') compact.output_text = raw.output_text;
    if (Array.isArray(raw.output)) {
        const output: RecordValue[] = [];
        for (const item of raw.output) {
            if (!object(item)) continue;
            if (item.type === 'message' && Array.isArray(item.content)) {
                const content: RecordValue[] = [];
                for (const part of item.content) {
                    if (object(part) && part.type === 'output_text' && typeof part.text === 'string') {
                        content.push({ type: 'output_text', text: part.text });
                    }
                }
                if (content.length) output.push({ type: 'message', content });
            } else if (item.type === 'reasoning' && Array.isArray(item.summary)) {
                const summary: RecordValue[] = [];
                for (const part of item.summary) {
                    if (object(part) && typeof part.text === 'string' && part.text.length > 0) {
                        summary.push({ text: part.text });
                    }
                }
                if (summary.length) output.push({ type: 'reasoning', summary });
            } else if (item.type === 'function_call') {
                output.push({
                    type: 'function_call',
                    ...(item.call_id !== undefined ? { call_id: item.call_id } : {}),
                    ...(item.name !== undefined ? { name: item.name } : {}),
                    ...(item.arguments !== undefined ? { arguments: item.arguments } : {})
                });
            }
        }
        if (output.length) compact.output = output;
    }
    return compact;
}

/** Sample journal binds attempt identity and stops admission synchronously on write failure. */
export class SampleJournal {
    observation: RecordValue | null = null;
    constructor(
        readonly journal: SessionJournal,
        readonly identity: Record<string, string>,
        readonly onFailure: () => void
    ) {}
    write(record: RecordValue): void {
        try {
            if (record.type === 'stream_chunk') return;
            let value: RecordValue;
            if (record.type === 'call') {
                // Request history is never persisted into session_events; skip cloning and redacting it.
                const { request: _omittedRequest, raw_response, ...rest } = record;
                value = {
                    ...rest,
                    ...(raw_response !== undefined ? { raw_response: compactCallRawResponse(raw_response) } : {}),
                    ...this.identity,
                    call_id: this.identity.attempt_id + ':' + String(record.turn) + ':' + String(record.api_attempt ?? 1)
                };
                value = this.journal.redactor.redactRecord(value, false);
            } else if (record.type === 'observation') {
                value = {
                    ...clone(record),
                    ...this.identity,
                    calls: (record.calls as string[]).map(id => this.identity.attempt_id + ':' + id.split(':').slice(1).join(':'))
                };
                value = this.journal.redactor.redactRecord(value, false);
                this.observation = value;
            } else {
                value = { ...record, ...this.identity };
                value = this.journal.redactor.redactRecord(value, false);
            }
            this.journal.write(value, true);
        } catch (error) {
            // Stop every admission synchronously, before another sample resumes a tool continuation.
            this.onFailure();
            throw error;
        }
    }
}
