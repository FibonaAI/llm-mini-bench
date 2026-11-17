import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { placeChartLabels, placeThinkingLabels } from '../web/chart-layout.js';
import { buildAnalysisHistoryStates } from '../web/analysis-history.js';
import { chartCategory, createChartColorRegistry } from '../web/chart-colors.js';
import { buildChartLegendGroups } from '../web/chart-legend.js';
import { formatChartRecordTime, summarizeChartRecordTimes, overlappingChartRecords } from '../web/chart-point-time.js';

function chartResizeFixture() {
    let writes = 0,
        callback,
        disconnected = false,
        nextFrame = 0,
        legendEntries = [],
        legendDestroyed = false,
        onLegendHighlight = () => {};
    const frames = new Map();
    class Node {
        constructor() {
            this.children = [];
            this.style = {};
            this.dataset = {};
            this.clientWidth = 900;
            this.attributes = {};
            this.classList = { add() {}, remove() {} };
        }
        setAttribute(key, value) {
            this.attributes[key] = String(value);
            writes++;
        }
        append(...children) {
            this.children.push(...children);
            children.forEach(child => (child.parent = this));
            writes++;
        }
        appendChild(child) {
            this.append(child);
            return child;
        }
        replaceChildren(...children) {
            this.children = children;
            writes++;
        }
        addEventListener(name, handler) {
            (this.handlers ??= new Map()).set(name, handler);
        }
        emit(name, event = {}) {
            this.handlers?.get(name)?.(event);
        }
        insertBefore(child, reference) {
            this.children.splice(this.children.indexOf(reference), 0, child);
        }
        getBBox() {
            return { x: 0, y: 0, width: 0, height: 0 };
        }
        getBoundingClientRect() {
            return { top: 0 };
        }
        getComputedTextLength() {
            return 40;
        }
        remove() {
            if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
            writes++;
        }
    }
    const context = vm.createContext({
        document: {
            createElement: () => new Node(),
            createElementNS: () => new Node(),
            createTextNode: text => ({ textContent: text }),
            documentElement: { dataset: {} }
        },
        window: { innerHeight: 1000, matchMedia: () => ({ matches: false }) },
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        ResizeObserver: class {
            constructor(handler) {
                callback = handler;
            }
            observe() {}
            disconnect() {
                disconnected = true;
            }
        },
        requestAnimationFrame: handler => {
            frames.set(++nextFrame, handler);
            return nextFrame;
        },
        cancelAnimationFrame: id => frames.delete(id),
        placeChartLabels,
        placeThinkingLabels,
        buildAnalysisHistoryStates,
        createChartColorRegistry,
        buildChartLegendGroups,
        createChartLegend: () => ({
            render(entries, dimension, onHighlight) {
                legendEntries = entries;
                onLegendHighlight = onHighlight;
            },
            destroy() {
                legendDestroyed = true;
            }
        }),
        formatChartRecordTime,
        summarizeChartRecordTimes,
        overlappingChartRecords,
        chartCategory
    });
    const source = readFileSync(new URL('../web/score-cost-chart.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '')
        .replace(/^export /gm, '');
    vm.runInContext(source + '\nthis.createChart = createScoreCostChart;', context);
    const container = new Node(),
        selections = [],
        chart = context.createChart(container, { onSelect: id => selections.push(id) });
    return {
        chart,
        container,
        frames,
        selections,
        get writes() {
            return writes;
        },
        get disconnected() {
            return disconnected;
        },
        get legendEntries() {
            return legendEntries;
        },
        get legendDestroyed() {
            return legendDestroyed;
        },
        highlightLegend(key) {
            onLegendHighlight(key);
        },
        deliver(width, height = 500) {
            container.clientWidth = width;
            callback([{ target: container, contentRect: { width, height } }]);
        },
        flush() {
            const pending = [...frames.values()];
            frames.clear();
            pending.forEach(handler => handler());
        }
    };
}

test('chart color mode changes markers and lines without merging points or Thinking groups', () => {
    const f = chartResizeFixture();
    const base = { model: 'gpt-6-luna', providerId: 'a', accountId: 'one', task_id: 'batch', source: 'run', cost: 1, score: 90 };
    const rows = [
        { ...base, id: 'low', think: 'low' },
        { ...base, id: 'high', think: 'high', cost: 2 },
        { ...base, id: 'peer', think: 'low', providerId: 'b' },
        { ...base, id: 'sol', model: 'gpt-6.1-sol', think: 'high' }
    ];
    f.chart.registerCatalog(rows);
    const nodes = () => {
        const all = [];
        const visit = node => {
            all.push(node);
            node.children?.forEach(visit);
        };
        visit(f.container);
        return all;
    };
    const pointColors = () =>
        nodes()
            .filter(node => node.attributes?.class === 'score-cost-point')
            .map(node => node.attributes['data-model-color']);
    const line = () => nodes().filter(node => node.attributes?.class === 'thinking-series');
    f.chart.render(rows, { labels: false });
    const original = pointColors();
    expect(original[0]).not.toBe(original[2]);
    for (const colorBy of ['model', 'family']) {
        f.chart.render(rows, { colorBy });
        const colors = pointColors();
        expect(colors.length).toBe(4);
        expect(colors[0]).toBe(colors[1]);
        expect(colors[0]).toBe(colors[2]);
        if (colorBy === 'model') expect(colors[0]).not.toBe(colors[3]);
        else expect(colors[0]).toBe(colors[3]);
        expect(line().length).toBe(1);
        expect(line()[0].attributes.stroke).toBe(colors[0]);
        const entry = f.legendEntries.find(group => group.name === (colorBy === 'model' ? 'gpt-6-luna' : 'GPT'));
        expect(entry.count).toBe(colorBy === 'model' ? 3 : 4);
        expect(entry.color).toBe(colors[0]);
        f.highlightLegend(entry.key);
        const points = nodes().filter(node => node.attributes?.class === 'score-cost-point');
        expect(points[0].attributes['data-legend-highlight']).toBe('true');
        expect(points[3].attributes.opacity).toBe(colorBy === 'model' ? '0.18' : '1');
        expect(line()[0].attributes['data-legend-highlight']).toBe('false');
        expect(line()[0].attributes.opacity).toBe('0');
        f.highlightLegend(null);
        expect(points.every(node => node.attributes.opacity === '1')).toBe(true);
    }
    f.chart.render(rows, { colorBy: 'series' });
    expect(pointColors()).toEqual(original);
    f.chart.render(rows, { colorBy: 'invalid' });
    expect(pointColors()).toEqual(original);
});

test('legend includes only rendered points and follows axis eligibility and zoom', () => {
    const f = chartResizeFixture();
    const base = { model: 'gpt-6-luna', providerId: 'a', accountId: 'one', score: 80, think: 'default' };
    const rows = [
        { ...base, id: 'zero', cost: 0 },
        { ...base, id: 'positive', cost: 1 },
        { ...base, id: 'unknown', cost: null },
        { ...base, id: 'incomplete', cost: 2, score: null },
        { ...base, id: 'far', cost: 100 }
    ];
    f.chart.render(rows, { labels: false, colorBy: 'model' });
    expect(f.legendEntries[0].count).toBe(2);
    f.chart.render(rows, { log: false });
    expect(f.legendEntries[0].count).toBe(3);
    f.chart.zoom(16);
    expect(f.legendEntries).toEqual([]);
    f.chart.resetZoom();
    expect(f.legendEntries[0].count).toBe(3);
    f.chart.render([]);
    expect(f.legendEntries).toEqual([]);
});

test('zoomed frontier shares the rendered point set and ignores offscreen dominators', () => {
    for (const axis of ['cost', 'tokens'])
        for (const log of [true, false]) {
            const f = chartResizeFixture();
            const rows = [
                { id: 'offscreen', model: 'A', cost: 1, score: 100 },
                { id: 'selected', model: 'B', cost: 10, score: 50 },
                { id: 'visible-best', model: 'C', cost: 10.1, score: 60 }
            ];
            const nodes = () => {
                const result = [];
                const visit = node => {
                    result.push(node);
                    node.children?.forEach(visit);
                };
                visit(f.container);
                return result;
            };
            const frontier = () => nodes().find(node => node.attributes?.class === 'pareto-frontier');
            f.chart.render(rows, { labels: false, selectedIds: ['selected'], axis, log });
            f.chart.zoom(16);
            const points = nodes().filter(node => node.attributes?.class === 'score-cost-point');
            expect(points.map(node => node.attributes['data-record-id'])).toEqual(['selected', 'visible-best']);
            const expected = points.map(point => {
                const marker = point.children.find(node => node.attributes?.class === 'record-marker');
                return [Number(marker.attributes.cx), Number(marker.attributes.cy)];
            });
            const frontierPoints = frontier()
                .attributes.points.split(' ')
                .slice(0, -1)
                .map(pair => pair.split(',').map(Number));
            expect(frontierPoints).toEqual(expected);
            expect(f.legendEntries.reduce((sum, entry) => sum + entry.count, 0)).toBe(2);
            f.chart.resetZoom();
            expect(Number(frontier().attributes.points.split(' ')[0].split(',')[1])).toBe(38);
            f.chart.destroy();
        }
});

test('resize delivery never mutates chart layout synchronously and coalesces width changes', () => {
    const f = chartResizeFixture();
    f.chart.render([]);
    const before = f.writes;
    f.deliver(700);
    f.deliver(390);
    expect(f.writes).toBe(before);
    expect(f.frames.size).toBe(1);
    f.flush();
    expect(f.writes).toBeGreaterThan(before);
    expect(f.container.children[0].attributes.viewBox).toBe('0 0 390 380');
    const after = f.writes;
    f.deliver(390, 650); // Legend height changes must not request another draw.
    expect(f.frames.size).toBe(0);
    expect(f.writes).toBe(after);
});

test('explicit render remains synchronous and a pending resize uses the latest width', () => {
    const f = chartResizeFixture();
    const before = f.writes;
    f.chart.render([]);
    expect(f.writes).toBeGreaterThan(before);
    f.deliver(700);
    f.container.clientWidth = 500;
    f.flush();
    expect(f.container.children[0].attributes.viewBox).toBe('0 0 500 380');
});

test('hidden containers do not redraw and showing at a new width resizes once', () => {
    const f = chartResizeFixture();
    f.chart.render([]);
    const before = f.writes;
    f.deliver(0, 0);
    expect(f.frames.size).toBe(0);
    expect(f.writes).toBe(before);
    f.deliver(390);
    f.flush();
    expect(f.container.children[0].attributes.viewBox).toBe('0 0 390 380');
});

test('destroy disconnects observer and cancels pending frame without later writes', () => {
    const f = chartResizeFixture();
    f.chart.render([]);
    f.deliver(600);
    expect(f.frames.size).toBe(1);
    f.chart.destroy();
    const after = f.writes;
    expect(f.disconnected).toBe(true);
    expect(f.legendDestroyed).toBe(true);
    expect(f.frames.size).toBe(0);
    f.flush();
    f.deliver(400);
    expect(f.writes).toBe(after);
    expect(f.frames.size).toBe(0);
});

function chartFixtureNodes(fixture, className) {
    const nodes = [];
    const visit = node => {
        if (node.attributes?.class === className) nodes.push(node);
        node.children?.forEach(visit);
    };
    visit(fixture.container);
    return nodes;
}

test('irregular batches reveal only visible same-batch Thinking on hover or selection, never on legend lookup', () => {
    const f = chartResizeFixture();
    const base = {
        source: 'run',
        bank_version: '1.0',
        bank_scope: 'whole',
        model: 'Atlas',
        providerId: 'a',
        accountId: 'one',
        cost: 1,
        score: 80
    };
    const rows = [
        { ...base, id: 'old-low', task_id: 'A1', think: 'low', created_at: '2026-11-03T12:00:00Z' },
        { ...base, id: 'medium', task_id: 'A1', think: 'medium', cost: 2, created_at: '2026-11-03T12:00:00Z' },
        { ...base, id: 'old-high', task_id: 'A1', think: 'high', cost: 3, created_at: '2026-11-03T12:00:00Z' },
        { ...base, id: 'new-low', task_id: 'A2', think: 'low', cost: 1.1, created_at: '2026-11-10T12:00:00Z' },
        { ...base, id: 'new-high', task_id: 'A3', think: 'high', cost: 3.3, created_at: '2026-11-17T12:00:00Z' }
    ];
    const nodes = className => chartFixtureNodes(f, className);
    const point = id => nodes('score-cost-point').find(node => node.attributes['data-record-id'] === id);
    f.chart.render(rows, { labels: false });
    expect(nodes('thinking-series').map(node => node.attributes.opacity)).toEqual(['0']);
    expect(point('old-low').attributes['data-history-state']).toBe('historical');
    expect(point('medium').attributes['data-history-state']).toBe('latest');
    f.highlightLegend(f.legendEntries[0].key);
    expect(nodes('thinking-series')[0].attributes.opacity).toBe('0');
    point('new-low').emit('pointerenter');
    expect(nodes('thinking-level-label')).toHaveLength(0);
    expect(nodes('thinking-series')[0].attributes.opacity).toBe('0');
    point('old-high').emit('pointerenter');
    expect(nodes('thinking-level-label').map(node => node.attributes['data-thinking-record'])).toEqual(['old-low', 'medium', 'old-high']);
    expect(nodes('thinking-series')[0].attributes.opacity).toBe('0.95');
    point('old-high').emit('pointerleave');
    expect(nodes('thinking-series')[0].attributes.opacity).toBe('0');
    f.chart.render(rows, { selectedIds: ['medium'] });
    expect(nodes('thinking-series')[0].attributes.opacity).toBe('0.95');
    // Latest records span A2/A1/A3: selecting the A1 singleton cannot complete it with hidden history.
    f.chart.render(
        rows.filter(record => ['new-low', 'medium', 'new-high'].includes(record.id)),
        { historyRecords: rows }
    );
    expect(nodes('thinking-series')).toHaveLength(0);
    point('medium').emit('focus');
    expect(nodes('thinking-level-label')).toHaveLength(0);
    // Zoom removes the other A1 levels; offscreen records do not complete a curve.
    f.chart.render(rows, { historyRecords: rows, selectedIds: ['medium'] });
    f.chart.zoom(16);
    expect(nodes('thinking-series')).toHaveLength(0);
});

test('marker states, source shape and time colors stay independent of displayed subset and axis', () => {
    const f = chartResizeFixture();
    const base = { source: 'run', model: 'A', think: 'high', providerId: 'a', accountId: 'one', score: 80, cost: 1 };
    const rows = [
        { ...base, id: 'old', created_at: '2026-11-03T12:00:00Z' },
        { ...base, id: 'failed', created_at: '2026-11-17T12:00:00Z', score: null },
        { ...base, id: 'baseline', source: 'baseline', created_at: '2026-11-10T12:00:00Z' },
        { ...base, id: 'unknown', created_at: null }
    ];
    f.chart.render(rows, { labels: false, colorBy: 'time', historyRecords: rows });
    const points = () => chartFixtureNodes(f, 'score-cost-point');
    const markers = () => chartFixtureNodes(f, 'record-marker');
    expect(points().map(point => point.attributes['data-history-state'])).toEqual(['historical', 'latest', 'unknown']);
    expect(markers()[0].attributes.fill).toBe('#fff');
    expect(markers()[1].attributes.width).toBe('8.5');
    expect(markers()[1].attributes.fill).toBe(points()[1].attributes['data-model-color']);
    expect(markers()[1].attributes.stroke).toBe(points()[1].attributes['data-model-color']);
    expect(chartFixtureNodes(f, 'record-marker-halo').every(node => node.attributes.stroke === '#fff')).toBe(true);
    expect(markers()[0].attributes.stroke).toBe(points()[0].attributes['data-model-color']);
    expect(markers()[2].attributes['stroke-dasharray']).toBe('2 2');
    const color = points()[0].attributes['data-model-color'];
    f.chart.render([rows[0]], { axis: 'tokens', log: false });
    expect(points()[0].attributes['data-history-state']).toBe('historical');
    expect(points()[0].attributes['data-model-color']).toBe(color);
    let prevented = 0;
    points()[0].emit('keydown', { key: ' ', preventDefault: () => prevented++ });
    expect(f.selections).toEqual([]);
    points()[0].emit('keyup', { key: ' ', preventDefault: () => prevented++ });
    expect(f.selections).toEqual(['old']);
    expect(prevented).toBe(2);
});

test('latest and historical markers share visible dimensions and a separate background halo in both shapes', () => {
    const f = chartResizeFixture();
    const base = { model: 'A', think: 'high', providerId: 'a', accountId: 'one', score: 80, cost: 1 };
    const rows = ['run', 'baseline'].flatMap(source => [
        { ...base, source, id: `${source}-old`, created_at: '2026-11-03T12:00:00Z' },
        { ...base, source, id: `${source}-latest`, created_at: '2026-11-17T12:00:00Z' },
        { ...base, source, id: `${source}-unknown`, created_at: null }
    ]);
    f.chart.render(rows, { labels: false });
    const markers = chartFixtureNodes(f, 'record-marker').map(node => node.attributes);
    expect(markers.slice(0, 3).map(marker => Number(marker.r) * 2 + Number(marker['stroke-width']))).toEqual([12, 12, 12]);
    expect(markers.slice(3).map(marker => Number(marker.width) + Number(marker['stroke-width']))).toEqual([10, 10, 10]);
    expect(markers.slice(3).map(marker => Number(marker.height) + Number(marker['stroke-width']))).toEqual([10, 10, 10]);
    expect(markers.every(marker => marker['stroke-width'] === '1.5')).toBe(true);
    expect(markers[0].fill).toBe('#fff');
    expect(markers[1].fill).toBe(markers[1].stroke);
    expect(markers[3].fill).toBe('#fff');
    expect(markers[4].fill).toBe(markers[4].stroke);
    expect(markers[2]['stroke-dasharray']).toBe('2 2');
    expect(markers[5]['stroke-dasharray']).toBe('2 2');
    const halos = chartFixtureNodes(f, 'record-marker-halo').map(node => node.attributes);
    expect(halos).toHaveLength(6);
    expect(
        halos.every(
            halo => halo.fill === '#fff' && halo.stroke === '#fff' && halo['stroke-width'] === '4.5' && halo['pointer-events'] === 'none'
        )
    ).toBe(true);
    expect(chartFixtureNodes(f, 'score-cost-hit').every(node => node.attributes.r === '7')).toBe(true);
    expect(chartFixtureNodes(f, 'score-cost-focus-ring').every(node => node.attributes.r === '11')).toBe(true);
});

test('dense chart uses a compact desktop canvas and short model labels without losing channel records', () => {
    const f = chartResizeFixture();
    const rows = Array.from({ length: 49 }, (_, index) => ({
        id: `dense-${index}`,
        model: `model-${index % 5}`,
        modelDisplayName: `Model ${index % 5}`,
        providerId: `channel-${index % 10}`,
        providerName: `Channel ${index % 10}`,
        think: 'high',
        created_at: '2026-11-17T12:00:00Z',
        cost: 0.001 * 1.12 ** index,
        score: index < 2 ? 60 + index * 8 : 90 + (index % 11)
    }));
    f.chart.render(rows);
    expect(f.container.children[0].attributes.viewBox).toBe('0 0 900 400');
    expect(chartFixtureNodes(f, 'score-cost-point')).toHaveLength(49);
    const labels = chartFixtureNodes(f, 'chart-point-label');
    expect(labels.length).toBeLessThanOrEqual(5);
    expect(labels.every(node => !node.textContent?.includes('Channel'))).toBe(true);
    expect(new Set(labels.map(node => node.textContent)).size).toBe(labels.length);
    expect(f.legendEntries).toHaveLength(10);
    f.deliver(390);
    f.flush();
    expect(chartFixtureNodes(f, 'chart-point-label').length).toBeLessThanOrEqual(2);
    expect(chartFixtureNodes(f, 'score-cost-point')).toHaveLength(49);
});
