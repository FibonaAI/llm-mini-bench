import type { ExecutionRun, ExecutionTaskState } from './bench_execution.ts';
import { RATE_LIMIT_ERROR_CODES } from './assessment_runner.ts';
import { observation_usage_accounting, sent_no_request_attempt } from './assessment_observations.ts';

type RecordValue = Record<string, unknown>;
const clone = <T>(value: T): T => structuredClone(value);

/** Return the non-empty post-submission abort reason when a sample submitted a valid answer then aborted. */
export function ended_after_submission_reason(sample: RecordValue): string | null {
    if (sample.status !== 'completed') return null;
    const submission = sample.answer_submission as RecordValue | null | undefined;
    if (!submission || typeof submission !== 'object') return null;
    return typeof submission.ended_after_submission === 'string' && submission.ended_after_submission.trim()
        ? submission.ended_after_submission.trim()
        : null;
}

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

/** Post-submission timeout: valid answer was graded, but the closing turn hit SampleTimeout. */
export function is_post_submission_timeout_sample(sample: RecordValue): boolean {
    return ended_after_submission_reason(sample) === 'SampleTimeout';
}

/** Any timeout anomaly (whole-sample timeout or post-submission SampleTimeout). */
export function is_timeout_anomaly_sample(sample: RecordValue): boolean {
    return is_timeout_sample(sample) || is_post_submission_timeout_sample(sample);
}

/** Model anomaly: model ended its turn naturally without calling submit_answer (scored 0). */
export function is_model_anomaly_sample(sample: RecordValue): boolean {
    if (sample.status !== 'completed') return false;
    const grade = sample.grade as RecordValue | null | undefined;
    return Boolean(grade && typeof grade === 'object' && grade.outcome === 'no_submission');
}

/** Post-submission non-model anomaly: valid answer recorded, then network/rate-limit/API error aborted the closing turn. */
export function is_post_submission_non_model_anomaly(sample: RecordValue): boolean {
    const reason = ended_after_submission_reason(sample);
    return reason !== null && reason !== 'SampleTimeout';
}

/** Pre-submission non-model failure (API error, rate limit, interruption, cancellation, truncation, worker/storage error). */
export function is_pre_submission_non_model_failure(sample: RecordValue): boolean {
    const status = String(sample.status ?? '');
    if (status === 'completed' || status === 'pending' || status === 'queued' || status === 'running') return false;
    return !is_timeout_sample(sample);
}

/** Any non-model anomaly (pre-submission failure or post-submission non-timeout abort). */
export function is_non_model_anomaly_sample(sample: RecordValue): boolean {
    return is_pre_submission_non_model_failure(sample) || is_post_submission_non_model_anomaly(sample);
}

/** Single-sample manual retry eligibility: every anomalous sample (timeout, model, or non-model) is retryable. */
export function is_retryable_sample(sample: RecordValue, stopReason: string | null | undefined): boolean {
    if (is_timeout_anomaly_sample(sample)) return true;
    if (is_model_anomaly_sample(sample)) return true;
    if (is_post_submission_non_model_anomaly(sample)) return true;
    if (sample.status === 'budget_not_admitted') {
        return RETRYABLE_NOT_ADMITTED_STOP_REASONS.has(stopReason ?? '');
    }
    if (['pending', 'queued', 'running', 'completed'].includes(String(sample.status ?? ''))) return false;
    return true;
}

