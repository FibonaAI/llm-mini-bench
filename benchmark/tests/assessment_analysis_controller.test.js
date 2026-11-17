import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createAppContext } from '../web/app-context.js';
import { createAnalysisModel, attachAnalysisBatchIds } from '../web/analysis-model.js';
import { assessmentChartMetric, observationQualitySummary } from '../web/assessment-chart-metric.js';
import { selectAnalysisHistoryRecords } from '../web/analysis-history.js';
import { renderAnalysisRecordList } from '../web/analysis-record-list.js';

class ControllerNode {
    value = '';
    checked = false;
    hidden = false;
    textContent = '';
    innerHTML = '';
    dataset = {};
    handlers = new Map();
    addEventListener(name, handler) {
        this.handlers.set(name, handler);
    }
    emit(name) {
        return this.handlers.get(name)?.({ target: this });
    }
    setAttribute() {}
    focus() {}
    querySelectorAll() {
        return [];
    }
}

test('analysis redraw events reuse derived metrics; source, bank and axes invalidate explicitly', async () => {
    const nodes = new Map(),
        listeners = new Map(),
        metricCalls = [],
        renders = [],
        renderOptions = [];
    const element = id => {
        if (!nodes.has(id)) nodes.set(id, new ControllerNode());
        return nodes.get(id);
    };
    element('chart-axis').value = 'cost';
    element('chart-color-by').value = 'series';
    const ids = Array.from({ length: 14 }, (_, index) => `task-${index}`);
    let taskReads = 0;
    const tasks = ids.map(task_id => ({ task_id, samples: [{ round: 1, status: 'completed', content_score: 0.5 }] }));
    const observations = ['one', 'repeat'].map(id => ({
        id,
        run_id: `run-${id}`,
        model: 'model',
        thinking: 'high',
        source: 'run',
        bank_version: '1.0',
        bank_scope: 'whole',
        status: 'completed',
        rounds: 1,
        sample_count: 14,
        estimated_cost_usd: 0.1,
        usage: { input_tokens: 10, output_tokens: 5 },
        get tasks() {
            taskReads++;
            return tasks;
        }
    }));
    const services = {
        byId: element,
        finite: Number.isFinite,
        escapeHtml: value => String(value ?? ''),
        notify() {},
        available: true,
        formatDate: value => value,
        statusText: value => value,
        request: async () => ({ observations: [...observations] })
    };
    const events = {
        addEventListener(name, handler) {
            (listeners.get(name) || listeners.set(name, []).get(name)).push(handler);
        },
        removeEventListener() {},
        dispatchEvent(event) {
            return Promise.all((listeners.get(event.type) || []).map(handler => handler(event)));
        }
    };
    const app = createAppContext(services, events);
    app.setBank({ version: '1.0', tasks: ids.map(id => ({ id })) });
    let select;
    let themeMutation;
    let systemTheme;
    const chart = {
        registerCatalog() {},
        render: (records, options) => {
            renders.push(records);
            renderOptions.push(options);
        },
        resetZoom() {},
        zoom() {}
    };
    const context = vm.createContext({
        getAppContext: () => app,
        createAnalysisModel: () =>
            createAnalysisModel({
                deriveMetric: (...args) => {
                    metricCalls.push(args);
                    return assessmentChartMetric(...args);
                }
            }),
        attachAnalysisBatchIds,
        selectAnalysisHistoryRecords,
        renderAnalysisRecordList,
        observationQualitySummary,
        createAnalysisFilters: () => ({ matches: () => true, setRecords() {}, reset() {}, setSource() {}, focus() {} }),
        createAnalysisPopover: (_, panel) => ({
            setOpen: open => {
                panel.hidden = !open;
            },
            position() {},
            close() {}
        }),
        createScoreCostChart: (_, options) => {
            select = options.onSelect;
            return chart;
        },
        selectionKey: record => record.id,
        thinkingLabel: value => value,
        document: { documentElement: {}, addEventListener() {} },
        window: {
            matchMedia: () => ({
                addEventListener: (_, callback) => {
                    systemTheme = callback;
                }
            })
        },
        MutationObserver: class {
            constructor(callback) {
                themeMutation = callback;
            }
            observe() {}
        },
        location: { hash: '' },
        setTimeout,
        console
    });
    const source = readFileSync(new URL('../web/analysis.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '')
        .replace('if (available) loadObservations();', '');
    vm.runInContext(source, context);
    await app.emit('mini-bench:refresh');
    expect(metricCalls).toHaveLength(2);
    expect(renders.at(-1).map(record => record.id)).toEqual(['one', 'repeat']);
    select('one');
    const readsAfterSelection = taskReads;
    for (const id of ['chart-color-by', 'log-axis', 'point-labels', 'pareto-line']) element(id).emit('change');
    await app.emit('mini-bench:theme-changed');
    themeMutation();
    systemTheme();
    app.setHistory([{ id: 'batch', children: [{ run_id: 'run-one' }] }]);
    await app.emit('mini-bench:routes-changed');
    expect(metricCalls).toHaveLength(2);
    expect(taskReads).toBe(readsAfterSelection);
    expect(renders.at(-1)[0].task_id).toBe('batch');
    element('chart-axis').value = 'tokens';
    element('chart-axis').emit('change');
    expect(metricCalls).toHaveLength(4);
    expect(renders.at(-1)[0].cost).toBe(15);
    element('chart-axis').value = 'cost';
    element('chart-axis').emit('change');
    expect(metricCalls).toHaveLength(4);
    app.setBank({ version: '1.0', tasks: ids.map(id => ({ id, title: 'label change' })) });
    expect(metricCalls).toHaveLength(4);
    app.setBank({ version: '1.0', tasks: ids.slice(1).map(id => ({ id })) });
    expect(metricCalls).toHaveLength(6);
    expect(renders.at(-1).every(record => record.score === null)).toBe(true);
    await app.emit('mini-bench:refresh');
    expect(metricCalls).toHaveLength(8);
    for (const [index, record] of observations.entries())
        Object.assign(record, { created_at: `2026-11-0${index + 1}T12:00:00Z`, provider_id: 'channel', account_ref: 'account' });
    await app.emit('mini-bench:refresh');
    expect(metricCalls).toHaveLength(10);
    expect(renders.at(-1).map(record => record.id)).toEqual(['repeat']);
    expect(renderOptions.at(-1).historyRecords.map(record => record.id)).toEqual(['one', 'repeat']);
    element('chart-color-by').value = 'time';
    element('chart-color-by').emit('change');
    expect(renderOptions.at(-1).colorBy).toBe('time');
    expect(renderOptions.at(-1).historyRecords).toHaveLength(2);
    expect(metricCalls).toHaveLength(10);
    element('analysis-data-all').emit('change');
    expect(renders.at(-1).map(record => record.id)).toEqual(['repeat', 'one']);
    element('analysis-data-selected').emit('change');
    expect(renders.at(-1)).toHaveLength(0);
    const checkbox = { checked: true, dataset: { historyRecord: 'one' } };
    element('analysis-history-options').handlers.get('change')({ target: { closest: () => checkbox } });
    expect(renders.at(-1).map(record => record.id)).toEqual(['one']);
    element('analysis-data-latest').emit('change');
    expect(renders.at(-1).map(record => record.id)).toEqual(['repeat']);
    element('analysis-data-selected').emit('change');
    expect(renders.at(-1).map(record => record.id)).toEqual(['one']);
    expect(metricCalls).toHaveLength(10);
});
