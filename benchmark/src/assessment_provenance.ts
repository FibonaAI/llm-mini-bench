import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PRODUCTION_BANK_VERSION, RELEASED_BANK_VERSIONS } from './production_bank.ts';
import {
    ASSESSMENT_BANK_SOURCE_PATHS,
    ASSESSMENT_PROJECT_ROOT,
    assessment_task_snapshot,
    load_assessment_bank,
    type AssessmentBank,
    type AssessmentTaskSnapshot
} from './assessment_bank.ts';
import { ASSESSMENT_INTERACTIVE_SOURCE_PATHS } from './assessment_interactive.ts';
import { ASSESSMENT_INTERACTIVE_V2_SOURCE_PATHS } from './assessment_interactive_v2.ts';

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
    // The bank loader imports these unconditionally across released banks.
    ...ASSESSMENT_INTERACTIVE_SOURCE_PATHS,
    ...ASSESSMENT_INTERACTIVE_V2_SOURCE_PATHS
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

/** Query-local source verification shares bank loads per version, including failed loads. */
export interface AssessmentSourceContext {
    production_bank(): AssessmentBank;
    production_cards(): AssessmentTaskSnapshot[];
    bank_for_version?(version: string): AssessmentBank;
    cards_for_version?(version: string): AssessmentTaskSnapshot[];
}

/** Never cache across queries: edited source bytes must be revalidated on the next query. */
export function create_assessment_source_context(
    load_bank: (version?: string) => AssessmentBank = load_assessment_bank
): AssessmentSourceContext {
    const entries = new Map<string, { bank: AssessmentBank; cards?: AssessmentTaskSnapshot[] } | { error: unknown }>();
    const bank_for_version = (version: string): AssessmentBank => {
        let entry = entries.get(version);
        if (!entry) {
            try {
                const bank = version === PRODUCTION_BANK_VERSION ? load_bank() : load_bank(version);
                entry = { bank };
            } catch (error) {
                entry = { error };
            }
            entries.set(version, entry);
        }
        if ('error' in entry) throw entry.error;
        return entry.bank;
    };
    const cards_for_version = (version: string): AssessmentTaskSnapshot[] => {
        const bank = bank_for_version(version);
        const entry = entries.get(version) as { bank: AssessmentBank; cards?: AssessmentTaskSnapshot[] };
        return (entry.cards ??= bank.tasks.map(assessment_task_snapshot));
    };
    return {
        production_bank: () => bank_for_version(PRODUCTION_BANK_VERSION),
        production_cards: () => cards_for_version(PRODUCTION_BANK_VERSION),
        bank_for_version,
        cards_for_version
    };
}

/** Fast stat-only signature of tracked source and bank files; detects on-disk edits without reading bytes. */
export function assessment_source_signature(root = ASSESSMENT_PROJECT_ROOT): string {
    const tracked = [
        ...RELEASED_BANK_VERSIONS.flatMap(version => [`banks/assessment-${version}.json`, `banks/assessment-${version}.questions.json`]),
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

/** Cryptographic digest of the released banks and execution sources for persistent cache validation. */
export function assessment_source_digest(context = create_assessment_source_context()): string {
    try {
        const versions = context.bank_for_version ? RELEASED_BANK_VERSIONS : [PRODUCTION_BANK_VERSION];
        const digests = versions.map(version => {
            const bank = context.bank_for_version ? context.bank_for_version(version) : context.production_bank();
            const { hashes } = capture_assessment_sources(bank);
            return { version: bank.version, task_sha256: bank.task_sha256, hashes };
        });
        return createHash('sha256').update(JSON.stringify(digests)).digest('hex');
    } catch {
        return 'invalid:' + assessment_source_signature();
    }
}
