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
                bank_version: '1.0',
                status: 'completed',
                plan: { bank_version: '1.0', targets: [target], run_count: 1 },
                children: [{ run_id: 'run', bank_version: '1.0', target, status: 'completed' }]
            }
        ],
        runs: [],
        taskDetail: null,
        runDetail: {
            id: 'run',
            task_id: 'task',
            bank_version: '1.0',
            status: 'completed',
            plan: { bank_version: '1.0', targets: [target] },
            samples: [
                { sample_id: 'sample-one', task: 'one', round: 1, thinking: 'high', status: 'completed', grade: { content_score: 0.5 } },
                { sample_id: 'sample-two', task: 'two', round: 1, thinking: 'high', status: 'api_failure' }
            ]
        }
    };
    const app = {
        bank: { version: '1.0' },
        services: {
            byId,
            escapeHtml: value => String(value ?? ''),
            activeStatus: status => ['queued', 'running'].includes(status),
            statusText: value => value,
            formatDate: value => value
        }
    };
    const view = createTaskHistoryView({ app, state, retryRequests: new Map(), retrying: new Set() });
    return { nodes, detached, state, view, app };
}

function clickRunDetail(nodes, selector, dataset) {
    nodes.get('bench-run-detail').handlers.get('click')({
        target: {
            closest: s => (s === selector ? { dataset } : null)
        }
    });
}

function clickTaskDetail(nodes, selector, dataset) {
    nodes.get('bench-task-detail').handlers.get('click')({
        stopPropagation() {},
        target: {
            closest: s => (s === selector ? { dataset } : null)
        }
    });
}

test('task history keeps the same detached sections and open inline inspector across redraws', () => {
    const { nodes, detached, state, view } = fixture();
    view.renderDetails();
    const taskSection = nodes.get('bench-task-section'),
        runSection = nodes.get('bench-run-section');
    expect(taskSection.parentSlot).toBe('data-inline-task="task"');
    expect(runSection.parentSlot).toBe('data-inline-run="run"');
    expect(taskSection.classList.contains('is-single-run-task')).toBe(true);
    clickRunDetail(nodes, '[data-open-sample]', { openSample: 'sample-one' });
    expect(nodes.get('bench-run-detail').innerHTML).toContain('data-inspector-sample="sample-one"');
    // DOM lookup cannot see sections detached by history innerHTML replacement.
    for (const id of ['bench-task-section', 'bench-run-section', 'bench-run-detail', 'bench-task-detail']) detached.add(id);
    state.runDetail = { ...state.runDetail, samples: state.runDetail.samples.map(sample => ({ ...sample })) };
    view.renderDetails();
    expect(view.taskSection).toBe(taskSection);
    expect(view.runSection).toBe(runSection);
    expect(nodes.get('bench-run-detail').innerHTML).toContain('data-inspector-sample="sample-one"');
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
    expect(nodes.get('bench-task-detail').innerHTML).toContain('data-inline-run="run"');
    expect(nodes.get('bench-run-list').innerHTML).toContain('aria-expanded="true"');
});

