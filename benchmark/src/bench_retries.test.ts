import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AssessmentBudget, run_assessment_sample, type RunnerTask } from '../calibrate_assessment.ts';
import { BenchDatabase } from './bench_db.ts';
import { BenchExecutionService, type ExecutionRoutes } from './bench_execution.ts';
import { project_assessment_observation } from './assessment_observations.ts';
import type { BaselineRun, BaselineTarget } from './assessment_baselines.ts';
import type { GatewayResponse } from './client.ts';

const success = (text = '42') => ({ status: 'completed', output_text: text, output: [], usage: { input_tokens: 10, output_tokens: 5 } });
const config = { max_output_tokens: 128, max_turns: 6, max_tool_calls: 5, timeout: 10, max_api_retries: 3 };
const pricing = { prompt: 0.000001, completion: 0.000001 };
const textTask: RunnerTask = { id: 'test', domain: 'test', kind: 'text', prompt: 'Solve', grade: () => ({ content_score: 1 }) };
const dirs: string[] = [],
    services: BenchExecutionService[] = [];
afterEach(async () => {
    for (const service of services.splice(0)) await service.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('three API retries means four attempts; each raw attempt precedes its retry and successful usage is retained', async () => {
    const records: Record<string, unknown>[] = [],
        delays: number[] = [],
        budget = new AssessmentBudget(Infinity, 20);
    let calls = 0;
    const result = await run_assessment_sample(
        { post_responses_stream: () => [++calls < 4 ? 429 : 200, 0, {}, calls < 4 ? { error: 'limited' } : success()] },
        textTask,
        { model: 'm', thinking: 'high' },
        1,
        config,
        pricing,
        budget,
        { write: row => records.push(row) },
        undefined,
        async ms => {
            delays.push(ms);
        }
    );
    expect(calls).toBe(4);
    expect(delays).toEqual([1000, 2000, 4000]);
    expect(result.status).toBe('completed');
    expect(result.estimated_uncached_cost_usd).toBeCloseTo(0.000015, 12);
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(budget.missing_cost).toBe(3);
    expect(budget.stop_reason).toBeNull();
    expect(budget.uncertain_cost).toBeGreaterThan(0);
    expect(records.map(row => row.type)).toEqual(['call', 'api_retry', 'call', 'api_retry', 'call', 'api_retry', 'call', 'observation']);
    expect(new Set(result.calls).size).toBe(4);
});

test('only transient HTTP/transport errors retry, not auth errors or capability limits', async () => {
    for (const [status, payload, attempts, outcome] of [
        [500, { error: 'upstream' }, 4, 'api_failure'],
        [-1, { exception: 'TimeoutError' }, 4, 'api_failure'],
        [401, { error: 'auth' }, 1, 'api_failure'],
        [200, { ...success(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, 1, 'incomplete']
    ] as const) {
        let calls = 0;
        const result = await run_assessment_sample(
            {
                post_responses_stream: () => {
                    calls++;
                    return [status, 0, {}, payload];
                }
            },
            textTask,
            { model: 'm', thinking: 'high' },
            1,
            config,
            pricing,
            new AssessmentBudget(Infinity, 20),
            { write() {} },
            undefined,
            async () => {}
        );
        expect(calls).toBe(attempts);
        expect(result.status).toBe(outcome);
    }
});

test('retrying a tool continuation keeps the exact history and does not execute prior tools twice', async () => {
    let calls = 0,
        tools = 0;
    const bodies: unknown[] = [];
    const task: RunnerTask = {
        ...textTask,
        kind: 'tool',
        tools: [],
        make_simulator: () => ({
            call() {
                tools++;
                return { ok: true };
            },
            grade() {
                return { content_score: 1 };
            }
        })
    };
    const result = await run_assessment_sample(
        {
            post_responses_stream: body => {
                bodies.push(structuredClone(body));
                calls++;
                return calls === 1
                    ? [
                          200,
                          0,
                          {},
                          {
                              ...success(),
                              output_text: '',
                              output: [{ type: 'function_call', call_id: 'wire', name: 'act', arguments: '{}' }]
                          }
                      ]
                    : calls === 2
                      ? [503, 0, {}, { error: 'temporary' }]
                      : [200, 0, {}, success()];
            }
        },
        task,
        { model: 'm', thinking: 'high' },
        1,
        config,
        pricing,
        new AssessmentBudget(Infinity, 20),
        { write() {} },
        undefined,
        async () => {}
    );
    expect(result.status).toBe('completed');
    expect(tools).toBe(1);
    expect(bodies[1]).toEqual(bodies[2]);
    expect(result.tool_trace).toHaveLength(1);
});

test('cancellation, request ceilings and journal failure prevent further API retries', async () => {
    let calls = 0,
        cancelled = false;
    const client = {
        post_responses_stream(): GatewayResponse {
            calls++;
            return [429, 0, {}, { error: 'limited' }];
        }
    };
    let result = await run_assessment_sample(
        client,
        textTask,
        { model: 'm', thinking: 'high' },
        1,
        config,
        pricing,
        new AssessmentBudget(Infinity, 20),
        { write() {} },
        () => cancelled,
        async () => {
            cancelled = true;
        }
    );
    expect(calls).toBe(1);
    expect(result.status).toBe('cancelled');
    calls = 0;
    result = await run_assessment_sample(
        client,
        textTask,
        { model: 'm', thinking: 'high' },
        1,
        config,
        pricing,
        new AssessmentBudget(Infinity, 1),
        { write() {} },
        undefined,
        async () => {}
    );
    expect(calls).toBe(1);
    expect(result.status).toBe('api_failure');
    calls = 0;
    await expect(
        run_assessment_sample(
            client,
            textTask,
            { model: 'm', thinking: 'high' },
            1,
            config,
            pricing,
            new AssessmentBudget(Infinity, 20),
            {
                write() {
                    throw Error('disk');
                }
            },
            undefined,
            async () => {}
        )
    ).rejects.toThrow('disk');
    expect(calls).toBe(1);
});

test('retry rejection does not close a healthy service; storage publication failure admits no new calls', async () => {
    const f = fixture();
    const id = await f.service.start_run({
        targets: [{ route_id: 'route', thinking: 'high' }],
        task_ids: ['K23_HTTP_Conditional_Cache_Precedence'],
        limits: { max_api_retries: 0, max_requests: 1 }
    });
    await f.service.wait_for_run(id, 2);
    f.succeed();
    await expect(f.service.retry_run(id, 'e'.repeat(32))).rejects.toThrow('limit exhausted');
    expect(f.service._closing).toBe(false);
    expect(f.calls()).toBe(1);
    expect(f.service.get_run(id)!.retry_batches).toBeUndefined();
    const g = fixture();
    const other = await g.service.start_run({
        targets: [{ route_id: 'route', thinking: 'high' }],
        task_ids: ['K23_HTTP_Conditional_Cache_Precedence'],
        limits: { max_api_retries: 0 }
    });
    await g.service.wait_for_run(other, 2);
    g.succeed();
    g.service._persist = () => {
        throw Object.assign(Error('disk'), { code: 'EIO' });
    };
    await expect(g.service.retry_run(other, 'f'.repeat(32))).rejects.toThrow('disk');
    expect(g.calls()).toBe(1);
    expect(g.service._closing).toBe(true);
});

test('concurrent duplicate manual retry submissions publish one retry generation', async () => {
    const f = fixture();
    const id = await f.service.start_run({
        targets: [{ route_id: 'route', thinking: 'high' }],
        task_ids: ['K23_HTTP_Conditional_Cache_Precedence'],
        limits: { max_api_retries: 0 }
    });
    await f.service.wait_for_run(id, 2);
    f.succeed();
    await Promise.all([f.service.retry_run(id, '1'.repeat(32)), f.service.retry_run(id, '1'.repeat(32))]);
    await f.service.wait_for_run(id, 2);
    expect(f.calls()).toBe(2);
    expect(f.service.get_run(id)!.retry_batches).toHaveLength(1);
});

function fixture(successFirst = false) {
    const dir = mkdtempSync(join(tmpdir(), 'bench-retry-'));
    dirs.push(dir);
    const route = {
        model: 'model',
        account_ref: 'fixed',
        account_evidence: 'configured_binding',
        binding_ref: 'binding',
        base_url: 'https://invalid/v1',
        api_key: 'private-secret',
        thinking_levels: ['high'],
        account_concurrency: 1,
        pricing
    };
    const routes: ExecutionRoutes = { resolve: () => structuredClone(route), public_routes: () => [] };
    let fail = true,
        calls = 0;
    const service = new BenchExecutionService(dir, routes, 2, () => ({
        post_responses_stream: () => {
            calls++;
            return fail && !(successFirst && calls === 1) ? [503, 0, {}, { error: 'private-secret' }] : [200, 0, {}, success()];
        }
    }));
    service.retry_wait = async () => {};
    services.push(service);
    return {
        dir,
        route,
        routes,
        service,
        calls: () => calls,
        succeed: () => {
            fail = false;
        }
    };
}

test('manual retry archives evidence, keeps successful sample bytes, updates parent/results and is idempotent', async () => {
    const f = fixture(true);
    const taskId = await f.service.start_task({
        targets: [{ route_id: 'route', thinking: 'high' }],
        rounds: 1,
        limits: { max_api_retries: 0 }
    });
    let task = f.service.get_task(taskId)!;
    const id = (task.children as { run_id: string }[])[0]!.run_id;
    await f.service.wait_for_run(id, 2);
    expect(f.service.get_run(id)!.status).toBe('failed');
    const successfulBefore = JSON.stringify(f.service.get_run(id)!.samples.find(sample => sample.status === 'completed'));
    const eventsBefore = f.service.read_run_session_events(id)!;
    f.succeed();
    const retryId = 'a'.repeat(32);
    await f.service.retry_run(id, retryId);
    await f.service.wait_for_run(id, 2);
    let run = f.service.get_run(id)!;
    expect(run.status).toBe('completed');
    expect(run.samples).toHaveLength(12);
    expect(run.samples.every(sample => sample.status === 'completed')).toBe(true);
    expect(f.service.get_task(taskId)!.status).toBe('completed');
    expect(run.budget.estimated_uncached_cost_usd).toBeNull();
    // Prior session events remain immutable and no run-before.json or copied source/ dirs are created.
    expect(f.service.read_run_session_events(id)!.slice(0, eventsBefore.length)).toEqual(eventsBefore);
    expect(existsSync(join(f.dir, id))).toBe(false);
    expect((run.retry_batches as Array<Record<string, any>>)[0]!.source_sha256['calibrate_assessment.ts']).toMatch(/^[a-f0-9]{64}$/);
    const after = f.calls();
    await f.service.retry_run(id, retryId);
    expect(f.calls()).toBe(after);
    expect(JSON.stringify(run)).not.toContain('private-secret');
    expect(run.samples[1]!.attempts as unknown[]).toHaveLength(1);
    expect(JSON.stringify(run.samples.find(sample => !sample.attempts))).toBe(successfulBefore);
    const stable = structuredClone(run.samples);
    await f.service.close();
    const restarted = new BenchExecutionService(f.dir, f.routes);
    services.push(restarted);
    expect(restarted.get_run(id)!.samples).toEqual(stable);
    expect(f.calls()).toBe(after);
});

test('manual retry rejects capability-only outcomes, active runs and changed account bindings', async () => {
    const f = fixture();
    const id = await f.service.start_run({
        targets: [{ route_id: 'route', thinking: 'high' }],
        task_ids: ['K23_HTTP_Conditional_Cache_Precedence'],
        limits: { max_api_retries: 0 }
    });
    await f.service.wait_for_run(id, 2);
    f.succeed();
    f.route.account_ref = 'other';
    await expect(f.service.retry_run(id, 'b'.repeat(32))).rejects.toThrow('identity');
    expect(f.calls()).toBe(1);
    f.route.account_ref = 'fixed';
    await f.service.retry_run(id, 'c'.repeat(32));
    await f.service.wait_for_run(id, 2);
    await expect(f.service.retry_run(id, 'd'.repeat(32))).rejects.toThrow('No API-failed');
});

test('explicit current-policy rerun retains successful samples and original plan while rerunning capability outcomes uncapped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-policy-rerun-'));
    dirs.push(dir);
    let calls = 0,
        phase = 'old';
    const bodies: any[] = [];
    const route = {
        model: 'fixture',
        account_ref: 'fixed',
        base_url: 'https://invalid/v1',
        api_key: 'fixture',
        thinking_levels: ['high'],
        account_concurrency: 1,
        pricing
    };
    const service = new BenchExecutionService(dir, { resolve: () => route, public_routes: () => [] }, 2, () => ({
        post_responses_stream: body => {
            calls++;
            bodies.push(structuredClone(body));
            return [
                200,
                0,
                {},
                phase === 'old' && calls > 1
                    ? { ...success(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
                    : success()
            ];
        }
    }));
    services.push(service);
    service.retry_wait = async () => {};
    const task = await service.start_task({
        targets: [{ route_id: 'route', thinking: 'high' }],
        rounds: 1,
        limits: {
            max_requests: 150,
            max_output_tokens: 128,
            max_turns: 1,
            max_tool_calls: 1,
            max_cost_usd: 3,
            timeout: 10,
            max_api_retries: 0
        }
    });
    const id = (service.get_task(task)!.children as any[])[0].run_id;
    await service.wait_for_run(id, 2);
    const before = structuredClone(service.get_run(id)!);
    expect(before.status).toBe('incomplete');
    expect(before.samples[0]!.status).toBe('completed');
    phase = 'new';
    await service.retry_run(id, '2'.repeat(32), 'sample-timeout-v1');
    await service.wait_for_run(id, 2);
    const after = service.get_run(id)!;
    expect(after.status).toBe('completed');
    expect(service.get_task(task)!.status).toBe('completed');
    expect(after.plan).toEqual(before.plan);
    expect(after.samples[0]).toEqual(before.samples[0]);
    expect(
        after.samples
            .slice(1)
            .every(sample => (sample.retry_limits as any).timeout === 600 && (sample.retry_limits as any).max_turns === null)
    ).toBe(true);
    expect(bodies.slice(12).every(body => !Object.hasOwn(body, 'max_output_tokens'))).toBe(true);
    expect(calls).toBe(23);
    const batch = (after.retry_batches as any[])[0];
    expect(batch.policy).toBe('sample-timeout-v1');
    expect(batch.limits.max_requests).toBeNull();
    await service.retry_run(id, '2'.repeat(32), 'sample-timeout-v1');
    expect(calls).toBe(23);
    await expect(service.retry_run(id, '2'.repeat(32))).rejects.toThrow('policy mismatch');
});

test('manual retry resumes service-interrupted runs while preserving completed samples', async () => {
    const f = fixture(true);
    let release!: () => void;
    const wait = new Promise<void>(resolve => {
        release = resolve;
    });
    let calls = 0;
    const dir = f.dir;
    await f.service.close();
    const slow = new BenchExecutionService(dir, f.routes, 1, () => ({
        post_responses_stream: async () => {
            calls++;
            if (calls > 1) await wait;
            return [200, 0, {}, success()];
        }
    }));
    services.push(slow);
    const taskId = await slow.start_task({
        targets: [{ route_id: 'route', thinking: 'high' }],
        rounds: 1,
        sample_concurrency: 1
    });
    const runId = (slow.get_task(taskId)!.children as { run_id: string }[])[0]!.run_id;
    while (calls < 2) await new Promise(resolve => setTimeout(resolve, 5));
    // Simulate a service restart where the previous process stops writing before the new service loads.
    slow._persist = () => {};
    slow._persist_task = () => {};
    const restarted = new BenchExecutionService(dir, f.routes, 2, () => ({
        post_responses_stream: () => [200, 0, {}, success()]
    }));
    services.push(restarted);
    release();
    await slow.close(false);
    const interrupted = restarted.get_run(runId)!;
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.retryable_samples).toBe(11);
    expect(restarted.get_task(taskId)!.status).toBe('interrupted');
    const retryResult = await restarted.retry_task(taskId, '3'.repeat(32));
    expect(retryResult).toEqual({ ids: [runId], rejected: [] });
    await restarted.wait_for_run(runId, 2);
    const completed = restarted.get_run(runId)!;
    expect(completed.status).toBe('completed');
    expect(completed.retryable_samples).toBe(0);
    expect(completed.samples.every(sample => sample.status === 'completed')).toBe(true);
    expect(restarted.get_task(taskId)!.status).toBe('completed');
});

test('manual retry resumes cancelled runs while keeping completed samples and complete usage', async () => {
    const f = fixture(true);
    let release!: () => void;
    const wait = new Promise<void>(resolve => {
        release = resolve;
    });
    let calls = 0,
        blockSecond = true;
    const dir = f.dir;
    await f.service.close();
    const service = new BenchExecutionService(dir, f.routes, 1, () => ({
        post_responses_stream: async () => {
            calls++;
            if (blockSecond && calls === 2) await wait;
            return [200, 0, {}, success()];
        }
    }));
    services.push(service);
    const taskId = await service.start_task({
        targets: [{ route_id: 'route', thinking: 'high' }],
        rounds: 1,
        sample_concurrency: 1
    });
    const runId = (service.get_task(taskId)!.children as { run_id: string }[])[0]!.run_id;
    while (calls < 2) await new Promise(resolve => setTimeout(resolve, 5));
    service.cancel_task(taskId);
    release();
    await service.wait_for_run(runId, 2);
    const cancelled = service.get_run(runId)!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.retryable_samples).toBe(11);
    blockSecond = false;
    const retryResult = await service.retry_task(taskId, '4'.repeat(32));
    expect(retryResult).toEqual({ ids: [runId], rejected: [] });
    await service.wait_for_run(runId, 2);
    const completed = service.get_run(runId)!;
    expect(completed.status).toBe('completed');
    expect(completed.retryable_samples).toBe(0);
    expect(completed.samples.every(sample => sample.status === 'completed')).toBe(true);
    const obs = project_assessment_observation(
        completed as unknown as BaselineRun,
        completed.plan.targets[0] as unknown as BaselineTarget,
        'run',
        null,
        null
    );
    expect(obs.usage).toEqual({ input_tokens: 120, output_tokens: 60 });
    expect(obs.estimated_cost_usd).toBeCloseTo(0.00018, 12);
    expect((obs.usage_accounting as Record<string, unknown>).unknown_usage_attempts).toBe(0);
});

test('sample timeout scores zero and completes the run while remaining retryable, unlike API failure', async () => {
    const f = fixture(true);
    let calls = 0;
    const dir = f.dir;
    await f.service.close();
    // 1) Runner emits SampleTimeout when the whole-sample deadline expires.
    const timed = await run_assessment_sample(
        {
            post_responses_stream: (_body, _timeout, options) =>
                new Promise<GatewayResponse>(resolve => {
                    const done = () => resolve([-1, 0.05, {}, { error: 'TimeoutError' }]);
                    if (options?.signal?.aborted) return done();
                    options?.signal?.addEventListener('abort', done, { once: true });
                })
        },
        textTask,
        { model: 'm', thinking: 'high' },
        1,
        { ...config, timeout: 0.05, timeout_scope: 'sample', max_api_retries: 0 },
        pricing,
        new AssessmentBudget(Infinity, 20),
        { write() {} },
        undefined,
        async () => {}
    );
    expect(timed.status).toBe('api_failure');
    expect(timed.runner_error).toBe('SampleTimeout');

    // 2) A run whose only non-completed sample is a SampleTimeout loads as completed (score 0) and stays retryable.
    const writer = new BenchExecutionService(dir, f.routes, 2, () => ({
        post_responses_stream: () => {
            calls++;
            return calls === 2 ? [503, 0.01, {}, { error: 'upstream' }] : [200, 0.01, {}, success()];
        }
    }));
    services.push(writer);
    const taskId = await writer.start_task({
        targets: [{ route_id: 'route', thinking: 'high' }],
        rounds: 1,
        sample_concurrency: 1,
        limits: { timeout: 10, max_api_retries: 0 }
    });
    const runId = (writer.get_task(taskId)!.children as { run_id: string }[])[0]!.run_id;
    await writer.wait_for_run(runId, 5);
    // Plain 503 API failure keeps run failed and sample unscored.
    const failedRun = writer.get_run(runId)!;
    expect(failedRun.status).toBe('failed');
    const failedObs = project_assessment_observation(
        failedRun as unknown as BaselineRun,
        failedRun.plan.targets[0] as unknown as BaselineTarget,
        'run',
        null,
        null
    );
    expect(failedObs.status).toBe('failed');
    expect(failedObs.tasks.flatMap(t => t.samples).filter(s => s.status === 'api_failure')[0]!.content_score).toBeNull();

    // Mark that failed sample as SampleTimeout in SQLite (matching a real deadline expiry) and reload.
    await writer.close();
    const db = new BenchDatabase(join(dir, 'mini-bench.sqlite'));
    try {
        const saved = db.load_run(runId) as any;
        const failedSample = saved.samples.find((s: Record<string, unknown>) => s.status === 'api_failure');
        failedSample.runner_error = 'SampleTimeout';
        failedSample.elapsed_seconds = 10;
        db.save_run(saved);
    } finally {
        db.close();
    }
    const reloaded = new BenchExecutionService(dir, f.routes, 2, () => ({
        post_responses_stream: () => [200, 0.01, {}, success()]
    }));
    services.push(reloaded);
    const run = reloaded.get_run(runId)!;
    expect(run.status).toBe('completed');
    expect(run.retryable_samples).toBe(1);
    const summary = reloaded.list_runs().find(item => item.id === runId)!;
    expect((summary.sample_status_counts as Record<string, number>).timeout).toBe(1);
    expect((summary.sample_status_counts as Record<string, number>).completed).toBe(11);
    const obs = project_assessment_observation(
        run as unknown as BaselineRun,
        run.plan.targets[0] as unknown as BaselineTarget,
        'run',
        null,
        null
    );
    expect(obs.status).toBe('completed');
    const timedOut = obs.tasks.flatMap(t => t.samples).filter(s => s.status === 'timeout');
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0]!.content_score).toBe(0);
    expect(obs.elapsed_seconds).toBeGreaterThan(0);
    // Timeout sample can still be manually retried to completion.
    await reloaded.retry_run(runId, '5'.repeat(32));
    await reloaded.wait_for_run(runId, 5);
    const retried = reloaded.get_run(runId)!;
    expect(retried.retryable_samples).toBe(0);
    expect(retried.samples.every(sample => sample.status === 'completed')).toBe(true);
});
