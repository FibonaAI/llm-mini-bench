import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BenchService, make_handler, MAX_BODY, startMiniBenchService } from './mini_bench.ts';
import { BenchExecutionService, type ExecutionRoute } from '../src/bench_execution.ts';
import { assessment_sample_protocol, execution_protocol_hash } from '../src/run_protocol.ts';
import { assessment_hash } from '../src/assessment_json.ts';
import type { AssessmentBaseline } from '../src/assessment_baselines.ts';
import { MagpieBenchAdapter } from '../../magpie/magpie_adapter.ts';

test('quota endpoint is authenticated, read-only and strips upstream secrets', async () => {
    const { service, adapter, request } = fixture();
    const calls: string[] = [];
    adapter.gateway = async path => {
        calls.push(path);
        return {
            data: [{ provider: 'office/codex', user: 'offline@example.invalid', secret: 'hidden', windows: [{ name: 'weekly', used: 0 }] }]
        };
    };
    expect((await request('/api/bench/quota-cards', 'GET', undefined, { 'X-Mini-Bench-Token': '' })).status).toBe(403);
    expect(calls).toEqual([]);
    const response = await request('/api/bench/quota-cards');
    const body = await response.json();
    expect(body.status).toBe('available');
    expect(body.cards[0].user).toBe('offline@example.invalid');
    expect(JSON.stringify(body)).not.toContain('hidden');
    await request('/api/bench/quota-cards');
    expect(calls).toHaveLength(1);
    await request('/api/bench/quota-cards?refresh=1');
    expect(calls).toEqual(['/magpie/quotas/cards', '/magpie/quotas/cards']);
    expect((await request('/api/bench/quota-cards', 'POST', {})).status).not.toBe(200);
    expect(calls).toHaveLength(2);
});

test('a new workspace never loads bundled test baselines or produces placeholder observations', async () => {
    const { service, request } = fixture();
    expect(service.baselines()).toEqual([]);
    expect(service.observations()).toEqual([]);
    expect(await (await request('/api/bench/baselines')).json()).toEqual({ baselines: [] });
    expect(await (await request('/api/bench/observations')).json()).toEqual({ etag: expect.any(String), observations: [] });
});

test('analysis reads independent evidence snapshots without building discarded history summaries', async () => {
    const { service } = fixture(),
        execution = service.bench_execution();
    const id = await execution.start_run({ targets: [{ route_id: 'route-a', thinking: 'high' }], rounds: 1 });
    expect(await execution.wait_for_run(id, 5)).toBe(true);
    const snapshots = execution.list_run_snapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.samples).toHaveLength(12);
    snapshots[0]!.samples[0]!.status = 'tampered';
    expect(execution.get_run(id)!.samples[0]!.status).not.toBe('tampered');
    execution.list_runs = () => {
        throw new Error('Analysis must not construct discarded summaries');
    };
    expect(service.observations()).toHaveLength(1);
});

test('route refresh invalidates the model cache and removed routes cannot resolve', async () => {
    const { service, adapter, request } = fixture();
    service._bench_execution = undefined;
    let model = 'office/codex/old',
        loads = 0;
    adapter.gateway = async path => {
        expect(path).toBe('/models');
        loads++;
        return { data: [{ id: model, owned_by: 'office', magpie_via: ['remote', 'local'], pricing: { prompt: 0, completion: 0 } }] };
    };
    const first = await (await request('/api/bench/routes')).json();
    model = 'office/codex/new';
    expect((await (await request('/api/bench/routes')).json()).routes[0].model).toBe('office/codex/old');
    const refreshed = await (await request('/api/bench/routes?refresh=1')).json();
    expect(refreshed.routes[0].model).toBe(model);
    expect(loads).toBe(2);
    await expect(service.bench_execution().routes.resolve(first.routes[0].id)).rejects.toThrow('unavailable');
});

test('manual retry endpoints require authentication, explicit idempotency keys and supported bodies', async () => {
    const { service, request } = fixture();
    const execution = service.bench_execution(),
        calls: string[] = [];
    execution.retry_run = async (id, key) => {
        calls.push(id + ':' + key);
        return id;
    };
    execution.retry_task = async (id, key) => {
        calls.push(id + ':' + key);
        return { ids: [id], rejected: [] };
    };
    const key = 'b'.repeat(32);
    expect((await request('/api/bench/runs/' + RUN_ID + '/retry', 'POST', { request_id: key }, { 'X-Mini-Bench-Token': '' })).status).toBe(
        403
    );
    expect(calls).toHaveLength(0);
    expect((await request('/api/bench/runs/' + RUN_ID + '/retry', 'POST', {})).status).toBe(400);
    expect((await request('/api/bench/tasks/' + RUN_ID + '/retry', 'POST', { request_id: key, extra: true })).status).toBe(400);
    expect((await request('/api/bench/runs/' + RUN_ID + '/retry', 'GET')).status).toBe(404);
    expect((await request('/api/bench/runs/' + RUN_ID + '/retry', 'POST', { request_id: key })).status).toBe(202);
    expect(await (await request('/api/bench/tasks/' + RUN_ID + '/retry', 'POST', { request_id: key })).json()).toEqual({
        ids: [RUN_ID],
        rejected: []
    });
    expect(calls).toEqual([RUN_ID + ':' + key, RUN_ID + ':' + key]);
});

