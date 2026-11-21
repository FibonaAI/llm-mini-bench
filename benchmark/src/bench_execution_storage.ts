import {
    chmodSync,
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    renameSync,
    unlinkSync,
    writeFileSync,
    writeSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

type RecordValue = Record<string, unknown>;
const uuid = () => randomUUID().replaceAll('-', '');
const clone = <T>(value: T): T => structuredClone(value);
const object = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);

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

/** Fast canonical serializer for standard stream_chunk records; falls back if keys or types differ. */
function serializeStreamChunk(record: RecordValue): string | null {
    const hasRedacted = Object.hasOwn(record, 'redaction_applied');
    const expectedKeys = hasRedacted ? 8 : 7;
    if (Object.keys(record).length !== expectedKeys) return null;
    const { attempt_id, call_id, chunk_index, elapsed_seconds, raw_stream_text, redaction_applied, sample_id, type } = record;
    if (
        type !== 'stream_chunk' ||
        typeof attempt_id !== 'string' ||
        typeof call_id !== 'string' ||
        typeof chunk_index !== 'number' ||
        !Number.isFinite(chunk_index) ||
        typeof elapsed_seconds !== 'number' ||
        !Number.isFinite(elapsed_seconds) ||
        typeof raw_stream_text !== 'string' ||
        typeof sample_id !== 'string' ||
        (hasRedacted && typeof redaction_applied !== 'boolean')
    )
        return null;
    return (
        '{"attempt_id":' +
        JSON.stringify(attempt_id) +
        ',"call_id":' +
        JSON.stringify(call_id) +
        ',"chunk_index":' +
        JSON.stringify(chunk_index) +
        ',"elapsed_seconds":' +
        JSON.stringify(elapsed_seconds) +
        ',"raw_stream_text":' +
        JSON.stringify(raw_stream_text) +
        (hasRedacted ? ',"redaction_applied":' + (redaction_applied ? 'true' : 'false') : '') +
        ',"sample_id":' +
        JSON.stringify(sample_id) +
        ',"type":"stream_chunk"}'
    );
}

