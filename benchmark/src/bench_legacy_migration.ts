import {
    closeSync,
    createReadStream,
    existsSync,
    lstatSync,
    openSync,
    readdirSync,
    readFileSync,
    rmdirSync,
    rmSync,
    statSync,
    unlinkSync,
    writeFileSync
} from 'node:fs';
import { createGunzip } from 'node:zlib';
import { join, resolve } from 'node:path';
import { AssessmentBudget } from './assessment_runner.ts';
import { parseAssessmentJson } from './assessment_json.ts';
import { run_journal_path } from './bench_call_summaries.ts';
import { BENCH_DB_FILENAME, BenchDatabase, type SessionEventRecord } from './bench_db.ts';
import { is_timeout_sample } from './bench_execution_queries.ts';
import { build_session_event } from './bench_execution_storage.ts';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const STREAM_CHUNK_MARKER = Buffer.from('"type":"stream_chunk"');
const CHUNK_SIZE = 1 << 20;
const MIGRATION_LOCK_FILE = '.legacy-migration.lock';
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 100;

export interface LegacyMigrationOptions {
    dryRun?: boolean;
    cleanup?: boolean;
    db?: BenchDatabase;
    shouldAbort?: () => boolean;
}

export interface MigrationReport {
    data_dir: string;
    db_path: string;
    dry_run: boolean;
    cleanup: boolean;
    aborted: boolean;
    runs_found: number;
    runs_migrated: number;
    runs_skipped: number;
    runs_failed: number;
    tasks_found: number;
    tasks_migrated: number;
    tasks_skipped: number;
    tasks_failed: number;
    baselines_found: number;
    baselines_migrated: number;
    baselines_skipped: number;
    baselines_failed: number;
    samples_migrated: number;
    attempts_migrated: number;
    events_migrated: number;
    cleaned_runs: number;
    cleaned_tasks: number;
    cleaned_baselines: number;
    cleaned_cache_files: number;
    removed_dirs: string[];
    db_bytes: number;
}

function isNonSymlinkDir(path: string): boolean {
    try {
        const st = lstatSync(path);
        return !st.isSymbolicLink() && st.isDirectory();
    } catch {
        return false;
    }
}

function isNonSymlinkFile(path: string): boolean {
    try {
        const st = lstatSync(path);
        return !st.isSymbolicLink() && st.isFile();
    } catch {
        return false;
    }
}

/** Fast non-symlink check for legacy file-per-run workspace directories. */
export function has_legacy_workspace(dataDir: string): boolean {
    const root = resolve(dataDir);
    return isNonSymlinkDir(join(root, 'assessment')) || isNonSymlinkDir(join(root, 'assessment-baselines'));
}

function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return !(error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ESRCH');
    }
}

async function acquireMigrationLock(root: string, shouldAbort?: () => boolean): Promise<(() => void) | null> {
    const lockPath = join(root, MIGRATION_LOCK_FILE);
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
        if (shouldAbort?.()) return null;
        try {
            const fd = openSync(lockPath, 'wx', 0o600);
            try {
                writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + '\n');
            } finally {
                closeSync(fd);
            }
            return () => {
                try {
                    if (isNonSymlinkFile(lockPath)) unlinkSync(lockPath);
                } catch {
                    /* Ignore lock cleanup errors on exit. */
                }
            };
        } catch (error) {
            if (!(error instanceof Error && 'code' in error && (error as { code?: string }).code === 'EEXIST')) throw error;
            // Remove lock only if its owner PID is demonstrably dead or the file is malformed and stale.
            let stale = false;
            try {
                const raw = readFileSync(lockPath, 'utf8');
                const parsed = JSON.parse(raw) as { pid?: unknown };
                if (typeof parsed.pid === 'number' && !isProcessAlive(parsed.pid)) stale = true;
            } catch {
                try {
                    const st = lstatSync(lockPath);
                    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) stale = true;
                } catch {
                    continue;
                }
            }
            if (stale) {
                try {
                    unlinkSync(lockPath);
                } catch {
                    /* Another process already replaced or removed the lock. */
                }
                continue;
            }
            if (Date.now() >= deadline) throw new Error('another process is migrating this workspace');
            await new Promise(resolveWait => setTimeout(resolveWait, LOCK_POLL_MS));
        }
    }
}