const TOKEN = 'x'.repeat(32),
    RUN_ID = 'a'.repeat(32);
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    cleanups.length = 0;
});
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'mini-bench-http-'));
    const adapter = new MagpieBenchAdapter();
    const service = new BenchService({ data_dir: directory, token: TOKEN, adapter });
    const route: ExecutionRoute = {
        id: 'route-a',
        label: 'model',
        account_ref: 'account-a',
        model: 'test-model',
        api_key: 'private-test-key',
        base_url: 'https://example.invalid/v1',
        thinking_levels: ['low', 'high'],
        account_concurrency: 1,
        pricing: { prompt: 0, completion: 0 }
    };
    const execution = new BenchExecutionService(
        directory,
        { resolve: () => route, public_routes: () => [{ id: 'route-a', model: 'test-model' }] },
        4,
        () => ({
            post_responses_stream: async () => [
                200,
                0.001,
                {},
                {
                    status: 'completed',
                    output: [
                        {
                            type: 'message',
                            content: [
                                {
                                    type: 'output_text',
                                    text: '{"posterior_A":"1/2","stop_at_3":"7/12","expected_draws":"41/12"}'
                                }
                            ]
                        }
                    ],
                    usage: { input_tokens: 1, output_tokens: 20 }
                }
            ]
        }),
        service.db
    );
    service._bench_execution = execution;
    const handler = make_handler(service);
    cleanups.push(async () => {
        await service.close();
        rmSync(directory, { recursive: true, force: true });
    });
    const request = (path: string, method = 'GET', body?: unknown, extra: Record<string, string | undefined> = {}) => {
        const text = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
        return handler(
            new Request('http://127.0.0.1:3481' + path, {
                method,
                headers: {
                    host: '127.0.0.1:3481',
                    'X-Mini-Bench-Token': TOKEN,
                    ...(text === undefined
                        ? {}
                        : {
                              'Content-Type': 'application/json',
                              'Content-Length': String(Buffer.byteLength(text))
                          }),
                    ...Object.fromEntries(Object.entries(extra).filter((entry): entry is [string, string] => entry[1] !== undefined))
                },
                body: text
            })
        );
    };
    return { directory, service, adapter, execution, handler, request };
}

