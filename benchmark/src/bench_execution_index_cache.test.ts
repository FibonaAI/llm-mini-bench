import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BenchExecutionService, type ExecutionRoutes } from './bench_execution.ts';
import { BenchDatabase } from './bench_db.ts';
import { BenchService, make_handler } from '../backend/mini_bench.ts';
import { load_assessment_bank } from './assessment_bank.ts';

function routes(): ExecutionRoutes {
    const route = {
        id: 'route-a',
        label: 'Route A',
        provider_id: 'openai',
        provider_evidence: 'configured_binding',
        account_ref: 'acct-a',
        account_evidence: 'configured_binding',
        base_url: 'http://127.0.0.1:1/v1',
        model: 'gpt-test',
        api_key: 'sk-test-secret',
        thinking_levels: ['high'],
        account_concurrency: 4,
        pricing: { prompt: 0.000001, completion: 0.000002 }
    };
    return {
        resolve: id => {
            if (id !== route.id) throw new TypeError('unknown route');
            return route;
        },
        public_routes: () => [{ id: route.id, model: route.model, thinking_levels: route.thinking_levels }]
    };
}

function completedResponse() {
    return {
        id: 'resp-1',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"answer":1}' }] }],
        usage: { input_tokens: 10, output_tokens: 5 }
    };
}

