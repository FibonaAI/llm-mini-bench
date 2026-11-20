import { test, expect } from 'bun:test';
import {
    assessmentChartMetric,
    buildObservationAnomalies,
    observationQualitySummary,
    observationSampleAnomalies
} from '../web/assessment-chart-metric.js';
const ids = Array.from({ length: 14 }, (_, i) => `official-${i}`);
function observation(rounds = 1) {
    return {
        bank_version: '1.0',
        bank_scope: 'whole',
        sample_count: 14 * rounds,
        status: 'completed',
        rounds,
        baseline_eligible: false,
        estimated_cost_usd: rounds * 0.14,
        tasks: ids.map(task_id => ({
            task_id,
            samples: Array.from({ length: rounds }, (_, i) => ({ round: i + 1, status: 'completed', content_score: 0.5 }))
        }))
    };
}
const excluded = record =>
    expect(assessmentChartMetric(record, ids, 'cost', '1.0')).toMatchObject({
        score: null,
        cost: null,
        exclusionReason: expect.any(String)
    });
// Complete scores with unknown usage keep the score but are never placed on the usage axis.
const usageExcluded = record =>
    expect(assessmentChartMetric(record, ids, 'cost', '1.0')).toMatchObject({ score: 50, cost: null, exclusionReason: expect.any(String) });
test('complete one through three rounds: equal sample mean and per-round cost', () => {
    for (const rounds of [1, 2, 3]) {
        const result = assessmentChartMetric(observation(rounds), ids, 'cost', '1.0');
        expect(result.score).toBe(50);
        expect(result.cost).toBeCloseTo(0.14);
        expect(result.exclusionReason).toBeNull();
    }
    const record = observation(2);
    record.tasks[0].samples[0].content_score = 0;
    record.tasks[0].samples[1].content_score = 1;
    expect(assessmentChartMetric(record, ids, 'cost', '1.0').score).toBe(50);
});
test('all-zero grades and zero cost are valid; chart log filtering is separate', () => {
    const record = observation();
    record.estimated_cost_usd = 0;
    record.tasks.forEach(task => {
        task.samples[0].content_score = 0;
    });
    expect(assessmentChartMetric(record, ids, 'cost', '1.0')).toEqual({ score: 0, cost: 0, exclusionReason: null, usageLowerBound: null });
});
test('canonical bank must supply exactly fourteen unique nonempty IDs', () => {
    for (const expected of [null, [], ids.slice(1), [...ids, 'extra'], [...ids.slice(1), ids[1]], [...ids.slice(1), '']]) {
        expect(assessmentChartMetric(observation(), expected, 'cost', '1.0').exclusionReason).toBeTruthy();
    }
});
test('whole-bank scope and original target sample count are required evidence', () => {
    for (const scope of [undefined, null, 'subset', '']) excluded({ ...observation(), bank_scope: scope });
    for (const count of [undefined, null, 0, 13, 15, 14.5, '14', 42]) excluded({ ...observation(), sample_count: count });
    excluded({ ...observation(3), sample_count: 43 });
});
test('invalid bank, status, rounds, partial or duplicate tasks are excluded', () => {
    for (const [key, value] of [
        ['bank_version', '0.9'],
        ['status', 'failed'],
        ['status', 'cancelled'],
        ['status', 'interrupted'],
        ['rounds', 0],
        ['rounds', 4],
        ['rounds', 1.5],
        ['rounds', null]
    ])
        excluded({ ...observation(), [key]: value });
    for (const mutate of [
        r => r.tasks.pop(),
        r => r.tasks.push(r.tasks[0]),
        r => (r.tasks[0].task_id = ids[1]),
        r => (r.tasks[0].task_id = 'unexpected')
    ]) {
        const record = observation();
        mutate(record);
        excluded(record);
    }
});
test('missing, extra, duplicate and out-of-range rounds cannot be scored', () => {
    for (const mutate of [
        r => r.tasks[0].samples.pop(),
        r => r.tasks[0].samples.push(r.tasks[0].samples[0]),
        r => (r.tasks[0].samples[1].round = 1),
        r => (r.tasks[0].samples[0].round = 0),
        r => (r.tasks[0].samples[0].round = 3)
    ]) {
        const record = observation(2);
        mutate(record);
        excluded(record);
    }
});
test('failed samples, null, nonfinite, string and out-of-range scores never become zero', () => {
    for (const value of [null, undefined, NaN, Infinity, -0.1, 1.1, '0.5']) {
        const record = observation();
        record.tasks[0].samples[0].content_score = value;
        excluded(record);
    }
    for (const status of ['failed', 'cancelled', 'running', null]) {
        const record = observation();
        record.tasks[0].samples[0].status = status;
        excluded(record);
    }
});
test('unknown, negative, nonfinite or string cost is excluded', () => {
    for (const value of [null, undefined, -1, NaN, Infinity, '0']) usageExcluded({ ...observation(), estimated_cost_usd: value });
});
test('historical or non-promotable complete observations retain valid metric without mutation', () => {
    const record = observation(3);
    record.implementation = 'python-historical';
    record.source_sha256 = { a: 'a'.repeat(64), b: 'b'.repeat(64), c: 'c'.repeat(64), d: 'd'.repeat(64) };
    record.tasks.reverse();
    record.tasks.forEach(task => task.samples.reverse());
    const before = JSON.stringify(record);
    expect(assessmentChartMetric(record, ids, 'cost', '1.0').score).toBe(50);
    expect(JSON.stringify(record)).toBe(before);
});

