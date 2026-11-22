import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseAssessmentJson } from '../src/assessment_json.ts';
import { BENCH_DB_FILENAME, BenchDatabase, type SessionEventRecord } from '../src/bench_db.ts';
import { build_session_event } from '../src/bench_execution_storage.ts';

/** Marks runs converted from standalone calibration journals: read-only, never retried, never promoted. */
export const CALIBRATION_IMPORT_KIND = 'calibration-import-v1';

type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const HELP = `Usage: bun benchmark/tools/import_calibration.ts --input FILE [--data-dir DIR]
Convert one calibrate_assessment.ts JSONL journal into a read-only SQLite workspace run so the task page
and analysis page can show it. Structured session events (calls, tool results, retries, grades) are stored
in mini-bench.sqlite without copying raw SSE streams. Targets carry no route identity, so imports can never
be retried or promoted to baselines. Experimental banks stay off the production chart. Reload the plugin or
restart the service afterwards.
  --data-dir DIR   Workspace root (default MAGPIE_BENCH_DATA_DIR or ~/.local/share/magpie-mini-bench)`;

/** Build the run record from journal rows; pure so it can be tested without a workspace. */
export function calibration_run(rows: readonly Row[], id: string, source: { file: string; sha256: string }): Row {
    const metadata = rows[0];
    if (
        !object(metadata) ||
        metadata.type !== 'metadata' ||
        !Array.isArray(metadata.targets) ||
        !Array.isArray(metadata.tasks) ||
        !object(metadata.bank)
    )
        throw new TypeError('Calibration import: the first line must be calibration metadata');
    const targets = (metadata.targets as Row[]).map((target, index) => {
        if (!object(target) || typeof target.model !== 'string' || typeof target.thinking !== 'string')
            throw new TypeError('Calibration import: malformed target');
        return {
            id: `target-${index + 1}`,
            model: target.model,
            thinking: target.thinking,
            label: target.model,
            route_id: null,
            account_ref: null,
            account_evidence: 'calibration_cli'
        };
    });
    const targetId = (model: unknown, thinking: unknown) =>
        targets.find(target => target.model === model && target.thinking === thinking)?.id;
    const samples = rows
        .filter(row => row.type === 'observation')
        .map(row => {
            const target_id = targetId(row.model, row.thinking);
            if (!target_id) throw new TypeError('Calibration import: observation for an undeclared target');
            const { type: _type, ...sample } = row;
            return { ...sample, run_id: id, target_id, route_id: null, account_ref: null, account_evidence: 'calibration_cli' } as Row;
        });
    const summary = [...rows].reverse().find(row => row.type === 'summary');
    const planned = Number(metadata.planned_samples ?? samples.length);
    const status = !summary
        ? 'interrupted'
        : samples.length === planned && samples.every(sample => sample.status === 'completed')
          ? 'completed'
          : samples.some(sample => sample.status === 'api_failure')
            ? 'failed'
            : 'incomplete';
    const bank = metadata.bank as Row;
    const tasks = metadata.tasks as Row[];
    return {
        id,
        status,
        execution_kind: CALIBRATION_IMPORT_KIND,
        created_at: typeof metadata.created_at === 'string' ? metadata.created_at : new Date().toISOString(),
        updated_at: new Date().toISOString(),
        stop_reason: object(summary) ? (summary.stop_reason ?? null) : 'journal_ended_without_summary',
        imported_from: source,
        plan: {
            bank_version: bank.version,
            bank_scope: metadata.bank_scope ?? 'subset',
            bank_snapshot: bank,
            task_ids: tasks.map(task => task.id),
            task_snapshots: tasks,
            source_sha256: metadata.source_sha256 ?? {},
            targets,
            rounds: metadata.rounds,
            round_start: metadata.round_start ?? 1,
            limits: metadata.config ?? {},
            sample_count: planned
        },
        budget: {
            estimated_uncached_cost_usd: object(summary) ? (summary.estimated_uncached_cost_usd ?? null) : null,
            known_cost_lower_bound_usd: object(summary) ? (summary.known_cost_lower_bound_usd ?? null) : null,
            requests: object(summary) ? (summary.requests ?? null) : null,
            stop_reason: object(summary) ? (summary.stop_reason ?? null) : null
        },
        samples
    };
}

/** Extract compact Pi Session-style events from calibration journal rows (excluding stream_chunk). */
export function calibration_session_events(rows: readonly Row[], runId: string): SessionEventRecord[] {
    const seqByAttempt = new Map<string, number>();
    const events: SessionEventRecord[] = [];
    for (const row of rows) {
        if (!object(row) || row.type === 'metadata' || row.type === 'summary' || row.type === 'stream_chunk') continue;
        const sampleId = typeof row.sample_id === 'string' ? row.sample_id : '';
        const attemptId = typeof row.attempt_id === 'string' && row.attempt_id.length > 0 ? row.attempt_id : `${runId}:${sampleId}:1`;
        const seq = (seqByAttempt.get(attemptId) ?? 0) + 1;
        seqByAttempt.set(attemptId, seq);
        const event = build_session_event(row, runId, seq, attemptId);
        if (event) events.push(event);
    }
    return events;
}

export function main(argv = process.argv.slice(2)): number {
    const { values } = parseArgs({
        args: argv,
        options: { input: { type: 'string' }, 'data-dir': { type: 'string' }, help: { type: 'boolean' } }
    });
    if (values.help) {
        console.log(HELP);
        return 0;
    }
    if (!values.input) throw new Error('Calibration import: --input is required');
    const bytes = readFileSync(values.input);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const rows = bytes
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => parseAssessmentJson(line) as Row);
    const dataDir = resolve(values['data-dir'] ?? process.env.MAGPIE_BENCH_DATA_DIR ?? join(homedir(), '.local/share/magpie-mini-bench'));
    const db = new BenchDatabase(join(dataDir, BENCH_DB_FILENAME));
    try {
        const existing = db.find_run_by_imported_sha256(sha256);
        if (existing) {
            console.log('Already imported as ' + existing);
            return 0;
        }
        const id = randomUUID().replaceAll('-', '');
        const run = calibration_run(rows, id, { file: basename(values.input), sha256 });
        const events = calibration_session_events(rows, id);
        db.save_run(run);
        db.insert_session_events_batch(events);
        console.log(`Imported ${(run.samples as unknown[]).length} samples as run ${id} (${run.status}); reload the plugin to see it.`);
        return 0;
    } finally {
        db.close();
    }
}
if (import.meta.main) {
    try {
        process.exitCode = main();
    } catch (error) {
        console.error((error as Error).message);
        process.exitCode = 2;
    }
}