describe('terminal run eviction and persistent index cache', () => {
    test('evicts terminal runs from memory, caches index privately, and recovers from cache corruption or run changes', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mini-bench-index-cache-'));
        const taskId = load_assessment_bank().task_ids[0]!;
        try {
            const clientFactory = () => ({
                post_responses_stream: () => [200, 0.01, {}, completedResponse()] as const
            });
            const first = new BenchExecutionService(dir, routes(), 4, clientFactory as never);
            const runId = await first.start_run({
                targets: [{ id: 'target-a', route_id: 'route-a', thinking: 'high' }],
                task_ids: [taskId],
                rounds: 1
            });
            expect(await first.wait_for_run(runId, 5)).toBe(true);
            // Completed terminal run is evicted from active _runs map while remaining queryable.
            expect(first._runs.size).toBe(0);
            expect(first.has_run(runId)).toBe(true);
            expect(first.list_runs()).toHaveLength(1);
            expect(first.list_observations()).toHaveLength(1);
            const full = first.get_run(runId)!;
            expect(full.status).toBe('completed');
            expect(full.samples).toHaveLength(1);
            expect(first._runs.size).toBe(0);

            const dbPath = join(dir, 'mini-bench.sqlite');
            expect(existsSync(dbPath)).toBe(true);
            expect(statSync(dbPath).mode & 0o777).toBe(0o600);
            expect(existsSync(join(dir, '.run-index-cache.json'))).toBe(false);
            const summaryBefore = first.list_runs();
            const obsBefore = first.list_observations();
            await first.close();

            // Restart loads directly from SQLite and keeps _runs empty.
            const warm = new BenchExecutionService(dir, routes(), 4, clientFactory as never);
            expect(warm._runs.size).toBe(0);
            expect(warm.list_runs()).toEqual(summaryBefore);
            expect(warm.list_observations()).toEqual(obsBefore);
            expect(warm.get_run(runId)?.status).toBe('completed');
            await warm.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('slimmed terminal tasks keep full provenance on get_task and survive restart plus child retry', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mini-bench-slim-task-'));
        try {
            let attempt = 0;
            const failingThenOk = () => ({
                post_responses_stream: () => {
                    attempt++;
                    return attempt === 1
                        ? ([503, 0.01, {}, { error: { message: 'temporary outage' } }] as const)
                        : ([200, 0.01, {}, completedResponse()] as const);
                }
            });
            const service = new BenchExecutionService(dir, routes(), 4, failingThenOk as never);
            service.retry_wait = async () => {};
            const taskId = await service.start_task({
                targets: [{ route_id: 'route-a', thinking: 'high' }],
                rounds: 1,
                sample_concurrency: 2,
                limits: { timeout: 60, max_api_retries: 0 }
            });
            const childId = (service.get_task(taskId)!.children as { run_id: string }[])[0]!.run_id;
            expect(await service.wait_for_run(childId, 5)).toBe(true);
            expect(service._runs.size).toBe(0);
            // list_tasks omits bulky provenance, get_task loads full task_snapshots from disk.
            const listed = service.list_tasks()[0]!.plan as Record<string, unknown>;
            expect(listed).not.toHaveProperty('task_snapshots');
            const detail = service.get_task(taskId)!.plan as Record<string, unknown>;
            expect(Array.isArray(detail.task_snapshots)).toBe(true);
            expect((detail.task_snapshots as unknown[]).length).toBe(12);

            // Retrying a failed child reloads full task.json before persisting updated task status.
            await service.retry_run(childId, 'a'.repeat(32));
            expect(await service.wait_for_run(childId, 5)).toBe(true);
            expect(service._runs.size).toBe(0);
            const afterRetry = service.get_task(taskId)!;
            expect(afterRetry.status).toBe('completed');
            expect(((afterRetry.plan as Record<string, unknown>).task_snapshots as unknown[]).length).toBe(12);
            await service.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('BenchService caches observations, banks, tasks, and runs payloads and invalidates on revision changes', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mini-bench-http-cache-'));
        const service = new BenchService({ data_dir: dir, token: 't'.repeat(32) });
        try {
            const execution = service.bench_execution();
            const obs1 = service.cached_observations_payload();
            const obs2 = service.cached_observations_payload();
            expect(obs2).toBe(obs1);
            const banks1 = service.cached_banks_payload();
            const banks2 = service.cached_banks_payload();
            expect(banks2).toBe(banks1);
            const tasks1 = service.cached_tasks_payload(execution);
            const tasks2 = service.cached_tasks_payload(execution);
            expect(tasks2).toBe(tasks1);
            expect(typeof tasks1.etag).toBe('string');
            expect(tasks1.body).toBe(JSON.stringify({ etag: tasks1.etag, tasks: execution.list_tasks() }));
            const runs1 = service.cached_runs_payload(execution);
            const runs2 = service.cached_runs_payload(execution);
            expect(runs2).toBe(runs1);
            expect(typeof runs1.etag).toBe('string');
            expect(runs1.body).toBe(JSON.stringify({ etag: runs1.etag, runs: execution.list_runs() }));
        } finally {
            await service.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('coalesced persistence and slim active tasks preserve full provenance and avoid spinning on partial slots', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mini-bench-coalesce-'));
        try {
            let calls = 0;
            const clientFactory = () => ({
                post_responses_stream: async () => {
                    calls++;
                    await new Promise(resolve => setTimeout(resolve, 2));
                    return [200, 0.01, {}, completedResponse()] as const;
                }
            });
            const service = new BenchExecutionService(dir, routes(), 6, clientFactory as never);
            let persists = 0;
            const origPersist = service._persist.bind(service);
            service._persist = run => {
                persists++;
                return origPersist(run);
            };
            const taskId = await service.start_task({
                targets: [{ route_id: 'route-a', thinking: 'high' }],
                rounds: 1,
                sample_concurrency: 5,
                limits: { timeout: 60 }
            });
            // Active task in _tasks is already slimmed while get_task loads full task_snapshots from disk.
            expect(service._tasks.get(taskId)!.plan).not.toHaveProperty('task_snapshots');
            expect(Array.isArray((service.get_task(taskId)!.plan as Record<string, unknown>).task_snapshots)).toBe(true);
            expect(service.serialize_tasks_payload()).toBe(JSON.stringify({ tasks: service.list_tasks() }));
            expect(service.serialize_runs_payload()).toBe(JSON.stringify({ runs: service.list_runs() }));

            const childId = (service.get_task(taskId)!.children as { run_id: string }[])[0]!.run_id;
            expect(await service.wait_for_run(childId, 5)).toBe(true);
            expect(calls).toBe(12);
            // 12 samples with sample_concurrency=5: 1 staging + <= 12 coalesced transitions (far below 25+ uncoalesced writes).
            expect(persists).toBeLessThanOrEqual(14);
            expect(service.serialize_tasks_payload()).toBe(JSON.stringify({ tasks: service.list_tasks() }));
            expect(service.serialize_runs_payload()).toBe(JSON.stringify({ runs: service.list_runs() }));
            await service.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('SQLite run_index_cache serves warm restarts without hydrating attempts and recovers from corrupt rows', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mini-bench-sqlite-cache-'));
        const taskId = load_assessment_bank().task_ids[0]!;
        const clientFactory = () => ({
            post_responses_stream: () => [200, 0.01, {}, completedResponse()] as const
        });
        try {
            const first = new BenchExecutionService(dir, routes(), 4, clientFactory as never);
            const runId = await first.start_run({
                targets: [{ id: 'target-a', route_id: 'route-a', thinking: 'high' }],
                task_ids: [taskId],
                rounds: 1
            });
            expect(await first.wait_for_run(runId, 5)).toBe(true);
            const expectedSummary = first.list_runs();
            const expectedObs = first.list_observations();
            await first.close();

            // Verify run_index_cache row exists and warm restart skips load_run completely.
            const db = new BenchDatabase(join(dir, 'mini-bench.sqlite'));
            let loadRunCalls = 0;
            const origLoadRun = db.load_run.bind(db);
            db.load_run = id => {
                loadRunCalls++;
                return origLoadRun(id);
            };
            const cachedRows = db.list_runs_for_startup();
            expect(cachedRows).toHaveLength(1);
            expect(cachedRows[0]!.summary_json).not.toBeNull();
            const warm = new BenchExecutionService(dir, routes(), 4, clientFactory as never, db);
            expect(loadRunCalls).toBe(0);
            expect(warm.list_runs()).toEqual(expectedSummary);
            expect(warm.list_observations()).toEqual(expectedObs);
            await warm.close();

            // Corrupt cache JSON -> startup gracefully falls back to load_run and repairs cache.
            db.db.run("UPDATE run_index_cache SET summary_json = '{not-json' WHERE run_id = ?", [runId]);
            const recovered = new BenchExecutionService(dir, routes(), 4, clientFactory as never, db);
            expect(loadRunCalls).toBe(1);
            expect(recovered.list_runs()).toEqual(expectedSummary);
            expect(recovered.list_observations()).toEqual(expectedObs);
            await recovered.close();

            // Stale summary_json missing 3-category anomaly fields -> startup rehydrates and repairs cache.
            const staleSummary = structuredClone(expectedSummary[0]!);
            delete (staleSummary.result_quality as Record<string, unknown>).timeout_samples;
            delete (staleSummary.result_quality as Record<string, unknown>).model_anomaly_samples;
            delete (staleSummary.result_quality as Record<string, unknown>).non_model_anomaly_samples;
            db.db.run('UPDATE run_index_cache SET summary_json = ? WHERE run_id = ?', [JSON.stringify(staleSummary), runId]);
            const upgraded = new BenchExecutionService(dir, routes(), 4, clientFactory as never, db);
            expect(loadRunCalls).toBe(2);
            expect(upgraded.list_runs()).toEqual(expectedSummary);
            await upgraded.close();
            db.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('tasks and runs HTTP endpoints support conditional ?known=<etag> polling', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mini-bench-known-etag-'));
        const token = 't'.repeat(32);
        const service = new BenchService({ data_dir: dir, token });
        const handler = make_handler(service);
        const headers = { Host: '127.0.0.1:3481', 'X-Mini-Bench-Token': token };
        try {
            const firstTasks = await (await handler(new Request('http://127.0.0.1:3481/api/bench/tasks', { headers }))).json();
            expect(typeof firstTasks.etag).toBe('string');
            expect(firstTasks.tasks).toEqual([]);
            const sameTasks = await (
                await handler(
                    new Request(`http://127.0.0.1:3481/api/bench/tasks?known=${encodeURIComponent(firstTasks.etag)}`, { headers })
                )
            ).json();
            expect(sameTasks).toEqual({ etag: firstTasks.etag, unchanged: true });

            const firstRuns = await (await handler(new Request('http://127.0.0.1:3481/api/bench/runs', { headers }))).json();
            expect(typeof firstRuns.etag).toBe('string');
            expect(firstRuns.runs).toEqual([]);
            const sameRuns = await (
                await handler(new Request(`http://127.0.0.1:3481/api/bench/runs?known=${encodeURIComponent(firstRuns.etag)}`, { headers }))
            ).json();
            expect(sameRuns).toEqual({ etag: firstRuns.etag, unchanged: true });
        } finally {
            await service.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('startup legacy overlay normalizes post-submission non-model runs and repairs 4xx budget / wiped timeout usage', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mini-bench-legacy-repair-'));
        const taskId = load_assessment_bank().task_ids[0]!;
        try {
            const clientFactory = () => ({
                post_responses_stream: () => [200, 0.01, {}, completedResponse()] as const
            });
            const writer = new BenchExecutionService(dir, routes(), 4, clientFactory as never);
            const runId = await writer.start_run({
                targets: [{ id: 'target-a', route_id: 'route-a', thinking: 'high' }],
                task_ids: [taskId],
                rounds: 1
            });
            expect(await writer.wait_for_run(runId, 5)).toBe(true);
            await writer.close();

            const db = new BenchDatabase(join(dir, 'mini-bench.sqlite'));
            try {
                const saved = db.load_run(runId) as any;
                const sample = saved.samples[0];
                sample.answer_submission = {
                    protocol: 'submit-answer-tool-v1',
                    call_id: 'c1',
                    answer: { ok: true },
                    submissions: 1,
                    ended_after_submission: 'api_failure'
                };
                sample.grade = { content_score: 1, outcome: 'exact_match', instruction_checks: { submitted_via_tool: true } };
                saved.budget.missing_cost_calls = 1;
                saved.budget.uncertain_cost_reservation_usd = 0.25;
                saved.budget.estimated_uncached_cost_usd = null;
                db.save_run(saved);
                db.insert_session_event({
                    run_id: runId,
                    sample_id: sample.sample_id,
                    attempt_id: sample.attempt_id,
                    seq: 99,
                    kind: 'llm_turn',
                    call_id: `${sample.attempt_id}:2:1`,
                    turn: 2,
                    api_attempt: 1,
                    http_status: 429,
                    elapsed_seconds: 0.2,
                    usage_known: false,
                    input_tokens: null,
                    output_tokens: null,
                    estimated_cost_usd: null,
                    response_status: null,
                    error_code: 'rate_limit_error',
                    error_message: 'rate limited',
                    local_exception: null,
                    terminal_event: null,
                    termination: 'http_error',
                    first_output_seconds: null,
                    last_progress_seconds: null,
                    payload: { type: 'call' }
                });
                db.db.run('DELETE FROM run_index_cache');
            } finally {
                db.close();
            }

            const reloaded = new BenchExecutionService(dir, routes(), 4, clientFactory as never);
            const loaded = reloaded.get_run(runId)!;
            expect(loaded.status).toBe('failed');
            expect(loaded.retryable_samples).toBe(1);
            expect(loaded.budget.missing_cost_calls).toBe(0);
            expect(loaded.budget.uncertain_cost_reservation_usd).toBe(0);
            expect(typeof loaded.budget.estimated_uncached_cost_usd).toBe('number');
            const summary = reloaded.list_runs().find(r => r.id === runId)!;
            expect(summary.status).toBe('failed');
            const quality = summary.result_quality as Record<string, number>;
            expect(quality.non_model_anomaly_samples).toBe(1);
            expect(quality.ended_after_non_model_samples).toBe(1);
            await reloaded.close();

            const cachedReload = new BenchExecutionService(dir, routes(), 4, clientFactory as never);
            expect(cachedReload.list_runs().find(r => r.id === runId)!.status).toBe('failed');
            expect(cachedReload.get_run(runId)!.status).toBe('failed');
            expect(cachedReload.get_run(runId)!.budget.missing_cost_calls).toBe(0);
            await cachedReload.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