/** Create private directories without changing permissions of existing ancestors. */
export function private_directory(path: string): void {
    if (!existsSync(dirname(path))) private_directory(dirname(path));
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
}
/** Atomic durable state publication; temporary files and final files stay private. */
export function save_execution_json(path: string, value: unknown): void {
    const temporary = join(dirname(path), '.state-' + uuid());
    let fd: number | undefined;
    try {
        fd = openSync(temporary, 'wx', 0o600);
        writeFileSync(fd, canonicalStorageJson(value));
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temporary, path);
    } finally {
        if (fd !== undefined) closeSync(fd);
        if (existsSync(temporary)) unlinkSync(temporary);
    }
}
/** Durable run journal redacts credentials before synchronous publication. */
export class RunJournal {
    private static readonly STREAM_BUFFER_LIMIT = 65536;
    fd: number;
    secrets: string[];
    private dirty = false;
    private streamBuffer: string[] = [];
    private streamBufferedChars = 0;
    constructor(path: string, secrets: string[]) {
        this.secrets = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
        this.fd = openSync(path, 'wx', 0o600);
    }
    private redactString(value: string): string {
        let text = value;
        for (const secret of this.secrets) if (text.includes(secret)) text = text.replaceAll(secret, '[REDACTED]');
        return text;
    }
    private redactTracked(value: unknown, state: { changed: boolean }): unknown {
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
    private redact_raw_text(raw: string): string {
        // Complete SSE frames keep secrets intact across network chunks for redaction.
        // Keep numeric lexemes intact while redacting escaped JSON string tokens.
        const text = this.redactString(raw);
        if (!text.includes('\\')) return text;
        return text.replace(/"(?:\\[\s\S]|[^"\\])*"/g, token => {
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
    redact_record(record: RecordValue): RecordValue {
        if (record.type === 'stream_chunk') {
            const result = { ...record };
            if (this.secrets.length && typeof result.raw_stream_text === 'string') {
                const raw = result.raw_stream_text;
                const redacted = this.redact_raw_text(raw);
                if (redacted !== raw) {
                    result.raw_stream_text = redacted;
                    result.redaction_applied = true;
                }
            }
            return result;
        }
        if (!this.secrets.length) return clone(record);
        const result = clone(record);
        const state = { changed: false };
        for (const key of ['raw_response', 'text', 'tool_trace', 'runner_error', 'result', 'arguments', 'request'])
            if (key in result) result[key] = this.redactTracked(result[key], state);
        for (const field of ['raw_response_text', 'raw_stream_text'])
            if (typeof result[field] === 'string') {
                const before = result[field];
                const after = this.redact_raw_text(before);
                if (after !== before) {
                    result[field] = after;
                    state.changed = true;
                }
            }
        if (record.type === 'tool_result') {
            // Wire tool identifiers and function names are provider-controlled, unlike sample IDs.
            for (const key of ['name', 'call_id']) if (key in result) result[key] = this.redactTracked(result[key], state);
        }
        if (state.changed) result.redaction_applied = true;
        return result;
    }
    private writeBytes(text: string): void {
        const bytes = Buffer.from(text);
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset);
    }
    private flushStreamBuffer(): void {
        if (!this.streamBufferedChars) return;
        const payload = this.streamBuffer.length === 1 ? this.streamBuffer[0]! : this.streamBuffer.join('');
        this.streamBuffer.length = 0;
        this.streamBufferedChars = 0;
        this.writeBytes(payload);
        this.dirty = true;
    }
    write(record: RecordValue, alreadyRedacted = false): void {
        const prepared = alreadyRedacted ? record : this.redact_record(record);
        const line = ((prepared.type === 'stream_chunk' ? serializeStreamChunk(prepared) : null) ?? canonicalStorageJson(prepared)) + '\n';
        if (prepared.type === 'stream_chunk') {
            this.streamBuffer.push(line);
            this.streamBufferedChars += line.length;
            if (this.streamBufferedChars >= RunJournal.STREAM_BUFFER_LIMIT) this.flushStreamBuffer();
            return;
        }
        if (this.streamBufferedChars > 0) {
            this.streamBuffer.push(line);
            this.streamBufferedChars += line.length;
            this.flushStreamBuffer();
        } else {
            this.writeBytes(line);
        }
        fsyncSync(this.fd);
        this.dirty = false;
    }
    close(): void {
        try {
            this.flushStreamBuffer();
            if (this.dirty) {
                fsyncSync(this.fd);
                this.dirty = false;
            }
        } finally {
            closeSync(this.fd);
        }
    }
}
/** Sample journal binds attempt identity and stops admission synchronously on write failure. */
export class SampleJournal {
    observation: RecordValue | null = null;
    constructor(
        readonly journal: RunJournal,
        readonly identity: Record<string, string>,
        readonly onFailure: () => void
    ) {}
    write(record: RecordValue): void {
        try {
            // Stream chunks are the bulk of a journal: keep only their identity, never repeated run metadata.
            if (record.type === 'stream_chunk') {
                const chunk: RecordValue = {
                    type: 'stream_chunk',
                    call_id: this.identity.attempt_id + ':' + String(record.turn) + ':' + String(record.api_attempt ?? 1),
                    sample_id: this.identity.sample_id ?? record.sample_id,
                    attempt_id: this.identity.attempt_id,
                    chunk_index: record.chunk_index,
                    elapsed_seconds: record.elapsed_seconds,
                    raw_stream_text: record.raw_stream_text
                };
                this.journal.write(chunk);
                return;
            }
            let value = { ...clone(record), ...this.identity };
            if (value.type === 'call')
                value.call_id = this.identity.attempt_id + ':' + String(value.turn) + ':' + String(value.api_attempt ?? 1);
            else if (value.type === 'observation')
                value.calls = (value.calls as string[]).map(id => this.identity.attempt_id + ':' + id.split(':').slice(1).join(':'));
            value = this.journal.redact_record(value);
            if (value.type === 'observation') this.observation = value;
            this.journal.write(value, true);
        } catch (error) {
            // Stop every admission synchronously, before another sample resumes a tool continuation.
            this.onFailure();
            throw error;
        }
    }
}
