import { expect, test } from 'bun:test';
import { selectAnalysisHistoryRecords } from '../web/analysis-history.js';

const record = (id, created_at, fields = {}) => ({
    id,
    created_at,
    source: 'run',
    bank_version: '1.0',
    bank_scope: 'whole',
    providerId: 'channel',
    accountId: 'account',
    model: 'model',
    think: 'high',
    ...fields
});
const ids = records => records.map(record => record.id);

test('latest is timestamp-based, not input order, score, status or axis eligibility', () => {
    const old = record('old', '2026-11-01T12:00:00Z', { score: 100, cost: 1 });
    const newest = record('new', '2026-11-03T12:00:00Z', { score: null, cost: null, status: 'failed' });
    const middle = record('middle', '2026-11-02T12:00:00Z', { score: 90, cost: 1 });
    for (const records of [
        [old, newest, middle],
        [newest, middle, old]
    ])
        expect(ids(selectAnalysisHistoryRecords(records))).toEqual(['new']);
    expect(ids(selectAnalysisHistoryRecords([old, newest], { mode: 'all' }))).toEqual(['new', 'old']);
});

test('latest keeps recorded channel/account/model/Thinking, bank scope and source separate', () => {
    const old = record('old', '2026-11-01T00:00:00Z');
    const dimensions = [
        { providerId: 'other' },
        { accountId: 'other' },
        { model: 'other' },
        { think: 'default' },
        { bank_version: '2.3' },
        { bank_scope: 'subset' },
        { source: 'baseline' }
    ];
    const records = [old, ...dimensions.map((fields, index) => record(`different-${index}`, '2026-11-02T00:00:00Z', fields))];
    expect(selectAnalysisHistoryRecords(records)).toHaveLength(records.length);
    // Coloring and display names do not change identity.
    expect(ids(selectAnalysisHistoryRecords([old, record('new', '2026-11-02T00:00:00Z', { modelDisplayName: 'Friendly name' })]))).toEqual([
        'new'
    ]);
});

test('unknown timestamps remain unknown and ties resolve consistently without mutating records', () => {
    const rows = [
        record('a', '2026-11-01T00:00:00Z'),
        record('b', '2026-11-01T00:00:00Z'),
        record('missing', null),
        record('invalid', 'not a date')
    ];
    const before = JSON.stringify(rows);
    expect(ids(selectAnalysisHistoryRecords(rows))).toEqual(['b', 'missing', 'invalid']);
    expect(ids(selectAnalysisHistoryRecords([...rows].reverse())).sort()).toEqual(['b', 'invalid', 'missing']);
    expect(JSON.stringify(rows)).toBe(before);
});

test('historical date bounds include the entire local end day and do not invent missing timestamps', () => {
    const rows = [
        record('start', new Date(2026, 10, 2, 0, 0).toISOString()),
        record('end', new Date(2026, 10, 2, 23, 59, 59).toISOString()),
        record('next', new Date(2026, 10, 3, 0, 0).toISOString()),
        record('missing', null)
    ];
    const range = { mode: 'all', from: '2026-11-02', to: '2026-11-02' };
    expect(ids(selectAnalysisHistoryRecords(rows, range))).toEqual(['end', 'start']);
    expect(selectAnalysisHistoryRecords(rows, { ...range, from: '2026-11-03' })).toEqual([]);
    expect(selectAnalysisHistoryRecords(rows, { mode: 'all', from: '2026-02-31' })).toEqual([]);
    expect(selectAnalysisHistoryRecords(rows, { mode: 'all' })).toHaveLength(4);
});

test('specified records use exact IDs, preserve repeated evaluations, and intersect date ranges', () => {
    const rows = [record('old', '2026-11-01T00:00:00Z'), record('new', '2026-11-02T00:00:00Z')];
    expect(selectAnalysisHistoryRecords(rows, { mode: 'selected' })).toEqual([]);
    expect(ids(selectAnalysisHistoryRecords(rows, { mode: 'selected', selectedIds: new Set(['old']) }))).toEqual(['old']);
    expect(ids(selectAnalysisHistoryRecords(rows, { mode: 'selected', selectedIds: new Set(['old', 'new']) }))).toEqual(['new', 'old']);
    expect(selectAnalysisHistoryRecords(rows, { mode: 'selected', selectedIds: new Set(['old']), from: '2026-11-03' })).toEqual([]);
});
