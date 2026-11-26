import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BenchExecutionService, type ExecutionRoute, type ExecutionRoutes } from './bench_execution.ts';
import type { GatewayResponse } from './client.ts';
import { parseAssessmentJson } from './assessment_json.ts';

class TaskRoutes implements ExecutionRoutes {
    accountLimit = 64;
    sharedAccount = false;
    resolve(id: string): ExecutionRoute {
        if (!/^route-[0-9]+$/.test(id)) throw new TypeError('Unknown fixture route');
        return {
            id,
            label: id,
            model: id,
            account_ref: this.sharedAccount ? 'shared' : id,
            provider_id: 'provider-' + id,
            base_url: 'https://offline.invalid',
            api_key: 'never-real',
            thinking_levels: ['low', 'high', 'none'],
            account_concurrency: this.accountLimit,
            pricing: { prompt: 0, completion: 0 }
        };
    }
    public_routes() {
        return [];
    }
}
class TaskGateway {
    calls: string[] = [];
    active = 0;
    maximum = 0;
    toolCalls = false;
    journalFailed = false;
    callsAfterJournalFailure = 0;
    perModel = new Map<string, number>();
    maxPerModel = new Map<string, number>();
    private releaseGate!: () => void;
    private gate = new Promise<void>(resolve => {
        this.releaseGate = resolve;
    });
    private waiters: Array<{ count: number; done: () => void }> = [];
    release() {
        this.releaseGate();
    }
    waitCalls(count: number) {
        return this.calls.length >= count ? Promise.resolve() : new Promise<void>(done => this.waiters.push({ count, done }));
    }
    factory = () => ({
        post_responses_stream: async (body: Record<string, unknown>): Promise<GatewayResponse> => {
            const model = String(body.model);
            this.calls.push(model);
            if (this.journalFailed) this.callsAfterJournalFailure++;
            this.active++;
            this.maximum = Math.max(this.maximum, this.active);
            this.perModel.set(model, (this.perModel.get(model) ?? 0) + 1);
            this.maxPerModel.set(model, Math.max(this.maxPerModel.get(model) ?? 0, this.perModel.get(model)!));
            for (const waiter of this.waiters) if (this.calls.length >= waiter.count) waiter.done();
            await this.gate;
            this.active--;
            this.perModel.set(model, this.perModel.get(model)! - 1);
            const output =
                this.toolCalls &&
                Array.isArray(body.tools) &&
                body.tools.length > 1 &&
                !(body.input as Array<Record<string, unknown>>).some(item => item.type === 'function_call_output')
                    ? [
                          {
                              type: 'function_call',
                              call_id: 'tool-step',
                              name: (body.tools as Array<{ name: string }>)[0]!.name,
                              arguments: '{}'
                          }
                      ]
                    : [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }];
            return [200, 0.001, {}, { status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1 } }];
        }
    });
}
const fixtures: Array<{ directory: string; service: BenchExecutionService; gateway: TaskGateway }> = [];
function fixture(global = 18, routes = new TaskRoutes()) {
    const directory = mkdtempSync(join(tmpdir(), 'bench-tasks-'));
    const gateway = new TaskGateway();
    const service = new BenchExecutionService(directory, routes, global, gateway.factory);
    fixtures.push({ directory, service, gateway });
    return { directory, service, gateway, routes };
}
const request = (count = 7) => ({
    targets: Array.from({ length: count }, (_, index) => ({ route_id: 'route-' + index, thinking: 'high' }))
});
function children(service: BenchExecutionService, id: string) {
    return service.get_task(id)!.children as Array<{
        run_id: string;
        status: string;
        target: { route_id: string };
        sample_count: number;
        budget: Record<string, unknown>;
    }>;
}
async function finish(service: BenchExecutionService, id: string) {
    await Promise.all(children(service, id).map(child => service.wait_run(child.run_id, 10)));
}
afterEach(async () => {
    for (const item of fixtures) item.gateway.release();
    for (const item of fixtures) {
        await item.service.close();
        rmSync(item.directory, { recursive: true, force: true });
    }
    fixtures.length = 0;
});

