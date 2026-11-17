#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { assessment_hash, canonicalAssessmentJson, parseAssessmentJson } from '../src/assessment_json.ts';
import { ASSESSMENT_COMPLETION_POLICY, summarize_assessment_completion, type AssessmentCompletionCall, type AssessmentCompletionPlan, type AssessmentCompletionSample } from '../src/assessment_completion.ts';

interface CompletionMetadata extends AssessmentCompletionPlan {
    type: 'metadata'; tasks: { id: string }[]; task_sha256: string;
    source_sha256: Record<string, string>; config: Record<string, unknown>;
    planned_samples: number; bank_scope?: string; bank?: { version?: string };
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function requireEvidence(condition: unknown, reason: string): asserts condition {
    if (!condition) throw new TypeError('Assessment completion report: ' + reason);
}
/** Read only recorded evidence; this report never calls models, imputes records or upgrades baseline provenance. */
export function report_assessment_completion(inputs: readonly string[]) {
    requireEvidence(inputs.length > 0, 'at least one input is required');
    const seen = new Set<string>();
    let reference: string | undefined;
    const sources = inputs.map(path => {
        const bytes = readFileSync(path);
        const rows = bytes.toString('utf8').split(/\r?\n/).filter(line => line.trim()).map(line => parseAssessmentJson(line));
        requireEvidence(rows.every(object), 'every JSONL row must be an object');
        const metadataRows = rows.filter(row => row.type === 'metadata');
        requireEvidence(metadataRows.length === 1, 'exactly one metadata row is required');
        const metadata = metadataRows[0] as unknown as CompletionMetadata;
        requireEvidence(Array.isArray(metadata.tasks) && metadata.tasks.every(task => object(task) && typeof task.id === 'string'), 'task snapshots are missing');
        requireEvidence(assessment_hash(metadata.tasks) === metadata.task_sha256, 'task snapshot hash differs');
        requireEvidence(object(metadata.source_sha256) && Object.keys(metadata.source_sha256).length > 0 && Object.values(metadata.source_sha256).every(hash => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)), 'source hashes are missing or invalid');
        requireEvidence(object(metadata.config), 'execution configuration is missing');
        const identity = canonicalAssessmentJson({ task_sha256: metadata.task_sha256, source_sha256: metadata.source_sha256, config: metadata.config, rounds: metadata.rounds, round_start: metadata.round_start ?? 1, bank: metadata.bank?.version ?? null, bank_scope: metadata.bank_scope ?? null });
        requireEvidence(reference === undefined || reference === identity, 'cannot combine different banks, execution sources, configurations or round plans'); reference = identity;
        const plan = { task_ids: metadata.tasks.map(task => task.id), targets: metadata.targets, rounds: metadata.rounds, round_start: metadata.round_start };
        const observations = rows.filter(row => row.type === 'observation') as unknown as AssessmentCompletionSample[];
        const calls = rows.filter(row => row.type === 'call') as unknown as AssessmentCompletionCall[];
        const targets = summarize_assessment_completion(plan, observations, calls);
        requireEvidence(metadata.planned_samples === targets.reduce((sum, target) => sum + target.planned_samples, 0), 'planned sample count differs');
        for (const target of targets) {
            const key = JSON.stringify([target.model, target.thinking]);
            requireEvidence(!seen.has(key), 'target appears in more than one input'); seen.add(key);
        }
        return { path, input_sha256: digest(bytes), bank_version: metadata.bank?.version ?? null, task_sha256: metadata.task_sha256, source_sha256: metadata.source_sha256, config: metadata.config, targets };
    });
    return { schema: ASSESSMENT_COMPLETION_POLICY, created_at: new Date().toISOString(), maximum_exception_fraction: 0.3,
        score_basis: 'Recorded completed grades plus explicit task-failure zeros, divided by planned samples minus exceptions. More than 30% exceptions invalidates the score. Timeout receipt evidence alone does not establish computation.',
        grading_replayed: false, baseline_eligible: false,
        report_source_sha256: { 'src/assessment_completion.ts': digest(readFileSync(new URL('../src/assessment_completion.ts', import.meta.url))), 'tools/report_assessment_completion.ts': digest(readFileSync(import.meta.filename)) },
        inputs: sources.map(({ targets: _targets, ...input }) => input), targets: sources.flatMap(source => source.targets) };
}
/** Offline CLI requires a new output path and never overwrites earlier reports. */
export function main(argv = process.argv.slice(2)): void {
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log('Usage: bun benchmark/tools/report_assessment_completion.ts --input OBSERVATIONS.jsonl [--input OTHER.jsonl] --output REPORT.json\nOffline supplemental completion scoring with a 30% exception threshold. Inputs may combine distinct targets only when bank and execution provenance match.');
        return;
    }
    const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: { input: { type: 'string', multiple: true }, output: { type: 'string' } } });
    requireEvidence(values.input?.length && values.output, '--input and --output are required');
    const report = report_assessment_completion(values.input);
    writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(report.targets.map(({ samples: _samples, ...target }) => target), null, 2));
}
if (import.meta.main) main();
