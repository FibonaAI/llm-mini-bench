import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PRODUCTION_BANK_VERSION } from './production_bank.ts';
import {
    ASSESSMENT_BANK_SOURCE_PATHS,
    ASSESSMENT_PROJECT_ROOT,
    assessment_task_snapshot,
    load_assessment_bank,
    type AssessmentBank,
    type AssessmentTaskSnapshot
} from './assessment_bank.ts';
import { ASSESSMENT_INTERACTIVE_SOURCE_PATHS } from './assessment_interactive.ts';

/** Execution source closure is independent of the selected bank's grading hash contract. */
export const EXECUTION_SOURCE_PATHS = [
    'calibrate_assessment.ts',
    'src/assessment_runner.ts',
    'src/assessment_provenance.ts',
    'src/assessment_baselines.ts',
    'src/assessment_observations.ts',
    'src/assessment_response.ts',
    'src/client.ts',
    'src/responses_stream.ts',
    'src/run_protocol.ts',
    'src/assessment_answer_protocol.ts',
    'src/assessment_bank.ts',
    'src/bench_execution.ts',
    'src/bench_db.ts',
    'src/bench_execution_storage.ts',
    'src/bench_execution_queries.ts',
    'src/bench_routes.ts',
    'src/bench_adapter.ts',
    'src/bench_http_body.ts',
    'src/bench_call_summaries.ts',
    'src/production_bank.ts',
    ...ASSESSMENT_BANK_SOURCE_PATHS,
    // The bank loader imports these unconditionally, including for production 1.0.
    ...ASSESSMENT_INTERACTIVE_SOURCE_PATHS
] as const;

/** Select the complete import closure, retaining any additional declared bank sources. */
export function assessment_execution_source_paths(bank: {
    source_sha256: Record<string, unknown>;
    extension_sha256?: Record<string, unknown>;
}): string[] {
    return [...new Set([...Object.keys(bank.source_sha256), ...Object.keys(bank.extension_sha256 ?? {}), ...EXECUTION_SOURCE_PATHS])];
}

/** Capture immutable source bytes and hashes together; callers verify declared bank hashes. */
export function capture_assessment_sources(
    bank: { source_sha256: Record<string, unknown>; extension_sha256?: Record<string, unknown> },
    root = ASSESSMENT_PROJECT_ROOT
): { sources: Map<string, Buffer>; hashes: Record<string, string> } {
    const sources = new Map<string, Buffer>(),
        hashes: Record<string, string> = {};
    for (const path of assessment_execution_source_paths(bank)) {
        const bytes = readFileSync(join(root, path));
        sources.set(path, bytes);
        hashes[path] = createHash('sha256').update(bytes).digest('hex');
    }
    return { sources, hashes };
}

/** Query-local source verification shares one production bank load, including a failed load. */
export interface AssessmentSourceContext {
    production_bank(): AssessmentBank;
    production_cards(): AssessmentTaskSnapshot[];
}

/** Never cache across queries: edited source bytes must be revalidated on the next query. */
export function create_assessment_source_context(load_bank: () => AssessmentBank = load_assessment_bank): AssessmentSourceContext {
    let result: { bank: AssessmentBank } | { error: unknown } | undefined;
    let cards: AssessmentTaskSnapshot[] | undefined;
    const production_bank = () => {
        if (!result) {
            try {
                result = { bank: load_bank() };
            } catch (error) {
                result = { error };
            }
        }
        if ('error' in result) throw result.error;
        return result.bank;
    };
    return { production_bank, production_cards: () => (cards ??= production_bank().tasks.map(assessment_task_snapshot)) };
}

/** Fast stat-only signature of tracked source and bank files; detects on-disk edits without reading bytes. */
export function assessment_source_signature(root = ASSESSMENT_PROJECT_ROOT): string {
    const tracked = [
        `banks/assessment-${PRODUCTION_BANK_VERSION}.json`,
        `banks/assessment-${PRODUCTION_BANK_VERSION}.questions.json`,
        ...EXECUTION_SOURCE_PATHS
    ];
    return tracked
        .map(path => {
            try {
                const stat = statSync(join(root, path));
                return `${path}:${stat.size}:${stat.mtimeMs}`;
            } catch {
                return `${path}:missing`;
            }
        })
        .join('|');
}

/** Cryptographic digest of the current production bank and execution sources for persistent cache validation. */
export function assessment_source_digest(context = create_assessment_source_context()): string {
    try {
        const bank = context.production_bank();
        const { hashes } = capture_assessment_sources(bank);
        return createHash('sha256')
            .update(JSON.stringify({ version: bank.version, task_sha256: bank.task_sha256, hashes }))
            .digest('hex');
    } catch {
        return 'invalid:' + assessment_source_signature();
    }
}