test('host, origin, token and opaque plugin origin security', async () => {
    const { request } = fixture();
    for (const headers of [
        { 'X-Mini-Bench-Token': '' },
        { host: 'evil.example' },
        { host: 'user@localhost' },
        { host: 'localhost:bad' },
        { host: '127.1' },
        { origin: 'https://evil.example' },
        { origin: 'null', 'X-Mini-Bench-Token': '' },
        { origin: 'http://127.0.0.1:3481/?secret=x' }
    ])
        expect((await request('/api/bench/banks', 'GET', undefined, headers)).status).toBe(403);
    const response = await request('/api/bench/banks', 'GET', undefined, { origin: 'null' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('null');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect((await request('/api/bench/banks', 'GET', undefined, { origin: 'http://127.0.0.1:3481' })).status).toBe(200);
});
test('preflight grants only sandbox origin; actual requests still require token', async () => {
    const { request } = fixture();
    const response = await request('/api/bench/runs', 'OPTIONS', undefined, {
        origin: 'null',
        'X-Mini-Bench-Token': ''
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, X-Mini-Bench-Token');
    expect((await request('/api/bench/runs', 'OPTIONS', undefined, { origin: 'https://evil.example' })).status).toBe(403);
});
test('strict JSON rejects duplicates, nonfinite, arrays, invalid UTF8, absent or oversized body', async () => {
    const { request, handler, execution } = fixture();
    for (const body of ['[]', '{', '{"x":NaN}', '{"x":1,"x":2}', '{"x":1e999}'])
        expect((await request('/api/bench/runs', 'POST', body)).status).toBe(400);
    for (const headers of [
        { 'Content-Type': 'text/plain' },
        { 'Content-Length': String(MAX_BODY + 1) },
        { 'Content-Length': '-1' },
        { 'Content-Length': 'invalid' },
        { 'Transfer-Encoding': 'chunked' }
    ])
        expect((await request('/api/bench/runs', 'POST', '{}', headers)).status).toBe(400);
    const response = await handler(
        new Request('http://localhost/api/bench/runs', {
            method: 'POST',
            headers: {
                host: 'localhost',
                'X-Mini-Bench-Token': TOKEN,
                'Content-Type': 'application/json',
                'Content-Length': '1'
            },
            body: new Uint8Array([255])
        })
    );
    expect(response.status).toBe(400);
    expect((await request('/api/bench/runs', 'POST')).status).toBe(400);
    expect(execution.list_runs()).toEqual([]);
});
test('integer request fields retain JSON lexical type and explicit null is not a default', async () => {
    const { request, execution } = fixture();
    const target = '"targets":[{"route_id":"route-a","thinking":"high"}],"task_ids":["K23_HTTP_Conditional_Cache_Precedence"]';
    for (const field of [
        '"rounds":1.0',
        '"rounds":1e0',
        '"concurrency":1.0',
        '"limits":{"max_requests":1.0}',
        '"limits":{"max_turns":1e0}',
        '"limits":{"timeout":1.2e2}',
        '"rounds":null',
        '"concurrency":null',
        '"limits":null',
        '"bank_version":null'
    ]) {
        const response = await request('/api/bench/plans', 'POST', '{' + target + ',' + field + '}');
        expect(response.status).toBe(400);
    }
    for (const value of [
        '{"targets":[{"route_id":"route-a","thinking":null}]}',
        '{"targets":[{"route_id":"route-a","id":null}]}',
        '{"targets":[{"route_id":"route-a","thinking":"high"}],"task_ids":null}'
    ]) {
        expect((await request('/api/bench/plans', 'POST', value)).status).toBe(400);
    }
    expect(execution.list_runs()).toEqual([]);
});

test('retired API endpoints remain nonexistent', async () => {
    const { request, execution } = fixture();
    for (const path of [
        '/api/questions',
        '/api/questions?version=1.0',
        '/api/runs',
        '/api/baselines',
        '/api/observations',
        '/api/runs/' + RUN_ID,
        '/api/runs/' + RUN_ID + '/matches',
        '/api/runs/' + RUN_ID + '/reconcile'
    ])
        for (const method of ['GET', 'POST', 'PUT'])
            expect((await request(path, method, method === 'GET' ? undefined : {})).status).toBe(404);
    expect(execution.list_runs()).toHaveLength(0);
});
test('banks, routes, plan, durable run and cancel API shapes', async () => {
    const { request, execution } = fixture();
    const banks = (await (await request('/api/bench/banks')).json()) as {
        banks: Array<{ title: string; tasks: unknown[] }>;
    };
    expect(banks.banks[0]!.tasks).toHaveLength(12);
    expect(banks.banks[0]!.title).toBe('Mini Bench');
    expect(await (await request('/api/bench/routes')).json()).toEqual({
        routes: [{ id: 'route-a', model: 'test-model' }]
    });
    const plan = { targets: [{ route_id: 'route-a', thinking: 'high' }], task_ids: ['K23_HTTP_Conditional_Cache_Precedence'] };
    expect((await request('/api/bench/plans', 'POST', plan)).status).toBe(200);
    const started = await request('/api/bench/runs', 'POST', plan);
    expect(started.status).toBe(202);
    const { id } = (await started.json()) as { id: string };
    await execution.wait_run(id, 3);
    const run = await request('/api/bench/runs/' + id);
    expect(run.status).toBe(200);
    expect(((await run.json()) as { status: string }).status).toBe('completed');
    expect((await request('/api/bench/runs/' + id + '/cancel', 'POST', {})).status).toBe(200);
    expect((await request('/api/bench/runs/' + RUN_ID)).status).toBe(404);
    expect((await request('/api/bench/runs/' + RUN_ID + '/cancel', 'POST', {})).status).toBe(404);
});
test('baseline input validation and missing run produce no artifact', async () => {
    const { service, request } = fixture();
    const path = '/api/bench/runs/' + RUN_ID + '/baseline';
    for (const body of [{}, { model: 'old' }, { target_id: 'a', extra: true }, { target_id: 1 }])
        expect((await request(path, 'POST', body)).status).toBe(400);
    expect((await request(path, 'POST', { target_id: 'a' })).status).toBe(404);
    expect(service.db.list_baseline_rows()).toEqual([]);
});
test('complete target baseline roundtrip and per-task observation API', async () => {
    const { service, execution, request, directory } = fixture();
    const id = await execution.start_run({
        targets: [{ id: 'target-a', route_id: 'route-a', thinking: 'high' }]
    });
    await execution.wait_run(id, 4);
    const run = execution.get_run(id)!;
    for (const sample of run.samples) {
        const task = run.plan.task_snapshots.find(task => task.id === sample.task)!;
        const { max_output_tokens, max_turns, max_tool_calls, timeout, max_api_retries, timeout_scope } = run.plan.limits;
        const config = {
            max_output_tokens,
            max_turns,
            max_tool_calls,
            timeout,
            max_api_retries,
            ...(timeout_scope ? { timeout_scope } : {})
        };
        const { execution_protocol: protocol, assessment_protocol_sha256 } = assessment_sample_protocol(
            task as { id: string; [key: string]: unknown },
            sample.thinking,
            config,
            false
        );
        Object.assign(sample, {
            status: 'completed',
            ok: true,
            execution_protocol: protocol,
            execution_protocol_sha256: execution_protocol_hash(protocol),
            assessment_protocol_sha256,
            grade: { content_score: 1, instruction_checks: { format: true }, outcome: 'correct' }
        });
    }
    run.status = 'completed';
    execution._persist(run);
    const response = await request('/api/bench/runs/' + id + '/baseline', 'POST', { target_id: 'target-a' });
    expect(response.status).toBe(201);
    const { baseline } = (await response.json()) as { baseline: AssessmentBaseline };
    expect(baseline.schema).toBe('assessment-baseline-v1');
    expect(baseline.samples).toHaveLength(12);
    expect(service.db.list_baseline_rows()).toHaveLength(1);
    expect(statSync(join(directory, 'mini-bench.sqlite')).mode & 0o777).toBe(0o600);
    expect(service.baselines()).toContainEqual(baseline);
    const observations = (await (await request('/api/bench/observations')).json()) as {
        observations: Array<Record<string, unknown>>;
    };
    const personal = observations.observations.find(row => row.source === 'run' && row.run_id === id)!;
    expect(personal.baseline_eligible).toBe(true);
    expect(personal.tasks).toHaveLength(12);
    const restored = new BenchService({ data_dir: directory, token: TOKEN });
    try {
        expect(restored.baselines()).toContainEqual(baseline);
    } finally {
        await restored.close();
    }
});
test('old user storage remains untouched and unconsumed', async () => {
    const { directory, service } = fixture();
    const files = {
        'questions.json': 'old questions',
        'runs/old.json': '{"status":"running"}',
        'baselines/old.json': '{"id":"old-baseline"}'
    };
    for (const [path, value] of Object.entries(files)) {
        const location = join(directory, path);
        mkdirSync(join(location, '..'), { recursive: true });
        writeFileSync(location, value);
    }
    service.baselines();
    for (const [path, value] of Object.entries(files)) expect(readFileSync(join(directory, path), 'utf8')).toBe(value);
    expect('jobs' in service).toBe(false);
    expect('questions' in service).toBe(false);
});
test('catalog reads coalesce and defensive copies cannot poison cache', async () => {
    const { service, adapter, request } = fixture();
    let calls = 0;
    adapter.gateway = async () => {
        calls++;
        await Promise.resolve();
        return { data: [{ id: 'model', reasoning_levels: ['high'] }, null, {}] };
    };
    const [first, second] = await Promise.all([service.models(), service.models()]);
    (first[0]!.reasoning_levels as string[]).push('forged');
    expect(second).toEqual([{ id: 'model', reasoning_levels: ['high'] }]);
    expect(await service.models()).toEqual(second);
    expect(calls).toBe(1);
    adapter._models_cache_time -= 61;
    await service.models();
    expect(calls).toBe(2);
    expect((await request('/api/models')).status).toBe(200);
    expect(calls).toBe(2);
});
test('catalog handshake requests remote-hop evidence and filters non-chat models', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mini-bench-remote-catalog-'));
    let requests = 0;
    const gateway = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request) {
            requests++;
            expect(request.method).toBe('GET');
            expect(new URL(request.url).pathname).toBe('/v1/models');
            expect(request.headers.get('X-Magpie-Drawers')).toBe('1');
            expect(request.headers.get('Authorization')).toBe('Bearer fixture-key');
            return Response.json({
                data: [
                    { id: 'office/openai/model', owned_by: 'office', magpie_via: ['remote-hop', 'local-hop'] },
                    { id: 'chat', kind: 'chat' },
                    { id: 'image', kind: 'image' },
                    { id: 'video', kind: 'video' },
                    { id: 'decision', kind: 'decision' },
                    { id: 'future-kind', kind: 'unknown' }
                ]
            });
        }
    });
    const service = new BenchService({
        token: TOKEN,
        data_dir: directory,
        adapter: new MagpieBenchAdapter(`http://127.0.0.1:${gateway.port}/v1`, 'fixture-key')
    });
    cleanups.push(async () => {
        await service.close();
        await gateway.stop();
        rmSync(directory, { recursive: true, force: true });
    });
    const catalog = await service.models();
    expect(catalog.map(model => model.id)).toEqual(['office/openai/model', 'chat']);
    expect(catalog[0]!.magpie_via).toEqual(['remote-hop', 'local-hop']);
    (catalog[0]!.magpie_via as string[]).push('caller-mutation');
    expect((await service.models())[0]!.magpie_via).toEqual(['remote-hop', 'local-hop']);
    expect(requests).toBe(1);
});

