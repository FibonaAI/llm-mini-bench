import { DEFAULT_UI_BANK_VERSION, RELEASED_BANK_VERSIONS } from '../src/production_bank.ts';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
    build_assessment_baseline,
    project_validated_baseline_observations,
    validate_assessment_baseline,
    type AssessmentBaseline
} from '../src/assessment_baselines.ts';
import { load_assessment_bank } from '../src/assessment_bank.ts';
import {
    assessment_source_signature,
    create_assessment_source_context,
    type AssessmentSourceContext
} from '../src/assessment_provenance.ts';
import { parseAssessmentJson } from '../src/assessment_json.ts';
import { parseStrictJson } from '../src/bench_execution_storage.ts';
import { readBenchLimitedBody } from '../src/bench_http_body.ts';
export { readBenchLimitedBody } from '../src/bench_http_body.ts';
import { BENCH_DB_FILENAME, BenchDatabase } from '../src/bench_db.ts';
import { BenchExecutionService, private_directory } from '../src/bench_execution.ts';
import { has_legacy_workspace, migrate_legacy_workspace, type MigrationReport } from '../src/bench_legacy_migration.ts';
import { BenchRouteRegistry } from '../src/bench_routes.ts';
import type { BenchServiceAdapter, BenchQuotaCatalog } from '../src/bench_adapter.ts';

type JsonObject = Record<string, unknown>;
/** Benchmark-relative paths do not depend on the plugin host working directory. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Reject oversized JSON before parsing or scheduling paid work. */
export const MAX_BODY = 1024 * 1024;
function object(value: unknown): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function expandHome(path: string): string {
    return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}
/** Plugin embedding accepts only local storage paths and runtime-only credentials. */
export interface MiniBenchOptions {
    port?: number;
    token: string;
    data_dir?: string;
    adapter?: BenchServiceAdapter;
    web_dir?: string;
}
/** Application errors carry public messages, never upstream credential-bearing details. */
class BenchUnavailableError extends Error {}
/** Local Assessment service; no process spawning and no automatic paid-task recovery. */
export class BenchService {
    readonly data_dir: string;
    readonly db: BenchDatabase;
    readonly adapter?: BenchServiceAdapter;
    readonly token: string;
    readonly concurrency: number;
    _bench_execution: BenchExecutionService | undefined;

