import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AssessmentBudget } from '../src/assessment_runner.ts';
import { parseAssessmentJson } from '../src/assessment_json.ts';
import { run_journal_path } from '../src/bench_call_summaries.ts';
import { BENCH_DB_FILENAME, BenchDatabase, type SessionEventRecord } from '../src/bench_db.ts';
import { is_timeout_sample } from '../src/bench_execution_queries.ts';
import { build_session_event } from '../src/bench_execution_storage.ts';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const STREAM_CHUNK_MARKER = Buffer.from('"type":"stream_chunk"');
const CHUNK_SIZE = 1 << 20;

const HELP = `Usage: bun benchmark/tools/migrate_legacy_storage.ts [--data-dir DIR] [--dry-run]
Migrate legacy file-per-run workspaces (<data-dir>/assessment/ and <data-dir>/assessment-baselines/)
into the single SQLite database (<data-dir>/mini-bench.sqlite).
Preserves all runs, tasks, samples, immutable attempt histories, compact Pi Session events (calls,
tool results, retries, grades), and baselines while discarding raw SSE stream chunks, duplicated
source/*.ts snapshots, run-before.json archives, and .run-index-cache.json.
Legacy files are NEVER modified or deleted. Re-running is idempotent.
  --data-dir DIR   Workspace root (default MAGPIE_BENCH_DATA_DIR or ~/.local/share/magpie-mini-bench)
  --dry-run        Inspect legacy workspace and report what would be migrated without writing SQLite`;

export interface MigrationReport {
    data_dir: string;
    db_path: string;
    dry_run: boolean;
    runs_found: number;
    runs_migrated: number;
    runs_skipped: number;
    tasks_found: number;
    tasks_migrated: number;
    tasks_skipped: number;
    baselines_found: number;
    baselines_migrated: number;
    baselines_skipped: number;
    samples_migrated: number;
    attempts_migrated: number;
    events_migrated: number;
    db_bytes: number;
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

/** Migrate one legacy workspace into <data_dir>/mini-bench.sqlite without modifying legacy files. */
export async function migrate_legacy_workspace(dataDir: string, dryRun = false): Promise<MigrationReport> {
    const root = resolve(dataDir);
    const assessmentDir = join(root, 'assessment');
    const tasksDir = join(assessmentDir, 'tasks');
    const baselinesDir = join(root, 'assessment-baselines');
    const dbPath = join(root, BENCH_DB_FILENAME);

    const report: MigrationReport = {
        data_dir: root,
        db_path: dbPath,
        dry_run: dryRun,
        runs_found: 0,
        runs_migrated: 0,
        runs_skipped: 0,
        tasks_found: 0,
        tasks_migrated: 0,
        tasks_skipped: 0,
        baselines_found: 0,
        baselines_migrated: 0,
        baselines_skipped: 0,
        samples_migrated: 0,
        attempts_migrated: 0,
        events_migrated: 0,
        db_bytes: existsSync(dbPath) ? statSync(dbPath).size : 0
    };

    const runIds = existsSync(assessmentDir)
        ? readdirSync(assessmentDir)
              .filter(name => {
                  if (!/^[a-f0-9]{32}$/.test(name)) return false;
                  const dir = join(assessmentDir, name);
                  return !lstatSync(dir).isSymbolicLink() && lstatSync(dir).isDirectory() && existsSync(join(dir, 'run.json'));
              })
              .sort()
        : [];
    report.runs_found = runIds.length;

    const taskIds = existsSync(tasksDir)
        ? readdirSync(tasksDir)
              .filter(name => {
                  if (!/^[a-f0-9]{32}$/.test(name)) return false;
                  const dir = join(tasksDir, name);
                  return !lstatSync(dir).isSymbolicLink() && lstatSync(dir).isDirectory() && existsSync(join(dir, 'task.json'));
              })
              .sort()
        : [];
    report.tasks_found = taskIds.length;

    const baselineFiles = existsSync(baselinesDir)
        ? readdirSync(baselinesDir)
              .filter(name => name.endsWith('.json'))
              .sort()
              .map(name => join(baselinesDir, name))
        : [];
    report.baselines_found = baselineFiles.length;

    if (dryRun) {
        if (existsSync(dbPath)) {
            const db = new BenchDatabase(dbPath);
            try {
                for (const id of runIds) if (db.has_run(id)) report.runs_skipped++;
                for (const id of taskIds) if (db.load_task(id, false)) report.tasks_skipped++;
                const existingBaselines = new Set(db.list_baseline_rows().map(row => row.id));
                for (const file of baselineFiles) {
                    try {
                        const parsed = parseAssessmentJson(readFileSync(file, 'utf8'));
                        if (object(parsed) && typeof parsed.id === 'string' && existingBaselines.has(parsed.id)) report.baselines_skipped++;
                    } catch {
                        /* Invalid baseline file counted as skipped in dry-run. */
                    }
                }
            } finally {
                db.close();
            }
        }
        return report;
    }

    const db = new BenchDatabase(dbPath);
    try {
        for (const runId of runIds) {
            if (db.has_run(runId)) {
                report.runs_skipped++;
                continue;
            }
            const runDir = join(assessmentDir, runId);
            const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as RecordValue;
            if (!object(run) || run.id !== runId || !Array.isArray(run.samples) || !object(run.plan)) continue;

            const events: SessionEventRecord[] = [];
            const seqByAttempt = new Map<string, number>();
            const callById = new Map<string, RecordValue>();
            const callUsage = new Map<string, { usage: { input_tokens: number; output_tokens: number }; cost: number | null }>();
            const budget = object(run.budget) ? run.budget : null;
            const needUncertainCost =
                budget !== null && budget.uncertain_cost_reservation_usd === undefined && Number(budget.missing_cost_calls ?? 0) > 0;
            let uncertainCost = 0;
            let missingCostCount = 0;
            const targets = Array.isArray(run.plan.targets) ? (run.plan.targets as RecordValue[]) : [];

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
                                    typeof row.estimated_uncached_cost_usd === 'number' && Number.isFinite(row.estimated_uncached_cost_usd)
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
                            ['api_failure', 'worker_error', 'storage_error'].includes(String(sample.status)) && !is_timeout_sample(sample)
                    )
                ) {
                    run.status =
                        samples.length && samples.every(sample => sample.status === 'completed' || is_timeout_sample(sample))
                            ? 'completed'
                            : 'incomplete';
                }
            }

