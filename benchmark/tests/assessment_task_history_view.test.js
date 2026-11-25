import { expect, test } from 'bun:test';
import { createTaskHistoryView } from '../web/task-history-view.js';

class HistoryNode {
    constructor(id) {
        this.id = id;
        this.value = '';
        this.hidden = false;
        this.samples = [];
        this.slots = new Map();
        this.handlers = new Map();
        this.attributes = new Map();
        this.dataset = {};
        this.classes = new Set();
        this.classList = {
            toggle: (name, force) => {
                if (force === undefined) {
                    if (this.classes.has(name)) this.classes.delete(name);
                    else this.classes.add(name);
                } else if (force) this.classes.add(name);
                else this.classes.delete(name);
            },
            contains: name => this.classes.has(name)
        };
    }
    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }
    removeAttribute(name) {
        this.attributes.delete(name);
    }
    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }
    addEventListener(name, handler) {
        this.handlers.set(name, handler);
    }
    get innerHTML() {
        return this.html || '';
    }
    set innerHTML(value) {
        this.renderCount = (this.renderCount || 0) + 1;
        this.html = value;
        this.samples = [...value.matchAll(/data-sample-id="([^"]+)"/g)].map(match => ({ dataset: { sampleId: match[1] }, open: false }));
        this.slots.clear();
        for (const match of value.matchAll(/data-inline-(task|run)="([^"]+)"/g)) {
            this.slots.set(`[data-inline-${match[1]}="${match[2]}"]`, {
                append: node => {
                    node.parentSlot = match[0];
                }
            });
        }
    }
    querySelector(selector) {
        return this.slots.get(selector);
    }
    querySelectorAll(selector) {
        return selector.includes('[open]') ? this.samples.filter(sample => sample.open) : this.samples;
    }
}

function fixture() {
    const nodes = new Map(),
        detached = new Set();
    const byId = id => {
        if (detached.has(id)) return null;
        if (!nodes.has(id)) nodes.set(id, new HistoryNode(id));
        return nodes.get(id);
    };
    byId('history-status').value = 'all';
    const target = { model: 'model', route_id: 'fixed', thinking: 'high', account_ref: 'account' };
    const state = {
        selectedTaskId: 'task',
        selectedRunId: 'run',
        cancelling: new Set(),
        tasks: [
            {
                id: 'task',
                status: 'completed',
                plan: { targets: [target], run_count: 1 },
                children: [{ run_id: 'run', target, status: 'completed' }]
            }
        ],
        runs: [],
        taskDetail: null,
        runDetail: {
            id: 'run',
            task_id: 'task',
            status: 'completed',
            plan: { targets: [target] },
            samples: [
                { sample_id: 'sample-one', task: 'one', round: 1, thinking: 'high', status: 'completed', grade: { content_score: 0.5 } },
                { sample_id: 'sample-two', task: 'two', round: 1, thinking: 'high', status: 'api_failure' }
            ]
        }
    };
    const app = {
        services: {
            byId,
            escapeHtml: value => String(value ?? ''),
            activeStatus: status => ['queued', 'running'].includes(status),
            statusText: value => value,
            formatDate: value => value
        }
    };
    const view = createTaskHistoryView({ app, state, retryRequests: new Map(), retrying: new Set() });
    return { nodes, detached, state, view };
}

test('task history keeps the same detached sections and expanded sample IDs across redraws', () => {
    const { nodes, detached, state, view } = fixture();
    view.renderDetails();
    const taskSection = nodes.get('bench-task-section'),
        runSection = nodes.get('bench-run-section');
    expect(taskSection.parentSlot).toBe('data-inline-task="task"');
    expect(runSection.parentSlot).toBe('data-inline-run="run"');
    const container = nodes.get('bench-run-detail');
    container.samples.find(sample => sample.dataset.sampleId === 'sample-one').open = true;
    // DOM lookup cannot see sections detached by history innerHTML replacement.
    for (const id of ['bench-task-section', 'bench-run-section', 'bench-run-detail', 'bench-task-detail']) detached.add(id);
    state.runDetail = { ...state.runDetail, samples: state.runDetail.samples.map(sample => ({ ...sample })) };
    view.renderDetails();
    expect(view.taskSection).toBe(taskSection);
    expect(view.runSection).toBe(runSection);
    // Samples needing attention render first; open state follows sample IDs, not DOM order.
    expect(Object.fromEntries(container.samples.map(sample => [sample.dataset.sampleId, sample.open]))).toEqual({
        'sample-one': true,
        'sample-two': false
    });
    expect(runSection.hidden).toBe(false);
    state.selectedRunId = null;
    state.runDetail = null;
    view.renderDetails();
    expect(runSection.hidden).toBe(true);
});

test('unchanged history polling does not replace any detail markup', () => {
    const { nodes, state, view } = fixture();
    view.renderDetails();
    const ids = ['bench-run-list', 'bench-task-detail', 'bench-run-detail'];
    const counts = ids.map(id => nodes.get(id).renderCount);
    state.runDetail = structuredClone(state.runDetail);
    view.renderDetails();
    expect(ids.map(id => nodes.get(id).renderCount)).toEqual(counts);
    expect(nodes.get('bench-task-detail').innerHTML).toContain('aria-expanded="true"');
    expect(nodes.get('bench-run-list').innerHTML).toContain('aria-expanded="true"');
});

test('completed sample diagnostics distinguish parser ambiguity, zero scores and missing cumulative usage', () => {
    const { nodes, state, view } = fixture();
    state.runDetail.samples = [
        {
            sample_id: 'ambiguous',
            status: 'completed',
            grade: { content_score: null, outcome: 'ambiguous' },
            text: '{"answer":1} explanation {invalid}'
        },
        { sample_id: 'ungradable', status: 'completed', grade: { content_score: null, outcome: 'ungradable' } },
        { sample_id: 'missing', status: 'completed', grade: null },
        {
            sample_id: 'recovered',
            status: 'completed',
            grade: { content_score: 0, outcome: 'ok' },
            attempts: [{ status: 'api_failure' }],
            usage: null,
            estimated_uncached_cost_usd: null,
            latest_attempt_usage: { input_tokens: 3, output_tokens: 4 },
            latest_attempt_cost_usd: 0.01
        }
    ];
    view.renderDetails();
    const html = nodes.get('bench-run-detail').innerHTML;
    expect(html).toContain('答案解析有歧义');
    expect(html).toContain('答案无法解析');
    expect(html).toContain('评分记录缺失或无效');
    expect(html).not.toContain('未评分');
    expect(html).toContain('completed · 0');
    expect(html).toContain('历次尝试');
    expect(html).toContain('本次尝试用量');
    expect(html).toContain('评分结果');
    expect(html).not.toContain('工具执行结果');
    expect(html).toContain('data-history-disclosure=');
});

