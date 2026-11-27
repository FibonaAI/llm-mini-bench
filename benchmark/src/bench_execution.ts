import { PRODUCTION_BANK_VERSION, is_released_bank_version } from './production_bank.ts';
import type { RunCallSummary } from './bench_call_summaries.ts';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AssessmentBudget, is_entry_rejection_status, run_assessment_sample } from './assessment_runner.ts';
import { load_assessment_bank } from './assessment_bank.ts';
import {
    assessment_source_digest,
    assessment_source_signature,
    capture_assessment_sources,
    create_assessment_source_context,
    type AssessmentSourceContext
} from './assessment_provenance.ts';
import { project_run_observations } from './assessment_baselines.ts';
import { project_assessment_observation, sent_no_request_attempt, type AssessmentObservation } from './assessment_observations.ts';
import {
    BENCH_DB_FILENAME,
    BenchDatabase,
    type PrecomputedPlanSnapshots,
    type RunIndexCacheEntry,
    type StoredLlmTurnUsageEvent,
    type StoredSessionEvent
} from './bench_db.ts';
import { canonicalStorageJson, private_directory, SessionJournal, SampleJournal } from './bench_execution_storage.ts';
import {
    execution_retryable_samples,
    execution_run_summary,
    execution_task_summary,
    fast_fail_stop_reason,
    is_retryable_sample,
    is_timeout_sample,
    terminal_run_status
} from './bench_execution_queries.ts';
export { EXECUTION_SOURCE_PATHS } from './assessment_provenance.ts';
export { private_directory, save_execution_json } from './bench_execution_storage.ts';
import { GatewayClient } from './client.ts';
import { assessmentJsonNumberToken } from './assessment_json.ts';
import type { AssessmentTask } from './assessment_tasks.ts';
import { _route_text, type BenchRouteMetadata } from './bench_routes.ts';

type RecordValue = Record<string, unknown>;
type Pricing = { prompt: number; completion: number };
type Limits = {
    max_requests: number | null;
    max_cost_usd: number | null;
    max_api_retries: number;
    max_output_tokens: number | null;
    max_turns: number | null;
    max_tool_calls: number | null;
    timeout: number;
    timeout_scope?: 'sample';
};
/** Private route bindings never appear in public execution plans. */
export interface ExecutionRoute extends BenchRouteMetadata {
    id?: string;
    label?: string;
    account_ref: string;
    account_evidence?: string;
    base_url: string;
    model: string;
    api_key: string;
    api_key_env?: string;
    thinking_levels: string[];
    account_concurrency: number;
    pricing: Pricing | null;
}
/** Both configured and gateway routes can resolve without changing scheduler semantics. */
export interface ExecutionRoutes {
    resolve(id: string): ExecutionRoute | Promise<ExecutionRoute>;
    resolve_many?(ids: string[]): Map<string, ExecutionRoute> | Promise<Map<string, ExecutionRoute>>;
    public_routes(): unknown | Promise<unknown>;
    public_routes_json?(): string | Promise<string>;
    create_client?(route: ExecutionRoute): SampleClient;
    execution_sources?(): Record<string, Uint8Array>;
}
interface ExecutionTarget extends BenchRouteMetadata {
    id: string;
    route_id: string;
    label: string;
    account_ref: string;
    account_evidence: string;
    model: string;
    thinking: string;
    account_concurrency: number;
    pricing: Pricing | null;
}
interface ExecutionPlan {
    bank_version: string;
    bank_scope: string;
    bank_snapshot: RecordValue;
    targets: ExecutionTarget[];
    task_ids: string[];
    task_snapshots: RecordValue[];
    rounds: number;
    concurrency: number;
    limits: Limits;
    source_sha256: Record<string, string>;
    sample_count: number;
}
interface ExecutionSample extends RecordValue {
    sample_id: string;
    attempt_id: string;
    run_id: string;
    target_id: string;
    route_id: string;
    account_ref: string;
    account_evidence: string;
    task: string;
    model: string;
    thinking: string;
    round: number;
    status: string;
    grade: unknown;
}
/** Durable run snapshots contain no runtime credentials or callable tasks. */
export interface ExecutionRun extends RecordValue {
    id: string;
    status: string;
    created_at: string;
    updated_at: string;
    plan: ExecutionPlan;
    samples: ExecutionSample[];
    budget: RecordValue;
    stop_reason: string | null;
}
/** A task freezes membership and per-run limits; child run files remain the execution evidence. */
export interface ExecutionTaskPlan extends Omit<ExecutionPlan, 'concurrency'> {
    sample_concurrency: number;
    run_concurrency: number;
    run_count: number;
    samples_per_run: number;
    total_max_cost_usd: number | null;
}
/** Committed task membership is projected read-only outside the coordinator. */
export interface ExecutionTaskState {
    id: string;
    status: string;
    created_at: string;
    updated_at: string;
    plan: ExecutionTaskPlan;
    child_run_ids: string[];
    stop_reason: string | null;
}
interface RunRuntime {
    bindings: Map<string, ExecutionRoute>;
    tasks: Map<string, AssessmentTask>;
    targets: Map<string, ExecutionTarget>;
    cancel: { value: boolean };
    budget: RunBudget;
    active: number;
    target_active: Set<string>;
    last_target_id: string | null;
    journal: SessionJournal;
    dirty: boolean;
    dirty_samples: Set<string>;
    /** Route ID -> fast-fail stop reason observed by this run; its blocked samples were left unsent. */
    fast_fail: Map<string, string>;
}
interface SampleDispatch {
    run_id: string;
    sample_id: string;
    attempt_id: string;
    target_id: string;
    route_id: string;
    account_ref: string;
    account_evidence: string;
    task: string;
    round: number;
    retry_limits?: unknown;
}
type SampleClient = Parameters<typeof run_assessment_sample>[0];
type ClientFactory = (base_url: string, api_key: string) => SampleClient;
/** Terminal failures and cancellations never contribute synthetic zero scores. */
export const TERMINAL_RUN_STATUSES = new Set(['completed', 'incomplete', 'cancelled', 'interrupted', 'failed']);
/** New evaluations share one whole-sample deadline; nullable legacy caps mean uncapped. */
export const DEFAULT_LIMITS: Limits = {
    max_requests: null,
    max_cost_usd: null,
    max_api_retries: 3,
    max_output_tokens: null,
    max_turns: null,
    max_tool_calls: null,
    timeout: 600,
    timeout_scope: 'sample'
};
const now = () => new Date().toISOString();
const uuid = () => randomUUID().replaceAll('-', '');
const clone = <T>(value: T): T => structuredClone(value);
function object(value: unknown): value is RecordValue {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function integer(value: unknown, minimum: number, maximum: number, name: string, container?: object): number {
    const token = container ? assessmentJsonNumberToken(container, name) : undefined;
    if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < minimum ||
        value > maximum ||
        (token !== undefined && /[.eE]/.test(token))
    )
        throw new TypeError(name + ' is outside safety bounds');
    return value;
}
function knownKeys(value: unknown, allowed: readonly string[], name: string): RecordValue {
    if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)))
        throw new TypeError(name + ' must be an object with only supported fields');
    return value;
}
function storageError(error: unknown): boolean {
    return error instanceof Error && 'code' in error;
}
class RunBudget extends AssessmentBudget {
    declare readonly cost_limit: number;
    declare readonly request_limit: number;
    constructor(
        limits: Limits,
        readonly cancellation: { value: boolean }
    ) {
        super(limits.max_cost_usd ?? Infinity, limits.max_requests ?? Infinity);
    }
    override admit(body: Parameters<AssessmentBudget['admit']>[0], pricing: Pricing | null) {
        return this.cancellation.value ? null : super.admit(body, pricing);
    }
    snapshot(): RecordValue {
        return {
            requests: this.requests,
            max_requests: Number.isFinite(this.request_limit) ? this.request_limit : null,
            max_cost_usd: Number.isFinite(this.cost_limit) ? this.cost_limit : null,
            uncertain_cost_reservation_usd: this.uncertain_cost,
            known_cost_lower_bound_usd: this.spent,
            estimated_uncached_cost_usd: this.missing_cost ? null : this.spent,
            reserved_cost_usd: this.reserved,
            missing_cost_calls: this.missing_cost,
            stop_reason: this.stop_reason
        };
    }
}
interface LegacyRunOverlay {
    status?: string;
    known_cost_lower_bound_usd?: number;
    budget_missing_cost_calls?: number;
    budget_uncertain_cost_reservation_usd?: number;
    budget_estimated_uncached_cost_usd?: number | null;
    samples: Record<
        string,
        {
            status?: string;
            usage?: { input_tokens: number; output_tokens: number };
            estimated_uncached_cost_usd?: number;
            attempts?: Record<
                number,
                {
                    usage?: { input_tokens: number; output_tokens: number };
                    estimated_uncached_cost_usd?: number;
                }
            >;
        }
    >;
}

interface BaselineTargetSummary {
    target_id: string;
    baseline_eligible: boolean;
    ineligibility_reason: string | null;
}

interface IndexedRun {
    id: string;
    task_id?: string;
    execution_kind?: string;
    status: string;
    stop_reason: string | null;
    created_at: string;
    updated_at: string;
    summary: ReturnType<typeof execution_run_summary>;
    /** Compact serialized observations array; avoids holding tens of thousands of nested sample objects in JS heap. */
    observations_json: string;
    baseline_targets: BaselineTargetSummary[];
    legacy_overlay?: LegacyRunOverlay;
}

function summarize_baseline_targets(observations: readonly AssessmentObservation[]): BaselineTargetSummary[] {
    return observations.map(obs => ({
        target_id: String(obs.target_id ?? ''),
        baseline_eligible: Boolean(obs.baseline_eligible),
        ineligibility_reason: typeof obs.ineligibility_reason === 'string' ? obs.ineligibility_reason : null
    }));
}

function slim_task_state(task: ExecutionTaskState): ExecutionTaskState {
    const { task_snapshots: _snapshots, bank_snapshot: _bank, source_sha256: _sources, ...plan } = task.plan as unknown as RecordValue;
    return {
        ...task,
        plan: { ...plan, provenance_omitted: true } as unknown as ExecutionTaskPlan
    };
}

function slim_run_snapshot(run: ExecutionRun): ExecutionRun {
    const { task_snapshots: _snapshots, bank_snapshot: _bank, source_sha256: _sources, ...plan } = run.plan as unknown as RecordValue;
    const slimSamples = run.samples.map(sample => {
        const cloned = clone(sample);
        delete cloned.retry_source_sha256;
        if (Array.isArray(cloned.attempts)) {
            for (const attempt of cloned.attempts) {
                if (object(attempt)) delete attempt.retry_source_sha256;
            }
        }
        return cloned;
    });
    const result = {
        ...clone({ ...run, plan: { ...plan, provenance_omitted: true }, samples: [] }),
        samples: slimSamples
    } as unknown as ExecutionRun;
    if (Array.isArray(result.retry_batches)) {
        result.retry_batches = result.retry_batches.map(batch => {
            if (!object(batch)) return batch;
            const { source_sha256: _batchSources, ...rest } = batch;
            return rest;
        });
    }
    return result;
}

