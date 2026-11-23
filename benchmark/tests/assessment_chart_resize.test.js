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
            this.classes = new Set();
            this.classList = {
                add: name => this.classes.add(name),
                remove: name => this.classes.delete(name),
                toggle: (name, force) =>
                    force === undefined
                        ? this.classes.has(name)
                            ? this.classes.delete(name)
                            : this.classes.add(name)
                        : force
                          ? this.classes.add(name)
                          : this.classes.delete(name),
                contains: name => this.classes.has(name)
            };
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
        removeEventListener(name, handler) {
            if (this.handlers?.get(name) === handler) this.handlers.delete(name);
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
            return {
                left: 0,
                top: 0,
                width: Number(this.attributes.width) || this.clientWidth || 900,
                height: Number(this.attributes.height) || 400
            };
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
        openedRuns = [],
        chart = context.createChart(container, {
            onSelect: id => selections.push(id),
            onOpenRun: runId => openedRuns.push(runId)
        });
    return {
        chart,
        container,
        frames,
        selections,
        openedRuns,
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
    const base = { model: 'gpt-6-luna', providerId: 'a', accountId: 'one', score: 80, think: 'high' };
    const rows = [
        { ...base, id: 'zero', cost: 0 },
        { ...base, id: 'positive', cost: 1 },
        { ...base, id: 'unknown', cost: null },
        { ...base, id: 'incomplete', cost: 2, score: null },
        { ...base, id: 'far', cost: 100 }
    ];
    f.chart.render(rows, { labels: false, colorBy: 'model' });
    expect(f.legendEntries[0].count).toBe(3);
    f.chart.render(rows, { axis: 'tokens', log: true });
    expect(f.legendEntries[0].count).toBe(2);
    f.chart.render(rows, { axis: 'tokens', log: false });
    expect(f.legendEntries[0].count).toBe(3);
    f.chart.zoom(16);
    expect(f.legendEntries).toEqual([]);
    f.chart.resetZoom();
    expect(f.legendEntries[0].count).toBe(3);
    f.chart.render([]);
    expect(f.legendEntries).toEqual([]);
});

test('zero-cost records plot on the y-axis in log and linear cost modes without joining the Pareto frontier', () => {
    const collectNodes = root => {
        const result = [];
        const visit = node => {
            result.push(node);
            node.children?.forEach(visit);
        };
        visit(root);
        return result;
    };
    for (const log of [true, false]) {
        const f = chartResizeFixture();
        const rows = [
            { id: 'free-top', model: 'Free Top', cost: 0, score: 99 },
            { id: 'cheap', model: 'Cheap', cost: 1, score: 70 },
            { id: 'dominated', model: 'Dominated', cost: 2, score: 65 },
            { id: 'best-paid', model: 'Best Paid', cost: 4, score: 90 }
        ];
        f.chart.render(rows, { labels: false, axis: 'cost', log });
        const nodes = collectNodes(f.container);
        const pointNodes = nodes.filter(node => node.attributes?.class === 'score-cost-point');
        expect(pointNodes.map(node => node.attributes['data-record-id'])).toEqual(['free-top', 'cheap', 'dominated', 'best-paid']);
        const freePoint = pointNodes.find(node => node.attributes['data-record-id'] === 'free-top');
        const freeMarker = freePoint.children.find(node => node.attributes?.class === 'record-marker');
        expect(Number(freeMarker.attributes.cx)).toBe(58);
        expect(Number.isFinite(Number(freeMarker.attributes.cy))).toBe(true);
        expect(freePoint.children.some(node => node.attributes?.class === 'score-cost-anomaly-badge')).toBe(false);
        expect(freePoint.attributes['aria-label']).toContain('零费用（不计入前沿）');
        const frontier = nodes.find(node => node.attributes?.class === 'pareto-frontier');
        const frontierPoints = frontier.attributes.points
            .split(' ')
            .slice(0, -1)
            .map(pair => pair.split(',').map(Number));
        const expectedPaid = ['cheap', 'best-paid'].map(id => {
            const point = pointNodes.find(node => node.attributes['data-record-id'] === id);
            const marker = point.children.find(node => node.attributes?.class === 'record-marker');
            return [Number(marker.attributes.cx), Number(marker.attributes.cy)];
        });
        expect(frontierPoints).toEqual(expectedPaid);
        // Zooming on the zero-cost point keeps finite coordinates on the y-axis.
        f.chart.render(rows, { labels: false, axis: 'cost', log, selectedIds: ['free-top'] });
        f.chart.zoom(4);
        const zoomedFree = collectNodes(f.container).find(node => node.attributes?.['data-record-id'] === 'free-top');
        expect(Number(zoomedFree.children.find(node => node.attributes?.class === 'record-marker').attributes.cx)).toBe(58);
        // Zooming into a paid region moves the zero-cost point offscreen.
        f.chart.resetZoom();
        f.chart.render(rows, { labels: false, axis: 'cost', log, selectedIds: ['best-paid'] });
        f.chart.zoom(16);
        expect(collectNodes(f.container).some(node => node.attributes?.['data-record-id'] === 'free-top')).toBe(false);
        // Only zero-cost records still plot cleanly without a frontier line.
        f.chart.resetZoom();
        f.chart.render([{ id: 'only-free', model: 'Only Free', cost: 0, score: 85 }], { labels: false, axis: 'cost', log });
        const onlyNodes = collectNodes(f.container);
        const onlyFree = onlyNodes.find(node => node.attributes?.['data-record-id'] === 'only-free');
        expect(Number(onlyFree.children.find(node => node.attributes?.class === 'record-marker').attributes.cx)).toBe(58);
        expect(onlyNodes.some(node => node.attributes?.class === 'pareto-frontier')).toBe(false);
        f.chart.destroy();
    }
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
    expect(labels.length).toBeGreaterThan(5);
    expect(labels.length).toBeLessThanOrEqual(28);
    expect(labels.every(node => !node.textContent?.includes('Channel'))).toBe(true);
    expect(f.legendEntries).toHaveLength(10);
    f.deliver(390);
    f.flush();
    expect(chartFixtureNodes(f, 'chart-point-label').length).toBeLessThanOrEqual(8);
    expect(chartFixtureNodes(f, 'score-cost-point')).toHaveLength(49);
});

