import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BenchDatabase } from './bench_db.ts';
import { BenchExecutionService, type ExecutionRoute, type ExecutionRoutes } from './bench_execution.ts';
import type { GatewayResponse } from './client.ts';

class FakeRoutes implements ExecutionRoutes {
    configs: Record<string, ExecutionRoute> = Object.fromEntries(
        [
            ['a', 'account-a'],
            ['b', 'account-b'],
            ['alias-a', 'account-a']
        ].map(([id, account]) => [
            id!,
            {
                id,
                label: id,
                account_ref: account!,
                base_url: 'https://' + account + '.invalid/v1',
                model: 'same-model',
                api_key: 'private-secret-' + account,
                thinking_levels: ['none', 'low', 'high'],
                pricing: { prompt: 0.000001, completion: 0.000001 },
                account_concurrency: 1
            }
        ])
    );
    resolve(id: string): ExecutionRoute {
        if (!this.configs[id]) throw new TypeError('Bench route is not configured');
        return structuredClone(this.configs[id]!);
    }
    public_routes() {
        return Object.keys(this.configs).map(id => ({ id, label: id }));
    }
}
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return { promise, resolve };
}
class FakeGateway {
    calls: Array<{ base_url: string; api_key: string; body: Record<string, unknown> }> = [];
    active = new Map<string, number>();
    maximum = new Map<string, number>();
    total_active = 0;
    total_maximum = 0;
    release = deferred();
    echo_secret = false;
    echo_tool_identifiers = false;
    fail = false;
    private waiting: Array<{ count: number; resolve: () => void }> = [];
    constructor(block = false) {
        if (!block) this.release.resolve();
    }
    wait_calls(count: number): Promise<void> {
        if (this.calls.length >= count) return Promise.resolve();
        return new Promise(resolve => {
            this.waiting.push({ count, resolve });
        });
    }
    factory = (base_url: string, api_key: string) => ({
        post_responses_stream: async (body: Record<string, unknown>): Promise<GatewayResponse> => {
            this.calls.push({ base_url, api_key, body: structuredClone(body) });
            this.active.set(api_key, (this.active.get(api_key) ?? 0) + 1);
            this.maximum.set(api_key, Math.max(this.maximum.get(api_key) ?? 0, this.active.get(api_key)!));
            this.total_active++;
            this.total_maximum = Math.max(this.total_maximum, this.total_active);
            for (const waiter of this.waiting) if (this.calls.length >= waiter.count) waiter.resolve();
            try {
                await this.release.promise;
                if (this.fail) throw new Error('secret should never be logged: ' + api_key);
                let output: unknown[];
                const isToolTask = Array.isArray(body.tools) && body.tools.length > 1;
                if (isToolTask && !(body.input as Array<Record<string, unknown>>).some(item => item.type === 'function_call_output'))
                    output = [
                        {
                            type: 'function_call',
                            call_id: this.echo_tool_identifiers ? api_key : 'wire-call',
                            name: this.echo_tool_identifiers ? api_key : 'read_document',
                            arguments: '{"doc_id":"manifest"}'
                        }
                    ];
                else {
                    let text = JSON.stringify({ ok: true });
                    if (this.echo_secret) text += '\n' + api_key + '\n' + base_url;
                    output = [{ type: 'message', content: [{ type: 'output_text', text }] }];
                }
                const response: Record<string, unknown> = {
                    status: 'completed',
                    output,
                    usage: { input_tokens: 20, output_tokens: 40 }
                };
                if (this.echo_secret) response.provider_debug = { secret: api_key, nested: [api_key], [api_key]: base_url };
                return [200, 0.001, {}, response];
            } finally {
                this.active.set(api_key, this.active.get(api_key)! - 1);
                this.total_active--;
            }
        }
    });
}
const fixtures: Array<{ directory: string; service: BenchExecutionService; gateway: FakeGateway }> = [];
function fixture(gateway = new FakeGateway(), concurrency = 4, routes = new FakeRoutes()) {
    const directory = mkdtempSync(join(tmpdir(), 'mini-bench-execution-'));
    const service = new BenchExecutionService(directory, routes, concurrency, gateway.factory);
    fixtures.push({ directory, service, gateway });
    return { directory, service, gateway, routes };
}
const request = (extra: Record<string, unknown> = {}) => ({
    targets: [{ id: 'a', route_id: 'a', thinking: 'none' }],
    task_ids: ['K23_HTTP_Conditional_Cache_Precedence'],
    ...extra
});
async function finish(service: BenchExecutionService, id: string) {
    const run = await service.wait_run(id, 4);
    expect(run).not.toBeNull();
    return run!;
}
afterEach(async () => {
    for (const item of fixtures) item.gateway.release.resolve();
    for (const item of fixtures) {
        await item.service.close();
        rmSync(item.directory, { recursive: true, force: true });
    }
    fixtures.length = 0;
});

