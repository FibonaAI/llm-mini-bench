import { closeSync, createReadStream, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { createGunzip, gunzipSync } from 'node:zlib';
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

/** Plain journals are written by the service; terminal runs may later be gzip-archived losslessly. */
export const JOURNAL_FILE = 'journal.jsonl';
export const COMPRESSED_JOURNAL_FILE = 'journal.jsonl.gz';

/** The journal of one run directory or retry generation, plain or archived; null if neither exists. */
export function run_journal_path(directory: string): string | null {
    for (const name of [JOURNAL_FILE, COMPRESSED_JOURNAL_FILE]) if (existsSync(join(directory, name))) return join(directory, name);
    return null;
}

/** Split byte chunks into lines and hand call lines to the visitor; memory stays bounded by the longest line. */
function callLineSplitter(visit: (record: RecordValue) => void, parse: (text: string) => unknown) {
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
    return {
        push(chunk: Buffer) {
            let start = 0;
            for (let index = chunk.indexOf(10, start); index >= 0; index = chunk.indexOf(10, start)) {
                const part = chunk.subarray(start, index);
                flush(pending.length ? Buffer.concat([...pending, part]) : part);
                pending = [];
                start = index + 1;
            }
            if (start < chunk.length) pending.push(Buffer.from(chunk.subarray(start)));
        },
        end() {
            if (pending.length) flush(Buffer.concat(pending));
            pending = [];
        }
    };
}

/**
 * Synchronously scan one journal's call lines. Plain files stream in 1 MiB chunks; an archived
 * journal is inflated in memory, so prefer the async scan except on rare synchronous paths.
 */
export function scan_journal_call_records(
    path: string,
    visit: (record: RecordValue) => void,
    parse: (text: string) => unknown = JSON.parse
): void {
    const splitter = callLineSplitter(visit, parse);
    if (path.endsWith('.gz')) {
        splitter.push(Buffer.from(gunzipSync(readFileSync(path))));
        splitter.end();
        return;
    }
    const fd = openSync(path, 'r');
    try {
        const buffer = Buffer.allocUnsafe(CHUNK);
        for (;;) {
            const read = readSync(fd, buffer, 0, CHUNK, null);
            if (read <= 0) break;
            splitter.push(buffer.subarray(0, read));
        }
        splitter.end();
    } finally {
        closeSync(fd);
    }
}

/** Stream one plain or gzip-archived journal's call lines without inflating it in memory. */
export async function scan_journal_call_records_async(
    path: string,
    visit: (record: RecordValue) => void,
    parse: (text: string) => unknown = JSON.parse
): Promise<void> {
    const splitter = callLineSplitter(visit, parse);
    const source = createReadStream(path, { highWaterMark: CHUNK });
    const stream: AsyncIterable<Buffer> = path.endsWith('.gz') ? source.pipe(createGunzip()) : source;
    try {
        for await (const chunk of stream) splitter.push(chunk);
    } finally {
        source.destroy();
    }
    splitter.end();
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
    async read(run_id: string): Promise<RunCallSummary[] | null> {
        if (!/^[0-9a-f]{32}$/.test(run_id)) return null;
        const directory = join(this.root, run_id);
        if (!existsSync(directory)) return null;
        const journals = [
            directory,
            ...readdirSync(directory)
                .filter(name => /^retry-[0-9a-f]{32}$/.test(name))
                .sort()
                .map(name => join(directory, name))
        ]
            .map(run_journal_path)
            .filter((path): path is string => path !== null);
        const signature = journals
            .map(path => {
                const stat = statSync(path);
                return `${path}:${stat.size}:${stat.mtimeMs}`;
            })
            .join('|');
        const cached = this.cache.get(run_id);
        if (cached?.signature === signature) return cached.calls;
        const calls: RunCallSummary[] = [];
        for (const path of journals) await scan_journal_call_records_async(path, record => calls.push(summarize_call_record(record)));
        this.cache.set(run_id, { signature, calls });
        return calls;
    }
}
