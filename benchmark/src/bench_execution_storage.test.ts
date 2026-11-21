import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalAssessmentJson } from './assessment_json.ts';
import { canonicalStorageJson, RunJournal, SampleJournal } from './bench_execution_storage.ts';

describe('bench execution storage optimizations', () => {
    test('canonicalStorageJson matches canonicalAssessmentJson byte-for-byte including Unicode code-point order and errors', () => {
        const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, { z: 1, a: 2 });
        const samples: unknown[] = [
            null,
            true,
            false,
            0,
            -0,
            42.5,
            'hello "world"\n\\u0000',
            [],
            {},
            [1, 'two', { b: 2, a: 1 }, null],
            // Astral code point U+10000 must sort AFTER BMP U+E000 (code-point order, not UTF-16 code-unit order).
            { '\u{10000}': 'astral', '\uE000': 'bmp', z: 1, a: 2, aa: 3 },
            { nested: nullProto, emptyObj: {}, emptyArr: [], unicode: { 中文: 1, English: 2, '🚀': 3 } }
        ];
        for (const value of samples) {
            expect(canonicalStorageJson(value)).toBe(canonicalAssessmentJson(value));
        }

        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(() => canonicalStorageJson(cyclic)).toThrow('cyclic');
        expect(() => canonicalStorageJson(Number.NaN)).toThrow('nonfinite');
        expect(() => canonicalStorageJson(Number.POSITIVE_INFINITY)).toThrow('nonfinite');
        expect(() => canonicalStorageJson(new Date())).toThrow('plain record');
        expect(() => canonicalStorageJson(undefined)).toThrow('unsupported');

        let deep: unknown = 1;
        for (let i = 0; i <= 101; i++) deep = [deep];
        expect(() => canonicalStorageJson(deep)).toThrow('nesting limit');
    });

    test('RunJournal buffers stream_chunk writes, preserves canonical order, flushes before call/close, and redacts secrets', () => {
        const dir = mkdtempSync(join(tmpdir(), 'mini-bench-storage-'));
        const path = join(dir, 'journal.jsonl');
        try {
            const journal = new RunJournal(path, ['sk-live-secret', 'https://secret.example']);
            const sample = new SampleJournal(
                journal,
                {
                    run_id: 'r'.repeat(32),
                    sample_id: 's'.repeat(32),
                    attempt_id: 'a'.repeat(32),
                    target_id: 'target-1',
                    route_id: 'route-1',
                    account_ref: 'acct-1',
                    account_evidence: 'configured_binding'
                },
                () => {
                    throw new Error('unexpected failure');
                }
            );

            // Standard unredacted chunk, raw secret chunk, escaped secret chunk, and large chunk burst (> 64 KiB).
            sample.write({
                type: 'stream_chunk',
                turn: 1,
                api_attempt: 1,
                chunk_index: 0,
                elapsed_seconds: 0.05,
                raw_stream_text: 'event: delta\ndata: {"delta":"plain"}\n\n'
            });
            sample.write({
                type: 'stream_chunk',
                turn: 1,
                api_attempt: 1,
                chunk_index: 1,
                elapsed_seconds: 0.1,
                raw_stream_text: 'data: {"leak":"sk-live-secret","url":"https://secret.example"}\n\n'
            });
            sample.write({
                type: 'stream_chunk',
                turn: 1,
                api_attempt: 1,
                chunk_index: 2,
                elapsed_seconds: 0.15,
                raw_stream_text: 'data: {"escaped":"\\u0073k-live-secret","n":10.0}\n\n'
            });
            for (let i = 3; i < 40; i++) {
                sample.write({
                    type: 'stream_chunk',
                    turn: 1,
                    api_attempt: 1,
                    chunk_index: i,
                    elapsed_seconds: 0.2 + i * 0.001,
                    raw_stream_text: 'data: ' + 'x'.repeat(2048) + '\n\n'
                });
            }
            // Extra-key stream_chunk falls back to canonicalStorageJson cleanly.
            journal.write({
                type: 'stream_chunk',
                attempt_id: 'a'.repeat(32),
                call_id: 'a'.repeat(32) + ':1:1',
                sample_id: 's'.repeat(32),
                chunk_index: 40,
                elapsed_seconds: 0.5,
                raw_stream_text: 'extra',
                custom_note: 'kept'
            });
            // Writing a non-stream record flushes any buffered stream_chunks strictly before it.
            sample.write({
                type: 'call',
                turn: 1,
                api_attempt: 1,
                http_status: 200,
                raw_response: { id: 'resp-1', note: 'clean' }
            });
            // Trailing stream_chunk is flushed on close().
            sample.write({
                type: 'stream_chunk',
                turn: 2,
                api_attempt: 1,
                chunk_index: 0,
                elapsed_seconds: 0.6,
                raw_stream_text: 'trailing'
            });
            journal.close();

            const rawLines = readFileSync(path, 'utf8').trim().split('\n');
            expect(rawLines).toHaveLength(43);
            for (const line of rawLines) {
                expect(line).toBe(canonicalAssessmentJson(JSON.parse(line)));
            }
            const parsed = rawLines.map(line => JSON.parse(line) as Record<string, unknown>);
            expect(parsed[0]!.redaction_applied).toBeUndefined();
            expect(parsed[1]!.redaction_applied).toBe(true);
            expect(String(parsed[1]!.raw_stream_text)).not.toContain('sk-live-secret');
            expect(String(parsed[1]!.raw_stream_text)).not.toContain('https://secret.example');
            expect(parsed[2]!.redaction_applied).toBe(true);
            expect(String(parsed[2]!.raw_stream_text)).toContain('"n":10.0');
            expect(String(parsed[2]!.raw_stream_text)).toContain('[REDACTED]');
            expect(parsed[40]!.custom_note).toBe('kept');
            expect(parsed[41]!.type).toBe('call');
            expect(parsed[41]!.redaction_applied).toBeUndefined();
            expect(parsed[42]!.raw_stream_text).toBe('trailing');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