test('known zero usage and cost do not produce missing-accounting warnings', () => {
    const { nodes, state, view } = fixture();
    state.runDetail.samples = [
        {
            sample_id: 'zero',
            status: 'completed',
            grade: { content_score: 0 },
            usage: { input_tokens: 0, output_tokens: 0 },
            estimated_uncached_cost_usd: 0
        }
    ];
    view.renderDetails();
    const html = nodes.get('bench-run-detail').innerHTML;
    expect(html).toContain('completed · 0');
    expect(html).not.toContain('累计用量');
    expect(html).not.toContain('累计估算费用');
    expect(html).not.toContain('无法评分');
});

test('searching away the selected task does not discard details or expanded samples', () => {
    const { nodes, state, view } = fixture();
    view.renderDetails();
    const container = nodes.get('bench-run-detail');
    container.samples[1].open = true;
    nodes.get('history-search').value = 'not-present';
    nodes.get('history-search').handlers.get('input')();
    expect(nodes.get('bench-run-list').innerHTML).toContain('没有匹配');
    expect(state.selectedTaskId).toBe('task');
    expect(state.selectedRunId).toBe('run');
    expect(container.samples[1].open).toBe(true);
    nodes.get('history-search').value = '';
    nodes.get('history-search').handlers.get('input')();
    expect(nodes.get('bench-run-section').parentSlot).toBe('data-inline-run="run"');
    expect(container.samples[1].open).toBe(true);
});

test('failed samples show journaled call diagnoses, never-sent attempts and a task-by-round matrix', async () => {
    const { nodes, state } = fixture();
    const calls = [
        {
            call_id: 'f:1',
            sample_id: 'sample-two',
            http_status: 200,
            elapsed_seconds: 90.1,
            response_status: 'failed',
            terminal_event: 'response.failed',
            error_code: 'server_error',
            error_message: 'connection lost mid-reply',
            local_exception: null,
            termination: 'terminal',
            first_output_seconds: 2,
            usage_known: false
        },
        {
            call_id: 't:1',
            sample_id: 'sample-three',
            http_status: -1,
            elapsed_seconds: 300,
            response_status: null,
            terminal_event: null,
            error_code: null,
            error_message: null,
            local_exception: 'TimeoutError',
            termination: 'timeout',
            first_output_seconds: null,
            usage_known: false
        }
    ];
    const requests = [];
    const byId = id => nodes.get(id) ?? nodes.set(id, new HistoryNode(id)).get(id);
    const app = {
        services: {
            byId,
            escapeHtml: value => String(value ?? ''),
            activeStatus: () => false,
            statusText: value => value,
            formatDate: value => value,
            request: async path => {
                requests.push(path);
                return { calls };
            }
        }
    };
    state.runDetail = {
        ...state.runDetail,
        status: 'failed',
        updated_at: 'u1',
        plan: { ...state.runDetail.plan, limits: { timeout: 300 } },
        samples: [
            state.runDetail.samples[0],
            { ...state.runDetail.samples[1], calls: ['f:1'], attempts: [{ status: 'budget_not_admitted', calls: [] }] },
            { sample_id: 'sample-three', task: 'one', round: 2, status: 'api_failure', runner_error: 'SampleTimeout', calls: ['t:1'] }
        ]
    };
    const withRequest = createTaskHistoryView({ app, state, retryRequests: new Map(), retrying: new Set() });
    withRequest.renderDetails();
    expect(requests).toEqual(['./api/bench/runs/run/calls']);
    await new Promise(resolve => setTimeout(resolve, 0));
    const html = nodes.get('bench-run-detail').innerHTML;
    expect(html).toContain('上游返回 response.failed：server_error（connection lost mid-reply）');
    expect(html).toContain('整题超时（300 秒）；最后一次请求：300 秒后等待超时（未收到任何输出）');
    expect(html).toContain('未发出请求');
    expect(html).toContain('data-open-sample="sample-two"');
    expect(html).toContain('第 2 轮');
    // Unchanged run versions do not refetch.
    withRequest.renderDetails();
    expect(requests).toHaveLength(1);
});

test('queued and running records omit unknown usage warnings and duplicate cost labels; finished records report unknown usage once', () => {
    const { nodes, state, view } = fixture();
    const target = state.tasks[0].plan.targets[0];
    const quality = {
        completed_samples: 6,
        unscored_samples: 0,
        unknown_usage_samples: 2,
        unknown_cost_samples: 2,
        prior_unknown_usage_samples: 0,
        prior_unknown_cost_samples: 0
    };
    state.tasks = [
        {
            id: 'task',
            status: 'running',
            plan: { targets: [target], run_count: 2 },
            children: [
                {
                    run_id: 'run',
                    target,
                    status: 'running',
                    sample_count: 36,
                    sample_status_counts: { completed: 6, running: 6, pending: 24 },
                    result_quality: quality,
                    budget: { estimated_uncached_cost_usd: null, max_cost_usd: null }
                },
                {
                    run_id: 'queued-run',
                    target,
                    status: 'queued',
                    sample_count: 36,
                    sample_status_counts: { pending: 36 },
                    result_quality: { ...quality, completed_samples: 0, unknown_usage_samples: 0, unknown_cost_samples: 0 },
                    budget: { estimated_uncached_cost_usd: 0, max_cost_usd: null }
                }
            ]
        }
    ];
    state.taskDetail = state.tasks[0];
    view.renderDetails();
    expect(nodes.get('bench-run-list').innerHTML).not.toContain('累计用量未知');
    expect(nodes.get('bench-run-list').innerHTML).not.toContain('累计费用未知');
    expect(nodes.get('bench-task-detail').innerHTML).not.toContain('累计用量未知');
    expect(nodes.get('bench-task-detail').innerHTML).not.toContain('估算 未记录');
    expect(nodes.get('bench-task-detail').innerHTML).not.toContain('不设 USD 上限');
    state.tasks[0] = {
        ...state.tasks[0],
        status: 'completed',
        children: [{ ...state.tasks[0].children[0], status: 'completed' }]
    };
    state.taskDetail = state.tasks[0];
    view.renderDetails();
    expect(nodes.get('bench-run-list').innerHTML).toContain('2 个累计用量未知');
    expect(nodes.get('bench-run-list').innerHTML).not.toContain('累计费用未知');
    expect(nodes.get('bench-task-detail').innerHTML).toContain('2 个累计用量未知');
    expect(nodes.get('bench-task-detail').innerHTML).not.toContain('累计费用未知');
});