/** Stream one plain or gzip legacy journal, skipping stream_chunk lines before JSON.parse. */
async function scanLegacyJournal(path: string, visit: (record: RecordValue) => void): Promise<void> {
    let pending: Buffer[] = [];
    const flush = (line: Buffer) => {
        if (!line.length || line.indexOf(STREAM_CHUNK_MARKER) >= 0) return;
        let parsed: unknown;
        try {
            parsed = JSON.parse(line.toString('utf8'));
        } catch {
            return; /* Ignore torn trailing line. */
        }
        if (object(parsed) && typeof parsed.type === 'string' && parsed.type !== 'stream_chunk') visit(parsed);
    };
    const source = createReadStream(path, { highWaterMark: CHUNK_SIZE });
    const stream: AsyncIterable<Buffer> = path.endsWith('.gz') ? source.pipe(createGunzip()) : source;
    try {
        for await (const chunk of stream) {
            let start = 0;
            for (let index = chunk.indexOf(10, start); index >= 0; index = chunk.indexOf(10, start)) {
                const part = chunk.subarray(start, index);
                flush(pending.length ? Buffer.concat([...pending, part]) : part);
                pending = [];
                start = index + 1;
            }
            if (start < chunk.length) pending.push(Buffer.from(chunk.subarray(start)));
        }
    } finally {
        source.destroy();
    }
    if (pending.length) flush(Buffer.concat(pending));
}

function journalPathsForRun(runDir: string): string[] {
    const paths: string[] = [];
    const main = run_journal_path(runDir);
    if (main) paths.push(main);
    for (const name of readdirSync(runDir)
        .filter(entry => /^retry-[0-9a-f]{32}$/.test(entry))
        .sort()) {
        const sub = run_journal_path(join(runDir, name));
        if (sub) paths.push(sub);
    }
    return paths;
}

function cleanupCacheFilesInDir(dir: string, patterns: RegExp[]): number {
    if (!isNonSymlinkDir(dir)) return 0;
    let removed = 0;
    for (const name of readdirSync(dir)) {
        if (!patterns.some(pattern => pattern.test(name))) continue;
        const target = join(dir, name);
        if (!isNonSymlinkFile(target)) continue;
        try {
            unlinkSync(target);
            removed++;
        } catch {
            /* Ignore transient unlink failure; directory check will keep dir intact if non-empty. */
        }
    }
    return removed;
}

function removeDirIfEmpty(dir: string): boolean {
    if (!isNonSymlinkDir(dir)) return false;
    const entries = readdirSync(dir);
    if (entries.length > 0) {
        // On macOS, Finder metadata should not keep an otherwise empty legacy directory around forever.
        if (entries.length === 1 && entries[0] === '.DS_Store' && isNonSymlinkFile(join(dir, '.DS_Store'))) {
            try {
                unlinkSync(join(dir, '.DS_Store'));
            } catch {
                return false;
            }
        } else {
            return false;
        }
    }
    try {
        rmdirSync(dir);
        return true;
    } catch {
        return false;
    }
}

/**
 * Migrate one legacy workspace (<data_dir>/assessment/ and <data_dir>/assessment-baselines/)
 * into <data_dir>/mini-bench.sqlite. When cleanup is true, deletes only items verified to be
 * durably stored in SQLite plus legacy cache/temp files and newly empty legacy directories.
 */