test('completed sample diagnostics distinguish parser ambiguity, zero scores and missing cumulative usage', () => {
    const { nodes, state, view } = fixture();
    state.runDetail.samples = [
        {
            sample_id: 'ambiguous',
            task: 't-ambig',
            round: 1,
            status: 'completed',
            grade: { content_score: null, outcome: 'ambiguous' },
            text: '{"answer":1} explanation {invalid}'
        },
        { sample_id: 'ungradable', task: 't-ungrad', round: 1, status: 'completed', grade: { content_score: null, outcome: 'ungradable' } },
        { sample_id: 'missing', task: 't-miss', round: 1, status: 'completed', grade: null },
        {
            sample_id: 'recovered',
            task: 't-rec',
            round: 1,
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
    expect(html).toContain('data-open-sample="recovered"');
    // Opening the recovered sample surfaces missing cumulative usage banner and raw evidence tab.
    clickRunDetail(nodes, '[data-open-sample]', { openSample: 'recovered' });
    const inspHtml = nodes.get('bench-run-detail').innerHTML;
    expect(inspHtml).toContain('累计用量、累计估算费用未知');
    expect(inspHtml).toContain('历次尝试存在缺失记录');
    clickRunDetail(nodes, '[data-si-tab]', { siTab: 'raw' });
    const rawHtml = nodes.get('bench-run-detail').innerHTML;
    expect(rawHtml).toContain('历次尝试（原始记录）');
    expect(rawHtml).toContain('用量与费用');
    expect(rawHtml).toContain('评分结果');
    expect(rawHtml).toContain('data-history-disclosure=');
});

test('known zero usage and cost do not produce missing-accounting warnings', () => {
    const { nodes, state, view } = fixture();
    state.runDetail.samples = [
        {
            sample_id: 'zero',
            task: 't-zero',
            round: 1,
            status: 'completed',
            grade: { content_score: 0 },
            usage: { input_tokens: 0, output_tokens: 0 },
            estimated_uncached_cost_usd: 0
        }
    ];
    view.renderDetails();
    clickRunDetail(nodes, '[data-open-sample]', { openSample: 'zero' });
    const html = nodes.get('bench-run-detail').innerHTML;
    expect(html).toContain('data-inspector-sample="zero"');
    expect(html).not.toContain('累计用量');
    expect(html).not.toContain('累计估算费用');
    expect(html).not.toContain('无法评分');
});

test('searching away the selected task does not discard details or open sample inspector', () => {
    const { nodes, state, view } = fixture();
    view.renderDetails();
    clickRunDetail(nodes, '[data-open-sample]', { openSample: 'sample-two' });
    expect(nodes.get('bench-run-detail').innerHTML).toContain('data-inspector-sample="sample-two"');
    nodes.get('history-search').value = 'not-present';
    nodes.get('history-search').handlers.get('input')();
    expect(nodes.get('bench-run-list').innerHTML).toContain('没有匹配');
    expect(state.selectedTaskId).toBe('task');
    expect(state.selectedRunId).toBe('run');
    expect(nodes.get('bench-run-detail').innerHTML).toContain('data-inspector-sample="sample-two"');
    nodes.get('history-search').value = '';
    nodes.get('history-search').handlers.get('input')();
    expect(nodes.get('bench-run-section').parentSlot).toBe('data-inline-run="run"');
    expect(nodes.get('bench-run-detail').innerHTML).toContain('data-inspector-sample="sample-two"');
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
        bank: { version: '1.0' },
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
    expect(html).toContain('data-open-sample="sample-two"');
    expect(html).toContain('第 2 轮');
    // Unchanged run versions do not refetch call summaries.
    withRequest.renderDetails();
    expect(requests).toHaveLength(1);
    // Opening sample-two shows prior never-sent attempt in the trace inspector and fetches its events once.
    clickRunDetail(nodes, '[data-open-sample]', { openSample: 'sample-two' });
    expect(nodes.get('bench-run-detail').innerHTML).toContain('未发出请求');
    expect(requests).toEqual(['./api/bench/runs/run/calls', './api/bench/runs/run/events?sample_id=sample-two']);
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
            bank_version: '1.0',
            status: 'running',
            plan: { bank_version: '1.0', targets: [target], run_count: 2 },
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
    state.selectedRunId = null;
    view.renderDetails();
    expect(nodes.get('bench-run-list').innerHTML).toContain('2 个累计用量未知');
    expect(nodes.get('bench-run-list').innerHTML).not.toContain('累计费用未知');
    expect(nodes.get('bench-task-detail').innerHTML).toContain('未定价 / 缺失');
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
            bank_version: '1.0',
            status: 'completed',
            plan: { bank_version: '1.0', targets: [devin, opencode], run_count: 2 },
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
    expect(html).toContain('按 0 分计');
    expect(nodes.get('bench-retry-run').textContent).toBe('重试异常样本');

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
            bank_version: '1.0',
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
            bank_version: '1.0',
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
    expect(detailHtml).toContain('class="task-ribbon-pills"');
    expect(detailHtml).toContain('data-preview-run-id="r-1"');
    expect(detailHtml).toContain('data-preview-run-id="r-2"');
    expect(detailHtml).toContain('12/36');
    expect(detailHtml).not.toContain('task-all-runs');
    expect(detailHtml).toContain('class="raw-block task-tech-meta"');
});

test('run detail defers raw JSON formatting until a disclosure is opened', () => {
    const { state, view, nodes } = fixture();
    const run = {
        id: 'run-lazy',
        bank_version: '1.0',
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
    expect(detail.innerHTML).toContain('data-lazy-json="run-lazy:预算与用量原始记录 (JSON)"');
    expect(detail.innerHTML).not.toContain('very-large-model-answer-payload');
    expect(detail.innerHTML).not.toContain('<pre>');

    // Open sample inspector -> Raw JSON tab: raw answer stays deferred until toggled open.
    clickRunDetail(nodes, '[data-open-sample]', { openSample: 's-1' });
    clickRunDetail(nodes, '[data-si-tab]', { siTab: 'raw' });
    expect(detail.innerHTML).toContain('data-lazy-json="run-lazy:si:s-1:原始回答"');
    expect(detail.innerHTML).not.toContain('very-large-model-answer-payload');

    const appended = [];
    const fakeDetails = {
        open: true,
        dataset: { lazyJson: 'run-lazy:si:s-1:原始回答' },
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
    expect(html).toContain('task-run-account">alpha</span>');
    expect(html).toContain('task-run-account">beta</span>');
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

    // Multi-account × single thinking (e.g. 2 accounts × medium) keeps medium explicitly visible in its thinking lane rail.
    state.selectedTaskId = 'task-multi-acct-medium';
    state.selectedRunId = null;
    state.taskDetail = multiAcctSingleThinkTask;
    state.runDetail = null;
    view.renderDetails();
    const singleThinkHtml = nodes.get('bench-task-detail').innerHTML;
    expect(singleThinkHtml).toContain('<code class="task-thinking-rail-value">medium</code>');
    expect(singleThinkHtml).toContain('task-run-account">acc-one@example.com</span>');
    expect(singleThinkHtml).toContain('task-run-account">acc-two@example.com</span>');
});

test('task preview labels gateway-binding accounts as 自动分配 and single-pinned tasks show account in headline', () => {
    const { state, view, nodes } = fixture();
    const pinnedTask = {
        id: 'task-single-pin',
        bank_version: '1.0',
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
        bank_version: '1.0',
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
    expect(nodes.get('bench-task-detail').innerHTML).toContain('task-run-account is-auto">自动分配</span>');
    expect(nodes.get('bench-task-detail').innerHTML).toContain('task-run-account">team-a</span>');
    nodes.get('history-search').value = '默认';
    nodes.get('history-search').handlers.get('input')();
    expect(nodes.get('bench-run-list').innerHTML).toContain('task-mixed-auto');
    expect(nodes.get('bench-run-list').innerHTML).not.toContain('task-single-pin');
});

test('task card surfaces channel badges, non-zero status pills, and channel-pod preview with progress fills', () => {
    const { state, view, nodes } = fixture();
    const multiChannelTask = {
        id: 'ea058bae56394729aee044cb7c83e0e2',
        bank_version: '1.0',
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
    expect(detailHtml).toContain('style="width:50%"');
    expect(detailHtml).toContain('class="task-run-pill-track"');
    expect(detailHtml).toContain('class="task-run-pill is-queued has-cancel"');
    expect(detailHtml).toContain('class="task-run-pill is-failed"');
    expect(detailHtml).toContain('class="task-run-pill is-interrupted"');
    expect(detailHtml).toContain('class="task-run-pill is-completed"');
});

test('large task history paginates to 40 cards, expands for deep selection, and loads more on demand', () => {
    const { nodes, state, view } = fixture();
    const target = { model: 'model', route_id: 'fixed', thinking: 'high', account_ref: 'account' };
    state.tasks = Array.from({ length: 55 }, (_, index) => ({
        id: `task-${String(index).padStart(3, '0')}`,
        bank_version: '1.0',
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
        bank_version: '1.0',
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
        bank_version: '1.0',
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
    expect(taskDetailHtml).toContain('task-run-pill is-completed is-baseline is-selected');
    expect(taskDetailHtml).toContain(
        '<span class="task-run-baseline" title="已设为基线"><i class="task-baseline-sq" aria-hidden="true"></i><span class="visually-hidden">已设基线</span></span>'
    );

    // Selected promoted run surfaces unbaseline button and banner pill.
    expect(nodes.get('bench-baseline-run').hidden).toBe(true);
    expect(nodes.get('bench-unbaseline-run').hidden).toBe(false);
    expect(nodes.get('bench-run-detail').innerHTML).toContain('run-baseline-pill');

    // Switching to completed ineligible run keeps baseline button visible as aria-disabled with reason.
    state.selectedRunId = 'third-timeout';
    state.runDetail = {
        id: 'third-timeout',
        task_id: 'baseline-task',
        bank_version: '1.0',
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
    expect(nodes.get('bench-run-detail').innerHTML).not.toContain('run-baseline-note');
    expect(nodes.get('bench-run-detail').innerHTML).not.toContain('不可设为基线：含 2 个超时样本');
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
    // Channel-pod promotes only the eligible run while row tooltips preserve specific ineligibility reasons.
    expect(html).toContain('data-baseline-level="channel"');
    expect(html).toContain('data-baseline-promote-runs="ab-ok-hi"');
    expect(html).not.toContain('devin swe-2-flash 不可设为基线');
    expect(html).not.toContain('task-chip-baseline');
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
        bank_version: '1.0',
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
        bank_version: '1.0',
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
    expect(detailHtml).toContain('class="task-run-pill is-cancelling has-cancel"');
    expect(detailHtml).toContain('class="task-run-pill is-queued has-cancel"');
    expect(detailHtml).not.toContain('task-run-pill-track');
});

test('task list, preview chip, run detail, matrix, and attention list surface ended_after_submission and no_submission anomalies', async () => {
    const { state, nodes, view } = fixture();
    const target = {
        id: 't-sub',
        provider_id: 'opencode-go',
        model: 'hungerg-free',
        model_display_name: 'HungerG Free',
        thinking: 'default',
        account_ref: 'gateway-default',
        account_evidence: 'gateway_binding'
    };
    const quality = {
        completed_samples: 36,
        unscored_samples: 0,
        timeout_samples: 1,
        model_anomaly_samples: 1,
        non_model_anomaly_samples: 0,
        ended_after_submission_samples: 1,
        ended_after_timeout_samples: 1,
        ended_after_non_model_samples: 0,
        no_submission_samples: 1,
        unknown_usage_samples: 0,
        unknown_cost_samples: 0,
        prior_unknown_usage_samples: 0,
        prior_unknown_cost_samples: 0
    };
    const task = {
        id: 'task-sub-anom',
        bank_version: '1.0',
        status: 'completed',
        created_at: '2026-11-25T09:31:05Z',
        plan: {
            targets: [target],
            run_count: 1,
            rounds: 1,
            sample_count: 3
        },
        children: [
            {
                run_id: 'run-sub-anom',
                target,
                status: 'completed',
                sample_count: 3,
                sample_status_counts: { completed: 3 },
                result_quality: quality
            }
        ]
    };
    const runDetail = {
        id: 'run-sub-anom',
        task_id: 'task-sub-anom',
        bank_version: '1.0',
        status: 'completed',
        updated_at: '2026-11-25T09:31:05Z',
        plan: { targets: [target], limits: { timeout: 600 } },
        sample_count: 3,
        sample_status_counts: { completed: 3 },
        result_quality: quality,
        samples: [
            {
                sample_id: 's-ok',
                task: 'K1',
                round: 1,
                status: 'completed',
                grade: { content_score: 1, outcome: 'ok' },
                usage: { input_tokens: 100, output_tokens: 50 },
                estimated_uncached_cost_usd: 0,
                elapsed_seconds: 12
            },
            {
                sample_id: 's-ended',
                task: 'T2',
                round: 1,
                status: 'completed',
                runner_error: 'SampleTimeout',
                grade: { content_score: 1, outcome: 'ok' },
                answer_submission: {
                    protocol: 'submit-answer-tool-v1',
                    call_id: 'call-1',
                    answer: { ans: 42 },
                    submissions: 1,
                    ended_after_submission: 'SampleTimeout'
                },
                usage: { input_tokens: 200, output_tokens: 80 },
                estimated_uncached_cost_usd: 0,
                elapsed_seconds: 600
            },
            {
                sample_id: 's-nosub',
                task: 'T3',
                round: 1,
                status: 'completed',
                grade: { content_score: 0, outcome: 'no_submission' },
                answer_submission: {
                    protocol: 'submit-answer-tool-v1',
                    call_id: null,
                    answer: null,
                    submissions: 0,
                    ended_after_submission: null
                },
                usage: { input_tokens: 150, output_tokens: 40 },
                estimated_uncached_cost_usd: 0,
                elapsed_seconds: 30
            }
        ]
    };
    state.tasks = [task];
    state.selectedTaskId = task.id;
    state.taskDetail = task;
    state.selectedRunId = runDetail.id;
    state.runDetail = runDetail;
    view.renderDetails();

    const listHtml = nodes.get('bench-run-list').innerHTML;
    expect(listHtml).toContain('超时 1 样本');
    expect(listHtml).toContain('模型异常 1（未提交）');
    // Balanced counts bar: completed child with timeout still counts in 已完成 1, alongside overlay anomaly pill.
    expect(listHtml).toContain('已完成 1');
    expect(listHtml).toContain('含异常 1（1 超时 · 1 未提交）');

    // Single-run task auto-directs straight into its sole child run detail.
    const taskDetailHtml = nodes.get('bench-task-detail').innerHTML;
    expect(nodes.get('bench-task-section').classList.contains('is-single-run-task')).toBe(true);
    expect(taskDetailHtml).toContain('class="task-single-run-slot"');

    const runDetailHtml = nodes.get('bench-run-detail').innerHTML;
    expect(runDetailHtml).toContain('class="run-diag-bar is-warn"');
    expect(runDetailHtml).toContain('提交后超时 1');
    expect(runDetailHtml).toContain('模型异常 1');
    expect(runDetailHtml).toContain('定位异常样本 →');
    expect(runDetailHtml).toContain('class="sample-cell is-full has-anomaly" data-open-sample="s-ended"');
    expect(runDetailHtml).toContain('class="sample-cell is-zero has-anomaly" data-open-sample="s-nosub"');
    expect(runDetailHtml).not.toContain('需要关注的样本');
    expect(runDetailHtml).not.toContain('全部 3 个样本详情');
    expect(runDetailHtml).toContain('仅高亮异常 2');
    expect(runDetailHtml).toContain('异常巡检 0/2');
    expect(runDetailHtml).toContain('超时（提交后超时 · 按最后提交评分）');
    expect(runDetailHtml).toContain('超时：提交后整题超时（SampleTimeout）');
    expect(runDetailHtml).toContain('1 题提交后超时（按最后提交评分，不可设基线）');
    expect(runDetailHtml).toContain('1 题未提交答案（按 0 分计，可设基线）');
    expect(runDetailHtml).toContain('模型异常（未提交答案 · 按 0 分计）');
    // Opening s-ended and checking raw tab exposes answer submission record without duplicating all samples.
    clickRunDetail(nodes, '[data-open-sample]', { openSample: 's-ended' });
    clickRunDetail(nodes, '[data-si-tab]', { siTab: 'raw' });
    expect(nodes.get('bench-run-detail').innerHTML).toContain('答案提交记录');

    // Status filter 'anomalous' matches anomalous tasks and hides clean completed ones.
    const cleanTask = {
        id: 'task-clean',
        status: 'completed',
        created_at: '2026-11-25T09:00:00Z',
        plan: { targets: [target], run_count: 1, rounds: 1, sample_count: 1 },
        children: [{ run_id: 'run-clean', target, status: 'completed', sample_count: 1, sample_status_counts: { completed: 1 } }]
    };
    state.tasks = [task, cleanTask];
    nodes.get('history-status').value = 'anomalous';
    view.renderDetails();
    const filteredHtml = nodes.get('bench-run-list').innerHTML;
    expect(filteredHtml).toContain('task-sub-anom');
    expect(filteredHtml).not.toContain('task-clean');
});

test('inline sample inspector opens below matrix row, adapts default tab, lazily loads session events, and compares rounds', async () => {
    const { state, nodes, app } = fixture();
    const requests = [];
    const mockEventsBySample = {
        's-partial': [
            {
                id: 1,
                run_id: 'run',
                sample_id: 's-partial',
                attempt_id: 'att-1',
                seq: 1,
                kind: 'llm_turn',
                turn: 1,
                api_attempt: 1,
                http_status: 200,
                elapsed_seconds: 12.4,
                first_output_seconds: 1.8,
                usage_known: true,
                input_tokens: 1200,
                output_tokens: 450,
                estimated_cost_usd: 0.0123,
                response_status: 'completed',
                payload: {
                    reasoning_summary: ['Trace yield* delegation'],
                    assistant_text: 'Submitting computed states.',
                    tool_calls: [
                        {
                            call_id: 'tc-1',
                            name: 'submit_answer',
                            arguments: '{"first":1,"second":{"value":5,"done":false},"steps":["I1","BAD"]}'
                        }
                    ]
                }
            },
            {
                id: 2,
                run_id: 'run',
                sample_id: 's-partial',
                attempt_id: 'att-1',
                seq: 2,
                kind: 'tool_result',
                call_id: 'tc-1',
                payload: { name: 'submit_answer', result: { accepted: true } }
            },
            {
                id: 3,
                run_id: 'run',
                sample_id: 's-partial',
                attempt_id: 'att-1',
                seq: 3,
                kind: 'grade',
                elapsed_seconds: 12.4,
                estimated_cost_usd: 0.0123,
                payload: { status: 'completed', outcome: 'graded', content_score: 0.333 }
            }
        ],
        's-nosub': [
            {
                id: 10,
                run_id: 'run',
                sample_id: 's-nosub',
                attempt_id: 'att-old',
                seq: 1,
                kind: 'llm_turn',
                turn: 1,
                api_attempt: 1,
                http_status: 429,
                elapsed_seconds: 2.0,
                error_code: 'rate_limit_exceeded',
                error_message: 'slow down',
                payload: { raw_error_excerpt: '{"error":"429"}' }
            },
            {
                id: 11,
                run_id: 'run',
                sample_id: 's-nosub',
                attempt_id: 'att-old',
                seq: 2,
                kind: 'api_retry',
                turn: 1,
                api_attempt: 2,
                payload: { delay_ms: 1500 }
            },
            {
                id: 12,
                run_id: 'run',
                sample_id: 's-nosub',
                attempt_id: 'att-new',
                seq: 1,
                kind: 'llm_turn',
                turn: 1,
                api_attempt: 1,
                http_status: 200,
                elapsed_seconds: 8.5,
                response_status: 'completed',
                payload: { assistant_text: 'The final answer is 42, forgot tool call.' }
            }
        ]
    };
    app.services.request = async url => {
        requests.push(url);
        if (url.includes('/events')) {
            const sampleId = new URL('http://local/' + url.replace(/^\.\//, '')).searchParams.get('sample_id');
            return { sample_id: sampleId, events: mockEventsBySample[sampleId] || [] };
        }
        return { calls: [] };
    };
    state.banks = [
        {
            version: '1.0',
            tasks: [
                {
                    id: 'C23_Async_Generator_Finally_Override',
                    domain: 'code',
                    title: 'ECMAScript async generator yield* return forwarding',
                    prompt: 'Evaluate the async generator.',
                    grading: {
                        expected: {
                            first: 1,
                            second: { value: 105, done: false },
                            steps: ['I1', 'T1']
                        }
                    }
                }
            ]
        }
    ];
    state.runDetail = {
        id: 'run',
        task_id: 'task',
        status: 'completed',
        updated_at: '2026-11-26T00:00:00Z',
        plan: { bank_version: '1.0', targets: state.runDetail.plan.targets, limits: { timeout: 600 } },
        samples: [
            {
                sample_id: 's-partial',
                task: 'C23_Async_Generator_Finally_Override',
                domain: 'code',
                round: 1,
                status: 'completed',
                elapsed_seconds: 12.4,
                usage: { input_tokens: 1200, output_tokens: 450 },
                estimated_uncached_cost_usd: 0.0123,
                answer_submission: {
                    submissions: 1,
                    answer: { first: 1, second: { value: 5, done: false }, steps: ['I1', 'BAD'] }
                },
                grade: {
                    outcome: 'graded',
                    content_score: 0.333,
                    content_checks: { first: true, second: false, steps: false },
                    instruction_checks: { submitted_via_tool: true }
                }
            },
            {
                sample_id: 's-nosub',
                task: 'C23_Async_Generator_Finally_Override',
                domain: 'code',
                round: 2,
                status: 'completed',
                attempt_id: 'att-new',
                elapsed_seconds: 8.5,
                text: 'The final answer is 42, forgot tool call.',
                attempts: [
                    { attempt_id: 'att-old', status: 'api_failure' },
                    { attempt_id: 'att-new', status: 'completed' }
                ],
                grade: {
                    outcome: 'no_submission',
                    content_score: 0,
                    content_checks: { first: false, second: false, steps: false },
                    instruction_checks: { submitted_via_tool: false }
                }
            }
        ]
    };
    const view = createTaskHistoryView({ app, state, retryRequests: new Set(), retrying: new Set() });
    view.renderDetails();

    // Before clicking any matrix cell, no /events request should fire.
    expect(requests.some(url => url.includes('/events'))).toBe(false);
    const runDetailNode = nodes.get('bench-run-detail');
    const click = runDetailNode.handlers.get('click');
    const makeClickEvent = (attr, val) => ({
        target: {
            closest: selector => {
                if (selector === `[${attr}]`) {
                    const camel = attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                    return { dataset: { [camel]: val } };
                }
                return null;
            }
        }
    });

    // Click partial-score sample -> lands on 判分对照 with diff highlighting + folded passed fields, and lazily fetches /events.
    click(makeClickEvent('data-open-sample', 's-partial'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(requests).toContain('./api/bench/runs/run/events?sample_id=s-partial');
    const gradingHtml = runDetailNode.innerHTML;
    expect(gradingHtml).toContain('sample-inline-inspector');
    expect(gradingHtml).toContain('ECMAScript async generator yield* return forwarding');
    expect(gradingHtml).toContain('si-tok-mismatch');
    expect(gradingHtml).toContain('value: 5');
    expect(gradingHtml).toContain('value: 105');
    expect(gradingHtml).toContain('si-seq-tok is-mismatch');
    expect(gradingHtml).toContain('已折叠 1 个通过字段（first）');

    // Switch to 执行轨迹 tab -> shows reasoning summary, assistant text, paired submit_answer tool call + accepted badge, and grade node.
    click(makeClickEvent('data-si-tab', 'trace'));
    const traceHtml = runDetailNode.innerHTML;
    expect(traceHtml).toContain('Trace yield* delegation');
    expect(traceHtml).toContain('Submitting computed states.');
    expect(traceHtml).toContain('submit_answer');
    expect(traceHtml).toContain('已接受');
    expect(traceHtml).toContain('GRADE');

    // Switch to 多轮对照 -> shows Field × Round comparison matrix.
    click(makeClickEvent('data-si-tab', 'compare'));
    const cmpHtml = runDetailNode.innerHTML;
    expect(cmpHtml).toContain('si-cmp-table');
    expect(cmpHtml).toContain('第 1 轮');
    expect(cmpHtml).toContain('第 2 轮');
    expect(cmpHtml).toContain('未提交');

    // Click anomaly stepper -> jumps to s-nosub, defaults to 执行轨迹, shows multi-attempt switcher + visible prose.
    click(makeClickEvent('data-matrix-step', 'next'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(requests).toContain('./api/bench/runs/run/events?sample_id=s-nosub');
    const nosubHtml = runDetailNode.innerHTML;
    expect(nosubHtml).toContain('未调用 submit_answer（模型异常 · 0 分）');
    expect(nosubHtml).toContain('第 1 次尝试 · 失败');
    expect(nosubHtml).toContain('第 2 次尝试 · 完成（最新）');
    expect(nosubHtml).toContain('The final answer is 42, forgot tool call.');

    // Switch to attempt 1 -> shows 429 error excerpt and api_retry timeline step.
    click(makeClickEvent('data-si-attempt', 'att-old'));
    const att1Html = runDetailNode.innerHTML;
    expect(att1Html).toContain('HTTP 429');
    expect(att1Html).toContain('rate_limit_exceeded');
    expect(att1Html).toContain('退避 1.5s');

    // Close inspector -> removes panel cleanly.
    click(makeClickEvent('data-si-close', '1'));
    expect(runDetailNode.innerHTML).not.toContain('sample-inline-inspector');
});

test('multi-run task comparison table projects per-round cost/tokens, avg sample elapsed, KPI strips, and anomaly filter toggle', () => {
    const { state, view, nodes } = fixture();
    const tFast = {
        id: 't-fast',
        provider_id: 'openai-official',
        model: 'gpt-5.4',
        model_display_name: 'GPT-5.4',
        thinking: 'medium',
        account_ref: 'gateway-default',
        account_evidence: 'gateway_binding'
    };
    const tSlow = {
        id: 't-slow',
        provider_id: 'openai-official',
        model: 'gpt-5.4',
        model_display_name: 'GPT-5.4',
        thinking: 'high',
        account_ref: 'gateway-default',
        account_evidence: 'gateway_binding'
    };
    const multiTask = {
        id: 'task-metrics',
        status: 'completed',
        plan: { targets: [tFast, tSlow], run_count: 2, rounds: 3, run_concurrency: 2, sample_concurrency: 6, sample_count: 72 },
        children: [
            {
                run_id: 'run-clean',
                target: tFast,
                status: 'completed',
                sample_count: 36,
                sample_status_counts: { completed: 36 },
                metrics: {
                    rounds: 3,
                    scored_samples: 36,
                    full_score_samples: 30,
                    partial_score_samples: 3,
                    zero_score_samples: 3,
                    mean_score: 87.5,
                    score_complete: true,
                    elapsed_sample_count: 36,
                    elapsed_seconds_known: 1800,
                    elapsed_seconds_total: 1800,
                    avg_sample_elapsed_seconds: 50,
                    input_tokens: 900000,
                    output_tokens: 300000,
                    total_tokens: 1200000,
                    known_input_tokens_lower_bound: null,
                    known_output_tokens_lower_bound: null,
                    known_total_tokens_lower_bound: null,
                    estimated_cost_usd: 0.9,
                    known_cost_lower_bound_usd: null,
                    unknown_usage_attempts: 0,
                    unknown_cost_attempts: 0
                }
            },
            {
                run_id: 'run-anom',
                target: tSlow,
                status: 'completed',
                sample_count: 36,
                sample_status_counts: { completed: 35, timeout: 1 },
                result_quality: {
                    completed_samples: 35,
                    unscored_samples: 0,
                    timeout_samples: 1,
                    model_anomaly_samples: 1,
                    non_model_anomaly_samples: 0,
                    ended_after_submission_samples: 0,
                    ended_after_timeout_samples: 0,
                    ended_after_non_model_samples: 0,
                    no_submission_samples: 1,
                    unknown_usage_attempts: 0,
                    unknown_cost_attempts: 0
                },
                metrics: {
                    rounds: 3,
                    scored_samples: 36,
                    full_score_samples: 24,
                    partial_score_samples: 6,
                    zero_score_samples: 6,
                    mean_score: 75,
                    score_complete: true,
                    elapsed_sample_count: 36,
                    elapsed_seconds_known: 5400,
                    elapsed_seconds_total: 5400,
                    avg_sample_elapsed_seconds: 150,
                    input_tokens: null,
                    output_tokens: null,
                    total_tokens: null,
                    known_input_tokens_lower_bound: 1500000,
                    known_output_tokens_lower_bound: 600000,
                    known_total_tokens_lower_bound: 2100000,
                    estimated_cost_usd: null,
                    known_cost_lower_bound_usd: 1.5,
                    unknown_usage_attempts: 1,
                    unknown_cost_attempts: 1
                }
            }
        ]
    };
    state.tasks = [multiTask];
    state.selectedTaskId = 'task-metrics';
    state.taskDetail = multiTask;
    state.selectedRunId = 'run-clean';
    state.runDetail = {
        id: 'run-clean',
        task_id: 'task-metrics',
        status: 'completed',
        plan: { targets: [tFast], rounds: 3 },
        metrics: multiTask.children[0].metrics,
        samples: [
            { sample_id: 's1', task: 'K23_Alpha', round: 1, status: 'completed', grade: { content_score: 1 }, elapsed_seconds: 40 },
            { sample_id: 's2', task: 'K23_Alpha', round: 2, status: 'completed', grade: { content_score: 0.5 }, elapsed_seconds: 60 }
        ]
    };
    view.renderDetails();

    const taskHtml = nodes.get('bench-task-detail').innerHTML;
    expect(taskHtml).toContain('class="task-inline-bar"');
    expect(taskHtml).toContain('单题均耗 <b>1m 40s</b>');
    expect(taskHtml).toMatch(/总费用 <b class="is-bound">≥ \$/);
    expect(taskHtml).toMatch(/总 Tokens <b class="is-bound">≥ /);
    // Status-focused pills: no inline score / metric strip, no density toggle, no boxed anomaly summary.
    expect(taskHtml).not.toContain('task-run-pill-score');
    expect(taskHtml).not.toContain('task-run-pill-metrics');
    expect(taskHtml).not.toContain('data-task-metric-mode');
    expect(taskHtml).not.toContain('task-tele-');
    expect(taskHtml).toContain('仅看异常 1');
    expect(taskHtml).toContain('全部 2');
    // Full score/metrics stay reachable through the pill tooltip.
    expect(taskHtml).toContain('每轮估算费用 $0.3');
    expect(taskHtml).toContain('≥ $0.5');
    expect(taskHtml).toContain('≥ 700k');

    // Toggle anomaly filter -> hides clean run row, keeps anomalous run row.
    clickTaskDetail(nodes, '[data-task-run-filter]', { taskRunFilter: 'anomaly' });
    const filteredHtml = nodes.get('bench-task-detail').innerHTML;
    expect(filteredHtml).not.toContain('data-preview-run-id="run-clean"');
    expect(filteredHtml).toContain('data-preview-run-id="run-anom"');
    // Switch back to all -> both rows visible again.
    clickTaskDetail(nodes, '[data-task-run-filter]', { taskRunFilter: 'all' });
    expect(nodes.get('bench-task-detail').innerHTML).toContain('data-preview-run-id="run-clean"');

    // Run detail KPI strip & sample matrix avg time column.
    const runHtml = nodes.get('bench-run-detail').innerHTML;
    expect(runHtml).toContain('class="run-kpi-strip"');
    expect(runHtml).toContain('30 满 · 3 部 · 3 零');
    expect(runHtml).toContain('每轮 10m');
    expect(runHtml).toContain('3 轮总计 $0.9');
    expect(runHtml).toContain('入 300k / 出 100k');
    expect(runHtml).toContain('<span role="columnheader" class="sample-matrix-time-head">单题均耗</span>');
    expect(runHtml).toContain('<span role="cell" class="sample-matrix-time">50s</span>');
});

test('history entries fail closed when active bank is unloaded or record lacks bank_version', () => {
    const { state } = fixture();
    const byId = id => new HistoryNode(id);
    const appHolder = {
        bank: null,
        services: {
            byId,
            escapeHtml: value => String(value ?? ''),
            activeStatus: () => false,
            statusText: value => value,
            formatDate: value => value
        }
    };
    state.tasks = [
        { id: 'v2-task', bank_version: '2.0', status: 'completed', plan: { targets: [] }, children: [] },
        { id: 'v1-task', bank_version: '1.0', status: 'completed', plan: { targets: [] }, children: [] },
        { id: 'missing-ver', status: 'completed', plan: { targets: [] }, children: [] }
    ];
    const view = createTaskHistoryView({ app: appHolder, state, retryRequests: new Map(), retrying: new Set() });
    expect(view.historyEntries()).toEqual([]);
    appHolder.bank = { version: '2.0' };
    expect(view.historyEntries().map(e => e.record.id)).toEqual(['v2-task']);
    appHolder.bank = { version: '1.0' };
    expect(view.historyEntries().map(e => e.record.id)).toEqual(['v1-task']);
});

test('multi-target direct runs keep target-aware anomaly navigation and resolve inspector specs by original task id', async () => {
    const { state, nodes, app } = fixture();
    app.services.request = async url => (url.includes('/events') ? { events: [] } : { calls: [] });
    const taskId = 'C23_Async_Generator_Finally_Override';
    state.banks = [
        { version: '1.0', tasks: [{ id: taskId, domain: 'code', title: 'Async generator', prompt: 'Evaluate the async generator.' }] }
    ];
    const targetA = { id: 'ta', model: 'model-a', thinking: 'high' };
    const targetB = { id: 'tb', model: 'model-b', thinking: 'high' };
    state.runs = [];
    state.tasks = [];
    state.selectedTaskId = null;
    state.taskDetail = null;
    state.selectedRunId = 'run-multi';
    state.runDetail = {
        id: 'run-multi',
        bank_version: '1.0',
        status: 'failed',
        updated_at: '2026-11-26T00:00:00Z',
        plan: { bank_version: '1.0', targets: [targetA, targetB], limits: { timeout: 600 } },
        samples: [
            { sample_id: 's-a', target_id: 'ta', task: taskId, round: 1, status: 'api_failure' },
            {
                sample_id: 's-b',
                target_id: 'tb',
                task: taskId,
                round: 1,
                status: 'completed',
                grade: { content_score: 1, instruction_checks: { submitted_via_tool: true } },
                answer_submission: { submissions: 1, answer: {} }
            }
        ]
    };
    const view = createTaskHistoryView({ app, state, retryRequests: new Set(), retrying: new Set() });
    view.renderDetails();
    const runDetailNode = nodes.get('bench-run-detail');
    expect(runDetailNode.innerHTML).toContain('data-matrix-step="next"');

    // The earlier target's failure must stay reachable even though the later target succeeded in the same cell.
    clickRunDetail(nodes, '[data-matrix-step]', { matrixStep: 'next' });
    await new Promise(resolve => setTimeout(resolve, 0));
    const html = runDetailNode.innerHTML;
    expect(html).toContain('sample-inline-inspector');
    expect(html).toContain('data-open-sample="s-a" aria-expanded="true"');
    // The decorated row key must not hide the bank task specification.
    expect(html).toContain('data-si-toggle-prompt');
});
