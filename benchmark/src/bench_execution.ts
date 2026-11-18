import { PRODUCTION_BANK_VERSION } from './production_bank.ts';
import { run_journal_path, scan_journal_call_records, scan_journal_call_records_async } from './bench_call_summaries.ts';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AssessmentBudget, run_assessment_sample } from './assessment_runner.ts';
import { load_assessment_bank } from './assessment_bank.ts';
import { capture_assessment_sources } from './assessment_provenance.ts';
import { private_directory, save_execution_json, RunJournal, SampleJournal } from './bench_execution_storage.ts';
import { execution_retryable_samples, execution_run_summary, execution_task_summary } from './bench_execution_queries.ts';
export { EXECUTION_SOURCE_PATHS } from './assessment_provenance.ts';
export { private_directory, save_execution_json } from './bench_execution_storage.ts';
import { GatewayClient } from './client.ts';
import { assessmentJsonNumberToken, canonicalAssessmentJson, parseAssessmentJson } from './assessment_json.ts';
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
    pricing: Pricing;
}
/** Both configured and gateway routes can resolve without changing scheduler semantics. */
export interface ExecutionRoutes {
    resolve(id: string): ExecutionRoute | Promise<ExecutionRoute>;
    public_routes(): unknown | Promise<unknown>;
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
    pricing: Pricing;
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
    journal: RunJournal;
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
    override admit(body: Parameters<AssessmentBudget['admit']>[0], pricing: Pricing) {
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
/** Event-driven scheduler serializes admission; only network requests run concurrently. */
export class BenchExecutionService {
    readonly concurrency: number;
    readonly data_dir: string;
    readonly _runs = new Map<string, ExecutionRun>();
    readonly _runtime = new Map<string, RunRuntime>();
    readonly _tasks = new Map<string, ExecutionTaskState>();
    private readonly task_active_runs = new Map<string, Set<string>>();
    readonly _account_active = new Map<string, number>();
    readonly _account_limits = new Map<string, number>();
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
        readonly client_factory: ClientFactory = (base, key) => new GatewayClient(base, key)
    ) {
        this.concurrency = integer(concurrency, 1, 64, 'global concurrency');
        this.data_dir = resolve(data_dir);
        private_directory(this.data_dir);
        this.load_runs();
        this.load_tasks();
    }
    private load_runs(): void {
        for (const name of readdirSync(this.data_dir)) {
            const directory = join(this.data_dir, name);
            if (!/^[a-f0-9]{32}$/.test(name) || lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) continue;
            const path = join(directory, 'run.json');
            if (!existsSync(path)) continue;
            const run = parseAssessmentJson(readFileSync(path, 'utf8')) as ExecutionRun;
            if (!object(run) || run.id !== name || !Array.isArray(run.samples) || !object(run.plan))
                throw new TypeError('Saved bench run identity mismatch');
            if (!TERMINAL_RUN_STATUSES.has(run.status)) {
                run.status = 'interrupted';
                run.updated_at = now();
                run.stop_reason = 'service_restart';
                for (const sample of run.samples) if (['pending', 'running'].includes(sample.status)) sample.status = 'interrupted';
                save_execution_json(path, run);
            }
            // Classify legacy outcomes in memory; never rewrite historical evidence on load.
            // Only legacy response_incomplete_or_error samples need journal evidence; journals can be
            // hundreds of MB, so skip them otherwise and stream only call lines when required.
            if (run.status === 'failed') {
                const calls = new Map<string, RecordValue>();
                const journal = run_journal_path(directory);
                const legacy = run.samples.some(sample => sample.status === 'response_incomplete_or_error');
                if (legacy && journal)
                    scan_journal_call_records(journal, row => {
                        calls.set(String(row.call_id), row);
                    });
                for (const sample of run.samples)
                    if (sample.status === 'response_incomplete_or_error') {
                        const ids = Array.isArray(sample.calls) ? sample.calls : [];
                        const last = calls.get(String(ids.at(-1)));
                        if (last && (last.http_status !== 200 || (object(last.raw_response) && !!last.raw_response.error)))
                            sample.status = 'api_failure';
                        else sample.status = 'incomplete';
                    }
                if (!run.samples.some(sample => ['api_failure', 'worker_error', 'storage_error'].includes(sample.status)))
                    run.status = 'incomplete';
            }
            this._runs.set(name, run);
        }
    }
    private task_path(id: string): string {
        return join(this.data_dir, 'tasks', id, 'task.json');
    }
    private load_tasks(): void {
        const root = join(this.data_dir, 'tasks');
        private_directory(root);
        for (const id of readdirSync(root)) {
            if (!/^[a-f0-9]{32}$/.test(id)) continue;
            const directory = join(root, id);
            if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) continue;
            const path = this.task_path(id);
            if (!existsSync(path)) continue; // Uncommitted staging directory never admits work.
            const task = parseAssessmentJson(readFileSync(path, 'utf8')) as unknown as ExecutionTaskState;
            if (
                !object(task) ||
                task.id !== id ||
                !object(task.plan) ||
                !Array.isArray(task.child_run_ids) ||
                !task.child_run_ids.length ||
                new Set(task.child_run_ids).size !== task.child_run_ids.length ||
                task.child_run_ids.some(child => typeof child !== 'string' || this._runs.get(child)?.task_id !== id)
            )
                throw new TypeError('Saved bench task membership mismatch');
            if (!TERMINAL_RUN_STATUSES.has(task.status)) {
                task.status = 'interrupted';
                task.stop_reason = 'service_restart';
                task.updated_at = now();
                save_execution_json(path, task);
            }
            if (['failed', 'incomplete'].includes(task.status)) {
                const children = task.child_run_ids.map(child => this._runs.get(child)!);
                if (children.every(run => TERMINAL_RUN_STATUSES.has(run.status)) && !children.some(run => run.status === 'failed'))
                    task.status = children.every(run => run.status === 'completed') ? 'completed' : 'incomplete';
            }
            this._tasks.set(id, task);
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
        const staged: Array<{ run: ExecutionRun; runtime: RunRuntime }> = [];
        const task: ExecutionTaskState = {
            id,
            status: 'queued',
            created_at: now(),
            updated_at: now(),
            plan,
            child_run_ids: [],
            stop_reason: null
        };
        try {
            private_directory(dirname(this.task_path(id)));
            for (const target of prepared.plan.targets) {
                const childId = uuid();
                const childPlan: ExecutionPlan = {
                    ...clone(prepared.plan),
                    targets: [clone(target)],
                    concurrency: plan.sample_concurrency,
                    sample_count: plan.samples_per_run
                };
                const child = this.stage_run(
                    { ...prepared, plan: childPlan, bindings: new Map([[target.id, prepared.bindings.get(target.id)!]]) },
                    childId,
                    id
                );
                staged.push(child);
                task.child_run_ids.push(childId);
                this._persist(child.run);
            }
            this._persist_task(task); // Commit: no child runtime has been installed yet.
        } catch (error) {
            for (const child of staged) {
                try {
                    child.runtime.journal.close();
                } catch {
                    /* All admissions remain disabled. */
                }
            }
            this.fail_storage();
            throw error;
        }
        this._tasks.set(id, task);
        this.task_active_runs.set(id, new Set());
        for (const { run, runtime } of staged) {
            this._runs.set(run.id, run);
            this._runtime.set(run.id, runtime);
            for (const route of runtime.bindings.values())
                this._account_limits.set(
                    route.account_ref,
                    Math.min(this._account_limits.get(route.account_ref) ?? 500, route.account_concurrency)
                );
        }
        this.schedule();
        return id;
    }
    _persist_task(task: ExecutionTaskState): void {
        task.updated_at = now();
        save_execution_json(this.task_path(task.id), task);
    }
    private update_task(id: string): void {
        const task = this._tasks.get(id);
        if (!task || TERMINAL_RUN_STATUSES.has(task.status)) return;
        const runs = task.child_run_ids.map(child => this._runs.get(child)!);
        const finished = runs.every(run => TERMINAL_RUN_STATUSES.has(run.status));
        const status = finished
            ? task.stop_reason === 'storage_error'
                ? 'failed'
                : task.stop_reason === 'cancelled'
                  ? 'cancelled'
                  : runs.every(run => run.status === 'completed')
                    ? 'completed'
                    : runs.some(run => run.status === 'failed')
                      ? 'failed'
                      : 'incomplete'
            : task.stop_reason === 'cancelled'
              ? 'cancelling'
              : runs.some(run => run.status !== 'queued')
                ? 'running'
                : 'queued';
        if (task.status === status) return;
        task.status = status;
        if (finished && status === 'failed' && !task.stop_reason) task.stop_reason = 'child_failure';
        try {
            this._persist_task(task);
        } catch {
            this.fail_storage();
        }
    }
    /** Task summaries expose child run IDs; raw samples and evidence remain at get_run. */
    get_task(id: string): RecordValue | null {
        const task = this._tasks.get(id);
        if (!task) return null;
        return execution_task_summary(
            task,
            task.child_run_ids.map(run_id => {
                const run = this._runs.get(run_id)!;
                return execution_run_summary(run, this._runtime.get(run_id)?.budget.snapshot());
            })
        );
    }
    /** List independently persisted batches without duplicating raw child evidence. */
    /** History polling omits bulky frozen provenance; get_task keeps the complete plan. */
    list_tasks(): RecordValue[] {
        return [...this._tasks.keys()].reverse().map(id => {
            const task = this.get_task(id)!;
            const { task_snapshots: _snapshots, bank_snapshot: _bank, source_sha256: _sources, ...plan } = task.plan as RecordValue;
            return { ...task, plan: { ...plan, provenance_omitted: true } };
        });
    }
    /** Persist cancellation intent before cancelling any child; never resume queued work. */
    cancel_task(id: string): boolean {
        const task = this._tasks.get(id);
        if (!task) return false;
        if (TERMINAL_RUN_STATUSES.has(task.status)) return true;
        task.status = 'cancelling';
        if (task.stop_reason !== 'storage_error') task.stop_reason = 'cancelled';
        try {
            this._persist_task(task);
        } catch {
            this.fail_storage();
            return true;
        }
        for (const child of task.child_run_ids) this.cancel_run(child);
        this.schedule();
        return true;
    }
    private async prepare(request: unknown, scope: 'run' | 'task' = 'run') {
        const req = knownKeys(request, ['bank_version', 'targets', 'task_ids', 'rounds', 'concurrency', 'limits'], 'request');
        const version = req.bank_version === undefined ? PRODUCTION_BANK_VERSION : req.bank_version;
        if (typeof version !== 'string') throw new TypeError('Invalid bank version');
        const bank = load_assessment_bank(version);
        const rounds = integer(req.rounds === undefined ? 1 : req.rounds, 1, 3, 'rounds', req),
            concurrency = integer(
                req.concurrency === undefined ? this.concurrency : req.concurrency,
                1,
                this.concurrency,
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
            combinations = new Set<string>();
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
            if (bindings.has(id) || combinations.has(combination)) throw new TypeError('Duplicate target id or route/thinking combination');
            const route = clone(await this.routes.resolve(route_id));
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
                !object(pricing) ||
                [pricing.prompt, pricing.completion].some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)
            )
                throw new TypeError('Route token pricing must be finite and nonnegative');
            combinations.add(combination);
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
                pricing: { prompt: pricing.prompt, completion: pricing.completion }
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
        if (!this.persist_safe(run)) {
            this.schedule();
            throw Object.assign(new Error('Bench run persistence failed'), { code: 'EIO' });
        }
        this.schedule();
        return id;
    }
    private stage_run(
        prepared: Awaited<ReturnType<BenchExecutionService['prepare']>>,
        id: string,
        task_id?: string
    ): { run: ExecutionRun; runtime: RunRuntime } {
        const { plan, tasks, bindings, sources } = prepared;
        const directory = join(this.data_dir, id);
        private_directory(directory);
        for (const [source, content] of sources) {
            const destination = join(directory, 'source', source);
            private_directory(dirname(destination));
            const fd = openSync(destination, 'wx', 0o600);
            try {
                writeFileSync(fd, content);
                fsyncSync(fd);
            } finally {
                closeSync(fd);
            }
        }
        const cancel = { value: false },
            budget = new RunBudget(plan.limits, cancel),
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
        const run: ExecutionRun = {
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
        const runtime: RunRuntime = {
            bindings,
            tasks: new Map(tasks.map(task => [task.id, task])),
            targets: new Map(plan.targets.map(target => [target.id, target])),
            cancel,
            budget,
            active: 0,
            target_active: new Set(),
            last_target_id: null,
            journal: new RunJournal(
                join(directory, 'journal.jsonl'),
                [...bindings.values()].flatMap(route => [route.api_key, route.base_url.replace(/\/+$/, ''), route.api_key_env ?? ''])
            )
        };
        return { run, runtime };
    }
    _persist(run: ExecutionRun): void {
        run.updated_at = now();
        const runtime = this._runtime.get(run.id);
        if (runtime) run.budget = runtime.budget.snapshot();
        save_execution_json(join(this.data_dir, run.id, 'run.json'), run);
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
        }
        this.schedule();
    }
    private persist_safe(run: ExecutionRun): boolean {
        try {
            this._persist(run);
            return true;
        } catch {
            this.fail_storage();
            return false;
        }
    }
    get_run(id: string): ExecutionRun | null {
        const run = this._runs.get(id);
        if (!run) return null;
        const result = clone(run),
            runtime = this._runtime.get(id);
        if (runtime) result.budget = runtime.budget.snapshot();
        result.retryable_samples = execution_retryable_samples(run);
        return result;
    }
    /** Full cloned evidence for analysis queries; history polling uses lightweight list_runs. */
    list_run_snapshots(): ExecutionRun[] {
        return [...this._runs.keys()].reverse().map(id => this.get_run(id)!);
    }
    list_runs(): RecordValue[] {
        return [...this._runs.values()].reverse().map(run => execution_run_summary(run, this._runtime.get(run.id)?.budget.snapshot()));
    }
    /** Batch retries reuse one idempotency key and report partial publication without resending successes. */
    async retry_task(id: string, request_id: string): Promise<{ ids: string[]; rejected: string[] }> {
        const task = this._tasks.get(id);
        if (!task || !/^[a-f0-9]{32}$/.test(request_id)) throw new TypeError('Invalid task or retry request_id');
        const ids: string[] = [],
            rejected: string[] = [];
        for (const child of task.child_run_ids) {
            const run = this.get_run(child)!;
            if (
                !(Number(run.retryable_samples) > 0 && TERMINAL_RUN_STATUSES.has(run.status)) &&
                !(Array.isArray(run.retry_batches) && (run.retry_batches as RecordValue[]).some(batch => batch.request_id === request_id))
            )
                continue;
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
        if (this._runs.get(id)?.execution_kind === 'calibration-import-v1')
            throw new TypeError('Imported calibration runs are read-only and cannot be retried');
        if (!/^[a-f0-9]{32}$/.test(request_id)) throw new TypeError('retry request_id must be 32 lowercase hex characters');
        const run = this._runs.get(id);
        if (!run) throw new TypeError('Run not found');
        const batches = Array.isArray(run.retry_batches) ? (run.retry_batches as RecordValue[]) : [];
        const existingBatch = batches.find(batch => batch.request_id === request_id);
        if (existingBatch) {
            if (existingBatch.policy !== policy) throw new TypeError('Retry request_id policy mismatch');
            return id;
        }
        if (this._closing || this._runtime.has(id) || !TERMINAL_RUN_STATUSES.has(run.status))
            throw new TypeError('Run is still active or service unavailable');
        const eligible = run.samples.filter(sample =>
            policy === 'sample-timeout-v1'
                ? sample.status !== 'completed'
                : sample.status === 'api_failure' ||
                  (sample.status === 'budget_not_admitted' && ['transport_failure', 'missing_usage_cost'].includes(run.stop_reason ?? ''))
        );
        if (!eligible.length) throw new TypeError(policy ? 'No unfinished samples to rerun' : 'No API-failed samples to retry');
        const latestLimits = batches.at(-1)?.limits;
        const retryLimits = policy ? clone(DEFAULT_LIMITS) : object(latestLimits) ? (latestLimits as Limits) : run.plan.limits;
        const prepared = await this.prepare(
            {
                bank_version: run.plan.bank_version,
                targets: run.plan.targets.map(target => ({ id: target.id, route_id: target.route_id, thinking: target.thinking })),
                task_ids: run.plan.task_ids,
                rounds: run.plan.rounds,
                concurrency: Math.min(run.plan.concurrency, this.concurrency),
                limits: retryLimits
            },
            run.task_id ? 'task' : 'run'
        );
        // A second request may have arrived while route discovery was awaiting I/O.
        const publishedBatch = Array.isArray(run.retry_batches)
            ? (run.retry_batches as RecordValue[]).find(batch => batch.request_id === request_id)
            : undefined;
        if (publishedBatch) {
            if (publishedBatch.policy !== policy) throw new TypeError('Retry request_id policy mismatch');
            return id;
        }
        if (this._closing || this._runtime.has(id) || !TERMINAL_RUN_STATUSES.has(run.status))
            throw new TypeError('Run retry already active or service closing');
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
                if (canonicalAssessmentJson(current[key] ?? null) !== canonicalAssessmentJson(target[key] ?? null))
                    throw new TypeError('Retry route identity or price changed; copy configuration to a new task instead');
        }
        const cancel = { value: false },
            budget = new RunBudget(retryLimits, cancel);
        budget.requests = Number(run.budget.requests ?? 0);
        budget.spent = Number(run.budget.known_cost_lower_bound_usd ?? 0);
        budget.missing_cost = Number(run.budget.missing_cost_calls ?? 0);
        budget.uncertain_cost = Number(run.budget.uncertain_cost_reservation_usd ?? 0);
        if (run.budget.uncertain_cost_reservation_usd === undefined && budget.missing_cost) {
            let missing = 0;
            // Stream call lines only; strict parsing keeps the original number tokens for reservation bytes.
            const journal = run_journal_path(join(this.data_dir, id));
            if (!journal) throw new TypeError('Missing request evidence for retry cost accounting');
            await scan_journal_call_records_async(
                journal,
                call => {
                    if (call.estimated_uncached_cost_usd !== null) return;
                    const target = run.plan.targets.find(target => target.id === call.target_id);
                    if (!target || !object(call.request)) throw new TypeError('Cannot reconstruct unknown-call budget reservation');
                    budget.uncertain_cost += new AssessmentBudget(Infinity, 1).admit(call.request, target.pricing)!;
                    missing++;
                },
                parseAssessmentJson
            );
            if (missing !== budget.missing_cost) throw new TypeError('Missing request evidence for retry cost accounting');
        }
        if (budget.requests >= budget.request_limit || budget.spent + budget.uncertain_cost >= budget.cost_limit)
            throw new TypeError('Original execution limit exhausted; copy configuration to a new task with adjusted limits');
        const directory = join(this.data_dir, id),
            generation = 'retry-' + request_id;
        private_directory(join(directory, generation));
        const original = clone(run);
        let journal: RunJournal | undefined;
        try {
            // Archive exact prior bytes before publishing any replacement result.
            const archive = openSync(join(directory, generation, 'run-before.json'), 'wx', 0o600);
            try {
                writeFileSync(archive, readFileSync(join(directory, 'run.json')));
                fsyncSync(archive);
            } finally {
                closeSync(archive);
            }
            for (const [source, bytes] of prepared.sources) {
                const destination = join(directory, generation, 'source', source);
                private_directory(dirname(destination));
                const fd = openSync(destination, 'wx', 0o600);
                try {
                    writeFileSync(fd, bytes);
                    fsyncSync(fd);
                } finally {
                    closeSync(fd);
                }
            }
            journal = new RunJournal(
                join(directory, generation, 'journal.jsonl'),
                [...prepared.bindings.values()].flatMap(route => [
                    route.api_key,
                    route.base_url.replace(/\/+$/, ''),
                    route.api_key_env ?? ''
                ])
            );
            for (const sample of eligible) {
                const { attempts, ...previous } = clone(sample);
                const history = [...(Array.isArray(attempts) ? attempts : []), previous];
                for (const key of [
                    'calls',
                    'usage',
                    'estimated_uncached_cost_usd',
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
                ...batches,
                {
                    request_id,
                    sample_ids: eligible.map(sample => sample.sample_id),
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
                journal
            };
            run.budget = budget.snapshot();
            this._persist(run);
            if (typeof run.task_id === 'string') {
                const task = this._tasks.get(run.task_id)!;
                task.status = 'queued';
                task.stop_reason = null;
                this._persist_task(task);
                if (!this.task_active_runs.has(task.id)) this.task_active_runs.set(task.id, new Set());
            }
            this._runtime.set(id, runtime);
            for (const route of prepared.bindings.values())
                this._account_limits.set(
                    route.account_ref,
                    Math.min(this._account_limits.get(route.account_ref) ?? 500, route.account_concurrency)
                );
            this.schedule();
            return id;
        } catch (error) {
            journal?.close();
            this._runs.set(id, original);
            this.fail_storage();
            throw error;
        }
    }
    cancel_run(id: string): boolean {
        const run = this._runs.get(id);
        if (!run) return false;
        if (!TERMINAL_RUN_STATUSES.has(run.status)) {
            this._runtime.get(id)!.cancel.value = true;
            run.status = 'cancelling';
            this.persist_safe(run);
            this.schedule();
        }
        return true;
    }
    async wait_for_run(id: string, timeout?: number): Promise<boolean> {
        if (!this._runs.has(id)) return false;
        if (TERMINAL_RUN_STATUSES.has(this._runs.get(id)!.status) && !this._runtime.has(id)) return true;
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
        if (!this._runs.has(id)) return null;
        if (!(await this.wait_for_run(id, timeout))) throw new Error('Bench run is still active');
        return this.get_run(id);
    }
    private schedule(): void {
        if (this.scheduled) return;
        this.scheduled = true;
        queueMicrotask(() => {
            this.scheduled = false;
            this.dispatch();
        });
    }
    private rotate<T>(values: T[], last: T | null): T[] {
        const pivot = last === null ? -1 : values.indexOf(last);
        return pivot < 0 ? values : [...values.slice(pivot + 1), ...values.slice(0, pivot + 1)];
    }
    private dispatch(): void {
        let dispatched: boolean;
        do {
            dispatched = false;
            for (const id of this.rotate([...this._runtime.keys()], this.last_run_id)) {
                const runtime = this._runtime.get(id)!,
                    run = this._runs.get(id)!;
                const cancelled = runtime.cancel.value,
                    stop = runtime.budget.stop_reason;
                if (cancelled || stop)
                    for (const sample of run.samples)
                        if (sample.status === 'pending') sample.status = cancelled ? 'cancelled' : 'budget_not_admitted';
                const pending = run.samples.filter(sample => sample.status === 'pending');
                if (!pending.length && !runtime.active) {
                    run.status =
                        run.stop_reason === 'storage_error'
                            ? 'failed'
                            : cancelled
                              ? 'cancelled'
                              : run.samples.every(sample => sample.status === 'completed')
                                ? 'completed'
                                : run.samples.some(sample => ['api_failure', 'worker_error', 'storage_error'].includes(sample.status))
                                  ? 'failed'
                                  : 'incomplete';
                    if (run.stop_reason !== 'storage_error')
                        run.stop_reason = cancelled
                            ? 'cancelled'
                            : stop ||
                              (run.status === 'failed' ? 'api_failure' : run.status === 'incomplete' ? 'capability_or_limit' : null);
                    this.persist_safe(run);
                    try {
                        runtime.journal.close();
                    } catch {
                        this.fail_storage();
                        this.persist_safe(run);
                    }
                    this._runtime.delete(id);
                    dispatched = true; // Reconsider queued siblings after this child releases a task slot.
                    if (typeof run.task_id === 'string') {
                        this.task_active_runs.get(run.task_id)?.delete(id);
                        this.update_task(run.task_id);
                    }
                    for (const done of this.waiters.get(id) ?? []) done();
                    this.waiters.delete(id);
                    continue;
                }
                const taskId = typeof run.task_id === 'string' ? run.task_id : null;
                const parent = taskId ? this._tasks.get(taskId) : null;
                const activeChildren = taskId ? this.task_active_runs.get(taskId) : null;
                const taskChild = run.execution_kind === 'task-child-v1' && !!parent && !!activeChildren;
                if (taskChild && !activeChildren.has(id) && activeChildren.size >= parent.plan.run_concurrency) continue;
                const targetOrder = this.rotate([...runtime.targets.keys()], runtime.last_target_id);
                pending.sort((a, b) => targetOrder.indexOf(a.target_id) - targetOrder.indexOf(b.target_id));
                for (const sample of pending) {
                    if (this._active >= this.concurrency || runtime.active >= run.plan.concurrency) break;
                    const account = runtime.bindings.get(sample.target_id)!.account_ref;
                    if (
                        (!taskChild && runtime.target_active.has(sample.target_id)) ||
                        (this._account_active.get(account) ?? 0) >= this._account_limits.get(account)!
                    )
                        continue;
                    sample.status = 'running';
                    sample.started_at = now();
                    run.status = 'running';
                    if (!this.persist_safe(run)) {
                        sample.status = 'storage_error';
                        break;
                    }
                    if (taskChild) {
                        activeChildren.add(id);
                        this.update_task(taskId!);
                        if (this._closing) {
                            sample.status = 'storage_error';
                            break;
                        }
                    }
                    runtime.active++;
                    if (!taskChild) runtime.target_active.add(sample.target_id);
                    runtime.last_target_id = sample.target_id;
                    this.last_run_id = id;
                    this._active++;
                    this._account_active.set(account, (this._account_active.get(account) ?? 0) + 1);
                    void this.execute(run, runtime, clone(sample)).then(
                        observation => this.complete(id, sample.sample_id, account, observation),
                        error => this.complete(id, sample.sample_id, account, null, error)
                    );
                    dispatched = true;
                    break;
                }
            }
        } while (dispatched);
    }
    private async execute(run: ExecutionRun, runtime: RunRuntime, sample: ExecutionSample): Promise<RecordValue | null> {
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
            Object.assign(sample, observation, {
                latest_attempt_usage: observation.usage,
                latest_attempt_cost_usd: observation.estimated_uncached_cost_usd
            });
            const attempts = Array.isArray(sample.attempts) ? (sample.attempts as RecordValue[]) : [];
            if (attempts.length) {
                // Attempts that sent no request (empty calls) consumed nothing: a known zero, not unknown.
                const all = [...attempts, observation].filter(item => !(Array.isArray(item.calls) && item.calls.length === 0));
                const costs = all.map(item =>
                    Object.hasOwn(item, 'latest_attempt_cost_usd') ? item.latest_attempt_cost_usd : item.estimated_uncached_cost_usd
                );
                const usages = all.map(item => (Object.hasOwn(item, 'latest_attempt_usage') ? item.latest_attempt_usage : item.usage));
                sample.estimated_uncached_cost_usd = costs.every(value => typeof value === 'number')
                    ? costs.reduce<number>((sum, value) => sum + Number(value), 0)
                    : null;
                sample.usage = usages.every(object)
                    ? {
                          input_tokens: usages.reduce((sum, usage) => sum + Number(usage.input_tokens), 0),
                          output_tokens: usages.reduce((sum, usage) => sum + Number(usage.output_tokens), 0)
                      }
                    : null;
            }
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
            this.persist_safe(run);
            this.schedule();
        }
    }
    async close(wait = true): Promise<void> {
        this._closing = true;
        const ids = [...this._runtime.keys()];
        for (const task of this._tasks.values()) {
            if (!TERMINAL_RUN_STATUSES.has(task.status)) this.cancel_task(task.id);
        }
        for (const runtime of this._runtime.values()) runtime.cancel.value = true;
        this.schedule();
        if (wait) await Promise.all(ids.map(id => this.wait_for_run(id)));
    }
}
