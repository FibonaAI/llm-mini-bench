import { Database } from 'bun:sqlite';
import { chmodSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { private_directory, canonicalStorageJson } from './bench_execution_storage.ts';
import type { RunCallSummary } from './bench_call_summaries.ts';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const integer = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const clone = <T>(value: T): T => structuredClone(value);

/** Single workspace SQLite database filename. */
export const BENCH_DB_FILENAME = 'mini-bench.sqlite';
export const BENCH_DB_SCHEMA_VERSION = '1';

export type SnapshotKind = 'bank' | 'tasks' | 'sources';
export type SessionEventKind = 'llm_turn' | 'tool_result' | 'api_retry' | 'grade' | 'worker_error';

export interface SessionEventRecord {
    run_id: string;
    sample_id: string;
    attempt_id: string;
    seq: number;
    kind: SessionEventKind;
    call_id?: string | null;
    turn?: number | null;
    api_attempt?: number | null;
    http_status?: number | null;
    elapsed_seconds?: number | null;
    usage_known?: boolean | null;
    input_tokens?: number | null;
    output_tokens?: number | null;
    estimated_cost_usd?: number | null;
    response_status?: string | null;
    error_code?: string | null;
    error_message?: string | null;
    local_exception?: string | null;
    terminal_event?: string | null;
    termination?: string | null;
    first_output_seconds?: number | null;
    last_progress_seconds?: number | null;
    payload?: RecordValue | null;
    created_at?: string;
}

export interface StoredSessionEvent {
    id: number;
    run_id: string;
    sample_id: string;
    attempt_id: string;
    seq: number;
    kind: SessionEventKind;
    call_id: string | null;
    turn: number | null;
    api_attempt: number | null;
    http_status: number | null;
    elapsed_seconds: number | null;
    usage_known: boolean | null;
    input_tokens: number | null;
    output_tokens: number | null;
    estimated_cost_usd: number | null;
    response_status: string | null;
    error_code: string | null;
    error_message: string | null;
    local_exception: string | null;
    terminal_event: string | null;
    termination: string | null;
    first_output_seconds: number | null;
    last_progress_seconds: number | null;
    payload: RecordValue | null;
    created_at: string;
}

export interface StoredBaselineRow {
    id: string;
    run_id: string;
    target_id: string;
    bank_version: string;
    model: string;
    provider_id: string | null;
    route_id: string | null;
    account_ref: string | null;
    thinking: string;
    created_at: string;
    payload_json: string;
}

export interface RunIndexCacheEntry {
    run_id: string;
    source_sig: string;
    updated_at: string;
    summary_json: string;
    observations_json: string;
    legacy_overlay_json: string | null;
}

export interface RunStartupRow {
    id: string;
    task_id: string | null;
    execution_kind: string | null;
    status: string;
    stop_reason: string | null;
    created_at: string;
    updated_at: string;
    cache_source_sig: string | null;
    cache_updated_at: string | null;
    summary_json: string | null;
    observations_json: string | null;
    legacy_overlay_json: string | null;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
    hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('bank', 'tasks', 'sources')),
    payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    stop_reason TEXT,
    bank_version TEXT NOT NULL,
    bank_scope TEXT NOT NULL,
    rounds INTEGER NOT NULL,
    sample_concurrency INTEGER NOT NULL,
    run_concurrency INTEGER NOT NULL,
    run_count INTEGER NOT NULL,
    samples_per_run INTEGER NOT NULL,
    total_max_cost_usd REAL,
    bank_hash TEXT NOT NULL,
    tasks_hash TEXT NOT NULL,
    sources_hash TEXT NOT NULL,
    targets_json TEXT NOT NULL,
    task_ids_json TEXT NOT NULL,
    limits_json TEXT NOT NULL,
    child_run_ids_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    execution_kind TEXT,
    status TEXT NOT NULL,
    stop_reason TEXT,
    bank_version TEXT NOT NULL,
    bank_scope TEXT NOT NULL,
    rounds INTEGER NOT NULL,
    round_start INTEGER,
    concurrency INTEGER,
    sample_count INTEGER NOT NULL,
    bank_hash TEXT NOT NULL,
    tasks_hash TEXT NOT NULL,
    sources_hash TEXT NOT NULL,
    targets_json TEXT NOT NULL,
    task_ids_json TEXT NOT NULL,
    limits_json TEXT NOT NULL,
    budget_json TEXT NOT NULL,
    retry_batches_json TEXT,
    imported_from_json TEXT,
    imported_sha256 TEXT,
    evidence_json TEXT,
    model TEXT,
    provider_id TEXT,
    route_id TEXT,
    account_ref TEXT,
    thinking TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_model ON runs(model);
CREATE INDEX IF NOT EXISTS idx_runs_imported_sha256 ON runs(imported_sha256);

CREATE TABLE IF NOT EXISTS samples (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    sample_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    route_id TEXT,
    account_ref TEXT,
    account_evidence TEXT,
    task TEXT NOT NULL,
    domain TEXT,
    model TEXT NOT NULL,
    thinking TEXT NOT NULL,
    round INTEGER NOT NULL,
    latest_attempt_id TEXT NOT NULL,
    status TEXT NOT NULL,
    ok INTEGER NOT NULL DEFAULT 0,
    score REAL,
    outcome TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    elapsed_seconds REAL,
    runner_error TEXT,
    started_at TEXT,
    finished_at TEXT,
    PRIMARY KEY (run_id, sample_id)
);
CREATE INDEX IF NOT EXISTS idx_samples_run_seq ON samples(run_id, seq);

CREATE TABLE IF NOT EXISTS attempts (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    sample_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    retry_batch_id TEXT,
    status TEXT NOT NULL,
    ok INTEGER NOT NULL DEFAULT 0,
    sources_hash TEXT,
    score REAL,
    outcome TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    elapsed_seconds REAL,
    api_request_count INTEGER,
    last_http_status INTEGER,
    runner_error TEXT,
    started_at TEXT,
    finished_at TEXT,
    detail_json TEXT NOT NULL,
    PRIMARY KEY (run_id, id)
);
CREATE INDEX IF NOT EXISTS idx_attempts_run_sample ON attempts(run_id, sample_id, seq);

CREATE TABLE IF NOT EXISTS session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    sample_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('llm_turn', 'tool_result', 'api_retry', 'grade', 'worker_error')),
    call_id TEXT,
    turn INTEGER,
    api_attempt INTEGER,
    http_status INTEGER,
    elapsed_seconds REAL,
    usage_known INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    estimated_cost_usd REAL,
    response_status TEXT,
    error_code TEXT,
    error_message TEXT,
    local_exception TEXT,
    terminal_event TEXT,
    termination TEXT,
    first_output_seconds REAL,
    last_progress_seconds REAL,
    payload_json TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_events_run_kind ON session_events(run_id, kind, id);