/** Terminal run status: runs without non-model anomalies complete (including model-anomaly and timeout runs). */
export function terminal_run_status(samples: readonly RecordValue[], stopReason: string | null | undefined, cancelled = false): string {
    if (stopReason === 'storage_error') return 'failed';
    if (cancelled) return 'cancelled';
    if (samples.some(is_non_model_anomaly_sample)) {
        if (
            samples.some(
                sample =>
                    (['api_failure', 'worker_error', 'storage_error'].includes(String(sample.status ?? '')) &&
                        !is_timeout_sample(sample)) ||
                    ended_after_submission_reason(sample) === 'api_failure'
            )
        )
            return 'failed';
        if (samples.some(sample => sample.status === 'interrupted')) return 'interrupted';
        if (samples.some(sample => sample.status === 'cancelled')) return 'cancelled';
        return 'incomplete';
    }
    if (samples.length > 0 && samples.every(sample => sample.status === 'completed' || is_timeout_sample(sample))) return 'completed';
    return 'incomplete';
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
        timeout_samples: 0,
        model_anomaly_samples: 0,
        non_model_anomaly_samples: 0,
        ended_after_submission_samples: 0,
        ended_after_timeout_samples: 0,
        ended_after_non_model_samples: 0,
        no_submission_samples: 0,
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
        if (is_timeout_sample(sample)) {
            quality.timeout_samples++;
            continue;
        }
        if (is_pre_submission_non_model_failure(sample)) {
            quality.non_model_anomaly_samples++;
            continue;
        }
        if (sample.status !== 'completed') continue;
        quality.completed_samples++;
        const grade = sample.grade as RecordValue | null | undefined;
        const score = grade?.content_score;
        if (!knownCost(score) || score > 1) quality.unscored_samples++;
        if (grade?.outcome === 'no_submission') {
            quality.no_submission_samples++;
            quality.model_anomaly_samples++;
        }
        const endedAfter = ended_after_submission_reason(sample);
        if (endedAfter) {
            quality.ended_after_submission_samples++;
            if (endedAfter === 'SampleTimeout') {
                quality.ended_after_timeout_samples++;
                quality.timeout_samples++;
            } else {
                quality.ended_after_non_model_samples++;
                quality.non_model_anomaly_samples++;
            }
        }
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

export interface ExecutionRunMetrics {
    rounds: number | null;
    scored_samples: number;
    full_score_samples: number;
    partial_score_samples: number;
    zero_score_samples: number;
    mean_score: number | null;
    score_complete: boolean;
    elapsed_sample_count: number;
    elapsed_seconds_known: number;
    elapsed_seconds_total: number | null;
    avg_sample_elapsed_seconds: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    total_tokens: number | null;
    known_input_tokens_lower_bound: number | null;
    known_output_tokens_lower_bound: number | null;
    known_total_tokens_lower_bound: number | null;
    estimated_cost_usd: number | null;
    known_cost_lower_bound_usd: number | null;
    unknown_usage_attempts: number;
    unknown_cost_attempts: number;
}

/** Lightweight read-only run metrics for task/run comparison tables; preserves missingness without imputing failures. */
export function execution_run_metrics(run: ExecutionRun): ExecutionRunMetrics {
    const validNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const validScoreValue = (value: unknown): value is number => validNonnegative(value) && value <= 1;
    let scored_samples = 0,
        full_score_samples = 0,
        partial_score_samples = 0,
        zero_score_samples = 0,
        scoreSum = 0,
        elapsed_sample_count = 0,
        elapsed_seconds_known = 0,
        hasActiveSamples = false;
    const roundSet = new Set<number>();
    for (const sample of run.samples) {
        if (Number.isInteger(sample.round) && (sample.round as number) > 0) roundSet.add(sample.round as number);
        if (['pending', 'queued', 'running'].includes(String(sample.status ?? ''))) hasActiveSamples = true;
        if (is_timeout_sample(sample)) {
            scored_samples++;
            zero_score_samples++;
        } else if (sample.status === 'completed') {
            const grade = sample.grade as RecordValue | null | undefined;
            const score = grade?.content_score;
            if (validScoreValue(score)) {
                scored_samples++;
                scoreSum += score;
                if (score >= 1) full_score_samples++;
                else if (score > 0) partial_score_samples++;
                else zero_score_samples++;
            }
        }
        if (validNonnegative(sample.elapsed_seconds)) {
            elapsed_sample_count++;
            elapsed_seconds_known += sample.elapsed_seconds;
        }
    }
    const planRounds = Number.isInteger(run.plan?.rounds) && (run.plan.rounds as number) > 0 ? (run.plan.rounds as number) : null;
    const rounds = planRounds ?? (roundSet.size > 0 ? roundSet.size : null);
    const totalSamples = run.samples.length;
    const accounting = observation_usage_accounting(run.samples as RecordValue[]);
    const usageComplete = totalSamples > 0 && !hasActiveSamples && accounting.unknown_usage_attempts === 0;
    const costComplete = totalSamples > 0 && !hasActiveSamples && accounting.unknown_cost_attempts === 0;
    const knownTokensSum = accounting.usage_known.input_tokens + accounting.usage_known.output_tokens;
    return {
        rounds,
        scored_samples,
        full_score_samples,
        partial_score_samples,
        zero_score_samples,
        mean_score: scored_samples > 0 ? (scoreSum / scored_samples) * 100 : null,
        score_complete: totalSamples > 0 && scored_samples === totalSamples,
        elapsed_sample_count,
        elapsed_seconds_known,
        elapsed_seconds_total: totalSamples > 0 && elapsed_sample_count === totalSamples ? elapsed_seconds_known : null,
        avg_sample_elapsed_seconds: elapsed_sample_count > 0 ? elapsed_seconds_known / elapsed_sample_count : null,
        input_tokens: usageComplete ? accounting.usage_known.input_tokens : null,
        output_tokens: usageComplete ? accounting.usage_known.output_tokens : null,
        total_tokens: usageComplete ? knownTokensSum : null,
        known_input_tokens_lower_bound: !usageComplete && knownTokensSum > 0 ? accounting.usage_known.input_tokens : null,
        known_output_tokens_lower_bound: !usageComplete && knownTokensSum > 0 ? accounting.usage_known.output_tokens : null,
        known_total_tokens_lower_bound: !usageComplete && knownTokensSum > 0 ? knownTokensSum : null,
        estimated_cost_usd: costComplete ? accounting.cost_known : null,
        known_cost_lower_bound_usd: !costComplete && accounting.cost_known > 0 ? accounting.cost_known : null,
        unknown_usage_attempts: accounting.unknown_usage_attempts,
        unknown_cost_attempts: accounting.unknown_cost_attempts
    };
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
        metrics: execution_run_metrics(run),
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
        metrics: cloneOutput ? clone(run.metrics) : run.metrics,
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
