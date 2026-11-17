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
import { canonicalAssessmentJson } from './assessment_json.ts';

type RecordValue = Record<string, unknown>;
const uuid = () => randomUUID().replaceAll('-', '');
const clone = <T>(value: T): T => structuredClone(value);
const object = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);

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
        writeFileSync(fd, canonicalAssessmentJson(value));
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
    fd: number;
    secrets: string[];
    constructor(path: string, secrets: string[]) {
        this.secrets = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
        this.fd = openSync(path, 'wx', 0o600);
    }
    redact(value: unknown): unknown {
        if (typeof value === 'string') {
            let text = value;
            for (const secret of this.secrets) text = text.split(secret).join('[REDACTED]');
            return text;
        }
        if (Array.isArray(value)) return value.map(item => this.redact(item));
        if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.redact(key), this.redact(item)]));
        return value;
    }
    redact_record(record: RecordValue): RecordValue {
        const result = clone(record);
        for (const key of ['raw_response', 'text', 'tool_trace', 'runner_error', 'result', 'arguments', 'request'])
            if (key in result) result[key] = this.redact(result[key]);
        for (const field of ['raw_response_text', 'raw_stream_text'])
            if (typeof result[field] === 'string') {
                // Complete SSE frames keep secrets intact across network chunks for redaction.
                // Keep numeric lexemes intact while redacting escaped JSON string tokens.
                const text = this.redact(result[field]) as string;
                result[field] = text.replace(/"(?:\\[\s\S]|[^"\\])*"/g, token => {
                    try {
                        const decoded: unknown = JSON.parse(token);
                        const redacted = this.redact(decoded);
                        return redacted === decoded ? token : JSON.stringify(redacted);
                    } catch {
                        return token;
                    }
                });
            }
        if (record.type === 'tool_result') {
            // Wire tool identifiers and function names are provider-controlled, unlike sample IDs.
            for (const key of ['name', 'call_id']) if (key in result) result[key] = this.redact(result[key]);
        }
        if (JSON.stringify(result) !== JSON.stringify(record)) result.redaction_applied = true;
        return result;
    }
    write(record: RecordValue): void {
        const bytes = Buffer.from(canonicalAssessmentJson(this.redact_record(record)) + '\n');
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset);
        fsyncSync(this.fd);
    }
    close(): void {
        closeSync(this.fd);
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
            let value = { ...clone(record), ...this.identity };
            if (value.type === 'call' || value.type === 'stream_chunk')
                value.call_id = this.identity.attempt_id + ':' + String(value.turn) + ':' + String(value.api_attempt ?? 1);
            // Stream chunks are the bulk of a journal: keep only their identity, never repeated run metadata.
            if (value.type === 'stream_chunk')
                value = {
                    type: 'stream_chunk',
                    call_id: value.call_id,
                    sample_id: value.sample_id,
                    attempt_id: this.identity.attempt_id,
                    chunk_index: value.chunk_index,
                    elapsed_seconds: value.elapsed_seconds,
                    raw_stream_text: value.raw_stream_text
                };
            else if (value.type === 'observation')
                value.calls = (value.calls as string[]).map(id => this.identity.attempt_id + ':' + id.split(':').slice(1).join(':'));
            value = this.journal.redact_record(value);
            if (value.type === 'observation') this.observation = value;
            this.journal.write(value);
        } catch (error) {
            // Stop every admission synchronously, before another sample resumes a tool continuation.
            this.onFailure();
            throw error;
        }
    }
}
