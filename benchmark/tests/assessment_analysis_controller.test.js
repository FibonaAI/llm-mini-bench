import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createAppContext } from '../web/app-context.js';
import { createAnalysisModel, attachAnalysisBatchIds } from '../web/analysis-model.js';
import { assessmentChartMetric, buildObservationAnomalies, observationQualitySummary } from '../web/assessment-chart-metric.js';
import { selectAnalysisHistoryRecords } from '../web/analysis-history.js';
import { renderAnalysisRecordList } from '../web/analysis-record-list.js';
import { compareRecordToBaseline, dedupePromotedRuns, findMatchingBaselines, findPromotedBaseline } from '../web/baseline-comparison.js';
import { analyzeAnomalies } from '../web/anomaly-analysis.js';

class ControllerNode {
    value = '';
    checked = false;
    hidden = false;
    textContent = '';
    innerHTML = '';
    className = '';
    classList = { toggle() {} };
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
        buildObservationAnomalies,
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
        compareRecordToBaseline,
        dedupePromotedRuns,
        findMatchingBaselines,
        findPromotedBaseline,
        analyzeAnomalies,
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
    expect(renderOptions.at(-1).maskAccounts).toBe(false);
    app.setMaskAccounts(true);
    expect(renderOptions.at(-1).maskAccounts).toBe(true);
    app.setMaskAccounts(false);
    expect(renderOptions.at(-1).maskAccounts).toBe(false);
    expect(metricCalls).toHaveLength(10);
});