test('remote namespace snapshots preserve outer owner and exact model while isolating shared route objects', async () => {
    const { service, gateway, directory, routes } = fixture();
    const source = routes.resolve('route-0');
    source.model = 'remote-instance/provider-one/exact-model';
    source.provider_id = 'remote-instance';
    source.remote_route = { namespace: 'provider-one', evidence: 'magpie_via_catalog' };
    routes.resolve = () => source; // Deliberately return the external mutable object, not a cloned registry result.
    const legacyPlan = await service.plan(request(1));
    const taskPlan = await service.plan_task(request(1));
    const id = await service.start_task(request(1));
    await gateway.waitCalls(6);
    source.remote_route.namespace = 'changed-after-admission';
    source.pricing!.prompt = 100;
    source.pricing!.completion = 100;
    source.thinking_levels.length = 0;
    source.model = 'changed-wire-model';
    source.provider_id = 'changed-owner';
    expect(legacyPlan.targets[0]!.remote_route).toEqual({ namespace: 'provider-one', evidence: 'magpie_via_catalog' });
    expect(taskPlan.targets[0]!.remote_route).toEqual(legacyPlan.targets[0]!.remote_route);
    const child = children(service, id)[0]!;
    const run = service.get_run(child.run_id)!;
    expect(run.plan.targets[0]).toMatchObject({
        provider_id: 'remote-instance',
        route_id: 'route-0',
        model: 'remote-instance/provider-one/exact-model',
        account_ref: 'route-0',
        remote_route: { namespace: 'provider-one', evidence: 'magpie_via_catalog' }
    });
    const binding = [...service._runtime.get(child.run_id)!.bindings.values()][0]!;
    expect(binding.remote_route?.namespace).toBe('provider-one');
    expect(binding.pricing).toEqual({ prompt: 0, completion: 0 });
    expect(binding.thinking_levels).toEqual(['low', 'high', 'none']);
    const persisted = service.db.load_run(child.run_id) as any;
    expect(persisted.plan.targets[0].remote_route).toEqual(legacyPlan.targets[0]!.remote_route);
    run.plan.targets[0]!.remote_route!.namespace = 'mutated-api-copy';
    expect(service.get_run(child.run_id)!.plan.targets[0]!.remote_route?.namespace).toBe('provider-one');
    gateway.release();
    await finish(service, id);
    expect(service.get_task(id)!.status).toBe('completed');
    expect(new Set(gateway.calls)).toEqual(new Set(['remote-instance/provider-one/exact-model']));
});

test('remote namespace metadata rejects malformed or unproven values from arbitrary route resolvers', async () => {
    const { service, routes, gateway } = fixture();
    const route = routes.resolve('route-0');
    routes.resolve = () => route;
    for (const value of [
        null,
        {},
        { namespace: '', evidence: 'magpie_via_catalog' },
        { namespace: 'a/b', evidence: 'magpie_via_catalog' },
        { namespace: 'x'.repeat(257), evidence: 'magpie_via_catalog' },
        { namespace: 'valid', evidence: '' },
        { namespace: 'valid', evidence: 'magpie_via_catalog', account: 'invented' }
    ]) {
        Object.assign(route, { remote_route: value });
        await expect(service.plan_task(request(1))).rejects.toThrow('Invalid remote route namespace evidence');
    }
    expect(gateway.calls).toHaveLength(0);
});

test('task defaults are 7 independent whole-bank runs, 36 samples each, per-run budgets', async () => {
    const { service, gateway } = fixture();
    const plan = await service.plan_task(request());
    expect(plan).toMatchObject({
        rounds: 3,
        sample_concurrency: 6,
        run_concurrency: 3,
        run_count: 7,
        samples_per_run: 36,
        sample_count: 252,
        bank_scope: 'whole',
        total_max_cost_usd: null
    });
    expect(plan.task_ids).toHaveLength(12);
    expect(gateway.calls).toHaveLength(0);
    expect(JSON.stringify(plan)).not.toMatch(/never-real|offline.invalid|api_key/);
    for (const invalid of [
        { ...request(), task_ids: plan.task_ids },
        { ...request(), rounds: 4 },
        { ...request(), sample_concurrency: 65 },
        { ...request(), run_concurrency: 11 },
        {
            ...request(),
            targets: [
                { route_id: 'route-0', thinking: 'high' },
                { route_id: 'route-0', thinking: 'high' }
            ]
        }
    ])
        await expect(service.plan_task(invalid)).rejects.toBeInstanceOf(TypeError);
    await expect(
        service.plan_task(parseAssessmentJson('{"targets":[{"route_id":"route-0","thinking":"high"}],"rounds":3.0}'))
    ).rejects.toBeInstanceOf(TypeError);
});