/** Event-driven scheduler serializes admission; only network requests run concurrently. */
interface QueuedChildEntry {
    task_id: string;
    target: ExecutionTarget;
    route: ExecutionRoute;
    tasks: Map<string, AssessmentTask>;
}
export class BenchExecutionService {
    readonly concurrency: number;
    readonly data_dir: string;
    readonly db: BenchDatabase;
    private readonly owns_db: boolean;
    /** Active runs (and any run whose final persistence failed) stay in memory; terminal and queued-lazy runs are indexed and loaded on demand from SQLite. */
    readonly _runs = new Map<string, ExecutionRun>();
    readonly _runtime = new Map<string, RunRuntime>();
    readonly _tasks = new Map<string, ExecutionTaskState>();
    private readonly _run_index = new Map<string, IndexedRun>();
    private readonly slim_tasks = new Set<string>();
    private _cached_source_sig = '';
    private _cached_source_digest = '';
    private _revision = 0;
    private readonly task_active_runs = new Map<string, Set<string>>();
    private readonly task_last_admitted_run = new Map<string, string>();
    private readonly task_queued_children = new Map<string, Map<string, QueuedChildEntry>>();
    private readonly queued_child_task = new Map<string, string>();
    private readonly task_interleaved_order = new Map<string, string[]>();
    readonly _account_active = new Map<string, number>();
    readonly _account_limits = new Map<string, number>();
    /** Service-wide fast-fail blocks (route ID -> stop reason); in memory only, so a restart clears them. */
    private readonly route_blocks = new Map<string, string>();
    retry_wait?: (milliseconds: number, cancelled?: () => boolean) => Promise<void>;
    _active = 0;
    _closing = false;
    private last_run_id: string | null = null;
    private scheduled = false;
    private waiters = new Map<string, Set<() => void>>();
    constructor(
        data_dir: string,
        readonly routes: ExecutionRoutes,
        concurrency = 18,
        readonly client_factory: ClientFactory = (base, key) => new GatewayClient(base, key),
        db?: BenchDatabase
    ) {
        this.concurrency = integer(concurrency, 1, 64, 'global concurrency');
        this.data_dir = resolve(data_dir);
        private_directory(this.data_dir);
        this.db = db ?? new BenchDatabase(join(this.data_dir, BENCH_DB_FILENAME));
        this.owns_db = !db;
        this.load_runs();
        this.load_tasks();
    }
    private with_db_read<T>(fn: (db: BenchDatabase) => T): T {
        if (!this.db.is_closed) return fn(this.db);
        const temp = new BenchDatabase(this.db.path);
        try {
            return fn(temp);
        } finally {
            temp.close();
        }
    }
    get revision(): number {
        return this._revision;
    }
    has_run(id: string): boolean {
        return this._runs.has(id) || this._run_index.has(id);
    }
    read_run_call_summaries(id: string): RunCallSummary[] | null {
        if (!this.has_run(id)) return null;
        return this.with_db_read(db => db.read_run_call_summaries(id));
    }
    read_run_session_events(id: string, attemptId?: string): StoredSessionEvent[] | null {
        if (!this.has_run(id)) return null;
        return this.with_db_read(db => db.read_run_session_events(id, attemptId));
    }
    read_sample_session_events(id: string, sampleId: string, attemptId?: string): StoredSessionEvent[] | null {
        if (!this.has_run(id)) return null;
        return this.with_db_read(db => db.read_sample_session_events(id, sampleId, attemptId));
    }
    private run_status(id: string): string | null {
        return this._runs.get(id)?.status ?? this._run_index.get(id)?.status ?? null;
    }
    private run_summary(id: string, cloneOutput = true): ReturnType<typeof execution_run_summary> {
        const active = this._runs.get(id);
        if (active) return execution_run_summary(active, this._runtime.get(id)?.budget.snapshot(), cloneOutput);
        const summary = this._run_index.get(id)!.summary;
        return cloneOutput ? clone(summary) : summary;
    }
    private index_run(run: ExecutionRun, context: AssessmentSourceContext, legacy_overlay?: LegacyRunOverlay): IndexedRun {
        const observations = project_run_observations(run, context);
        return {
            id: run.id,
            ...(typeof run.task_id === 'string' ? { task_id: run.task_id } : {}),
            ...(typeof run.execution_kind === 'string' ? { execution_kind: run.execution_kind } : {}),
            status: run.status,
            stop_reason: run.stop_reason,
            created_at: run.created_at,
            updated_at: run.updated_at,
            summary: execution_run_summary(run, this._runtime.get(run.id)?.budget.snapshot()),
            observations_json: JSON.stringify(observations),
            baseline_targets: summarize_baseline_targets(observations),
            ...(legacy_overlay ? { legacy_overlay } : {})
        };
    }
    private update_active_index(run: ExecutionRun): void {
        const existing = this._run_index.get(run.id);
        const summary = execution_run_summary(run, this._runtime.get(run.id)?.budget.snapshot());
        this._run_index.set(run.id, {
            id: run.id,
            ...(typeof run.task_id === 'string' ? { task_id: run.task_id } : {}),
            ...(typeof run.execution_kind === 'string' ? { execution_kind: run.execution_kind } : {}),
            status: run.status,
            stop_reason: run.stop_reason,
            created_at: run.created_at,
            updated_at: run.updated_at,
            summary,
            observations_json: existing?.observations_json ?? '[]',
            baseline_targets: existing?.baseline_targets ?? []
        });
    }
    private apply_legacy_overlay(run: ExecutionRun, overlay?: LegacyRunOverlay): void {
        for (const sample of run.samples) {
            if (!object(sample.usage) && object(sample.latest_attempt_usage)) sample.usage = clone(sample.latest_attempt_usage);
            if (
                typeof sample.estimated_uncached_cost_usd !== 'number' &&
                typeof sample.latest_attempt_cost_usd === 'number' &&
                Number.isFinite(sample.latest_attempt_cost_usd)
            )
                sample.estimated_uncached_cost_usd = sample.latest_attempt_cost_usd;
        }
        if (!overlay) return;
        if (overlay.status) run.status = overlay.status;
        for (const sample of run.samples) {
            const patch = overlay.samples[sample.sample_id];
            if (!patch) continue;
            if (patch.status) sample.status = patch.status;
            if (patch.usage) {
                const zeroTimeoutUsage =
                    is_timeout_sample(sample) &&
                    object(sample.usage) &&
                    Number(sample.usage.input_tokens) === 0 &&
                    Number(sample.usage.output_tokens) === 0 &&
                    (patch.usage.input_tokens > 0 || patch.usage.output_tokens > 0);
                if (!object(sample.usage) || zeroTimeoutUsage) sample.usage = clone(patch.usage);
                if (Object.hasOwn(sample, 'latest_attempt_usage') && (!object(sample.latest_attempt_usage) || zeroTimeoutUsage))
                    sample.latest_attempt_usage = clone(patch.usage);
            }
            if (patch.estimated_uncached_cost_usd !== undefined) {
                const zeroTimeoutCost =
                    is_timeout_sample(sample) && sample.estimated_uncached_cost_usd === 0 && patch.estimated_uncached_cost_usd > 0;
                if (typeof sample.estimated_uncached_cost_usd !== 'number' || zeroTimeoutCost)
                    sample.estimated_uncached_cost_usd = patch.estimated_uncached_cost_usd;
                if (
                    Object.hasOwn(sample, 'latest_attempt_cost_usd') &&
                    (typeof sample.latest_attempt_cost_usd !== 'number' || zeroTimeoutCost)
                )
                    sample.latest_attempt_cost_usd = patch.estimated_uncached_cost_usd;
            }
            if (patch.attempts && Array.isArray(sample.attempts)) {
                for (const [indexKey, attemptPatch] of Object.entries(patch.attempts)) {
                    const attempt = sample.attempts[Number(indexKey)];
                    if (!object(attempt)) continue;
                    if (attemptPatch.usage) {
                        if (!object(attempt.usage)) attempt.usage = clone(attemptPatch.usage);
                        if (Object.hasOwn(attempt, 'latest_attempt_usage') && !object(attempt.latest_attempt_usage))
                            attempt.latest_attempt_usage = clone(attemptPatch.usage);
                    }
                    if (attemptPatch.estimated_uncached_cost_usd !== undefined) {
                        if (typeof attempt.estimated_uncached_cost_usd !== 'number')
                            attempt.estimated_uncached_cost_usd = attemptPatch.estimated_uncached_cost_usd;
                        if (Object.hasOwn(attempt, 'latest_attempt_cost_usd') && typeof attempt.latest_attempt_cost_usd !== 'number')
                            attempt.latest_attempt_cost_usd = attemptPatch.estimated_uncached_cost_usd;
                    }
                }
            }
        }
        if (object(run.budget)) {
            if (overlay.known_cost_lower_bound_usd !== undefined) {
                if (overlay.known_cost_lower_bound_usd > Number(run.budget.known_cost_lower_bound_usd ?? 0))
                    run.budget.known_cost_lower_bound_usd = overlay.known_cost_lower_bound_usd;
            }
            if (overlay.budget_missing_cost_calls !== undefined) run.budget.missing_cost_calls = overlay.budget_missing_cost_calls;
            if (overlay.budget_uncertain_cost_reservation_usd !== undefined)
                run.budget.uncertain_cost_reservation_usd = overlay.budget_uncertain_cost_reservation_usd;
            if (overlay.budget_estimated_uncached_cost_usd !== undefined)
                run.budget.estimated_uncached_cost_usd = overlay.budget_estimated_uncached_cost_usd;
        }
    }
    private load_run_from_db(id: string, includeProvenance = true): ExecutionRun | null {
        const run = this.with_db_read(db => db.load_run(id, includeProvenance)) as ExecutionRun | null;
        if (!run) return null;
        if (!object(run) || run.id !== id || !Array.isArray(run.samples) || !object(run.plan))
            throw new TypeError('Saved bench run identity mismatch');
        this.apply_legacy_overlay(run, this._run_index.get(id)?.legacy_overlay);
        return run;
    }
    private normalize_legacy_run(run: ExecutionRun): LegacyRunOverlay | undefined {
        const overlay: LegacyRunOverlay = { samples: {} };
        let patched = false;
        if (run.status === 'failed') {
            const legacy = run.samples.some(sample => sample.status === 'response_incomplete_or_error');
            if (legacy) {
                const calls = new Map(this.db.read_run_call_summaries(run.id).map(call => [call.call_id, call]));
                for (const sample of run.samples) {
                    if (sample.status === 'response_incomplete_or_error') {
                        const ids = Array.isArray(sample.calls) ? sample.calls : [];
                        const last = calls.get(String(ids.at(-1)));
                        sample.status =
                            last && (last.http_status !== 200 || last.error_code !== null || last.error_message !== null)
                                ? 'api_failure'
                                : 'incomplete';
                        overlay.samples[sample.sample_id] = { ...(overlay.samples[sample.sample_id] ?? {}), status: sample.status };
                        patched = true;
                    }
                }
            }
            const normalizedStatus = terminal_run_status(run.samples, run.stop_reason, false);
            if (normalizedStatus !== run.status) {
                run.status = normalizedStatus;
                overlay.status = normalizedStatus;
                patched = true;
            }
        } else if (run.status === 'completed') {
            const normalizedStatus = terminal_run_status(run.samples, run.stop_reason, false);
            if (normalizedStatus !== run.status) {
                run.status = normalizedStatus;
                overlay.status = normalizedStatus;
                patched = true;
            }
        }
        for (const sample of run.samples) {
            if (!object(sample.usage) && object(sample.latest_attempt_usage)) sample.usage = clone(sample.latest_attempt_usage);
            if (
                typeof sample.estimated_uncached_cost_usd !== 'number' &&
                typeof sample.latest_attempt_cost_usd === 'number' &&
                Number.isFinite(sample.latest_attempt_cost_usd)
            )
                sample.estimated_uncached_cost_usd = sample.latest_attempt_cost_usd;
        }
        const isZeroTimeoutUsage = (sample: ExecutionSample) =>
            is_timeout_sample(sample) &&
            Array.isArray(sample.calls) &&
            sample.calls.length > 1 &&
            object(sample.usage) &&
            Number(sample.usage.input_tokens) === 0 &&
            Number(sample.usage.output_tokens) === 0;
        const needsEventUsage = run.samples.some(
            sample =>
                ((sample.status === 'completed' || is_timeout_sample(sample)) &&
                    (!object(sample.usage) || typeof sample.estimated_uncached_cost_usd !== 'number' || isZeroTimeoutUsage(sample))) ||
                (Array.isArray(sample.attempts) &&
                    (sample.attempts as unknown[]).some(
                        attempt =>
                            object(attempt) &&
                            !sent_no_request_attempt(attempt) &&
                            Array.isArray(attempt.calls) &&
                            attempt.calls.length > 0 &&
                            (!object(Object.hasOwn(attempt, 'latest_attempt_usage') ? attempt.latest_attempt_usage : attempt.usage) ||
                                typeof (Object.hasOwn(attempt, 'latest_attempt_cost_usd')
                                    ? attempt.latest_attempt_cost_usd
                                    : attempt.estimated_uncached_cost_usd) !== 'number')
                    ))
        );
        const needsBudgetRepair = object(run.budget) && Number(run.budget.missing_cost_calls ?? 0) > 0;
        let runEvents: StoredLlmTurnUsageEvent[] | null = null;
        if (needsEventUsage || needsBudgetRepair) {
            runEvents = this.db.read_run_llm_turn_usage_events(run.id);
        }
        if (needsEventUsage && runEvents) {
            const callEvents = new Map<
                string,
                { usage: { input_tokens: number; output_tokens: number } | null; cost: number | null; entryRejection: boolean }
            >();
            for (const event of runEvents) {
                if (!event.call_id) continue;
                const entryRejection = event.http_status !== null && is_entry_rejection_status(event.http_status);
                const usage =
                    event.usage_known && event.input_tokens !== null && event.output_tokens !== null
                        ? { input_tokens: event.input_tokens, output_tokens: event.output_tokens }
                        : entryRejection
                          ? { input_tokens: 0, output_tokens: 0 }
                          : null;
                const cost = usage ? (event.estimated_cost_usd !== null ? event.estimated_cost_usd : entryRejection ? 0 : null) : null;
                callEvents.set(event.call_id, { usage, cost, entryRejection });
            }
            for (const sample of run.samples) {
                const target = run.plan.targets.find(item => item.id === sample.target_id);
                const pricing = target?.pricing;
                if (
                    (sample.status === 'completed' || is_timeout_sample(sample)) &&
                    (!object(sample.usage) || typeof sample.estimated_uncached_cost_usd !== 'number' || isZeroTimeoutUsage(sample))
                ) {
                    const ids = Array.isArray(sample.calls) ? (sample.calls as string[]) : [];
                    const known = ids
                        .map(callId => callEvents.get(String(callId)))
                        .filter(
                            (
                                item
                            ): item is {
                                usage: { input_tokens: number; output_tokens: number };
                                cost: number | null;
                                entryRejection: boolean;
                            } => Boolean(item && item.usage)
                        );
                    if (known.length > 0 || (is_timeout_sample(sample) && !isZeroTimeoutUsage(sample))) {
                        const usage = known.reduce(
                            (acc, item) => ({
                                input_tokens: acc.input_tokens + item.usage.input_tokens,
                                output_tokens: acc.output_tokens + item.usage.output_tokens
                            }),
                            { input_tokens: 0, output_tokens: 0 }
                        );
                        const cost =
                            known.length > 0 && known.every(item => item.cost !== null)
                                ? known.reduce((acc, item) => acc + (item.cost ?? 0), 0)
                                : pricing
                                  ? usage.input_tokens * pricing.prompt + usage.output_tokens * pricing.completion
                                  : null;
                        const zeroRestore = isZeroTimeoutUsage(sample) && (usage.input_tokens > 0 || usage.output_tokens > 0);
                        const patch = overlay.samples[sample.sample_id] ?? {};
                        if (!object(sample.usage) || zeroRestore) {
                            sample.usage = usage;
                            patch.usage = clone(usage);
                            patched = true;
                        }
                        if (Object.hasOwn(sample, 'latest_attempt_usage') && (!object(sample.latest_attempt_usage) || zeroRestore))
                            sample.latest_attempt_usage = clone(usage);
                        if (
                            (typeof sample.estimated_uncached_cost_usd !== 'number' || (zeroRestore && cost !== null && cost > 0)) &&
                            cost !== null
                        ) {
                            sample.estimated_uncached_cost_usd = cost;
                            patch.estimated_uncached_cost_usd = cost;
                            patched = true;
                        }
                        if (
                            Object.hasOwn(sample, 'latest_attempt_cost_usd') &&
                            (typeof sample.latest_attempt_cost_usd !== 'number' || (zeroRestore && cost !== null && cost > 0)) &&
                            cost !== null
                        )
                            sample.latest_attempt_cost_usd = cost;
                        if (patch.usage || patch.estimated_uncached_cost_usd !== undefined) overlay.samples[sample.sample_id] = patch;
                    }
                }
                if (Array.isArray(sample.attempts)) {
                    for (let attemptIndex = 0; attemptIndex < sample.attempts.length; attemptIndex++) {
                        const attempt = sample.attempts[attemptIndex];
                        if (!object(attempt) || sent_no_request_attempt(attempt) || !Array.isArray(attempt.calls) || !attempt.calls.length)
                            continue;
                        const attemptUsage = Object.hasOwn(attempt, 'latest_attempt_usage') ? attempt.latest_attempt_usage : attempt.usage;
                        const attemptCost = Object.hasOwn(attempt, 'latest_attempt_cost_usd')
                            ? attempt.latest_attempt_cost_usd
                            : attempt.estimated_uncached_cost_usd;
                        if (object(attemptUsage) && typeof attemptCost === 'number') continue;
                        const items = (attempt.calls as string[]).map(callId => callEvents.get(String(callId)));
                        if (items.length && items.every(item => item && item.usage !== null)) {
                            const usage = items.reduce(
                                (acc, item) => ({
                                    input_tokens: acc.input_tokens + item!.usage!.input_tokens,
                                    output_tokens: acc.output_tokens + item!.usage!.output_tokens
                                }),
                                { input_tokens: 0, output_tokens: 0 }
                            );
                            const cost = items.every(item => item!.cost !== null)
                                ? items.reduce((acc, item) => acc + (item!.cost ?? 0), 0)
                                : pricing
                                  ? usage.input_tokens * pricing.prompt + usage.output_tokens * pricing.completion
                                  : null;
                            const samplePatch = overlay.samples[sample.sample_id] ?? {};
                            const attemptPatch = samplePatch.attempts?.[attemptIndex] ?? {};
                            if (!object(attempt.usage)) {
                                attempt.usage = usage;
                                attemptPatch.usage = clone(usage);
                                patched = true;
                            }
                            if (Object.hasOwn(attempt, 'latest_attempt_usage') && !object(attempt.latest_attempt_usage))
                                attempt.latest_attempt_usage = clone(usage);
                            if (typeof attempt.estimated_uncached_cost_usd !== 'number' && cost !== null) {
                                attempt.estimated_uncached_cost_usd = cost;
                                attemptPatch.estimated_uncached_cost_usd = cost;
                                patched = true;
                            }
                            if (
                                Object.hasOwn(attempt, 'latest_attempt_cost_usd') &&
                                typeof attempt.latest_attempt_cost_usd !== 'number' &&
                                cost !== null
                            )
                                attempt.latest_attempt_cost_usd = cost;
                            if (attemptPatch.usage || attemptPatch.estimated_uncached_cost_usd !== undefined) {
                                samplePatch.attempts = { ...(samplePatch.attempts ?? {}), [attemptIndex]: attemptPatch };
                                overlay.samples[sample.sample_id] = samplePatch;
                            }
                        }
                    }
                }
            }
        }
        if (object(run.budget)) {
            const sampleCosts = run.samples
                .map(sample => sample.estimated_uncached_cost_usd)
                .filter((cost): cost is number => typeof cost === 'number' && Number.isFinite(cost) && cost >= 0);
            const totalKnownCost = sampleCosts.reduce((sum, cost) => sum + cost, 0);
            if (totalKnownCost > Number(run.budget.known_cost_lower_bound_usd ?? 0)) {
                run.budget.known_cost_lower_bound_usd = totalKnownCost;
                overlay.known_cost_lower_bound_usd = totalKnownCost;
                patched = true;
            }
            if (needsBudgetRepair && runEvents) {
                const llmEvents = runEvents;
                // Clear missing-cost accounting only when every call has known cost evidence or was a confirmed
                // entry rejection; unpriced routes keep known usage with unknown cost.
                const nonEntryUnknown = llmEvents.filter(
                    event =>
                        !(event.http_status !== null && is_entry_rejection_status(event.http_status)) &&
                        !(event.usage_known && event.estimated_cost_usd !== null)
                );
                if (llmEvents.length > 0 && nonEntryUnknown.length === 0) {
                    const knownBound = Number(run.budget.known_cost_lower_bound_usd ?? 0);
                    run.budget.missing_cost_calls = 0;
                    run.budget.uncertain_cost_reservation_usd = 0;
                    run.budget.estimated_uncached_cost_usd = knownBound;
                    overlay.budget_missing_cost_calls = 0;
                    overlay.budget_uncertain_cost_reservation_usd = 0;
                    overlay.budget_estimated_uncached_cost_usd = knownBound;
                    patched = true;
                }
            }
        }
        return patched ? overlay : undefined;
    }
    private to_cache_entry(indexed: IndexedRun, sourceSig: string): RunIndexCacheEntry {
        return {
            run_id: indexed.id,
            source_sig: sourceSig,
            updated_at: indexed.updated_at,
            summary_json: JSON.stringify(indexed.summary),
            observations_json: indexed.observations_json,
            legacy_overlay_json: indexed.legacy_overlay ? JSON.stringify(indexed.legacy_overlay) : null
        };
    }
    private load_runs(): void {
        const context = create_assessment_source_context();
        const sourceSig = assessment_source_signature();
        const sourceDigest = assessment_source_digest(context);
        this._cached_source_sig = sourceSig;
        this._cached_source_digest = sourceDigest;
        const cacheUpdates: RunIndexCacheEntry[] = [];
        let coldLoaded = 0;
        for (const row of this.db.list_runs_for_startup()) {
            const id = row.id;
            if (
                TERMINAL_RUN_STATUSES.has(row.status) &&
                (row.cache_source_sig === sourceDigest || row.cache_source_sig === sourceSig) &&
                row.cache_updated_at === row.updated_at &&
                typeof row.summary_json === 'string' &&
                typeof row.observations_json === 'string'
            ) {
                try {
                    const summary = JSON.parse(row.summary_json) as ReturnType<typeof execution_run_summary>;
                    const observations = JSON.parse(row.observations_json) as AssessmentObservation[];
                    const legacy_overlay =
                        typeof row.legacy_overlay_json === 'string' ? (JSON.parse(row.legacy_overlay_json) as LegacyRunOverlay) : undefined;
                    if (
                        object(summary) &&
                        summary.id === id &&
                        typeof summary.result_quality?.timeout_samples === 'number' &&
                        typeof summary.result_quality?.model_anomaly_samples === 'number' &&
                        typeof summary.result_quality?.non_model_anomaly_samples === 'number' &&
                        typeof summary.result_quality?.ended_after_submission_samples === 'number' &&
                        typeof summary.result_quality?.no_submission_samples === 'number' &&
                        typeof summary.metrics?.scored_samples === 'number' &&
                        typeof summary.metrics?.elapsed_sample_count === 'number' &&
                        Array.isArray(observations)
                    ) {
                        this._run_index.set(id, {
                            id,
                            ...(typeof row.task_id === 'string' ? { task_id: row.task_id } : {}),
                            ...(typeof row.execution_kind === 'string' ? { execution_kind: row.execution_kind } : {}),
                            status: legacy_overlay?.status ?? summary.status ?? row.status,
                            stop_reason: row.stop_reason ?? null,
                            created_at: row.created_at,
                            updated_at: row.updated_at,
                            summary,
                            observations_json: row.observations_json,
                            baseline_targets: summarize_baseline_targets(observations),
                            ...(legacy_overlay ? { legacy_overlay } : {})
                        });
                        continue;
                    }
                } catch {
                    /* Corrupt index cache row falls back to full hydration. */
                }
            }
            const run = this.db.load_run(id) as ExecutionRun | null;
            if (!run) continue;
            coldLoaded++;
            if (!object(run) || run.id !== id || !Array.isArray(run.samples) || !object(run.plan))
                throw new TypeError('Saved bench run identity mismatch');
            if (!TERMINAL_RUN_STATUSES.has(run.status)) {
                run.status = 'interrupted';
                run.updated_at = now();
                run.stop_reason = 'service_restart';
                for (const sample of run.samples) if (['pending', 'running'].includes(sample.status)) sample.status = 'interrupted';
                this.db.save_run(run);
            }
            const legacyOverlay = this.normalize_legacy_run(run);
            const indexed = this.index_run(run, context, legacyOverlay);
            this._run_index.set(id, indexed);
            if (TERMINAL_RUN_STATUSES.has(run.status)) cacheUpdates.push(this.to_cache_entry(indexed, sourceDigest));
        }
        if (cacheUpdates.length) this.db.save_run_index_cache_batch(cacheUpdates);
        if (coldLoaded > 0) this.db.shrink_memory();
    }
    private load_full_task_from_db(id: string): ExecutionTaskState {
        const task = this.with_db_read(db => db.load_task(id, true)) as unknown as ExecutionTaskState;
        const cached = this._tasks.get(id);
        if (cached) {
            task.status = cached.status;
            task.stop_reason = cached.stop_reason;
            task.updated_at = cached.updated_at;
        }
        return task;
    }
    private load_tasks(): void {
        for (const raw of this.db.list_tasks(false)) {
            const task = raw as unknown as ExecutionTaskState;
            const id = task.id;
            if (
                !object(task) ||
                typeof id !== 'string' ||
                !object(task.plan) ||
                !Array.isArray(task.child_run_ids) ||
                !task.child_run_ids.length ||
                new Set(task.child_run_ids).size !== task.child_run_ids.length ||
                task.child_run_ids.some(child => typeof child !== 'string' || this._run_index.get(child)?.task_id !== id)
            )
                throw new TypeError('Saved bench task membership mismatch');
            if (!TERMINAL_RUN_STATUSES.has(task.status)) {
                task.status = 'interrupted';
                task.stop_reason = 'service_restart';
                task.updated_at = now();
                this.db.update_task_status(id, task.status, task.stop_reason, task.updated_at);
            }
            if (['completed', 'failed', 'incomplete'].includes(task.status) && task.stop_reason !== 'storage_error') {
                const children = task.child_run_ids.map(child => this._run_index.get(child)!);
                if (children.every(run => TERMINAL_RUN_STATUSES.has(run.status))) {
                    task.status = children.every(run => run.status === 'completed')
                        ? 'completed'
                        : children.some(run => run.status === 'failed')
                          ? 'failed'
                          : children.some(run => run.status === 'interrupted')
                            ? 'interrupted'
                            : children.every(run => run.status === 'cancelled')
                              ? 'cancelled'
                              : 'incomplete';
                }
            }
            this._tasks.set(id, slim_task_state(task));
            this.slim_tasks.add(id);
        }
    }
    private async prepare_task(request: unknown) {
        const req = knownKeys(
            request,
            ['bank_version', 'targets', 'rounds', 'sample_concurrency', 'run_concurrency', 'limits'],
            'task request'
        );
        const sample_concurrency = integer(
            req.sample_concurrency === undefined ? 6 : req.sample_concurrency,
            1,
            64,
            'sample_concurrency',
            req
        );
        const run_concurrency = integer(req.run_concurrency === undefined ? 3 : req.run_concurrency, 1, 10, 'run_concurrency', req);
        const rounds = integer(req.rounds === undefined ? 3 : req.rounds, 1, 3, 'rounds', req);
        const prepared = await this.prepare(
            {
                bank_version: req.bank_version === undefined ? PRODUCTION_BANK_VERSION : req.bank_version,
                targets: req.targets,
                rounds,
                concurrency: Math.min(sample_concurrency, this.concurrency),
                limits: req.limits === undefined ? {} : req.limits
            },
            'task'
        );
        const { concurrency: ignored, ...base } = prepared.plan;
        const plan: ExecutionTaskPlan = {
            ...base,
            sample_concurrency,
            run_concurrency,
            run_count: base.targets.length,
            samples_per_run: base.task_ids.length * base.rounds,
            total_max_cost_usd: base.limits.max_cost_usd === null ? null : base.targets.length * base.limits.max_cost_usd
        };
        return { prepared, plan };
    }
    /** Plan one independent whole-bank run per route/Thinking leaf, without submitting requests. */
    async plan_task(request: unknown): Promise<ExecutionTaskPlan> {
        return clone((await this.prepare_task(request)).plan);
    }
    /** Stage all child evidence before the atomic task manifest commit permits scheduling. */
    async start_task(request: unknown): Promise<string> {
        const { prepared, plan } = await this.prepare_task(request);
        if (this._closing) throw new Error('Bench execution service is closed');
        if ([...this._tasks.values()].filter(task => !TERMINAL_RUN_STATUSES.has(task.status)).length >= 10)
            throw new TypeError('At most 10 bench tasks may be active');
        const id = uuid();
        const staged: Array<{ run: ExecutionRun; target: ExecutionTarget; route: ExecutionRoute }> = [];
        const task: ExecutionTaskState = {
            id,
            status: 'queued',
            created_at: now(),
            updated_at: now(),
            plan,
            child_run_ids: [],
            stop_reason: null
        };
        const sharedTaskMap = new Map(prepared.tasks.map(item => [item.id, item]));
        try {
            this.db.run_in_transaction(() => {
                const precomputed: PrecomputedPlanSnapshots = {
                    bankHash: this.db.put_snapshot('bank', prepared.plan.bank_snapshot ?? {}),
                    tasksHash: this.db.put_snapshot('tasks', prepared.plan.task_snapshots ?? []),
                    sourcesHash: this.db.put_snapshot('sources', prepared.plan.source_sha256 ?? {})
                };
                for (const target of prepared.plan.targets) {
                    const childId = uuid();
                    // Share immutable bank/task provenance snapshots across sibling children to limit active RSS.
                    const childPlan: ExecutionPlan = {
                        ...prepared.plan,
                        targets: [clone(target)],
                        concurrency: plan.sample_concurrency,
                        sample_count: plan.samples_per_run,
                        limits: clone(prepared.plan.limits)
                    };
                    const run = this.build_staged_run(childPlan, prepared.tasks, childId, id);
                    staged.push({ run, target: childPlan.targets[0]!, route: prepared.bindings.get(target.id)! });
                    task.child_run_ids.push(childId);
                    this._persist(run, undefined, precomputed);
                }
                this._persist_task(task, precomputed); // Commit: no child runtime has been installed yet.
            });
        } catch (error) {
            this.fail_storage();
            throw error;
        }
        const slimTask = slim_task_state(task);
        this._tasks.set(id, slimTask);
        this.slim_tasks.add(id);
        this.task_active_runs.set(id, new Set());
        this.task_last_admitted_run.delete(id);
        const queuedMap = new Map<string, QueuedChildEntry>();
        const stagedById = new Map<string, { run: ExecutionRun; target: ExecutionTarget; route: ExecutionRoute }>();
        for (const entry of staged) {
            const { run, target, route } = entry;
            stagedById.set(run.id, entry);
            const queuedObs = [
                project_assessment_observation(
                    run as unknown as Parameters<typeof project_assessment_observation>[0],
                    target as unknown as Parameters<typeof project_assessment_observation>[1],
                    'run',
                    null,
                    'Assessment baseline: run must be completed'
                )
            ];
            this._run_index.set(run.id, {
                id: run.id,
                task_id: id,
                execution_kind: 'task-child-v1',
                status: run.status,
                stop_reason: run.stop_reason,
                created_at: run.created_at,
                updated_at: run.updated_at,
                summary: execution_run_summary(run),
                observations_json: JSON.stringify(queuedObs),
                baseline_targets: summarize_baseline_targets(queuedObs)
            });
            this._account_limits.set(
                route.account_ref,
                Math.min(this._account_limits.get(route.account_ref) ?? 500, route.account_concurrency)
            );
        }
        const interleaved = this.task_interleaved_children(slimTask);
        this.task_interleaved_order.set(id, interleaved);
        // Hydrate only the initial run_concurrency children upfront; keep remaining siblings lazy-queued in SQLite.
        const initialHydrateCount = Math.min(plan.run_concurrency, interleaved.length);
        for (let idx = 0; idx < interleaved.length; idx++) {
            const childId = interleaved[idx]!;
            const entry = stagedById.get(childId)!;
            if (idx < initialHydrateCount) {
                const runtime = this.build_runtime(entry.run, new Map([[entry.target.id, entry.route]]), sharedTaskMap);
                this._runs.set(childId, entry.run);
                this._runtime.set(childId, runtime);
            } else {
                queuedMap.set(childId, {
                    task_id: id,
                    target: entry.target,
                    route: entry.route,
                    tasks: sharedTaskMap
                });
                this.queued_child_task.set(childId, id);
            }
        }
        if (queuedMap.size) this.task_queued_children.set(id, queuedMap);
        this._revision++;
        this.schedule();
        return id;
    }
    _persist_task(task: ExecutionTaskState, precomputed?: PrecomputedPlanSnapshots): void {
        task.updated_at = now();
        this.db.save_task(task as unknown as RecordValue, precomputed);
        this._revision++;
    }
    private update_task(id: string): void {
        const task = this._tasks.get(id);
        if (!task || TERMINAL_RUN_STATUSES.has(task.status)) return;
        const statuses = task.child_run_ids.map(child => this.run_status(child)!);
        const finished = statuses.every(status => TERMINAL_RUN_STATUSES.has(status));
        const status = finished
            ? task.stop_reason === 'storage_error'
                ? 'failed'
                : statuses.every(value => value === 'completed')
                  ? 'completed'
                  : task.stop_reason === 'cancelled' || statuses.every(value => value === 'cancelled')
                    ? 'cancelled'
                    : statuses.some(value => value === 'failed')
                      ? 'failed'
                      : statuses.some(value => value === 'interrupted')
                        ? 'interrupted'
                        : 'incomplete'
            : task.stop_reason === 'cancelled'
              ? 'cancelling'
              : statuses.some(value => value !== 'queued')
                ? 'running'
                : 'queued';
        if (task.status === status) return;
        try {
            const targetTask = this.slim_tasks.has(id) ? this.load_full_task_from_db(id) : task;
            targetTask.status = status;
            if (finished && status === 'failed' && !targetTask.stop_reason) targetTask.stop_reason = 'child_failure';
            this._persist_task(targetTask);
            this._tasks.set(id, slim_task_state(targetTask));
            this.slim_tasks.add(id);
            if (finished) {
                this.task_active_runs.delete(id);
                this.task_last_admitted_run.delete(id);
                this.task_queued_children.delete(id);
                this.task_interleaved_order.delete(id);
                this.db.shrink_memory();
            }
        } catch {
            this.fail_storage();
        }
    }
    /** Task summaries expose child run IDs; raw samples and evidence remain at get_run. */
    get_task(id: string, options?: { omit_provenance?: boolean }): RecordValue | null {
        const cached = this._tasks.get(id);
        if (!cached) return null;
        const task = options?.omit_provenance
            ? this.slim_tasks.has(id)
                ? cached
                : slim_task_state(cached)
            : this.slim_tasks.has(id)
              ? this.load_full_task_from_db(id)
              : cached;
        return execution_task_summary(
            task,
            task.child_run_ids.map(run_id => this.run_summary(run_id))
        );
    }
    private collect_task_summaries(cloneOutput: boolean, enrichChild?: (child: RecordValue) => RecordValue): RecordValue[] {
        return [...this._tasks.keys()].reverse().map(id => {
            const task = this._tasks.get(id)!;
            const summary = execution_task_summary(
                task,
                task.child_run_ids.map(run_id => this.run_summary(run_id, cloneOutput)),
                cloneOutput
            );
            const children = enrichChild ? (summary.children as RecordValue[]).map(enrichChild) : summary.children;
            const { task_snapshots: _snapshots, bank_snapshot: _bank, source_sha256: _sources, ...plan } = summary.plan as RecordValue;
            return { ...summary, children, plan: { ...plan, provenance_omitted: true } };
        });
    }
    /** List independently persisted batches without duplicating raw child evidence. */
    /** History polling omits bulky frozen provenance; get_task keeps the complete plan. */
    list_tasks(): RecordValue[] {
        return this.collect_task_summaries(true);
    }
    /** Serialize task summaries directly for HTTP caches without cloning every historical record. */
    serialize_tasks_payload(enrichChild?: (child: RecordValue) => RecordValue): string {
        return JSON.stringify({ tasks: this.collect_task_summaries(false, enrichChild) });
    }
    /** Persist cancellation intent before cancelling any child; never resume queued work. */
    cancel_task(id: string): boolean {
        const cached = this._tasks.get(id);
        if (!cached) return false;
        if (TERMINAL_RUN_STATUSES.has(cached.status)) return true;
        try {
            const task = this.slim_tasks.has(id) ? this.load_full_task_from_db(id) : cached;
            task.status = 'cancelling';
            if (task.stop_reason !== 'storage_error') task.stop_reason = 'cancelled';
            this._persist_task(task);
            this._tasks.set(id, slim_task_state(task));
            this.slim_tasks.add(id);
        } catch {
            this.fail_storage();
            return true;
        }
        const queued = this.task_queued_children.get(id);
        if (queued && queued.size > 0) {
            this.cancel_queued_children(id, [...queued.keys()]);
        }
        for (const child of cached.child_run_ids) if (this._runs.has(child)) this.cancel_run(child);
        this.update_task(id);
        this.schedule();
        return true;
    }
    private prepare(request: unknown, scope: 'run' | 'task' = 'run') {
        return this._prepare(request, scope);
    }
    private async _prepare(request: unknown, scope: 'run' | 'task' = 'run') {
        const req = knownKeys(request, ['bank_version', 'targets', 'task_ids', 'rounds', 'concurrency', 'limits'], 'request');
        const version = req.bank_version === undefined ? PRODUCTION_BANK_VERSION : req.bank_version;
        if (typeof version !== 'string') throw new TypeError('Invalid bank version');
        const bank = is_released_bank_version(version)
            ? create_assessment_source_context().bank_for_version!(version)
            : load_assessment_bank(version);
        const rounds = integer(req.rounds === undefined ? 1 : req.rounds, 1, 3, 'rounds', req),
            concurrency = integer(
                req.concurrency === undefined ? this.concurrency : req.concurrency,
                1,
                scope === 'task' ? 64 : this.concurrency,
                'concurrency',
                req
            );
        const requested = knownKeys(req.limits === undefined ? {} : req.limits, Object.keys(DEFAULT_LIMITS), 'limits');
        const limits = { ...DEFAULT_LIMITS, ...requested } as Limits;
        for (const [key, low, high] of [
            ['max_requests', 1, 500],
            ['max_output_tokens', 128, 32768],
            ['max_turns', 1, 10],
            ['max_tool_calls', 1, 8],
            ['timeout', 10, 3600],
            ['max_api_retries', 0, 5]
        ] as const)
            if (!['timeout', 'max_api_retries'].includes(key) && limits[key] === null) continue;
            else integer(limits[key], low, high, key, requested);
        if (limits.timeout_scope !== undefined && limits.timeout_scope !== 'sample') throw new TypeError('Invalid timeout scope');
        if (
            limits.max_cost_usd !== null &&
            (typeof limits.max_cost_usd !== 'number' ||
                !Number.isFinite(limits.max_cost_usd) ||
                limits.max_cost_usd <= 0 ||
                limits.max_cost_usd > 10000)
        )
            throw new TypeError('max_cost_usd is outside safety bounds');
        const ids = req.task_ids === undefined ? bank.task_ids : req.task_ids;
        if (
            !Array.isArray(ids) ||
            !ids.length ||
            ids.some(id => typeof id !== 'string' || !bank.task_ids.includes(id)) ||
            new Set(ids).size !== ids.length
        )
            throw new TypeError('task_ids must be unique IDs in the selected assessment bank');
        const tasks = bank.tasks.filter(task => ids.includes(task.id));
        const specs = req.targets;
        if (!Array.isArray(specs) || !specs.length) throw new TypeError('targets must be a nonempty array');
        if (scope === 'run' && tasks.length * specs.length * rounds > 500)
            throw new TypeError('A bench run may contain at most 500 samples');
        const targets: ExecutionTarget[] = [],
            bindings = new Map<string, ExecutionRoute>(),
            combinations = new Set<string>(),
            seenIds = new Set<string>(),
            parsedSpecs: Array<{ id: string; route_id: string; thinking: string }> = [],
            uniqueRouteIds: string[] = [],
            seenRoutes = new Set<string>();
        for (const [index, specValue] of specs.entries()) {
            const spec = knownKeys(specValue, ['id', 'route_id', 'thinking'], 'target');
            const id = spec.id === undefined ? 'target-' + (index + 1) : spec.id,
                route_id = spec.route_id,
                thinking = spec.thinking === undefined ? 'default' : spec.thinking;
            if (
                typeof id !== 'string' ||
                !id.trim() ||
                typeof route_id !== 'string' ||
                !route_id.trim() ||
                typeof thinking !== 'string' ||
                !thinking.trim()
            )
                throw new TypeError('Target id, route_id and thinking must be nonempty strings');
            const combination = JSON.stringify([route_id, thinking]);
            if (seenIds.has(id) || combinations.has(combination)) throw new TypeError('Duplicate target id or route/thinking combination');
            seenIds.add(id);
            combinations.add(combination);
            parsedSpecs.push({ id, route_id, thinking });
            if (!seenRoutes.has(route_id)) {
                seenRoutes.add(route_id);
                uniqueRouteIds.push(route_id);
            }
        }
        const canBatchResolve =
            typeof this.routes.resolve_many === 'function' &&
            this.routes.resolve === (Object.getPrototypeOf(this.routes) as ExecutionRoutes | null)?.resolve;
        const resolvedRoutes = canBatchResolve
            ? await this.routes.resolve_many!(uniqueRouteIds)
            : new Map(await Promise.all(uniqueRouteIds.map(async route_id => [route_id, await this.routes.resolve(route_id)] as const)));
        for (const { id, route_id, thinking } of parsedSpecs) {
            const route = clone(resolvedRoutes.get(route_id)!);
            if (!object(route)) throw new TypeError('Unknown bench route');
            if (
                route.remote_route !== undefined &&
                (!object(route.remote_route) ||
                    Object.keys(route.remote_route).some(key => !['namespace', 'evidence'].includes(key)) ||
                    !_route_text(route.remote_route.namespace) ||
                    route.remote_route.namespace.includes('/') ||
                    !_route_text(route.remote_route.evidence, 128))
            )
                throw new TypeError('Invalid remote route namespace evidence');
            if (route.binding_ref !== undefined && !_route_text(route.binding_ref))
                throw new TypeError('Invalid adapter binding reference');
            if (thinking !== 'default' && !route.thinking_levels.includes(thinking))
                throw new TypeError('Thinking level is not supported by this route');
            for (const key of ['account_ref', 'base_url', 'model', 'api_key'] as const)
                if (typeof route[key] !== 'string' || !route[key].trim()) throw new TypeError('Route configuration is incomplete');
            const account_limit = integer(
                route.account_concurrency === undefined ? 1 : route.account_concurrency,
                1,
                500,
                'account_concurrency',
                route
            );
            const pricing = route.pricing;
            if (
                pricing !== null &&
                (!object(pricing) ||
                    [pricing.prompt, pricing.completion].some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0))
            )
                throw new TypeError('Route token pricing must be finite and nonnegative');
            if (pricing === null && limits.max_cost_usd !== null)
                throw new TypeError('Route without known pricing cannot enforce max_cost_usd');
            targets.push({
                id,
                route_id,
                label: route.label ?? route_id,
                account_ref: route.account_ref,
                account_evidence: route.account_evidence ?? 'configured_binding',
                ...(route.binding_ref !== undefined ? { binding_ref: route.binding_ref } : {}),
                ...(route.provider_id !== undefined ? { provider_id: route.provider_id } : {}),
                ...(route.provider_evidence !== undefined ? { provider_evidence: route.provider_evidence } : {}),
                ...(route.model_display_name !== undefined ? { model_display_name: route.model_display_name } : {}),
                ...(route.remote_route !== undefined ? { remote_route: clone(route.remote_route) } : {}),
                model: route.model,
                thinking,
                account_concurrency: account_limit,
                pricing: pricing === null ? null : { prompt: pricing.prompt, completion: pricing.completion }
            });
            bindings.set(id, { ...route, account_concurrency: account_limit });
        }
        const snapshots = tasks.map(task => Object.fromEntries(Object.entries(task).filter(([, value]) => typeof value !== 'function')));
        const { sources, hashes } = capture_assessment_sources(bank);
        for (const [source, content] of Object.entries(this.routes.execution_sources?.() ?? {})) {
            if (
                !_route_text(source, 512) ||
                !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(source) ||
                source.split('/').some(part => part === '.' || part === '..') ||
                sources.has(source) ||
                !(content instanceof Uint8Array) ||
                content.byteLength > 2 * 1024 * 1024
            )
                throw new TypeError('Invalid adapter execution source snapshot');
            sources.set(source, Buffer.from(content));
            hashes[source] = createHash('sha256').update(content).digest('hex');
        }
        for (const [key, digest] of Object.entries({ ...bank.source_sha256, ...bank.extension_sha256 }))
            if (hashes[key] !== digest) throw new TypeError('Assessment source changed during planning');
        const { tasks: discard, ...snapshot } = bank;
        const plan: ExecutionPlan = {
            bank_version: version,
            bank_scope: 'task_ids' in req ? 'subset' : 'whole',
            bank_snapshot: snapshot,
            targets,
            task_ids: tasks.map(task => task.id),
            task_snapshots: snapshots,
            rounds,
            concurrency,
            limits,
            source_sha256: hashes,
            sample_count: tasks.length * targets.length * rounds
        };
        return { plan, tasks, bindings, sources };
    }
    async plan(request: unknown): Promise<ExecutionPlan> {
        return clone((await this.prepare(request)).plan);
    }
    async start_run(request: unknown): Promise<string> {
        const { plan, tasks, bindings, sources } = await this.prepare(request);
        if (this._closing) throw new Error('Bench execution service is closed');
        if ([...this._runs.values()].filter(run => !run.task_id && !TERMINAL_RUN_STATUSES.has(run.status)).length >= 10)
            throw new TypeError('At most 10 bench runs may be active');
        const id = uuid();
        const { run, runtime } = this.stage_run({ plan, tasks, bindings, sources }, id);
        for (const route of bindings.values())
            this._account_limits.set(
                route.account_ref,
                Math.min(this._account_limits.get(route.account_ref) ?? 500, route.account_concurrency)
            );
        this._runs.set(id, run);
        this._runtime.set(id, runtime);
        this.update_active_index(run);
        if (!this.persist_safe(run)) {
            this.schedule();
            throw Object.assign(new Error('Bench run persistence failed'), { code: 'EIO' });
        }
        this.schedule();
        return id;
    }
    private build_staged_run(plan: ExecutionPlan, tasks: AssessmentTask[], id: string, task_id?: string): ExecutionRun {
        const budget = new RunBudget(plan.limits, { value: false }),
            samples: ExecutionSample[] = [];
        for (const target of plan.targets)
            for (let round = 1; round <= plan.rounds; round++)
                for (const task of tasks)
                    samples.push({
                        sample_id: uuid(),
                        attempt_id: uuid(),
                        run_id: id,
                        target_id: target.id,
                        route_id: target.route_id,
                        account_ref: target.account_ref,
                        account_evidence: target.account_evidence,
                        task: task.id,
                        model: target.model,
                        thinking: target.thinking,
                        round,
                        status: 'pending',
                        grade: null
                    });
        return {
            id,
            status: 'queued',
            ...(task_id ? { task_id, execution_kind: 'task-child-v1' } : {}),
            created_at: now(),
            updated_at: now(),
            plan,
            samples,
            budget: budget.snapshot(),
            stop_reason: null
        };
    }
    private build_runtime(run: ExecutionRun, bindings: Map<string, ExecutionRoute>, taskMap: Map<string, AssessmentTask>): RunRuntime {
        const cancel = { value: false },
            budget = new RunBudget(run.plan.limits, cancel);
        return {
            bindings,
            tasks: taskMap,
            targets: new Map(run.plan.targets.map(target => [target.id, target])),
            cancel,
            budget,
            active: 0,
            target_active: new Set(),
            last_target_id: null,
            journal: new SessionJournal(
                this.db,
                run.id,
                [...bindings.values()].flatMap(route => [route.api_key, route.base_url.replace(/\/+$/, ''), route.api_key_env ?? ''])
            ),
            dirty: false,
            dirty_samples: new Set(),
            fast_fail: new Map()
        };
    }
    private stage_run(
        prepared: Awaited<ReturnType<BenchExecutionService['prepare']>>,
        id: string,
        task_id?: string,
        sharedTaskMap?: Map<string, AssessmentTask>
    ): { run: ExecutionRun; runtime: RunRuntime } {
        const { plan, tasks, bindings } = prepared;
        const run = this.build_staged_run(plan, tasks, id, task_id);
        const runtime = this.build_runtime(run, bindings, sharedTaskMap ?? new Map(tasks.map(task => [task.id, task])));
        return { run, runtime };
    }
    _persist(run: ExecutionRun, dirtySampleIds?: ReadonlySet<string>, precomputed?: PrecomputedPlanSnapshots): void {
        run.updated_at = now();
        const runtime = this._runtime.get(run.id);
        if (runtime) run.budget = runtime.budget.snapshot();
        this.db.save_run(run, dirtySampleIds, precomputed);
        if (this._runs.has(run.id)) this.update_active_index(run);
        else if (this._run_index.has(run.id)) this.finalize_indexed_run(run);
        this._revision++;
    }
    private finalize_indexed_run(run: ExecutionRun, sharedContext?: AssessmentSourceContext, sharedSourceDigest?: string): void {
        const context = sharedContext ?? create_assessment_source_context();
        const sourceSig = assessment_source_signature();
        const sourceDigest = sharedSourceDigest ?? assessment_source_digest(context);
        this._cached_source_sig = sourceSig;
        this._cached_source_digest = sourceDigest;
        const existing = this._run_index.get(run.id);
        const indexed = this.index_run(run, context, existing?.legacy_overlay);
        this._run_index.set(run.id, indexed);
        this.db.forget_run_snapshot_hashes(run.id);
        if (TERMINAL_RUN_STATUSES.has(run.status) && !this.db.is_closed) {
            try {
                this.db.save_run_index_cache(this.to_cache_entry(indexed, sourceDigest));
            } catch {
                /* Index cache is an optimization; primary run state is already committed. */
            }
        }
    }
    private fail_storage(): void {
        this._closing = true;
        for (const task of this._tasks.values()) {
            if (!TERMINAL_RUN_STATUSES.has(task.status)) task.stop_reason = 'storage_error';
        }
        for (const [id, runtime] of this._runtime) {
            runtime.cancel.value = true;
            const run = this._runs.get(id)!;
            run.stop_reason = 'storage_error';
            if (!runtime.active) run.status = 'failed';
            for (const sample of run.samples) if (sample.status === 'pending') sample.status = 'storage_error';
            this.update_active_index(run);
        }
        for (const [taskId, queued] of this.task_queued_children) {
            for (const childId of queued.keys()) {
                this.queued_child_task.delete(childId);
                const indexed = this._run_index.get(childId);
                if (indexed) {
                    indexed.status = 'failed';
                    indexed.stop_reason = 'storage_error';
                    indexed.summary.status = 'failed';
                    indexed.summary.stop_reason = 'storage_error';
                    try {
                        const parsed = JSON.parse(indexed.observations_json) as AssessmentObservation[];
                        for (const obs of parsed) obs.status = 'failed';
                        indexed.observations_json = JSON.stringify(parsed);
                    } catch {
                        indexed.observations_json = '[]';
                    }
                }
                for (const done of this.waiters.get(childId) ?? []) done();
                this.waiters.delete(childId);
            }
            const task = this._tasks.get(taskId);
            if (task && !TERMINAL_RUN_STATUSES.has(task.status) && (this.task_active_runs.get(taskId)?.size ?? 0) === 0) {
                task.status = 'failed';
                task.stop_reason = 'storage_error';
            }
        }
        this.task_queued_children.clear();
        this._revision++;
        this.schedule();
    }
    private persist_safe(run: ExecutionRun, dirtySampleIds?: ReadonlySet<string>): boolean {
        try {
            this._persist(run, dirtySampleIds);
            return true;
        } catch {
            this.fail_storage();
            return false;
        }
    }
    /** Return cache validation metadata for immutable terminal runs currently backed by SQLite. */
    get_run_cache_key(id: string): { status: string; updated_at: string } | null {
        if (this._runs.has(id)) return null;
        const entry = this._run_index.get(id);
        if (!entry || !TERMINAL_RUN_STATUSES.has(entry.status)) return null;
        return { status: entry.status, updated_at: entry.updated_at };
    }
    get_run(id: string, options?: { omit_provenance?: boolean }): ExecutionRun | null {
        const omitProvenance = Boolean(options?.omit_provenance);
        const active = this._runs.get(id);
        if (active) {
            const result = omitProvenance ? slim_run_snapshot(active) : clone(active),
                runtime = this._runtime.get(id);
            if (runtime) result.budget = runtime.budget.snapshot();
            result.retryable_samples = execution_retryable_samples(active);
            return result;
        }
        if (!this._run_index.has(id)) return null;
        const run = this.load_run_from_db(id, !omitProvenance);
        if (!run) return null;
        run.retryable_samples = execution_retryable_samples(run);
        return run;
    }
    /** Full cloned evidence for callers that inspect complete runs; analysis uses list_observations. */
    list_run_snapshots(): ExecutionRun[] {
        return [...this._run_index.keys()].reverse().map(id => this.get_run(id)!);
    }
    ensure_source_index(
        context: AssessmentSourceContext = create_assessment_source_context(),
        source_sig = assessment_source_signature()
    ): void {
        if (source_sig === this._cached_source_sig) return;
        this._cached_source_sig = source_sig;
        const nextDigest = assessment_source_digest(context);
        if (nextDigest === this._cached_source_digest) return;
        this._cached_source_digest = nextDigest;
        const cacheUpdates: RunIndexCacheEntry[] = [];
        for (const [id, entry] of this._run_index) {
            if (this._runs.has(id) || this.queued_child_task.has(id)) continue;
            const run = this.load_run_from_db(id);
            if (!run) continue;
            const refreshed = this.index_run(run, context, entry.legacy_overlay);
            this._run_index.set(id, refreshed);
            if (TERMINAL_RUN_STATUSES.has(run.status)) cacheUpdates.push(this.to_cache_entry(refreshed, nextDigest));
        }
        if (cacheUpdates.length && !this.db.is_closed) {
            try {
                this.db.save_run_index_cache_batch(cacheUpdates);
            } catch {
                /* Best-effort cache refresh. */
            }
        }
    }
    /** Read cached per-target baseline eligibility without cloning or querying SQLite. */
    get_run_baseline_targets(
        id: string,
        context?: AssessmentSourceContext,
        source_sig?: string
    ): Array<{ target_id: string; baseline_eligible: boolean; ineligibility_reason: string | null }> {
        const active = this._runs.get(id);
        if (active) {
            return (active.plan.targets ?? []).map(target => ({
                target_id: String(target.id ?? ''),
                baseline_eligible: false,
                ineligibility_reason: 'Assessment baseline: run must be completed'
            }));
        }
        if (source_sig !== undefined) this.ensure_source_index(context, source_sig);
        const entry = this._run_index.get(id);
        if (!entry) return [];
        return entry.baseline_targets.map(item => ({ ...item }));
    }
    /** Return cached terminal observations plus live projections for active runs without loading terminal runs from SQLite. */
    list_observations(
        context: AssessmentSourceContext = create_assessment_source_context(),
        source_sig = assessment_source_signature()
    ): AssessmentObservation[] {
        this.ensure_source_index(context, source_sig);
        const result: AssessmentObservation[] = [];
        for (const id of [...this._run_index.keys()].reverse()) {
            const active = this._runs.get(id);
            if (active) result.push(...project_run_observations(active, context));
            else result.push(...(JSON.parse(this._run_index.get(id)!.observations_json) as AssessmentObservation[]));
        }
        return result;
    }
    /** Return pre-serialized observation JSON fragments, reusing cached JSON for terminal and lazy-queued runs. */
    serialize_observation_chunks(
        context: AssessmentSourceContext = create_assessment_source_context(),
        source_sig = assessment_source_signature()
    ): string[] {
        this.ensure_source_index(context, source_sig);
        const chunks: string[] = [];
        for (const id of [...this._run_index.keys()].reverse()) {
            const active = this._runs.get(id);
            if (active) {
                const raw = JSON.stringify(project_run_observations(active, context));
                if (raw.length > 2) chunks.push(raw.slice(1, -1));
                continue;
            }
            const raw = this._run_index.get(id)!.observations_json;
            if (raw.length > 2) chunks.push(raw.slice(1, -1));
        }
        return chunks;
    }
    list_runs(): RecordValue[] {
        return [...this._run_index.keys()].reverse().map(id => this.run_summary(id));
    }
    /** Serialize run summaries directly for HTTP caches without cloning every historical record. */
    serialize_runs_payload(enrichRun?: (run: RecordValue) => RecordValue): string {
        const runs = [...this._run_index.keys()].reverse().map(id => {
            const summary = this.run_summary(id, false);
            return enrichRun ? enrichRun(summary) : summary;
        });
        return JSON.stringify({ runs });
    }
    /** Batch retries reuse one idempotency key and report partial publication without resending successes. */
    async retry_task(id: string, request_id: string): Promise<{ ids: string[]; rejected: string[] }> {
        const task = this._tasks.get(id);
        if (!task || !/^[a-f0-9]{32}$/.test(request_id)) throw new TypeError('Invalid task or retry request_id');
        const ids: string[] = [],
            rejected: string[] = [];
        for (const child of task.child_run_ids) {
            const indexed = this._run_index.get(child);
            if (indexed && !this._runs.has(child)) {
                const retryable = Number(indexed.summary.retryable_samples ?? 0);
                if (
                    !(retryable > 0 && TERMINAL_RUN_STATUSES.has(indexed.status)) &&
                    !this.with_db_read(db => db.has_retry_batch(child, request_id))
                )
                    continue;
            } else {
                const run = this.get_run(child, { omit_provenance: true })!;
                if (
                    !(Number(run.retryable_samples) > 0 && TERMINAL_RUN_STATUSES.has(run.status)) &&
                    !(
                        Array.isArray(run.retry_batches) &&
                        (run.retry_batches as RecordValue[]).some(batch => batch.request_id === request_id)
                    )
                )
                    continue;
            }
            try {
                ids.push(await this.retry_run(child, request_id));
            } catch {
                rejected.push(child);
            }
        }
        return { ids, rejected };
    }
    /** Explicitly retry API-failed samples, retaining successes and immutable prior evidence. */
    async retry_run(id: string, request_id: string, policy?: 'sample-timeout-v1'): Promise<string> {
        if (policy !== undefined && policy !== 'sample-timeout-v1') throw new TypeError('Unknown rerun policy');
        const indexed = this._run_index.get(id);
        if ((this._runs.get(id)?.execution_kind ?? indexed?.execution_kind) === 'calibration-import-v1')
            throw new TypeError('Imported calibration runs are read-only and cannot be retried');
        if (!/^[a-f0-9]{32}$/.test(request_id)) throw new TypeError('retry request_id must be 32 lowercase hex characters');
        if (!this.has_run(id)) throw new TypeError('Run not found');
        const loaded = this._runs.get(id) ?? this.load_run_from_db(id);
        if (!loaded) throw new TypeError('Run not found');
        const batches = Array.isArray(loaded.retry_batches) ? (loaded.retry_batches as RecordValue[]) : [];
        const existingBatch = batches.find(batch => batch.request_id === request_id);
        if (existingBatch) {
            if (existingBatch.policy !== policy) throw new TypeError('Retry request_id policy mismatch');
            return id;
        }
        if (this._closing || this._runtime.has(id) || !TERMINAL_RUN_STATUSES.has(loaded.status))
            throw new TypeError('Run is still active or service unavailable');
        const eligible = loaded.samples.filter(sample =>
            policy === 'sample-timeout-v1' ? sample.status !== 'completed' : is_retryable_sample(sample, loaded.stop_reason)
        );
        if (!eligible.length)
            throw new TypeError(policy ? 'No unfinished samples to rerun' : 'No API-failed or anomalous samples to retry');
        const latestLimits = batches.at(-1)?.limits;
        const retryLimits = policy ? clone(DEFAULT_LIMITS) : object(latestLimits) ? (latestLimits as Limits) : loaded.plan.limits;
        const prepared = await this.prepare(
            {
                bank_version: loaded.plan.bank_version,
                targets: loaded.plan.targets.map(target => ({ id: target.id, route_id: target.route_id, thinking: target.thinking })),
                task_ids: loaded.plan.task_ids,
                rounds: loaded.plan.rounds,
                concurrency: loaded.task_id ? loaded.plan.concurrency : Math.min(loaded.plan.concurrency, this.concurrency),
                limits: retryLimits
            },
            loaded.task_id ? 'task' : 'run'
        );
        // A second request may have arrived while route discovery was awaiting I/O.
        const run = this._runs.get(id) ?? this.load_run_from_db(id);
        if (!run) throw new TypeError('Run not found');
        const currentBatches = Array.isArray(run.retry_batches) ? (run.retry_batches as RecordValue[]) : [];
        const publishedBatch = currentBatches.find(batch => batch.request_id === request_id);
        if (publishedBatch) {
            if (publishedBatch.policy !== policy) throw new TypeError('Retry request_id policy mismatch');
            return id;
        }
        if (this._closing || this._runtime.has(id) || !TERMINAL_RUN_STATUSES.has(run.status))
            throw new TypeError('Run retry already active or service closing');
        const currentEligible = run.samples.filter(sample =>
            policy === 'sample-timeout-v1' ? sample.status !== 'completed' : is_retryable_sample(sample, run.stop_reason)
        );
        if (!currentEligible.length)
            throw new TypeError(policy ? 'No unfinished samples to rerun' : 'No API-failed or anomalous samples to retry');
        for (const target of run.plan.targets) {
            const current = prepared.plan.targets.find(value => value.id === target.id)!;
            for (const key of [
                'route_id',
                'model',
                'thinking',
                'account_ref',
                'account_evidence',
                'binding_ref',
                'provider_id',
                'remote_route',
                'pricing'
            ] as const)
                if (canonicalStorageJson(current[key] ?? null) !== canonicalStorageJson(target[key] ?? null))
                    throw new TypeError('Retry route identity or price changed; copy configuration to a new task instead');
        }
        const cancel = { value: false },
            budget = new RunBudget(retryLimits, cancel);
        budget.requests = Number(run.budget.requests ?? 0);
        budget.spent = Number(run.budget.known_cost_lower_bound_usd ?? 0);
        budget.missing_cost = Number(run.budget.missing_cost_calls ?? 0);
        budget.uncertain_cost = Number(run.budget.uncertain_cost_reservation_usd ?? 0);
        if (run.budget.uncertain_cost_reservation_usd === undefined && budget.missing_cost) {
            throw new TypeError('Missing request evidence for retry cost accounting');
        }
        if (budget.requests >= budget.request_limit || budget.spent + budget.uncertain_cost >= budget.cost_limit)
            throw new TypeError('Original execution limit exhausted; copy configuration to a new task with adjusted limits');
        let journal: SessionJournal | undefined;
        try {
            journal = new SessionJournal(
                this.db,
                id,
                [...prepared.bindings.values()].flatMap(route => [
                    route.api_key,
                    route.base_url.replace(/\/+$/, ''),
                    route.api_key_env ?? ''
                ])
            );
            for (const sample of currentEligible) {
                const { attempts, ...previous } = clone(sample);
                const history = [...(Array.isArray(attempts) ? attempts : []), previous];
                for (const key of [
                    'calls',
                    'usage',
                    'estimated_uncached_cost_usd',
                    'latest_attempt_usage',
                    'latest_attempt_cost_usd',
                    'usage_incomplete',
                    'answer_submission',
                    'api_request_count',
                    'last_http_status',
                    'elapsed_seconds',
                    'text',
                    'tool_trace',
                    'started_at',
                    'finished_at',
                    'runner_error'
                ])
                    delete sample[key];
                Object.assign(sample, {
                    status: 'pending',
                    grade: null,
                    ok: false,
                    attempt_id: uuid(),
                    attempts: history,
                    retry_source_sha256: prepared.plan.source_sha256,
                    retry_limits: clone(retryLimits)
                });
            }
            run.retry_batches = [
                ...currentBatches,
                {
                    request_id,
                    sample_ids: currentEligible.map(sample => sample.sample_id),
                    source_sha256: prepared.plan.source_sha256,
                    limits: clone(retryLimits),
                    ...(policy ? { policy } : {}),
                    created_at: now()
                }
            ];
            run.status = 'queued';
            run.stop_reason = null;
            const runtime: RunRuntime = {
                bindings: prepared.bindings,
                tasks: new Map(prepared.tasks.map(task => [task.id, task])),
                targets: new Map(run.plan.targets.map(target => [target.id, target])),
                cancel,
                budget,
                active: 0,
                target_active: new Set(),
                last_target_id: null,
                journal,
                dirty: false,
                dirty_samples: new Set(),
                fast_fail: new Map()
            };
            run.budget = budget.snapshot();
            this._runs.set(id, run);
            this._persist(run);
            if (typeof run.task_id === 'string') {
                const task = this.slim_tasks.has(run.task_id) ? this.load_full_task_from_db(run.task_id) : this._tasks.get(run.task_id)!;
                const anyActive = task.child_run_ids.some(childId => {
                    const childStatus = this.run_status(childId);
                    return childStatus === 'running' || childStatus === 'cancelling';
                });
                task.status = anyActive ? 'running' : 'queued';
                task.stop_reason = null;
                this._persist_task(task);
                this._tasks.set(run.task_id, slim_task_state(task));
                this.slim_tasks.add(run.task_id);
                if (!this.task_active_runs.has(task.id)) this.task_active_runs.set(task.id, new Set());
            }
            this._runtime.set(id, runtime);
            this.update_active_index(run);
            // An explicit manual retry is the user's decision to try the route again.
            for (const target of run.plan.targets) this.route_blocks.delete(target.route_id);
            for (const route of prepared.bindings.values())
                this._account_limits.set(
                    route.account_ref,
                    Math.min(this._account_limits.get(route.account_ref) ?? 500, route.account_concurrency)
                );
            this.schedule();
            return id;
        } catch (error) {
            journal?.close();
            if (indexed) this._run_index.set(id, indexed);
            this._runs.delete(id);
            this.fail_storage();
            throw error;
        }
    }
    cancel_run(id: string): boolean {
        const queuedTaskId = this.queued_child_task.get(id);
        if (queuedTaskId) {
            this.cancel_queued_children(queuedTaskId, [id]);
            this.update_task(queuedTaskId);
            this.schedule();
            return true;
        }
        const run = this._runs.get(id);
        if (!run) return this._run_index.has(id);
        if (!TERMINAL_RUN_STATUSES.has(run.status)) {
            const runtime = this._runtime.get(id)!;
            runtime.cancel.value = true;
            run.status = 'cancelling';
            runtime.dirty = false;
            this.persist_safe(run);
            this.schedule();
        }
        return true;
    }
    private cancel_queued_children(taskId: string, childIds: string[], blockReason?: string): void {
        const queued = this.task_queued_children.get(taskId);
        if (!queued || !childIds.length) return;
        const toProcess: string[] = [];
        for (const childId of childIds) {
            if (!queued.has(childId)) continue;
            queued.delete(childId);
            this.queued_child_task.delete(childId);
            toProcess.push(childId);
        }
        if (queued.size === 0) this.task_queued_children.delete(taskId);
        if (!toProcess.length) return;
        const context = create_assessment_source_context();
        const sourceDigest = assessment_source_digest(context);
        const cacheEntries: RunIndexCacheEntry[] = [];
        const sampleStatus = blockReason ? 'budget_not_admitted' : 'cancelled';
        try {
            this.db.run_in_transaction(() => {
                for (const childId of toProcess) {
                    const precomputed = this.db.get_run_snapshot_hashes(childId);
                    const run = this.load_run_from_db(childId, !precomputed);
                    if (!run) continue;
                    for (const sample of run.samples) {
                        if (sample.status === 'pending') sample.status = sampleStatus;
                    }
                    run.status = terminal_run_status(run.samples, run.stop_reason, !blockReason);
                    run.stop_reason = blockReason ?? 'cancelled';
                    run.updated_at = now();
                    this.db.save_run(run, undefined, precomputed ?? undefined);
                    const existing = this._run_index.get(childId);
                    let indexed: IndexedRun;
                    if (precomputed && existing) {
                        const observations = JSON.parse(existing.observations_json) as AssessmentObservation[];
                        for (const obs of observations) {
                            obs.status = run.status;
                            if (Array.isArray(obs.tasks)) {
                                for (const taskEntry of obs.tasks) {
                                    if (!Array.isArray(taskEntry.samples)) continue;
                                    for (const s of taskEntry.samples) {
                                        if (s.status === 'pending') s.status = sampleStatus;
                                    }
                                }
                            }
                        }
                        indexed = {
                            ...existing,
                            status: run.status,
                            stop_reason: run.stop_reason,
                            updated_at: run.updated_at,
                            summary: execution_run_summary(run),
                            observations_json: JSON.stringify(observations),
                            baseline_targets: summarize_baseline_targets(observations)
                        };
                    } else {
                        indexed = this.index_run(run, context, existing?.legacy_overlay);
                    }
                    this._run_index.set(childId, indexed);
                    this.db.forget_run_snapshot_hashes(childId);
                    if (TERMINAL_RUN_STATUSES.has(run.status)) cacheEntries.push(this.to_cache_entry(indexed, sourceDigest));
                }
                if (cacheEntries.length) this.db.save_run_index_cache_batch(cacheEntries);
            });
            this._revision++;
        } catch {
            this.fail_storage();
        }
        for (const childId of toProcess) {
            for (const done of this.waiters.get(childId) ?? []) done();
            this.waiters.delete(childId);
        }
    }
    private hydrate_queued_child(taskId: string, childId: string): boolean {
        const queued = this.task_queued_children.get(taskId);
        const entry = queued?.get(childId);
        if (!queued || !entry) return false;
        queued.delete(childId);
        this.queued_child_task.delete(childId);
        if (queued.size === 0) this.task_queued_children.delete(taskId);
        let run: ExecutionRun | null;
        try {
            run = this.load_run_from_db(childId, true);
        } catch {
            this.fail_storage();
            return false;
        }
        if (!run) {
            this.fail_storage();
            return false;
        }
        const runtime = this.build_runtime(run, new Map([[entry.target.id, entry.route]]), entry.tasks);
        this._runs.set(childId, run);
        this._runtime.set(childId, runtime);
        return true;
    }
    private promote_queued_task_children(): boolean {
        if (!this.task_queued_children.size) return false;
        let changed = false;
        for (const [taskId, queued] of [...this.task_queued_children]) {
            const parent = this._tasks.get(taskId);
            const activeChildren = this.task_active_runs.get(taskId);
            if (!parent || !activeChildren) continue;
            // Immediately fast-fail any queued child whose route is blocked.
            const blockedByReason = new Map<string, string[]>();
            for (const [childId, entry] of queued) {
                const blocked = this.route_block(entry.target.route_id);
                if (blocked) {
                    const list = blockedByReason.get(blocked) ?? [];
                    list.push(childId);
                    blockedByReason.set(blocked, list);
                }
            }
            if (blockedByReason.size) {
                for (const [reason, ids] of blockedByReason) this.cancel_queued_children(taskId, ids, reason);
                this.update_task(taskId);
                changed = true;
            }
            if (this._closing || TERMINAL_RUN_STATUSES.has(parent.status) || parent.stop_reason === 'cancelled') continue;
            while (activeChildren.size < parent.plan.run_concurrency) {
                const currentQueued = this.task_queued_children.get(taskId);
                if (!currentQueued || currentQueued.size === 0) break;
                const nextId = this.next_task_child_to_admit(parent, activeChildren);
                if (!nextId) break;
                if (this._runtime.has(nextId)) break; // Already hydrated; dispatch loop will admit it.
                if (!this.hydrate_queued_child(taskId, nextId)) break;
                changed = true;
                break; // Admit one child per pass so activeChildren updates accurately.
            }
        }
        return changed;
    }
    async wait_for_run(id: string, timeout?: number): Promise<boolean> {
        if (!this.has_run(id)) return false;
        if (TERMINAL_RUN_STATUSES.has(this.run_status(id)!) && !this._runtime.has(id)) return true;
        return new Promise(resolve => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const done = () => {
                if (timer) clearTimeout(timer);
                this.waiters.get(id)?.delete(done);
                resolve(true);
            };
            if (!this.waiters.has(id)) this.waiters.set(id, new Set());
            this.waiters.get(id)!.add(done);
            if (timeout !== undefined)
                timer = setTimeout(() => {
                    this.waiters.get(id)?.delete(done);
                    resolve(false);
                }, timeout * 1000);
        });
    }
    async wait_run(id: string, timeout?: number): Promise<ExecutionRun | null> {
        if (!this.has_run(id)) return null;
        if (!(await this.wait_for_run(id, timeout))) throw new Error('Bench run is still active');
        return this.get_run(id);
    }
    private schedule(): void {
        if (this.scheduled) return;
        this.scheduled = true;
        setImmediate(() => {
            this.scheduled = false;
            this.dispatch();
        });
    }
    private rotate<T>(values: T[], last: T | null): T[] {
        const pivot = last === null ? -1 : values.indexOf(last);
        return pivot < 0 ? values : [...values.slice(pivot + 1), ...values.slice(0, pivot + 1)];
    }
    private target_channel_key(target: ExecutionTarget): string {
        return target.remote_route
            ? `${target.provider_id ?? ''}\u0000${target.remote_route.namespace}`
            : (target.provider_id ?? target.account_ref ?? target.route_id);
    }
    /** Interleave child runs across channels and models so concurrent slots do not bunch on one channel's Thinking levels. */
    private task_interleaved_children(task: ExecutionTaskState): string[] {
        const channels = new Map<string, { routes: Map<string, string[]>; order: string[]; cursor: number }>();
        for (const childId of task.child_run_ids) {
            const target = this._runs.get(childId)?.plan.targets[0] ?? this._run_index.get(childId)?.summary.targets[0];
            if (!target) continue;
            const channelKey = this.target_channel_key(target);
            let channel = channels.get(channelKey);
            if (!channel) {
                channel = { routes: new Map(), order: [], cursor: 0 };
                channels.set(channelKey, channel);
            }
            let queue = channel.routes.get(target.route_id);
            if (!queue) {
                queue = [];
                channel.routes.set(target.route_id, queue);
                channel.order.push(target.route_id);
            }
            queue.push(childId);
        }
        const interleaved: string[] = [];
        let remaining = true;
        while (remaining) {
            remaining = false;
            for (const channel of channels.values()) {
                for (let checked = 0; checked < channel.order.length; checked++) {
                    const routeId = channel.order[(channel.cursor + checked) % channel.order.length]!;
                    const queue = channel.routes.get(routeId)!;
                    if (queue.length) {
                        interleaved.push(queue.shift()!);
                        channel.cursor = (channel.cursor + checked + 1) % channel.order.length;
                        remaining = true;
                        break;
                    }
                }
            }
        }
        return interleaved;
    }
    private next_task_child_to_admit(task: ExecutionTaskState, activeChildren: Set<string>): string | null {
        const channelCounts = new Map<string, number>(),
            routeCounts = new Map<string, number>();
        for (const activeId of activeChildren) {
            const target = this._runs.get(activeId)?.plan.targets[0] ?? this._run_index.get(activeId)?.summary.targets[0];
            if (!target) continue;
            const channelKey = this.target_channel_key(target);
            channelCounts.set(channelKey, (channelCounts.get(channelKey) ?? 0) + 1);
            routeCounts.set(target.route_id, (routeCounts.get(target.route_id) ?? 0) + 1);
        }
        let baseOrder = this.task_interleaved_order.get(task.id);
        if (!baseOrder) {
            baseOrder = this.task_interleaved_children(task);
            this.task_interleaved_order.set(task.id, baseOrder);
        }
        const order = this.rotate(baseOrder, this.task_last_admitted_run.get(task.id) ?? null);
        const queued = this.task_queued_children.get(task.id);
        let best: string | null = null,
            bestChannelCount = Infinity,
            bestRouteCount = Infinity;
        for (const childId of order) {
            if (activeChildren.has(childId)) continue;
            let target: ExecutionTarget | undefined;
            const runtime = this._runtime.get(childId),
                run = this._runs.get(childId);
            if (runtime && run) {
                if (runtime.cancel.value || runtime.budget.stop_reason) continue;
                if (!run.samples.some(sample => sample.status === 'pending' && !this.route_block(sample.route_id))) continue;
                target = run.plan.targets[0];
            } else {
                const queuedEntry = queued?.get(childId);
                if (!queuedEntry || this.route_block(queuedEntry.target.route_id)) continue;
                target = queuedEntry.target;
            }
            if (!target) continue;
            const channelCount = channelCounts.get(this.target_channel_key(target)) ?? 0;
            const routeCount = routeCounts.get(target.route_id) ?? 0;
            if (channelCount < bestChannelCount || (channelCount === bestChannelCount && routeCount < bestRouteCount)) {
                best = childId;
                bestChannelCount = channelCount;
                bestRouteCount = routeCount;
                if (bestChannelCount === 0 && bestRouteCount === 0) break;
            }
        }
        return best;
    }
    private dispatch(): void {
        let dispatched: boolean;
        do {
            dispatched = this.promote_queued_task_children();
            for (const id of this.rotate([...this._runtime.keys()], this.last_run_id)) {
                const runtime = this._runtime.get(id)!,
                    run = this._runs.get(id)!;
                const cancelled = runtime.cancel.value,
                    stop = runtime.budget.stop_reason;
                for (const sample of run.samples) {
                    if (sample.status !== 'pending') continue;
                    const blocked = cancelled || stop ? null : this.route_block(sample.route_id);
                    if (blocked) runtime.fast_fail.set(sample.route_id, blocked);
                    if (cancelled || stop || blocked) {
                        sample.status = cancelled ? 'cancelled' : 'budget_not_admitted';
                        runtime.dirty = true;
                        runtime.dirty_samples.add(sample.sample_id);
                    }
                }
                const fastFail = runtime.fast_fail.size ? runtime.fast_fail.values().next().value! : null;
                const pending = run.samples.filter(sample => sample.status === 'pending');
                if (!pending.length && !runtime.active) {
                    run.status = terminal_run_status(run.samples, run.stop_reason, cancelled);
                    if (run.stop_reason !== 'storage_error')
                        run.stop_reason = cancelled
                            ? 'cancelled'
                            : run.status === 'completed'
                              ? null
                              : stop ||
                                fastFail ||
                                (run.status === 'failed' ? 'api_failure' : run.status === 'incomplete' ? 'capability_or_limit' : null);
                    runtime.dirty = false;
                    runtime.dirty_samples.clear();
                    let persisted = this.persist_safe(run);
                    try {
                        runtime.journal.close();
                    } catch {
                        this.fail_storage();
                        persisted = this.persist_safe(run);
                    }
                    this._runtime.delete(id);
                    this.finalize_indexed_run(run);
                    if (persisted && run.stop_reason !== 'storage_error') this._runs.delete(id);
                    this._revision++;
                    dispatched = true; // Reconsider queued siblings after this child releases a task slot.
                    if (typeof run.task_id === 'string') {
                        this.task_active_runs.get(run.task_id)?.delete(id);
                        this.update_task(run.task_id);
                    }
                    for (const done of this.waiters.get(id) ?? []) done();
                    this.waiters.delete(id);
                    continue;
                }
                const flushDirty = () => {
                    runtime.dirty = false;
                    const dirtyIds = runtime.dirty_samples.size ? new Set(runtime.dirty_samples) : undefined;
                    runtime.dirty_samples.clear();
                    this.persist_safe(run, dirtyIds);
                };
                if (!pending.length) {
                    if (runtime.dirty) flushDirty();
                    continue;
                }
                const taskId = typeof run.task_id === 'string' ? run.task_id : null;
                const parent = taskId ? this._tasks.get(taskId) : null;
                const activeChildren = taskId ? this.task_active_runs.get(taskId) : null;
                const taskChild = run.execution_kind === 'task-child-v1' && !!parent && !!activeChildren;
                if (taskChild && !activeChildren.has(id)) {
                    if (
                        activeChildren.size >= parent.plan.run_concurrency ||
                        this.next_task_child_to_admit(parent, activeChildren) !== id
                    ) {
                        if (runtime.dirty) flushDirty();
                        continue;
                    }
                }
                if (taskChild) {
                    const slots = run.plan.concurrency - runtime.active;
                    if (slots <= 0) {
                        if (runtime.dirty) flushDirty();
                        continue;
                    }
                    const batch = pending.slice(0, slots);
                    const startedAt = now();
                    const dirtyBatch = new Set(runtime.dirty_samples);
                    for (const sample of batch) {
                        sample.status = 'running';
                        sample.started_at = startedAt;
                        dirtyBatch.add(sample.sample_id);
                    }
                    run.status = 'running';
                    runtime.dirty = false;
                    runtime.dirty_samples.clear();
                    if (!this.persist_safe(run, dirtyBatch)) {
                        for (const sample of batch) sample.status = 'storage_error';
                        continue;
                    }
                    if (!activeChildren.has(id)) this.task_last_admitted_run.set(taskId!, id);
                    activeChildren.add(id);
                    this.update_task(taskId!);
                    if (this._closing) {
                        for (const sample of batch) sample.status = 'storage_error';
                        continue;
                    }
                    for (const sample of batch) {
                        const account = runtime.bindings.get(sample.target_id)!.account_ref;
                        runtime.active++;
                        runtime.last_target_id = sample.target_id;
                        this.last_run_id = id;
                        this._active++;
                        this._account_active.set(account, (this._account_active.get(account) ?? 0) + 1);
                        void this.execute(run, runtime, this.sample_dispatch(sample)).then(
                            observation => this.complete(id, sample.sample_id, account, observation),
                            error => this.complete(id, sample.sample_id, account, null, error)
                        );
                    }
                    dispatched = true;
                    continue;
                }
                const targetOrder = this.rotate([...runtime.targets.keys()], runtime.last_target_id);
                pending.sort((a, b) => targetOrder.indexOf(a.target_id) - targetOrder.indexOf(b.target_id));
                let admittedDirect = false;
                for (const sample of pending) {
                    if (this._active >= this.concurrency || runtime.active >= run.plan.concurrency) break;
                    const account = runtime.bindings.get(sample.target_id)!.account_ref;
                    if (
                        runtime.target_active.has(sample.target_id) ||
                        (this._account_active.get(account) ?? 0) >= this._account_limits.get(account)!
                    )
                        continue;
                    sample.status = 'running';
                    sample.started_at = now();
                    run.status = 'running';
                    const dirtyDirect = new Set(runtime.dirty_samples);
                    dirtyDirect.add(sample.sample_id);
                    runtime.dirty = false;
                    runtime.dirty_samples.clear();
                    if (!this.persist_safe(run, dirtyDirect)) {
                        sample.status = 'storage_error';
                        admittedDirect = true;
                        break;
                    }
                    runtime.active++;
                    runtime.target_active.add(sample.target_id);
                    runtime.last_target_id = sample.target_id;
                    this.last_run_id = id;
                    this._active++;
                    this._account_active.set(account, (this._account_active.get(account) ?? 0) + 1);
                    void this.execute(run, runtime, this.sample_dispatch(sample)).then(
                        observation => this.complete(id, sample.sample_id, account, observation),
                        error => this.complete(id, sample.sample_id, account, null, error)
                    );
                    admittedDirect = true;
                    dispatched = true;
                    break;
                }
                if (!admittedDirect && runtime.dirty) flushDirty();
            }
        } while (dispatched);
    }
    private sample_dispatch(sample: ExecutionSample): SampleDispatch {
        return {
            run_id: sample.run_id,
            sample_id: sample.sample_id,
            attempt_id: sample.attempt_id,
            target_id: sample.target_id,
            route_id: sample.route_id,
            account_ref: sample.account_ref,
            account_evidence: sample.account_evidence,
            task: sample.task,
            round: sample.round,
            ...(object(sample.retry_limits) ? { retry_limits: clone(sample.retry_limits) } : {})
        };
    }
    private async execute(run: ExecutionRun, runtime: RunRuntime, sample: SampleDispatch): Promise<RecordValue | null> {
        const target = runtime.targets.get(sample.target_id)!,
            route = runtime.bindings.get(sample.target_id)!,
            client = this.routes.create_client
                ? this.routes.create_client(clone(route))
                : this.client_factory(route.base_url, route.api_key);
        const identity: Record<string, string> = {};
        for (const key of ['run_id', 'sample_id', 'attempt_id', 'target_id', 'route_id', 'account_ref', 'account_evidence'] as const)
            identity[key] = sample[key];
        const journal = new SampleJournal(runtime.journal, identity, () => this.fail_storage());
        const effectiveLimits = object(sample.retry_limits) ? (sample.retry_limits as Limits) : run.plan.limits;
        const { max_output_tokens, max_turns, max_tool_calls, timeout, timeout_scope } = effectiveLimits;
        const max_api_retries = effectiveLimits.max_api_retries ?? 3;
        await run_assessment_sample(
            client,
            runtime.tasks.get(sample.task)!,
            target,
            sample.round,
            { max_output_tokens, max_turns, max_tool_calls, timeout, max_api_retries, ...(timeout_scope ? { timeout_scope } : {}) },
            route.pricing,
            runtime.budget,
            journal,
            () => runtime.cancel.value,
            this.retry_wait
        );
        return journal.observation;
    }
    private complete(id: string, sample_id: string, account: string, observation: RecordValue | null, error?: unknown): void {
        const run = this._runs.get(id)!,
            runtime = this._runtime.get(id)!,
            sample = run.samples.find(value => value.sample_id === sample_id)!;
        try {
            if (error) throw error;
            if (!observation) throw new TypeError('Missing sample observation');
            if (is_timeout_sample(observation) && !object(observation.usage)) {
                const route = runtime.bindings.get(sample.target_id);
                observation = {
                    ...observation,
                    usage: { input_tokens: 0, output_tokens: 0 },
                    estimated_uncached_cost_usd: route?.pricing === null ? null : 0
                };
            }
            Object.assign(sample, observation, {
                latest_attempt_usage: observation.usage,
                latest_attempt_cost_usd: observation.estimated_uncached_cost_usd
            });
            const fastFail = fast_fail_stop_reason(observation);
            if (fastFail) this.block_route(sample.route_id, fastFail);
        } catch (error) {
            Object.assign(sample, {
                status: 'worker_error',
                runner_error: error instanceof Error ? error.name : 'Error',
                grade: null
            });
            try {
                runtime.journal.write({ type: 'worker_error', ...sample });
            } catch {
                this.fail_storage();
            }
            if (storageError(error)) this.fail_storage();
        } finally {
            sample.finished_at = now();
            runtime.active--;
            runtime.target_active.delete(sample.target_id);
            this._active--;
            this._account_active.set(account, this._account_active.get(account)! - 1);
            runtime.dirty = true;
            runtime.dirty_samples.add(sample_id);
            this.update_active_index(run);
            this._revision++;
            this.schedule();
        }
    }
    /**
     * After a sample exhausts its retries on a route-level rejection (rate limit, auth/quota or missing model),
     * no new sample of that route (same model and account binding) starts in any run or task, including tasks
     * created later; in-flight samples finish normally. The block never expires on its own: the in-sample API
     * retries already absorb transient errors, so it lasts until an explicit manual retry of a run on that
     * route or a service restart.
     */
    private block_route(routeId: string, reason: string): void {
        if (!this.route_blocks.has(routeId)) this.route_blocks.set(routeId, reason);
    }
    /** Active fast-fail block reason for a route, or null if none. */
    private route_block(routeId: string): string | null {
        return this.route_blocks.get(routeId) ?? null;
    }
    async close(wait = true): Promise<void> {
        this._closing = true;
        const ids = [...this._runtime.keys()];
        for (const task of this._tasks.values()) {
            if (!TERMINAL_RUN_STATUSES.has(task.status)) this.cancel_task(task.id);
        }
        for (const runtime of this._runtime.values()) runtime.cancel.value = true;
        this.schedule();
        if (wait) {
            await Promise.all(ids.map(id => this.wait_for_run(id)));
            if (this.owns_db) this.db.close();
        }
    }
}
