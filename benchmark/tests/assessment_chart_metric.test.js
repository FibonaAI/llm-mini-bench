import { test, expect } from 'bun:test';
import { assessmentChartMetric } from '../web/assessment-chart-metric.js';
const ids = Array.from({ length: 14 }, (_, i) => `official-${i}`);
function observation(rounds = 1) {
  return { bank_version: '1.0', bank_scope: 'whole', sample_count: 14 * rounds, status: 'completed', rounds, baseline_eligible: false, estimated_cost_usd: rounds * .14,
    tasks: ids.map(task_id => ({ task_id, samples: Array.from({ length: rounds }, (_, i) => ({ round: i + 1, status: 'completed', content_score: .5 })) })) };
}
const excluded = record => expect(assessmentChartMetric(record, ids)).toMatchObject({ score: null, cost: null, exclusionReason: expect.any(String) });
// Complete scores with unknown usage keep the score but are never placed on the usage axis.
const usageExcluded = record => expect(assessmentChartMetric(record, ids)).toMatchObject({ score: 50, cost: null, exclusionReason: expect.any(String) });
test('complete one through three rounds: equal sample mean and per-round cost', () => {
  for (const rounds of [1, 2, 3]) {
    const result = assessmentChartMetric(observation(rounds), ids);
    expect(result.score).toBe(50); expect(result.cost).toBeCloseTo(.14); expect(result.exclusionReason).toBeNull();
  }
  const record = observation(2); record.tasks[0].samples[0].content_score = 0; record.tasks[0].samples[1].content_score = 1;
  expect(assessmentChartMetric(record, ids).score).toBe(50);
});
test('all-zero grades and zero cost are valid; chart log filtering is separate', () => {
  const record = observation(); record.estimated_cost_usd = 0;
  record.tasks.forEach(task => { task.samples[0].content_score = 0; });
  expect(assessmentChartMetric(record, ids)).toEqual({ score: 0, cost: 0, exclusionReason: null, usageLowerBound: null });
});
test('canonical bank must supply exactly fourteen unique nonempty IDs', () => {
  for (const expected of [null, [], ids.slice(1), [...ids, 'extra'], [...ids.slice(1), ids[1]], [...ids.slice(1), '']]) {
    expect(assessmentChartMetric(observation(), expected).exclusionReason).toBeTruthy();
  }
});
test('whole-bank scope and original target sample count are required evidence', () => {
  for (const scope of [undefined, null, 'subset', '']) excluded({ ...observation(), bank_scope: scope });
  for (const count of [undefined, null, 0, 13, 15, 14.5, '14', 42]) excluded({ ...observation(), sample_count: count });
  excluded({ ...observation(3), sample_count: 43 });
});
test('invalid bank, status, rounds, partial or duplicate tasks are excluded', () => {
  for (const [key, value] of [['bank_version', '0.9'], ['status', 'failed'], ['status', 'cancelled'], ['status', 'interrupted'], ['rounds', 0], ['rounds', 4], ['rounds', 1.5], ['rounds', null]]) excluded({ ...observation(), [key]: value });
  for (const mutate of [r => r.tasks.pop(), r => r.tasks.push(r.tasks[0]), r => r.tasks[0].task_id = ids[1], r => r.tasks[0].task_id = 'unexpected']) { const record = observation(); mutate(record); excluded(record); }
});
test('missing, extra, duplicate and out-of-range rounds cannot be scored', () => {
  for (const mutate of [r => r.tasks[0].samples.pop(), r => r.tasks[0].samples.push(r.tasks[0].samples[0]), r => r.tasks[0].samples[1].round = 1, r => r.tasks[0].samples[0].round = 0, r => r.tasks[0].samples[0].round = 3]) { const record = observation(2); mutate(record); excluded(record); }
});
test('failed samples, null, nonfinite, string and out-of-range scores never become zero', () => {
  for (const value of [null, undefined, NaN, Infinity, -.1, 1.1, '0.5']) { const record = observation(); record.tasks[0].samples[0].content_score = value; excluded(record); }
  for (const status of ['failed', 'cancelled', 'running', null]) { const record = observation(); record.tasks[0].samples[0].status = status; excluded(record); }
});
test('unknown, negative, nonfinite or string cost is excluded', () => {
  for (const value of [null, undefined, -1, NaN, Infinity, '0']) usageExcluded({ ...observation(), estimated_cost_usd: value });
});
test('historical or non-promotable complete observations retain valid metric without mutation', () => {
  const record = observation(3);
  record.implementation = 'python-historical'; record.source_sha256 = { a: 'a'.repeat(64), b: 'b'.repeat(64), c: 'c'.repeat(64), d: 'd'.repeat(64) };
  record.tasks.reverse(); record.tasks.forEach(task => task.samples.reverse());
  const before = JSON.stringify(record);
  expect(assessmentChartMetric(record, ids).score).toBe(50);
  expect(JSON.stringify(record)).toBe(before);
});

test('usage gaps expose a labelled known lower bound only when attempt accounting proves unknown attempts', () => {
  const record = { ...observation(2), estimated_cost_usd: null, usage: null, usage_accounting: { usage_lower_bound: { input_tokens: 100, output_tokens: 60 }, estimated_cost_usd_lower_bound: .2, unknown_usage_attempts: 3, unknown_cost_attempts: 2, attempts: 30 } };
  const cost = assessmentChartMetric(record, ids), tokens = assessmentChartMetric(record, ids, 'tokens');
  expect(cost).toMatchObject({ score: 50, cost: null, usageLowerBound: { cost: .1, unknownAttempts: 2, attempts: 30 } });
  expect(cost.exclusionReason).toContain('2 次请求尝试未返回用量');
  expect(tokens).toMatchObject({ score: 50, cost: null, usageLowerBound: { cost: 80, unknownAttempts: 3 } });
  // No accounting evidence: no bound is invented.
  expect(assessmentChartMetric({ ...observation(), estimated_cost_usd: null }, ids).usageLowerBound).toBeNull();
  // A failed run never gets a score or bound, even with accounting.
  const failed = { ...record, status: 'failed' };
  expect(assessmentChartMetric(failed, ids)).toMatchObject({ score: null, cost: null, usageLowerBound: null });
});