test('828 samples queue as independent runs under per-task concurrency and cancellation controls', async () => {
    const { service, gateway } = fixture(5);
    const input = { ...request(23), sample_concurrency: 2, run_concurrency: 3 };
    const plan = await service.plan_task(input);
    expect(plan).toMatchObject({ run_count: 23, samples_per_run: 36, sample_count: 828, total_max_cost_usd: null });
    expect(gateway.calls).toHaveLength(0);
    await expect(service.plan({ ...request(23), rounds: 3 })).rejects.toThrow('at most 500 samples');
    const id = await service.start_task(input);
    await gateway.waitCalls(6);
    const rows = children(service, id);
    expect(rows).toHaveLength(23);
    expect(rows.every(child => child.sample_count === 36)).toBe(true);
    expect(rows.filter(child => child.status === 'running')).toHaveLength(3);
    expect(rows.filter(child => child.status === 'queued')).toHaveLength(20);
    expect(gateway.maximum).toBe(6);
    expect([...gateway.maxPerModel.values()].every(count => count <= 2)).toBe(true);
    expect(service.cancel_task(id)).toBe(true);
    gateway.release();
    await finish(service, id);
    expect(service.get_task(id)!.status).toBe('cancelled');
    expect(children(service, id).every(child => child.status === 'cancelled')).toBe(true);
    expect(gateway.calls).toHaveLength(6);
});

test('three admitted child runs execute six simultaneous samples each; remaining runs wait', async () => {
    const { service, gateway, directory } = fixture();
    const id = await service.start_task(request());
    await gateway.waitCalls(18);
    const rows = children(service, id);
    expect(rows).toHaveLength(7);
    expect(rows.filter(child => child.status === 'running')).toHaveLength(3);
    expect(rows.filter(child => child.status === 'queued')).toHaveLength(4);
    expect(gateway.maximum).toBe(18);
    expect([...gateway.maxPerModel.values()]).toEqual([6, 6, 6]);
    for (const child of rows) {
        const run = service.get_run(child.run_id)!;
        expect(run).toMatchObject({ task_id: id, execution_kind: 'task-child-v1' });
        expect(run.samples).toHaveLength(36);
        expect(run.plan.targets).toHaveLength(1);
        expect(run.plan.source_sha256['src/bench_execution.ts']).toMatch(/^[a-f0-9]{64}$/);
        expect((service.db.load_run(child.run_id) as any).task_id).toBe(id);
    }
    expect(service.list_runs().every(run => run.task_id === id)).toBe(true);
    expect(service.cancel_task(id)).toBe(true);
    gateway.release();
    await finish(service, id);
    expect(service.get_task(id)!.status).toBe('cancelled');
    expect(children(service, id).every(child => child.status === 'cancelled')).toBe(true);
    expect(gateway.calls).toHaveLength(18);
});

test('task concurrency is controlled within the task and spreads concurrent runs across channels and models', async () => {
    const routes = new TaskRoutes();
    routes.sharedAccount = true;
    routes.accountLimit = 2;
    const { service, gateway } = fixture(4, routes);
    const targets = [0, 1, 2, 3].flatMap(channel =>
        [0, 1].flatMap(model => {
            const route_id = `route-${channel * 2 + model}`;
            return ['low', 'high', 'none'].map(thinking => ({ route_id, thinking }));
        })
    );
    const resolve = routes.resolve.bind(routes);
    routes.resolve = (id: string) => {
        const index = Number(id.split('-')[1]);
        const channel = Math.floor(index / 2);
        return {
            ...resolve(id),
            provider_id: 'homelab',
            remote_route: { namespace: `channel-${channel}`, evidence: 'magpie_via_catalog' }
        };
    };
    const id = await service.start_task({ targets, sample_concurrency: 2, run_concurrency: 3 });
    await gateway.waitCalls(6);
    const active = children(service, id).filter(child => child.status === 'running');
    expect(active).toHaveLength(3);
    // The 3 concurrent runs must spread across 3 distinct channels, not 3 thinking levels of channel-0/route-0.
    expect(new Set(active.map(child => (child.target as { remote_route?: { namespace: string } }).remote_route?.namespace)).size).toBe(3);
    expect(new Set(active.map(child => child.target.route_id)).size).toBe(3);
    expect(gateway.calls).toHaveLength(6);
    service.cancel_task(id);
    gateway.release();
    await finish(service, id);
});

