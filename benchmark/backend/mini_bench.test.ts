import { afterEach, expect, test } from 'bun:test';
import {
    mkdtempSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BenchService, make_handler, MAX_BODY, startMiniBenchService } from './mini_bench.ts';
import { BenchExecutionService, type ExecutionRoute } from '../src/bench_execution.ts';
import { target_execution_protocol, execution_protocol_hash } from '../src/run_protocol.ts';
import { assessment_hash } from '../src/assessment_json.ts';
import type { AssessmentBaseline } from '../src/assessment_baselines.ts';
import { MagpieBenchAdapter } from '../../magpie/magpie_adapter.ts';

test('quota endpoint is authenticated, read-only and strips upstream secrets', async () => {
    const { service, adapter, request } = fixture();
    const calls: string[] = [];
    adapter.gateway = async path => {
        calls.push(path);
        return { data: [{ provider:'office/codex',user:'offline@example.invalid',secret:'hidden',windows:[{name:'weekly',used:0}] }] };
    };
    expect((await request('/api/bench/quota-cards', 'GET', undefined, { 'X-Mini-Bench-Token': '' })).status).toBe(403);
    expect(calls).toEqual([]);
    const response = await request('/api/bench/quota-cards');
    const body = await response.json();
    expect(body.status).toBe('available'); expect(body.cards[0].user).toBe('offline@example.invalid');
    expect(JSON.stringify(body)).not.toContain('hidden');
    await request('/api/bench/quota-cards'); expect(calls).toHaveLength(1);
    await request('/api/bench/quota-cards?refresh=1'); expect(calls).toEqual(['/magpie/quotas/cards','/magpie/quotas/cards']);
    expect((await request('/api/bench/quota-cards', 'POST', {})).status).not.toBe(200);
    expect(calls).toHaveLength(2);
});

test('a new workspace never loads bundled test baselines or produces placeholder observations', async () => {
    const { service, request } = fixture();
    expect(service.baselines()).toEqual([]);
    expect(service.observations()).toEqual([]);
    expect(await (await request('/api/bench/baselines')).json()).toEqual({ baselines: [] });
    expect(await (await request('/api/bench/observations')).json()).toEqual({ observations: [] });
});

test('analysis reads independent evidence snapshots without building discarded history summaries', async () => {
    const {service}=fixture(), execution=service.bench_execution();
    const id=await execution.start_run({targets:[{route_id:'route-a'}],rounds:1});
    expect(await execution.wait_for_run(id,5)).toBe(true);
    const snapshots=execution.list_run_snapshots();
    expect(snapshots).toHaveLength(1);expect(snapshots[0]!.samples).toHaveLength(14);
    snapshots[0]!.samples[0]!.status='tampered';
    expect(execution.get_run(id)!.samples[0]!.status).not.toBe('tampered');
    execution.list_runs=()=>{throw new Error('Analysis must not construct discarded summaries');};
    expect(service.observations()).toHaveLength(1);
});

test('route refresh invalidates the model cache and removed routes cannot resolve', async () => {
    const { service, adapter, request } = fixture();
    service._bench_execution = undefined;
    let model = 'office/codex/old', loads = 0;
    adapter.gateway = async path => {
        expect(path).toBe('/models'); loads++;
        return { data: [{ id:model, owned_by:'office', magpie_via:['remote','local'], pricing:{prompt:0,completion:0} }] };
    };
    const first = await (await request('/api/bench/routes')).json();
    model = 'office/codex/new';
    expect((await (await request('/api/bench/routes')).json()).routes[0].model).toBe('office/codex/old');
    const refreshed = await (await request('/api/bench/routes?refresh=1')).json();
    expect(refreshed.routes[0].model).toBe(model); expect(loads).toBe(2);
    await expect(service.bench_execution().routes.resolve(first.routes[0].id)).rejects.toThrow('unavailable');
});

