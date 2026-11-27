import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalAssessmentJson, parseAssessmentJson, assessmentJsonNumberToken } from './assessment_json.ts';
import { BenchDatabase } from './bench_db.ts';
import {
    canonicalStorageJson,
    parseStrictJson,
    parseStrictJsonWithResponseUsage,
    SessionJournal,
    SampleJournal
} from './bench_execution_storage.ts';
import { ResponsesStreamDecoder, responses_stream_telemetry } from './responses_stream.ts';

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

    test('SessionJournal persists compact Pi Session events into SQLite, ignores stream_chunk, and redacts secrets', () => {
        const dir = mkdtempSync(join(tmpdir(), 'mini-bench-storage-'));
        const db = new BenchDatabase(join(dir, 'mini-bench.sqlite'));
        const runId = 'r'.repeat(32);
        const sampleId = 's'.repeat(32);
        const attemptId = 'a'.repeat(32);
        try {
            db.save_run({
                id: runId,
                status: 'running',
                created_at: '2026-11-22T00:00:00.000Z',
                updated_at: '2026-11-22T00:00:00.000Z',
                stop_reason: null,
                plan: {
                    bank_version: '1.0',
                    bank_scope: 'subset',
                    bank_snapshot: {},
                    targets: [],
                    task_ids: ['K04'],
                    task_snapshots: [],
                    rounds: 1,
                    concurrency: 1,
                    limits: { timeout: 60 },
                    source_sha256: {},
                    sample_count: 1
                },
                samples: [
                    {
                        sample_id: sampleId,
                        attempt_id: attemptId,
                        run_id: runId,
                        target_id: 'target-1',
                        route_id: 'route-1',
                        account_ref: 'acct-1',
                        account_evidence: 'configured_binding',
                        task: 'K04',
                        model: 'm',
                        thinking: 'high',
                        round: 1,
                        status: 'running',
                        grade: null
                    }
                ],
                budget: {}
            });

            const journal = new SessionJournal(db, runId, ['sk-live-secret', 'https://secret.example']);
            const sample = new SampleJournal(
                journal,
                {
                    run_id: runId,
                    sample_id: sampleId,
                    attempt_id: attemptId,
                    target_id: 'target-1',
                    route_id: 'route-1',
                    account_ref: 'acct-1',
                    account_evidence: 'configured_binding'
                },
                () => {
                    throw new Error('unexpected failure');
                }
            );

            // Raw stream_chunk records are ignored and never persisted.
            sample.write({
                type: 'stream_chunk',
                turn: 1,
                api_attempt: 1,
                chunk_index: 0,
                elapsed_seconds: 0.05,
                raw_stream_text: 'event: delta\ndata: {"delta":"plain"}\n\n'
            });
            // Failed turn retains a redacted error excerpt without storing request history.
            sample.write({
                type: 'call',
                turn: 1,
                api_attempt: 1,
                http_status: 500,
                elapsed_seconds: 0.5,
                request: { input: [{ role: 'user', content: 'huge repeated prompt' }] },
                raw_response: { error: { code: 'upstream', message: 'bad sk-live-secret at https://secret.example' } },
                raw_response_text: '{"escaped":"\\u0073k-live-secret","n":10.0}'
            });
            // Tool result redacts secrets across wire identifiers, arguments, and result.
            sample.write({
                type: 'tool_result',
                call_id: 'wire-sk-live-secret',
                name: 'tool-sk-live-secret',
                arguments: '{"url":"https://secret.example"}',
                result: { echoed: 'sk-live-secret' }
            });
            // Successful turn stores compact output/tool_calls without raw error excerpt or request payload.
            sample.write({
                type: 'call',
                turn: 2,
                api_attempt: 1,
                http_status: 200,
                elapsed_seconds: 0.25,
                estimated_uncached_cost_usd: 0.001,
                raw_response: {
                    status: 'completed',
                    output_text: 'final answer',
                    usage: { input_tokens: 12, output_tokens: 4 }
                },
                stream: { terminal_event: 'response.completed', termination: 'terminal', first_output_seconds: 0.1 }
            });
            journal.close();

            const events = db.read_run_session_events(runId, attemptId);
            expect(events).toHaveLength(3);
            expect(events.map(e => e.kind)).toEqual(['llm_turn', 'tool_result', 'llm_turn']);
            expect(events.map(e => e.seq)).toEqual([1, 2, 3]);

            const first = events[0]!;
            expect(first.call_id).toBe(attemptId + ':1:1');
            expect(first.error_message).not.toContain('sk-live-secret');
            expect(first.error_message).not.toContain('https://secret.example');
            expect(String(first.payload?.raw_error_excerpt)).toContain('"n":10.0');
            expect(String(first.payload?.raw_error_excerpt)).toContain('[REDACTED]');
            expect(first.payload?.request).toBeUndefined();
            expect(first.payload?.redaction_applied).toBe(true);

            const tool = events[1]!;
            expect(tool.call_id).toBe('wire-[REDACTED]');
            expect(JSON.stringify(tool.payload)).not.toContain('sk-live-secret');
            expect(JSON.stringify(tool.payload)).not.toContain('https://secret.example');

            const second = events[2]!;
            expect(second.usage_known).toBe(true);
            expect(second.input_tokens).toBe(12);
            expect(second.output_tokens).toBe(4);
            expect(second.payload?.assistant_text).toBe('final answer');
            expect(second.payload?.raw_error_excerpt).toBeUndefined();

            const summaries = db.read_run_call_summaries(runId);
            expect(summaries).toHaveLength(2);
            expect(summaries[0]!.http_status).toBe(500);
            expect(summaries[1]!.usage_known).toBe(true);
        } finally {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('parseStrictJson matches parseAssessmentJson validation semantics and extracts response.usage accurately', () => {
        const validCases = [
            'null',
            'true',
            'false',
            '0',
            '-123.45e-6',
            '"hello \\"world\\" \\u4e2d\\u6587"',
            '[]',
            '{}',
            '{"a":1,"b":[true,false,null,{"nested":42}],"__proto__":{"polluted":true}}',
            '[{"x":1},{"x":2}]'
        ];
        for (const text of validCases) {
            expect(parseStrictJson(text)).toEqual(parseAssessmentJson(text));
        }
        const protoParsed = parseStrictJson('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
        expect(Object.hasOwn(protoParsed, '__proto__')).toBe(true);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();

        // Reject duplicate keys (including escaped equivalents), nonfinite numbers, nesting overflow, and bad syntax.
        expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow('duplicate object key');
        expect(() => parseStrictJson('{"a":1,"\\u0061":2}')).toThrow('duplicate object key');
        expect(() => parseStrictJson('{"n":1e309}')).toThrow('nonfinite number');
        expect(() => parseStrictJson('{"n":-1e400}')).toThrow('nonfinite number');
        expect(() => parseStrictJson('{"a":1} trailing')).toThrow('invalid JSON syntax');
        expect(() => parseStrictJson('{"a":"\x01"}')).toThrow('invalid JSON syntax');
        expect(() => parseStrictJson('[1]', 1)).not.toThrow();
        expect(() => parseStrictJson('[[1]]', 1)).toThrow('nesting limit exceeded');
        expect(() => parseStrictJson('[[]]', 1)).not.toThrow();

        // parseStrictJsonWithResponseUsage ignores `"usage"` inside assistant strings and captures the real response.usage slice.
        const sseData = JSON.stringify({
            type: 'response.completed',
            response: {
                status: 'completed',
                output_text: 'literal "usage":{"input_tokens":999}',
                usage: { input_tokens: 10, output_tokens: 5 }
            }
        }).replace('"input_tokens":10', '"input_tokens":10.0');
        const extracted = parseStrictJsonWithResponseUsage(sseData);
        expect(extracted.usageJson).toBe('{"input_tokens":10.0,"output_tokens":5}');

        // Terminal SSE frame keeps exact number-token detection for float usage values.
        const decoder = new ResponsesStreamDecoder(responses_stream_telemetry(), () => 0.1);
        decoder.push(`event: response.completed\ndata: ${sseData}\n\n`);
        expect(decoder.response).not.toBeNull();
        expect(assessmentJsonNumberToken(decoder.response!.usage as object, 'input_tokens')).toBe('10.0');
        expect(assessmentJsonNumberToken(decoder.response!.usage as object, 'output_tokens')).toBe('5');
    });
});
