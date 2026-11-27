import type { AssessmentBaseline, BaselineRun, BaselineTarget, BaselineGrade } from './assessment_baselines.ts';
type Evidence = Record<string, unknown>;
const object = (value: unknown): value is Evidence => value !== null && typeof value === 'object' && !Array.isArray(value);
const finiteScore = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** Observation rows keep task-level outcomes and explicit historical/current implementation labels. */
export interface AssessmentObservation extends Evidence {
    id: string;
    source: string;
    source_sha256: Record<string, string>;
    tasks: {
        task_id: string;
        title: string;
        domain: string | null;
        samples: {
            round: number | null;
            status: string | null;
            content_score: number | null;
            instruction_checks: Record<string, boolean>;
            outcome: string | null;
            elapsed_seconds: number | null;
            ended_after_submission: string | null;
        }[];
    }[];
}

type UsageValue = { input_tokens: number; output_tokens: number };
const knownNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const knownUsage = (value: unknown): value is UsageValue =>
    object(value) &&
    Number.isInteger(value.input_tokens) &&
    Number.isInteger(value.output_tokens) &&
    (value.input_tokens as number) >= 0 &&
    (value.output_tokens as number) >= 0;
/** An attempt that never sent a request (empty `calls`, or never started and left unsent) is a known zero. */
export const sent_no_request_attempt = (attempt: Evidence) =>
    (Array.isArray(attempt.calls) && attempt.calls.length === 0) ||
    (!Array.isArray(attempt.calls) &&
        !attempt.started_at &&
        ['interrupted', 'cancelled', 'budget_not_admitted', 'pending'].includes(String(attempt.status)));
const isTimeoutSample = (sample: Evidence) =>
    sample.status === 'timeout' ||
    (object(sample.grade) && sample.grade.outcome === 'timeout') ||
    (sample.status === 'api_failure' && sample.runner_error === 'SampleTimeout');
const endedAfterSubmissionReason = (sample: Evidence): string | null => {
    if (sample.status !== 'completed') return null;
    const submission = object(sample.answer_submission) ? sample.answer_submission : null;
    return typeof submission?.ended_after_submission === 'string' && submission.ended_after_submission.trim()
        ? submission.ended_after_submission.trim()
        : null;
};

/**
 * Cumulative accounting over every sample. When a sample has known effective usage and cost,
 * use them directly. An attempt that sent no request (empty `calls`, e.g. budget_not_admitted)
 * consumed nothing, so it is a known zero rather than unknown. Samples whose effective usage
 * remains unknown stay counted for lower-bound presentation.
 */
export function observation_usage_accounting(samples: readonly Evidence[]) {
    const usage_known = { input_tokens: 0, output_tokens: 0 };
    let cost_known = 0,
        unknown_usage_attempts = 0,
        unknown_cost_attempts = 0,
        attempts = 0;
    const add = (attempt: Evidence, usage: unknown, cost: unknown) => {
        attempts++;
        if (sent_no_request_attempt(attempt)) return;
        if (knownUsage(usage)) {
            usage_known.input_tokens += usage.input_tokens;
            usage_known.output_tokens += usage.output_tokens;
        } else unknown_usage_attempts++;
        if (knownNumber(cost)) cost_known += cost;
        else unknown_cost_attempts++;
        // Known usage retained after a timeout/abort is a lower bound, never a complete total.
        if (attempt.usage_incomplete === true) {
            if (knownUsage(usage)) unknown_usage_attempts++;
            if (knownNumber(cost)) unknown_cost_attempts++;
        }
    };
    for (const sample of samples) {
        const prior = Array.isArray(sample.attempts) ? (sample.attempts as unknown[]).filter(object) : [];
        const incomplete = sample.usage_incomplete === true || prior.some(attempt => attempt.usage_incomplete === true);
        if (!incomplete && knownUsage(sample.usage) && knownNumber(sample.estimated_uncached_cost_usd)) {
            attempts += prior.length + 1;
            usage_known.input_tokens += sample.usage.input_tokens;
            usage_known.output_tokens += sample.usage.output_tokens;
            cost_known += sample.estimated_uncached_cost_usd;
            continue;
        }
        const latest = (attempt: Evidence, key: 'usage' | 'cost') =>
            key === 'usage'
                ? Object.hasOwn(attempt, 'latest_attempt_usage')
                    ? attempt.latest_attempt_usage
                    : attempt.usage
                : Object.hasOwn(attempt, 'latest_attempt_cost_usd')
                  ? attempt.latest_attempt_cost_usd
                  : attempt.estimated_uncached_cost_usd;
        for (const attempt of prior) add(attempt, latest(attempt, 'usage'), latest(attempt, 'cost'));
        if (prior.length) add(sample, latest(sample, 'usage'), latest(sample, 'cost'));
        else add(sample, sample.usage, sample.estimated_uncached_cost_usd);
    }
    return { usage_known, cost_known, unknown_usage_attempts, unknown_cost_attempts, attempts };
}