test('anomaly insights support collapsing, clean-state guard, progressive pagination, scroll preservation, and Escape clear', async () => {
    const nodes = new Map(),
        listeners = new Map(),
        docHandlers = new Map(),
        renderOptions = [];
    class InsightNode extends ControllerNode {
        open = true;
        scrollTop = 0;
        attrs = new Map();
        classes = new Set();
        classList = {
            toggle: (name, force) => {
                const on = force === undefined ? !this.classes.has(name) : Boolean(force);
                if (on) this.classes.add(name);
                else this.classes.delete(name);
                return on;
            },
            contains: name => this.classes.has(name)
        };
        setAttribute(name, value) {
            this.attrs.set(name, String(value));
        }
        removeAttribute(name) {
            this.attrs.delete(name);
        }
        getAttribute(name) {
            return this.attrs.get(name) ?? null;
        }
        scrollIntoView() {}
    }
    const element = id => {
        if (!nodes.has(id)) nodes.set(id, new InsightNode());
        return nodes.get(id);
    };
    element('chart-axis').value = 'cost';
    element('chart-color-by').value = 'series';
    const taskIds = Array.from({ length: 12 }, (_, idx) => `t-${idx}`);
    const makeTasks = score => taskIds.map(task_id => ({ task_id, samples: [{ round: 1, status: 'completed', content_score: score }] }));
    let observations = [];
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
    app.setBank({ version: '1.0', tasks: taskIds.map(id => ({ id })) });
    const context = vm.createContext({
        getAppContext: () => app,
        createAnalysisModel,
        attachAnalysisBatchIds,
        selectAnalysisHistoryRecords,
        renderAnalysisRecordList,
        buildObservationAnomalies,
        observationQualitySummary,
        createAnalysisFilters: () => ({ matches: () => true, setRecords() {}, reset() {}, setSource() {}, focus() {} }),
        createAnalysisPopover: (_, panel) => ({
            setOpen: open => {
                panel.hidden = !open;
            },
            position() {},
            close() {}
        }),
        createScoreCostChart: () => ({
            registerCatalog() {},
            render: (_, options) => {
                renderOptions.push(options);
            },
            resetZoom() {},
            zoom() {}
        }),
        selectionKey: record => record.id,
        thinkingLabel: value => value,
        compareRecordToBaseline,
        dedupePromotedRuns,
        findMatchingBaselines,
        findPromotedBaseline,
        analyzeAnomalies,
        document: {
            documentElement: {},
            addEventListener(name, handler) {
                docHandlers.set(name, handler);
            }
        },
        window: { matchMedia: () => ({ addEventListener() {} }) },
        MutationObserver: class {
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

    // 1. Clean comparable state: summary is aria-disabled, disclosure stays closed, click is prevented
    observations = ['ch-a', 'ch-b', 'ch-c'].map((ch, idx) => ({
        id: `clean-${idx}`,
        run_id: `run-clean-${idx}`,
        provider_id: ch,
        model: 'gpt-6',
        model_display_name: 'GPT-6',
        thinking: 'high',
        source: 'run',
        bank_version: '1.0',
        bank_scope: 'whole',
        status: 'completed',
        rounds: 1,
        sample_count: 12,
        estimated_cost_usd: 0.2,
        usage: { input_tokens: 100, output_tokens: 100 },
        tasks: makeTasks(0.9)
    }));
    await app.emit('mini-bench:refresh');
    expect(element('analysis-insights').hidden).toBe(false);
    expect(element('analysis-insights').classList.contains('is-clean')).toBe(true);
    expect(element('analysis-insights-disclosure').open).toBe(false);
    expect(element('analysis-insights-summary').getAttribute('aria-disabled')).toBe('true');
    expect(element('analysis-insights-toggle-hint').hidden).toBe(true);
    let prevented = false;
    element('analysis-insights-summary').handlers.get('click')({
        preventDefault() {
            prevented = true;
        }
    });
    expect(prevented).toBe(true);

    // 2. High-volume anomalies: 20 anomalous accounts + 1 multi-model degraded channel (22 model items)
    const highVolume = [];
    for (let i = 0; i < 20; i++) {
        highVolume.push({
            id: `base-acc-${i}`,
            provider_id: 'shared-ch',
            model: `acc-model-${i}`,
            model_display_name: `AccModel-${i}`,
            thinking: 'high',
            source: 'baseline',
            bank_version: '1.0',
            bank_scope: 'whole',
            status: 'completed',
            rounds: 1,
            sample_count: 12,
            estimated_cost_usd: 0.1,
            usage: { input_tokens: 100, output_tokens: 100 },
            tasks: makeTasks(0.92)
        });
        highVolume.push({
            id: `bad-acc-${i}`,
            run_id: `run-bad-acc-${i}`,
            provider_id: 'shared-ch',
            account_ref: `user${i}@example.invalid`,
            account_evidence: 'gateway_account_binding',
            model: `acc-model-${i}`,
            model_display_name: `AccModel-${i}`,
            thinking: 'high',
            source: 'run',
            bank_version: '1.0',
            bank_scope: 'whole',
            status: 'completed',
            rounds: 1,
            sample_count: 12,
            estimated_cost_usd: 0.45,
            usage: { input_tokens: 100, output_tokens: 100 },
            tasks: makeTasks(0.45)
        });
    }
    for (let m = 0; m < 22; m++) {
        highVolume.push({
            id: `base-ch-${m}`,
            provider_id: 'official',
            model: `ch-model-${m}`,
            model_display_name: `ChModel-${m}`,
            thinking: 'high',
            source: 'baseline',
            bank_version: '1.0',
            bank_scope: 'whole',
            status: 'completed',
            rounds: 1,
            sample_count: 12,
            estimated_cost_usd: 0.1,
            usage: { input_tokens: 100, output_tokens: 100 },
            tasks: makeTasks(0.9)
        });
        highVolume.push({
            id: `bad-ch-${m}`,
            run_id: `run-bad-ch-${m}`,
            provider_id: 'degraded-channel',
            model: `ch-model-${m}`,
            model_display_name: `ChModel-${m}`,
            thinking: 'high',
            source: 'run',
            bank_version: '1.0',
            bank_scope: 'whole',
            status: 'completed',
            rounds: 1,
            sample_count: 12,
            estimated_cost_usd: 0.12,
            usage: { input_tokens: 100, output_tokens: 100 },
            tasks: makeTasks(0.4)
        });
    }
    observations = highVolume;
    await app.emit('mini-bench:refresh');

    const countGroups = html => (html.match(/class="insight-group /g) || []).length;
    const countOpenGroups = html => (html.match(/<details class="insight-group [^>]* open>/g) || []).length;
    expect(element('analysis-insights-disclosure').open).toBe(true);
    expect(element('analysis-insights-summary').getAttribute('aria-disabled')).toBeNull();
    expect(element('analysis-insights-toggle-hint').textContent).toBe('收起');
    expect(countGroups(element('analysis-insights-list').innerHTML)).toBe(8);
    // High-volume lists start collapsed per subject so users scan compact headers first
    expect(countOpenGroups(element('analysis-insights-list').innerHTML)).toBe(0);
    expect(element('analysis-insights-toolbar').hidden).toBe(false);
    expect(element('analysis-insights-toggle-all').textContent).toBe('全部展开');
    expect(element('analysis-insights-more').innerHTML).toContain('展开更多主体（已显示 8 / 21）');
    expect(element('analysis-insights-more').innerHTML).toContain('展开全部 21 个主体');

    // Metric pill filtering and search filtering
    const clickView = attrs =>
        element('analysis-view').handlers.get('click')({
            target: {
                closest: selector => {
                    if (selector === '[data-insight-metric]' && attrs.insightMetric !== undefined) return { dataset: attrs };
                    if (selector === '[data-insight-toggle]' && attrs.insightToggle !== undefined) return { dataset: attrs };
                    if (selector === '[data-insight-group-toggle]' && attrs.insightGroupToggle !== undefined) return { dataset: attrs };
                    if (selector === '[data-insight-record]' && attrs.insightRecord !== undefined) return { dataset: attrs };
                    return null;
                }
            }
        });

    await clickView({ insightMetric: 'cost' });
    expect(element('analysis-insights-list').innerHTML).not.toContain('degraded-channel');
    await clickView({ insightMetric: 'all' });

    element('analysis-insights-search').value = 'degraded-channel';
    element('analysis-insights-search').emit('input');
    expect(countGroups(element('analysis-insights-list').innerHTML)).toBe(1);
    expect(countOpenGroups(element('analysis-insights-list').innerHTML)).toBe(1);
    element('analysis-insights-search').value = '';
    element('analysis-insights-search').emit('input');

    // Expand all / collapse all visible subjects
    element('analysis-insights-toggle-all').emit('click');
    expect(countOpenGroups(element('analysis-insights-list').innerHTML)).toBe(8);
    expect(element('analysis-insights-toggle-all').textContent).toBe('全部收起');
    element('analysis-insights-toggle-all').emit('click');
    expect(countOpenGroups(element('analysis-insights-list').innerHTML)).toBe(0);
    expect(element('analysis-insights-toggle-all').textContent).toBe('全部展开');

    // Stepwise group pagination: 8 -> 20 -> 21 -> reset(8)
    await clickView({ insightToggle: 'more' });
    expect(countGroups(element('analysis-insights-list').innerHTML)).toBe(20);
    expect(element('analysis-insights-more').innerHTML).toContain('展开其余 1 个主体');
    expect(element('analysis-insights-more').innerHTML).toContain('收起部分主体');

    element('analysis-insights-list').scrollTop = 180;
    await clickView({ insightToggle: 'all' });
    expect(countGroups(element('analysis-insights-list').innerHTML)).toBe(21);
    expect(element('analysis-insights-list').scrollTop).toBe(180);

    // Per-group item pagination on the deduplicated 22-item channel group: 5 -> 20 -> 22 -> reset(5)
    const channelGroupId = 'channel:provider:degraded-channel';
    expect(element('analysis-insights-list').innerHTML).toContain('继续展开（已显示 5 / 22 项）');
    expect(element('analysis-insights-list').innerHTML).toContain('展开全部 22 项');
    await clickView({ insightGroupToggle: channelGroupId, insightGroupStep: 'more' });
    expect(element('analysis-insights-list').innerHTML).toContain('展开其余 2 项');
    expect(element('analysis-insights-list').innerHTML).toContain('收起明细');
    await clickView({ insightGroupToggle: channelGroupId, insightGroupStep: 'all' });
    expect((element('analysis-insights-list').innerHTML.match(/data-insight-item="[^"]*degraded-channel/g) || []).length).toBe(22);
    await clickView({ insightGroupToggle: channelGroupId, insightGroupStep: 'reset' });
    expect((element('analysis-insights-list').innerHTML.match(/data-insight-item="[^"]*degraded-channel/g) || []).length).toBe(5);

    // Select an insight item, collapse panel, verify state persists across redraws, and Escape clears highlight
    const itemMatch = /data-insight-record="([^"]+)" data-insight-item="([^"]+)"/.exec(element('analysis-insights-list').innerHTML);
    expect(itemMatch).not.toBeNull();
    await clickView({ insightRecord: itemMatch[1], insightItem: itemMatch[2] });
    expect(renderOptions.at(-1).insightHighlight).not.toBeNull();
    expect(element('analysis-insights-active').hidden).toBe(false);
    expect(element('analysis-insights-active').textContent).toBe('已定位对比');

    element('analysis-insights-disclosure').open = false;
    element('analysis-insights-disclosure').emit('toggle');
    expect(element('analysis-insights').classList.contains('is-collapsed')).toBe(true);
    expect(element('analysis-insights-toggle-hint').textContent).toBe('展开');

    element('chart-color-by').emit('change');
    expect(element('analysis-insights-disclosure').open).toBe(false);
    expect(element('analysis-insights').classList.contains('is-collapsed')).toBe(true);
    expect(renderOptions.at(-1).insightHighlight).not.toBeNull();

    docHandlers.get('keydown')({ key: 'Escape', defaultPrevented: false });
    expect(renderOptions.at(-1).insightHighlight).toBeNull();
    expect(element('analysis-insights-active').hidden).toBe(true);

    await clickView({ insightToggle: 'reset' });
    expect(countGroups(element('analysis-insights-list').innerHTML)).toBe(8);
    expect(element('analysis-insights-list').scrollTop).toBe(0);
});

test('analysis controller promotes and demotes baselines while preserving selection and notifying tasks', async () => {
    const nodes = new Map(),
        listeners = new Map(),
        requests = [];
    const element = id => {
        if (!nodes.has(id)) nodes.set(id, new ControllerNode());
        return nodes.get(id);
    };
    element('chart-axis').value = 'cost';
    element('chart-color-by').value = 'series';
    const ids = Array.from({ length: 12 }, (_, index) => `task-${index}`);
    const tasks = ids.map(task_id => ({ task_id, samples: [{ round: 1, status: 'completed', content_score: 0.8 }] }));
    let observations = [
        {
            id: 'run-obs',
            run_id: 'r1',
            target_id: 't1',
            model: 'model',
            thinking: 'high',
            source: 'run',
            bank_version: '1.0',
            bank_scope: 'whole',
            status: 'completed',
            baseline_eligible: true,
            rounds: 1,
            sample_count: 12,
            estimated_cost_usd: 0.1,
            usage: { input_tokens: 10, output_tokens: 5 },
            tasks
        }
    ];
    const services = {
        byId: element,
        finite: Number.isFinite,
        escapeHtml: value => String(value ?? ''),
        notify() {},
        available: true,
        formatDate: value => value,
        statusText: value => value,
        request: async (path, options) => {
            requests.push({ path, options });
            if (path.endsWith('/baseline') && options?.method === 'POST') {
                observations = [{ ...observations[0], id: 'base-obs', source: 'baseline' }, observations[0]];
                return { baseline: { id: 'base-obs' } };
            }
            if (path.endsWith('/baselines/base-obs/delete') && options?.method === 'POST') {
                observations = observations.filter(item => item.id !== 'base-obs');
                return { ok: true, id: 'base-obs' };
            }
            return { observations: [...observations] };
        }
    };
    let baselinesChanged = 0;
    const events = {
        addEventListener(name, handler) {
            (listeners.get(name) || listeners.set(name, []).get(name)).push(handler);
        },
        removeEventListener() {},
        dispatchEvent(event) {
            if (event.type === 'mini-bench:baselines-changed') baselinesChanged++;
            return Promise.all((listeners.get(event.type) || []).map(handler => handler(event)));
        }
    };
    const app = createAppContext(services, events);
    app.setBank({ version: '1.0', tasks: ids.map(id => ({ id })) });
    let chartCallbacks;
    const renderOptions = [];
    const chart = {
        registerCatalog() {},
        render: (_records, options) => {
            renderOptions.push(options);
        },
        resetZoom() {},
        zoom() {}
    };
    const context = vm.createContext({
        getAppContext: () => app,
        createAnalysisModel,
        attachAnalysisBatchIds,
        selectAnalysisHistoryRecords,
        renderAnalysisRecordList,
        buildObservationAnomalies,
        observationQualitySummary,
        createAnalysisFilters: () => ({ matches: () => true, setRecords() {}, reset() {}, setSource() {}, focus() {} }),
        createAnalysisPopover: (_, panel) => ({ setOpen: open => (panel.hidden = !open), position() {}, close() {}, isOpen: false }),
        createScoreCostChart: (_container, callbacks) => {
            chartCallbacks = callbacks;
            return chart;
        },
        dedupePromotedRuns,
        analyzeAnomalies,
        selectionKey: () => 'key',
        thinkingLabel: value => value,
        MutationObserver: class {
            observe() {}
        },
        document: { addEventListener() {}, documentElement: {} },
        window: { matchMedia: () => ({ addEventListener() {} }) },
        URL: { createObjectURL: () => '', revokeObjectURL() {} },
        Blob: class {},
        setTimeout() {},
        location: { hash: '' }
    });
    vm.runInContext(readFileSync(new URL('../web/analysis.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, ''), context);
    await new Promise(resolve => setTimeout(resolve, 0));

    chartCallbacks.onSelect('run-obs');
    expect(renderOptions.at(-1).selectedIds).toEqual(['run-obs']);

    await chartCallbacks.onPromoteBaseline('run-obs');
    expect(renderOptions.at(-1).selectedIds).toEqual(['base-obs']);
    expect(baselinesChanged).toBe(1);

    await chartCallbacks.onDemoteBaseline('base-obs');
    expect(requests.some(req => req.path === './api/bench/baselines/base-obs/delete' && req.options?.method === 'POST')).toBe(true);
    expect(renderOptions.at(-1).selectedIds).toEqual(['run-obs']);
    expect(baselinesChanged).toBe(2);
});