describe('durable execution and admission (fully offline)', () => {
    test('normalized public plan preserves provenance and excludes credentials', async () => {
        const { service } = fixture();
        const plan = await service.plan(request());
        expect(plan.bank_version).toBe('1.0');
        expect(plan.sample_count).toBe(1);
        expect(plan.targets[0]!.account_evidence).toBe('configured_binding');
        expect(plan.source_sha256['src/assessment_tasks.ts']).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(plan)).not.toMatch(/private-secret|account-a\.invalid|api_key/);
        plan.targets[0]!.thinking = 'bad';
        expect((await service.plan(request())).targets[0]!.thinking).toBe('none');
    });
    test('optional interactive source hashes accompany service plans without dispatching requests', async () => {
        const { service, gateway } = fixture();
        const plan = await service.plan(request({ bank_version: '1.0', task_ids: ['T23_Adaptive_Fault_Diagnosis'] }));
        const extensions = plan.bank_snapshot.extension_sha256 as Record<string, string>;
        for (const path of ['src/assessment_interactive.ts', 'src/assessment_blackbox.ts', 'src/assessment_documents.ts']) {
            expect(plan.source_sha256[path]).toBe(extensions[path]);
        }
        expect(gateway.calls).toHaveLength(0);
    });
    test('optional catalog identity is frozen in plans and runs without inferring missing metadata', async () => {
        const { service, routes, directory } = fixture();
        Object.assign(routes.configs.a!, {
            provider_id: 'chatgpt-api-2',
            provider_evidence: 'gateway_catalog',
            model_display_name: 'Display model'
        });
        const plan = await service.plan(request());
        expect(plan.targets[0]!.provider_id).toBe('chatgpt-api-2');
        expect(plan.targets[0]!.provider_evidence).toBe('gateway_catalog');
        expect(plan.targets[0]!.model_display_name).toBe('Display model');
        expect(plan.targets[0]!.model).toBe('same-model');
        const id = await service.start_run(request());
        routes.configs.a!.provider_id = 'renamed-provider';
        const run = await finish(service, id);
        expect(run.plan.targets[0]!.provider_id).toBe('chatgpt-api-2');
        expect((service.db.load_run(id) as any).plan.targets[0].provider_id).toBe('chatgpt-api-2');
        expect(existsSync(join(directory, id))).toBe(false);
        const configured = await service.plan(request({ targets: [{ id: 'b', route_id: 'b', thinking: 'none' }] }));
        for (const key of ['provider_id', 'provider_evidence', 'model_display_name']) expect(configured.targets[0]).not.toHaveProperty(key);
        expect(JSON.stringify(run.plan)).not.toMatch(/private-secret|account-a\.invalid|api_key/);
    });
    test('rejects unsupported fields, duplicate targets and unsafe limits', async () => {
        const { service } = fixture();
        const invalid = [
            request({ unknown: 1 }),
            request({ limits: { typo: 1 } }),
            request({ rounds: true }),
            request({ rounds: 4 }),
            request({ concurrency: 5 }),
            request({ limits: { max_cost_usd: NaN } }),
            request({ limits: { max_requests: 501 } }),
            request({ task_ids: ['K01_Molecular_Facts'] }),
            request({ task_ids: [] }),
            request({ limits: { timeout: 1 } }),
            request({ targets: [{ route_id: 'missing', thinking: 'high' }] }),
            request({ targets: [{ route_id: 'a', thinking: 'ultra' }] }),
            request({ targets: [{ route_id: 'a', unknown: 1 }] }),
            request({
                targets: [
                    { id: 'x', route_id: 'a', thinking: 'high' },
                    { id: 'x', route_id: 'b', thinking: 'high' }
                ]
            }),
            request({
                targets: [
                    { id: 'x', route_id: 'a', thinking: 'high' },
                    { id: 'y', route_id: 'a', thinking: 'high' }
                ]
            })
        ];
        for (const value of invalid) await expect(service.plan(value)).rejects.toThrow();
    });
    test('same model has isolated accounts and unique sample/call identities', async () => {
        const { service, gateway, directory } = fixture(new FakeGateway(true), 2);
        const id = await service.start_run(
            request({
                targets: [
                    { id: 'A', route_id: 'a', thinking: 'high' },
                    { id: 'B', route_id: 'b', thinking: 'high' }
                ]
            })
        );
        await gateway.wait_calls(2);
        expect(gateway.total_maximum).toBe(2);
        gateway.release.resolve();
        const run = await finish(service, id);
        expect(new Set(run.samples.map(sample => sample.sample_id)).size).toBe(2);
        expect(new Set(run.samples.map(sample => sample.account_ref))).toEqual(new Set(['account-a', 'account-b']));
        expect(run.samples.every(sample => (sample.grade as { content_score: number }).content_score === 0)).toBe(true);
        const events = service.read_run_session_events(id)!;
        expect(events.length).toBeGreaterThan(0);
        expect(events.every(event => event.run_id === id && event.attempt_id)).toBe(true);
        expect(new Set(events.filter(event => event.kind === 'llm_turn').map(event => event.call_id))).toEqual(
            new Set(run.samples.flatMap(sample => sample.calls as string[]))
        );
        run.samples = [];
        expect(service.get_run(id)!.samples.length).toBe(2);
    });
    test('account limits span runs without blocking independent accounts', async () => {
        const { service, gateway } = fixture(new FakeGateway(true), 2);
        const first = await service.start_run(request({ rounds: 2 }));
        await gateway.wait_calls(1);
        const second = await service.start_run(request({ targets: [{ id: 'alias', route_id: 'alias-a', thinking: 'high' }] }));
        const third = await service.start_run(request({ targets: [{ id: 'other', route_id: 'b', thinking: 'high' }] }));
        await gateway.wait_calls(2);
        expect(service.get_run(second)!.samples[0]!.status).toBe('pending');
        gateway.release.resolve();
        await Promise.all([first, second, third].map(id => finish(service, id)));
        expect(gateway.maximum.get('private-secret-account-a')).toBe(1);
        expect(gateway.total_maximum).toBe(2);
    });
    test('per target and per run concurrency limits both hold', async () => {
        const routes = new FakeRoutes();
        routes.configs.a!.account_concurrency = 4;
        const { service, gateway } = fixture(new FakeGateway(true), 4, routes);
        const id = await service.start_run(request({ rounds: 3 }));
        await gateway.wait_calls(1);
        expect(service.get_run(id)!.samples.map(sample => sample.status)).toEqual(['running', 'pending', 'pending']);
        gateway.release.resolve();
        await finish(service, id);
        expect(gateway.maximum.get('private-secret-account-a')).toBe(1);
        const second = fixture(new FakeGateway(true));
        const id2 = await second.service.start_run(
            request({
                concurrency: 1,
                targets: [
                    { id: 'A', route_id: 'a', thinking: 'high' },
                    { id: 'B', route_id: 'b', thinking: 'high' }
                ]
            })
        );
        await second.gateway.wait_calls(1);
        expect(second.service.get_run(id2)!.samples.filter(sample => sample.status === 'running').length).toBe(1);
        second.gateway.release.resolve();
        await finish(second.service, id2);
        expect(second.gateway.total_maximum).toBe(1);
    });
    test('a route without thinking levels runs with omitted reasoning', async () => {
        const { service, gateway, routes } = fixture();
        routes.configs.a!.thinking_levels = [];
        const target = { route_id: 'a' };
        await expect(service.plan(request({ targets: [{ ...target, thinking: 'none' }] }))).rejects.toThrow(
            'Thinking level is not supported'
        );
        const run = await finish(service, await service.start_run(request({ targets: [target] })));
        expect(run.plan.targets[0]!.thinking).toBe('default');
        expect(gateway.calls).toHaveLength(1);
        expect(gateway.calls[0]!.body).not.toHaveProperty('reasoning');
    });
    test('omitted thinking is default and omits reasoning; explicit none and high remain distinct', async () => {
        const { service, gateway } = fixture();
        expect((await service.plan(request({ targets: [{ route_id: 'a' }] }))).targets[0]!.thinking).toBe('default');
        await expect(service.plan(request({ targets: [{ route_id: 'a', thinking: 'mixed' }] }))).rejects.toThrow();
        const id = await service.start_run(
            request({
                targets: ['default', 'none', 'high'].map(thinking => ({
                    id: thinking,
                    route_id: 'a',
                    thinking
                }))
            })
        );
        await finish(service, id);
        expect(gateway.calls.map(call => call.body.reasoning)).toEqual([undefined, { effort: 'none' }, { effort: 'high' }]);
    });
    test('cancellation blocks tool continuation and pending samples, preserves raw response', async () => {
        const { service, gateway, directory } = fixture(new FakeGateway(true));
        const id = await service.start_run(request({ task_ids: ['E23_Tight_Conditional_Audit'], rounds: 3 }));
        await gateway.wait_calls(1);
        expect(service.cancel_run(id)).toBe(true);
        gateway.release.resolve();
        const run = await finish(service, id);
        expect(run.status).toBe('cancelled');
        expect(gateway.calls.length).toBe(1);
        expect(new Set(run.samples.map(sample => sample.status))).toEqual(new Set(['cancelled']));
        const events = service.read_run_session_events(id)!;
        expect(events.map(event => event.kind)).toEqual(['llm_turn', 'grade']);
        expect(service.get_run('unknown')).toBeNull();
        expect(service.cancel_run('unknown')).toBe(false);
        expect(await service.wait_for_run('unknown', 0)).toBe(false);
    });
    test('tool requests use per-call budgets and retain ungraded budget failures', async () => {
        const { service } = fixture();
        const first = await finish(service, await service.start_run(request({ task_ids: ['E23_Tight_Conditional_Audit'] })));
        expect(first.samples[0]!.calls).toHaveLength(2);
        expect(first.samples[0]!.tool_trace).toHaveLength(1);
        expect((first.samples[0]!.grade as { content_score: number }).content_score).toBe(0);
        const second = await finish(
            service,
            await service.start_run(request({ task_ids: ['E23_Tight_Conditional_Audit'], limits: { max_requests: 1 } }))
        );
        expect(second.status).toBe('incomplete');
        expect(second.samples[0]!.status).toBe('budget_not_admitted');
        expect(second.samples[0]!.grade).toBeNull();
        expect(second.budget.stop_reason).toBe('request_limit');
    });
    test('optional cost preflight rejects before transport and explicit zero disables API retries', async () => {
        const { service, gateway } = fixture();
        const first = await finish(service, await service.start_run(request({ limits: { max_cost_usd: 0.000001 } })));
        expect(gateway.calls.length).toBe(0);
        expect(first.samples[0]!.status).toBe('budget_not_admitted');
        gateway.fail = true;
        const second = await finish(service, await service.start_run(request({ rounds: 1, limits: { max_api_retries: 0 } })));
        expect(gateway.calls.length).toBe(1);
        expect(second.budget.estimated_uncached_cost_usd).toBeNull();
        expect(second.budget.missing_cost_calls).toBe(1);
        expect(JSON.stringify(second)).not.toContain('private-secret');
    });
    test('provider echoes are redacted recursively including nested keys', async () => {
        const gateway = new FakeGateway();
        gateway.echo_secret = true;
        const { service } = fixture(gateway);
        const id = await service.start_run(request());
        const run = await finish(service, id);
        const eventsJson = JSON.stringify(service.read_run_session_events(id));
        expect(eventsJson).not.toMatch(/private-secret-account-a|account-a\.invalid/);
        expect(JSON.stringify(run)).not.toMatch(/private-secret-account-a|account-a\.invalid/);
        expect(eventsJson).toContain('[REDACTED]');
    });
    test('raw response text preserves numeric tokens and redacts escaped string secrets', async () => {
        const { service, gateway } = fixture(new FakeGateway(true));
        const id = await service.start_run(request());
        await gateway.wait_calls(1);
        service._runtime.get(id)!.journal.write({
            type: 'call',
            http_status: 500,
            raw_response_text: '{"secret":"\\u0070rivate-secret-account-a","usage":{"input_tokens":10.0}}'
        });
        gateway.release.resolve();
        await finish(service, id);
        const events = service.read_run_session_events(id)!;
        const source = events.find(event => typeof event.payload?.raw_error_excerpt === 'string')!.payload!.raw_error_excerpt as string;
        expect(source).toContain('"input_tokens":10.0');
        expect(source).toContain('[REDACTED]');
        expect(source).not.toContain('rivate-secret-account-a');
    });
    test('provider tool names and wire call IDs are redacted without changing management identity', async () => {
        const gateway = new FakeGateway();
        gateway.echo_tool_identifiers = true;
        const { service } = fixture(gateway);
        const id = await service.start_run(request({ task_ids: ['E23_Tight_Conditional_Audit'] }));
        const run = await finish(service, id);
        const events = service.read_run_session_events(id)!;
        const eventsJson = JSON.stringify(events);
        expect(eventsJson).not.toContain('private-secret-account-a');
        expect(JSON.stringify(run)).not.toContain('private-secret-account-a');
        const tool = events.find(event => event.kind === 'tool_result')!;
        expect(tool.payload?.name).toBe('[REDACTED]');
        expect(tool.call_id).toBe('[REDACTED]');
        expect(tool.run_id).toBe(id);
        expect(run.samples[0]!.target_id).toBe('a');
    });
    test('short secrets cannot corrupt management identities', async () => {
        const routes = new FakeRoutes();
        routes.configs.a!.api_key = 'a';
        const gateway = new FakeGateway();
        gateway.echo_secret = true;
        const { service } = fixture(gateway, 4, routes);
        const id = await service.start_run(request());
        const run = await finish(service, id),
            sample = run.samples[0]!;
        expect(run.status).toBe('completed');
        expect(sample.target_id).toBe('a');
        expect(sample.run_id).toBe(id);
        expect(sample.calls).toEqual([sample.attempt_id + ':1:1']);
        expect(sample.text).toContain('[REDACTED]');
    });
    test('round robin rotates between both runs and targets', async () => {
        const { service, gateway } = fixture(new FakeGateway(true), 1);
        const first = await service.start_run(
            request({
                targets: [
                    { id: 'first', route_id: 'a', thinking: 'low' },
                    { id: 'second', route_id: 'alias-a', thinking: 'high' }
                ],
                rounds: 2
            })
        );
        await gateway.wait_calls(1);
        const second = await service.start_run(request());
        gateway.release.resolve();
        await Promise.all([first, second].map(id => finish(service, id)));
        expect(gateway.calls.map(call => (call.body.reasoning as { effort: string }).effort)).toEqual([
            'low',
            'none',
            'high',
            'low',
            'high'
        ]);
    });
    test('all SQLite storage files are private and restart interrupts without resubmission', async () => {
        const { service, directory } = fixture();
        const id = await service.start_run(request({ rounds: 2 }));
        await finish(service, id);
        await service.close();
        expect(statSync(directory).mode & 0o777).toBe(0o700);
        expect(statSync(join(directory, 'mini-bench.sqlite')).mode & 0o777).toBe(0o600);
        // No per-run directories or copied source/*.ts trees are created.
        expect(existsSync(join(directory, id))).toBe(false);
        const db = new BenchDatabase(join(directory, 'mini-bench.sqlite'));
        try {
            const state = db.load_run(id)! as any;
            state.status = 'running';
            state.samples[0].status = 'running';
            state.samples[1].status = 'pending';
            db.save_run(state);
        } finally {
            db.close();
        }
        const gateway = new FakeGateway(),
            restored = new BenchExecutionService(directory, new FakeRoutes(), 4, gateway.factory);
        try {
            const run = restored.get_run(id)!;
            expect(run.status).toBe('interrupted');
            expect(run.samples.map(sample => sample.status)).toEqual(['interrupted', 'interrupted']);
            expect(gateway.calls).toHaveLength(0);
            expect(restored.list_runs()).toHaveLength(1);
            expect(await restored.wait_for_run(id, 0)).toBe(true);
        } finally {
            await restored.close();
        }
    });
    for (const surface of ['journal', 'persist'])
        test('storage failure in ' + surface + ' closes admission and releases slots', async () => {
            const { service, gateway } = fixture(new FakeGateway(true), 2);
            const id = await service.start_run(request({ rounds: 3 }));
            await gateway.wait_calls(1);
            const fail = () => {
                throw Object.assign(new Error('test storage failure'), { code: 'EIO' });
            };
            if (surface === 'persist') service._persist = fail;
            else service._runtime.get(id)!.journal.write = fail;
            gateway.release.resolve();
            const run = await finish(service, id);
            expect(run.status).toBe('failed');
            expect(run.stop_reason).toBe('storage_error');
            expect(service._active).toBe(0);
            expect(gateway.calls.length).toBe(1);
            await expect(service.start_run(request())).rejects.toThrow('closed');
        });
    test('active run cap and shutdown cancel everything without later requests', async () => {
        const { service, gateway } = fixture(new FakeGateway(true), 1);
        const ids: string[] = [];
        for (let index = 0; index < 10; index++) ids.push(await service.start_run(request()));
        await expect(service.start_run(request())).rejects.toThrow('At most 10');
        await service.close(false);
        gateway.release.resolve();
        await service.close();
        expect(ids.every(id => service.get_run(id)!.status === 'cancelled')).toBe(true);
        await expect(service.start_run(request())).rejects.toThrow('closed');
    });
    test('global limit permits sixteen', async () => {
        const { service } = fixture(undefined, 16);
        expect((await service.plan(request({ concurrency: 16 }))).concurrency).toBe(16);
    });
    test('unpriced route runs cleanly without max_cost_usd, records token usage with null cost, and rejects finite max_cost_usd', async () => {
        const { service, routes } = fixture();
        (routes.configs.a as any).pricing = null;
        await expect(service.plan(request({ limits: { max_cost_usd: 1 } }))).rejects.toThrow('max_cost_usd');
        const plan = await service.plan(request({ limits: { max_cost_usd: null } }));
        expect(plan.targets[0]!.pricing).toBeNull();
        const id = await service.start_run(request({ limits: { max_cost_usd: null } }));
        const run = await finish(service, id);
        expect(run.status).toBe('completed');
        expect(run.samples).toHaveLength(1);
        expect(run.samples[0]!.status).toBe('completed');
        expect(run.samples[0]!.usage).toEqual({ input_tokens: 20, output_tokens: 40 });
        expect(run.samples[0]!.estimated_uncached_cost_usd).toBeNull();
    });
    test('reloading an unpriced timed-out sample from SQLite keeps cost null instead of fabricating zero', async () => {
        const realNow = Date.now;
        let offsetMs = 0;
        Date.now = () => realNow() + offsetMs;
        const routes = new FakeRoutes();
        (routes.configs.a as any).pricing = null;
        const timeoutGateway = new FakeGateway();
        const factory = () => ({
            post_responses_stream: async (): Promise<GatewayResponse> => {
                offsetMs += 31_000;
                return [-1, 0, {}, { error: 'TimeoutError' }];
            }
        });
        const directory = mkdtempSync(join(tmpdir(), 'mini-bench-execution-'));
        const service = new BenchExecutionService(directory, routes, 4, factory);
        fixtures.push({ directory, service, gateway: timeoutGateway });
        try {
            const id = await service.start_run(
                request({
                    limits: { max_cost_usd: null, timeout: 30, timeout_scope: 'sample', max_api_retries: 0 }
                })
            );
            const run = await finish(service, id);
            expect(run.status).toBe('completed');
            expect(run.samples[0]!.runner_error).toBe('SampleTimeout');
            expect(run.samples[0]!.estimated_uncached_cost_usd).toBeNull();
            await service.close();
            const reloaded = new BenchExecutionService(directory, routes, 4, factory);
            try {
                const loaded = reloaded.get_run(id);
                expect(loaded).not.toBeNull();
                expect(loaded!.samples[0]!.runner_error).toBe('SampleTimeout');
                expect(loaded!.samples[0]!.estimated_uncached_cost_usd).toBeNull();
            } finally {
                await reloaded.close();
            }
        } finally {
            Date.now = realNow;
        }
    });
});
