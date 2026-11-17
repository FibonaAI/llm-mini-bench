import { expect, test } from 'bun:test';
import { buildAnalysisHistoryStates, selectAnalysisHistoryRecords } from '../web/analysis-history.js';
import { chartCategory, createChartColorRegistry } from '../web/chart-colors.js';
import { buildChartLegendGroups } from '../web/chart-legend.js';

const base = {
    source: 'run',
    bank_version: '1.0',
    bank_scope: 'whole',
    model: 'Atlas',
    providerId: 'channel',
    accountId: 'account',
    think: 'low'
};
const dated = (id, day, fields = {}) => ({ ...base, id, created_at: new Date(2026, 10, day, 12).toISOString(), ...fields });

test('historical marker states never promote older success after latest failure or filtering', () => {
    const rows = [
        dated('old', 3, { score: 90, cost: 1 }),
        dated('failed', 17, { score: null, cost: null }),
        dated('baseline', 3, { source: 'baseline' }),
        dated('medium', 3, { think: 'medium' }),
        dated('other-account', 3, { accountId: 'other' }),
        { ...base, id: 'undated', created_at: null }
    ];
    const before = JSON.stringify(rows),
        states = buildAnalysisHistoryStates(rows);
    expect([...states.values()]).toEqual(['historical', 'latest', 'latest', 'latest', 'latest', 'unknown']);
    expect(selectAnalysisHistoryRecords(rows).map(record => record.id)).not.toContain('old');
    expect(states.get(rows.filter(record => record.score === 90)[0].id)).toBe('historical');
    expect(JSON.stringify(rows)).toBe(before);
});

test('time categories use recorded local dates and the same multicolor palette as other dimensions', () => {
    const rows = [dated('early', 3), dated('middle', 10), dated('late', 17)];
    const registry = createChartColorRegistry(),
        reversed = createChartColorRegistry();
    registry.register(rows, 'time');
    reversed.register([...rows].reverse(), 'time');
    const models = ['A', 'B', 'C'].map(model => ({ model }));
    registry.register(models, 'model');
    for (const dark of [false, true]) {
        const colors = rows.map(record => registry.color(record, 'time', dark));
        expect(colors).toEqual(models.map(record => registry.color(record, 'model', dark)));
        expect(colors).toEqual(rows.map(record => reversed.color(record, 'time', dark)));
        registry.register([rows[2]], 'time');
        expect(rows.map(record => registry.color(record, 'time', dark))).toEqual(colors);
        expect(registry.color({ ...rows[0], model: 'Other', source: 'baseline' }, 'time', dark)).toBe(colors[0]);
    }
    expect(chartCategory(rows[0], 'time').label).toBe('2026-11-03');
    expect(chartCategory({ ...rows[0], created_at: new Date(2026, 10, 3, 23, 59).toISOString() }, 'time').key).toBe(
        chartCategory(rows[0], 'time').key
    );
    for (const created_at of [null, '', 'invalid']) expect(chartCategory({ created_at }, 'time').label).toBe('时间未记录');
    expect(registry.color({ created_at: null }, 'time')).toBe('#62666e');
});

test('time legend orders dates chronologically with textual unknown, counting only supplied visible points', () => {
    const rows = [dated('late', 17), { ...base, id: 'unknown' }, dated('early', 3), dated('repeat', 3)];
    const groups = buildChartLegendGroups(rows, 'time');
    expect(groups.map(group => [group.name, group.count])).toEqual([
        ['2026-11-03', 2],
        ['2026-11-17', 1],
        ['时间未记录', 1]
    ]);
    expect(groups[0].searchText).toContain('atlas');
    expect(buildChartLegendGroups([rows[0]], 'time')[0].key).toBe(groups[1].key);
});