    private closed = false;
    private close_promise: Promise<void> | null = null;
    private _migration_promise: Promise<MigrationReport | null> | null = null;
    private _migration_done = false;
    private _migration_error: unknown = null;
    constructor(options: Partial<MiniBenchOptions> = {}) {
        this.token = options.token ?? process.env.MAGPIE_BENCH_TOKEN ?? '';
        if (Array.from(this.token).length < 32) throw new TypeError('MAGPIE_BENCH_TOKEN must be at least 32 characters');
        const concurrency = process.env.MAGPIE_BENCH_CONCURRENCY ?? '18';
        if (!/^\d+$/.test(concurrency) || Number(concurrency) < 1 || Number(concurrency) > 64)
            throw new TypeError('MAGPIE_BENCH_CONCURRENCY must be an integer from 1 to 64');
        this.concurrency = Number(concurrency);
        this.data_dir = resolve(expandHome(options.data_dir ?? process.env.MAGPIE_BENCH_DATA_DIR ?? '~/.local/share/magpie-mini-bench'));
        this.adapter = options.adapter;
        private_directory(this.data_dir);
        this.db = new BenchDatabase(join(this.data_dir, BENCH_DB_FILENAME));
    }
    bench_execution(): BenchExecutionService {
        if (this.closed) throw new BenchUnavailableError('Assessment service is closed');
        if (!this._bench_execution) {
            const override = process.env.MAGPIE_BENCH_ROUTES_FILE;
            if (override !== undefined && !override.trim()) throw new TypeError('Bench routes file override must not be empty');
            const path = expandHome(override ?? join(this.data_dir, 'routes.json'));
            let entryExists = false;
            try {
                lstatSync(path);
                entryExists = true;
            } catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
            }
            const routes = override !== undefined || entryExists || !this.adapter ? new BenchRouteRegistry(path) : this.adapter.routes;
            this._bench_execution = new BenchExecutionService(this.data_dir, routes, this.concurrency, undefined, this.db);
        }
        return this._bench_execution;
    }
    /** Automatically migrate legacy file-per-run directories into SQLite and clean up verified files. */
    ensure_ready(): Promise<MigrationReport | null> {
        if (this.closed) return Promise.reject(new BenchUnavailableError('Assessment service is closed'));
        if (this._migration_error)
            return Promise.reject(new BenchUnavailableError('legacy storage migration failed; inspect storage and restart'));
        if (this._migration_done) return Promise.resolve(null);
        if (!this._migration_promise) {
            if (!has_legacy_workspace(this.data_dir)) {
                this._migration_done = true;
                return Promise.resolve(null);
            }
            this._migration_promise = migrate_legacy_workspace(this.data_dir, {
                db: this.db,
                cleanup: true,
                shouldAbort: () => this.closed
            })
                .then(report => {
                    if (!report.aborted) this._migration_done = true;
                    this._baselines_cache = null;
                    this._observations_cache = null;
                    this._tasks_cache = null;
                    this._runs_cache = null;
                    if (
                        report.runs_migrated > 0 ||
                        report.tasks_migrated > 0 ||
                        report.baselines_migrated > 0 ||
                        report.cleaned_runs > 0 ||
                        report.cleaned_tasks > 0 ||
                        report.cleaned_baselines > 0 ||
                        report.removed_dirs.length > 0
                    ) {
                        console.log(
                            `LLM Mini Bench migrated legacy storage into ${BENCH_DB_FILENAME}: ` +
                                `${report.runs_migrated} runs, ${report.tasks_migrated} tasks, ${report.baselines_migrated} baselines migrated; ` +
                                `${report.cleaned_runs} runs, ${report.cleaned_tasks} tasks, ${report.cleaned_baselines} baselines cleaned.`
                        );
                    }
                    if (report.runs_failed > 0 || report.tasks_failed > 0 || report.baselines_failed > 0) {
                        console.warn(
                            `LLM Mini Bench kept unreadable legacy items on disk: ` +
                                `${report.runs_failed} runs, ${report.tasks_failed} tasks, ${report.baselines_failed} baselines.`
                        );
                    }
                    return report;
                })
                .catch(error => {
                    this._migration_error = error;
                    console.error('LLM Mini Bench automatic legacy migration failed; legacy files were preserved.');
                    throw new BenchUnavailableError('legacy storage migration failed; inspect storage and restart');
                });
        }
        return this._migration_promise;
    }
    async close(): Promise<void> {
        if (this.close_promise) return this.close_promise;
        this.closed = true;
        this.close_promise = (async () => {
            try {
                await this._migration_promise?.catch(() => undefined);
                await this._bench_execution?.close();
            } finally {
                this._run_detail_cache.clear();
                this.db.close();
            }
        })();
        return this.close_promise;
    }
    async models(): Promise<JsonObject[]> {
        return this.adapter ? structuredClone(await this.adapter.models()) : [];
    }
    async quota_cards(refresh = false): Promise<BenchQuotaCatalog> {
        return this.adapter?.quotas ? this.adapter.quotas.read(refresh) : { status: 'unavailable', fetched_at: null, cards: [] };
    }
    private readonly instance_id = randomUUID().slice(0, 12);
    private _baselines_cache: { key: string; baselines: AssessmentBaseline[] } | null = null;
    private _observations_cache: {
        key: string;
        etag: string;
        body: string | Uint8Array<ArrayBuffer>;
        gzip: Uint8Array<ArrayBuffer> | null;
    } | null = null;
    private _banks_cache: { key: string; body: string; gzip: Uint8Array<ArrayBuffer> | null } | null = null;
    private _tasks_cache: { key: string; etag: string; body: string; gzip: Uint8Array<ArrayBuffer> | null } | null = null;
    private _runs_cache: { key: string; etag: string; body: string; gzip: Uint8Array<ArrayBuffer> | null } | null = null;
    private static readonly RUN_DETAIL_CACHE_MAX = 16;
    private static readonly RUN_DETAIL_CACHE_MAX_BYTES = 8 * 1024 * 1024;
    private _run_detail_cache_bytes = 0;
    private readonly _run_detail_cache = new Map<
        string,
        { status: string; updated_at: string; body: string; gzip: Uint8Array<ArrayBuffer> | null; bytes: number }
    >();
    private baselines_signature(): string {
        if (this.db.is_closed) return 'closed';
        const rows = this.db.list_baseline_metadata();
        return `${this.db.baselines_revision}|` + rows.map(row => `${row.id}:${row.payload_length}`).join(',');
    }
    baselines(context?: AssessmentSourceContext, sourceSig = assessment_source_signature()): AssessmentBaseline[] {
        const signature = this.baselines_signature();
        const key = `${sourceSig}\u0000${signature}`;
        if (!context && this._baselines_cache?.key === key) return this._baselines_cache.baselines;
        const payloads = this.db.is_closed ? [] : this.db.list_baseline_rows().map(row => row.payload_json);
        const resolvedContext = context ?? create_assessment_source_context();
        const validated: AssessmentBaseline[] = [];
        const seen = new Set<string>();
        for (const raw of payloads) {
            try {
                const baseline = validate_assessment_baseline(parseStrictJson(raw), resolvedContext);
                if (!seen.has(baseline.id)) {
                    seen.add(baseline.id);
                    validated.push(baseline);
                }
            } catch {
                /* Invalid, tampered, or stale baselines are skipped without upgrading. */
            }
        }
        if (!context) this._baselines_cache = { key, baselines: validated };
        return validated;
    }
    private invalidate_baseline_caches(): void {
        this._baselines_cache = null;
        this._observations_cache = null;
        this._tasks_cache = null;
        this._runs_cache = null;
        this._run_detail_cache.clear();
        this._run_detail_cache_bytes = 0;
    }
    save_baseline(baseline: AssessmentBaseline): void {
        this.db.save_baseline(baseline);
        this.invalidate_baseline_caches();
    }
    save_baselines_batch(baselines: readonly AssessmentBaseline[]): void {
        if (!baselines.length) return;
        this.db.save_baselines_batch(baselines);
        this.invalidate_baseline_caches();
    }
    delete_baseline(id: string): boolean {
        const deleted = this.db.delete_baseline(id);
        if (deleted) this.invalidate_baseline_caches();
        return deleted;
    }
    delete_baselines_batch(ids: readonly string[]): string[] {
        const deleted = this.db.delete_baselines_batch(ids);
        if (deleted.length) this.invalidate_baseline_caches();
        return deleted;
    }
    create_run_baseline(run_id: string, target_id: string) {
        const run = this.bench_execution().get_run(run_id);
        if (!run) return null;
        const baseline = build_assessment_baseline(run, target_id);
        this.save_baseline(baseline);
        return baseline;
    }
    create_run_baselines_batch(items: readonly { run_id: string; target_id: string }[]) {
        const execution = this.bench_execution();
        const context = create_assessment_source_context();
        const toSave: AssessmentBaseline[] = [];
        const created: Array<{ id: string; run_id: string; target_id: string }> = [];
        const rejected: Array<{ run_id: string; target_id: string; error: string }> = [];
        const seen = new Set<string>();
        for (const item of items) {
            const pairKey = `${item.run_id}\u0000${item.target_id}`;
            if (seen.has(pairKey)) continue;
            seen.add(pairKey);
            const run = execution.get_run(item.run_id);
            if (!run) {
                rejected.push({ run_id: item.run_id, target_id: item.target_id, error: 'run not found' });
                continue;
            }
            try {
                const baseline = build_assessment_baseline(run, item.target_id, context);
                toSave.push(baseline);
                created.push({ id: baseline.id, run_id: item.run_id, target_id: item.target_id });
            } catch (error) {
                rejected.push({
                    run_id: item.run_id,
                    target_id: item.target_id,
                    error: error instanceof Error ? error.message : 'ineligible for baseline'
                });
            }
        }
        if (toSave.length) this.save_baselines_batch(toSave);
        return { created, rejected };
    }
    private baseline_lookup(sourceSig = assessment_source_signature()): Map<string, { id: string; created_at: string }> {
        const map = new Map<string, { id: string; created_at: string }>();
        for (const baseline of this.baselines(undefined, sourceSig)) {
            map.set(`${baseline.run_id}\u0000${baseline.target_id}`, { id: baseline.id, created_at: baseline.created_at });
        }
        return map;
    }
    private enrich_task_child(
        execution: BenchExecutionService,
        child: JsonObject,
        lookup: ReadonlyMap<string, { id: string; created_at: string }>,
        context: AssessmentSourceContext,
        sourceSig: string
    ): JsonObject {
        const runId = typeof child.run_id === 'string' ? child.run_id : '';
        const targetObj = object(child.target) ? child.target : null;
        const targetId = typeof targetObj?.id === 'string' ? targetObj.id : '';
        const targets =
            typeof execution.get_run_baseline_targets === 'function' ? execution.get_run_baseline_targets(runId, context, sourceSig) : [];
        const entry = targets.find(item => item.target_id === targetId) ?? (targets.length === 1 ? targets[0] : undefined);
        const match = runId && targetId ? lookup.get(`${runId}\u0000${targetId}`) : undefined;
        const createdAt = typeof child.created_at === 'string' ? child.created_at : '';
        const baseline_id = match && (!match.created_at || !createdAt || match.created_at === createdAt) ? match.id : null;
        return {
            ...child,
            baseline_eligible: Boolean(entry?.baseline_eligible),
            ineligibility_reason: entry?.ineligibility_reason ?? null,
            baseline_id
        };
    }
    enrich_task_payload(
        execution: BenchExecutionService,
        task: JsonObject,
        lookup?: ReadonlyMap<string, { id: string; created_at: string }>,
        context?: AssessmentSourceContext,
        sourceSig = assessment_source_signature()
    ): JsonObject {
        if (!Array.isArray(task.children)) return task;
        const resolvedLookup = lookup ?? this.baseline_lookup(sourceSig);
        const resolvedContext = context ?? create_assessment_source_context();
        return {
            ...task,
            children: (task.children as JsonObject[]).map(child =>
                this.enrich_task_child(execution, child, resolvedLookup, resolvedContext, sourceSig)
            )
        };
    }
    enrich_run_payload(
        execution: BenchExecutionService,
        run: JsonObject,
        lookup?: ReadonlyMap<string, { id: string; created_at: string }>,
        context?: AssessmentSourceContext,
        sourceSig = assessment_source_signature()
    ): JsonObject {
        const runId = typeof run.id === 'string' ? run.id : '';
        if (!runId || typeof execution.get_run_baseline_targets !== 'function') return run;
        const resolvedLookup = lookup ?? this.baseline_lookup(sourceSig);
        const resolvedContext = context ?? create_assessment_source_context();
        const createdAt = typeof run.created_at === 'string' ? run.created_at : '';
        const baseline_targets = execution.get_run_baseline_targets(runId, resolvedContext, sourceSig).map(item => {
            const match = resolvedLookup.get(`${runId}\u0000${item.target_id}`);
            const baseline_id = match && (!match.created_at || !createdAt || match.created_at === createdAt) ? match.id : null;
            return {
                target_id: item.target_id,
                baseline_eligible: item.baseline_eligible,
                ineligibility_reason: item.ineligibility_reason,
                baseline_id
            };
        });
        return {
            ...run,
            baseline_targets,
            baseline_eligible: baseline_targets.some(item => item.baseline_eligible),
            ineligibility_reason: baseline_targets.length === 1 ? baseline_targets[0]!.ineligibility_reason : null,
            baseline_id: baseline_targets.length === 1 ? baseline_targets[0]!.baseline_id : null
        };
    }
    observations() {
        const execution = this.bench_execution(),
            sourceSig = assessment_source_signature(),
            context = create_assessment_source_context();
        const baselineRows = project_validated_baseline_observations(this.baselines(undefined, sourceSig));
        const runRows = execution.list_observations(context, sourceSig);
        return [...baselineRows, ...runRows];
    }
    cached_observations_payload(): { etag: string; body: string | Uint8Array<ArrayBuffer>; gzip: Uint8Array<ArrayBuffer> | null } {
        const execution = this.bench_execution();
        const sourceSig = assessment_source_signature();
        const baselineSig = this.baselines_signature();
        const key = `${sourceSig}\u0000${baselineSig}\u0000${execution.revision}`;
        if (this._observations_cache?.key === key) return this._observations_cache;
        if (execution.list_observations !== BenchExecutionService.prototype.list_observations) {
            const observations = this.observations();
            const observationsJson = JSON.stringify(observations);
            const etag = createHash('sha256').update(observationsJson).digest('hex').slice(0, 32);
            const body = `{"etag":${JSON.stringify(etag)},"observations":${observationsJson}}`;
            this._observations_cache = { key, etag, body, gzip: null };
            return this._observations_cache;
        }
        const context = create_assessment_source_context();
        const baselineRows = project_validated_baseline_observations(this.baselines(undefined, sourceSig));
        const chunks: string[] = [];
        if (baselineRows.length) {
            const rawBaselines = JSON.stringify(baselineRows);
            if (rawBaselines.length > 2) chunks.push(rawBaselines.slice(1, -1));
        }
        for (const chunk of execution.serialize_observation_chunks(context, sourceSig)) {
            chunks.push(chunk);
        }
        const hasher = createHash('sha256');
        hasher.update('[');
        let payloadBytes = 0;
        for (let i = 0; i < chunks.length; i++) {
            if (i > 0) {
                hasher.update(',');
                payloadBytes += 1;
            }
            const chunk = chunks[i]!;
            hasher.update(chunk);
            payloadBytes += Buffer.byteLength(chunk);
        }
        hasher.update(']');
        const etag = hasher.digest('hex').slice(0, 32);
        const prefix = `{"etag":${JSON.stringify(etag)},"observations":[`;
        const suffix = ']}';
        const prefixBytes = Buffer.byteLength(prefix);
        const suffixBytes = Buffer.byteLength(suffix);
        // Write directly into one exact-sized buffer to avoid doubling multi-MiB strings + UTF-8 copies during gzip.
        const out = Buffer.allocUnsafe(prefixBytes + payloadBytes + suffixBytes);
        let offset = out.write(prefix, 0, 'utf8');
        for (let i = 0; i < chunks.length; i++) {
            if (i > 0) out[offset++] = 0x2c; // ','
            offset += out.write(chunks[i]!, offset, 'utf8');
        }
        out.write(suffix, offset, 'utf8');
        const body = new Uint8Array(out.buffer, out.byteOffset, out.byteLength) as Uint8Array<ArrayBuffer>;
        this._observations_cache = { key, etag, body, gzip: null };
        return this._observations_cache;
    }
    cached_banks_payload(): { body: string; gzip: Uint8Array<ArrayBuffer> | null } {
        const sourceSig = assessment_source_signature();
        if (this._banks_cache?.key === sourceSig) return this._banks_cache;
        const banks = RELEASED_BANK_VERSIONS.map(version => {
            const bank = load_assessment_bank(version);
            const tasks = bank.tasks.map(task =>
                Object.fromEntries(Object.entries(task).filter(([, value]) => typeof value !== 'function'))
            );
            return {
                id: 'assessment-' + bank.version,
                version: bank.version,
                default: bank.version === DEFAULT_UI_BANK_VERSION,
                production: true,
                kind: 'assessment',
                title: 'Mini Bench',
                task_sha256: bank.task_sha256,
                tasks,
                scoring_policy: bank.scoring_policy
            };
        });
        const body = JSON.stringify({
            execution_policy: 'sample-timeout-v1',
            banks
        });
        this._banks_cache = { key: sourceSig, body, gzip: null };
        return this._banks_cache;
    }
    cached_tasks_payload(execution: BenchExecutionService): { etag: string | null; body: string; gzip: Uint8Array<ArrayBuffer> | null } {
        const sourceSig = assessment_source_signature();
        if (execution.list_tasks !== BenchExecutionService.prototype.list_tasks) {
            const lookup = this.baseline_lookup(sourceSig);
            const context = create_assessment_source_context();
            const tasks = execution.list_tasks().map(task => this.enrich_task_payload(execution, task, lookup, context, sourceSig));
            return { etag: null, body: JSON.stringify({ tasks }), gzip: null };
        }
        const revision = execution.revision;
        const baselineSig = this.baselines_signature();
        const key = `${revision}\u0000${sourceSig}\u0000${baselineSig}`;
        if (this._tasks_cache?.key === key) return this._tasks_cache;
        const lookup = this.baseline_lookup(sourceSig);
        const context = create_assessment_source_context();
        const sigDigest = createHash('sha256').update(`${sourceSig}\u0000${baselineSig}`).digest('hex').slice(0, 12);
        const etag = `${this.instance_id}-t-${revision}-${sigDigest}`;
        if (typeof execution.ensure_source_index === 'function') execution.ensure_source_index(context, sourceSig);
        const raw = execution.serialize_tasks_payload(child => this.enrich_task_child(execution, child, lookup, context, sourceSig));
        const body = `{"etag":${JSON.stringify(etag)},${raw.slice(1)}`;
        this._tasks_cache = { key, etag, body, gzip: null };
        return this._tasks_cache;
    }
    cached_runs_payload(execution: BenchExecutionService): { etag: string | null; body: string; gzip: Uint8Array<ArrayBuffer> | null } {
        const sourceSig = assessment_source_signature();
        if (execution.list_runs !== BenchExecutionService.prototype.list_runs) {
            const lookup = this.baseline_lookup(sourceSig);
            const context = create_assessment_source_context();
            const runs = execution.list_runs().map(run => this.enrich_run_payload(execution, run, lookup, context, sourceSig));
            return { etag: null, body: JSON.stringify({ runs }), gzip: null };
        }
        const revision = execution.revision;
        const baselineSig = this.baselines_signature();
        const key = `${revision}\u0000${sourceSig}\u0000${baselineSig}`;
        if (this._runs_cache?.key === key) return this._runs_cache;
        const lookup = this.baseline_lookup(sourceSig);
        const context = create_assessment_source_context();
        const sigDigest = createHash('sha256').update(`${sourceSig}\u0000${baselineSig}`).digest('hex').slice(0, 12);
        const etag = `${this.instance_id}-r-${revision}-${sigDigest}`;
        if (typeof execution.ensure_source_index === 'function') execution.ensure_source_index(context, sourceSig);
        const raw = execution.serialize_runs_payload(run => this.enrich_run_payload(execution, run, lookup, context, sourceSig));
        const body = `{"etag":${JSON.stringify(etag)},${raw.slice(1)}`;
        this._runs_cache = { key, etag, body, gzip: null };
        return this._runs_cache;
    }
    cached_run_detail_payload(
        execution: BenchExecutionService,
        id: string,
        omitProvenance: boolean
    ): { body: string; gzip: Uint8Array<ArrayBuffer> | null } | null {
        const sourceSig = assessment_source_signature();
        if (execution.get_run !== BenchExecutionService.prototype.get_run) {
            const run = omitProvenance ? execution.get_run(id, { omit_provenance: true }) : execution.get_run(id);
            return run
                ? { body: JSON.stringify(this.enrich_run_payload(execution, run, undefined, undefined, sourceSig)), gzip: null }
                : null;
        }
        const meta = execution.get_run_cache_key(id);
        const cacheKey = `${id}:${omitProvenance ? 'slim' : 'full'}:${sourceSig}:${this.db.baselines_revision}`;
        if (meta) {
            const hit = this._run_detail_cache.get(cacheKey);
            if (hit && hit.status === meta.status && hit.updated_at === meta.updated_at) {
                this._run_detail_cache.delete(cacheKey);
                this._run_detail_cache.set(cacheKey, hit);
                return hit;
            }
        }
        const run = execution.get_run(id, omitProvenance ? { omit_provenance: true } : undefined);
        if (!run) return null;
        const enriched = this.enrich_run_payload(execution, run, undefined, undefined, sourceSig);
        const body = JSON.stringify(enriched);
        const entry = { status: run.status, updated_at: run.updated_at, body, gzip: null, bytes: body.length };
        if (meta && run.status === meta.status && run.updated_at === meta.updated_at) {
            const existing = this._run_detail_cache.get(cacheKey);
            if (existing) {
                this._run_detail_cache_bytes -= existing.bytes;
                this._run_detail_cache.delete(cacheKey);
            }
            if (entry.bytes <= BenchService.RUN_DETAIL_CACHE_MAX_BYTES) {
                this._run_detail_cache.set(cacheKey, entry);
                this._run_detail_cache_bytes += entry.bytes;
                while (
                    this._run_detail_cache.size > BenchService.RUN_DETAIL_CACHE_MAX ||
                    this._run_detail_cache_bytes > BenchService.RUN_DETAIL_CACHE_MAX_BYTES
                ) {
                    const oldest = this._run_detail_cache.keys().next().value;
                    if (oldest === undefined) break;
                    const evicted = this._run_detail_cache.get(oldest)!;
                    this._run_detail_cache_bytes -= evicted.bytes;
                    this._run_detail_cache.delete(oldest);
                }
            }
        }
        return entry;
    }
}
function secureRequest(request: Request): boolean {
    const host = request.headers.get('host') ?? '';
    try {
        const parsed = new URL('http://' + host);
        if (
            !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
            parsed.username ||
            parsed.password ||
            parsed.pathname !== '/' ||
            parsed.search ||
            parsed.hash
        )
            return false;
        // URL parsing canonicalizes host spellings; allow only the original loopback spelling.
        if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) return false;
        const origin = request.headers.get('origin');
        if (origin && origin !== 'null') {
            const source = new URL(origin);
            if (
                !['http:', 'https:'].includes(source.protocol) ||
                source.username ||
                source.password ||
                source.pathname !== '/' ||
                source.search ||
                source.hash
            )
                return false;
            const authority = origin.match(/^https?:\/\/([^/]+)(?:\/)?$/)?.[1];
            if (authority !== host) return false;
        }
        return true;
    } catch {
        return false;
    }
}
async function requestBody(request: Request): Promise<JsonObject> {
    if (request.headers.has('transfer-encoding')) throw new TypeError('transfer encoding is not supported');
    const size = request.headers.get('content-length');
    if (size === null || !/^\d+$/.test(size) || Number(size) > MAX_BODY)
        throw new TypeError('request body exceeds size limit or is missing');
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
        throw new TypeError('content type must be application/json');
    let body: unknown;
    try {
        const bytes = await readBenchLimitedBody(request.body, MAX_BODY);
        if (bytes.length !== Number(size)) throw new TypeError('invalid body size');
        body = parseAssessmentJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
        throw new TypeError('invalid JSON body');
    }
    if (!object(body)) throw new TypeError('JSON body must be an object');
    return body;
}
/** JSON responses at least this large are gzip-encoded when the client accepts it. */
export const JSON_GZIP_MIN_BYTES = 2048;
/** Embeddable Bun fetch handler enforces token, Host, Origin, and strict request bodies. */
export function make_handler(service: BenchService, web_dir?: string): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
        const headers = new Headers({
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer'
        });
        if (request.headers.get('origin') === 'null') {
            headers.set('Access-Control-Allow-Origin', 'null');
            headers.set('Vary', 'Origin');
        }
        // Larger JSON bodies (observations, task/run lists polled every 2 s) compress roughly 10x.
        const acceptsGzip = /\bgzip\b/i.test(request.headers.get('accept-encoding') ?? '');
        const jsonCached = (status: number, cached: { body: string | Uint8Array<ArrayBuffer>; gzip: Uint8Array<ArrayBuffer> | null }) => {
            const size = typeof cached.body === 'string' ? cached.body.length : cached.body.byteLength;
            if (!acceptsGzip || size < JSON_GZIP_MIN_BYTES) return new Response(cached.body, { status, headers });
            if (!cached.gzip) cached.gzip = Bun.gzipSync(cached.body);
            headers.set('Content-Encoding', 'gzip');
            headers.append('Vary', 'Accept-Encoding');
            return new Response(cached.gzip, { status, headers });
        };
        const json = (status: number, value: unknown) => {
            const body = JSON.stringify(value);
            if (!acceptsGzip || body.length < JSON_GZIP_MIN_BYTES) return new Response(body, { status, headers });
            headers.set('Content-Encoding', 'gzip');
            headers.append('Vary', 'Accept-Encoding');
            return new Response(Bun.gzipSync(body), { status, headers });
        };
        if (!secureRequest(request)) return json(403, { error: 'loopback host and same-origin requests only' });
        if (request.method === 'OPTIONS') {
            if (request.headers.get('origin') !== 'null') return json(403, { error: 'origin not allowed' });
            headers.set('Access-Control-Allow-Methods', 'GET, POST');
            headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Mini-Bench-Token');
            return new Response(null, { status: 204, headers });
        }
        const path = new URL(request.url).pathname;
        if (path.startsWith('/api/')) {
            const actual = Buffer.from(request.headers.get('X-Mini-Bench-Token') ?? ''),
                expected = Buffer.from(service.token);
            if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
                return json(403, { error: 'invalid or missing bench token' });
        }
        try {
            if (path.startsWith('/api/bench/')) {
                if (request.method === 'GET' && path === '/api/bench/banks') return jsonCached(200, service.cached_banks_payload());
                await service.ensure_ready();
                if (request.method === 'GET' && path === '/api/bench/baselines') return json(200, { baselines: service.baselines() });
                if (request.method === 'POST' && path === '/api/bench/baselines/batch') {
                    const body = await requestBody(request);
                    if (body.action === 'promote') {
                        if (
                            Object.keys(body).some(key => key !== 'action' && key !== 'items') ||
                            !Array.isArray(body.items) ||
                            body.items.length === 0 ||
                            body.items.length > 256 ||
                            body.items.some(
                                item =>
                                    !object(item) ||
                                    Object.keys(item).some(key => key !== 'run_id' && key !== 'target_id') ||
                                    typeof item.run_id !== 'string' ||
                                    !/^[0-9a-f]{32}$/.test(item.run_id) ||
                                    typeof item.target_id !== 'string' ||
                                    !item.target_id.trim()
                            )
                        )
                            throw new TypeError('baseline batch promote requires 1..256 { run_id, target_id } items');
                        return json(200, service.create_run_baselines_batch(body.items as Array<{ run_id: string; target_id: string }>));
                    }
                    if (body.action === 'delete') {
                        if (
                            Object.keys(body).some(key => key !== 'action' && key !== 'ids') ||
                            !Array.isArray(body.ids) ||
                            body.ids.length === 0 ||
                            body.ids.length > 256 ||
                            body.ids.some(id => typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id))
                        )
                            throw new TypeError('baseline batch delete requires 1..256 64-hex baseline ids');
                        return json(200, { deleted: service.delete_baselines_batch(body.ids as string[]) });
                    }
                    throw new TypeError('baseline batch action must be promote or delete');
                }
                const baselineMatch = path.match(/^\/api\/bench\/baselines\/([0-9a-f]{64})\/delete$/);
                if (baselineMatch && request.method === 'POST') {
                    const id = baselineMatch[1]!;
                    return service.delete_baseline(id) ? json(200, { ok: true, id }) : json(404, { error: 'baseline not found' });
                }
                if (request.method === 'GET' && path === '/api/bench/observations') {
                    // `known` lets a client that already holds this exact list skip the download.
                    const cached = service.cached_observations_payload();
                    if (new URL(request.url).searchParams.get('known') === cached.etag)
                        return json(200, { etag: cached.etag, unchanged: true });
                    return jsonCached(200, cached);
                }
                const execution = service.bench_execution();
                if (request.method === 'GET' && path === '/api/bench/quota-cards')
                    return json(200, await service.quota_cards(new URL(request.url).searchParams.get('refresh') === '1'));
                if (request.method === 'GET' && path === '/api/bench/routes') {
                    if (new URL(request.url).searchParams.get('refresh') === '1') service.adapter?.refresh();
                    if (typeof execution.routes.public_routes_json === 'function') {
                        return jsonCached(200, { body: await execution.routes.public_routes_json(), gzip: null });
                    }
                    return json(200, { routes: await execution.routes.public_routes() });
                }
                if (request.method === 'POST' && path === '/api/bench/task-plans')
                    return json(200, await execution.plan_task(await requestBody(request)));
                if (request.method === 'GET' && path === '/api/bench/tasks') {
                    const cached = service.cached_tasks_payload(execution);
                    if (cached.etag && new URL(request.url).searchParams.get('known') === cached.etag)
                        return json(200, { etag: cached.etag, unchanged: true });
                    return jsonCached(200, cached);
                }
                if (request.method === 'POST' && path === '/api/bench/tasks')
                    return json(202, { id: await execution.start_task(await requestBody(request)) });
                const taskMatch = path.match(/^\/api\/bench\/tasks\/([0-9a-f]{32})(\/cancel|\/retry)?$/);
                if (taskMatch) {
                    if (request.method === 'GET' && !taskMatch[2]) {
                        const omitProvenance = new URL(request.url).searchParams.get('omit_provenance') === '1';
                        const task = omitProvenance
                            ? execution.get_task(taskMatch[1]!, { omit_provenance: true })
                            : execution.get_task(taskMatch[1]!);
                        return task ? json(200, service.enrich_task_payload(execution, task)) : json(404, { error: 'task not found' });
                    }
                    if (request.method === 'POST' && taskMatch[2] === '/retry') {
                        const body = await requestBody(request);
                        if (Object.keys(body).length !== 1 || typeof body.request_id !== 'string')
                            throw new TypeError('retry request must contain only request_id');
                        return json(202, await execution.retry_task(taskMatch[1]!, body.request_id));
                    }
                    if (request.method === 'POST' && taskMatch[2] === '/cancel')
                        return execution.cancel_task(taskMatch[1]!) ? json(200, { ok: true }) : json(404, { error: 'task not found' });
                }
                if (request.method === 'POST' && path === '/api/bench/plans')
                    return json(200, await execution.plan(await requestBody(request)));
                if (request.method === 'GET' && path === '/api/bench/runs') {
                    const cached = service.cached_runs_payload(execution);
                    if (cached.etag && new URL(request.url).searchParams.get('known') === cached.etag)
                        return json(200, { etag: cached.etag, unchanged: true });
                    return jsonCached(200, cached);
                }
                if (request.method === 'POST' && path === '/api/bench/runs')
                    return json(202, { id: await execution.start_run(await requestBody(request)) });
                const match = path.match(/^\/api\/bench\/runs\/([0-9a-f]{32})(\/cancel|\/retry|\/baseline|\/calls|\/events)?$/);
                if (match) {
                    const id = match[1]!;
                    if (request.method === 'GET' && match[2] === '/calls') {
                        const execution = service.bench_execution();
                        const exists =
                            execution.has_run(id) ||
                            (execution.get_run !== BenchExecutionService.prototype.get_run && Boolean(execution.get_run(id)));
                        if (!exists) return json(404, { error: 'run not found' });
                        return json(200, { calls: execution.read_run_call_summaries(id) ?? [] });
                    }
                    if (request.method === 'GET' && match[2] === '/events') {
                        const execution = service.bench_execution();
                        const exists =
                            execution.has_run(id) ||
                            (execution.get_run !== BenchExecutionService.prototype.get_run && Boolean(execution.get_run(id)));
                        if (!exists) return json(404, { error: 'run not found' });
                        const params = new URL(request.url).searchParams;
                        const sampleId = params.get('sample_id')?.trim() ?? '';
                        if (!sampleId) return json(400, { error: 'sample_id is required' });
                        const attemptId = params.get('attempt_id')?.trim() || undefined;
                        const events =
                            typeof execution.read_sample_session_events === 'function'
                                ? (execution.read_sample_session_events(id, sampleId, attemptId) ?? [])
                                : (execution.read_run_session_events(id, attemptId)?.filter(event => event.sample_id === sampleId) ?? []);
                        return json(200, { sample_id: sampleId, events });
                    }
                    if (request.method === 'GET' && !match[2]) {
                        const omitProvenance = new URL(request.url).searchParams.get('omit_provenance') === '1';
                        const cached = service.cached_run_detail_payload(execution, id, omitProvenance);
                        return cached ? jsonCached(200, cached) : json(404, { error: 'run not found' });
                    }
                    if (request.method === 'POST' && match[2] === '/retry') {
                        const body = await requestBody(request);
                        if (
                            Object.keys(body).some(key => !['request_id', 'policy'].includes(key)) ||
                            typeof body.request_id !== 'string' ||
                            (body.policy !== undefined && body.policy !== 'sample-timeout-v1')
                        )
                            throw new TypeError('retry request requires request_id and an optional supported policy');
                        return json(202, {
                            id: await execution.retry_run(id, body.request_id, body.policy as 'sample-timeout-v1' | undefined)
                        });
                    }
                    if (request.method === 'POST' && match[2] === '/baseline') {
                        const body = await requestBody(request);
                        if (Object.keys(body).length !== 1 || typeof body.target_id !== 'string')
                            throw new TypeError('baseline request must contain only target_id');
                        const baseline = service.create_run_baseline(id, body.target_id);
                        return baseline ? json(201, { baseline }) : json(404, { error: 'run not found' });
                    }
                    if (request.method === 'POST' && match[2] === '/cancel')
                        return execution.cancel_run(id) ? json(200, { ok: true }) : json(404, { error: 'run not found' });
                }
                return json(404, { error: 'not found' });
            }
            if (request.method === 'GET' && path === '/api/models') return json(200, { models: await service.models() });
            if (request.method === 'GET' && web_dir && !path.startsWith('/api/')) {
                const root = realpathSync(web_dir);
                let candidate: string;
                try {
                    candidate = realpathSync(resolve(root, path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '')));
                } catch {
                    return json(404, { error: 'not found' });
                }
                const inside = relative(root, candidate);
                const extension = extname(candidate);
                const mime: Record<string, string> = {
                    '.html': 'text/html',
                    '.css': 'text/css',
                    '.js': 'text/javascript',
                    '.svg': 'image/svg+xml',
                    '.png': 'image/png',
                    '.ico': 'image/x-icon'
                };
                if (inside && !inside.startsWith('..') && !inside.startsWith('/') && extension in mime && lstatSync(candidate).isFile()) {
                    // Magpie's allow-scripts iframe has an opaque origin. Modules and SVG
                    // masks need the same narrowly scoped Origin:null CORS headers as the API.
                    headers.set('Content-Type', mime[extension] + '; charset=utf-8');
                    return new Response(readFileSync(candidate), { status: 200, headers });
                }
            }
            return json(404, { error: 'not found' });
        } catch (error) {
            if (error instanceof Error && 'code' in error) return json(500, { error: 'storage error' });
            if (error instanceof BenchUnavailableError || service._bench_execution?._closing)
                return json(503, {
                    error: 'execution service unavailable; inspect storage and restart before submitting again'
                });
            // Validation errors originate in local validators, not arbitrary upstream exceptions.
            if (error instanceof TypeError || error instanceof SyntaxError) return json(400, { error: error.message });
            return json(500, { error: 'assessment service error' });
        }
    };
}
/** Start the loopback server inside the current Bun host; stop drains admitted calls. */
export async function startMiniBenchService(
    options: MiniBenchOptions
): Promise<{ port: number; service: BenchService; stop: () => Promise<void> }> {
    const configuredPort = options.port === undefined ? process.env.MAGPIE_BENCH_PORT : undefined;
    if (configuredPort !== undefined && !/^\d+$/.test(configuredPort)) throw new TypeError('LLM Mini Bench port is outside safety bounds');
    const port = options.port ?? Number(configuredPort ?? 3481);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('LLM Mini Bench port is outside safety bounds');
    const service = new BenchService(options);
    let server: ReturnType<typeof Bun.serve>;
    try {
        server = Bun.serve({
            hostname: '127.0.0.1',
            port,
            maxRequestBodySize: MAX_BODY,
            idleTimeout: 180,
            fetch: make_handler(service, options.web_dir ?? join(PROJECT_ROOT, 'web')),
            error: () =>
                new Response(JSON.stringify({ error: 'invalid HTTP request' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
                })
        });
    } catch (error) {
        await service.close();
        throw error;
    }
    // Start one-time legacy migration & cleanup in the background only after the port is claimed
    // so an older draining service on the same port never loses its files mid-flight.
    if (has_legacy_workspace(service.data_dir)) {
        void service.ensure_ready().catch(() => {});
    }
    let stopping: Promise<void> | null = null;
    return {
        port: server.port!,
        service,
        stop: () => (stopping ??= Promise.all([service.close(), server.stop()]).then(() => {}))
    };
}
/** Standalone service remains import-safe for embedding by the Magpie adapter. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
    if (argv.includes('--help')) {
        console.log(
            'Usage: bun benchmark/backend/mini_bench.ts [--port PORT] [--data-dir PATH] [--web-dir PATH]\nRequires MAGPIE_BENCH_TOKEN (at least 32 characters).'
        );
        return;
    }
    const options: MiniBenchOptions = { token: process.env.MAGPIE_BENCH_TOKEN ?? '' };
    for (let index = 0; index < argv.length; index++) {
        const name = argv[index],
            value = argv[++index];
        if (!value) throw new TypeError('LLM Mini Bench option requires a value');
        if (name === '--port') {
            if (!/^\d+$/.test(value)) throw new TypeError('LLM Mini Bench port must be an integer');
            options.port = Number(value);
        } else if (name === '--data-dir') options.data_dir = value;
        else if (name === '--web-dir') options.web_dir = value;
        else throw new TypeError('LLM Mini Bench unknown option');
    }
    const server = await startMiniBenchService(options);
    console.log('LLM Mini Bench listening on http://127.0.0.1:' + server.port);
    const stop = () => {
        void server.stop().then(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
}
if (import.meta.main)
    main().catch(() => {
        console.error('LLM Mini Bench service failed to start; check local configuration');
        process.exitCode = 1;
    });