test('manual retry endpoints require authentication, explicit idempotency keys and supported bodies', async () => {
    const { service, request } = fixture();
    const execution = service.bench_execution(), calls: string[] = [];
    execution.retry_run = async (id, key) => { calls.push(id + ':' + key); return id; };
    execution.retry_task = async (id, key) => { calls.push(id + ':' + key); return { ids: [id], rejected: [] }; };
    const key = 'b'.repeat(32);
    expect((await request('/api/bench/runs/' + RUN_ID + '/retry', 'POST', { request_id: key }, { 'X-Mini-Bench-Token': '' })).status).toBe(403);
    expect(calls).toHaveLength(0);
    expect((await request('/api/bench/runs/' + RUN_ID + '/retry', 'POST', {})).status).toBe(400);
    expect((await request('/api/bench/tasks/' + RUN_ID + '/retry', 'POST', { request_id: key, extra: true })).status).toBe(400);
    expect((await request('/api/bench/runs/' + RUN_ID + '/retry', 'GET')).status).toBe(404);
    expect((await request('/api/bench/runs/' + RUN_ID + '/retry', 'POST', { request_id: key })).status).toBe(202);
    expect(await (await request('/api/bench/tasks/' + RUN_ID + '/retry', 'POST', { request_id: key })).json()).toEqual({ ids: [RUN_ID], rejected: [] });
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
        thinking_levels: ['high'],
        account_concurrency: 1,
        pricing: { prompt: 0, completion: 0 }
    };
    const execution = new BenchExecutionService(
        join(directory, 'assessment'),
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
        })
    );
    service._bench_execution = execution;
    const handler = make_handler(service);
    cleanups.push(async () => {
        await service.close();
        rmSync(directory, { recursive: true, force: true });
    });
    const request = (
        path: string,
        method = 'GET',
        body?: unknown,
        extra: Record<string, string | undefined> = {}
    ) => {
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
                    ...Object.fromEntries(
                        Object.entries(extra).filter(
                            (entry): entry is [string, string] => entry[1] !== undefined
                        )
                    )
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
    expect(
        (await request('/api/bench/banks', 'GET', undefined, { origin: 'http://127.0.0.1:3481' })).status
    ).toBe(200);
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
    expect(
        (await request('/api/bench/runs', 'OPTIONS', undefined, { origin: 'https://evil.example' })).status
    ).toBe(403);
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
    const target = '"targets":[{"route_id":"route-a"}],"task_ids":["R01_Stopping_Urn"]';
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
        '{"targets":[{"route_id":"route-a"}],"task_ids":null}'
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
    expect(banks.banks[0]!.tasks).toHaveLength(14);
    expect(banks.banks[0]!.title).toBe('Mini Bench');
    expect(await (await request('/api/bench/routes')).json()).toEqual({
        routes: [{ id: 'route-a', model: 'test-model' }]
    });
    const plan = { targets: [{ route_id: 'route-a' }], task_ids: ['R01_Stopping_Urn'] };
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
    const { directory, request } = fixture();
    const path = '/api/bench/runs/' + RUN_ID + '/baseline';
    for (const body of [{}, { model: 'old' }, { target_id: 'a', extra: true }, { target_id: 1 }])
        expect((await request(path, 'POST', body)).status).toBe(400);
    expect((await request(path, 'POST', { target_id: 'a' })).status).toBe(404);
    expect(readdirSync(join(directory, 'assessment-baselines'))).toEqual([]);
});
test('complete target baseline roundtrip and per-task observation API', async () => {
    const { service, execution, request, directory } = fixture();
    const id = await execution.start_run({
        targets: [{ id: 'target-a', route_id: 'route-a', thinking: 'high' }]
    });
    await execution.wait_run(id, 4);
    const run = execution._runs.get(id)!;
    for (const sample of run.samples) {
        const task = run.plan.task_snapshots.find((task) => task.id === sample.task)!;
        const { max_output_tokens, max_turns, max_tool_calls, timeout, max_api_retries, timeout_scope } = run.plan.limits;
        const config = { max_output_tokens, max_turns, max_tool_calls, timeout, max_api_retries, ...(timeout_scope ? { timeout_scope } : {}) };
        const protocol = target_execution_protocol([{ id: sample.task, ...(max_output_tokens === null ? {} : { max_output_tokens }) }], sample.thinking);
        Object.assign(sample, {
            status: 'completed',
            ok: true,
            execution_protocol: protocol,
            execution_protocol_sha256: execution_protocol_hash(protocol),
            assessment_protocol_sha256: assessment_hash({ task, config, request_protocol: protocol }),
            grade: { content_score: 1, instruction_checks: { format: true }, outcome: 'correct' }
        });
    }
    run.status = 'completed';
    const response = await request('/api/bench/runs/' + id + '/baseline', 'POST', { target_id: 'target-a' });
    expect(response.status).toBe(201);
    const { baseline } = (await response.json()) as { baseline: AssessmentBaseline };
    expect(baseline.schema).toBe('assessment-baseline-v1');
    expect(baseline.samples).toHaveLength(14);
    const files = readdirSync(join(directory, 'assessment-baselines'));
    expect(files).toHaveLength(1);
    expect(statSync(join(directory, 'assessment-baselines', files[0]!)).mode & 0o777).toBe(0o600);
    expect(service.baselines()).toContainEqual(baseline);
    const observations = (await (await request('/api/bench/observations')).json()) as {
        observations: Array<Record<string, unknown>>;
    };
    const personal = observations.observations.find((row) => row.source === 'run' && row.run_id === id)!;
    expect(personal.baseline_eligible).toBe(true);
    expect(personal.tasks).toHaveLength(14);
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
    for (const [path, value] of Object.entries(files))
        expect(readFileSync(join(directory, path), 'utf8')).toBe(value);
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
    const gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
        requests++;
        expect(request.method).toBe('GET');
        expect(new URL(request.url).pathname).toBe('/v1/models');
        expect(request.headers.get('X-Magpie-Drawers')).toBe('1');
        expect(request.headers.get('Authorization')).toBe('Bearer fixture-key');
        return Response.json({ data: [
            { id: 'office/openai/model', owned_by: 'office', magpie_via: ['remote-hop', 'local-hop'] },
            { id: 'chat', kind: 'chat' },
            { id: 'image', kind: 'image' },
            { id: 'video', kind: 'video' },
            { id: 'decision', kind: 'decision' },
            { id: 'future-kind', kind: 'unknown' }
        ] });
    } });
    const service = new BenchService({ token: TOKEN, data_dir: directory,
        adapter: new MagpieBenchAdapter(`http://127.0.0.1:${gateway.port}/v1`, 'fixture-key') });
    cleanups.push(async () => { await service.close(); await gateway.stop(); rmSync(directory, { recursive: true, force: true }); });
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
    const body = { targets: [{ route_id: 'route-a' }], task_ids: ['R01_Stopping_Urn'] };
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
    const body = { targets: [
        { id: 'default', route_id: 'route-a', thinking: 'default' },
        { id: 'high', route_id: 'route-a', thinking: 'high' }
    ] };
    const planned = await request('/api/bench/task-plans', 'POST', body);
    expect(planned.status).toBe(200);
    const plan = await planned.json();
    expect(plan.run_count).toBe(2);
    expect(plan.samples_per_run).toBe(42);
    expect(plan.sample_count).toBe(84);
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
    expect(task.plan.task_snapshots).toHaveLength(14);
    for (const child of task.children) {
        const run = await (await request('/api/bench/runs/' + child.run_id)).json();
        expect(run.task_id).toBe(id);
        expect(run.plan.targets).toHaveLength(1);
        expect(run.samples).toHaveLength(42);
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
        expect((await request(path, 'POST', { targets: [{ route_id: 'route-a' }], task_ids: ['bayes'] })).status).toBe(400);
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
        await expect(execution.plan({ targets: [{ route_id: 'missing' }] })).rejects.toThrow(
            'not configured'
        );
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
    const call = (path: string) =>
        handler(new Request('http://localhost' + path, { headers: { host: 'localhost' } }));
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
        expect(((await response.json()) as { banks: unknown[] }).banks).toHaveLength(1);
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
    execution.get_run = (id) => (id === RUN_ID ? ({ id } as never) : null);
    mkdirSync(join(execution.data_dir, RUN_ID), { recursive: true });
    writeFileSync(join(execution.data_dir, RUN_ID, 'journal.jsonl'), JSON.stringify({ type: 'call', call_id: 'c', sample_id: 's', http_status: 502, request: { input: 'secret prompt' }, raw_response: {} }) + '\n');
    const response = await request('/api/bench/runs/' + RUN_ID + '/calls');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.calls).toHaveLength(1);
    expect(body.calls[0]).toMatchObject({ call_id: 'c', http_status: 502 });
    expect(JSON.stringify(body)).not.toContain('secret prompt');
    expect((await request('/api/bench/runs/' + RUN_ID + '/calls', 'POST', {})).status).toBe(404);
});