export async function migrate_legacy_workspace(
    dataDir: string,
    optionsOrDryRun: boolean | LegacyMigrationOptions = false
): Promise<MigrationReport> {
    const options: LegacyMigrationOptions = typeof optionsOrDryRun === 'boolean' ? { dryRun: optionsOrDryRun } : optionsOrDryRun;
    const dryRun = Boolean(options.dryRun);
    const cleanup = Boolean(options.cleanup) && !dryRun;
    const shouldAbort = options.shouldAbort;
    const root = resolve(dataDir);
    const assessmentDir = join(root, 'assessment');
    const tasksDir = join(assessmentDir, 'tasks');
    const baselinesDir = join(root, 'assessment-baselines');
    const dbPath = join(root, BENCH_DB_FILENAME);

    const report: MigrationReport = {
        data_dir: root,
        db_path: dbPath,
        dry_run: dryRun,
        cleanup,
        aborted: false,
        runs_found: 0,
        runs_migrated: 0,
        runs_skipped: 0,
        runs_failed: 0,
        tasks_found: 0,
        tasks_migrated: 0,
        tasks_skipped: 0,
        tasks_failed: 0,
        baselines_found: 0,
        baselines_migrated: 0,
        baselines_skipped: 0,
        baselines_failed: 0,
        samples_migrated: 0,
        attempts_migrated: 0,
        events_migrated: 0,
        cleaned_runs: 0,
        cleaned_tasks: 0,
        cleaned_baselines: 0,
        cleaned_cache_files: 0,
        removed_dirs: [],
        db_bytes: existsSync(dbPath) ? statSync(dbPath).size : 0
    };

    const hasAssessmentDir = isNonSymlinkDir(assessmentDir);
    const hasTasksDir = hasAssessmentDir && isNonSymlinkDir(tasksDir);
    const hasBaselinesDir = isNonSymlinkDir(baselinesDir);

    const runIds = hasAssessmentDir
        ? readdirSync(assessmentDir)
              .filter(name => {
                  if (!/^[a-f0-9]{32}$/.test(name)) return false;
                  const dir = join(assessmentDir, name);
                  return isNonSymlinkDir(dir) && isNonSymlinkFile(join(dir, 'run.json'));
              })
              .sort()
        : [];
    report.runs_found = runIds.length;

    const taskIds = hasTasksDir
        ? readdirSync(tasksDir)
              .filter(name => {
                  if (!/^[a-f0-9]{32}$/.test(name)) return false;
                  const dir = join(tasksDir, name);
                  return isNonSymlinkDir(dir) && isNonSymlinkFile(join(dir, 'task.json'));
              })
              .sort()
        : [];
    report.tasks_found = taskIds.length;

    const baselineFiles = hasBaselinesDir
        ? readdirSync(baselinesDir)
              .filter(name => name.endsWith('.json') && isNonSymlinkFile(join(baselinesDir, name)))
              .sort()
              .map(name => join(baselinesDir, name))
        : [];
    report.baselines_found = baselineFiles.length;

    if (dryRun) {
        if (options.db || existsSync(dbPath)) {
            const owned = !options.db;
            const db = options.db ?? new BenchDatabase(dbPath);
            try {
                for (const id of runIds) if (db.has_run(id)) report.runs_skipped++;
                for (const id of taskIds) if (db.load_task(id, false)) report.tasks_skipped++;
                const existingBaselines = new Set(db.list_baseline_rows().map(row => row.id));
                for (const file of baselineFiles) {
                    try {
                        const parsed = parseAssessmentJson(readFileSync(file, 'utf8'));
                        if (object(parsed) && typeof parsed.id === 'string' && existingBaselines.has(parsed.id)) report.baselines_skipped++;
                    } catch {
                        report.baselines_failed++;
                    }
                }
            } finally {
                if (owned) db.close();
            }
        }
        return report;
    }

    if (!hasAssessmentDir && !hasBaselinesDir) return report;
    if (shouldAbort?.()) {
        report.aborted = true;
        return report;
    }

    const releaseLock = await acquireMigrationLock(root, shouldAbort);
    if (!releaseLock) {
        report.aborted = true;
        return report;
    }
    const ownedDb = !options.db;
    let db: BenchDatabase | null = null;
    try {
        db = options.db ?? new BenchDatabase(dbPath);
        const verifiedRunIds: string[] = [];
        const verifiedTaskIds: string[] = [];
        const verifiedBaselineFiles: string[] = [];

        for (const runId of runIds) {
            if (shouldAbort?.()) {
                report.aborted = true;
                break;
            }
            if (db.has_run(runId)) {
                report.runs_skipped++;
                verifiedRunIds.push(runId);
                continue;
            }
            const runDir = join(assessmentDir, runId);
            let run: RecordValue;
            let events: SessionEventRecord[];
            let attemptsCount: number;
            try {
                const parsed = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as unknown;
                if (!object(parsed) || parsed.id !== runId || !Array.isArray(parsed.samples) || !object(parsed.plan)) {
                    report.runs_failed++;
                    continue;
                }
                const plan = parsed.plan;
                run = parsed;
                events = [];
                const seqByAttempt = new Map<string, number>();
                const callById = new Map<string, RecordValue>();
                const callUsage = new Map<string, { usage: { input_tokens: number; output_tokens: number }; cost: number | null }>();
                const budget = object(run.budget) ? run.budget : null;
                const needUncertainCost =
                    budget !== null && budget.uncertain_cost_reservation_usd === undefined && Number(budget.missing_cost_calls ?? 0) > 0;
                let uncertainCost = 0;
                let missingCostCount = 0;
                const targets = Array.isArray(plan.targets) ? (plan.targets as RecordValue[]) : [];

                for (const journalPath of journalPathsForRun(runDir)) {
                    await scanLegacyJournal(journalPath, row => {
                        const sampleId = typeof row.sample_id === 'string' ? row.sample_id : '';
                        const attemptId =
                            typeof row.attempt_id === 'string' && row.attempt_id.length > 0 ? row.attempt_id : `${runId}:${sampleId}:1`;
                        const seq = (seqByAttempt.get(attemptId) ?? 0) + 1;
                        seqByAttempt.set(attemptId, seq);
                        const event = build_session_event(row, runId, seq, attemptId);
                        if (event) events.push(event);

                        if (row.type === 'call') {
                            const callId = String(row.call_id ?? '');
                            callById.set(callId, row);
                            const raw = object(row.raw_response) ? row.raw_response : null;
                            const usage = raw && object(raw.usage) ? raw.usage : null;
                            if (
                                usage &&
                                typeof usage.input_tokens === 'number' &&
                                Number.isSafeInteger(usage.input_tokens) &&
                                usage.input_tokens >= 0 &&
                                typeof usage.output_tokens === 'number' &&
                                Number.isSafeInteger(usage.output_tokens) &&
                                usage.output_tokens >= 0
                            ) {
                                callUsage.set(callId, {
                                    usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
                                    cost:
                                        typeof row.estimated_uncached_cost_usd === 'number' &&
                                        Number.isFinite(row.estimated_uncached_cost_usd)
                                            ? row.estimated_uncached_cost_usd
                                            : null
                                });
                            }
                            if (needUncertainCost && row.estimated_uncached_cost_usd === null) {
                                const target = targets.find(item => item.id === row.target_id);
                                if (target && object(target.pricing) && object(row.request)) {
                                    const res = new AssessmentBudget(Infinity, 1).admit(
                                        row.request,
                                        target.pricing as { prompt: number; completion: number }
                                    );
                                    if (res !== null) {
                                        uncertainCost += res;
                                        missingCostCount++;
                                    }
                                }
                            }
                        }
                    });
                }

                if (needUncertainCost && budget && missingCostCount === Number(budget.missing_cost_calls ?? 0)) {
                    budget.uncertain_cost_reservation_usd = uncertainCost;
                }

                // Apply legacy outcome/usage normalization when migrating so migrated runs match runtime projections.
                const samples = run.samples as RecordValue[];
                if (run.status === 'failed') {
                    for (const sample of samples) {
                        if (sample.status === 'response_incomplete_or_error') {
                            const ids = Array.isArray(sample.calls) ? sample.calls : [];
                            const last = callById.get(String(ids.at(-1)));
                            sample.status =
                                last && (last.http_status !== 200 || (object(last.raw_response) && !!last.raw_response.error))
                                    ? 'api_failure'
                                    : 'incomplete';
                        }
                    }
                    if (
                        !samples.some(
                            sample =>
                                ['api_failure', 'worker_error', 'storage_error'].includes(String(sample.status)) &&
                                !is_timeout_sample(sample)
                        )
                    ) {
                        run.status =
                            samples.length && samples.every(sample => sample.status === 'completed' || is_timeout_sample(sample))
                                ? 'completed'
                                : 'incomplete';
                    }
                }

                attemptsCount = 0;
                for (const sample of samples) {
                    attemptsCount += 1 + (Array.isArray(sample.attempts) ? sample.attempts.length : 0);
                    if (!object(sample.usage) && object(sample.latest_attempt_usage))
                        sample.usage = structuredClone(sample.latest_attempt_usage);
                    if (
                        typeof sample.estimated_uncached_cost_usd !== 'number' &&
                        typeof sample.latest_attempt_cost_usd === 'number' &&
                        Number.isFinite(sample.latest_attempt_cost_usd)
                    )
                        sample.estimated_uncached_cost_usd = sample.latest_attempt_cost_usd;

                    if (
                        (sample.status === 'completed' || is_timeout_sample(sample)) &&
                        (!object(sample.usage) || typeof sample.estimated_uncached_cost_usd !== 'number')
                    ) {
                        const ids = Array.isArray(sample.calls) ? (sample.calls as string[]) : [];
                        const known = ids
                            .map(callId => callUsage.get(String(callId)))
                            .filter((item): item is { usage: { input_tokens: number; output_tokens: number }; cost: number | null } =>
                                Boolean(item)
                            );
                        if (known.length > 0 || is_timeout_sample(sample)) {
                            const usage = known.reduce(
                                (acc, item) => ({
                                    input_tokens: acc.input_tokens + item.usage.input_tokens,
                                    output_tokens: acc.output_tokens + item.usage.output_tokens
                                }),
                                { input_tokens: 0, output_tokens: 0 }
                            );
                            const target = targets.find(item => item.id === sample.target_id);
                            const pricing =
                                target && object(target.pricing) ? (target.pricing as { prompt: number; completion: number }) : null;
                            const cost = known.every(item => item.cost !== null)
                                ? known.reduce((acc, item) => acc + (item.cost ?? 0), 0)
                                : pricing
                                  ? usage.input_tokens * pricing.prompt + usage.output_tokens * pricing.completion
                                  : null;
                            if (!object(sample.usage)) sample.usage = usage;
                            if (Object.hasOwn(sample, 'latest_attempt_usage') && !object(sample.latest_attempt_usage))
                                sample.latest_attempt_usage = structuredClone(usage);
                            if (typeof sample.estimated_uncached_cost_usd !== 'number' && cost !== null)
                                sample.estimated_uncached_cost_usd = cost;
                            if (
                                Object.hasOwn(sample, 'latest_attempt_cost_usd') &&
                                typeof sample.latest_attempt_cost_usd !== 'number' &&
                                cost !== null
                            )
                                sample.latest_attempt_cost_usd = cost;
                        }
                    }
                }

                if (budget) {
                    const sampleCosts = samples
                        .map(sample => sample.estimated_uncached_cost_usd)
                        .filter((cost): cost is number => typeof cost === 'number' && Number.isFinite(cost) && cost >= 0);
                    const totalKnownCost = sampleCosts.reduce((sum, cost) => sum + cost, 0);
                    if (totalKnownCost > Number(budget.known_cost_lower_bound_usd ?? 0)) {
                        budget.known_cost_lower_bound_usd = totalKnownCost;
                    }
                }
            } catch {
                // Keep corrupted or unreadable legacy run directories intact on disk.
                report.runs_failed++;
                continue;
            }

            // SQLite writes stay outside per-item catch so disk/database errors fail closed without deleting files.
            db.run_in_transaction(() => {
                db!.save_run(run);
                db!.insert_session_events_batch(events);
            });
            report.runs_migrated++;
            report.samples_migrated += (run.samples as RecordValue[]).length;
            report.attempts_migrated += attemptsCount;
            report.events_migrated += events.length;
            verifiedRunIds.push(runId);
        }

        if (!report.aborted) {
            for (const taskId of taskIds) {
                if (shouldAbort?.()) {
                    report.aborted = true;
                    break;
                }
                if (db.load_task(taskId, false)) {
                    report.tasks_skipped++;
                    verifiedTaskIds.push(taskId);
                    continue;
                }
                let task: RecordValue;
                try {
                    const parsed = JSON.parse(readFileSync(join(tasksDir, taskId, 'task.json'), 'utf8')) as unknown;
                    if (
                        !object(parsed) ||
                        parsed.id !== taskId ||
                        !Array.isArray(parsed.child_run_ids) ||
                        !parsed.child_run_ids.length ||
                        parsed.child_run_ids.some(child => typeof child !== 'string' || !db!.has_run(child))
                    ) {
                        report.tasks_failed++;
                        continue;
                    }
                    task = parsed;
                } catch {
                    report.tasks_failed++;
                    continue;
                }
                db.save_task(task);
                report.tasks_migrated++;
                verifiedTaskIds.push(taskId);
            }
        }

        if (!report.aborted) {
            const existingBaselines = new Set(db.list_baseline_rows().map(row => row.id));
            for (const file of baselineFiles) {
                if (shouldAbort?.()) {
                    report.aborted = true;
                    break;
                }
                let parsed: unknown;
                try {
                    parsed = parseAssessmentJson(readFileSync(file, 'utf8'));
                } catch {
                    report.baselines_failed++;
                    continue;
                }
                if (!object(parsed) || typeof parsed.id !== 'string' || !parsed.id) {
                    report.baselines_failed++;
                    continue;
                }
                if (existingBaselines.has(parsed.id)) {
                    report.baselines_skipped++;
                    verifiedBaselineFiles.push(file);
                    continue;
                }
                db.save_baseline(parsed);
                existingBaselines.add(parsed.id);
                report.baselines_migrated++;
                verifiedBaselineFiles.push(file);
            }
        }

        // Checkpoint WAL into the main DB file before any cleanup so SQLite holds durable state on disk.
        db.db.run('PRAGMA wal_checkpoint(TRUNCATE);');

        if (cleanup && !report.aborted) {
            for (const runId of verifiedRunIds) {
                if (!db.has_run(runId)) continue;
                rmSync(join(assessmentDir, runId), { recursive: true, force: true });
                report.cleaned_runs++;
            }
            for (const taskId of verifiedTaskIds) {
                if (!db.load_task(taskId, false)) continue;
                rmSync(join(tasksDir, taskId), { recursive: true, force: true });
                report.cleaned_tasks++;
            }
            for (const file of verifiedBaselineFiles) {
                if (!isNonSymlinkFile(file)) continue;
                unlinkSync(file);
                report.cleaned_baselines++;
            }
            report.cleaned_cache_files += cleanupCacheFilesInDir(assessmentDir, [
                /^\.run-index-cache\.json$/,
                /^\.run-index-cache-[0-9a-f]{32}$/,
                /^\.tmp-[0-9a-f]{32}$/
            ]);
            report.cleaned_cache_files += cleanupCacheFilesInDir(tasksDir, [/^\.tmp-[0-9a-f]{32}$/]);
            report.cleaned_cache_files += cleanupCacheFilesInDir(baselinesDir, [/^\.tmp-[0-9a-f]{32}$/]);

            if (removeDirIfEmpty(tasksDir)) report.removed_dirs.push(tasksDir);
            if (removeDirIfEmpty(assessmentDir)) report.removed_dirs.push(assessmentDir);
            if (removeDirIfEmpty(baselinesDir)) report.removed_dirs.push(baselinesDir);
        }
    } finally {
        if (ownedDb && db) db.close();
        releaseLock();
    }

    report.db_bytes = existsSync(dbPath) ? statSync(dbPath).size : 0;
    return report;
}
