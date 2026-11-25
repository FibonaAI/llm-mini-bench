import { readFileSync } from 'node:fs';
import { assessment_task_snapshot, type AssessmentBank, type AssessmentTaskSnapshot } from './assessment_bank.ts';
import { assessment_hash, canonicalAssessmentJson, parseAssessmentJson } from './assessment_json.ts';
import { assessment_sample_protocol, execution_protocol_hash, type ExecutionProtocol } from './run_protocol.ts';
import { create_assessment_source_context, type AssessmentSourceContext } from './assessment_provenance.ts';
import { project_assessment_observation, type AssessmentObservation } from './assessment_observations.ts';
import type { BenchRouteMetadata } from './bench_routes.ts';

/** Only complete, per-question baseline snapshots use this schema. */
export const ASSESSMENT_BASELINE_SCHEMA = 'assessment-baseline-v1';
type Evidence = Record<string, unknown>;
/** Frozen target identity is recorded evidence, never reconstructed from the current catalog. */
export interface BaselineTarget extends Evidence, BenchRouteMetadata {
    id: string;
    model: string;
    thinking: string;
    route_id: string;
    account_ref?: string | null;
    account_evidence?: string;
    label?: string;
}
/** A baseline grade must retain content, instruction checks and outcome separately. */
export interface BaselineGrade extends Evidence {
    content_score: number;
    instruction_checks: Record<string, boolean>;
    outcome: string;
}
interface BaselineSample extends Evidence {
    sample_id: string;
    target_id: string;
    run_id: string;
    task: string;
    round: number;
    model: string;
    thinking: string;
    status: string;
    ok: boolean;
    route_id: string;
    account_ref?: string | null;
    execution_protocol: ExecutionProtocol;
    execution_protocol_sha256: string;
    assessment_protocol_sha256: string;
    grade: BaselineGrade;
    usage?: { input_tokens: number; output_tokens: number };
    estimated_uncached_cost_usd?: number;
}
type BankSnapshot = Pick<AssessmentBank, 'version' | 'task_ids' | 'task_sha256' | 'source_sha256'>;
type ProtocolLimits = Record<'max_output_tokens' | 'max_turns' | 'max_tool_calls', number | null> & {
    timeout: number;
    max_api_retries?: number;
    timeout_scope?: 'sample';
};
interface BaselinePlan extends Evidence {
    bank_version: string;
    bank_scope: string;
    bank_snapshot: BankSnapshot;
    task_ids: string[];
    task_snapshots: AssessmentTaskSnapshot[];
    source_sha256: Record<string, string>;
    targets: BaselineTarget[];
    rounds: number;
    limits: ProtocolLimits;
}
/** Minimal recorded run envelope shared by validation and pure observation projection. */
export interface BaselineRun extends Evidence {
    id: string;
    status: string;
    created_at: string;
    evidence?: unknown;
    plan: BaselinePlan;
    samples: BaselineSample[];
}
/** A validated frozen target retains the original source map and every planned sample. */
export interface AssessmentBaseline extends Evidence {
    schema: string;
    id: string;
    bank_version: string;
    run_id: string;
    created_at: string;
    target_id: string;
    evidence: unknown;
    target: BaselineTarget;
    rounds: number;
    bank_snapshot: BankSnapshot;
    task_snapshots: AssessmentTaskSnapshot[];
    source_sha256: Record<string, string>;
    limits: ProtocolLimits;
    samples: BaselineSample[];
    assessment_protocol_sha256: string;
}
export type { AssessmentObservation } from './assessment_observations.ts';
const protocolLimits = ['max_output_tokens', 'max_turns', 'max_tool_calls', 'timeout'] as const;
const object = (value: unknown): value is Evidence => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left: unknown, right: unknown) => canonicalAssessmentJson(left) === canonicalAssessmentJson(right);
const finiteScore = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const requireBaseline = (condition: unknown, reason: string) => {
    if (!condition) throw new TypeError('Assessment baseline: ' + reason);
};

/** Freeze a complete current-runtime target; historical sources cannot be promoted. */
export function build_assessment_baseline(
    run: unknown,
    target_id: string,
    context: AssessmentSourceContext = create_assessment_source_context()
): AssessmentBaseline {
    return buildBaselineWithContext(run, target_id, context);
}

function buildBaselineWithContext(run: unknown, target_id: string, context: AssessmentSourceContext): AssessmentBaseline {
    const bank = context.production_bank();
    try {
        return buildBaseline(run as BaselineRun, target_id, bank, context.production_cards);
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('Assessment baseline:')) throw error;
        throw new TypeError('Assessment baseline: malformed run evidence', { cause: error });
    }
}