test('single-model multi-channel chart labels distinguish channels and thinking levels without crowding', () => {
    const f = chartResizeFixture();
    const rows = [
        {
            id: 'r1',
            model: 'sonnet',
            modelDisplayName: 'Claude Sonnet 5.5',
            providerId: 'p1',
            providerName: 'homelab / agy-pro',
            think: 'low',
            created_at: '2026-11-18T12:00:00Z',
            cost: 0.6,
            score: 75
        },
        {
            id: 'r2',
            model: 'sonnet',
            modelDisplayName: 'Claude Sonnet 5.5',
            providerId: 'p2',
            providerName: 'homelab / claude-code',
            think: 'high',
            created_at: '2026-11-18T12:00:00Z',
            cost: 1.0,
            score: 88
        },
        {
            id: 'r3',
            model: 'sonnet',
            modelDisplayName: 'Claude Sonnet 5.5',
            providerId: 'p3',
            providerName: 'homelab / opencode',
            think: 'max',
            created_at: '2026-11-18T12:00:00Z',
            cost: 1.6,
            score: 96
        }
    ];
    f.chart.render(rows);
    const texts = chartFixtureNodes(f, 'chart-point-label').map(node => node.textContent);
    expect(texts).toHaveLength(3);
    expect(texts).toContain('agy-pro · low');
    expect(texts).toContain('claude-code · high');
    expect(texts).toContain('opencode · max');
});