test('invalid catalog is not cached and can recover', async () => {
    const { service, adapter } = fixture();
    adapter.gateway = async () => ({ data: {} });
    await expect(service.models()).rejects.toThrow('models list');
    expect(adapter._models_cache).toBeNull();
    adapter.gateway = async () => ({ models: [{ id: 'recovered' }] });
    expect(await service.models()).toEqual([{ id: 'recovered' }]);
});
test('close prevents lazy initialization and submission', async () => {
    const { service, adapter, request } = fixture();
    await service.close();
    expect(() => service.bench_execution()).toThrow('closed');
    expect((await request('/api/bench/runs')).status).toBe(503);
});
test('failed initial persistence returns safe storage error then closes admission', async () => {
    const { execution, request } = fixture();
    execution._persist = () => {
        throw Object.assign(new Error('private-storage-details'), { code: 'EIO' });
    };
    const body = { targets: [{ route_id: 'route-a', thinking: 'high' }], task_ids: ['K23_HTTP_Conditional_Cache_Precedence'] };
    const failed = await request('/api/bench/runs', 'POST', body);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'storage error' });
    const rejected = await request('/api/bench/runs', 'POST', body);
    expect(rejected.status).toBe(503);
    expect(await rejected.text()).not.toContain('private-storage-details');
    expect(execution._active).toBe(0);
});

test('task API plans independent whole-bank runs, persists membership and cancels children', async () => {
    const { request, execution } = fixture();
    const body = {
        targets: [
            { id: 'low', route_id: 'route-a', thinking: 'low' },
            { id: 'high', route_id: 'route-a', thinking: 'high' }
        ]
    };
    const planned = await request('/api/bench/task-plans', 'POST', body);
    expect(planned.status).toBe(200);
    const plan = await planned.json();
    expect(plan.run_count).toBe(2);
    expect(plan.samples_per_run).toBe(36);
    expect(plan.sample_count).toBe(72);
    expect(plan.sample_concurrency).toBe(6);
    expect(plan.run_concurrency).toBe(3);
    expect(plan.total_max_cost_usd).toBeNull();
    expect(plan.limits.max_cost_usd).toBeNull();
    expect(plan.limits.max_api_retries).toBe(3);
    expect(execution.list_runs()).toEqual([]);
    const started = await request('/api/bench/tasks', 'POST', body);
    expect(started.status).toBe(202);
    const { id } = await started.json();
    const task = await (await request('/api/bench/tasks/' + id)).json();
    expect(task.children).toHaveLength(2);
    const listed = (await (await request('/api/bench/tasks')).json()).tasks;
    expect(listed).toHaveLength(1);
    // Polling summaries drop frozen provenance; the detail endpoint keeps the complete plan.
    expect(listed[0].plan).not.toHaveProperty('task_snapshots');
    expect(listed[0].plan.provenance_omitted).toBe(true);
    expect(listed[0].plan.targets).toHaveLength(2);
    expect(task.plan.task_snapshots).toHaveLength(12);
    for (const child of task.children) {
        const run = await (await request('/api/bench/runs/' + child.run_id)).json();
        expect(run.task_id).toBe(id);
        expect(run.plan.targets).toHaveLength(1);
        expect(run.samples).toHaveLength(36);
    }
    expect((await request('/api/bench/tasks/' + id + '/cancel', 'POST')).status).toBe(200);
    await Promise.all(task.children.map((child: { run_id: string }) => execution.wait_for_run(child.run_id)));
    expect(execution.get_task(id)?.status).toBe('cancelled');
    for (const path of ['/api/bench/tasks/' + RUN_ID, '/api/bench/tasks/' + RUN_ID + '/cancel'])
        expect((await request(path, path.endsWith('/cancel') ? 'POST' : 'GET')).status).toBe(404);
});

test('task API preserves authentication and strict JSON before admission', async () => {
    const { request, execution } = fixture();
    for (const path of ['/api/bench/task-plans', '/api/bench/tasks']) {
        expect((await request(path, 'POST', {}, { 'X-Mini-Bench-Token': '' })).status).toBe(403);
        expect((await request(path, 'POST', {}, { origin: 'https://evil.example' })).status).toBe(403);
        for (const body of ['[]', '{', '{"rounds":3,"rounds":2}', '{"sample_concurrency":NaN}'])
            expect((await request(path, 'POST', body)).status).toBe(400);
        expect((await request(path, 'POST', { targets: [{ route_id: 'route-a', thinking: 'high' }], task_ids: ['bayes'] })).status).toBe(
            400
        );
    }
    expect(execution.list_runs()).toEqual([]);
    expect(execution.list_tasks()).toEqual([]);
});

