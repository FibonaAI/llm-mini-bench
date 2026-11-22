import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
    has_legacy_workspace,
    migrate_legacy_workspace,
    type LegacyMigrationOptions,
    type MigrationReport
} from '../src/bench_legacy_migration.ts';

export { has_legacy_workspace, migrate_legacy_workspace, type LegacyMigrationOptions, type MigrationReport };

const HELP = `Usage: bun benchmark/tools/migrate_legacy_storage.ts [--data-dir DIR] [--dry-run] [--cleanup]
Migrate legacy file-per-run workspaces (<data-dir>/assessment/ and <data-dir>/assessment-baselines/)
into the single SQLite database (<data-dir>/mini-bench.sqlite).
Note: the Mini Bench service also performs this migration and cleanup automatically on startup.
Preserves all runs, tasks, samples, immutable attempt histories, compact Pi Session events (calls,
tool results, retries, grades), and baselines while discarding raw SSE stream chunks, duplicated
source/*.ts snapshots, run-before.json archives, and .run-index-cache.json.
  --data-dir DIR   Workspace root (default MAGPIE_BENCH_DATA_DIR or ~/.local/share/magpie-mini-bench)
  --dry-run        Inspect legacy workspace and report what would be migrated without writing SQLite
  --cleanup        Delete migrated legacy files, derived caches, and empty legacy directories after verifying SQLite`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
    const { values } = parseArgs({
        args: argv,
        options: {
            'data-dir': { type: 'string' },
            'dry-run': { type: 'boolean' },
            cleanup: { type: 'boolean' },
            help: { type: 'boolean' }
        }
    });
    if (values.help) {
        console.log(HELP);
        return 0;
    }
    const dataDir = resolve(values['data-dir'] ?? process.env.MAGPIE_BENCH_DATA_DIR ?? join(homedir(), '.local/share/magpie-mini-bench'));
    const report = await migrate_legacy_workspace(dataDir, {
        dryRun: Boolean(values['dry-run']),
        cleanup: Boolean(values.cleanup)
    });
    const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    if (report.dry_run) {
        console.log(
            `Dry run for ${report.data_dir}: found ${report.runs_found} runs (${report.runs_skipped} already in SQLite), ` +
                `${report.tasks_found} tasks (${report.tasks_skipped} already in SQLite), ` +
                `${report.baselines_found} baselines (${report.baselines_skipped} already in SQLite).`
        );
    } else {
        const cleaned = report.cleanup
            ? ` Cleaned ${report.cleaned_runs} runs, ${report.cleaned_tasks} tasks, ${report.cleaned_baselines} baselines, ` +
              `${report.cleaned_cache_files} cache files, ${report.removed_dirs.length} empty dirs.`
            : '';
        const failed =
            report.runs_failed || report.tasks_failed || report.baselines_failed
                ? ` Preserved unreadable legacy items: ${report.runs_failed} runs, ${report.tasks_failed} tasks, ${report.baselines_failed} baselines.`
                : '';
        console.log(
            `Migrated into ${report.db_path} (${mb(report.db_bytes)}): ` +
                `${report.runs_migrated}/${report.runs_found} runs (${report.runs_skipped} skipped), ` +
                `${report.tasks_migrated}/${report.tasks_found} tasks (${report.tasks_skipped} skipped), ` +
                `${report.baselines_migrated}/${report.baselines_found} baselines (${report.baselines_skipped} skipped), ` +
                `${report.samples_migrated} samples, ${report.attempts_migrated} attempts, ${report.events_migrated} session events.` +
                cleaned +
                failed
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
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    );
}
