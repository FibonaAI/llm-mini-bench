import { expect, test } from 'bun:test';
import { formatChartRecordTime, summarizeChartRecordTimes, overlappingChartRecords } from '../web/chart-point-time.js';

const records = Array.from({ length: 16 }, (_, index) => ({
    id: String(index),
    created_at: new Date(Date.UTC(2026, 10, index + 1, 12, 34)).toISOString(),
    cost: 1,
    score: 90
}));

test('chart time uses recorded timestamps, including seconds, and keeps missing dates explicit', () => {
    expect(formatChartRecordTime(records[0])).toContain('2026');
    expect(formatChartRecordTime(records[0])).toMatch(/\d{2}:\d{2}:\d{2}/);
    for (const created_at of [null, undefined, '', 'invalid']) expect(formatChartRecordTime({ created_at })).toBe('时间未记录');
});

test('few overlaps list timestamps; sixteen stable repeats show only range and count', () => {
    const few = summarizeChartRecordTimes(records.slice(0, 3));
    expect(few).toContain('共 3 条记录');
    for (const record of records.slice(0, 3)) expect(few).toContain(formatChartRecordTime(record));
    const many = summarizeChartRecordTimes(records);
    expect(many).toBe(`${formatChartRecordTime(records[0])} 至 ${formatChartRecordTime(records.at(-1))} · 共 16 条记录`);
    expect(many.length).toBeLessThan(100);
    expect(summarizeChartRecordTimes([...records, { created_at: null }])).toContain('1 条时间未记录');
    expect(summarizeChartRecordTimes(records.map(record => ({ ...record, created_at: records[0].created_at })))).toContain('共 16 条记录');
});

test('overlap detection uses rendered distance, never averages or moves chart coordinates', () => {
    const point = records[0],
        nearby = { ...point, id: 'near', cost: 1.05 },
        far = { ...point, id: 'far', cost: 2 };
    const rows = [point, nearby, far],
        before = JSON.stringify(rows);
    expect(
        overlappingChartRecords(
            rows,
            point,
            cost => cost * 100,
            score => score
        ).map(record => record.id)
    ).toEqual(['0', 'near']);
    expect(
        overlappingChartRecords(
            rows,
            point,
            cost => cost * 1000,
            score => score
        ).map(record => record.id)
    ).toEqual(['0']);
    expect(JSON.stringify(rows)).toBe(before);
});
