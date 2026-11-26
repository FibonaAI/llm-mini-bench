import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BenchExecutionService, type ExecutionRoutes } from './bench_execution.ts';
import { fast_fail_stop_reason } from './bench_execution_queries.ts';
import type { GatewayResponse } from './client.ts';

const success = () => ({ status: 'completed', output_text: '42', output: [], usage: { input_tokens: 10, output_tokens: 5 } });
const pricing = { prompt: 0.000001, completion: 0.000001 };
const dirs: string[] = [],
    services: BenchExecutionService[] = [];
afterEach(async () => {
    for (const service of services.splice(0)) await service.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Two routes on separate accounts; route A answers with `failure` until healed, route B always succeeds. */
function fixture(failure: GatewayResponse) {
    const dir = mkdtempSync(join(tmpdir(), 'bench-fast-fail-'));
    dirs.push(dir);
    const route = (name: string) => ({
        model: 'model-' + name,
        account_ref: 'account-' + name,
        account_evidence: 'configured_binding',
        base_url: `https://${name}.invalid/v1`,
        api_key: 'secret-' + name,
        thinking_levels: ['low', 'high'],
        account_concurrency: 4,
        pricing
    });
    const routes: ExecutionRoutes = {
        resolve: id => {
            if (id !== 'route-a' && id !== 'route-b') throw new TypeError('Unknown fixture route');
            return route(id.slice(-1));
        },
        public_routes: () => []
    };
    const counts = { a: 0, b: 0 };
    let healed = false;
    const service = new BenchExecutionService(dir, routes, 18, base_url => ({
        post_responses_stream: (): GatewayResponse => {
            if (base_url.includes('//a.')) {
                counts.a++;
                return healed ? [200, 0, {}, success()] : structuredClone(failure);
            }
            counts.b++;
            return [200, 0, {}, success()];
        }
    }));
    service.retry_wait = async () => {};
    services.push(service);
    return {
        service,
        counts,
        heal: () => {
            healed = true;
        }
    };
}

async function children(service: BenchExecutionService, taskId: string) {
    const ids = (service.get_task(taskId)!.children as { run_id: string }[]).map(child => child.run_id);
    for (const id of ids) expect(await service.wait_for_run(id, 5)).toBe(true);
    return ids.map(id => service.get_run(id)!);
}

test('fast-fail classifies only exhausted route-level rejections', () => {
    expect(fast_fail_stop_reason({ status: 'api_failure', last_http_status: 429 })).toBe('rate_limited');
    expect(fast_fail_stop_reason({ status: 'api_failure', last_http_status: 403 })).toBe('access_denied');
    expect(fast_fail_stop_reason({ status: 'api_failure', last_http_status: 401 })).toBe('access_denied');
    expect(fast_fail_stop_reason({ status: 'api_failure', last_http_status: 402 })).toBe('payment_required');
    expect(fast_fail_stop_reason({ status: 'api_failure', last_http_status: 404 })).toBe('model_not_found');
    for (const status of [400, 408, 409, 500, 503, -1, 200])
        expect(fast_fail_stop_reason({ status: 'api_failure', last_http_status: status })).toBeNull();
    expect(fast_fail_stop_reason({ status: 'api_failure', last_http_status: 429, runner_error: 'SampleTimeout' })).toBeNull();
    expect(fast_fail_stop_reason({ status: 'completed', last_http_status: 200 })).toBeNull();
    expect(fast_fail_stop_reason({ status: 'incomplete', last_http_status: 429 })).toBeNull();
    expect(fast_fail_stop_reason({ status: 'api_failure', last_http_status: 200, last_error_code: 'rate_limit_exceeded' })).toBe(
        'rate_limited'
    );
    expect(fast_fail_stop_reason({ status: 'api_failure', last_http_status: 200, last_error_code: 'insufficient_quota' })).toBe(
        'rate_limited'
    );
    expect(fast_fail_stop_reason({ status: 'api_failure', last_http_status: 200, last_error_code: 'server_error' })).toBeNull();
    expect(fast_fail_stop_reason({ status: 'api_failure', last_http_status: 200, last_error_code: 'invalid_prompt' })).toBeNull();
    // A 5xx or transport failure carrying a rate-limit code stays transient and never blocks the route.
    for (const status of [500, 503, -1])
        for (const code of ['rate_limit_exceeded', 'insufficient_quota'])
            expect(fast_fail_stop_reason({ status: 'api_failure', last_http_status: status, last_error_code: code })).toBeNull();
    expect(
        fast_fail_stop_reason({ status: 'completed', last_http_status: 429, answer_submission: { ended_after_submission: 'api_failure' } })
    ).toBe('rate_limited');
});

test('a rate-limited route stops after bounded retries, stops sibling Thinking runs, spares other routes and stays retryable', async () => {
    const f = fixture([429, 0, {}, { error: { code: 'rate_limit_exceeded', message: 'slow down' } }]);
    const taskId = await f.service.start_task({
        targets: [
            { route_id: 'route-a', thinking: 'low' },
            { route_id: 'route-a', thinking: 'high' },
            { route_id: 'route-b', thinking: 'high' }
        ],
        rounds: 1,
        sample_concurrency: 1,
        run_concurrency: 1,
        limits: { max_api_retries: 1 }
    });
    const runs = await children(f.service, taskId);
    // One sample: initial request plus one retry; no other route-A request is ever sent.
    expect(f.counts.a).toBe(2);
    expect(f.counts.b).toBe(12);
    const routeA = runs.filter(run => run.plan.targets[0]!.route_id === 'route-a');
    const routeB = runs.find(run => run.plan.targets[0]!.route_id === 'route-b')!;
    expect(routeB.status).toBe('completed');
    expect(routeA.every(run => run.stop_reason === 'rate_limited')).toBe(true);
    expect(routeA.map(run => run.status).sort()).toEqual(['failed', 'incomplete']);
    const samples = routeA.flatMap(run => run.samples);
    expect(samples.filter(sample => sample.status === 'api_failure')).toHaveLength(1);
    expect(samples.filter(sample => sample.status === 'budget_not_admitted')).toHaveLength(23);
    expect(routeA.every(run => run.retryable_samples === 12)).toBe(true);
    expect(f.service.get_task(taskId)!.status).toBe('failed');

    f.heal();
    const retried = await f.service.retry_task(taskId, '6'.repeat(32));
    expect(retried.ids.sort()).toEqual(routeA.map(run => run.id).sort());
    expect(retried.rejected).toEqual([]);
    const after = await children(f.service, taskId);
    expect(after.every(run => run.status === 'completed' && run.stop_reason === null)).toBe(true);
    expect(f.counts.a).toBe(2 + 24);
    expect(f.service.get_task(taskId)!.status).toBe('completed');
    // Only the rate-limited attempt sent requests without usage; never-sent attempts are known zero.
    const quality = f.service
        .list_runs()
        .filter(run => routeA.some(item => item.id === run.id))
        .map(run => run.result_quality as Record<string, number>);
    expect(quality.reduce((sum, item) => sum + item.prior_unknown_usage_samples!, 0)).toBe(1);
});

test('a permanent 403 is not retried; in-flight samples finish but no further sample is sent', async () => {
    const f = fixture([403, 0, {}, { error: { code: 'forbidden', message: 'no access' } }]);
    const taskId = await f.service.start_task({
        targets: [{ route_id: 'route-a', thinking: 'high' }],
        rounds: 1,
        sample_concurrency: 3,
        limits: { max_api_retries: 3 }
    });
    const [run] = await children(f.service, taskId);
    expect(f.counts.a).toBe(3);
    expect(run!.status).toBe('failed');
    expect(run!.stop_reason).toBe('access_denied');
    expect(run!.samples.filter(sample => sample.status === 'api_failure')).toHaveLength(3);
    expect(run!.samples.filter(sample => sample.status === 'budget_not_admitted')).toHaveLength(9);
    expect(run!.retryable_samples).toBe(12);
});

test('a block spans concurrent and later tasks until a manual retry clears it', async () => {
    const f = fixture([429, 0, {}, { error: { code: 'rate_limit_exceeded' } }]);
    const request = (targets: { route_id: string; thinking: string }[]) => ({
        targets,
        rounds: 1,
        sample_concurrency: 1,
        limits: { max_api_retries: 1 }
    });
    // Two concurrent tasks share route A: only samples already in flight may still send requests.
    const [first, second] = await Promise.all([
        f.service.start_task(request([{ route_id: 'route-a', thinking: 'high' }])),
        f.service.start_task(request([{ route_id: 'route-a', thinking: 'low' }]))
    ]);
    const concurrent = [...(await children(f.service, first!)), ...(await children(f.service, second!))];
    const failed = concurrent.flatMap(run => run.samples).filter(sample => sample.status === 'api_failure');
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(f.counts.a).toBe(failed.length * 2);
    expect(concurrent.every(run => run.stop_reason === 'rate_limited')).toBe(true);

    // A task created after the trigger sends nothing on route A but runs route B normally.
    const before = f.counts.a;
    const later = await children(
        f.service,
        await f.service.start_task(
            request([
                { route_id: 'route-a', thinking: 'high' },
                { route_id: 'route-b', thinking: 'high' }
            ])
        )
    );
    expect(f.counts.a).toBe(before);
    const laterA = later.find(run => run.plan.targets[0]!.route_id === 'route-a')!;
    expect(laterA.stop_reason).toBe('rate_limited');
    expect(laterA.samples.every(sample => sample.status === 'budget_not_admitted' && !sample.calls)).toBe(true);
    expect(laterA.retryable_samples).toBe(12);
    expect(later.find(run => run.plan.targets[0]!.route_id === 'route-b')!.status).toBe('completed');

    // An explicit manual retry clears the block for that route.
    f.heal();
    await f.service.retry_run(laterA.id, '7'.repeat(32));
    expect(await f.service.wait_for_run(laterA.id, 5)).toBe(true);
    expect(f.service.get_run(laterA.id)!.status).toBe('completed');
    expect(f.counts.a).toBe(before + 12);
});

test('rate-limit and access-denied blocks never expire on their own, even after the upstream recovers', async () => {
    const one = { targets: [{ route_id: 'route-a', thinking: 'high' }], rounds: 1, sample_concurrency: 1, limits: { max_api_retries: 0 } };
    const cases: [GatewayResponse, string][] = [
        [[429, 0, {}, { error: 'limited' }], 'rate_limited'],
        [[403, 0, {}, { error: 'forbidden' }], 'access_denied']
    ];
    for (const [failure, reason] of cases) {
        const f = fixture(failure);
        await children(f.service, await f.service.start_task(one));
        expect(f.counts.a).toBe(1);
        await Bun.sleep(20);
        f.heal();
        const [blocked] = await children(f.service, await f.service.start_task(one));
        expect(blocked!.stop_reason).toBe(reason);
        expect(f.counts.a).toBe(1);
    }
});

test('a streamed response.failed rate-limit or quota code retries like HTTP 429, then fast-fails the route', async () => {
    for (const code of ['rate_limit_exceeded', 'insufficient_quota']) {
        const f = fixture([200, 0, {}, { status: 'failed', error: { code, message: 'upstream refused' } }]);
        const taskId = await f.service.start_task({
            targets: [
                { route_id: 'route-a', thinking: 'high' },
                { route_id: 'route-b', thinking: 'high' }
            ],
            rounds: 1,
            sample_concurrency: 1,
            limits: { max_api_retries: 2 }
        });
        const runs = await children(f.service, taskId);
        // One sample: the initial request plus two in-sample retries, then nothing else on route A.
        expect(f.counts.a).toBe(3);
        const routeA = runs.find(run => run.plan.targets[0]!.route_id === 'route-a')!;
        expect(routeA.stop_reason).toBe('rate_limited');
        const failed = routeA.samples.find(sample => sample.status === 'api_failure')!;
        expect(failed.last_http_status).toBe(200);
        expect(failed.last_error_code).toBe(code);
        expect(routeA.samples.filter(sample => sample.status === 'budget_not_admitted')).toHaveLength(11);
        expect(runs.find(run => run.plan.targets[0]!.route_id === 'route-b')!.status).toBe('completed');
    }
});

test('transient 5xx exhaustion does not fast-fail the remaining samples', async () => {
    const f = fixture([503, 0, {}, { error: 'temporary' }]);
    const taskId = await f.service.start_task({
        targets: [{ route_id: 'route-a', thinking: 'high' }],
        rounds: 1,
        sample_concurrency: 1,
        limits: { max_api_retries: 0 }
    });
    const [run] = await children(f.service, taskId);
    expect(f.counts.a).toBe(12);
    expect(run!.status).toBe('failed');
    expect(run!.stop_reason).toBe('api_failure');
    expect(run!.samples.every(sample => sample.status === 'api_failure')).toBe(true);
});