test('history search filters both task list and expanded child runs without leaking unmatched channels', () => {
    const { nodes, state, view } = fixture();
    const devin = { model: 'claude-sonnet-5.5', provider_id: 'homelab', provider_name: 'devin', route_id: 'devin-route', thinking: 'high' };
    const opencode = {
        model: 'claude-sonnet-5.5',
        provider_id: 'homelab',
        provider_name: 'opencode',
        route_id: 'opencode-route',
        thinking: 'high'
    };
    state.tasks = [
        {
            id: 'task-mixed',
            status: 'completed',
            plan: { targets: [devin, opencode], run_count: 2 },
            children: [
                { run_id: 'run-devin', target: devin, status: 'completed', sample_status_counts: { completed: 12 } },
                { run_id: 'run-opencode', target: opencode, status: 'failed', sample_status_counts: { api_failure: 2, completed: 10 } }
            ]
        },
        {
            id: 'task-other',
            status: 'completed',
            plan: { targets: [opencode], run_count: 1 },
            children: [{ run_id: 'run-only-opencode', target: opencode, status: 'completed', sample_status_counts: { completed: 12 } }]
        }
    ];
    state.selectedTaskId = 'task-mixed';
    state.taskDetail = state.tasks[0];
    nodes.get('history-search').value = 'devin';
    view.renderDetails();
    const listHtml = nodes.get('bench-run-list').innerHTML;
    const detailHtml = nodes.get('bench-task-detail').innerHTML;
    expect(listHtml).toContain('task-mixed');
    expect(listHtml).not.toContain('task-other');
    expect(detailHtml).toContain('run-devin');
    expect(detailHtml).not.toContain('run-opencode');
    expect(detailHtml).toContain('仅显示 1 / 2 个匹配子运行');
});

test('status badges, sample cells, and retry labels distinguish timeout, cancelled, interrupted, and api_failure', () => {
    const { nodes, state, view } = fixture();
    state.runDetail = {
        ...state.runDetail,
        status: 'completed',
        retryable_samples: 1,
        sample_status_counts: { completed: 1, timeout: 1 },
        samples: [
            { sample_id: 's-ok', task: 't1', round: 1, status: 'completed', grade: { content_score: 1 } },
            { sample_id: 's-to', task: 't2', round: 1, status: 'api_failure', runner_error: 'SampleTimeout' },
            { sample_id: 's-fail', task: 't3', round: 1, status: 'api_failure' },
            { sample_id: 's-cancel', task: 't4', round: 1, status: 'cancelled' },
            { sample_id: 's-int', task: 't5', round: 1, status: 'interrupted' }
        ]
    };
    view.renderDetails();
    const html = nodes.get('bench-run-detail').innerHTML;
    expect(html).toContain('sample-cell is-timeout');
    expect(html).toContain('sample-cell is-failed');
    expect(html).toContain('sample-cell is-cancelled');
    expect(html).toContain('sample-cell is-interrupted');
    expect(html).toContain('0（超时）');
    expect(nodes.get('bench-retry-run').textContent).toBe('重试未完成样本');

    // Pure cancelled run gets cancelled-specific retry label
    state.runDetail = {
        ...state.runDetail,
        status: 'cancelled',
        retryable_samples: 1,
        samples: [{ sample_id: 's-cancel', task: 't4', round: 1, status: 'cancelled' }]
    };
    view.renderDetails();
    expect(nodes.get('bench-retry-run').textContent).toBe('重跑已取消样本');
});

test('outer task cards show model names and expanded tasks render a model-grouped preview with collapsed full run list', () => {
    const { nodes, state, view } = fixture();
    const mkTarget = (model, display, provider, thinking) => ({
        model,
        model_display_name: display,
        provider_id: 'homelab',
        provider_name: `homelab / ${provider}`,
        route_id: `${provider}:${model}`,
        thinking
    });
    const manyTargets = Array.from({ length: 7 }, (_, i) => mkTarget(`m-${i}`, `Model ${i + 1}`, i % 2 ? 'opencode' : 'codex', 'high'));
    state.tasks = [
        {
            id: 'task-single',
            status: 'running',
            plan: {
                targets: [
                    mkTarget('sonnet', 'Claude Sonnet 5.5', 'claude', 'high'),
                    mkTarget('sonnet', 'Claude Sonnet 5.5', 'claude', 'max')
                ],
                run_count: 2,
                rounds: 3,
                sample_count: 72
            },
            children: [
                {
                    run_id: 'r-1',
                    target: mkTarget('sonnet', 'Claude Sonnet 5.5', 'claude', 'high'),
                    status: 'completed',
                    sample_count: 36,
                    sample_status_counts: { completed: 36 }
                },
                {
                    run_id: 'r-2',
                    target: mkTarget('sonnet', 'Claude Sonnet 5.5', 'claude', 'max'),
                    status: 'running',
                    sample_count: 36,
                    sample_status_counts: { completed: 12, running: 2, pending: 22 }
                }
            ]
        },
        {
            id: 'task-seven',
            status: 'completed',
            plan: { targets: manyTargets, run_count: 7, rounds: 3, sample_count: 252 },
            children: manyTargets.map((target, index) => ({
                run_id: `r-many-${index}`,
                target,
                status: index === 0 ? 'failed' : 'completed',
                sample_count: 36,
                sample_status_counts: index === 0 ? { completed: 30, api_failure: 6 } : { completed: 36 }
            }))
        }
    ];
    state.selectedTaskId = 'task-single';
    state.selectedRunId = null;
    state.taskDetail = state.tasks[0];
    view.renderDetails();
    const listHtml = nodes.get('bench-run-list').innerHTML;
    expect(listHtml).toContain('Claude Sonnet 5.5 · homelab / claude');
    expect(listHtml).toContain('Model 1、Model 2、Model 3、Model 4、Model 5 等 7 个模型');
    const detailHtml = nodes.get('bench-task-detail').innerHTML;
    expect(detailHtml).toContain('class="task-preview"');
    expect(detailHtml).toContain('data-preview-run-id="r-1"');
    expect(detailHtml).toContain('data-preview-run-id="r-2"');
    expect(detailHtml).toContain('12/36');
    expect(detailHtml).toContain('class="raw-block task-all-runs"');
    expect(detailHtml).toContain('全部 2 个独立运行列表');
});

