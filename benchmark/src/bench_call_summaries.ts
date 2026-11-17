import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, limit = 300): string | null => (typeof value === 'string' && value.length ? value.slice(0, limit) : null);
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Read-only per-call diagnosis; raw request/response bodies and stream text are never returned. */
export interface RunCallSummary {
    call_id: string;
    sample_id: string;
    attempt_id: string | null;
    turn: number | null;
    api_attempt: number | null;
    http_status: number | null;
    elapsed_seconds: number | null;
    usage_known: boolean;
    estimated_cost_usd: number | null;
    response_status: string | null;
    error_code: string | null;
    error_message: string | null;
    local_exception: string | null;
    terminal_event: string | null;
    termination: string | null;
    first_output_seconds: number | null;
    last_progress_seconds: number | null;
}

const CALL_MARKER = Buffer.from('"type":"call"');
const CHUNK = 1 << 20;

/** Stream one JSONL file and parse only lines that can be call records; memory stays bounded by the longest line. */
export function scan_journal_call_records(
    path: string,
    visit: (record: RecordValue) => void,
    parse: (text: string) => unknown = JSON.parse
): void {
    const fd = openSync(path, 'r');
    try {
        const buffer = Buffer.allocUnsafe(CHUNK);
        let pending: Buffer[] = [];
        const flush = (line: Buffer) => {
            if (line.indexOf(CALL_MARKER) < 0) return;
            let value: unknown;
            try {
                value = parse(line.toString('utf8'));
            } catch {
                return; /* A torn final line is not evidence. */
            }
            // Visitor errors are real failures and must propagate.
            if (object(value) && value.type === 'call') visit(value);
        };
        for (;;) {
            const read = readSync(fd, buffer, 0, CHUNK, null);
            if (read <= 0) break;
            let start = 0;
            for (let index = buffer.indexOf(10, start); index >= 0 && index < read; index = buffer.indexOf(10, start)) {
                const part = buffer.subarray(start, index);
                flush(pending.length ? Buffer.concat([...pending, part]) : part);
                pending = [];
                start = index + 1;
            }
            if (start < read) pending.push(Buffer.from(buffer.subarray(start, read)));
        }
        if (pending.length) flush(Buffer.concat(pending));
    } finally {
        closeSync(fd);
    }
}

export function summarize_call_record(record: RecordValue): RunCallSummary {
    const raw = object(record.raw_response) ? record.raw_response : {};
    const stream = object(record.stream) ? record.stream : {};
    const error = raw.error;
    const usage = object(raw.usage) && finite(raw.usage.input_tokens) !== null && finite(raw.usage.output_tokens) !== null;
    return {
        call_id: String(record.call_id ?? ''),
        sample_id: String(record.sample_id ?? ''),
        attempt_id: text(record.attempt_id, 64),
        turn: finite(record.turn),
        api_attempt: finite(record.api_attempt),
        http_status: finite(record.http_status),
        elapsed_seconds: finite(record.elapsed_seconds),
        usage_known: usage,
        estimated_cost_usd: finite(record.estimated_uncached_cost_usd),
        response_status: text(raw.status, 40),
        error_code: object(error) ? (text(error.code, 80) ?? text(error.type, 80)) : typeof error === 'string' ? text(error, 80) : null,
        error_message: object(error) ? text(error.message) : null,
        local_exception: text(raw.exception, 80),
        terminal_event: text(stream.terminal_event, 80),
        termination: text(stream.termination, 40),
        first_output_seconds: finite(stream.first_output_seconds),
        last_progress_seconds: finite(stream.last_progress_seconds)
    };
}

/** Collect call summaries from a run directory and its retry generations, cached by file size and mtime. */
export class RunCallSummaryReader {
    private cache = new Map<string, { signature: string; calls: RunCallSummary[] }>();
    constructor(private readonly root: string) {}
    read(run_id: string): RunCallSummary[] | null {
        if (!/^[0-9a-f]{32}$/.test(run_id)) return null;
        const directory = join(this.root, run_id);
        if (!existsSync(directory)) return null;
        const journals = [
            join(directory, 'journal.jsonl'),
            ...readdirSync(directory)
                .filter(name => /^retry-[0-9a-f]{32}$/.test(name))
                .sort()
                .map(name => join(directory, name, 'journal.jsonl'))
        ].filter(path => existsSync(path));
        const signature = journals
            .map(path => {
                const stat = statSync(path);
                return `${path}:${stat.size}:${stat.mtimeMs}`;
            })
            .join('|');
        const cached = this.cache.get(run_id);
        if (cached?.signature === signature) return cached.calls;
        const calls: RunCallSummary[] = [];
        for (const path of journals) scan_journal_call_records(path, record => calls.push(summarize_call_record(record)));
        this.cache.set(run_id, { signature, calls });
        return calls;
    }
}
