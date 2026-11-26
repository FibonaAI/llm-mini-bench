import type { ExecutionRun, ExecutionTaskState } from './bench_execution.ts';
import { RATE_LIMIT_ERROR_CODES } from './assessment_runner.ts';
import { sent_no_request_attempt } from './assessment_observations.ts';

type RecordValue = Record<string, unknown>;
const clone = <T>(value: T): T => structuredClone(value);

/** Distinguish whole-sample timeouts (scored 0, completed task, still retryable) from API failures. */
export function is_timeout_sample(sample: RecordValue): boolean {
    if (sample.status === 'timeout') return true;
    const grade = sample.grade as RecordValue | null | undefined;
    if (grade && typeof grade === 'object' && grade.outcome === 'timeout') return true;
    return sample.status === 'api_failure' && sample.runner_error === 'SampleTimeout';
}

/**
 * Fast-fail stop reasons: after a sample exhausts its API retries on one of these HTTP statuses (or a
 * streamed `response.failed` with a rate-limit/quota code, treated as 429), every remaining sample of
 * the same route (model + account binding) is left unsent rather than repeating a rejection that the
 * route is almost certainly going to return again.
 */
export const FAST_FAIL_HTTP_STATUS_REASONS: Readonly<Record<number, string>> = {
    401: 'access_denied',
    402: 'payment_required',
    403: 'access_denied',
    404: 'model_not_found',
    429: 'rate_limited'
};
export const FAST_FAIL_STOP_REASONS: ReadonlySet<string> = new Set(Object.values(FAST_FAIL_HTTP_STATUS_REASONS));
const RETRYABLE_NOT_ADMITTED_STOP_REASONS = new Set(['transport_failure', 'missing_usage_cost', 'cancelled', ...FAST_FAIL_STOP_REASONS]);

/**
 * Classify one finished sample observation. Only an exhausted API failure (or an upstream abort after a
 * valid submission) whose last response is a route-level rejection triggers fast-fail; whole-sample
 * timeouts, 5xx and transport errors never do.
 */
export function fast_fail_stop_reason(observation: RecordValue): string | null {
    const status = observation.last_http_status,
        code = observation.last_error_code;
    const reason =
        typeof status === 'number' && Object.hasOwn(FAST_FAIL_HTTP_STATUS_REASONS, status)
            ? FAST_FAIL_HTTP_STATUS_REASONS[status]!
            : // Only a streamed HTTP 200 `response.failed` code counts; a 5xx carrying the same code stays transient.
              status === 200 && typeof code === 'string' && RATE_LIMIT_ERROR_CODES.has(code)
              ? 'rate_limited'
              : null;
    if (reason === null || observation.runner_error === 'SampleTimeout') return null;
    const submission = observation.answer_submission as RecordValue | null | undefined;
    const failedAfterSubmission =
        observation.status === 'completed' &&
        typeof submission === 'object' &&
        submission !== null &&
        submission.ended_after_submission === 'api_failure';
    if (observation.status !== 'api_failure' && !failedAfterSubmission) return null;
    return reason;
}

/** Ordinary manual retry covers API failures, timeouts, interruptions, cancellations and samples left unsent by a retryable stop. */
export function is_retryable_sample(sample: RecordValue, run_stop_reason: string | null | undefined): boolean {
    return (
        sample.status === 'api_failure' ||
        is_timeout_sample(sample) ||
        sample.status === 'interrupted' ||
        sample.status === 'cancelled' ||
        (sample.status === 'budget_not_admitted' && RETRYABLE_NOT_ADMITTED_STOP_REASONS.has(run_stop_reason ?? ''))
    );
}

/** Retry eligibility is a projection only; coordinator admission still rechecks every condition. */
export function execution_retryable_samples(run: ExecutionRun): number {
    // Imported calibration journals have no route identity and are never retried.
    if (run.execution_kind === 'calibration-import-v1') return 0;
    return run.samples.filter(sample => is_retryable_sample(sample, run.stop_reason)).length;
}

/** Result quality is a read-only projection, never a replacement for grading or cumulative usage. */
export function execution_result_quality(run: ExecutionRun) {
    const quality = {
        completed_samples: 0,
        unscored_samples: 0,
        unknown_usage_samples: 0,
        unknown_cost_samples: 0,
        prior_unknown_usage_samples: 0,
        prior_unknown_cost_samples: 0
    };
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
        // Attempts that sent no request consumed nothing and are never unknown (same rule as observation accounting).
        const attempts = ((Array.isArray(sample.attempts) ? sample.attempts : []) as RecordValue[]).filter(
            attempt => !sent_no_request_attempt(attempt)
        );
        if (
            attempts.some(
                attempt => !knownUsage(Object.hasOwn(attempt, 'latest_attempt_usage') ? attempt.latest_attempt_usage : attempt.usage)
            )
        )
            quality.prior_unknown_usage_samples++;
        if (
            attempts.some(
                attempt =>
                    !knownCost(
                        Object.hasOwn(attempt, 'latest_attempt_cost_usd')
                            ? attempt.latest_attempt_cost_usd
                            : attempt.estimated_uncached_cost_usd
                    )
            )
        )
            quality.prior_unknown_cost_samples++;
    }
    return quality;
}

/** Run summaries exclude raw evidence and use the caller's current budget snapshot. */
export function execution_run_summary(run: ExecutionRun, budget: RecordValue = run.budget, cloneOutput = true) {
    const counts: Record<string, number> = {};
    for (const sample of run.samples) {
        const status = is_timeout_sample(sample) ? 'timeout' : sample.status;
        counts[status] = (counts[status] ?? 0) + 1;
    }
    return {
        id: run.id,
        status: run.status,
        created_at: run.created_at,
        updated_at: run.updated_at,
        stop_reason: run.stop_reason,
        ...(run.task_id ? { task_id: run.task_id } : {}),
        ...(run.execution_kind ? { execution_kind: run.execution_kind } : {}),
        targets: cloneOutput ? clone(run.plan.targets) : run.plan.targets,
        bank_version: run.plan.bank_version,
        sample_count: run.samples.length,
        sample_status_counts: counts,
        retryable_samples: execution_retryable_samples(run),
        result_quality: execution_result_quality(run),
        budget: cloneOutput ? clone(budget) : budget
    };
}

/** Task summaries aggregate committed child membership without copying every raw sample. */
export function execution_task_summary(
    task: ExecutionTaskState,
    runs: readonly ReturnType<typeof execution_run_summary>[],
    cloneOutput = true
): RecordValue {
    const children = runs.map(run => ({
        run_id: run.id,
        target: cloneOutput ? clone(run.targets[0]!) : run.targets[0]!,
        status: run.status,
        created_at: run.created_at,
        updated_at: run.updated_at,
        sample_count: run.sample_count,
        sample_status_counts: run.sample_status_counts,
        result_quality: cloneOutput ? clone(run.result_quality) : run.result_quality,
        budget: run.budget,
        stop_reason: run.stop_reason,
        retryable_samples: run.retryable_samples
    }));
    const run_status_counts: Record<string, number> = {},
        sample_status_counts: Record<string, number> = {};
    for (const child of children) {
        run_status_counts[child.status] = (run_status_counts[child.status] ?? 0) + 1;
        for (const [status, count] of Object.entries(child.sample_status_counts))
            sample_status_counts[status] = (sample_status_counts[status] ?? 0) + count;
    }
    return {
        ...(cloneOutput ? clone(task) : task),
        bank_version: task.plan.bank_version,
        children,
        run_status_counts,
        sample_status_counts
    };
}