function buildBaseline(
    run: BaselineRun,
    target_id: string,
    bank: AssessmentBank,
    getCards = () => bank.tasks.map(assessment_task_snapshot)
): AssessmentBaseline {
    const plan = run.plan;
    if (Array.isArray(run.retry_batches))
        for (const batch of run.retry_batches)
            requireBaseline(
                object(batch) && same(batch.source_sha256, plan.source_sha256),
                'retry execution sources differ; retained for analysis, not baseline promotion'
            );
    requireBaseline(run.status === 'completed', 'run must be completed');
    requireBaseline(typeof run.id === 'string' && run.id, 'run identity is missing');
    requireBaseline(plan.bank_version === '1.0' && plan.bank_scope === 'whole', 'only the whole Assessment 1.0 bank is eligible');
    const ids = bank.task_ids;
    requireBaseline(ids.length === 12 && same(plan.task_ids, ids), 'all 12 tasks are required in bank order');
    for (const key of ['version', 'task_ids', 'task_sha256', 'source_sha256'] as const)
        requireBaseline(same(plan.bank_snapshot[key], bank[key]), 'current bank provenance mismatch: ' + key);
    const cards = getCards();
    requireBaseline(same(plan.task_snapshots, cards), 'task snapshots differ from current bank');
    const sources = plan.source_sha256;
    requireBaseline(
        object(sources) && Object.entries(bank.source_sha256).every(([key, value]) => sources[key] === value),
        'task source hashes are missing or stale'
    );
    requireBaseline(
        ['calibrate_assessment.ts', 'src/run_protocol.ts', 'src/client.ts'].every(key => Object.hasOwn(sources, key)),
        'execution source provenance is missing'
    );
    requireBaseline(
        Object.values(sources).every(value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)),
        'invalid source digest'
    );
    const rounds = plan.rounds;
    requireBaseline(Number.isInteger(rounds) && rounds >= 1 && rounds <= 3, 'invalid round count');
    const targets = plan.targets.filter(target => target.id === target_id);
    requireBaseline(targets.length === 1, 'target must exist exactly once');
    const target = targets[0]!;
    requireBaseline(
        (['id', 'model', 'thinking', 'route_id'] as const).every(key => typeof target[key] === 'string' && target[key].trim()),
        'target identity is incomplete'
    );
    const config: ProtocolLimits = {
        max_output_tokens: plan.limits.max_output_tokens,
        max_turns: plan.limits.max_turns,
        max_tool_calls: plan.limits.max_tool_calls,
        timeout: plan.limits.timeout
    };
    requireBaseline(
        protocolLimits.every(
            key => (key !== 'timeout' && config[key] === null) || (Number.isInteger(config[key]) && Number(config[key]) > 0)
        ),
        'invalid protocol limits'
    );
    if (plan.limits.timeout_scope !== undefined) {
        requireBaseline(plan.limits.timeout_scope === 'sample', 'invalid timeout scope');
        config.timeout_scope = 'sample';
    }
    if (plan.limits.max_api_retries !== undefined) {
        requireBaseline(
            Number.isInteger(plan.limits.max_api_retries) && plan.limits.max_api_retries >= 0 && plan.limits.max_api_retries <= 5,
            'invalid API retry policy'
        );
        config.max_api_retries = plan.limits.max_api_retries;
    }
    const firstSample = run.samples.find(sample => sample.target_id === target_id);
    const streaming = firstSample?.execution_protocol?.requests?.[firstSample.task]?.stream === true;
    const protocols: Record<string, ExecutionProtocol> = {},
        protocolHashes: Record<string, string> = {};
    for (const card of cards) {
        const identity = assessment_sample_protocol(card, target.thinking, config, streaming);
        protocols[card.id] = identity.execution_protocol;
        protocolHashes[card.id] = identity.assessment_protocol_sha256;
    }
    const samples = run.samples.filter(sample => sample.target_id === target_id);
    requireBaseline(samples.length === 12 * rounds, 'every planned round must contain exactly 12 samples');
    const seen = new Set(),
        sampleIds = new Set();
    for (const sample of samples) {
        const taskId = sample.task,
            round = sample.round;
        requireBaseline(ids.includes(taskId) && Number.isInteger(round) && round >= 1 && round <= rounds, 'unexpected task or round');
        const pair = JSON.stringify([taskId, round]);
        requireBaseline(!seen.has(pair), 'duplicate task round');
        seen.add(pair);
        requireBaseline(
            typeof sample.sample_id === 'string' && sample.sample_id && !sampleIds.has(sample.sample_id),
            'missing or duplicate sample identity'
        );
        sampleIds.add(sample.sample_id);
        requireBaseline(sample.status === 'completed' && sample.ok === true, 'failed or incomplete samples are not scores');
        requireBaseline(sample.model === target.model && sample.thinking === target.thinking, 'sample target identity differs');
        for (const key of ['run_id', 'route_id', 'account_ref'])
            requireBaseline(
                (sample[key] ?? null) === (key === 'run_id' ? run.id : (target[key] ?? null)),
                'sample identity differs: ' + key
            );
        requireBaseline(
            same(sample.execution_protocol, protocols[taskId]) &&
                sample.execution_protocol_sha256 === execution_protocol_hash(sample.execution_protocol) &&
                sample.assessment_protocol_sha256 === protocolHashes[taskId],
            'sample execution protocol is unknown or contradictory'
        );
        const grade = sample.grade;
        requireBaseline(object(grade) && finiteScore(grade.content_score), 'ungradable content must not become zero');
        requireBaseline(
            object(grade.instruction_checks) &&
                Object.keys(grade.instruction_checks).length &&
                Object.values(grade.instruction_checks).every(value => typeof value === 'boolean'),
            'instruction checks are missing or invalid'
        );
        requireBaseline(typeof grade.outcome === 'string' && grade.outcome, 'grade outcome is missing');
    }
    const snapshot: AssessmentBaseline = {
        id: '',
        schema: ASSESSMENT_BASELINE_SCHEMA,
        bank_version: '1.0',
        run_id: run.id,
        created_at: run.created_at,
        target_id,
        evidence: structuredClone(run.evidence ?? null),
        target: structuredClone(target),
        rounds,
        bank_snapshot: {
            version: bank.version,
            task_ids: structuredClone(bank.task_ids),
            task_sha256: bank.task_sha256,
            source_sha256: structuredClone(bank.source_sha256)
        },
        task_snapshots: structuredClone(cards),
        source_sha256: structuredClone(sources),
        limits: config,
        samples: structuredClone(samples),
        assessment_protocol_sha256: assessment_hash(protocolHashes)
    };
    const { id: _emptyId, ...identity } = snapshot;
    snapshot.id = assessment_hash(identity);
    return snapshot;
}

