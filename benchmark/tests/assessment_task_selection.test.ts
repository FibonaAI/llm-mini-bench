// @ts-nocheck
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { remoteRouteNamespace } from '../web/data-adapter.js';
import { sortThinkingEfforts, thinkingLabel } from '../web/data-picker.js';

class TestNode {
    constructor(value = '') {
        this.value = value;
        this.handlers = {};
        this.hidden = false;
        this.disabled = false;
        this.innerHTML = '';
        this.textContent = '';
    }
    addEventListener(type, handler) {
        (this.handlers[type] ||= []).push(handler);
    }
    async emit(type, detail = {}) {
        await Promise.all((this.handlers[type] || []).map(handler => handler({ target: this, preventDefault() {}, ...detail })));
    }
    checkValidity() {
        return this.value === '' || (Number.isFinite(Number(this.value)) && Number(this.value) > 0);
    }
}
function fixture() {
    const nodes = new Map();
    const element = id => {
        if (!nodes.has(id)) nodes.set(id, new TestNode());
        return nodes.get(id);
    };
    Object.entries({
        'run-rounds': '3',
        'sample-concurrency': '6',
        'run-concurrency': '3',
        'bench-bank': '1.0',
        'bench-max-cost': '1',
        'bench-max-requests': '150',
        'bench-max-output': '8192',
        'bench-api-retries': '3',
        'bench-timeout': '600',
        'bench-max-tools': '5',
        'bench-max-turns': '6',
        'history-status': 'all'
    }).forEach(([id, value]) => (element(id).value = value));
    const events = new TestNode();
    const calls = [],
        messages = [];
    let routes = [
        {
            id: 'route-a',
            providerId: 'channel-a',
            accountId: 'main',
            provider: 'API',
            account: '主账号',
            model: 'Luna',
            thinking_levels: ['high', 'low']
        },
        {
            id: 'route-b',
            providerId: 'channel-b',
            accountId: 'main',
            provider: 'API',
            account: '主账号',
            model: 'Luna',
            thinking_levels: ['high']
        }
    ];
    let failStart = false,
        failRetry = false;
    let submissionGate;
    let historyTasks = [],
        historyRuns = [{ id: 'created', status: 'completed', targets: [], samples: [] }];
    const details = new Map();
    const key = record => JSON.stringify([record.providerId, record.accountId, record.model, record.think]);
    const request = async (path, options) => {
        calls.push({ path, options });
        if (path.split('?')[0].endsWith('/routes')) return { routes };
        if (path.split('?')[0].endsWith('/quota-cards')) return { status: 'available', cards: [] };
        if (path.endsWith('/banks'))
            return { execution_policy: 'sample-timeout-v1', banks: [{ version: '1.0', tasks: Array(14).fill({}) }] };
        if (path.endsWith('/task-plans')) throw Error('UI must not request manual plans');
        if (path.endsWith('/retry')) {
            if (failRetry) throw Error('timeout');
            return { id: 'created', ids: ['created'], rejected: [] };
        }
        if (path.endsWith('/tasks') && options?.method === 'POST') {
            if (submissionGate) await submissionGate;
            if (failStart) throw Error('timeout');
            return { id: 'task-created' };
        }
        if (path.endsWith('/baselines/batch') && options?.method === 'POST') {
            const payload = JSON.parse(options.body);
            if (payload.action === 'promote') {
                return {
                    created: payload.items.map((item, idx) => ({ id: `promoted-${idx}`, ...item })),
                    rejected: []
                };
            }
            return { deleted: payload.ids };
        }
        if (path.endsWith('/baseline') && options?.method === 'POST') {
            return { baseline: { id: 'promoted-single' } };
        }
        if (path.endsWith('/delete') && path.includes('/baselines/') && options?.method === 'POST') {
            return { ok: true };
        }
        if (path.endsWith('/tasks')) return { tasks: historyTasks };
        if (path.endsWith('/runs')) return { runs: historyRuns };
        const basePath = path.split('?')[0];
        if (details.has(path)) return details.get(path);
        if (details.has(basePath)) return details.get(basePath);
        return { id: 'created', status: 'completed', targets: [], samples: [] };
    };
    const mini = {
        byId: element,
        escapeHtml: value => String(value ?? ''),
        notify: (...args) => messages.push(args),
        request,
        available: true,
        activeStatus: status => ['queued', 'running'].includes(status),
        statusText: status => status,
        formatDate: value => value || ''
    };
    const window = {
        MiniBench: mini,
        addEventListener: (...args) => events.addEventListener(...args),
        dispatchEvent: event => events.emit(event.type, { detail: event.detail })
    };
    const context = vm.createContext({
        window,
        Event: class {
            constructor(type) {
                this.type = type;
            }
        },
        CustomEvent: class {
            constructor(type, { detail }) {
                this.type = type;
                this.detail = detail;
            }
        },
        setTimeout: () => 0,
        clearTimeout: () => {},
        console,
        crypto,
        Uint8Array,
        remoteRouteNamespace,
        selectionKey: key,
        sortThinkingEfforts,
        thinkingLabel,
        createDataPicker: () => ({ setQuotaCatalog() {}, setSelection() {}, destroy() {} }),
        routePickerLeaves: records =>
            records.flatMap(route => route.thinking_levels.map(think => ({ ...route, route, routeId: route.id, think })))
    });
    for (const filename of ['app-context.js', 'runs.js', 'task-history-view.js', 'task-submission.js', 'bench.js']) {
        const raw = readFileSync(
            process.env.MINI_BENCH_WEB_DIR
                ? join(process.env.MINI_BENCH_WEB_DIR, filename)
                : new URL('../web/' + filename, import.meta.url),
            'utf8'
        );
        const exports = [...raw.matchAll(/^export function (\w+)/gm)].map(match => match[1]);
        const source = raw
            .replace(/^import .*;\n/gm, '')
            .replace(/^export /gm, '')
            .replace('if (available) load();', '');
        // Inject real module exports while retaining separate module lexical scopes.
        Object.assign(context, vm.runInContext(`(function(){${source}\nreturn {${exports.join(',')}};})()`, context));
    }
    return {
        mini,
        element,
        calls,
        messages,
        key,
        window,
        load: () => events.emit('mini-bench:refresh'),
        setFailStart: value => (failStart = value),
        setFailRetry: value => (failRetry = value),
        setRoutes: value => (routes = value),
        setSubmissionGate: value => (submissionGate = value),
        setHistory: (tasks, runs) => {
            historyTasks = tasks;
            historyRuns = runs;
        },
        setDetail: (path, value) => details.set(path, value)
    };
}