test('wheel zoom at cursor, drag-to-pan when zoomed, duration axis, and pinned tooltip with run detail link', () => {
    const f = chartResizeFixture();
    const rows = [
        {
            id: 'p1',
            source: 'run',
            run_id: 'run-1',
            model: 'm1',
            modelDisplayName: 'Model 1',
            providerName: 'ch1',
            account: 'a1',
            think: 'high',
            created_at: '2026-11-18T12:00:00Z',
            cost: 120,
            score: 70,
            rounds: 1,
            original: { rounds: 1, elapsed_seconds: 120 }
        },
        {
            id: 'p2',
            source: 'run',
            run_id: 'run-2',
            model: 'm2',
            modelDisplayName: 'Model 2',
            providerName: 'ch2',
            account: 'a2',
            think: 'high',
            created_at: '2026-11-18T12:00:00Z',
            cost: 600,
            score: 92,
            rounds: 1,
            original: { rounds: 1, elapsed_seconds: 600 }
        }
    ];
    f.chart.render(rows, { axis: 'duration', log: false });
    const svg = f.container.children[0];
    const tooltip = f.container.children[1];
    // Duration axis renders time-formatted ticks
    const allTexts = [];
    const walk = node => {
        if (node.textContent !== undefined) allTexts.push(String(node.textContent));
        for (const child of node.children || []) walk(child);
    };
    walk(svg);
    expect(allTexts.some(t => t.includes('平均耗时'))).toBe(true);
    expect(allTexts.some(t => /\d+[ms]/.test(t))).toBe(true);

    // Clicking a point pins the tooltip and exposes the task detail button
    const point1 = chartFixtureNodes(f, 'score-cost-point').find(node => node.attributes['data-record-id'] === 'p1');
    point1.emit('click', { stopPropagation() {} });
    expect(f.selections).toEqual(['p1']);
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.classList.contains('is-pinned')).toBe(true);
    // Leaving the point keeps pinned tooltip open
    point1.emit('pointerleave');
    expect(tooltip.hidden).toBe(false);
    // Clicking the tooltip run detail button invokes onOpenRun
    const findBtn = node => {
        if (node.dataset?.tooltipOpenRun) return node;
        for (const child of node.children || []) {
            const found = findBtn(child);
            if (found) return found;
        }
        return null;
    };
    const openBtn = findBtn(tooltip);
    expect(openBtn?.dataset.tooltipOpenRun).toBe('run-1');
    openBtn.emit('click', { stopPropagation() {} });
    expect(f.openedRuns).toEqual(['run-1']);

    // Clicking the same point again deselects it and unpins the tooltip
    point1.emit('click', { stopPropagation() {} });
    expect(f.selections).toEqual(['p1', null]);
    expect(tooltip.hidden).toBe(true);
    expect(tooltip.classList.contains('is-pinned')).toBe(false);

    // Re-clicking selects and pins it again; blank click closes pinned tooltip without box-selecting
    point1.emit('click', { stopPropagation() {} });
    expect(f.selections).toEqual(['p1', null, 'p1']);
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.classList.contains('is-pinned')).toBe(true);
    expect(svg.classList.contains('is-pannable')).toBe(false);
    svg.emit('pointerdown', { button: 0, pointerId: 1, clientX: 500, clientY: 40 });
    svg.emit('pointermove', { pointerId: 1, clientX: 860, clientY: 160 });
    svg.emit('pointerup', { pointerId: 1, clientX: 860, clientY: 160 });
    expect(chartFixtureNodes(f, 'score-cost-point')).toHaveLength(2);
    expect(chartFixtureNodes(f, 'chart-brush-rect')).toHaveLength(0);
    expect(tooltip.hidden).toBe(true);

    // Clicking a point selected externally via options.selectedIds also toggles it off
    f.chart.render(rows, { axis: 'duration', log: false, selectedIds: ['p2'] });
    const point2 = chartFixtureNodes(f, 'score-cost-point').find(node => node.attributes['data-record-id'] === 'p2');
    point2.emit('click', { stopPropagation() {} });
    expect(f.selections).toEqual(['p1', null, 'p1', null]);
    expect(tooltip.hidden).toBe(true);
    f.chart.render(rows, { axis: 'duration', log: false, selectedIds: [] });

    // Wheel zoom in right over p2 keeps p2 anchored under the cursor while excluding p1
    const p2Marker = chartFixtureNodes(f, 'record-marker').at(-1);
    const p2X = Number(p2Marker.attributes.cx);
    const p2Y = Number(p2Marker.attributes.cy);
    let prevented = false;
    for (let i = 0; i < 2; i++) {
        svg.emit('wheel', {
            clientX: p2X,
            clientY: p2Y,
            deltaY: -200,
            deltaMode: 0,
            preventDefault() {
                prevented = true;
            }
        });
    }
    expect(prevented).toBe(true);
    expect(svg.classList.contains('is-pannable')).toBe(true);
    expect(chartFixtureNodes(f, 'score-cost-point').map(n => n.attributes['data-record-id'])).toEqual(['p2']);
    const p2After = chartFixtureNodes(f, 'record-marker')[0];
    expect(Math.abs(Number(p2After.attributes.cx) - p2X)).toBeLessThan(1.5);
    expect(Math.abs(Number(p2After.attributes.cy) - p2Y)).toBeLessThan(1.5);

    // A small drag moves the point 1:1 with the pointer (drag right -> cx increases, drag up -> cy decreases)
    const beforePanX = Number(p2After.attributes.cx);
    const beforePanY = Number(p2After.attributes.cy);
    svg.emit('pointerdown', { button: 0, pointerId: 2, clientX: 400, clientY: 200 });
    svg.emit('pointermove', { pointerId: 2, clientX: 460, clientY: 160 });
    expect(svg.classList.contains('is-panning')).toBe(true);
    const p2MidPan = chartFixtureNodes(f, 'record-marker')[0];
    expect(Number(p2MidPan.attributes.cx)).toBeGreaterThan(beforePanX + 30);
    expect(Number(p2MidPan.attributes.cy)).toBeLessThan(beforePanY - 20);
    svg.emit('pointerup', { pointerId: 2, clientX: 460, clientY: 160 });
    expect(svg.classList.contains('is-panning')).toBe(false);

    // Continuing to drag right & up pans all the way to p1 (lower cost & lower score)
    for (let i = 0; i < 3; i++) {
        svg.emit('pointerdown', { button: 0, pointerId: 3 + i, clientX: 100, clientY: 320 });
        svg.emit('pointermove', { pointerId: 3 + i, clientX: 820, clientY: 60 });
        svg.emit('pointerup', { pointerId: 3 + i, clientX: 820, clientY: 60 });
    }
    expect(chartFixtureNodes(f, 'score-cost-point').map(n => n.attributes['data-record-id'])).toEqual(['p1']);

    // Double click resets zoom to both points and clears pannable state
    svg.emit('dblclick', {});
    expect(svg.classList.contains('is-pannable')).toBe(false);
    expect(chartFixtureNodes(f, 'score-cost-point')).toHaveLength(2);
});

