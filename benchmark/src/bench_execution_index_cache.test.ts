import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BenchExecutionService, type ExecutionRoutes } from './bench_execution.ts';
import { BenchService } from '../backend/mini_bench.ts';
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

            const cachePath = join(dir, '.run-index-cache.json');
            expect(existsSync(cachePath)).toBe(true);
            expect(statSync(cachePath).mode & 0o777).toBe(0o600);
            const summaryBefore = first.list_runs();
            const obsBefore = first.list_observations();
            await first.close();

            // Warm restart uses index cache and keeps _runs empty.
            const warm = new BenchExecutionService(dir, routes(), 4, clientFactory as never);
            expect(warm._runs.size).toBe(0);
            expect(warm.list_runs()).toEqual(summaryBefore);
            expect(warm.list_observations()).toEqual(obsBefore);
            expect(warm.get_run(runId)?.status).toBe('completed');
            await warm.close();

            // Corrupt index cache is ignored cleanly and rebuilt from durable run.json.
            writeFileSync(cachePath, '{not valid json', { mode: 0o600 });
            const rebuilt = new BenchExecutionService(dir, routes(), 4, clientFactory as never);
            expect(rebuilt._runs.size).toBe(0);
            expect(rebuilt.list_runs()).toEqual(summaryBefore);
            expect(rebuilt.list_observations()).toEqual(obsBefore);
            expect(JSON.parse(readFileSync(cachePath, 'utf8')).version).toBe(1);
            await rebuilt.close();
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
            const runs1 = service.cached_runs_payload(execution);
            const runs2 = service.cached_runs_payload(execution);
            expect(runs2).toBe(runs1);
        } finally {
            await service.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
