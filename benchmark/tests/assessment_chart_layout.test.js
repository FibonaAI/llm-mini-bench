import { expect, test } from 'bun:test';
import { placeChartLabels } from '../web/chart-layout.js';
import { thinkingSeries, scoreCostFrontier } from '../web/score-cost-chart.js';
import { assessmentChartMetric } from '../web/assessment-chart-metric.js';
import { chartCategory, createChartColorRegistry } from '../web/chart-colors.js';

test('model/channel colors distinguish routes while Thinking and baseline source preserve the series color', () => {
    const a = { providerId: 'a', providerName: 'A', modelDisplayName: 'GPT-6 Luna', think: 'low', source: 'run' };
    const b = { ...a, providerId: 'b', providerName: 'B' };
    const registry = createChartColorRegistry();
    registry.register([a, b], 'series');
    expect(registry.color(a, 'series')).not.toBe(registry.color(b, 'series'));
    expect(registry.color(a, 'series')).toBe(registry.color({ ...a, think: 'high', source: 'baseline' }, 'series'));
    expect(chartCategory(a, 'series').label).toBe('GPT-6 Luna · A');
    expect(chartCategory(a, 'series').key).toBe(chartCategory({ ...a, modelDisplayName: 'GPT-6-Luna' }, 'series').key);
});
test('crowded labels stay close to their anchors instead of spilling across the plot', () => {
    const points = Array.from({ length: 43 }, (_, i) => ({ id: String(i), x: 80 + (i % 22) * 35, y: 40 + (i < 22 ? 0 : 35), width: 112 }));
    const placed = placeChartLabels(points, points, { left: 50, right: 1000, top: 40, bottom: 440 });
    expect(placed.length).toBeGreaterThan(0);
    expect(placed.some(item => item.id === '0')).toBe(true);
    for (const item of placed) {
        expect(Math.abs(item.box.y + 11 - item.y)).toBeLessThanOrEqual(44);
        expect(item.box.y).toBeGreaterThanOrEqual(40);
        expect(item.box.y + item.box.h).toBeLessThanOrEqual(440);
    }
    for (let i = 0; i < placed.length; i++)
        for (let j = i + 1; j < placed.length; j++) {
            const a = placed[i].box,
                b = placed[j].box;
            expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).toBe(false);
        }
});
test('Thinking lines never bridge channels, batches, accounts or duplicate levels', () => {
    const base = {
        source: 'run',
        task_id: 'batch',
        model: 'model',
        providerId: 'a',
        accountId: 'one',
        score: 90,
        cost: 1,
        bank_version: '1.0',
        bank_scope: 'whole'
    };
    const points = [
        { ...base, id: 'low', think: 'low' },
        { ...base, id: 'high', think: 'high' },
        { ...base, id: 'other-channel', providerId: 'b', think: 'max' },
        { ...base, id: 'other-batch', task_id: 'old', think: 'max' },
        { ...base, id: 'other-account', accountId: 'two', think: 'max' }
    ];
    expect(thinkingSeries(points).map(series => series.map(p => p.id))).toEqual([['low', 'high']]);
    for (const fields of [{ model: 'other-exact-request', modelDisplayName: 'model' }, { bank_version: '2.3' }, { bank_scope: 'subset' }]) {
        expect(thinkingSeries([points[0], { ...points[1], ...fields }])).toEqual([]);
    }
    expect(
        thinkingSeries([
            { ...points[0], modelDisplayName: 'Friendly low' },
            { ...points[1], modelDisplayName: 'Friendly high' }
        ])
    ).toHaveLength(1);
    expect(thinkingSeries([...points, { ...points[0], id: 'duplicate' }])).toEqual([]);
    expect(
        scoreCostFrontier([
            { cost: 0, score: 100 },
            { cost: 1, score: 90 },
            { cost: 2, score: 80 },
            { cost: 3, score: 100 }
        ])
    ).toEqual([
        { cost: 1, score: 90 },
        { cost: 3, score: 100 }
    ]);
});
test('token-axis eligibility is independent of USD but never imputes unknown usage', () => {
    const ids = Array.from({ length: 14 }, (_, i) => String(i));
    const record = {
        bank_version: '1.0',
        bank_scope: 'whole',
        status: 'completed',
        rounds: 2,
        sample_count: 28,
        estimated_cost_usd: null,
        usage: { input_tokens: 200, output_tokens: 100 },
        tasks: ids.map(task_id => ({ task_id, samples: [1, 2].map(round => ({ round, status: 'completed', content_score: 1 })) }))
    };
    expect(assessmentChartMetric(record, ids, 'cost', '1.0')).toMatchObject({ score: 100, cost: null }); // score known; unknown USD only removes the cost-axis position
    expect(assessmentChartMetric(record, ids, 'tokens', '1.0')).toEqual({
        score: 100,
        cost: 150,
        exclusionReason: null,
        usageLowerBound: null
    });
    record.usage.input_tokens = null;
    expect(assessmentChartMetric(record, ids, 'tokens', '1.0')).toMatchObject({ score: 100, cost: null });
});

test('model label budget preserves candidate priority without moving points or adding distant annotations', () => {
    const candidates = Array.from({ length: 10 }, (_, index) => ({
        id: String(index),
        group: `model-${index}`,
        x: 80 + index * 85,
        y: 60 + (index % 2) * 100,
        width: 48
    }));
    const before = JSON.stringify(candidates);
    const bounds = { left: 40, right: 1000, top: 38, bottom: 340, maxLabels: 3 };
    const labels = placeChartLabels(candidates, candidates, bounds);
    expect(labels).toHaveLength(3);
    expect(labels.map(label => label.id)).toEqual(['0', '1', '2']);
    expect(JSON.stringify(candidates)).toBe(before);
    for (const label of labels) expect(Math.abs(label.box.y + 11 - label.y)).toBeLessThanOrEqual(44);
});