test('run detail defers raw JSON formatting until a disclosure is opened', () => {
    const { state, view, nodes } = fixture();
    const run = {
        id: 'run-lazy',
        status: 'completed',
        plan: { targets: [{ id: 't1', model: 'gpt-test', thinking: 'high' }], limits: { timeout: 600 } },
        budget: { requests: 1, estimated_uncached_cost_usd: 0.01 },
        samples: [
            {
                sample_id: 's-1',
                task: 'K23_HTTP_Conditional_Cache_Precedence',
                round: 1,
                status: 'completed',
                text: 'very-large-model-answer-payload',
                grade: { content_score: 1, outcome: 'correct' },
                usage: { input_tokens: 10, output_tokens: 20 }
            }
        ]
    };
    state.runs = [run];
    state.selectedRunId = 'run-lazy';
    state.runDetail = run;
    view.renderDetails();
    const detail = nodes.get('bench-run-detail');
    expect(detail.innerHTML).toContain('data-lazy-json="run-lazy:s-1:原始回答"');
    expect(detail.innerHTML).not.toContain('very-large-model-answer-payload');
    expect(detail.innerHTML).not.toContain('<pre>');

    const appended = [];
    const fakeDetails = {
        open: true,
        dataset: { lazyJson: 'run-lazy:s-1:原始回答' },
        querySelector: () => null,
        ownerDocument: {
            createElement: tag => ({ tag, textContent: '' })
        },
        append: node => appended.push(node)
    };
    detail.handlers.get('toggle')({ target: fakeDetails });
    expect(appended).toHaveLength(1);
    expect(appended[0].textContent).toContain('very-large-model-answer-payload');
});

test('task preview groups multiple accounts into effort-ordered thinking lanes and surfaces card thinking badge', () => {
    const { state, view, nodes } = fixture();
    const mkTarget = (account_ref, thinking, account_evidence = 'gateway_account_binding') => ({
        provider_id: 'bench-mock',
        model: 'bench-mock/gpt-6-luna',
        model_display_name: 'GPT-6 Luna',
        route_id: `r-${account_ref}`,
        account_ref,
        account_evidence,
        thinking
    });
    const multiAcctTask = {
        id: 'task-multi-acct',
        bank_version: '1.0',
        status: 'completed',
        plan: { run_count: 3, rounds: 1 },
        children: [
            {
                run_id: 'r-a-high',
                target: mkTarget('alpha', 'high'),
                status: 'completed',
                sample_count: 12,
                sample_status_counts: { completed: 12 }
            },
            {
                run_id: 'r-b-high',
                target: mkTarget('beta', 'high'),
                status: 'completed',
                sample_count: 12,
                sample_status_counts: { completed: 12 }
            },
            {
                run_id: 'r-a-low',
                target: mkTarget('alpha', 'low'),
                status: 'completed',
                sample_count: 12,
                sample_status_counts: { completed: 12 }
            }
        ]
    };
    const multiAcctSingleThinkTask = {
        id: 'task-multi-acct-medium',
        bank_version: '1.0',
        status: 'running',
        plan: { run_count: 2, rounds: 3 },
        children: [
            {
                run_id: 'r-m-1',
                target: mkTarget('acc-one@example.com', 'medium'),
                status: 'completed',
                sample_count: 36,
                sample_status_counts: { completed: 36 }
            },
            {
                run_id: 'r-m-2',
                target: mkTarget('acc-two@example.com', 'medium'),
                status: 'running',
                sample_count: 36,
                sample_status_counts: { completed: 18, running: 2, pending: 16 }
            }
        ]
    };
    state.tasks = [multiAcctTask, multiAcctSingleThinkTask];
    state.selectedTaskId = 'task-multi-acct';
    state.selectedRunId = 'r-a-high';
    state.taskDetail = multiAcctTask;
    state.runDetail = {
        id: 'r-a-high',
        task_id: 'task-multi-acct',
        bank_version: '1.0',
        status: 'completed',
        plan: { bank_version: '1.0', targets: [mkTarget('alpha', 'high')] },
        samples: [{ sample_id: 's-1', task: 't1', round: 1, status: 'completed', grade: { content_score: 1 } }]
    };
    view.renderDetails();
    const html = nodes.get('bench-task-detail').innerHTML;
    expect(html.indexOf('data-thinking-lane="low"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-thinking-lane="high"')).toBeGreaterThan(html.indexOf('data-thinking-lane="low"'));
    expect(html).toContain('<code class="task-thinking-rail-value">low</code><span class="task-thinking-rail-stat">1/1 完成</span>');
    expect(html).toContain('<code class="task-thinking-rail-value">high</code><span class="task-thinking-rail-stat">2/2 完成</span>');
    expect(html).toContain('<span class="task-preview-chip-label">alpha</span>');
    expect(html).toContain('<span class="task-preview-chip-label">beta</span>');
    expect(html).toContain('aria-describedby="history-preview-lane-task-multi-acct-0-0"');
    const listHtml = nodes.get('bench-run-list').innerHTML;
    expect(listHtml).toContain('GPT-6 Luna · bench-mock（2 个账号）');
    expect(listHtml).toContain('class="task-thinking-badge"');
    expect(listHtml).toContain(
        '<code class="task-thinking-code">low</code><span class="task-thinking-sep" aria-hidden="true">·</span><code class="task-thinking-code">high</code>'
    );
    expect(listHtml).toContain('<code class="task-thinking-code">medium</code>');
    const runHtml = nodes.get('bench-run-detail').innerHTML;
    expect(runHtml).toContain('class="run-target-banner"');
    expect(runHtml).toContain('<span class="run-thinking-pill"><span class="run-thinking-pill-prefix">思考</span><code>high</code></span>');
    expect(runHtml).toContain('<span class="run-account-pill">账号 alpha</span>');

    // Multi-account × single thinking (e.g. 7 accounts × medium) keeps medium explicitly visible on the lane rail.
    state.selectedTaskId = 'task-multi-acct-medium';
    state.selectedRunId = null;
    state.taskDetail = multiAcctSingleThinkTask;
    state.runDetail = null;
    view.renderDetails();
    const singleThinkHtml = nodes.get('bench-task-detail').innerHTML;
    expect(singleThinkHtml).toContain('data-thinking-lane="medium"');
    expect(singleThinkHtml).toContain(
        '<code class="task-thinking-rail-value">medium</code><span class="task-thinking-rail-stat">1/2 完成</span>'
    );
});