CREATE INDEX IF NOT EXISTS idx_session_events_attempt ON session_events(run_id, attempt_id, seq);

CREATE TABLE IF NOT EXISTS baselines (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    bank_version TEXT NOT NULL,
    model TEXT NOT NULL,
    provider_id TEXT,
    route_id TEXT,
    account_ref TEXT,
    thinking TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_baselines_created_at ON baselines(created_at);

CREATE TABLE IF NOT EXISTS run_index_cache (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    source_sig TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    observations_json TEXT NOT NULL,
    legacy_overlay_json TEXT
);
`;

function extractAttemptMetrics(record: RecordValue) {
    const grade = object(record.grade) ? record.grade : null;
    const usage = object(record.usage) ? record.usage : null;
    return {
        status: String(record.status ?? 'pending'),
        ok: record.ok === true ? 1 : 0,
        score: grade ? finite(grade.content_score) : null,
        outcome: grade ? text(grade.outcome) : null,
        input_tokens: usage ? integer(usage.input_tokens) : null,
        output_tokens: usage ? integer(usage.output_tokens) : null,
        cost_usd: finite(record.estimated_uncached_cost_usd),
        elapsed_seconds: finite(record.elapsed_seconds),
        api_request_count: integer(record.api_request_count),
        last_http_status: integer(record.last_http_status),
        runner_error: text(record.runner_error),
        started_at: text(record.started_at),
        finished_at: text(record.finished_at)
    };
}

function stableAttemptId(runId: string, sampleId: string, record: RecordValue, seq: number): string {
    return typeof record.attempt_id === 'string' && record.attempt_id.length > 0 ? record.attempt_id : `${runId}:${sampleId}:${seq}`;
}

/** Single-file SQLite store for tasks, runs, samples, immutable attempts, Pi Session events, and baselines. */
export class BenchDatabase {
    readonly path: string;
    readonly db: Database;
    private closed = false;
    private _baselines_revision = 0;
    private txDepth = 0;
    private readonly snapshotCache = new Map<string, unknown>();
    private readonly runSnapshotHashes = new Map<
        string,
        { bank: unknown; bankHash: string; tasks: unknown; tasksHash: string; sources: unknown; sourcesHash: string }
    >();
    private readonly stmtPutSnapshot;
    private readonly stmtGetSnapshot;
    private readonly stmtUpsertRun;
    private readonly stmtUpsertSample;
    private readonly stmtInsertHistoricalAttempt;
    private readonly stmtUpsertCurrentAttempt;
    private readonly stmtInsertSessionEvent;
    private readonly stmtUpsertIndexCache;
    private readonly stmtDeleteIndexCache;

    constructor(dbPath: string) {
        this.path = resolve(dbPath);
        private_directory(dirname(this.path));
        this.db = new Database(this.path, { create: true, strict: false });
        if (existsSync(this.path)) chmodSync(this.path, 0o600);
        this.db.run('PRAGMA journal_mode = WAL;');
        this.db.run('PRAGMA synchronous = NORMAL;');
        this.db.run('PRAGMA foreign_keys = ON;');
        this.db.run('PRAGMA busy_timeout = 5000;');
        this.db.run(SCHEMA_SQL);
        this.db.run('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)', ['schema_version', BENCH_DB_SCHEMA_VERSION]);
        // Ensure private permissions after WAL initialization.
        if (existsSync(this.path)) chmodSync(this.path, 0o600);

        this.stmtPutSnapshot = this.db.query('INSERT OR IGNORE INTO snapshots (hash, kind, payload_json) VALUES (?, ?, ?)');
        this.stmtGetSnapshot = this.db.query('SELECT payload_json FROM snapshots WHERE hash = ?');
        this.stmtUpsertRun = this.db.query(
            `INSERT INTO runs (
                id, task_id, execution_kind, status, stop_reason,
                bank_version, bank_scope, rounds, round_start, concurrency, sample_count,
                bank_hash, tasks_hash, sources_hash,
                targets_json, task_ids_json, limits_json, budget_json,
                retry_batches_json, imported_from_json, imported_sha256, evidence_json,
                model, provider_id, route_id, account_ref, thinking,
                created_at, updated_at
            ) VALUES (
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?
            )
            ON CONFLICT(id) DO UPDATE SET
                task_id = excluded.task_id,
                execution_kind = excluded.execution_kind,
                status = excluded.status,
                stop_reason = excluded.stop_reason,
                bank_version = excluded.bank_version,
                bank_scope = excluded.bank_scope,
                rounds = excluded.rounds,
                round_start = excluded.round_start,
                concurrency = excluded.concurrency,
                sample_count = excluded.sample_count,
                bank_hash = excluded.bank_hash,
                tasks_hash = excluded.tasks_hash,
                sources_hash = excluded.sources_hash,
                targets_json = excluded.targets_json,
                task_ids_json = excluded.task_ids_json,
                limits_json = excluded.limits_json,
                budget_json = excluded.budget_json,
                retry_batches_json = excluded.retry_batches_json,
                imported_from_json = excluded.imported_from_json,
                imported_sha256 = excluded.imported_sha256,
                evidence_json = excluded.evidence_json,
                model = excluded.model,
                provider_id = excluded.provider_id,
                route_id = excluded.route_id,
                account_ref = excluded.account_ref,
                thinking = excluded.thinking,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at`
        );
        this.stmtUpsertSample = this.db.query(
            `INSERT INTO samples (
                run_id, sample_id, seq, target_id, route_id, account_ref, account_evidence,
                task, domain, model, thinking, round, latest_attempt_id,
                status, ok, score, outcome, input_tokens, output_tokens, cost_usd,
                elapsed_seconds, runner_error, started_at, finished_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?
            )
            ON CONFLICT(run_id, sample_id) DO UPDATE SET
                seq = excluded.seq,
                target_id = excluded.target_id,
                route_id = excluded.route_id,
                account_ref = excluded.account_ref,
                account_evidence = excluded.account_evidence,
                task = excluded.task,
                domain = excluded.domain,
                model = excluded.model,
                thinking = excluded.thinking,
                round = excluded.round,
                latest_attempt_id = excluded.latest_attempt_id,
                status = excluded.status,
                ok = excluded.ok,
                score = excluded.score,
                outcome = excluded.outcome,
                input_tokens = excluded.input_tokens,
                output_tokens = excluded.output_tokens,
                cost_usd = excluded.cost_usd,
                elapsed_seconds = excluded.elapsed_seconds,
                runner_error = excluded.runner_error,
                started_at = excluded.started_at,
                finished_at = excluded.finished_at`
        );
        this.stmtInsertHistoricalAttempt = this.db.query(
            `INSERT OR IGNORE INTO attempts (
                run_id, id, sample_id, seq, retry_batch_id,
                status, ok, sources_hash, score, outcome,
                input_tokens, output_tokens, cost_usd, elapsed_seconds,
                api_request_count, last_http_status, runner_error,
                started_at, finished_at, detail_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        this.stmtUpsertCurrentAttempt = this.db.query(
            `INSERT INTO attempts (
                run_id, id, sample_id, seq, retry_batch_id,
                status, ok, sources_hash, score, outcome,
                input_tokens, output_tokens, cost_usd, elapsed_seconds,
                api_request_count, last_http_status, runner_error,
                started_at, finished_at, detail_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id, id) DO UPDATE SET
                seq = excluded.seq,
                status = excluded.status,
                ok = excluded.ok,
                sources_hash = excluded.sources_hash,
                score = excluded.score,
                outcome = excluded.outcome,
                input_tokens = excluded.input_tokens,
                output_tokens = excluded.output_tokens,
                cost_usd = excluded.cost_usd,
                elapsed_seconds = excluded.elapsed_seconds,
                api_request_count = excluded.api_request_count,
                last_http_status = excluded.last_http_status,
                runner_error = excluded.runner_error,
                started_at = excluded.started_at,
                finished_at = excluded.finished_at,
                detail_json = excluded.detail_json`
        );
        this.stmtInsertSessionEvent = this.db.query(
            `INSERT INTO session_events (
                run_id, sample_id, attempt_id, seq, kind,
                call_id, turn, api_attempt, http_status, elapsed_seconds,
                usage_known, input_tokens, output_tokens, estimated_cost_usd,
                response_status, error_code, error_message, local_exception,
                terminal_event, termination, first_output_seconds, last_progress_seconds,
                payload_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        this.stmtUpsertIndexCache = this.db.query(
            `INSERT INTO run_index_cache (
                run_id, source_sig, updated_at, summary_json, observations_json, legacy_overlay_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
                source_sig = excluded.source_sig,
                updated_at = excluded.updated_at,
                summary_json = excluded.summary_json,
                observations_json = excluded.observations_json,
                legacy_overlay_json = excluded.legacy_overlay_json`
        );
        this.stmtDeleteIndexCache = this.db.query('DELETE FROM run_index_cache WHERE run_id = ?');
    }

    get is_closed(): boolean {
        return this.closed;
    }

    get baselines_revision(): number {
        return this._baselines_revision;
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        try {
            this.db.close();
        } catch {
            /* Ignore double-close on shutdown. */
        }
    }

    /** Run multiple write operations inside a single SQLite transaction without nested savepoints. */
    run_in_transaction<T>(fn: () => T): T {
        if (this.txDepth > 0) return fn();
        this.txDepth++;
        try {
            const tx = this.db.transaction(fn);
            return tx();
        } finally {
            this.txDepth--;
        }
    }

    put_snapshot(kind: SnapshotKind, value: unknown): string {
        const json = canonicalStorageJson(value);
        const hash = createHash('sha256').update(json).digest('hex');
        if (!this.snapshotCache.has(hash)) {
            this.stmtPutSnapshot.run(hash, kind, json);
            this.snapshotCache.set(hash, JSON.parse(json));
        }
        return hash;
    }

    get_snapshot<T = unknown>(hash: string | null | undefined): T | undefined {
        if (!hash) return undefined;
        if (this.snapshotCache.has(hash)) return clone(this.snapshotCache.get(hash) as T);
        const row = this.stmtGetSnapshot.get(hash) as { payload_json: string } | null;
        if (!row) return undefined;
        const parsed = JSON.parse(row.payload_json) as T;
        this.snapshotCache.set(hash, parsed);
        return clone(parsed);
    }

    /** Atomically persist a run, its deduplicated plan snapshots, its samples, and immutable attempt rows. */
    save_run(run: RecordValue, dirtySampleIds?: ReadonlySet<string>): void {
        const plan = run.plan as RecordValue;
        const targets = Array.isArray(plan.targets) ? (plan.targets as RecordValue[]) : [];
        const primary = targets[0] ?? null;
        const samples = Array.isArray(run.samples) ? (run.samples as RecordValue[]) : [];
        const runId = String(run.id);
        const isDelta = dirtySampleIds !== undefined;

        this.run_in_transaction(() => {
            const cachedSnap = isDelta ? this.runSnapshotHashes.get(runId) : undefined;
            const bankObj = plan.bank_snapshot ?? {};
            const tasksObj = plan.task_snapshots ?? [];
            const sourcesObj = plan.source_sha256 ?? {};
            let bankHash: string, tasksHash: string, sourcesHash: string;
            if (cachedSnap && cachedSnap.bank === bankObj && cachedSnap.tasks === tasksObj && cachedSnap.sources === sourcesObj) {
                bankHash = cachedSnap.bankHash;
                tasksHash = cachedSnap.tasksHash;
                sourcesHash = cachedSnap.sourcesHash;
            } else {
                bankHash = this.put_snapshot('bank', bankObj);
                tasksHash = this.put_snapshot('tasks', tasksObj);
                sourcesHash = this.put_snapshot('sources', sourcesObj);
                this.runSnapshotHashes.set(runId, {
                    bank: bankObj,
                    bankHash,
                    tasks: tasksObj,
                    tasksHash,
                    sources: sourcesObj,
                    sourcesHash
                });
            }

            let compactBatches: string | null = null;
            if (Array.isArray(run.retry_batches)) {
                const batches = (run.retry_batches as RecordValue[]).map(batch => {
                    if (!object(batch)) return batch;
                    const { source_sha256, ...rest } = batch;
                    if (object(source_sha256)) {
                        return { ...rest, sources_hash: this.put_snapshot('sources', source_sha256) };
                    }
                    return rest;
                });
                compactBatches = JSON.stringify(batches);
            }

            const importedFrom = object(run.imported_from) ? run.imported_from : null;
            const importedSha = importedFrom && typeof importedFrom.sha256 === 'string' ? importedFrom.sha256 : null;

            this.stmtDeleteIndexCache.run(runId);
            this.stmtUpsertRun.run(
                runId,
                text(run.task_id),
                text(run.execution_kind),
                String(run.status),
                text(run.stop_reason),
                String(plan.bank_version ?? ''),
                String(plan.bank_scope ?? 'whole'),
                Number(plan.rounds ?? 1),
                integer(plan.round_start),
                integer(plan.concurrency),
                Number(plan.sample_count ?? samples.length),
                bankHash,
                tasksHash,
                sourcesHash,
                JSON.stringify(targets),
                JSON.stringify(plan.task_ids ?? []),
                JSON.stringify(plan.limits ?? {}),
                JSON.stringify(run.budget ?? {}),
                compactBatches,
                importedFrom ? JSON.stringify(importedFrom) : null,
                importedSha,
                run.evidence !== undefined ? JSON.stringify(run.evidence) : null,
                primary ? text(primary.model) : null,
                primary ? text(primary.provider_id) : null,
                primary ? text(primary.route_id) : null,
                primary ? text(primary.account_ref) : null,
                primary ? text(primary.thinking) : null,
                String(run.created_at ?? ''),
                String(run.updated_at ?? '')
            );

            for (let sampleIdx = 0; sampleIdx < samples.length; sampleIdx++) {
                const sample = samples[sampleIdx]!;
                const sampleId = String(sample.sample_id);
                if (isDelta && !dirtySampleIds.has(sampleId)) continue;
                const priorAttempts = Array.isArray(sample.attempts) ? (sample.attempts as RecordValue[]) : [];

                if (!isDelta) {
                    for (let idx = 0; idx < priorAttempts.length; idx++) {
                        const prev = priorAttempts[idx]!;
                        const attemptSeq = idx + 1;
                        const prevId = stableAttemptId(runId, sampleId, prev, attemptSeq);
                        const { retry_source_sha256: prevSrc, attempts: _nested, ...prevDetail } = prev;
                        const prevSrcHash = object(prevSrc) ? this.put_snapshot('sources', prevSrc) : null;
                        const m = extractAttemptMetrics(prev);
                        this.stmtInsertHistoricalAttempt.run(
                            runId,
                            prevId,
                            sampleId,
                            attemptSeq,
                            null,
                            m.status,
                            m.ok,
                            prevSrcHash,
                            m.score,
                            m.outcome,
                            m.input_tokens,
                            m.output_tokens,
                            m.cost_usd,
                            m.elapsed_seconds,
                            m.api_request_count,
                            m.last_http_status,
                            m.runner_error,
                            m.started_at,
                            m.finished_at,
                            JSON.stringify(prevDetail)
                        );
                    }
                }

                const latestSeq = priorAttempts.length + 1;
                const latestAttemptId = stableAttemptId(runId, sampleId, sample, latestSeq);
                const { attempts: _attempts, retry_source_sha256: curSrc, ...curDetail } = sample;
                const curSrcHash = object(curSrc) ? this.put_snapshot('sources', curSrc) : null;
                const metrics = extractAttemptMetrics(sample);

                this.stmtUpsertCurrentAttempt.run(
                    runId,
                    latestAttemptId,
                    sampleId,
                    latestSeq,
                    null,
                    metrics.status,
                    metrics.ok,
                    curSrcHash,
                    metrics.score,
                    metrics.outcome,
                    metrics.input_tokens,
                    metrics.output_tokens,
                    metrics.cost_usd,
                    metrics.elapsed_seconds,
                    metrics.api_request_count,
                    metrics.last_http_status,
                    metrics.runner_error,
                    metrics.started_at,
                    metrics.finished_at,
                    JSON.stringify(curDetail)
                );

                this.stmtUpsertSample.run(
                    runId,
                    sampleId,
                    sampleIdx,
                    String(sample.target_id ?? ''),
                    typeof sample.route_id === 'string' ? sample.route_id : null,
                    typeof sample.account_ref === 'string' ? sample.account_ref : null,
                    typeof sample.account_evidence === 'string' ? sample.account_evidence : null,
                    String(sample.task ?? ''),
                    text(sample.domain),
                    String(sample.model ?? ''),
                    String(sample.thinking ?? ''),
                    Number(sample.round ?? 1),
                    latestAttemptId,
                    metrics.status,
                    metrics.ok,
                    metrics.score,
                    metrics.outcome,
                    metrics.input_tokens,
                    metrics.output_tokens,
                    metrics.cost_usd,
                    metrics.elapsed_seconds,
                    metrics.runner_error,
                    metrics.started_at,
                    metrics.finished_at
                );
            }
        });
    }

    /** Release cached snapshot hash references once an active run reaches a terminal state. */
    forget_run_snapshot_hashes(runId: string): void {
        this.runSnapshotHashes.delete(runId);
    }

    /** Single startup query joining run metadata with cached terminal summaries and observations. */
    list_runs_for_startup(): RunStartupRow[] {
        return this.db
            .query(
                `SELECT
                    r.id, r.task_id, r.execution_kind, r.status, r.stop_reason, r.created_at, r.updated_at,
                    c.source_sig AS cache_source_sig,
                    c.updated_at AS cache_updated_at,
                    c.summary_json,
                    c.observations_json,
                    c.legacy_overlay_json
                 FROM runs r
                 LEFT JOIN run_index_cache c ON c.run_id = r.id
                 ORDER BY r.created_at ASC, r.id ASC`
            )
            .all() as RunStartupRow[];
    }

    save_run_index_cache(entry: RunIndexCacheEntry): void {
        this.stmtUpsertIndexCache.run(
            entry.run_id,
            entry.source_sig,
            entry.updated_at,
            entry.summary_json,
            entry.observations_json,
            entry.legacy_overlay_json
        );
    }

    save_run_index_cache_batch(entries: readonly RunIndexCacheEntry[]): void {
        if (!entries.length) return;
        this.run_in_transaction(() => {
            for (const entry of entries) this.save_run_index_cache(entry);
        });
    }

    delete_run_index_cache(runId: string): void {
        this.stmtDeleteIndexCache.run(runId);
    }

    has_run(id: string): boolean {
        return Boolean(this.db.query('SELECT 1 FROM runs WHERE id = ?').get(id));
    }

    list_run_ids(): string[] {
        const rows = this.db.query('SELECT id FROM runs ORDER BY created_at ASC, id ASC').all() as Array<{ id: string }>;
        return rows.map(row => row.id);
    }

    find_run_by_imported_sha256(sha256: string): string | null {
        const row = this.db.query('SELECT id FROM runs WHERE imported_sha256 = ? LIMIT 1').get(sha256) as { id: string } | null;
        return row ? row.id : null;
    }

    /** Hydrate a full ExecutionRun including deduplicated plan snapshots, samples, and attempt history. */
    load_run(id: string): RecordValue | null {
        const row = this.db.query('SELECT * FROM runs WHERE id = ?').get(id) as RecordValue | null;
        if (!row) return null;

        const bankSnapshot = this.get_snapshot<RecordValue>(row.bank_hash as string) ?? {};
        const taskSnapshots = this.get_snapshot<RecordValue[]>(row.tasks_hash as string) ?? [];
        const sourceSha256 = this.get_snapshot<Record<string, string>>(row.sources_hash as string) ?? {};

        const plan: RecordValue = {
            bank_version: row.bank_version,
            bank_scope: row.bank_scope,
            bank_snapshot: bankSnapshot,
            targets: JSON.parse(row.targets_json as string),
            task_ids: JSON.parse(row.task_ids_json as string),
            task_snapshots: taskSnapshots,
            rounds: row.rounds,
            ...(row.round_start !== null && row.round_start !== undefined ? { round_start: row.round_start } : {}),
            ...(row.concurrency !== null && row.concurrency !== undefined ? { concurrency: row.concurrency } : {}),
            limits: JSON.parse(row.limits_json as string),
            source_sha256: sourceSha256,
            sample_count: row.sample_count
        };

        const sampleRows = this.db
            .query('SELECT sample_id, latest_attempt_id FROM samples WHERE run_id = ? ORDER BY seq ASC')
            .all(id) as Array<{ sample_id: string; latest_attempt_id: string }>;

        const attemptRows = this.db
            .query('SELECT id, sample_id, seq, sources_hash, detail_json FROM attempts WHERE run_id = ? ORDER BY sample_id ASC, seq ASC')
            .all(id) as Array<{ id: string; sample_id: string; seq: number; sources_hash: string | null; detail_json: string }>;

        const bySample = new Map<string, Array<{ id: string; sources_hash: string | null; detail: RecordValue }>>();
        for (const a of attemptRows) {
            let list = bySample.get(a.sample_id);
            if (!list) {
                list = [];
                bySample.set(a.sample_id, list);
            }
            const detail = JSON.parse(a.detail_json) as RecordValue;
            if (a.sources_hash) {
                const retrySources = this.get_snapshot<Record<string, string>>(a.sources_hash);
                if (retrySources) detail.retry_source_sha256 = retrySources;
            }
            list.push({ id: a.id, sources_hash: a.sources_hash, detail });
        }

        const samples: RecordValue[] = [];
        for (const s of sampleRows) {
            const list = bySample.get(s.sample_id) ?? [];
            const latestIdx = list.findIndex(item => item.id === s.latest_attempt_id);
            const current = latestIdx >= 0 ? list[latestIdx]!.detail : list.at(-1)?.detail;
            if (!current) continue;
            const prior = list
                .filter((_, index) => (latestIdx >= 0 ? index !== latestIdx : index !== list.length - 1))
                .map(item => item.detail);
            if (prior.length > 0) current.attempts = prior;
            samples.push(current);
        }

        const run: RecordValue = {
            id: row.id,
            status: row.status,
            ...(row.task_id ? { task_id: row.task_id } : {}),
            ...(row.execution_kind ? { execution_kind: row.execution_kind } : {}),
            created_at: row.created_at,
            updated_at: row.updated_at,
            plan,
            samples,
            budget: JSON.parse(row.budget_json as string),
            stop_reason: row.stop_reason ?? null
        };

        if (typeof row.retry_batches_json === 'string') {
            const rawBatches = JSON.parse(row.retry_batches_json) as RecordValue[];
            run.retry_batches = rawBatches.map(batch => {
                if (!object(batch)) return batch;
                if (typeof batch.sources_hash === 'string') {
                    const { sources_hash, ...rest } = batch;
                    return { ...rest, source_sha256: this.get_snapshot(sources_hash) ?? {} };
                }
                return batch;
            });
        }
        if (typeof row.imported_from_json === 'string') run.imported_from = JSON.parse(row.imported_from_json);
        if (typeof row.evidence_json === 'string') run.evidence = JSON.parse(row.evidence_json);
        return run;
    }

    save_task(task: RecordValue): void {
        const plan = task.plan as RecordValue;
        this.run_in_transaction(() => {
            const bankHash = this.put_snapshot('bank', plan.bank_snapshot ?? {});
            const tasksHash = this.put_snapshot('tasks', plan.task_snapshots ?? []);
            const sourcesHash = this.put_snapshot('sources', plan.source_sha256 ?? {});
            this.db.run(
                `INSERT INTO tasks (
                    id, status, stop_reason, bank_version, bank_scope, rounds,
                    sample_concurrency, run_concurrency, run_count, samples_per_run, total_max_cost_usd,
                    bank_hash, tasks_hash, sources_hash,
                    targets_json, task_ids_json, limits_json, child_run_ids_json,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    status = excluded.status,
                    stop_reason = excluded.stop_reason,
                    bank_version = excluded.bank_version,
                    bank_scope = excluded.bank_scope,
                    rounds = excluded.rounds,
                    sample_concurrency = excluded.sample_concurrency,
                    run_concurrency = excluded.run_concurrency,
                    run_count = excluded.run_count,
                    samples_per_run = excluded.samples_per_run,
                    total_max_cost_usd = excluded.total_max_cost_usd,
                    bank_hash = excluded.bank_hash,
                    tasks_hash = excluded.tasks_hash,
                    sources_hash = excluded.sources_hash,
                    targets_json = excluded.targets_json,
                    task_ids_json = excluded.task_ids_json,
                    limits_json = excluded.limits_json,
                    child_run_ids_json = excluded.child_run_ids_json,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at`,
                [
                    String(task.id),
                    String(task.status),
                    text(task.stop_reason),
                    String(plan.bank_version ?? ''),
                    String(plan.bank_scope ?? 'whole'),
                    Number(plan.rounds ?? 1),
                    Number(plan.sample_concurrency ?? 6),
                    Number(plan.run_concurrency ?? 3),
                    Number(plan.run_count ?? 0),
                    Number(plan.samples_per_run ?? 0),
                    finite(plan.total_max_cost_usd),
                    bankHash,
                    tasksHash,
                    sourcesHash,
                    JSON.stringify(plan.targets ?? []),
                    JSON.stringify(plan.task_ids ?? []),
                    JSON.stringify(plan.limits ?? {}),
                    JSON.stringify(task.child_run_ids ?? []),
                    String(task.created_at ?? ''),
                    String(task.updated_at ?? '')
                ]
            );
        });
    }

    update_task_status(id: string, status: string, stop_reason: string | null, updated_at: string): void {
        this.db.run('UPDATE tasks SET status = ?, stop_reason = ?, updated_at = ? WHERE id = ?', [status, stop_reason, updated_at, id]);
    }

    load_task(id: string, includeProvenance = true): RecordValue | null {
        const row = this.db.query('SELECT * FROM tasks WHERE id = ?').get(id) as RecordValue | null;
        if (!row) return null;
        return this.hydrate_task_row(row, includeProvenance);
    }

    list_tasks(includeProvenance = false): RecordValue[] {
        const rows = this.db.query('SELECT * FROM tasks ORDER BY created_at ASC, id ASC').all() as RecordValue[];
        return rows.map(row => this.hydrate_task_row(row, includeProvenance));
    }

    private hydrate_task_row(row: RecordValue, includeProvenance: boolean): RecordValue {
        const plan: RecordValue = {
            bank_version: row.bank_version,
            bank_scope: row.bank_scope,
            targets: JSON.parse(row.targets_json as string),
            task_ids: JSON.parse(row.task_ids_json as string),
            rounds: row.rounds,
            limits: JSON.parse(row.limits_json as string),
            sample_count: Number(row.run_count) * Number(row.samples_per_run),
            sample_concurrency: row.sample_concurrency,
            run_concurrency: row.run_concurrency,
            run_count: row.run_count,
            samples_per_run: row.samples_per_run,
            total_max_cost_usd: row.total_max_cost_usd ?? null
        };
        if (includeProvenance) {
            plan.bank_snapshot = this.get_snapshot(row.bank_hash as string) ?? {};
            plan.task_snapshots = this.get_snapshot(row.tasks_hash as string) ?? [];
            plan.source_sha256 = this.get_snapshot(row.sources_hash as string) ?? {};
        } else {
            plan.provenance_omitted = true;
        }
        return {
            id: row.id,
            status: row.status,
            created_at: row.created_at,
            updated_at: row.updated_at,
            plan,
            child_run_ids: JSON.parse(row.child_run_ids_json as string),
            stop_reason: row.stop_reason ?? null
        };
    }

    insert_session_event(event: SessionEventRecord): void {
        this.stmtInsertSessionEvent.run(
            event.run_id,
            event.sample_id,
            event.attempt_id,
            event.seq,
            event.kind,
            event.call_id ?? null,
            event.turn ?? null,
            event.api_attempt ?? null,
            event.http_status ?? null,
            event.elapsed_seconds ?? null,
            event.usage_known === undefined || event.usage_known === null ? null : event.usage_known ? 1 : 0,
            event.input_tokens ?? null,
            event.output_tokens ?? null,
            event.estimated_cost_usd ?? null,
            event.response_status ?? null,
            event.error_code ?? null,
            event.error_message ?? null,
            event.local_exception ?? null,
            event.terminal_event ?? null,
            event.termination ?? null,
            event.first_output_seconds ?? null,
            event.last_progress_seconds ?? null,
            event.payload !== undefined && event.payload !== null ? JSON.stringify(event.payload) : null,
            event.created_at ?? new Date().toISOString()
        );
    }

    insert_session_events_batch(events: readonly SessionEventRecord[]): void {
        if (!events.length) return;
        this.run_in_transaction(() => {
            for (const event of events) this.insert_session_event(event);
        });
    }

    /** Direct indexed projection of per-call diagnostics without reading any raw bodies or streams. */
    read_run_call_summaries(runId: string): RunCallSummary[] {
        const rows = this.db
            .query(
                `SELECT call_id, sample_id, attempt_id, turn, api_attempt, http_status,
                        elapsed_seconds, usage_known, estimated_cost_usd, response_status,
                        error_code, error_message, local_exception, terminal_event,
                        termination, first_output_seconds, last_progress_seconds
                 FROM session_events
                 WHERE run_id = ? AND kind = 'llm_turn'
                 ORDER BY id ASC`
            )
            .all(runId) as Array<RecordValue>;
        return rows.map(row => ({
            call_id: String(row.call_id ?? ''),
            sample_id: String(row.sample_id ?? ''),
            attempt_id: typeof row.attempt_id === 'string' && row.attempt_id.length ? row.attempt_id : null,
            turn: finite(row.turn),
            api_attempt: finite(row.api_attempt),
            http_status: finite(row.http_status),
            elapsed_seconds: finite(row.elapsed_seconds),
            usage_known: row.usage_known === 1,
            estimated_cost_usd: finite(row.estimated_cost_usd),
            response_status: text(row.response_status),
            error_code: text(row.error_code),
            error_message: text(row.error_message),
            local_exception: text(row.local_exception),
            terminal_event: text(row.terminal_event),
            termination: text(row.termination),
            first_output_seconds: finite(row.first_output_seconds),
            last_progress_seconds: finite(row.last_progress_seconds)
        }));
    }

    read_run_session_events(runId: string, attemptId?: string): StoredSessionEvent[] {
        const rows = (
            attemptId
                ? this.db
                      .query('SELECT * FROM session_events WHERE run_id = ? AND attempt_id = ? ORDER BY seq ASC, id ASC')
                      .all(runId, attemptId)
                : this.db.query('SELECT * FROM session_events WHERE run_id = ? ORDER BY id ASC').all(runId)
        ) as Array<RecordValue>;
        return rows.map(row => ({
            id: Number(row.id),
            run_id: String(row.run_id),
            sample_id: String(row.sample_id),
            attempt_id: String(row.attempt_id),
            seq: Number(row.seq),
            kind: row.kind as SessionEventKind,
            call_id: text(row.call_id),
            turn: finite(row.turn),
            api_attempt: finite(row.api_attempt),
            http_status: finite(row.http_status),
            elapsed_seconds: finite(row.elapsed_seconds),
            usage_known: row.usage_known === null || row.usage_known === undefined ? null : row.usage_known === 1,
            input_tokens: integer(row.input_tokens),
            output_tokens: integer(row.output_tokens),
            estimated_cost_usd: finite(row.estimated_cost_usd),
            response_status: text(row.response_status),
            error_code: text(row.error_code),
            error_message: text(row.error_message),
            local_exception: text(row.local_exception),
            terminal_event: text(row.terminal_event),
            termination: text(row.termination),
            first_output_seconds: finite(row.first_output_seconds),
            last_progress_seconds: finite(row.last_progress_seconds),
            payload: typeof row.payload_json === 'string' ? (JSON.parse(row.payload_json) as RecordValue) : null,
            created_at: String(row.created_at)
        }));
    }

    has_session_events(runId: string): boolean {
        return Boolean(this.db.query('SELECT 1 FROM session_events WHERE run_id = ? LIMIT 1').get(runId));
    }

    save_baseline(baseline: RecordValue): void {
        const target = object(baseline.target) ? baseline.target : {};
        const payload = canonicalStorageJson(baseline);
        this.db.run(
            `INSERT INTO baselines (
                id, run_id, target_id, bank_version, model, provider_id, route_id, account_ref, thinking, created_at, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                run_id = excluded.run_id,
                target_id = excluded.target_id,
                bank_version = excluded.bank_version,
                model = excluded.model,
                provider_id = excluded.provider_id,
                route_id = excluded.route_id,
                account_ref = excluded.account_ref,
                thinking = excluded.thinking,
                created_at = excluded.created_at,
                payload_json = excluded.payload_json`,
            [
                String(baseline.id),
                String(baseline.run_id ?? ''),
                String(baseline.target_id ?? ''),
                String(baseline.bank_version ?? ''),
                String(target.model ?? ''),
                text(target.provider_id),
                text(target.route_id),
                text(target.account_ref),
                String(target.thinking ?? ''),
                String(baseline.created_at ?? ''),
                payload
            ]
        );
        this._baselines_revision++;
    }

    list_baseline_rows(): StoredBaselineRow[] {
        return this.db.query('SELECT * FROM baselines ORDER BY created_at ASC, id ASC').all() as StoredBaselineRow[];
    }

    list_baseline_metadata(): Array<{ id: string; payload_length: number }> {
        return this.db
            .query('SELECT id, length(payload_json) AS payload_length FROM baselines ORDER BY created_at ASC, id ASC')
            .all() as Array<{ id: string; payload_length: number }>;
    }
}
