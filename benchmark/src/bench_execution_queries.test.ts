import { expect, test } from 'bun:test';
import { DEFAULT_LIMITS, type ExecutionRun, type ExecutionTaskState } from './bench_execution.ts';
import { execution_result_quality, execution_retryable_samples, execution_run_summary, execution_task_summary } from './bench_execution_queries.ts';

function fixtureRun(): ExecutionRun {
    return { id: 'run', status: 'failed', task_id: 'task', execution_kind: 'task-child-v1', created_at: 'created', updated_at: 'updated', stop_reason: 'missing_usage_cost', budget: { requests: 2 },
        plan: { bank_version: '1.0', bank_scope: 'whole', bank_snapshot: {}, task_ids: ['fixture'], task_snapshots: [], source_sha256: {}, rounds: 1, concurrency: 1, sample_count: 1, limits: { ...DEFAULT_LIMITS },
            targets: [{ id: 'target', route_id: 'route', label: 'Fixture', account_ref: 'offline', account_evidence: 'configured_binding', model: 'model', thinking: 'default', account_concurrency: 1, pricing: { prompt: 0, completion: 0 }, remote_route: { namespace: 'remote', evidence: 'magpie_via_catalog' } }] },
        samples: ['completed', 'api_failure', 'budget_not_admitted', 'incomplete'].map((status, index) => ({ sample_id: String(index), attempt_id: String(index), run_id: 'run', target_id: 'target', route_id: 'route', account_ref: 'offline', account_evidence: 'configured_binding', task: 'fixture', model: 'model', thinking: 'default', round: 1, status, grade: null, text: 'raw private evidence' })) };
}

test('run query summaries preserve retry predicates and isolate targets and live budget snapshots', () => {
    const run = fixtureRun(), budget = { requests: 3, nested: { count: 1 } };
    const summary = execution_run_summary(run, budget);
    expect(summary.sample_status_counts).toEqual({ completed: 1, api_failure: 1, budget_not_admitted: 1, incomplete: 1 });
    expect(summary.retryable_samples).toBe(2); expect(summary.budget).toEqual(budget);
    expect(summary).not.toHaveProperty('samples'); expect(JSON.stringify(summary)).not.toContain('raw private evidence');
    summary.targets[0]!.remote_route!.namespace = 'mutated';
    (summary.budget.nested as { count: number }).count = 9;
    expect(run.plan.targets[0]!.remote_route!.namespace).toBe('remote'); expect(budget.nested.count).toBe(1);
    run.stop_reason = null; expect(execution_retryable_samples(run)).toBe(1);
    run.stop_reason = 'transport_failure'; expect(execution_retryable_samples(run)).toBe(2);
});

test('task query summaries count committed children without leaking full child evidence', () => {
    const run = fixtureRun();
    const { concurrency: _concurrency, ...base } = run.plan;
    const task: ExecutionTaskState = { id: 'task', status: 'failed', created_at: 'created', updated_at: 'updated', stop_reason: 'child_failure', child_run_ids: ['run', 'other'], plan: {
        ...base, sample_concurrency: 6, run_concurrency: 3, run_count: 2, samples_per_run: 4, total_max_cost_usd: null
    } };
    const other = { ...run, id: 'other', status: 'completed', samples: [run.samples[0]!] };
    const result = execution_task_summary(task, [execution_run_summary(run), execution_run_summary(other)]);
    expect(result.run_status_counts).toEqual({ failed: 1, completed: 1 });
    expect(result.sample_status_counts).toEqual({ completed: 2, api_failure: 1, budget_not_admitted: 1, incomplete: 1 });
    const children = result.children as Record<string, unknown>[];
    expect(children.map(child => child.run_id)).toEqual(task.child_run_ids);
    expect(children[0]).not.toHaveProperty('samples'); expect(children[0]).not.toHaveProperty('plan');
    (result.child_run_ids as string[]).pop(); expect(task.child_run_ids).toHaveLength(2);
    expect(children[0]!.result_quality).toEqual(execution_result_quality(run));
});

test('result quality separates completed scoring and all-attempt accounting without changing evidence', () => {
    const run = fixtureRun(), base = run.samples[0]!;
    const known = { input_tokens: 0, output_tokens: 0 };
    run.status = 'completed';
    run.samples = [
        { ...base, grade: { content_score: 0 }, usage: known, estimated_uncached_cost_usd: 0 },
        { ...base, grade: { content_score: 1 }, usage: null, estimated_uncached_cost_usd: null, latest_attempt_usage: known, latest_attempt_cost_usd: 0,
            attempts: [{ status: 'api_failure', usage: null, estimated_uncached_cost_usd: null }] },
        { ...base, grade: { content_score: null, outcome: 'ambiguous' }, usage: known, estimated_uncached_cost_usd: 0 },
        { ...base, grade: { content_score: 1.1 }, usage: { input_tokens: -1, output_tokens: 2 }, estimated_uncached_cost_usd: -1 },
        { ...base, status: 'running', grade: null, usage: null }
    ];
    const before = structuredClone(run);
    expect(execution_result_quality(run)).toEqual({ completed_samples: 4, unscored_samples: 2, unknown_usage_samples: 2, unknown_cost_samples: 2, prior_unknown_usage_samples: 1, prior_unknown_cost_samples: 1 });
    expect(execution_run_summary(run).result_quality).toEqual(execution_result_quality(run));
    expect(run).toEqual(before);
    run.samples[1]!.attempts = [{ latest_attempt_usage: known, latest_attempt_cost_usd: 0, usage: null, estimated_uncached_cost_usd: null }];
    expect(execution_result_quality(run).prior_unknown_usage_samples).toBe(0);
    expect(execution_result_quality(run).prior_unknown_cost_samples).toBe(0);
});