test('task preview labels gateway-binding accounts as 自动分配 and single-pinned tasks show account in headline', () => {
    const { state, view, nodes } = fixture();
    const pinnedTask = {
        id: 'task-single-pin',
        status: 'completed',
        plan: { run_count: 1, rounds: 1 },
        children: [
            {
                run_id: 'r-pin',
                target: {
                    provider_id: 'openai',
                    model: 'openai/gpt-5.4',
                    model_display_name: 'GPT-5.4',
                    route_id: 'r-pin',
                    account_ref: 'team-a',
                    account_evidence: 'gateway_account_binding',
                    thinking: 'high'
                },
                status: 'completed',
                sample_count: 12,
                sample_status_counts: { completed: 12 }
            }
        ]
    };
    const mixedDefaultTask = {
        id: 'task-mixed-auto',
        status: 'completed',
        plan: { run_count: 2, rounds: 1 },
        children: [
            {
                run_id: 'r-auto',
                target: {
                    provider_id: 'openai',
                    model: 'openai/gpt-5.4',
                    model_display_name: 'GPT-5.4',
                    route_id: 'r-auto',
                    account_ref: 'gateway-default',
                    account_evidence: 'gateway_binding',
                    thinking: 'default'
                },
                status: 'completed',
                sample_count: 12,
                sample_status_counts: { completed: 12 }
            },
            {
                run_id: 'r-fixed',
                target: {
                    provider_id: 'openai',
                    model: 'openai/gpt-5.4',
                    model_display_name: 'GPT-5.4',
                    route_id: 'r-fixed',
                    account_ref: 'team-a',
                    account_evidence: 'gateway_account_binding',
                    thinking: 'default'
                },
                status: 'completed',
                sample_count: 12,
                sample_status_counts: { completed: 12 }
            }
        ]
    };
    state.tasks = [pinnedTask, mixedDefaultTask];
    state.selectedTaskId = 'task-mixed-auto';
    state.selectedRunId = null;
    state.taskDetail = mixedDefaultTask;
    view.renderDetails();
    expect(nodes.get('bench-run-list').innerHTML).toContain('GPT-5.4 · openai / team-a');
    expect(nodes.get('bench-task-detail').innerHTML).toContain('<code class="task-thinking-rail-value">默认</code>');
    expect(nodes.get('bench-task-detail').innerHTML).toContain('<span class="task-preview-chip-label">自动分配</span>');
    expect(nodes.get('bench-task-detail').innerHTML).toContain('<span class="task-preview-chip-label">team-a</span>');
    nodes.get('history-search').value = '默认';
    nodes.get('history-search').handlers.get('input')();
    expect(nodes.get('bench-run-list').innerHTML).toContain('task-mixed-auto');
    expect(nodes.get('bench-run-list').innerHTML).not.toContain('task-single-pin');
});