test('catalog load defaults to no paid targets and no cross-product selection', async () => {
    const f = fixture();
    await f.load();
    expect(f.mini.runState.getSelectedTargets()).toEqual([]);
    expect(f.element('start-run').disabled).toBe(true);
    const leaves = f.mini.runState.leaves;
    f.mini.runState.setTaskSelection([
        f.key(leaves.find(r => r.routeId === 'route-a' && r.think === 'low')),
        f.key(leaves.find(r => r.routeId === 'route-b' && r.think === 'high'))
    ]);
    expect(f.mini.runState.getSelectedTargets().map(t => [t.route_id, t.thinking])).toEqual([
        ['route-a', 'low'],
        ['route-b', 'high']
    ]);
    expect(f.calls.filter(c => c.options?.method === 'POST')).toHaveLength(0);
    f.mini.runState.setTaskSelection([]);
    await f.element('start-run').emit('click');
    expect(f.calls.filter(c => c.options?.method === 'POST')).toHaveLength(0);
});
test('long route and Thinking identities retain exact payload with short deterministic local IDs', async () => {
    const f = fixture();
    const longRoute = 'r'.repeat(256),
        longThink = 't'.repeat(64);
    const routes = [
        {
            id: longRoute,
            providerId: 'long-provider',
            accountId: 'main',
            provider: 'API',
            account: '主账号',
            model: 'Long model',
            thinking_levels: [longThink]
        },
        {
            id: 'short-route',
            providerId: 'short-provider',
            accountId: 'main',
            provider: 'API',
            account: '主账号',
            model: 'Other model',
            thinking_levels: ['high']
        }
    ];
    f.setRoutes(routes);
    await f.load();
    const keys = f.mini.runState.leaves.map(f.key);
    f.mini.runState.setTaskSelection(keys);
    const first = f.mini.runState.getSelectedTargets();
    expect(first.every(target => target.id.length <= 256)).toBe(true);
    expect(first.map(target => target.id)).toEqual(['target-1', 'target-2']);
    expect(first.find(target => target.thinking === longThink).route_id).toBe(longRoute);
    f.setRoutes([...routes].reverse());
    await f.load();
    f.mini.runState.setTaskSelection([...keys].reverse());
    expect(f.mini.runState.getSelectedTargets()).toEqual(first);
    await f.element('start-run').emit('click');
    const submission = f.calls.find(call => call.path.endsWith('/tasks') && call.options?.method === 'POST');
    expect(JSON.parse(submission.options.body).targets).toEqual(first);
});
test('copy drops unavailable leaves; refresh never selects replacement routes', async () => {
    const f = fixture();
    await f.load();
    const leaf = f.mini.runState.leaves[0];
    await f.window.dispatchEvent({ type: 'mini-bench:select-targets', detail: { keys: [f.key(leaf), 'unknown'] } });
    expect(f.mini.runState.selectedKeys).toEqual([f.key(leaf)]);
    expect(f.messages.at(-1)[0]).toContain('1 项不受当前路由目录支持');
    f.setRoutes([]);
    await f.load();
    expect(f.mini.runState.selectedKeys).toEqual([]);
});
test('one action starts the latest exact targets; config changes update preview without requests', async () => {
    const f = fixture();
    await f.load();
    f.mini.runState.setTaskSelection([f.key(f.mini.runState.leaves[0])]);
    expect(f.element('start-run').disabled).toBe(false);
    f.mini.runState.setTaskSelection([f.key(f.mini.runState.leaves[1])]);
    expect(f.element('start-run').disabled).toBe(false);
    expect(f.calls.filter(c => c.options?.method === 'POST')).toHaveLength(0);
    await f.element('start-run').emit('click');
    const posts = f.calls.filter(c => c.options?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe('./api/bench/tasks');
    expect(JSON.parse(posts[0].options.body).targets[0].thinking).toBe('low');
});

test('submission timeout checks history and requires explicit review before another attempt', async () => {
    const f = fixture();
    await f.load();
    f.mini.runState.setTaskSelection([f.key(f.mini.runState.leaves[0])]);
    f.setFailStart(true);
    await f.element('start-run').emit('click');
    f.element('run-rounds').value = '2';
    await f.element('run-form').emit('input');
    await f.element('start-run').emit('click');
    const posts = f.calls.filter(c => c.path.endsWith('/tasks') && c.options?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(f.calls.slice(f.calls.indexOf(posts[0]) + 1).some(c => c.path.endsWith('/tasks') && !c.options)).toBe(true);
    expect(f.element('start-run').disabled).toBe(true);
    expect(f.element('bench-retry-review').hidden).toBe(false);
    await f.element('bench-retry-review').emit('click');
    expect(f.element('start-run').disabled).toBe(false);
    expect(f.calls.filter(c => c.options?.method === 'POST')).toHaveLength(1);
    f.setFailStart(false);
    await f.element('start-run').emit('click');
    expect(f.calls.filter(c => c.options?.method === 'POST')).toHaveLength(2);
});

test('invalid budgets, rounds and concurrency cannot start; cancellation remains explicit', async () => {
    const f = fixture();
    await f.load();
    f.mini.runState.setTaskSelection([f.key(f.mini.runState.leaves[0])]);
    for (const [id, value] of [
        ['run-rounds', '4'],
        ['run-concurrency', '0'],
        ['bench-timeout', '0'],
        ['bench-timeout', '3601'],
        ['bench-timeout', 'NaN']
    ]) {
        const prior = f.element(id).value;
        f.element(id).value = value;
        await f.element('start-run').emit('click');
        f.element(id).value = prior;
    }
    expect(f.calls.filter(call => call.path.endsWith('/task-plans'))).toHaveLength(0);
    await f.element('bench-cancel-run').emit('click');
    expect(f.calls.filter(call => call.path.endsWith('/cancel') && call.options?.method === 'POST')).toHaveLength(0);
    expect(f.calls.filter(call => call.path.endsWith('/tasks') && call.options?.method === 'POST')).toHaveLength(0);
});
test('history search filters without modifying records or starting tasks', async () => {
    const f = fixture();
    await f.load();
    f.element('history-search').value = 'not-found';
    await f.element('history-search').emit('input');
    expect(f.element('bench-run-list').innerHTML).toContain('没有匹配');
    f.element('history-search').value = 'created';
    await f.element('history-search').emit('input');
    expect(f.element('bench-run-list').innerHTML).toContain('created');
    expect(f.calls.filter(c => c.options?.method === 'POST')).toHaveLength(0);
});

test('seven exact leaves create seven runs with 42 samples each and two-level concurrency', async () => {
    const f = fixture();
    f.setRoutes(
        Array.from({ length: 7 }, (_, i) => ({
            id: `route-${i}`,
            providerId: `provider-${i}`,
            accountId: 'one',
            provider: 'API',
            account: '固定账号',
            model: `model-${i}`,
            thinking_levels: ['high']
        }))
    );
    await f.load();
    f.mini.runState.setTaskSelection(f.mini.runState.leaves.filter(leaf => leaf.think === 'high').map(f.key));
    expect(f.element('run-request-estimate').textContent).toContain('294');
    expect(f.element('bench-plan-preview').innerHTML).toContain('7 个独立运行');
    expect(f.element('bench-plan-preview').innerHTML).toContain('每运行 42');
    await f.element('start-run').emit('click');
    const call = f.calls.find(call => call.path.endsWith('/tasks') && call.options?.method === 'POST');
    const input = JSON.parse(call.options.body);
    expect(input.targets).toHaveLength(7);
    expect(input.rounds).toBe(3);
    expect(input.sample_concurrency).toBe(6);
    expect(input.run_concurrency).toBe(3);
    expect(input).not.toHaveProperty('concurrency');
    expect(input.limits).toEqual({
        max_cost_usd: null,
        max_requests: null,
        max_output_tokens: null,
        max_api_retries: 3,
        timeout: 600,
        timeout_scope: 'sample',
        max_tool_calls: null,
        max_turns: null
    });
    expect(f.calls.some(call => call.path.endsWith('/runs') && call.options?.method === 'POST')).toBe(false);
});

test('new task history excludes child runs from top level and retains old records explicitly', async () => {
    const f = fixture();
    const target = {
        model: 'one-model',
        route_id: 'fixed-route',
        thinking: 'high',
        account_ref: 'fixed-account',
        provider_id: 'remote-instance',
        remote_route: { namespace: 'group', evidence: 'magpie_via_catalog' }
    };
    const task = {
        id: 'parent-task',
        status: 'running',
        plan: { targets: [target], run_count: 1, sample_count: 42, run_concurrency: 3, sample_concurrency: 6 },
        children: [
            {
                run_id: 'child-run',
                target,
                status: 'running',
                sample_count: 42,
                sample_status_counts: { completed: 2, running: 1, pending: 39 }
            }
        ]
    };
    const child = {
        id: 'child-run',
        task_id: task.id,
        status: 'running',
        plan: { targets: [target] },
        samples: [{ sample_id: 'sample-a', task: 'math', thinking: 'high', round: 1, status: 'completed', grade: { content_score: 1 } }]
    };
    f.setHistory([task], [child, { id: 'old-run', status: 'completed', targets: [target], sample_count: 14 }]);
    f.setDetail('./api/bench/tasks/parent-task', task);
    f.setDetail('./api/bench/runs/child-run', child);
    await f.load();
    const html = f.element('bench-run-list').innerHTML;
    expect(html).toContain('data-bench-task-id="parent-task"');
    expect(html).toContain('data-bench-run-id="old-run"');
    expect(html).not.toContain('data-bench-run-id="child-run"');
    expect(html).toContain('旧运行');
    expect(f.element('bench-task-detail').innerHTML).toContain('2/42');
    expect(f.element('bench-task-detail').innerHTML).toContain('remote-instance / group（路由组）');
    await f.window.dispatchEvent({ type: 'mini-bench:select-run', detail: 'child-run' });
    expect(f.element('bench-task-detail').innerHTML).toContain('fixed-account');
    expect(f.element('bench-run-detail').innerHTML).toContain('sample-a');
    await f.element('bench-cancel-run').emit('click');
    expect(f.calls.filter(call => call.options?.method === 'POST').map(call => call.path)).toEqual(['./api/bench/runs/child-run/cancel']);
    await f.element('bench-cancel-task').emit('click');
    expect(f.calls.filter(call => call.options?.method === 'POST').map(call => call.path)).toEqual([
        './api/bench/runs/child-run/cancel',
        './api/bench/tasks/parent-task/cancel'
    ]);
});

test('late run details do not overwrite a more recent selection', async () => {
    const f = fixture();
    await f.load();
    let release;
    f.setDetail('./api/bench/runs/slow', new Promise(resolve => (release = resolve)));
    f.setDetail('./api/bench/runs/fast', { id: 'fast', status: 'completed', samples: [] });
    const pending = f.window.dispatchEvent({ type: 'mini-bench:select-run', detail: 'slow' });
    await f.window.dispatchEvent({ type: 'mini-bench:select-run', detail: 'fast' });
    release({ id: 'slow', status: 'completed', samples: [] });
    await pending;
    expect(f.element('bench-run-detail').innerHTML).toContain('fast');
    expect(f.element('bench-run-detail').innerHTML).not.toContain('slow');
});

test('double submit and config edits during creation cannot submit a second task', async () => {
    const f = fixture();
    await f.load();
    const key = f.key(f.mini.runState.leaves[0]);
    f.mini.runState.setTaskSelection([key]);
    let release;
    f.setSubmissionGate(new Promise(resolve => (release = resolve)));
    const pending = f.element('start-run').emit('click');
    f.mini.runState.setTaskSelection([]);
    f.mini.runState.setTaskSelection([key]);
    expect(f.element('start-run').disabled).toBe(true);
    await f.element('start-run').emit('click');
    expect(f.calls.filter(call => call.options?.method === 'POST')).toHaveLength(1);
    release();
    await pending;
    expect(f.mini.runState.getSelectedTargets()).toEqual([]);
    expect(f.element('start-run').disabled).toBe(true);
    f.mini.runState.setTaskSelection([key]);
    expect(f.element('start-run').disabled).toBe(false);
});

test('concurrency bounds validate independently before any task submission', async () => {
    const f = fixture();
    await f.load();
    f.mini.runState.setTaskSelection([f.key(f.mini.runState.leaves[0])]);
    for (const [id, value] of [
        ['sample-concurrency', '0'],
        ['sample-concurrency', '65'],
        ['sample-concurrency', '1.5'],
        ['run-concurrency', '11'],
        ['run-concurrency', '0']
    ]) {
        const prior = f.element(id).value;
        f.element(id).value = value;
        await f.element('start-run').emit('click');
        f.element(id).value = prior;
    }
    expect(f.calls.filter(call => call.options?.method === 'POST')).toHaveLength(0);
});

test('966 samples preview automatically without starting a paid task', async () => {
    const f = fixture();
    f.setRoutes(
        Array.from({ length: 23 }, (_, i) => ({
            id: `route-${i}`,
            providerId: `p-${i}`,
            accountId: 'one',
            model: `model-${i}`,
            thinking_levels: ['high']
        }))
    );
    await f.load();
    f.mini.runState.setTaskSelection(f.mini.runState.leaves.map(f.key));
    expect(f.element('run-request-estimate').textContent).toContain('966');
    expect(f.element('start-run').disabled).toBe(false);
    const plans = f.calls.filter(call => call.path.endsWith('/task-plans'));
    expect(plans).toHaveLength(0);
    expect(f.element('bench-plan-preview').innerHTML).toContain('966');
    expect(f.element('start-run').disabled).toBe(false);
    expect(f.calls.filter(call => call.path.endsWith('/tasks') && call.options?.method === 'POST')).toHaveLength(0);
});

test('gateway selections warn about unfixed accounts and upstream retries without blocking start', async () => {
    const f = fixture();
    f.setRoutes([
        {
            id: 'gateway',
            providerId: 'provider',
            accountId: 'gateway',
            model: 'model',
            thinking_levels: ['high'],
            account_evidence: 'gateway_binding'
        }
    ]);
    await f.load();
    expect(f.element('task-route-warning').hidden).toBe(true);
    f.mini.runState.setTaskSelection(f.mini.runState.leaves.map(f.key));
    expect(f.element('task-route-warning').hidden).toBe(false);
    expect(f.element('task-route-warning').textContent).toContain('固定账号对照需显式绑定');
    expect(f.element('start-run').disabled).toBe(false);
    expect(f.calls.filter(call => call.options?.method === 'POST')).toHaveLength(0);
});

test('only per-sample timeout is submitted; no hidden request, token, dollar or tool caps', async () => {
    const f = fixture();
    await f.load();
    f.mini.runState.setTaskSelection([f.key(f.mini.runState.leaves[0])]);
    expect(f.element('bench-plan-preview').innerHTML).toContain('每题总超时 600 秒');
    expect(f.element('bench-plan-preview').innerHTML).toContain('不设置 token');
    await f.element('start-run').emit('click');
    const call = f.calls.find(c => c.options?.method === 'POST');
    const limits = JSON.parse(call.options.body).limits;
    for (const key of ['max_output_tokens', 'max_cost_usd', 'max_requests', 'max_tool_calls', 'max_turns']) expect(limits[key]).toBeNull();
    f.element('bench-timeout').value = '9';
    await f.element('run-form').emit('input');
    expect(f.element('start-run').disabled).toBe(true);
});
test('copy a task selects exact current leaves and restores all limits without requests', async () => {
    const f = fixture();
    const task = {
        id: 'copy-task',
        status: 'incomplete',
        plan: {
            targets: [
                { route_id: 'route-a', model: 'Luna', thinking: 'low' },
                { route_id: 'retired', thinking: 'high' }
            ],
            rounds: 2,
            sample_concurrency: 4,
            run_concurrency: 2,
            limits: {
                max_cost_usd: null,
                max_output_tokens: 16384,
                max_requests: 200,
                max_api_retries: 1,
                timeout: 180,
                max_tool_calls: 7,
                max_turns: 8
            }
        },
        children: []
    };
    f.setHistory([task], []);
    f.setDetail('./api/bench/tasks/copy-task', task);
    await f.load();
    await f.element('bench-copy-task').emit('click');
    expect(f.mini.runState.getSelectedTargets().map(t => [t.route_id, t.thinking])).toEqual([['route-a', 'low']]);
    expect(f.element('run-rounds').value).toBe('2');
    expect(f.element('bench-timeout').value).toBe('600');
    expect(f.calls.filter(c => c.options?.method === 'POST')).toHaveLength(0);
    expect(f.messages.at(-1)[0]).toContain('未替换为其他目标');
});
test('manual retry requires confirmation, reuses uncertain id and refreshes analysis', async () => {
    const f = fixture(),
        run = { id: 'retry-run', status: 'failed', retryable_samples: 1, plan: { targets: [] }, samples: [] };
    f.setHistory([], [run]);
    f.setDetail('./api/bench/runs/retry-run', run);
    await f.load();
    let updates = 0;
    f.window.addEventListener('mini-bench:observations-changed', () => updates++);
    await f.element('bench-retry-run').emit('click');
    expect(f.calls.filter(c => c.path.endsWith('/retry'))).toHaveLength(0);
    expect(f.element('bench-retry-run').textContent).toBe('确认重试 API 失败');
    expect(f.element('bench-run-detail').innerHTML).toContain('待确认：仅重试 API 失败');
    f.setFailRetry(true);
    await f.element('bench-retry-run').emit('click');
    const first = f.calls.find(c => c.path.endsWith('/retry'));
    expect(JSON.parse(first.options.body).request_id).toMatch(/^[a-f0-9]{32}$/);
    f.setFailRetry(false);
    await f.element('bench-retry-run').emit('click');
    const retries = f.calls.filter(c => c.path.endsWith('/retry'));
    expect(retries).toHaveLength(2);
    expect(retries[1].options.body).toBe(first.options.body);
    expect(updates).toBe(1);
});

test('historical classifications distinguish API errors, capability limits and never-sent samples', async () => {
    const f = fixture();
    const samples = [
        ['api_failure', 'request_timeout'],
        ['incomplete', 'output_token_limit'],
        ['budget_not_admitted', 'not_executed_after_api_failure']
    ].map(([status, reason], i) => ({
        sample_id: 'history-' + i,
        task: 'task',
        round: 1,
        thinking: 'high',
        status,
        historical_outcome_classification: { reason }
    }));
    const run = { id: 'history-classified', status: 'failed', plan: { targets: [] }, samples };
    f.setHistory([], [run]);
    f.setDetail('./api/bench/runs/history-classified', run);
    await f.load();
    const html = f.element('bench-run-detail').innerHTML;
    for (const text of ['API 失败：请求超时', '未完成：输出 token 超限', '未执行：此前 API 失败导致停止']) expect(html).toContain(text);
    expect(f.calls.filter(call => call.options?.method === 'POST')).toHaveLength(0);
});

test('closing a detail invalidates an in-flight selection and does not reopen history', async () => {
    const f = fixture();
    await f.load();
    let release;
    f.setDetail('./api/bench/runs/slow-close', new Promise(resolve => (release = resolve)));
    const pending = f.window.dispatchEvent({ type: 'mini-bench:select-run', detail: 'slow-close' });
    await f.element('bench-close-run').emit('click');
    release({ id: 'slow-close', status: 'completed', samples: [] });
    await pending;
    expect(f.element('bench-run-section').hidden).toBe(true);
    expect(f.element('bench-run-detail').innerHTML).not.toContain('slow-close');
    await f.load();
    expect(f.element('bench-run-section').hidden).toBe(true);
});

test('copy never substitutes a changed account binding on the same route', async () => {
    const f = fixture();
    f.setRoutes([
        {
            id: 'same-route',
            providerId: 'channel',
            accountId: 'new-account',
            model: 'model',
            thinking_levels: ['high'],
            binding_ref: 'new-binding'
        }
    ]);
    const task = {
        id: 'bound-task',
        status: 'completed',
        plan: { targets: [{ route_id: 'same-route', thinking: 'high', binding_ref: 'old-binding' }] },
        children: []
    };
    f.setHistory([task], []);
    f.setDetail('./api/bench/tasks/bound-task', task);
    await f.load();
    await f.element('bench-copy-task').emit('click');
    expect(f.mini.runState.getSelectedTargets()).toEqual([]);
    expect(f.messages.at(-1)[0]).toContain('未替换为其他目标');
    expect(f.calls.filter(call => call.options?.method === 'POST')).toHaveLength(0);
});

test('web UI avoids native form submission so sandboxed iframes without allow-forms can start tasks', () => {
    const html = readFileSync(join(import.meta.dir, '../web/index.html'), 'utf8');
    expect(html).not.toMatch(/<form\b/i);
    expect(html).not.toMatch(/type=["']submit["']/i);
});

test('task, channel-pod, and single-run baseline controls promote and demote with observation sync', async () => {
    const f = fixture();
    const task = {
        id: 'batch-task',
        status: 'completed',
        plan: {
            targets: [
                { id: 't-a', route_id: 'route-a', provider_id: 'channel-a', model: 'Luna', thinking: 'high' },
                { id: 't-b', route_id: 'route-b', provider_id: 'channel-b', model: 'Luna', thinking: 'high' },
                { id: 't-c', route_id: 'route-b', provider_id: 'channel-b', model: 'Luna', thinking: 'low' }
            ],
            rounds: 3
        },
        children: [
            {
                run_id: 'run-a',
                target: { id: 't-a', route_id: 'route-a', provider_id: 'channel-a', model: 'Luna', thinking: 'high' },
                status: 'completed',
                baseline_eligible: true,
                baseline_id: null
            },
            {
                run_id: 'run-b',
                target: { id: 't-b', route_id: 'route-b', provider_id: 'channel-b', model: 'Luna', thinking: 'high' },
                status: 'completed',
                baseline_eligible: true,
                baseline_id: null
            },
            {
                run_id: 'run-c',
                target: { id: 't-c', route_id: 'route-b', provider_id: 'channel-b', model: 'Luna', thinking: 'low' },
                status: 'failed',
                baseline_eligible: false,
                baseline_id: null
            }
        ]
    };
    f.setHistory([task], []);
    f.setDetail('./api/bench/tasks/batch-task', task);
    await f.load();
    let obsChanged = 0;
    f.window.addEventListener('mini-bench:observations-changed', () => obsChanged++);

    // Task-level batch promote skips ineligible child and posts both eligible children together.
    await f.element('bench-baseline-task').emit('click');
    const batchCall = f.calls.find(call => call.path === './api/bench/baselines/batch');
    expect(JSON.parse(batchCall.options.body)).toEqual({
        action: 'promote',
        items: [
            { run_id: 'run-a', target_id: 't-a' },
            { run_id: 'run-b', target_id: 't-b' }
        ]
    });
    expect(obsChanged).toBe(1);

    // Channel-pod single-item promote uses single run baseline endpoint; multi-id demote uses batch delete.
    task.children[0].baseline_id = 'base-a';
    task.children[1].baseline_id = 'base-b';
    await f.element('bench-unbaseline-task').emit('click');
    const batchDelete = f.calls.filter(call => call.path === './api/bench/baselines/batch').at(-1);
    expect(JSON.parse(batchDelete.options.body)).toEqual({
        action: 'delete',
        ids: ['base-a', 'base-b']
    });
    expect(obsChanged).toBe(2);

    // Single-run promote & demote via run section buttons.
    task.children[0].baseline_id = null;
    const runDetail = {
        id: 'run-a',
        task_id: 'batch-task',
        status: 'completed',
        updated_at: '2026-11-24T00:00:00Z',
        plan: { targets: [task.children[0].target] },
        samples: []
    };
    f.setDetail('./api/bench/runs/run-a', runDetail);
    await f.window.dispatchEvent(
        new (class {
            type = 'mini-bench:select-run';
            detail = 'run-a';
        })()
    );
    await f.element('bench-baseline-run').emit('click');
    expect(f.calls.some(call => call.path === './api/bench/runs/run-a/baseline' && call.options?.method === 'POST')).toBe(true);
    task.children[0].baseline_id = 'base-single';
    await f.load();
    await f.element('bench-unbaseline-run').emit('click');
    expect(f.calls.some(call => call.path === './api/bench/baselines/base-single/delete' && call.options?.method === 'POST')).toBe(true);
});