test('tooltip anchors near the active point without covering it and flips side near chart edges', () => {
    const f = chartResizeFixture();
    const tooltip = f.container.children[1];
    tooltip.offsetWidth = 348;
    tooltip.offsetHeight = 176;
    const baseRows = [
        {
            id: 'mid-left',
            source: 'run',
            run_id: 'r-left',
            model: 'gpt-6.1-terra',
            modelDisplayName: 'GPT-6.1 Terra',
            provider: 'codex',
            providerName: 'homelab / codex',
            account: 'acc',
            think: 'high',
            created_at: '2026-11-19T12:00:00Z',
            cost: 0.25,
            score: 76,
            rounds: 3,
            batch_id: 'b1'
        },
        {
            id: 'top-right',
            source: 'run',
            run_id: 'r-top',
            model: 'gpt-6.1-terra',
            modelDisplayName: 'GPT-6.1 Terra',
            provider: 'codex',
            providerName: 'homelab / codex',
            account: 'acc',
            think: 'max',
            created_at: '2026-11-19T12:00:00Z',
            cost: 0.9,
            score: 94,
            rounds: 3,
            batch_id: 'b1'
        }
    ];
    f.chart.render(baseRows, { axis: 'cost', log: false });
    const leftPoint = chartFixtureNodes(f, 'score-cost-point').find(node => node.attributes['data-record-id'] === 'mid-left');
    const leftMarker = leftPoint.children.find(node => node.attributes.class?.includes('record-marker'));
    const leftX = Number(leftMarker.attributes.cx);
    leftPoint.emit('pointerenter');
    const leftCardX = Number.parseFloat(tooltip.style.left);
    // Anchors directly beside the hovered point instead of jumping to the far corner.
    expect(leftCardX).toBeGreaterThanOrEqual(leftX + 12);
    expect(leftCardX).toBeLessThanOrEqual(leftX + 40);

    // Pinning keeps the tooltip steady even if the pointer brushes another dot on the way to the card.
    leftPoint.emit('click', { stopPropagation() {} });
    expect(tooltip.classList.contains('is-pinned')).toBe(true);
    const pinnedLeft = tooltip.style.left;
    const topRightPoint = chartFixtureNodes(f, 'score-cost-point').find(node => node.attributes['data-record-id'] === 'top-right');
    topRightPoint.emit('pointerenter');
    expect(tooltip.style.left).toBe(pinnedLeft);
    expect(tooltip.classList.contains('is-pinned')).toBe(true);
    leftPoint.emit('click', { stopPropagation() {} });
    expect(tooltip.hidden).toBe(true);

    // When the active point sits near the right edge, the card flips to its left side while staying close.
    f.chart.render(
        [
            ...baseRows,
            {
                id: 'bottom-right',
                source: 'run',
                run_id: 'r-br',
                model: 'slow-model',
                modelDisplayName: 'Slow Model',
                provider: 'slow',
                providerName: 'homelab / slow',
                account: 'acc',
                think: 'high',
                created_at: '2026-11-19T12:00:00Z',
                cost: 1.0,
                score: 40,
                rounds: 3
            }
        ],
        { axis: 'cost', log: false }
    );
    const brPoint = chartFixtureNodes(f, 'score-cost-point').find(node => node.attributes['data-record-id'] === 'bottom-right');
    const brMarker = brPoint.children.find(node => node.attributes.class?.includes('record-marker'));
    const brX = Number(brMarker.attributes.cx);
    brPoint.emit('pointerenter');
    const brCardX = Number.parseFloat(tooltip.style.left);
    expect(brCardX + tooltip.offsetWidth).toBeLessThanOrEqual(brX - 10);
    expect(brCardX + tooltip.offsetWidth).toBeGreaterThanOrEqual(brX - 40);
});