test('invalid startup token and concurrency fail before serving', () => {
    expect(() => new BenchService({ token: 'short' })).toThrow('TOKEN');
    const old = process.env.MAGPIE_BENCH_CONCURRENCY;
    try {
        for (const value of ['0', '65', 'invalid']) {
            process.env.MAGPIE_BENCH_CONCURRENCY = value;
            expect(() => new BenchService({ token: TOKEN })).toThrow('CONCURRENCY');
        }
    } finally {
        if (old === undefined) delete process.env.MAGPIE_BENCH_CONCURRENCY;
        else process.env.MAGPIE_BENCH_CONCURRENCY = old;
    }
});
test('explicit missing routes never silently fall back to gateway models', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mini-bench-explicit-routes-'));
    const previous = process.env.MAGPIE_BENCH_ROUTES_FILE;
    process.env.MAGPIE_BENCH_ROUTES_FILE = join(directory, 'absent.json');
    const service = new BenchService({ token: TOKEN, data_dir: directory });
    let catalogCalls = 0;
    service.models = async () => {
        catalogCalls++;
        return [];
    };
    try {
        const execution = service.bench_execution();
        expect(await execution.routes.public_routes()).toEqual([]);
        await expect(execution.plan({ targets: [{ route_id: 'missing', thinking: 'high' }] })).rejects.toThrow('not configured');
        expect(execution.list_runs()).toEqual([]);
        expect(catalogCalls).toBe(0);
        expect(readdirSync(directory)).not.toContain('absent.json');
    } finally {
        await service.close();
        if (previous === undefined) delete process.env.MAGPIE_BENCH_ROUTES_FILE;
        else process.env.MAGPIE_BENCH_ROUTES_FILE = previous;
        rmSync(directory, { recursive: true, force: true });
    }
});

test('safe assets cannot escape via symlink and unknown suffixes are not served', async () => {
    const { directory, service } = fixture();
    const web = join(directory, 'web');
    mkdirSync(web);
    writeFileSync(join(web, 'index.html'), '<h1>local</h1>');
    writeFileSync(join(directory, 'private.js'), 'secret');
    symlinkSync(join(directory, 'private.js'), join(web, 'escape.js'));
    writeFileSync(join(web, 'private.json'), 'secret');
    const handler = make_handler(service, web);
    const call = (path: string) => handler(new Request('http://localhost' + path, { headers: { host: 'localhost' } }));
    expect((await call('/')).status).toBe(200);
    expect((await call('/escape.js')).status).toBe(404);
    expect((await call('/private.json')).status).toBe(404);
    expect((await call('/%2e%2e/private.js')).status).toBe(404);
});
test('real Bun server binds random loopback port and serves without subprocesses', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mini-bench-live-http-'));
    const running = await startMiniBenchService({ port: 0, token: TOKEN, data_dir: directory });
    try {
        expect(running.port).toBeGreaterThan(0);
        const response = await fetch('http://127.0.0.1:' + running.port + '/api/bench/banks', {
            headers: { 'X-Mini-Bench-Token': TOKEN, Origin: 'null' }
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('null');
        expect(((await response.json()) as { banks: Array<{ version: string }> }).banks.map(b => b.version)).toEqual(['2.0', '1.0']);
    } finally {
        await running.stop();
        await running.stop();
        rmSync(directory, { recursive: true, force: true });
    }
});
test('gateway redirect never forwards credentials or leaks provider exception bodies', async () => {
    const { service, adapter } = fixture();
    let targetCalls = 0;
    const target = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () => {
            targetCalls++;
            return Response.json({ data: [] });
        }
    });
    const redirect = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () =>
            new Response('secret-provider-body', {
                status: 302,
                headers: { Location: 'http://127.0.0.1:' + target.port + '/capture' }
            })
    });
    const local = new BenchService({
        token: TOKEN,
        data_dir: service.data_dir,
        adapter: new MagpieBenchAdapter('http://127.0.0.1:' + redirect.port, 'private-provider-key')
    });
    try {
        await expect(local.models()).rejects.toThrow('gateway HTTP error 302');
        expect(targetCalls).toBe(0);
    } finally {
        await local.close();
        await redirect.stop();
        await target.stop();
    }
});

test('run call diagnosis is authenticated, read-only and limited to known runs', async () => {
    const { service, request } = fixture();
    const execution = service.bench_execution();
    expect((await request('/api/bench/runs/' + RUN_ID + '/calls', 'GET', undefined, { 'X-Mini-Bench-Token': '' })).status).toBe(403);
    expect((await request('/api/bench/runs/' + RUN_ID + '/calls')).status).toBe(404);
    service.db.save_run({
        id: RUN_ID,
        status: 'failed',
        created_at: '2026-11-22T00:00:00.000Z',
        updated_at: '2026-11-22T00:00:00.000Z',
        stop_reason: 'api_failure',
        plan: {
            bank_version: '1.0',
            bank_scope: 'subset',
            bank_snapshot: {},
            targets: [],
            task_ids: [],
            task_snapshots: [],
            rounds: 1,
            limits: { timeout: 60 },
            source_sha256: {},
            sample_count: 1
        },
        samples: [],
        budget: {}
    });
    service.db.insert_session_event({
        run_id: RUN_ID,
        sample_id: 's',
        attempt_id: 'att-1',
        seq: 1,
        kind: 'llm_turn',
        call_id: 'c',
        http_status: 502,
        usage_known: false,
        payload: { raw_error_excerpt: 'bad gateway' }
    });
    execution.has_run = id => id === RUN_ID;
    const response = await request('/api/bench/runs/' + RUN_ID + '/calls');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.calls).toHaveLength(1);
    expect(body.calls[0]).toMatchObject({ call_id: 'c', http_status: 502 });
    expect(JSON.stringify(body)).not.toContain('bad gateway');
    expect((await request('/api/bench/runs/' + RUN_ID + '/calls', 'POST', {})).status).toBe(404);
});

