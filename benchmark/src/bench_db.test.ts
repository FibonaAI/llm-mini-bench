import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BENCH_DB_FILENAME, BenchDatabase } from './bench_db.ts';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'bench-db-test-'));
    dirs.push(dir);
    return dir;
}

function sampleRun(id: string, overrides: Record<string, unknown> = {}): Record<string, any> {
    return {
        id,
        status: 'completed',
        created_at: '2026-11-22T00:00:00.000Z',
        updated_at: '2026-11-22T00:01:00.000Z',
        stop_reason: null,
        plan: {
            bank_version: '1.0',
            bank_scope: 'whole',
            bank_snapshot: { version: '1.0', task_ids: ['T1'] },
            targets: [
                {
                    id: 'target-1',
                    route_id: 'route-1',
                    model: 'gpt-test',
                    provider_id: 'openai',
                    account_ref: 'acct-1',
                    thinking: 'high',
                    pricing: { prompt: 0.000001, completion: 0.000002 }
                }
            ],
            task_ids: ['T1'],
            task_snapshots: [{ id: 'T1', prompt: 'Solve T1' }],
            rounds: 1,
            concurrency: 6,
            limits: { timeout: 600, max_api_retries: 3 },
            source_sha256: { 'src/bench_execution.ts': 'a'.repeat(64) },
            sample_count: 1
        },
        samples: [
            {
                sample_id: 'shared-sample-id',
                attempt_id: id + '-att-1',
                run_id: id,
                target_id: 'target-1',
                route_id: 'route-1',
                account_ref: 'acct-1',
                account_evidence: 'gateway_binding',
                task: 'T1',
                model: 'gpt-test',
                thinking: 'high',
                round: 1,
                status: 'completed',
                ok: true,
                grade: { content_score: 1, instruction_checks: { ok: true }, outcome: 'correct' },
                usage: { input_tokens: 100, output_tokens: 50 },
                estimated_uncached_cost_usd: 0.0002,
                elapsed_seconds: 1.5,
                calls: [id + '-att-1:1:1']
            }
        ],
        budget: { requests: 1, known_cost_lower_bound_usd: 0.0002, missing_cost_calls: 0 },
        ...overrides
    };
}

describe('BenchDatabase single-file SQLite storage', () => {
    test('deduplicates bank/task/source snapshots across runs and preserves composite sample identity', () => {
        const dir = tempDir();
        const dbPath = join(dir, BENCH_DB_FILENAME);
        const db = new BenchDatabase(dbPath);
        try {
            expect(existsSync(dbPath)).toBe(true);
            expect(statSync(dbPath).mode & 0o777).toBe(0o600);

            const runA = sampleRun('a'.repeat(32));
            const runB = sampleRun('b'.repeat(32));
            db.save_run(runA);
            db.save_run(runB);

            const snapshotCount = (db.db.query('SELECT COUNT(*) AS n FROM snapshots').get() as { n: number }).n;
            // Only 3 snapshots (bank, tasks, sources) shared across both runs.
            expect(snapshotCount).toBe(3);

            // Both runs share the same sample_id (like calibration imports) without colliding.
            expect(db.load_run('a'.repeat(32))).toEqual(runA);
            expect(db.load_run('b'.repeat(32))).toEqual(runB);
        } finally {
            db.close();
        }
    });

    test('retains immutable prior attempts across retries and serves indexed call summaries', () => {
        const dir = tempDir();
        const db = new BenchDatabase(join(dir, BENCH_DB_FILENAME));
        try {
            const runId = 'c'.repeat(32);
            const run = sampleRun(runId, {
                status: 'failed',
                samples: [
                    {
                        sample_id: 's1',
                        attempt_id: 'att-1',
                        run_id: runId,
                        target_id: 'target-1',
                        route_id: 'route-1',
                        account_ref: 'acct-1',
                        account_evidence: 'gateway_binding',
                        task: 'T1',
                        model: 'gpt-test',
                        thinking: 'high',
                        round: 1,
                        status: 'api_failure',
                        ok: false,
                        grade: null,
                        runner_error: 'HTTP 503',
                        calls: ['att-1:1:1']
                    }
                ]
            });
            db.save_run(run);
            db.insert_session_event({
                run_id: runId,
                sample_id: 's1',
                attempt_id: 'att-1',
                seq: 1,
                kind: 'llm_turn',
                call_id: 'att-1:1:1',
                turn: 1,
                api_attempt: 1,
                http_status: 503,
                elapsed_seconds: 0.4,
                usage_known: false,
                error_code: 'server_error',
                error_message: 'temporary overload',
                payload: { raw_error_excerpt: '{"error":"temporary overload"}' }
            });

            // Simulate retry with attempt 2 while attempt 1 moves to sample.attempts.
            const prev = structuredClone(run.samples[0]);
            run.status = 'completed';
            run.retry_batches = [
                {
                    request_id: '1'.repeat(32),
                    sample_ids: ['s1'],
                    source_sha256: { 'src/bench_execution.ts': 'a'.repeat(64) },
                    limits: { timeout: 600 },
                    created_at: '2026-11-22T00:02:00.000Z'
                }
            ];
            run.samples[0] = {
                ...prev,
                attempt_id: 'att-2',
                status: 'completed',
                ok: true,
                runner_error: null,
                grade: { content_score: 1, instruction_checks: { ok: true }, outcome: 'correct' },
                usage: { input_tokens: 10, output_tokens: 5 },
                estimated_uncached_cost_usd: 0.00002,
                calls: ['att-2:1:1'],
                retry_source_sha256: { 'src/bench_execution.ts': 'a'.repeat(64) },
                attempts: [prev]
            } as any;
            db.save_run(run);
            db.insert_session_event({
                run_id: runId,
                sample_id: 's1',
                attempt_id: 'att-2',
                seq: 1,
                kind: 'llm_turn',
                call_id: 'att-2:1:1',
                turn: 1,
                api_attempt: 1,
                http_status: 200,
                elapsed_seconds: 0.8,
                usage_known: true,
                input_tokens: 10,
                output_tokens: 5,
                estimated_cost_usd: 0.00002,
                response_status: 'completed',
                terminal_event: 'response.completed',
                termination: 'terminal',
                payload: { assistant_text: 'done' }
            });

            const attemptRows = db.db.query('SELECT id, seq, status FROM attempts WHERE run_id = ? ORDER BY seq ASC').all(runId);
            expect(attemptRows).toEqual([
                { id: 'att-1', seq: 1, status: 'api_failure' },
                { id: 'att-2', seq: 2, status: 'completed' }
            ]);

            const hydrated = db.load_run(runId) as any;
            expect(hydrated.samples[0].attempt_id).toBe('att-2');
            expect(hydrated.samples[0].attempts).toHaveLength(1);
            expect(hydrated.samples[0].attempts[0].attempt_id).toBe('att-1');
            expect(hydrated.samples[0].retry_source_sha256).toEqual({ 'src/bench_execution.ts': 'a'.repeat(64) });
            expect(hydrated.retry_batches[0].source_sha256).toEqual({ 'src/bench_execution.ts': 'a'.repeat(64) });

            const summaries = db.read_run_call_summaries(runId);
            expect(summaries).toHaveLength(2);
            expect(summaries[0]).toMatchObject({ call_id: 'att-1:1:1', http_status: 503, error_code: 'server_error', usage_known: false });
            expect(summaries[1]).toMatchObject({
                call_id: 'att-2:1:1',
                http_status: 200,
                usage_known: true,
                terminal_event: 'response.completed'
            });
        } finally {
            db.close();
        }
    });
});