test('task card surfaces channel badges, non-zero status pills, and channel-pod preview with progress fills', () => {
    const { state, view, nodes } = fixture();
    const multiChannelTask = {
        id: 'ea058bae56394729aee044cb7c83e0e2',
        status: 'running',
        created_at: '2026-11-22T01:14:24Z',
        plan: { run_count: 5, rounds: 3, sample_count: 180, run_concurrency: 2, sample_concurrency: 4 },
        children: [
            {
                run_id: 'r-g-run',
                target: {
                    provider_id: 'google',
                    model: 'google/gemini-4-neon',
                    model_display_name: 'Gemini 4 Neon',
                    account_ref: 'gateway-default',
                    account_evidence: 'gateway_binding',
                    thinking: 'high'
                },
                status: 'running',
                sample_count: 36,
                sample_status_counts: { completed: 18, running: 4, pending: 14 }
            },
            {
                run_id: 'r-g-queue',
                target: {
                    provider_id: 'google',
                    model: 'google/gemini-4-neon',
                    model_display_name: 'Gemini 4 Neon',
                    account_ref: 'gateway-default',
                    account_evidence: 'gateway_binding',
                    thinking: 'low'
                },
                status: 'queued',
                sample_count: 36,
                sample_status_counts: { pending: 36 }
            },
            {
                run_id: 'r-or-fail',
                target: {
                    provider_id: 'openrouter',
                    model: 'openrouter/gemini-4-neon',
                    model_display_name: 'Gemini 4 Neon',
                    account_ref: 'prod-key-2',
                    account_evidence: 'gateway_account_binding',
                    thinking: 'high'
                },
                status: 'failed',
                sample_count: 36,
                sample_status_counts: { completed: 12, api_failure: 4, pending: 20 }
            },
            {
                run_id: 'r-rem-ok',
                target: {
                    provider_id: 'tokyo-node',
                    model: 'tokyo-node/openai/gpt-5.2',
                    model_display_name: 'GPT-5.2',
                    account_ref: 'gateway-default',
                    account_evidence: 'gateway_binding',
                    remote_route: { namespace: 'openai', evidence: 'magpie_via' },
                    thinking: 'high'
                },
                status: 'completed',
                sample_count: 36,
                sample_status_counts: { completed: 36 }
            },
            {
                run_id: 'r-rem-int',
                target: {
                    provider_id: 'tokyo-node',
                    model: 'tokyo-node/openai/gpt-5.2',
                    model_display_name: 'GPT-5.2',
                    account_ref: 'gateway-default',
                    account_evidence: 'gateway_binding',
                    remote_route: { namespace: 'openai', evidence: 'magpie_via' },
                    thinking: 'medium'
                },
                status: 'interrupted',
                sample_count: 36,
                sample_status_counts: { completed: 10, interrupted: 8, pending: 18 }
            }
        ]
    };
    state.tasks = [multiChannelTask];
    state.selectedTaskId = multiChannelTask.id;
    state.selectedRunId = null;
    state.taskDetail = multiChannelTask;
    view.renderDetails();

    const listHtml = nodes.get('bench-run-list').innerHTML;
    expect(listHtml).toContain('class="task-card-channels"');
    expect(listHtml).toContain('class="task-channel-badge is-running"');
    expect(listHtml).toContain('class="task-channel-badge is-failed"');
    expect(listHtml).toContain('class="task-channel-badge is-interrupted"');
    expect(listHtml).toContain('prod-key-2');
    expect(listHtml).toContain('tokyo-node / openai');
    expect(listHtml).toContain('总计 5');
    expect(listHtml).toContain('运行中 1');
    expect(listHtml).toContain('API 失败 1');
    expect(listHtml).toContain('已中断 1');
    expect(listHtml).not.toContain('已取消 0');
    expect(listHtml).not.toContain('未完成 0');
    expect(listHtml).toContain('class="task-progress-bar"');

    const detailHtml = nodes.get('bench-task-detail').innerHTML;
    expect(detailHtml).toContain('class="channel-pod is-running"');
    expect(detailHtml).toContain('class="channel-pod is-failed"');
    expect(detailHtml).toContain('class="channel-pod is-interrupted"');
    expect(detailHtml).toContain('账号 prod-key-2');
    expect(detailHtml).toContain('自动分配');
    expect(detailHtml).toContain('远端路由');
    expect(detailHtml).toContain('style="--pct:50%"');
    expect(detailHtml).toContain('class="task-preview-chip-fill"');
    expect(detailHtml).toContain('class="task-preview-chip is-queued"');
    expect(detailHtml).toContain('× 失败');
    expect(detailHtml).toContain('‖ 中断');
    expect(detailHtml).toContain('✓ 完成');
});