test('sample session events endpoint is authenticated, read-only, and scoped by sample_id and optional attempt_id', async () => {
    const { service, request } = fixture();
    const execution = service.bench_execution();
    expect(
        (await request('/api/bench/runs/' + RUN_ID + '/events?sample_id=s1', 'GET', undefined, { 'X-Mini-Bench-Token': '' })).status
    ).toBe(403);
    expect((await request('/api/bench/runs/' + RUN_ID + '/events?sample_id=s1')).status).toBe(404);
    service.db.save_run({
        id: RUN_ID,
        status: 'completed',
        created_at: '2026-11-22T00:00:00.000Z',
        updated_at: '2026-11-22T00:00:00.000Z',
        stop_reason: null,
        plan: {
            bank_version: '1.0',
            bank_scope: 'subset',
            bank_snapshot: {},
            targets: [],
            task_ids: [],
            task_snapshots: [],
            rounds: 1,
            limits: { timeout: 60 },
            source_sha256: {},
            sample_count: 2
        },
        samples: [],
        budget: {}
    });
    service.db.insert_session_events_batch([
        {
            run_id: RUN_ID,
            sample_id: 's1',
            attempt_id: 'att-1',
            seq: 1,
            kind: 'llm_turn',
            call_id: 'c1',
            turn: 1,
            http_status: 200,
            elapsed_seconds: 1.5,
            usage_known: true,
            input_tokens: 100,
            output_tokens: 40,
            response_status: 'completed',
            payload: {
                reasoning_summary: ['check inputs'],
                assistant_text: 'Calling tool',
                tool_calls: [{ call_id: 'tc-1', name: 'submit_answer', arguments: '{"a":1}' }]
            }
        },
        {
            run_id: RUN_ID,
            sample_id: 's1',
            attempt_id: 'att-1',
            seq: 2,
            kind: 'tool_result',
            call_id: 'tc-1',
            payload: { name: 'submit_answer', result: { accepted: true } }
        },
        {
            run_id: RUN_ID,
            sample_id: 's1',
            attempt_id: 'att-2',
            seq: 1,
            kind: 'llm_turn',
            call_id: 'c2',
            turn: 1,
            http_status: 429,
            error_code: 'rate_limit_exceeded',
            payload: { raw_error_excerpt: 'too many requests' }
        },
        {
            run_id: RUN_ID,
            sample_id: 's2',
            attempt_id: 'att-other',
            seq: 1,
            kind: 'llm_turn',
            call_id: 'c3',
            http_status: 200,
            payload: { assistant_text: 'other sample' }
        }
    ]);
    execution.has_run = id => id === RUN_ID;
    expect((await request('/api/bench/runs/' + RUN_ID + '/events')).status).toBe(400);
    expect((await request('/api/bench/runs/' + RUN_ID + '/events?sample_id=')).status).toBe(400);

    const allS1 = await request('/api/bench/runs/' + RUN_ID + '/events?sample_id=s1');
    expect(allS1.status).toBe(200);
    const bodyAll = await allS1.json();
    expect(bodyAll.sample_id).toBe('s1');
    expect(bodyAll.events).toHaveLength(3);
    expect(bodyAll.events.map((e: { kind: string }) => e.kind)).toEqual(['llm_turn', 'tool_result', 'llm_turn']);
    expect(bodyAll.events[0].payload.reasoning_summary).toEqual(['check inputs']);
    expect(bodyAll.events[1].payload.result).toEqual({ accepted: true });
    expect(JSON.stringify(bodyAll)).not.toContain('other sample');

    const att2Only = await request('/api/bench/runs/' + RUN_ID + '/events?sample_id=s1&attempt_id=att-2');
    expect(att2Only.status).toBe(200);
    const bodyAtt2 = await att2Only.json();
    expect(bodyAtt2.events).toHaveLength(1);
    expect(bodyAtt2.events[0]).toMatchObject({ attempt_id: 'att-2', http_status: 429, error_code: 'rate_limit_exceeded' });
    expect(bodyAtt2.events[0].payload.raw_error_excerpt).toBe('too many requests');

    expect((await request('/api/bench/runs/' + RUN_ID + '/events?sample_id=s1', 'POST', {})).status).toBe(404);
});

test('large JSON responses are gzip-encoded and unchanged observations are not resent', async () => {
    const { request } = fixture();
    const plain = await request('/api/bench/banks', 'GET', undefined, { 'Accept-Encoding': 'identity' });
    expect(plain.headers.get('content-encoding')).toBeNull();
    const zipped = await request('/api/bench/banks', 'GET', undefined, { 'Accept-Encoding': 'gzip, deflate' });
    expect(zipped.headers.get('content-encoding')).toBe('gzip');
    expect(zipped.headers.get('vary')).toContain('Accept-Encoding');
    // Browsers decode transparently; the decoded JSON is identical to the plain body.
    const decoded = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await zipped.arrayBuffer())));
    expect(JSON.parse(decoded)).toEqual(await plain.json());
    const first = await (await request('/api/bench/observations')).json();
    expect(first.etag).toMatch(/^[0-9a-f]{32}$/);
    expect(Array.isArray(first.observations)).toBe(true);
    expect(await (await request('/api/bench/observations?known=' + first.etag)).json()).toEqual({ etag: first.etag, unchanged: true });
    expect((await (await request('/api/bench/observations?known=stale')).json()).observations).toEqual(first.observations);
});

