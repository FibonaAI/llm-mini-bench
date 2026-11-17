import type { ExecutionRun, ExecutionTaskState } from './bench_execution.ts';

type RecordValue = Record<string, unknown>;
const clone = <T>(value: T): T => structuredClone(value);

/** Retry eligibility is a projection only; coordinator admission still rechecks every condition. */
export function execution_retryable_samples(run: ExecutionRun): number {
    // Imported calibration journals have no route identity and are never retried.
    if (run.execution_kind === 'calibration-import-v1') return 0;
    return run.samples.filter(sample => sample.status === 'api_failure' || sample.status === 'budget_not_admitted' && ['transport_failure', 'missing_usage_cost'].includes(run.stop_reason ?? '')).length;
}

/** Result quality is a read-only projection, never a replacement for grading or cumulative usage. */
export function execution_result_quality(run: ExecutionRun) {
    const quality = { completed_samples: 0, unscored_samples: 0, unknown_usage_samples: 0, unknown_cost_samples: 0, prior_unknown_usage_samples: 0, prior_unknown_cost_samples: 0 };
    const knownCost = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const knownUsage = (value: unknown) => {
        const usage = value as RecordValue | null | undefined;
        return knownCost(usage?.input_tokens) && knownCost(usage?.output_tokens);
    };
    for (const sample of run.samples) {
        if (sample.status !== 'completed') continue;
        quality.completed_samples++;
        const score = (sample.grade as RecordValue | null)?.content_score;
        if (!knownCost(score) || score > 1) quality.unscored_samples++;
        if (!knownUsage(sample.usage)) quality.unknown_usage_samples++;
        if (!knownCost(sample.estimated_uncached_cost_usd)) quality.unknown_cost_samples++;
        // Attempts that sent no request (empty calls) consumed nothing and are never unknown.
        const attempts = ((Array.isArray(sample.attempts) ? sample.attempts : []) as RecordValue[]).filter(attempt => !(Array.isArray(attempt.calls) && attempt.calls.length === 0));
        if (attempts.some(attempt => !knownUsage(Object.hasOwn(attempt, 'latest_attempt_usage') ? attempt.latest_attempt_usage : attempt.usage))) quality.prior_unknown_usage_samples++;
        if (attempts.some(attempt => !knownCost(Object.hasOwn(attempt, 'latest_attempt_cost_usd') ? attempt.latest_attempt_cost_usd : attempt.estimated_uncached_cost_usd))) quality.prior_unknown_cost_samples++;
    }
    return quality;
}

/** Run summaries exclude raw evidence and use the caller's current budget snapshot. */
export function execution_run_summary(run: ExecutionRun, budget: RecordValue = run.budget) {
    const counts: Record<string, number> = {};
    for (const sample of run.samples) counts[sample.status] = (counts[sample.status] ?? 0) + 1;
    return {
        id: run.id,
        status: run.status,
        created_at: run.created_at,
        updated_at: run.updated_at,
        stop_reason: run.stop_reason,
        ...(run.task_id ? { task_id: run.task_id } : {}),
        ...(run.execution_kind ? { execution_kind: run.execution_kind } : {}),
        targets: clone(run.plan.targets),
        bank_version: run.plan.bank_version,
        sample_count: run.samples.length,
        sample_status_counts: counts,
        retryable_samples: execution_retryable_samples(run),
        result_quality: execution_result_quality(run),
        budget: clone(budget)
    };
}

/** Task summaries aggregate committed child membership without copying every raw sample. */
export function execution_task_summary(task: ExecutionTaskState, runs: readonly ReturnType<typeof execution_run_summary>[]): RecordValue {
    const children = runs.map(run => ({ run_id: run.id, target: clone(run.targets[0]!), status: run.status,
        created_at: run.created_at, updated_at: run.updated_at, sample_count: run.sample_count,
        sample_status_counts: run.sample_status_counts, result_quality: clone(run.result_quality), budget: run.budget, stop_reason: run.stop_reason, retryable_samples: run.retryable_samples }));
    const run_status_counts: Record<string, number> = {}, sample_status_counts: Record<string, number> = {};
    for (const child of children) {
        run_status_counts[child.status] = (run_status_counts[child.status] ?? 0) + 1;
        for (const [status, count] of Object.entries(child.sample_status_counts)) sample_status_counts[status] = (sample_status_counts[status] ?? 0) + count;
    }
    return { ...clone(task), children, run_status_counts, sample_status_counts };
}