test('all anomaly categories show amber badges, list details in tooltip, and stay off the Pareto frontier', () => {
    const f = chartResizeFixture();
    const tooltip = f.container.children.find(node => node.className === 'score-cost-tooltip');
    const collectText = node => {
        if (!node) return '';
        return [node.textContent || '', ...(node.children || []).map(collectText)].join('');
    };
    const rows = [
        {
            id: 'anomalous-top',
            source: 'run',
            run_id: 'r-anom',
            model: 'Anom Model',
            provider: 'ch',
            account: 'acc',
            think: 'high',
            created_at: '2026-11-19T12:00:00Z',
            cost: 0.05,
            score: 99,
            rounds: 1,
            anomalies: {
                timedOut: 1,
                endedAfterSubmission: 1,
                noSubmission: 1,
                usageIncomplete: null,
                items: [
                    '1 个样本超时（按 0 分计）',
                    '1 个样本提交答案后异常中止（按最后一次提交评分）',
                    '1 个样本未调用 submit_answer 提交（按 0 分计）'
                ],
                hasAny: true,
                summary:
                    '1 个样本超时（按 0 分计）；1 个样本提交答案后异常中止（按最后一次提交评分）；1 个样本未调用 submit_answer 提交（按 0 分计）'
            }
        },
        {
            id: 'usage-only-top',
            source: 'run',
            run_id: 'r-usage',
            model: 'Usage Gap Model',
            provider: 'ch',
            account: 'acc',
            think: 'high',
            created_at: '2026-11-19T12:00:00Z',
            cost: 0.08,
            score: 95,
            rounds: 1,
            usageIncomplete: { cost: 0.08, unknownAttempts: 2, attempts: 12 }
        },
        {
            id: 'clean-frontier',
            source: 'run',
            run_id: 'r-clean',
            model: 'Clean Model',
            provider: 'ch',
            account: 'acc',
            think: 'high',
            created_at: '2026-11-19T12:00:00Z',
            cost: 0.2,
            score: 80,
            rounds: 1
        }
    ];
    f.chart.render(rows, { axis: 'cost', log: false, pareto: true });
    const points = chartFixtureNodes(f, 'score-cost-point');
    const anomPoint = points.find(node => node.attributes['data-record-id'] === 'anomalous-top');
    const usagePoint = points.find(node => node.attributes['data-record-id'] === 'usage-only-top');
    const cleanPoint = points.find(node => node.attributes['data-record-id'] === 'clean-frontier');

    // Both anomalous records get amber badge and data-has-anomalies; clean record does not.
    expect(anomPoint.attributes['data-has-anomalies']).toBe('true');
    expect(anomPoint.children.some(child => child.attributes.class?.includes('record-anomaly-badge'))).toBe(true);
    expect(usagePoint.attributes['data-has-anomalies']).toBe('true');
    expect(usagePoint.attributes['data-usage-incomplete']).toBe('true');
    expect(usagePoint.children.some(child => child.attributes.class?.includes('record-anomaly-badge'))).toBe(true);
    expect(cleanPoint.attributes['data-has-anomalies']).toBeUndefined();
    expect(cleanPoint.children.some(child => child.attributes.class?.includes('record-anomaly-badge'))).toBe(false);

    // Pareto frontier includes ONLY clean-frontier, never the higher-scoring/cheaper anomalous points.
    const frontier = chartFixtureNodes(f, 'pareto-frontier')[0];
    const cleanMarker = cleanPoint.children.find(node => node.attributes.class?.includes('record-marker'));
    const frontierPts = frontier.attributes.points
        .split(' ')
        .slice(0, -1)
        .map(pair => pair.split(',').map(Number));
    expect(frontierPts).toEqual([[Number(cleanMarker.attributes.cx), Number(cleanMarker.attributes.cy)]]);

    // Hovering anomalous point displays unified header and all specific anomaly reasons.
    anomPoint.emit('pointerenter');
    const tooltipText = collectText(tooltip);
    expect(tooltipText).toContain('含异常项（不参与前沿）');
    expect(tooltipText).toContain('1 个样本超时（按 0 分计）');
    expect(tooltipText).toContain('1 个样本提交答案后异常中止（按最后一次提交评分）');
    expect(tooltipText).toContain('1 个样本未调用 submit_answer 提交（按 0 分计）');
    f.chart.destroy();
});

