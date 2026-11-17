import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AssessmentBudget, run_assessment_sample, type RunnerTask } from '../calibrate_assessment.ts';
import { BenchExecutionService, type ExecutionRoutes } from './bench_execution.ts';
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

test('three API retries means four attempts; each raw attempt precedes its retry and costs stay unknown', async () => {
    const records: Record<string, unknown>[] = [],
        delays: number[] = [],
        budget = new AssessmentBudget(Infinity, 20);
    let calls = 0;
    const result = await run_assessment_sample(
        { post_responses_stream: () => [++calls < 4 ? 429 : 200, 0, {}, calls < 4 ? { error: 'limited' } : success()] },
        textTask,
        { model: 'm', thinking: 'default' },
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
    expect(result.estimated_uncached_cost_usd).toBeNull();
    expect(result.usage).toBeNull();
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
            { model: 'm', thinking: 'default' },
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
        { model: 'm', thinking: 'default' },
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
        { model: 'm', thinking: 'default' },
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
        { model: 'm', thinking: 'default' },
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
            { model: 'm', thinking: 'default' },
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
        targets: [{ route_id: 'route' }],
        task_ids: ['K04_Genetic_Code'],
        limits: { max_api_retries: 0, max_requests: 1 }
    });
    await f.service.wait_for_run(id, 2);
    f.succeed();
    await expect(f.service.retry_run(id, 'e'.repeat(32))).rejects.toThrow('limit exhausted');
    expect(f.service._closing).toBe(false);
    expect(f.calls()).toBe(1);
    expect(readdirSync(join(f.dir, id)).some(name => name.startsWith('retry-'))).toBe(false);
    const g = fixture();
    const other = await g.service.start_run({
        targets: [{ route_id: 'route' }],
        task_ids: ['K04_Genetic_Code'],
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
        targets: [{ route_id: 'route' }],
        task_ids: ['K04_Genetic_Code'],
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
        thinking_levels: [],
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
    const taskId = await f.service.start_task({ targets: [{ route_id: 'route' }], rounds: 1, limits: { max_api_retries: 0 } });
    let task = f.service.get_task(taskId)!;
    const id = (task.children as { run_id: string }[])[0]!.run_id;
    await f.service.wait_for_run(id, 2);
    expect(f.service.get_run(id)!.status).toBe('failed');
    const successfulBefore = JSON.stringify(f.service.get_run(id)!.samples.find(sample => sample.status === 'completed'));
    const before = readFileSync(join(f.dir, id, 'run.json'));
    const journal = readFileSync(join(f.dir, id, 'journal.jsonl'));
    f.succeed();
    const retryId = 'a'.repeat(32);
    await f.service.retry_run(id, retryId);
    await f.service.wait_for_run(id, 2);
    let run = f.service.get_run(id)!;
    expect(run.status).toBe('completed');
    expect(run.samples).toHaveLength(14);
    expect(run.samples.every(sample => sample.status === 'completed')).toBe(true);
    expect(f.service.get_task(taskId)!.status).toBe('completed');
    expect(run.budget.estimated_uncached_cost_usd).toBeNull();
    expect(readFileSync(join(f.dir, id, 'retry-' + retryId, 'run-before.json'))).toEqual(before);
    expect(readFileSync(join(f.dir, id, 'journal.jsonl'))).toEqual(journal);
    expect(readdirSync(join(f.dir, id, 'retry-' + retryId, 'source'))).toContain('calibrate_assessment.ts');
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
        targets: [{ route_id: 'route' }],
        task_ids: ['K04_Genetic_Code'],
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
        thinking_levels: [],
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
        targets: [{ route_id: 'route' }],
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
    expect(bodies.slice(14).every(body => !Object.hasOwn(body, 'max_output_tokens'))).toBe(true);
    expect(calls).toBe(27);
    const batch = (after.retry_batches as any[])[0];
    expect(batch.policy).toBe('sample-timeout-v1');
    expect(batch.limits.max_requests).toBeNull();
    await service.retry_run(id, '2'.repeat(32), 'sample-timeout-v1');
    expect(calls).toBe(27);
    await expect(service.retry_run(id, '2'.repeat(32))).rejects.toThrow('policy mismatch');
});