test('task and run detail endpoints support omit_provenance=1 and cache terminal runs with invalidation', async () => {
    const { service, request } = fixture();
    // Seed one terminal task and child run directly in SQLite before bench_execution() loads the index.
    const runId = 'a'.repeat(32);
    const taskId = 'b'.repeat(32);
    const bankSnapshot = { version: '1.0', title: 'Mini Bench', large_payload: 'x'.repeat(4000) };
    const taskSnapshots = [{ id: 't1', prompt: 'y'.repeat(4000) }];
    const sourceSha256 = { 'src/assessment_tasks.ts': 'c'.repeat(64) };
    const basePlan = {
        bank_version: '1.0',
        bank_scope: 'subset',
        bank_snapshot: bankSnapshot,
        targets: [
            {
                target_id: 'route-cache:high',
                route_id: 'route-cache',
                provider: 'Demo',
                provider_id: 'demo',
                account_ref: 'main',
                account_evidence: 'explicit_route',
                model: 'demo-model',
                thinking: 'high'
            }
        ],
        task_ids: ['t1'],
        task_snapshots: taskSnapshots,
        rounds: 1,
        limits: { timeout: 600, timeout_scope: 'sample', max_api_retries: 3 },
        source_sha256: sourceSha256,
        sample_count: 1
    };
    service.db.save_run({
        id: runId,
        task_id: taskId,
        status: 'completed',
        created_at: '2026-11-22T00:00:00.000Z',
        updated_at: '2026-11-22T00:01:00.000Z',
        stop_reason: null,
        plan: basePlan,
        samples: [
            {
                sample_id: 's1',
                attempt_id: 'att-1',
                run_id: runId,
                target_id: 'route-cache:high',
                route_id: 'route-cache',
                account_ref: 'main',
                account_evidence: 'explicit_route',
                task: 't1',
                model: 'demo-model',
                thinking: 'high',
                round: 1,
                status: 'completed',
                grade: { content_score: 1 },
                text: 'ok '.repeat(900)
            }
        ],
        budget: { requests: 1 }
    });
    service.db.save_task({
        id: taskId,
        status: 'completed',
        created_at: '2026-11-22T00:00:00.000Z',
        updated_at: '2026-11-22T00:01:00.000Z',
        stop_reason: null,
        plan: {
            ...basePlan,
            sample_concurrency: 6,
            run_concurrency: 3,
            run_count: 1,
            samples_per_run: 1,
            total_max_cost_usd: null
        },
        child_run_ids: [runId]
    });
    // Reload execution index from the seeded SQLite rows.
    service._bench_execution = undefined;

    // Default endpoints retain full provenance.
    const fullTaskResp = await request(`/api/bench/tasks/${taskId}`);
    expect(fullTaskResp.status).toBe(200);
    const fullTask = await fullTaskResp.json();
    expect(fullTask.plan.bank_snapshot).toEqual(bankSnapshot);
    expect(fullTask.plan.task_snapshots).toEqual(taskSnapshots);
    expect(fullTask.plan.source_sha256).toEqual(sourceSha256);

    const fullRunResp = await request(`/api/bench/runs/${runId}`);
    expect(fullRunResp.status).toBe(200);
    const fullRun = await fullRunResp.json();
    expect(fullRun.plan.bank_snapshot).toEqual(bankSnapshot);
    expect(fullRun.plan.task_snapshots).toEqual(taskSnapshots);
    expect(fullRun.plan.source_sha256).toEqual(sourceSha256);

    // omit_provenance=1 strips immutable provenance snapshots while keeping samples and children.
    const slimTask = await (await request(`/api/bench/tasks/${taskId}?omit_provenance=1`)).json();
    expect(slimTask.plan.provenance_omitted).toBe(true);
    expect(slimTask.plan.bank_snapshot).toBeUndefined();
    expect(slimTask.plan.task_snapshots).toBeUndefined();
    expect(slimTask.plan.source_sha256).toBeUndefined();
    expect(slimTask.children).toHaveLength(1);

    let loadCalls = 0;
    const origLoadRun = service.db.load_run.bind(service.db);
    service.db.load_run = (...args: Parameters<typeof service.db.load_run>) => {
        loadCalls++;
        return origLoadRun(...args);
    };

    const slimRunResp1 = await request(`/api/bench/runs/${runId}?omit_provenance=1`, 'GET', undefined, {
        'Accept-Encoding': 'gzip'
    });
    expect(slimRunResp1.headers.get('content-encoding')).toBe('gzip');
    const slimRun1 = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await slimRunResp1.arrayBuffer()))));
    expect(slimRun1.plan.provenance_omitted).toBe(true);
    expect(slimRun1.plan.bank_snapshot).toBeUndefined();
    expect(slimRun1.plan.task_snapshots).toBeUndefined();
    expect(slimRun1.plan.source_sha256).toBeUndefined();
    expect(slimRun1.samples).toHaveLength(1);
    expect(loadCalls).toBe(1);

    // Second request for the unchanged terminal run hits the server-side cache without touching SQLite.
    const slimRunResp2 = await request(`/api/bench/runs/${runId}?omit_provenance=1`, 'GET', undefined, {
        'Accept-Encoding': 'gzip'
    });
    expect(slimRunResp2.headers.get('content-encoding')).toBe('gzip');
    const slimRun2 = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await slimRunResp2.arrayBuffer()))));
    expect(slimRun2).toEqual(slimRun1);
    expect(loadCalls).toBe(1);

    // Updating the terminal run's timestamp invalidates the server-side cache on the next read.
    service.db.db.run('UPDATE runs SET updated_at = ? WHERE id = ?', ['2026-11-22T00:05:00.000Z', runId]);
    service._bench_execution = undefined;
    const slimRunResp3 = await request(`/api/bench/runs/${runId}?omit_provenance=1`, 'GET', undefined, {
        'Accept-Encoding': 'gzip'
    });
    const slimRun3 = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await slimRunResp3.arrayBuffer()))));
    expect(slimRun3.updated_at).toBe('2026-11-22T00:05:00.000Z');
    expect(loadCalls).toBeGreaterThan(1);
});

