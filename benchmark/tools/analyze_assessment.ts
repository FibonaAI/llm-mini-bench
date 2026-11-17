import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseAssessmentJson } from '../src/assessment_json.ts';

interface AnalysisMetadata {
    type: 'metadata';
    task_sha256: string;
    source_sha256: Record<string, string>;
    bank?: unknown;
    bank_scope?: string;
    config: unknown;
    targets: unknown[];
    tasks: { id: string; domain: string }[];
}
interface AnalysisObservation {
    type: 'observation';
    model: string;
    thinking: string;
    task: string;
    domain: string;
    round: number;
    ok: boolean;
    status: string;
    elapsed_seconds: number;
    calls: string[];
    grade: { content_score: number | null; outcome: string; instruction_checks: Record<string, boolean> } | null;
}
interface AnalysisCall {
    type: 'call';
    estimated_uncached_cost_usd?: number | null;
}
type AnalysisRecord = AnalysisMetadata | AnalysisObservation | AnalysisCall;
const average = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
/** Summarize all recorded rounds; operational failures are not content scores. */
export function summarize_assessment(input: readonly unknown[]) {
    const records = input as AnalysisRecord[];
    const metadata = records.filter(row => row.type === 'metadata');
    if (metadata.length !== 1) throw new Error('exactly one experiment metadata record required');
    const observations = records.filter(row => row.type === 'observation');
    const identities = observations.map(row => JSON.stringify([row.model, row.thinking, row.task, row.round]));
    if (new Set(identities).size !== identities.length) throw new Error('duplicate samples; repeats must have distinct rounds');
    const groups = new Map<string, AnalysisObservation[]>();
    for (const row of observations) {
        const key = JSON.stringify([row.task, row.domain, row.model, row.thinking]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(row);
    }
    const results = [...groups]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, rows]) => {
            const [task, domain, model, thinking] = JSON.parse(key);
            const grades = rows.flatMap(row =>
                row.ok && row.grade && typeof row.grade === 'object' && !Array.isArray(row.grade) ? [row.grade] : []
            );
            const scores = grades
                .map(grade => grade.content_score)
                .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
            const failureAsZeroScores = rows.map(row =>
                row.ok && row.grade && typeof row.grade.content_score === 'number' && Number.isFinite(row.grade.content_score)
                    ? row.grade.content_score
                    : 0
            );
            const outcomes: Record<string, number> = {};
            for (const row of rows) {
                const outcome = row.ok && row.grade ? row.grade.outcome : row.status;
                outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
            }
            return {
                task,
                domain,
                model,
                thinking,
                samples: rows.length,
                completed: rows.filter(row => row.ok).length,
                gradable: scores.length,
                content_mean: average(scores),
                failure_as_zero_mean: average(failureAsZeroScores),
                content_min: scores.length ? Math.min(...scores) : null,
                content_max: scores.length ? Math.max(...scores) : null,
                outcomes,
                instruction_all_pass: grades.filter(
                    grade =>
                        grade.instruction_checks &&
                        Object.keys(grade.instruction_checks).length &&
                        Object.values(grade.instruction_checks).every(Boolean)
                ).length,
                mean_elapsed_seconds: average(rows.map(row => row.elapsed_seconds)),
                request_count: rows.reduce((sum, row) => sum + row.calls.length, 0)
            };
        });
    const tasks = metadata[0]!.tasks.map(task => {
        const rows = results.filter(row => row.task === task.id);
        const means = rows.map(row => row.content_mean).filter((value): value is number => value !== null);
        const flags = [];
        if (means.length && means.every(value => value === 1)) flags.push('content_saturated_in_observed_configs');
        if (means.length && means.every(value => value === 0)) flags.push('content_floor_in_observed_configs');
        if (means.length && Math.max(...means) > Math.min(...means)) flags.push('observed_between_config_difference');
        if (rows.some(row => row.content_min !== row.content_max)) flags.push('observed_within_config_variation');
        if (rows.some(row => row.gradable < row.samples)) flags.push('incomplete_or_ungradable_samples');
        if (task.domain === 'instruction' && rows.some(row => row.instruction_all_pass < row.completed))
            flags.push('instruction_failures_despite_separate_content_score');
        return { task: task.id, domain: task.domain, flags, observed_configurations: rows.length, results: rows };
    });
    const calls = records.filter(row => row.type === 'call'),
        missing = calls.filter(row => row.estimated_uncached_cost_usd == null).length;
    const cost = calls.reduce((sum, row) => sum + (row.estimated_uncached_cost_usd ?? 0), 0);
    return {
        task_sha256: metadata[0]!.task_sha256,
        source_sha256: metadata[0]!.source_sha256,
        bank: metadata[0]!.bank ?? null,
        bank_scope: metadata[0]!.bank_scope ?? null,
        config: metadata[0]!.config,
        targets: metadata[0]!.targets,
        samples: observations.length,
        calls: calls.length,
        missing_cost_calls: missing,
        known_cost_lower_bound_usd: cost,
        estimated_uncached_cost_usd: missing ? null : cost,
        tasks,
        limitations: [
            'Small exploratory calibration; no validated ability scale, aggregate weights or reliability claim.',
            'Requested thinking and catalog route do not verify effective upstream configuration or identity.',
            'Content, instruction compliance, tool-state checks and operational failures remain separate.',
            'failure_as_zero_mean is an execution summary with failed or ungradable samples set to zero; it never rewrites content_score or chart eligibility.',
            'No pass@k/best-of selection: all recorded repetitions are retained.'
        ]
    };
}

/** Analyze an existing JSONL file offline; refuses to overwrite output. */
export function main(argv = process.argv.slice(2)): number {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: { output: { type: 'string' }, help: { type: 'boolean' } }
    });
    if (values.help) {
        console.log(
            'Usage: bun benchmark/tools/analyze_assessment.ts INPUT --output OUTPUT\nSummarize per-question recorded evidence; no model calls.'
        );
        return 0;
    }
    if (positionals.length !== 1 || !values.output) throw new Error('Assessment analysis: INPUT and --output are required');
    const summary = summarize_assessment(
        readFileSync(positionals[0]!, 'utf8')
            .split(/\r?\n/)
            .filter(line => line.trim())
            .map(line => parseAssessmentJson(line))
    );
    writeFileSync(values.output, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
    console.log(
        JSON.stringify(Object.fromEntries((['samples', 'calls', 'estimated_uncached_cost_usd'] as const).map(key => [key, summary[key]])))
    );
    return 0;
}
if (import.meta.main) {
    try {
        process.exitCode = main();
    } catch (error) {
        console.error((error as Error).message);
        process.exitCode = 2;
    }
}
