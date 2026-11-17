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