test('usage gaps expose a labelled known lower bound only when attempt accounting proves unknown attempts', () => {
    const record = {
        ...observation(2),
        estimated_cost_usd: null,
        usage: null,
        usage_accounting: {
            usage_lower_bound: { input_tokens: 100, output_tokens: 60 },
            estimated_cost_usd_lower_bound: 0.2,
            unknown_usage_attempts: 3,
            unknown_cost_attempts: 2,
            attempts: 30
        }
    };
    const cost = assessmentChartMetric(record, ids, 'cost', '1.0'),
        tokens = assessmentChartMetric(record, ids, 'tokens', '1.0');
    expect(cost).toMatchObject({ score: 50, cost: null, usageLowerBound: { cost: 0.1, unknownAttempts: 2, attempts: 30 } });
    expect(cost.exclusionReason).toContain('2 次请求尝试未返回用量');
    expect(tokens).toMatchObject({ score: 50, cost: null, usageLowerBound: { cost: 80, unknownAttempts: 3 } });
    // No accounting evidence: no bound is invented.
    expect(assessmentChartMetric({ ...observation(), estimated_cost_usd: null }, ids, 'cost', '1.0').usageLowerBound).toBeNull();
    // A failed run never gets a score or bound, even with accounting.
    const failed = { ...record, status: 'failed' };
    expect(assessmentChartMetric(failed, ids, 'cost', '1.0')).toMatchObject({ score: null, cost: null, usageLowerBound: null });
});

test('task count and version come from the production bank, not hardcoded 1.0 / 14', () => {
    const twelve = ids.slice(0, 12);
    const record = { ...observation(2), bank_version: '3.0', sample_count: 24, tasks: observation(2).tasks.slice(0, 12) };
    expect(assessmentChartMetric(record, twelve, 'cost', '3.0')).toMatchObject({ score: 50, exclusionReason: null });
    expect(assessmentChartMetric(record, twelve, 'cost', '1.0').exclusionReason).toBe('题库版本不兼容');
    expect(assessmentChartMetric(record, twelve).exclusionReason).toBe('正式题库尚未加载或无效');
});

test('duration axis computes per-round elapsed seconds and timeout samples score zero without excluding the run', () => {
    const record = observation(2);
    record.elapsed_seconds = 360;
    expect(assessmentChartMetric(record, ids, 'duration', '1.0')).toMatchObject({ score: 50, cost: 180, exclusionReason: null });
    // Falls back to summing sample elapsed_seconds when top-level elapsed_seconds is absent
    const fromSamples = observation(2);
    for (const task of fromSamples.tasks) for (const sample of task.samples) sample.elapsed_seconds = 10;
    expect(assessmentChartMetric(fromSamples, ids, 'duration', '1.0')).toMatchObject({
        score: 50,
        cost: (ids.length * 2 * 10) / 2,
        exclusionReason: null
    });
    // Missing duration excludes cleanly without inventing zero
    expect(assessmentChartMetric(observation(2), ids, 'duration', '1.0').exclusionReason).toBe('未记录完整执行耗时');

    // Timeout sample counts as 0 and keeps the run plottable; api_failure still excludes
    const withTimeout = observation(1);
    withTimeout.tasks[0].samples[0] = { round: 1, status: 'timeout', content_score: 0, elapsed_seconds: 600 };
    const timeoutMetric = assessmentChartMetric(withTimeout, ids, 'cost', '1.0');
    expect(timeoutMetric.exclusionReason).toBeNull();
    expect(timeoutMetric.score).toBeCloseTo((((ids.length - 1) * 0.5) / ids.length) * 100, 6);
    const quality = observationQualitySummary(withTimeout);
    expect(quality.timedOut).toBe(1);
    expect(quality.failed).toBe(0);
    expect(quality.retryable).toBe(1);
    expect(quality.text).toContain('超时');
});

test('unified anomaly helpers detect timeout, ended_after_submission, no_submission, and usageIncomplete', () => {
    const clean = observation(1);
    expect(buildObservationAnomalies(observationSampleAnomalies(clean), null)).toEqual({
        timedOut: 0,
        endedAfterSubmission: 0,
        noSubmission: 0,
        usageIncomplete: null,
        items: [],
        hasAny: false,
        summary: ''
    });

    const mixed = observation(1);
    mixed.tasks[0].samples[0] = { round: 1, status: 'timeout', content_score: 0, outcome: 'timeout', ended_after_submission: null };
    mixed.tasks[1].samples[0] = {
        round: 1,
        status: 'completed',
        content_score: 1,
        outcome: 'exact_match',
        ended_after_submission: 'api_failure'
    };
    mixed.tasks[2].samples[0] = {
        round: 1,
        status: 'completed',
        content_score: 0,
        outcome: 'no_submission',
        ended_after_submission: null
    };
    const sampleAnomalies = observationSampleAnomalies(mixed);
    expect(sampleAnomalies).toEqual({ timedOut: 1, endedAfterSubmission: 1, noSubmission: 1 });
    const combined = buildObservationAnomalies(sampleAnomalies, { cost: 0.1, unknownAttempts: 2, attempts: 14 });
    expect(combined.hasAny).toBe(true);
    expect(combined.items).toHaveLength(4);
    expect(combined.summary).toContain('1 个样本超时（按 0 分计）');
    expect(combined.summary).toContain('1 个样本提交答案后异常中止（按最后一次提交评分）');
    expect(combined.summary).toContain('1 个样本未调用 submit_answer 提交（按 0 分计）');
    expect(combined.summary).toContain('用量不完整：2 次请求尝试未返回用量');
});