test('task and run baseline summaries, batch promotion, and baseline deletion preserve underlying runs', async () => {
    const { service, execution, request } = fixture();
    const taskId = await execution.start_task({
        bank_version: '1.0',
        targets: [
            { id: 'target-a', route_id: 'route-a', thinking: 'high' },
            { id: 'target-b', route_id: 'route-a', thinking: 'low' },
            { id: 'target-c', route_id: 'route-a', thinking: 'default' }
        ],
        rounds: 1,
        sample_concurrency: 6,
        run_concurrency: 3,
        limits: {
            timeout: 600,
            timeout_scope: 'sample',
            max_requests: null,
            max_output_tokens: null,
            max_cost_usd: null,
            max_turns: null,
            max_tool_calls: null,
            max_api_retries: 3
        }
    });
    const initialTask = execution.get_task(taskId)!;
    const childIds = initialTask.child_run_ids as string[];
    for (const childId of childIds) await execution.wait_run(childId, 4);

    // Make child 0 and child 1 baseline-eligible; keep child 2 ineligible (failed sample).
    for (const [index, childId] of childIds.entries()) {
        const run = execution.get_run(childId)!;
        const { max_output_tokens, max_turns, max_tool_calls, timeout, max_api_retries, timeout_scope } = run.plan.limits;
        const config = {
            max_output_tokens,
            max_turns,
            max_tool_calls,
            timeout,
            max_api_retries,
            ...(timeout_scope ? { timeout_scope } : {})
        };
        for (const [sampleIdx, sample] of run.samples.entries()) {
            const card = run.plan.task_snapshots.find(item => item.id === sample.task)!;
            const { execution_protocol: protocol, assessment_protocol_sha256 } = assessment_sample_protocol(
                card as { id: string; [key: string]: unknown },
                sample.thinking,
                config,
                false
            );
            const failed = index === 2 && sampleIdx === 0;
            Object.assign(sample, {
                status: failed ? 'api_failure' : 'completed',
                ok: !failed,
                execution_protocol: protocol,
                execution_protocol_sha256: execution_protocol_hash(protocol),
                assessment_protocol_sha256,
                grade: failed ? null : { content_score: 0.9, instruction_checks: { format: true }, outcome: 'correct' }
            });
        }
        run.status = index === 2 ? 'failed' : 'completed';
        execution._persist(run);
    }
    service._bench_execution = undefined;

    // Input validation and auth checks on batch and delete endpoints.
    expect((await request('/api/bench/baselines/batch', 'POST', { action: 'promote', items: [] })).status).toBe(400);
    expect((await request('/api/bench/baselines/batch', 'POST', { action: 'delete', ids: ['not-hex'] })).status).toBe(400);
    expect((await request('/api/bench/baselines/' + 'a'.repeat(64) + '/delete', 'POST', {}, { 'X-Mini-Bench-Token': '' })).status).toBe(
        403
    );
    expect((await request('/api/bench/baselines/' + 'a'.repeat(64) + '/delete', 'POST', {})).status).toBe(404);

    // Task list and task detail surface baseline eligibility before promotion.
    const tasksResp1 = await (await request('/api/bench/tasks')).json();
    const etagBefore = tasksResp1.etag as string;
    const childrenBefore = tasksResp1.tasks[0].children as Array<Record<string, unknown>>;
    expect(childrenBefore.map(child => [child.baseline_eligible, child.baseline_id])).toEqual([
        [true, null],
        [true, null],
        [false, null]
    ]);
    expect(typeof childrenBefore[2]!.ineligibility_reason).toBe('string');

    // Batch promote promotes eligible targets and reports ineligible ones without failing the batch.
    const batchPromoteResp = await request('/api/bench/baselines/batch', 'POST', {
        action: 'promote',
        items: [
            { run_id: childIds[0]!, target_id: 'target-a' },
            { run_id: childIds[1]!, target_id: 'target-b' },
            { run_id: childIds[2]!, target_id: 'target-c' }
        ]
    });
    expect(batchPromoteResp.status).toBe(200);
    const batchPromote = await batchPromoteResp.json();
    expect(batchPromote.created).toHaveLength(2);
    expect(batchPromote.rejected).toHaveLength(1);
    expect(batchPromote.rejected[0].run_id).toBe(childIds[2]);
    expect(service.baselines()).toHaveLength(2);

    // Task list ETag invalidates on baseline mutation so polling sees new baseline_id values.
    const tasksAfterPromote = await (await request(`/api/bench/tasks?known=${encodeURIComponent(etagBefore)}`)).json();
    expect(tasksAfterPromote.unchanged).toBeUndefined();
    expect(tasksAfterPromote.etag).not.toBe(etagBefore);
    const promotedIds = batchPromote.created.map((entry: { id: string }) => entry.id);
    expect(tasksAfterPromote.tasks[0].children.map((child: Record<string, unknown>) => child.baseline_id)).toEqual([
        promotedIds[0],
        promotedIds[1],
        null
    ]);

    const runDetailAfterPromote = await (await request(`/api/bench/runs/${childIds[0]}?omit_provenance=1`)).json();
    expect(runDetailAfterPromote.baseline_id).toBe(promotedIds[0]);
    expect(runDetailAfterPromote.baseline_eligible).toBe(true);

    // Single baseline delete removes the baseline snapshot while retaining the underlying run.
    const singleDel = await request(`/api/bench/baselines/${promotedIds[0]}/delete`, 'POST', {});
    expect(singleDel.status).toBe(200);
    expect(await singleDel.json()).toEqual({ ok: true, id: promotedIds[0] });
    expect((await request(`/api/bench/baselines/${promotedIds[0]}/delete`, 'POST', {})).status).toBe(404);
    expect(service.baselines().map(item => item.id)).toEqual([promotedIds[1]]);
    expect((await (await request(`/api/bench/runs/${childIds[0]}?omit_provenance=1`)).json()).baseline_id).toBeNull();
    expect((await (await request(`/api/bench/runs/${childIds[0]}`)).json()).samples).toHaveLength(12);

    // Batch delete removes remaining baselines cleanly.
    const batchDel = await request('/api/bench/baselines/batch', 'POST', { action: 'delete', ids: promotedIds });
    expect(batchDel.status).toBe(200);
    expect(await batchDel.json()).toEqual({ deleted: [promotedIds[1]] });
    expect(service.baselines()).toEqual([]);
    const tasksAfterDelete = await (await request('/api/bench/tasks')).json();
    expect(tasksAfterDelete.tasks[0].children.map((child: Record<string, unknown>) => child.baseline_id)).toEqual([null, null, null]);
});
