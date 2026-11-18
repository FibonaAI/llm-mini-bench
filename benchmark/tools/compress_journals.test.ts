import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compress_journal, decompress_journal, main, JOURNAL_ARCHIVE_MANIFEST } from './compress_journals.ts';
import {
    RunCallSummaryReader,
    scan_journal_call_records,
    scan_journal_call_records_async,
    run_journal_path
} from '../src/bench_call_summaries.ts';

const id = (c: string) => c.repeat(32);
const journal = (calls: string[]) =>
    calls
        .map(
            call =>
                JSON.stringify({ type: 'stream_chunk', raw_stream_text: 'x'.repeat(5000) }) +
                '\n' +
                JSON.stringify({ type: 'call', call_id: call, sample_id: 's', http_status: 200, raw_response: { status: 'completed' } }) +
                '\n'
        )
        .join('');
function workspace() {
    const data = mkdtempSync(join(tmpdir(), 'journal-archive-'));
    const root = join(data, 'assessment');
    const run = (name: string, status: string, calls: string[], retry?: string[]) => {
        const directory = join(root, name);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'run.json'), JSON.stringify({ id: name, status }));
        writeFileSync(join(directory, 'journal.jsonl'), journal(calls));
        if (retry) {
            mkdirSync(join(directory, 'retry-' + id('e')), { recursive: true });
            writeFileSync(join(directory, 'retry-' + id('e'), 'journal.jsonl'), journal(retry));
        }
        return directory;
    };
    return { data, root, run };
}

test('terminal journals are archived losslessly, active runs are skipped, and restore is exact', async () => {
    const { data, root, run } = workspace();
    const done = run(id('a'), 'completed', ['a:1', 'a:2'], ['r:1']);
    const active = run(id('b'), 'running', ['b:1']);
    const original = readFileSync(join(done, 'journal.jsonl'));
    expect(await main(['--data-dir', data])).toBe(0);
    expect(existsSync(join(done, 'journal.jsonl'))).toBe(false);
    expect(statSync(join(done, 'journal.jsonl.gz')).size).toBeLessThan(original.length / 10);
    expect(existsSync(join(done, 'retry-' + id('e'), 'journal.jsonl.gz'))).toBe(true);
    expect(JSON.parse(readFileSync(join(done, JOURNAL_ARCHIVE_MANIFEST), 'utf8'))).toMatchObject({
        method: 'gzip',
        original_bytes: original.length
    });
    expect(existsSync(join(active, 'journal.jsonl'))).toBe(true);
    // Readers see the same call records from the archive, synchronously and streamed.
    const sync: unknown[] = [],
        streamed: unknown[] = [];
    scan_journal_call_records(run_journal_path(done)!, call => sync.push(call.call_id));
    await scan_journal_call_records_async(run_journal_path(done)!, call => streamed.push(call.call_id));
    expect(sync).toEqual(['a:1', 'a:2']);
    expect(streamed).toEqual(['a:1', 'a:2']);
    expect((await new RunCallSummaryReader(root).read(id('a')))!.map(call => call.call_id)).toEqual(['a:1', 'a:2', 'r:1']);
    // Running again is a no-op; restore gives back the exact bytes.
    expect(await main(['--data-dir', data])).toBe(0);
    expect(await main(['--data-dir', data, '--decompress'])).toBe(0);
    expect(readFileSync(join(done, 'journal.jsonl')).equals(original)).toBe(true);
    expect(existsSync(join(done, JOURNAL_ARCHIVE_MANIFEST))).toBe(false);
    expect(statSync(join(done, 'journal.jsonl')).mode & 0o777).toBe(0o600);
});

test('an interrupted archive resumes, and a mismatching archive never removes the original', async () => {
    const { run } = workspace();
    const directory = run(id('c'), 'failed', ['c:1']);
    expect(await compress_journal(directory)).toBe('compressed');
    expect(await decompress_journal(directory)).toBe('restored');
    // Simulate a crash after the archive was published but before the plain file was removed.
    expect(await compress_journal(directory)).toBe('compressed');
    writeFileSync(join(directory, 'journal.jsonl'), journal(['c:1']));
    expect(await compress_journal(directory)).toBe('compressed');
    expect(existsSync(join(directory, 'journal.jsonl'))).toBe(false);
    // A plain file that differs from the recorded original is kept and reported.
    writeFileSync(join(directory, 'journal.jsonl'), journal(['different']));
    await expect(compress_journal(directory)).rejects.toThrow('does not match original');
    expect(existsSync(join(directory, 'journal.jsonl'))).toBe(true);
});
