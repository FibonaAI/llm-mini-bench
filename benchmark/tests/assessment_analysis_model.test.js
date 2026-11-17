import { expect, test } from 'bun:test';
import { createAnalysisModel, attachAnalysisBatchIds } from '../web/analysis-model.js';
import { assessmentChartMetric } from '../web/assessment-chart-metric.js';

const ids = Array.from({ length: 14 }, (_, index) => `official-${index}`);
const bank = { version: '1.0', tasks: ids.map(id => ({ id })) };
function observation(id = 'one', extra = {}) {
    return {
        id,
        run_id: `run-${id}`,
        provider_id: 'channel',
        account_ref: 'account',
        model: 'model',
        thinking: 'high',
        source: 'run',
        bank_version: '1.0',
        bank_scope: 'whole',
        status: 'completed',
        rounds: 2,
        sample_count: 28,
        estimated_cost_usd: 0.4,
        usage: { input_tokens: 40, output_tokens: 20 },
        tasks: ids.map(task_id => ({ task_id, samples: [1, 2].map(round => ({ round, status: 'completed', content_score: 0.5 })) })),
        ...extra
    };
}
function countedModel() {
    const calls = [];
    const model = createAnalysisModel({
        deriveMetric: (...args) => {
            calls.push(args);
            return assessmentChartMetric(...args);
        }
    });
    model.setBank(bank);
    return { model, calls };
}

test('derived models cache by observation response, official task IDs and axis only', () => {
    const { model, calls } = countedModel();
    const observations = [observation()];
    model.setObservations(observations);
    const cost = model.records('cost');
    expect(cost[0]).toMatchObject({ score: 50, cost: 0.2, exclusionReason: null });
    // All presentation changes reuse these exact records without scanning task samples.
    for (let redraw = 0; redraw < 10; redraw++) expect(model.records('cost')).toBe(cost);
    model.setObservations(observations);
    model.setBank({ ...bank, tasks: bank.tasks.map(task => ({ ...task, title: 'Label only' })) });
    expect(model.records('cost')).toBe(cost);
    expect(calls).toHaveLength(1);
    expect(model.records('tokens')[0].cost).toBe(30);
    expect(calls).toHaveLength(2);
    expect(model.records('cost')).toBe(cost);
    model.setObservations([observation('one', { estimated_cost_usd: 0.8 })]);
    expect(model.records('cost')[0].cost).toBe(0.4);
    expect(calls).toHaveLength(3);
    model.setBank({ ...bank, tasks: [...bank.tasks.slice(1), { id: 'unexpected' }] });
    expect(model.records('cost')[0].score).toBeNull();
    expect(model.records('tokens')[0].score).toBeNull();
    expect(calls).toHaveLength(5);
});

test('bank arrival, removal and version invalidate both axes without global stale cache', () => {
    const model = createAnalysisModel();
    model.setObservations([observation()]);
    expect(model.records()[0].score).toBeNull();
    model.setBank(bank);
    expect(model.records()[0].score).toBe(50);
    expect(model.records('tokens')[0].cost).toBe(30);
    model.setBank({ ...bank, version: '2.3' });
    expect(model.records()[0].score).toBeNull();
    expect(model.records('tokens')[0].score).toBeNull();
    model.setBank(bank);
    expect(model.records()[0].score).toBe(50);
    const isolated = createAnalysisModel();
    isolated.setObservations([observation()]);
    expect(isolated.records()[0].score).toBeNull();
});

test('history only attaches batch IDs and never changes metrics or raw observations', () => {
    const { model, calls } = countedModel();
    const originals = [observation(), observation('recorded', { task_id: 'recorded-batch' })];
    const before = JSON.stringify(originals);
    model.setObservations(originals);
    const records = model.records();
    const mapped = attachAnalysisBatchIds(records, () => 'batch-one');
    expect(mapped.map(record => record.task_id)).toEqual(['batch-one', 'recorded-batch']);
    expect(attachAnalysisBatchIds(records, () => 'batch-two')[0].task_id).toBe('batch-two');
    expect(attachAnalysisBatchIds(records, () => undefined)[0].task_id).toBeUndefined();
    expect(mapped.map(record => [record.score, record.cost])).toEqual([
        [50, 0.2],
        [50, 0.2]
    ]);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(originals)).toBe(before);
    expect(mapped[0].original).toBe(originals[0]);
});

test('repeated observations and recorded channel/account/model/Thinking remain distinct', () => {
    const { model } = countedModel();
    model.setObservations([
        observation('one'),
        observation('repeat'),
        observation('low', { thinking: 'low' }),
        observation('other-account', { account_ref: 'other' }),
        observation('other-channel', { provider_id: 'other' })
    ]);
    const records = attachAnalysisBatchIds(model.records(), () => 'batch');
    expect(records.map(record => record.id)).toEqual(['one', 'repeat', 'low', 'other-account', 'other-channel']);
    expect(new Set(records.map(record => [record.providerId, record.accountId, record.model, record.think].join('|'))).size).toBe(4);
    expect(records.every(record => record.task_id === 'batch')).toBe(true);
});

test('axis-specific known usage and complete all-round eligibility are never imputed', () => {
    const { model } = countedModel();
    const failed = observation('failed');
    failed.tasks[0].samples[1].status = 'api_failure';
    const missing = observation('missing');
    missing.tasks[0].samples[1].content_score = null;
    const duplicate = observation('duplicate');
    duplicate.tasks[1].task_id = ids[0];
    model.setObservations([
        observation('cost-only', { usage: null }),
        observation('tokens-only', { estimated_cost_usd: null }),
        observation('zero', { estimated_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } }),
        failed,
        missing,
        duplicate
    ]);
    const cost = model.records(),
        tokens = model.records('tokens');
    // Score is known whenever every sample is graded; unknown usage only removes the axis position.
    expect(cost.map(record => record.score)).toEqual([50, 50, 50, null, null, null]);
    expect(tokens.map(record => record.score)).toEqual([50, 50, 50, null, null, null]);
    expect(cost.map(record => record.cost === null)).toEqual([false, true, false, true, true, true]);
    expect(tokens.map(record => record.cost === null)).toEqual([true, false, false, true, true, true]);
    expect(cost[2].cost).toBe(0);
    expect(tokens[2].cost).toBe(0);
    expect(cost.slice(3).every(record => record.cost === null && record.exclusionReason)).toBe(true);
});
