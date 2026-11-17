/** Supplemental completion scoring never changes raw grades, bank hashes or production chart eligibility. */
export const ASSESSMENT_COMPLETION_POLICY = 'assessment-completion-v2-exception-aware';
/** Explicit whole-bank sample plan; missing, duplicate and unexpected observations are rejected. */
export interface AssessmentCompletionPlan {
    task_ids: readonly string[];
    targets: readonly { model: string; thinking: string }[];
    rounds: number;
    round_start?: number;
}
/** Observation evidence remains untouched; only terminal outcomes determine completion scoring. */
export interface AssessmentCompletionSample {
    sample_id: string; task: string; model: string; thinking: string; round: number;
    status: string; runner_error?: string | null; grade?: { content_score?: unknown; outcome?: unknown } | null;
    calls?: readonly string[];
}
/** Failed earlier attempts never override a later completed response. */
export interface AssessmentCompletionCall {
    call_id: string; sample_id: string; http_status: number; raw_response?: unknown;
}
/** Only separately verified executor evidence may attribute a deadline to computation; SSE activity is insufficient. */
export interface VerifiedAssessmentComputeDeadline {
    sample_id: string; kind: 'verified_compute_deadline'; evidence_reference: string;
}
/** Reviewed task-deadline evidence requires actual answer/reasoning output and local timeout, not heartbeat activity. */
export interface VerifiedAssessmentTaskDeadline {
    sample_id: string; kind: 'verified_task_deadline'; evidence_reference: string;
}
/** A score is either a finite grade, explicit task failure zero, or an excluded infrastructure exception. */
export type AssessmentCompletionOutcome = {
    sample_id: string; task: string; round: number; reason: string;
} & ({ kind: 'scored' | 'task_failure'; score: number } | { kind: 'exception'; score: null });
/** Score validity is checked across every planned sample for one model/Thinking target. */
export interface AssessmentCompletionTarget {
    model: string; thinking: string; planned_samples: number; completed_samples: number;
    scored_samples: number; task_failures: number; exceptions: number; included_samples: number;
    exception_fraction: number; assessment_valid: boolean; invalid_reason: string | null;
    score_percent: number | null; reasons: Record<string, number>; samples: AssessmentCompletionOutcome[];
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const key = (value: { model: string; thinking: string; task: string; round: number }) => JSON.stringify([value.model, value.thinking, value.task, value.round]);
const finiteScore = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
function requireEvidence(condition: unknown, reason: string): asserts condition {
    if (!condition) throw new TypeError('Assessment completion evidence: ' + reason);
}
function classify(sample: AssessmentCompletionSample, call: AssessmentCompletionCall | undefined, deadline: VerifiedAssessmentComputeDeadline | VerifiedAssessmentTaskDeadline | undefined): AssessmentCompletionOutcome {
    const base = { sample_id: sample.sample_id, task: sample.task, round: sample.round };
    const exception = (reason: string): AssessmentCompletionOutcome => ({ ...base, kind: 'exception', score: null, reason });
    const failure = (reason: string): AssessmentCompletionOutcome => ({ ...base, kind: 'task_failure', score: 0, reason });
    if (sample.status === 'completed') {
        requireEvidence(!deadline, 'completed sample has contradictory compute-deadline evidence');
        if (finiteScore(sample.grade?.content_score)) return { ...base, kind: 'scored', score: sample.grade.content_score, reason: 'completed_grade' };
        if (sample.grade?.content_score === null && ['ambiguous', 'ungradable'].includes(String(sample.grade.outcome))) return failure('invalid_final_answer');
        return exception('invalid_or_missing_grade');
    }
    if (deadline) {
        if (deadline.kind === 'verified_task_deadline') requireEvidence(sample.runner_error === 'SampleTimeout', 'verified task deadline requires a recorded local sample timeout');
        return failure(deadline.kind);
    }
    if (['empty_final_answer', 'tool_call_limit', 'turn_limit', 'unsupported_tool_sequence', 'invalid_tool_call_id'].includes(sample.status)) return failure(sample.status);
    const raw = object(call?.raw_response) ? call.raw_response : {};
    if (sample.runner_error === 'SampleTimeout' || raw.exception === 'TimeoutError') return exception('unattributed_timeout');
    if (['grading_error', 'simulator_error', 'cancelled', 'budget_not_admitted', 'invalid_response_output', 'usage_or_cap_failure'].includes(sample.status)) return exception(sample.status);
    if (call && call.http_status !== 200) return exception(call.http_status === -1 ? 'transport_exception' : 'http_error');
    if (sample.status === 'api_failure' || sample.status === 'response_incomplete_or_error') return exception('api_or_protocol_exception');
    return exception('unattributed_incomplete');
}

/** Exclude exceptions up to exactly 30%; above 30% return no valid score, never impute missing samples. */
export function summarize_assessment_completion(plan: AssessmentCompletionPlan, observations: readonly AssessmentCompletionSample[], calls: readonly AssessmentCompletionCall[] = [], verifiedDeadlines: readonly (VerifiedAssessmentComputeDeadline | VerifiedAssessmentTaskDeadline)[] = []): AssessmentCompletionTarget[] {
    const start = plan.round_start ?? 1;
    requireEvidence(Number.isInteger(plan.rounds) && plan.rounds >= 1 && plan.rounds <= 3 && Number.isInteger(start) && start >= 1 && start + plan.rounds - 1 <= 3, 'invalid round plan');
    requireEvidence(Array.isArray(plan.task_ids) && plan.task_ids.length > 0 && plan.task_ids.every(id => typeof id === 'string' && id.length > 0) && new Set(plan.task_ids).size === plan.task_ids.length, 'task IDs must be nonempty and unique');
    requireEvidence(Array.isArray(plan.targets) && plan.targets.length > 0, 'targets are missing');
    const targetKeys = new Set<string>(), planned = new Set<string>();
    for (const target of plan.targets) {
        requireEvidence(typeof target.model === 'string' && target.model.length > 0 && typeof target.thinking === 'string' && target.thinking.length > 0, 'invalid target');
        const targetKey = JSON.stringify([target.model, target.thinking]);
        requireEvidence(!targetKeys.has(targetKey), 'duplicate target'); targetKeys.add(targetKey);
        for (const task of plan.task_ids) for (let round = start; round < start + plan.rounds; round++) planned.add(key({ ...target, task, round }));
    }
    const seen = new Set<string>(), sampleIds = new Set<string>();
    for (const sample of observations) {
        const sampleKey = key(sample);
        requireEvidence(planned.has(sampleKey) && !seen.has(sampleKey), 'unexpected or duplicate task round'); seen.add(sampleKey);
        requireEvidence(typeof sample.sample_id === 'string' && sample.sample_id.length > 0 && !sampleIds.has(sample.sample_id), 'missing or duplicate sample ID'); sampleIds.add(sample.sample_id);
    }
    requireEvidence(seen.size === planned.size, 'missing planned observations');
    const callMap = new Map<string, AssessmentCompletionCall>();
    for (const call of calls) {
        requireEvidence(typeof call.call_id === 'string' && call.call_id.length > 0 && !callMap.has(call.call_id) && sampleIds.has(call.sample_id), 'duplicate or unowned call');
        callMap.set(call.call_id, call);
    }
    const deadlines = new Map<string, VerifiedAssessmentComputeDeadline | VerifiedAssessmentTaskDeadline>();
    for (const deadline of verifiedDeadlines) {
        requireEvidence((deadline.kind === 'verified_compute_deadline' || deadline.kind === 'verified_task_deadline') && typeof deadline.evidence_reference === 'string' && deadline.evidence_reference.trim().length > 0 && sampleIds.has(deadline.sample_id) && !deadlines.has(deadline.sample_id), 'invalid verified compute-deadline evidence');
        deadlines.set(deadline.sample_id, deadline);
    }
    return plan.targets.map(target => {
        const selected = observations.filter(sample => sample.model === target.model && sample.thinking === target.thinking);
        const samples = selected.map(sample => {
            for (const id of sample.calls ?? []) requireEvidence(callMap.get(id)?.sample_id === sample.sample_id, 'missing or mismatched call evidence');
            return classify(sample, callMap.get(sample.calls?.at(-1) ?? ''), deadlines.get(sample.sample_id));
        });
        const exceptions = samples.filter(sample => sample.kind === 'exception').length;
        const included = samples.length - exceptions;
        const valid = included > 0 && exceptions * 10 <= samples.length * 3;
        const reasons: Record<string, number> = {};
        for (const sample of samples) reasons[sample.reason] = (reasons[sample.reason] ?? 0) + 1;
        return { ...target, planned_samples: samples.length, completed_samples: selected.filter(sample => sample.status === 'completed').length,
            scored_samples: samples.filter(sample => sample.kind === 'scored').length, task_failures: samples.filter(sample => sample.kind === 'task_failure').length,
            exceptions, included_samples: included, exception_fraction: exceptions / samples.length,
            assessment_valid: valid, invalid_reason: valid ? null : 'excessive_exceptions',
            score_percent: valid ? samples.reduce((sum, sample) => sum + (sample.score ?? 0), 0) / included * 100 : null, reasons, samples };
    });
}