/** Project observations without loading banks, reading files or validating baseline evidence. */
export function project_assessment_observation(
    run: BaselineRun,
    target: BaselineTarget,
    source: string,
    candidate: Pick<AssessmentBaseline, 'assessment_protocol_sha256'> | null,
    reason: string | null,
    baseline?: AssessmentBaseline
): AssessmentObservation {
    const plan = run.plan;
    const bank = plan.bank_snapshot ?? {};
    const samples = (run.samples ?? []).filter(sample => sample.target_id === target.id);
    const tasks = (plan.task_snapshots ?? []).map(card => ({
        task_id: card.id,
        title: card.title ?? card.id,
        domain: card.domain ?? null,
        samples: samples
            .filter(sample => sample.task === card.id)
            .map(sample => {
                const grade: Partial<BaselineGrade> = sample.grade ?? {};
                const timeout = isTimeoutSample(sample);
                const submission = object(sample.answer_submission) ? sample.answer_submission : null;
                const ended_after_submission =
                    typeof submission?.ended_after_submission === 'string' && submission.ended_after_submission.trim()
                        ? submission.ended_after_submission
                        : null;
                return {
                    round: sample.round ?? null,
                    status: timeout ? 'timeout' : (sample.status ?? null),
                    content_score:
                        sample.status === 'completed' && finiteScore(grade.content_score) ? grade.content_score : timeout ? 0 : null,
                    instruction_checks: structuredClone(grade.instruction_checks ?? {}),
                    outcome: grade.outcome ?? (timeout ? 'timeout' : null),
                    elapsed_seconds: knownNumber(sample.elapsed_seconds) ? sample.elapsed_seconds : null,
                    ended_after_submission
                };
            })
    }));
    const accounting = observation_usage_accounting(samples);
    const usage = accounting.unknown_usage_attempts === 0 && samples.length ? accounting.usage_known : null;
    const cost = accounting.unknown_cost_attempts === 0 && samples.length ? accounting.cost_known : null;
    const elapsed_seconds =
        samples.length && samples.every(sample => knownNumber(sample.elapsed_seconds))
            ? samples.reduce((sum, sample) => sum + Number(sample.elapsed_seconds), 0)
            : null;
    const hasPostSubmissionNonModel = samples.some(sample => {
        const ended = endedAfterSubmissionReason(sample);
        return ended !== null && ended !== 'SampleTimeout';
    });
    const projectedStatus =
        run.status === 'completed' && hasPostSubmissionNonModel
            ? samples.some(sample => endedAfterSubmissionReason(sample) === 'api_failure')
                ? 'failed'
                : 'incomplete'
            : run.status === 'failed' &&
                samples.length > 0 &&
                !hasPostSubmissionNonModel &&
                samples.every(sample => sample.status === 'completed' || isTimeoutSample(sample))
              ? 'completed'
              : (run.status ?? null);
    return {
        id: baseline?.id ?? run.id + ':' + target.id,
        source,
        run_id: run.id,
        task_id: typeof run.task_id === 'string' ? run.task_id : null,
        target_id: target.id,
        label: target.label ?? target.model,
        model: target.model,
        thinking: target.thinking ?? 'unknown',
        route_id: target.route_id ?? null,
        account_ref: target.account_ref ?? null,
        account_evidence: target.account_evidence ?? null,
        provider_id: target.provider_id ?? null,
        provider_evidence: target.provider_evidence ?? null,
        model_display_name: target.model_display_name ?? null,
        remote_route: target.remote_route === undefined ? null : structuredClone(target.remote_route),
        created_at: run.created_at ?? null,
        elapsed_seconds,
        usage,
        estimated_cost_usd: cost,
        usage_accounting: {
            usage_lower_bound: accounting.usage_known,
            estimated_cost_usd_lower_bound: accounting.cost_known,
            unknown_usage_attempts: accounting.unknown_usage_attempts,
            unknown_cost_attempts: accounting.unknown_cost_attempts,
            attempts: accounting.attempts
        },
        bank_version: plan.bank_version ?? null,
        bank_scope: plan.bank_scope ?? null,
        sample_count: samples.length,
        task_sha256: bank.task_sha256 ?? null,
        source_sha256: structuredClone(bank.source_sha256 ?? {}),
        implementation: Object.keys(bank.source_sha256 ?? {}).some(key => key.endsWith('.py')) ? 'python-historical' : 'typescript-bun',
        assessment_protocol_sha256: candidate?.assessment_protocol_sha256 ?? null,
        rounds: plan.rounds ?? null,
        status: projectedStatus,
        baseline_eligible: candidate !== null,
        ineligibility_reason: reason,
        tasks
    };
}