test('all seven children complete independently and each request budget is not shared', async () => {
    const { service, gateway } = fixture();
    gateway.release();
    const id = await service.start_task({ ...request(), limits: { max_requests: 1 } });
    await finish(service, id);
    expect(gateway.calls).toHaveLength(7);
    expect(children(service, id).every(child => child.budget.requests === 1)).toBe(true);
    expect(service.get_task(id)!.status).toBe('incomplete');
    const successful = await service.start_task(request(2));
    await finish(service, successful);
    expect(children(service, successful).every(child => child.status === 'completed')).toBe(true);
    expect(service.get_task(successful)!.status).toBe('completed');
    expect(gateway.calls).toHaveLength(7 + 72);
});

test('user example keeps three Thinking leaves plus two accounts with two leaves as seven runs', async () => {
    const { service } = fixture();
    const targets = [
        ...['none', 'low', 'high'].map(thinking => ({ route_id: 'route-0', thinking })),
        ...['route-1', 'route-2'].flatMap(route_id => ['low', 'high'].map(thinking => ({ route_id, thinking })))
    ];
    const plan = await service.plan_task({ targets });
    expect(plan.run_count).toBe(7);
    expect(plan.sample_count).toBe(252);
    expect(plan.targets.map(target => [target.route_id, target.thinking])).toEqual(
        targets.map(target => [target.route_id, target.thinking])
    );
});

test('different tasks control concurrency independently without queueing behind each other, and cancelling one task does not cancel the other', async () => {
    const { service, gateway } = fixture(5);
    const first = await service.start_task({ ...request(3), sample_concurrency: 2, run_concurrency: 2 });
    await gateway.waitCalls(4);
    const second = await service.start_task({
        targets: [
            { route_id: 'route-10', thinking: 'high' },
            { route_id: 'route-11', thinking: 'high' }
        ],
        sample_concurrency: 2,
        run_concurrency: 2
    });
    await gateway.waitCalls(8);
    expect(gateway.maximum).toBe(8);
    expect(children(service, first).filter(child => child.status === 'running')).toHaveLength(2);
    expect(children(service, second).filter(child => child.status === 'running')).toHaveLength(2);
    service.cancel_task(first);
    gateway.release();
    await finish(service, first);
    await finish(service, second);
    expect(service.get_task(first)!.status).toBe('cancelled');
    expect(service.get_task(second)!.status).toBe('completed');
    expect(gateway.maximum).toBe(8);
    expect([...gateway.maxPerModel.values()].every(count => count <= 2)).toBe(true);
});

test('single child cancellation preserves sibling completion and terminal task bytes', async () => {
    const { service, gateway, directory, routes } = fixture();
    const id = await service.start_task({ ...request(3), sample_concurrency: 2, run_concurrency: 2 });
    await gateway.waitCalls(4);
    service.cancel_run(children(service, id)[0]!.run_id);
    gateway.release();
    await finish(service, id);
    expect(children(service, id).map(child => child.status)).toEqual(['cancelled', 'completed', 'completed']);
    expect(gateway.calls).toHaveLength(74);
    const before = JSON.stringify(service.db.load_task(id, true));
    const restarted = new BenchExecutionService(directory, routes, 18, gateway.factory);
    expect(JSON.stringify(restarted.db.load_task(id, true))).toBe(before);
    expect(restarted.get_task(id)!.status).toBe('incomplete');
    await restarted.close();
});

test('graceful close marks the task cancelled and never admits queued siblings', async () => {
    const { service, gateway } = fixture();
    const id = await service.start_task(request());
    await gateway.waitCalls(18);
    const closing = service.close();
    gateway.release();
    await closing;
    expect(service.get_task(id)!.status).toBe('cancelled');
    expect(gateway.calls).toHaveLength(18);
});

test('legacy single-target run stays serialized even with concurrency six', async () => {
    const { service, gateway } = fixture();
    const id = await service.start_run({ ...request(1), concurrency: 6 });
    await gateway.waitCalls(1);
    expect(gateway.calls).toHaveLength(1);
    expect(service.get_run(id)!.task_id).toBeUndefined();
    service.cancel_run(id);
    gateway.release();
    await service.wait_run(id, 5);
    expect(gateway.maximum).toBe(1);
});