function baselineRun(baseline: AssessmentBaseline): BaselineRun {
    return {
        id: baseline.run_id,
        status: 'completed',
        created_at: baseline.created_at,
        evidence: baseline.evidence ?? null,
        plan: {
            bank_version: baseline.bank_version,
            bank_scope: 'whole',
            bank_snapshot: baseline.bank_snapshot,
            task_ids: baseline.bank_snapshot.task_ids,
            task_snapshots: baseline.task_snapshots,
            source_sha256: baseline.source_sha256,
            targets: [baseline.target],
            rounds: baseline.rounds,
            limits: baseline.limits
        },
        samples: baseline.samples
    };
}

function validatedBaseline(value: unknown, context: AssessmentSourceContext): AssessmentBaseline {
    requireBaseline(object(value) && value.schema === ASSESSMENT_BASELINE_SCHEMA, 'unsupported schema');
    const baseline = value as AssessmentBaseline;
    const rebuilt = buildBaselineWithContext(baselineRun(baseline), baseline.target_id, context);
    requireBaseline(same(rebuilt, baseline), 'snapshot differs from its validated evidence');
    return rebuilt;
}

/** Validate one baseline object against the current production bank and execution provenance. */
export function validate_assessment_baseline(value: unknown, context = create_assessment_source_context()): AssessmentBaseline {
    return validatedBaseline(value, context);
}

/** Invalid, tampered and obsolete snapshots are skipped, never upgraded or filled with defaults. */
export function load_assessment_baselines(paths: Iterable<string>, context = create_assessment_source_context()): AssessmentBaseline[] {
    const result: AssessmentBaseline[] = [],
        seen = new Set();
    for (const path of paths) {
        try {
            const baseline = validatedBaseline(parseAssessmentJson(readFileSync(path, 'utf8')) as Evidence, context);
            if (!seen.has(baseline.id)) {
                seen.add(baseline.id);
                result.push(baseline);
            }
        } catch {
            /* A bad file must not hide other valid baselines. */
        }
    }
    return result;
}

/** Project one run's target observations with baseline eligibility evaluated against the caller's source context. */
export function project_run_observations(value: unknown, context = create_assessment_source_context()): AssessmentObservation[] {
    if (!object(value) || !object(value.plan)) return [];
    const run = value as BaselineRun;
    const result: AssessmentObservation[] = [];
    for (const target of run.plan.targets ?? []) {
        let candidate: AssessmentBaseline | null = null,
            reason: string | null = null;
        try {
            candidate = buildBaselineWithContext(run, target.id, context);
        } catch (error) {
            reason = String((error as Error).message);
        }
        result.push(project_assessment_observation(run, target, 'run', candidate, reason));
    }
    return result;
}

/** Project already-validated baselines into observation rows without re-reading disk files. */
export function project_validated_baseline_observations(baselines: readonly AssessmentBaseline[]): AssessmentObservation[] {
    return baselines.map(valid => project_assessment_observation(baselineRun(valid), valid.target, 'baseline', valid, null, valid));
}

/** Preserve each task, round and failure independently; unknown usage and cost stay null. */
export function assessment_observations(
    baselines: readonly unknown[],
    runs: readonly unknown[],
    context = create_assessment_source_context()
): AssessmentObservation[] {
    const result: AssessmentObservation[] = [];
    for (const baseline of baselines) {
        try {
            const valid = validatedBaseline(baseline, context);
            result.push(project_assessment_observation(baselineRun(valid), valid.target, 'baseline', valid, null, valid));
        } catch {
            /* Ignore invalid snapshots. */
        }
    }
    for (const value of runs) result.push(...project_run_observations(value, context));
    return result;
}
