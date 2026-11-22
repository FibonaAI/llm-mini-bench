import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BENCH_DB_FILENAME, BenchDatabase } from '../src/bench_db.ts';
import { BenchExecutionService } from '../src/bench_execution.ts';
import { migrate_legacy_workspace, main } from './migrate_legacy_storage.ts';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'bench-migrate-test-'));
    dirs.push(dir);
    return dir;
}

describe('legacy workspace migration to SQLite', () => {
    test('migrates runs, tasks, retry journals (plain and gzip), and baselines while leaving legacy files untouched', async () => {
        const root = tempDir();
        const runId = 'a'.repeat(32);
        const taskId = 'b'.repeat(32);
        const retryId = 'c'.repeat(32);
        const runDir = join(root, 'assessment', runId);
        const retryDir = join(runDir, 'retry-' + retryId);
        const taskDir = join(root, 'assessment', 'tasks', taskId);
        const baselinesDir = join(root, 'assessment-baselines');
        mkdirSync(join(runDir, 'source', 'src'), { recursive: true });
        mkdirSync(retryDir, { recursive: true });
        mkdirSync(taskDir, { recursive: true });
        mkdirSync(baselinesDir, { recursive: true });

        // Legacy copied source files and run-before.json must be ignored during migration and preserved untouched on disk.
        writeFileSync(join(runDir, 'source', 'src', 'bench_execution.ts'), '// copied source');
        writeFileSync(join(retryDir, 'run-before.json'), '{"legacy":"backup"}');

        const legacyRun = {
            id: runId,
            task_id: taskId,
            execution_kind: 'task-child-v1',
            status: 'completed',
            created_at: '2026-11-20T00:00:00.000Z',
            updated_at: '2026-11-20T00:05:00.000Z',
            stop_reason: null,
            plan: {
                bank_version: '1.0',
                bank_scope: 'subset',
                bank_snapshot: { version: '1.0', task_ids: ['T1'] },
                targets: [
                    {
                        id: 'target-1',
                        route_id: 'openai::gpt-test',
                        model: 'gpt-test',
                        provider_id: 'openai',
                        account_ref: 'acct-1',
                        thinking: 'high',
                        pricing: { prompt: 0.000001, completion: 0.000002 }
                    }
                ],
                task_ids: ['T1'],
                task_snapshots: [{ id: 'T1', prompt: 'Test prompt' }],
                rounds: 1,
                concurrency: 6,
                limits: { timeout: 600, max_api_retries: 3 },
                source_sha256: { 'src/bench_execution.ts': 'd'.repeat(64) },
                sample_count: 1
            },
            retry_batches: [
                {
                    request_id: retryId,
                    sample_ids: ['s1'],
                    source_sha256: { 'src/bench_execution.ts': 'd'.repeat(64) },
                    limits: { timeout: 600, max_api_retries: 3 },
                    created_at: '2026-11-20T00:03:00.000Z'
                }
            ],
            samples: [
                {
                    sample_id: 's1',
                    attempt_id: 'att-2',
                    run_id: runId,
                    target_id: 'target-1',
                    route_id: 'openai::gpt-test',
                    account_ref: 'acct-1',
                    account_evidence: 'gateway_binding',
                    task: 'T1',
                    model: 'gpt-test',
                    thinking: 'high',
                    round: 1,
                    status: 'completed',
                    ok: true,
                    grade: { content_score: 1, instruction_checks: { format: true }, outcome: 'correct' },
                    calls: ['att-2:1:1'],
                    // Intentionally omit usage & cost on sample to test recovery from gzipped retry journal!
                    usage: null,
                    estimated_uncached_cost_usd: null,
                    attempts: [
                        {
                            sample_id: 's1',
                            attempt_id: 'att-1',
                            run_id: runId,
                            target_id: 'target-1',
                            route_id: 'openai::gpt-test',
                            account_ref: 'acct-1',
                            account_evidence: 'gateway_binding',
                            task: 'T1',
                            model: 'gpt-test',
                            thinking: 'high',
                            round: 1,
                            status: 'api_failure',
                            ok: false,
                            grade: null,
                            calls: ['att-1:1:1']
                        }
                    ]
                }
            ],
            budget: { requests: 2, known_cost_lower_bound_usd: 0, missing_cost_calls: 1, uncertain_cost_reservation_usd: 0.01 }
        };
        const runJsonPath = join(runDir, 'run.json');
        writeFileSync(runJsonPath, JSON.stringify(legacyRun));
        const runJsonBefore = readFileSync(runJsonPath, 'utf8');

        // Plain main journal with stream_chunk noise + 503 call.
        writeFileSync(
            join(runDir, 'journal.jsonl'),
            [
                { type: 'stream_chunk', sample_id: 's1', attempt_id: 'att-1', call_id: 'att-1:1:1', raw_stream_text: 'x'.repeat(10000) },
                {
                    type: 'call',
                    sample_id: 's1',
                    attempt_id: 'att-1',
                    call_id: 'att-1:1:1',
                    turn: 1,
                    api_attempt: 1,
                    http_status: 503,
                    elapsed_seconds: 0.5,
                    estimated_uncached_cost_usd: null,
                    request: { input: [{ role: 'user', content: 'huge duplicated history' }] },
                    raw_response: { error: { code: 'overloaded', message: 'busy' } }
                }
            ]
                .map(row => JSON.stringify(row))
                .join('\n') + '\n'
        );

        // Gzipped retry journal with stream_chunk noise + successful call with usage.
        const retryLines =
            [
                { type: 'stream_chunk', sample_id: 's1', attempt_id: 'att-2', call_id: 'att-2:1:1', raw_stream_text: 'y'.repeat(10000) },
                {
                    type: 'call',
                    sample_id: 's1',
                    attempt_id: 'att-2',
                    call_id: 'att-2:1:1',
                    turn: 1,
                    api_attempt: 1,
                    http_status: 200,
                    elapsed_seconds: 1.2,
                    estimated_uncached_cost_usd: 0.0005,
                    raw_response: {
                        status: 'completed',
                        output_text: '42',
                        usage: { input_tokens: 100, output_tokens: 200 }
                    },
                    stream: { terminal_event: 'response.completed', termination: 'terminal', first_output_seconds: 0.2 }
                },
                {
                    type: 'tool_result',
                    sample_id: 's1',
                    attempt_id: 'att-2',
                    call_id: 'tool-1',
                    name: 'submit_answer',
                    arguments: '{"ans":42}',
                    result: { accepted: true }
                }
            ]
                .map(row => JSON.stringify(row))
                .join('\n') + '\n';
        writeFileSync(join(retryDir, 'journal.jsonl.gz'), gzipSync(Buffer.from(retryLines)));

        const legacyTask = {
            id: taskId,
            status: 'completed',
            created_at: '2026-11-20T00:00:00.000Z',
            updated_at: '2026-11-20T00:05:00.000Z',
            stop_reason: null,
            child_run_ids: [runId],
            plan: {
                ...legacyRun.plan,
                sample_concurrency: 6,
                run_concurrency: 3,
                run_count: 1,
                samples_per_run: 1,
                total_max_cost_usd: null
            }
        };
        writeFileSync(join(taskDir, 'task.json'), JSON.stringify(legacyTask));

        const fakeBaseline = {
            id: 'e'.repeat(64),
            schema: 'assessment-baseline-v1',
            bank_version: '1.0',
            run_id: runId,
            target_id: 'target-1',
            created_at: '2026-11-20T00:00:00.000Z',
            target: legacyRun.plan.targets[0]
        };
        writeFileSync(join(baselinesDir, 'fixture.json'), JSON.stringify(fakeBaseline));

        // 1) Dry run writes nothing.
        const dry = await migrate_legacy_workspace(root, true);
        expect(dry).toMatchObject({ dry_run: true, runs_found: 1, tasks_found: 1, baselines_found: 1 });
        expect(existsSync(join(root, BENCH_DB_FILENAME))).toBe(false);

        // 2) Real migration writes SQLite, discards stream_chunks, recovers usage, leaves legacy files intact.
        const report = await migrate_legacy_workspace(root, false);
        expect(report).toMatchObject({
            runs_found: 1,
            runs_migrated: 1,
            runs_skipped: 0,
            tasks_found: 1,
            tasks_migrated: 1,
            baselines_found: 1,
            baselines_migrated: 1,
            samples_migrated: 1,
            attempts_migrated: 2,
            events_migrated: 3
        });

        // Legacy files were never modified or removed.
        expect(readFileSync(runJsonPath, 'utf8')).toBe(runJsonBefore);
        expect(existsSync(join(runDir, 'source', 'src', 'bench_execution.ts'))).toBe(true);
        expect(existsSync(join(retryDir, 'run-before.json'))).toBe(true);

        // Verify SQLite contents via BenchDatabase and BenchExecutionService.
        const db = new BenchDatabase(join(root, BENCH_DB_FILENAME));
        try {
            expect(db.list_baseline_rows()).toHaveLength(1);
            const calls = db.read_run_call_summaries(runId);
            expect(calls).toHaveLength(2);
            expect(calls[0]).toMatchObject({ call_id: 'att-1:1:1', http_status: 503, error_code: 'overloaded' });
            expect(calls[1]).toMatchObject({ call_id: 'att-2:1:1', http_status: 200, usage_known: true });
            const events = db.read_run_session_events(runId);
            expect(events.map(e => e.kind)).toEqual(['llm_turn', 'llm_turn', 'tool_result']);
            expect(JSON.stringify(events)).not.toContain('huge duplicated history');
        } finally {
            db.close();
        }

        const service = new BenchExecutionService(root, {
            resolve: () => {
                throw new Error('offline');
            },
            public_routes: () => []
        });
        try {
            const run = service.get_run(runId)!;
            expect(run.status).toBe('completed');
            expect(run.samples[0]!.usage).toEqual({ input_tokens: 100, output_tokens: 200 });
            expect(run.samples[0]!.estimated_uncached_cost_usd).toBe(0.0005);
            expect((run.samples[0]!.attempts as unknown[]).length).toBe(1);
            expect(service.get_task(taskId)!.status).toBe('completed');
        } finally {
            await service.close();
        }

        // 3) Re-running CLI is idempotent.
        expect(await main(['--data-dir', root])).toBe(0);
        const rerun = await migrate_legacy_workspace(root, false);
        expect(rerun).toMatchObject({
            runs_migrated: 0,
            runs_skipped: 1,
            tasks_migrated: 0,
            tasks_skipped: 1,
            baselines_migrated: 0,
            baselines_skipped: 1
        });
    });
});