test('late route validation and atomic publication failures send no requests', async () => {
    const { service, gateway, directory, routes } = fixture();
    await expect(
        service.start_task({
            targets: [
                { route_id: 'route-0', thinking: 'high' },
                { route_id: 'missing', thinking: 'high' }
            ]
        })
    ).rejects.toThrow();
    expect(service.list_tasks()).toHaveLength(0);
    expect(gateway.calls).toHaveLength(0);
    const persist = service._persist.bind(service);
    let writes = 0;
    service._persist = run => {
        if (++writes === 2) throw Object.assign(new Error('disk failure'), { code: 'EIO' });
        persist(run);
    };
    await expect(service.start_task(request())).rejects.toThrow('disk failure');
    expect(service.list_tasks()).toHaveLength(0);
    expect(gateway.calls).toHaveLength(0);
    const restarted = new BenchExecutionService(directory, routes, 18, gateway.factory);
    expect(restarted.list_tasks()).toHaveLength(0);
    expect(restarted.list_runs().every(run => run.status === 'interrupted')).toBe(true);
    await restarted.close();
    expect(gateway.calls).toHaveLength(0);
});

test('task manifest failure before commit or on first admission is fail-closed', async () => {
    for (const failAt of [1, 2]) {
        const { service, gateway } = fixture();
        const persist = service._persist_task.bind(service);
        let writes = 0;
        service._persist_task = task => {
            if (++writes === failAt) throw Object.assign(new Error('manifest failure'), { code: 'EIO' });
            persist(task);
        };
        if (failAt === 1) await expect(service.start_task(request())).rejects.toThrow('manifest failure');
        else {
            const id = await service.start_task(request());
            await finish(service, id);
            expect(service.get_task(id)!.status).toBe('failed');
        }
        expect(gateway.calls).toHaveLength(0);
        expect(service._closing).toBe(true);
    }
});

for (const failureType of ['call', 'tool_result', 'observation']) {
    test(`journal ${failureType} failure synchronously blocks concurrent tool continuation before promise rejection handlers`, async () => {
        const { service, gateway } = fixture();
        gateway.toolCalls = true;
        const id = await service.start_task({ ...request(1), rounds: 1, sample_concurrency: 12, run_concurrency: 1 });
        await gateway.waitCalls(12);
        const journal = service._runtime.get(children(service, id)[0]!.run_id)!.journal;
        const write = journal.write.bind(journal);
        journal.write = record => {
            if (record.type === failureType && !gateway.journalFailed) {
                gateway.journalFailed = true;
                throw Object.assign(new Error('journal unavailable'), { code: 'EIO' });
            }
            write(record);
        };
        gateway.release();
        await finish(service, id);
        expect(gateway.journalFailed).toBe(true);
        expect(gateway.callsAfterJournalFailure).toBe(0);
        expect(gateway.calls).toHaveLength(12);
        expect(service._closing).toBe(true);
        expect(service.get_task(id)!.status).toBe('failed');
        expect(service.get_task(id)!.stop_reason).toBe('storage_error');
    });
}

test('restart interrupts admitted and queued children, retaining terminal historical bytes', async () => {
    const { service, gateway, directory, routes } = fixture();
    const id = await service.start_task(request());
    await gateway.waitCalls(18);
    const restarted = new BenchExecutionService(directory, routes, 18, gateway.factory);
    expect(restarted.get_task(id)!.status).toBe('interrupted');
    expect(children(restarted, id).every(child => child.status === 'interrupted')).toBe(true);
    expect(gateway.calls).toHaveLength(18);
    const before = new Map(restarted.db.list_run_ids().map(name => [name, JSON.stringify(restarted.db.load_run(name))]));
    const another = new BenchExecutionService(directory, routes, 18, gateway.factory);
    for (const [child, snapshot] of before) expect(JSON.stringify(another.db.load_run(child))).toBe(snapshot);
    expect(another.cancel_task(id)).toBe(true);
    expect(gateway.calls).toHaveLength(18);
    await restarted.close();
    await another.close();
    service.cancel_task(id);
    gateway.release();
    await finish(service, id);
});