            let attemptsCount = 0;
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

            db.save_run(run);
            db.insert_session_events_batch(events);
            report.runs_migrated++;
            report.samples_migrated += samples.length;
            report.attempts_migrated += attemptsCount;
            report.events_migrated += events.length;
        }

        for (const taskId of taskIds) {
            if (db.load_task(taskId, false)) {
                report.tasks_skipped++;
                continue;
            }
            const task = JSON.parse(readFileSync(join(tasksDir, taskId, 'task.json'), 'utf8')) as RecordValue;
            if (!object(task) || task.id !== taskId || !Array.isArray(task.child_run_ids) || !task.child_run_ids.length) continue;
            if (task.child_run_ids.some(child => typeof child !== 'string' || !db.has_run(child))) continue;
            db.save_task(task);
            report.tasks_migrated++;
        }

        const existingBaselines = new Set(db.list_baseline_rows().map(row => row.id));
        for (const file of baselineFiles) {
            try {
                const parsed = parseAssessmentJson(readFileSync(file, 'utf8'));
                if (!object(parsed) || typeof parsed.id !== 'string' || !parsed.id) continue;
                if (existingBaselines.has(parsed.id)) {
                    report.baselines_skipped++;
                    continue;
                }
                db.save_baseline(parsed);
                existingBaselines.add(parsed.id);
                report.baselines_migrated++;
            } catch {
                /* Skip malformed baseline files without halting migration. */
            }
        }
        // Checkpoint WAL into the main DB file so size reporting is accurate.
        db.db.run('PRAGMA wal_checkpoint(TRUNCATE);');
    } finally {
        db.close();
    }

    report.db_bytes = existsSync(dbPath) ? statSync(dbPath).size : 0;
    return report;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
    const { values } = parseArgs({
        args: argv,
        options: {
            'data-dir': { type: 'string' },
            'dry-run': { type: 'boolean' },
            help: { type: 'boolean' }
        }
    });
    if (values.help) {
        console.log(HELP);
        return 0;
    }
    const dataDir = resolve(values['data-dir'] ?? process.env.MAGPIE_BENCH_DATA_DIR ?? join(homedir(), '.local/share/magpie-mini-bench'));
    const report = await migrate_legacy_workspace(dataDir, Boolean(values['dry-run']));
    const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    if (report.dry_run) {
        console.log(
            `Dry run for ${report.data_dir}: found ${report.runs_found} runs (${report.runs_skipped} already in SQLite), ` +
                `${report.tasks_found} tasks (${report.tasks_skipped} already in SQLite), ` +
                `${report.baselines_found} baselines (${report.baselines_skipped} already in SQLite).`
        );
    } else {
        console.log(
            `Migrated into ${report.db_path} (${mb(report.db_bytes)}): ` +
                `${report.runs_migrated}/${report.runs_found} runs (${report.runs_skipped} skipped), ` +
                `${report.tasks_migrated}/${report.tasks_found} tasks (${report.tasks_skipped} skipped), ` +
                `${report.baselines_migrated}/${report.baselines_found} baselines (${report.baselines_skipped} skipped), ` +
                `${report.samples_migrated} samples, ${report.attempts_migrated} attempts, ${report.events_migrated} session events.`
        );
    }
    return 0;
}

if (import.meta.main) {
    main().then(
        code => {
            process.exitCode = code;
        },
        error => {
            console.error((error as Error).message);
            process.exitCode = 2;
        }
    );
}