test('maskAccounts masks single-model multi-account SVG point labels before truncation and masks point aria-labels while preserving gateway defaults', () => {
    const f = chartResizeFixture();
    const rows = [
        {
            id: 'pinned-email',
            source: 'run',
            run_id: 'r1',
            model: 'gpt-6-luna',
            modelDisplayName: 'GPT-6 Luna',
            providerId: 'provider:openai',
            providerName: 'OpenAI',
            provider: '网关目录归属',
            accountId: 'account:alice.researcher@company.invalid',
            account: 'alice.researcher@company.invalid（固定绑定）',
            accountDisplayId: 'alice.researcher@company.invalid',
            think: 'high',
            created_at: '2026-11-19T12:00:00Z',
            cost: 0.2,
            score: 92,
            rounds: 1
        },
        {
            id: 'gateway-auto',
            source: 'run',
            run_id: 'r2',
            model: 'gpt-6-luna',
            modelDisplayName: 'GPT-6 Luna',
            providerId: 'provider:openai',
            providerName: 'OpenAI',
            provider: '网关目录归属',
            accountId: 'gateway-binding:gateway-default',
            account: '网关自动分配（账号未记录）',
            accountShortName: '网关自动分配',
            accountDisplayId: '实际账号未记录',
            think: 'high',
            created_at: '2026-11-19T12:00:00Z',
            cost: 0.8,
            score: 84,
            rounds: 1
        }
    ];
    f.chart.render(rows, { labels: true, maskAccounts: false });
    const unmaskedLabels = chartFixtureNodes(f, 'chart-point-label').map(node => node.textContent);
    expect(unmaskedLabels).toContain('alice.researc…');
    expect(unmaskedLabels).toContain('默认');
    expect(
        chartFixtureNodes(f, 'score-cost-point').find(node => node.attributes['data-record-id'] === 'pinned-email').attributes[
            'data-color-key'
        ]
    ).toContain('alice.researcher');

    f.chart.render(rows, { labels: true, maskAccounts: true });
    const maskedLabels = chartFixtureNodes(f, 'chart-point-label').map(node => node.textContent);
    expect(maskedLabels.some(label => label.includes('alice'))).toBe(false);
    expect(maskedLabels).toContain('•••••.•••••••…');
    expect(maskedLabels).toContain('默认');

    const points = chartFixtureNodes(f, 'score-cost-point');
    const pinnedPoint = points.find(node => node.attributes['data-record-id'] === 'pinned-email');
    expect(pinnedPoint.attributes['data-color-key']).toBeUndefined();
    const pinnedAria = pinnedPoint.attributes['aria-label'];
    const autoAria = points.find(node => node.attributes['data-record-id'] === 'gateway-auto').attributes['aria-label'];
    expect(pinnedAria).not.toContain('alice.researcher');
    expect(pinnedAria).toContain('•••••.••••••••••@•••••••.•••••••（固定绑定）');
    expect(autoAria).toContain('网关自动分配（账号未记录）');
    f.chart.destroy();
});