test('large task history paginates to 40 cards, expands for deep selection, and loads more on demand', () => {
    const { nodes, state, view } = fixture();
    const target = { model: 'model', route_id: 'fixed', thinking: 'high', account_ref: 'account' };
    state.tasks = Array.from({ length: 55 }, (_, index) => ({
        id: `task-${String(index).padStart(3, '0')}`,
        status: 'completed',
        created_at: new Date(2026, 10, 1, 12, 0, index).toISOString(),
        plan: { targets: [target], run_count: 1, rounds: 1 },
        children: [{ run_id: `run-${index}`, target, status: 'completed', sample_count: 12, sample_status_counts: { completed: 12 } }]
    }));
    state.selectedTaskId = null;
    state.selectedRunId = null;
    state.taskDetail = null;
    state.runDetail = null;
    view.renderDetails();
    const list = nodes.get('bench-run-list');
    expect(list.innerHTML.match(/class="history-entry/g)?.length).toBe(40);
    expect(list.innerHTML).toContain('显示更多（已显示 40 / 55 条）');
    // Selecting an entry past index 40 automatically expands the visible window to include it.
    state.selectedTaskId = 'task-002';
    view.renderDetails();
    expect(list.innerHTML).toContain('data-bench-task-id="task-002"');
    // Clicking "show more" expands the full list.
    state.selectedTaskId = null;
    list.handlers.get('click')({
        stopPropagation() {},
        target: { closest: selector => (selector === '[data-history-show-more]' ? { dataset: { historyShowMore: '40' } } : null) }
    });
    expect(list.innerHTML.match(/class="history-entry/g)?.length).toBe(55);
    expect(list.innerHTML).not.toContain('data-history-show-more');
});

test('task history renders task, channel-pod, and run baseline actions, badges, and ineligibility reasons', () => {
    const { nodes, state, view } = fixture();
    const children = [
        {
            run_id: 'ref-promoted',
            target: { id: 't1', provider_id: 'openai-official', model: 'gpt-5.4', thinking: 'high', account_ref: 'gateway-default' },
            status: 'completed',
            sample_count: 36,
            sample_status_counts: { completed: 36 },
            baseline_eligible: true,
            ineligibility_reason: null,
            baseline_id: 'b'.repeat(64)
        },
        {
            run_id: 'ref-eligible',
            target: { id: 't2', provider_id: 'openai-official', model: 'gpt-5.4', thinking: 'medium', account_ref: 'gateway-default' },
            status: 'completed',
            sample_count: 36,
            sample_status_counts: { completed: 36 },
            baseline_eligible: true,
            ineligibility_reason: null,
            baseline_id: null
        },
        {
            run_id: 'third-eligible',
            target: { id: 't3', provider_id: 'proxy-relay', model: 'gpt-5.4', thinking: 'high', account_ref: 'gateway-default' },
            status: 'completed',
            sample_count: 36,
            sample_status_counts: { completed: 36 },
            baseline_eligible: true,
            ineligibility_reason: null,
            baseline_id: null
        },
        {
            run_id: 'third-timeout',
            target: { id: 't4', provider_id: 'proxy-relay', model: 'gpt-5.4', thinking: 'low', account_ref: 'gateway-default' },
            status: 'completed',
            sample_count: 36,
            sample_status_counts: { completed: 34, timeout: 2 },
            baseline_eligible: false,
            ineligibility_reason: 'Assessment baseline: failed or incomplete samples are not scores',
            baseline_id: null
        }
    ];
    const task = {
        id: 'baseline-task',
        status: 'completed',
        plan: { targets: children.map(c => c.target), run_count: 4, rounds: 3 },
        children
    };
    state.tasks = [task];
    state.selectedTaskId = 'baseline-task';
    state.taskDetail = task;
    state.selectedRunId = 'ref-promoted';
    state.runDetail = {
        id: 'ref-promoted',
        task_id: 'baseline-task',
        status: 'completed',
        updated_at: '2026-11-24T00:00:00Z',
        plan: { targets: [children[0].target] },
        samples: [{ sample_id: 's1', task: 'one', round: 1, thinking: 'high', status: 'completed', grade: { content_score: 1 } }]
    };
    view.renderDetails();

    // Outer card shows baseline count pill.
    expect(nodes.get('bench-run-list').innerHTML).toContain('基线 1');

    // Task header shows both remaining promotable count (2) and existing baseline count (1).
    expect(nodes.get('bench-baseline-task').hidden).toBe(false);
    expect(nodes.get('bench-baseline-task').textContent).toBe('设为基线 (2)');
    expect(nodes.get('bench-baseline-task').title).toContain('跳过 1 个不可设为基线的运行：含 2 个超时样本');
    expect(nodes.get('bench-unbaseline-task').hidden).toBe(false);
    expect(nodes.get('bench-unbaseline-task').textContent).toBe('取消基线');

    // Channel-level controls appear for eligible/promoted channels; single-model channels avoid duplicate model buttons,
    // and thinking chips stay compact without inline baseline buttons.
    const taskDetailHtml = nodes.get('bench-task-detail').innerHTML;
    expect(taskDetailHtml).toContain('data-baseline-level="channel"');
    expect(taskDetailHtml).toContain('data-baseline-promote-runs="ref-eligible"');
    expect(taskDetailHtml).toContain('aria-label="openai-official 设为基线 (1)"');
    expect(taskDetailHtml).toContain(`data-baseline-demote-ids="${'b'.repeat(64)}"`);
    expect(taskDetailHtml).toContain('aria-label="openai-official 取消基线 (1)"');
    expect(taskDetailHtml).toContain('data-baseline-promote-runs="third-eligible"');
    expect(taskDetailHtml).toContain('aria-label="proxy-relay 设为基线 (1)"');
    expect(taskDetailHtml).not.toContain('data-baseline-level="model"');
    expect(taskDetailHtml).not.toContain('task-chip-baseline');
    expect(taskDetailHtml).not.toContain('task-preview-chip-pair');
    expect(taskDetailHtml).toContain('不可设为基线：含 2 个超时样本');
    expect(taskDetailHtml).toContain('task-preview-chip is-completed is-baseline');
    expect(taskDetailHtml).toContain(
        '<span class="task-preview-chip-baseline"><i class="task-baseline-sq" aria-hidden="true"></i><span class="visually-hidden">已设基线</span></span><span class="task-preview-chip-label">high</span><span class="task-preview-chip-state">✓ 完成</span>'
    );
    expect(taskDetailHtml).toContain('task-baseline-inline');

    // Selected promoted run surfaces unbaseline button and banner pill.
    expect(nodes.get('bench-baseline-run').hidden).toBe(true);
    expect(nodes.get('bench-unbaseline-run').hidden).toBe(false);
    expect(nodes.get('bench-run-detail').innerHTML).toContain('run-baseline-pill');

    // Switching to completed ineligible run keeps baseline button visible as aria-disabled with reason.
    state.selectedRunId = 'third-timeout';
    state.runDetail = {
        id: 'third-timeout',
        task_id: 'baseline-task',
        status: 'completed',
        updated_at: '2026-11-24T00:00:00Z',
        sample_status_counts: { completed: 34, timeout: 2 },
        plan: { targets: [children[3].target] },
        samples: []
    };
    view.renderDetails();
    expect(nodes.get('bench-baseline-run').hidden).toBe(false);
    expect(nodes.get('bench-baseline-run').getAttribute('aria-disabled')).toBe('true');
    expect(nodes.get('bench-baseline-run').dataset.baselineIneligibleReason).toBe('含 2 个超时样本');
    expect(nodes.get('bench-baseline-run').title).toBe('不可设为基线：含 2 个超时样本');
    expect(nodes.get('bench-unbaseline-run').hidden).toBe(true);
    expect(nodes.get('bench-run-detail').innerHTML).toContain('run-baseline-note');
    expect(nodes.get('bench-run-detail').innerHTML).toContain('不可设为基线：含 2 个超时样本');
});

test('abnormal tasks support healthy channel/model promotion without cluttering chips or ineligible scopes', () => {
    const { nodes, state, view } = fixture();
    const children = [
        {
            run_id: 'ab-ok-hi',
            target: { id: 't1', provider_id: 'devin', model: 'swe-2', thinking: 'high', account_ref: 'acct-a' },
            status: 'completed',
            sample_count: 36,
            sample_status_counts: { completed: 36 },
            baseline_eligible: true,
            ineligibility_reason: null,
            baseline_id: null
        },
        {
            run_id: 'ab-ok-hi-b',
            target: { id: 't2', provider_id: 'devin', model: 'swe-2', thinking: 'high', account_ref: 'acct-b' },
            status: 'failed',
            sample_count: 36,
            sample_status_counts: { completed: 30, api_failure: 6 },
            baseline_eligible: false,
            ineligibility_reason: 'Assessment baseline: run must be completed',
            baseline_id: null
        },
        {
            run_id: 'ab-bad-med',
            target: { id: 't3', provider_id: 'devin', model: 'swe-2-flash', thinking: 'medium', account_ref: 'acct-a' },
            status: 'completed',
            sample_count: 36,
            sample_status_counts: { completed: 36 },
            baseline_eligible: false,
            ineligibility_reason: 'Assessment baseline: retry execution sources differ; retained for analysis, not baseline promotion',
            baseline_id: null
        }
    ];
    const abnormalTask = {
        id: 'abnormal-task',
        status: 'failed',
        plan: { targets: children.map(c => c.target), run_count: 3, rounds: 3 },
        children
    };
    state.tasks = [abnormalTask];
    state.selectedTaskId = 'abnormal-task';
    state.taskDetail = abnormalTask;
    state.selectedRunId = null;
    state.runDetail = null;
    view.renderDetails();

    // Even when parent task failed, healthy child run stays promotable at task, channel, and model levels.
    expect(nodes.get('bench-baseline-task').hidden).toBe(false);
    expect(nodes.get('bench-baseline-task').getAttribute('aria-disabled')).toBeNull();
    expect(nodes.get('bench-baseline-task').textContent).toBe('设为基线 (1)');
    expect(nodes.get('bench-baseline-task').title).toContain('含 6 个 API 失败样本');
    expect(nodes.get('bench-baseline-task').title).toContain('重试时源码版本发生变化');

    const html = nodes.get('bench-task-detail').innerHTML;
    // Multi-model channel surfaces a model-level action only for the model with promotable runs.
    expect(html).toContain('data-baseline-level="model"');
    expect(html).toContain('aria-label="devin swe-2 设为基线 (1)"');
    // Fully ineligible model omits disabled baseline buttons, while chip tooltips retain specific reasons.
    expect(html).not.toContain('devin swe-2-flash 不可设为基线');
    expect(html).not.toContain('task-chip-baseline');
    expect(html).not.toContain('task-thinking-rail-actions');
    expect(html).toContain('不可设为基线：含 6 个 API 失败样本');
    expect(html).toContain('不可设为基线：重试时源码版本发生变化');

    // All-ineligible task keeps one task-level aria-disabled button with aggregated reason and omits pod/model buttons.
    const allBadTask = {
        id: 'all-bad-task',
        status: 'failed',
        plan: { targets: [children[1].target, children[2].target], run_count: 2, rounds: 3 },
        children: [children[1], children[2]]
    };
    state.tasks = [allBadTask];
    state.selectedTaskId = 'all-bad-task';
    state.taskDetail = allBadTask;
    view.renderDetails();
    expect(nodes.get('bench-baseline-task').hidden).toBe(false);
    expect(nodes.get('bench-baseline-task').getAttribute('aria-disabled')).toBe('true');
    expect(nodes.get('bench-baseline-task').title).toBe('不可设为基线：含 6 个 API 失败样本；重试时源码版本发生变化');
    expect(nodes.get('bench-task-detail').innerHTML).not.toContain('data-baseline-level=');
});

test('cancelling and queued states render distinct non-running tones across cards, pods, chips and legends', () => {
    const { nodes, state, view } = fixture();
    const cancellingTask = {
        id: 'task-cancelling',
        status: 'cancelling',
        created_at: '2026-11-25T07:00:00Z',
        plan: {
            targets: [
                { id: 't-cancel', provider_id: 'ch-alpha', model: 'deepseek-r1', thinking: 'high', account_ref: 'acct-1' },
                { id: 't-queue', provider_id: 'ch-beta', model: 'qwen-max', thinking: 'medium', account_ref: 'acct-2' }
            ],
            run_count: 2,
            rounds: 3,
            sample_count: 72
        },
        children: [
            {
                run_id: 'run-cancelling',
                target: { id: 't-cancel', provider_id: 'ch-alpha', model: 'deepseek-r1', thinking: 'high', account_ref: 'acct-1' },
                status: 'cancelling',
                sample_count: 36,
                sample_status_counts: { completed: 12, running: 2, pending: 22 }
            },
            {
                run_id: 'run-queued',
                target: { id: 't-queue', provider_id: 'ch-beta', model: 'qwen-max', thinking: 'medium', account_ref: 'acct-2' },
                status: 'queued',
                sample_count: 36,
                sample_status_counts: { pending: 36 }
            }
        ]
    };
    const queuedTask = {
        id: 'task-queued',
        status: 'queued',
        created_at: '2026-11-25T06:59:00Z',
        plan: {
            targets: [{ id: 't-q2', provider_id: 'ch-gamma', model: 'gpt-5', thinking: 'low', account_ref: 'acct-3' }],
            run_count: 1,
            rounds: 1,
            sample_count: 12
        },
        children: [
            {
                run_id: 'run-queued-only',
                target: { id: 't-q2', provider_id: 'ch-gamma', model: 'gpt-5', thinking: 'low', account_ref: 'acct-3' },
                status: 'queued',
                sample_count: 12,
                sample_status_counts: { pending: 12 }
            }
        ]
    };
    state.tasks = [cancellingTask, queuedTask];
    state.selectedTaskId = cancellingTask.id;
    state.taskDetail = cancellingTask;
    state.selectedRunId = null;
    state.runDetail = null;
    view.renderDetails();

    const listHtml = nodes.get('bench-run-list').innerHTML;
    expect(listHtml).toContain('class="run-list-status is-cancelling"><i class="task-dot is-cancelling" aria-hidden="true"></i>cancelling');
    expect(listHtml).toContain('class="run-list-status is-queued"><i class="task-dot is-queued" aria-hidden="true"></i>queued');
    expect(listHtml).toContain('class="task-channel-badge is-cancelling"');
    expect(listHtml).toContain('class="task-channel-badge is-queued"');
    expect(listHtml).toContain('class="task-count-pill is-cancelling"');
    expect(listHtml).toContain('取消中 1');
    expect(listHtml).toContain('class="task-count-pill is-queued"');
    expect(listHtml).toContain('class="task-progress-seg is-cancelling"');
    expect(listHtml).not.toContain('task-dot is-cancelling is-pulse');

    const detailHtml = nodes.get('bench-task-detail').innerHTML;
    expect(detailHtml).toContain('class="channel-pod is-cancelling"');
    expect(detailHtml).toContain('class="channel-pod-status is-cancelling"');
    expect(detailHtml).toContain('class="channel-pod is-queued"');
    expect(detailHtml).toContain('class="channel-pod-status is-queued"');
    expect(detailHtml).toContain('class="task-preview-chip is-cancelling"');
    expect(detailHtml).toContain('取消中 12/36');
    expect(detailHtml).not.toContain('task-preview-chip-fill');
    expect(detailHtml).toContain('class="task-preview-legend-item"><i class="task-dot is-cancelling" aria-hidden="true"></i>取消中');
});
