#!/usr/bin/env bun
/** Calibration CLI; sample execution lives in the reusable runner core. */
import { SUBMIT_ANSWER_PROTOCOL, task_answer_protocol } from './src/assessment_answer_protocol.ts';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { calibration_price } from './src/assessment_response.ts';
import { GatewayClient, type GatewayCatalog } from './src/client.ts';
import { advertised_thinking_levels } from './src/run_protocol.ts';
import { assessment_hash, parseAssessmentJson } from './src/assessment_json.ts';
import { capture_assessment_sources } from './src/assessment_provenance.ts';
import type { AssessmentPricing } from './src/bench_routes.ts';
import { AssessmentBudget, AssessmentJournal, ASSESSMENT_UNCAPPED_OUTPUT_RESERVATION_TOKENS, run_assessment_sample, type RunnerConfig, type RunnerTask, type AssessmentClient, type AssessmentTarget, type AssessmentObservation } from './src/assessment_runner.ts';
// Retain the historical CLI import surface and source-presence provenance requirement.
export * from './src/assessment_runner.ts';
export { assessment_hash } from './src/assessment_json.ts';
export type { AssessmentPricing } from './src/bench_routes.ts';

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function error_name(error: unknown): string { return error instanceof Error ? error.name : 'Error'; }
interface CalibrationArguments extends RunnerConfig {
    max_output_tokens?: number; max_turns: number | null; max_tool_calls: number | null;
    target: string[]; task_ids: string[] | null; bank_version: string; output: string; answer_protocol?: string; answer_schemas?: string; max_api_retries?: number;
    rounds: number; round_start: number; max_cost_usd: number | null; max_requests: number | null; concurrency: number;
}
/** CLI argument errors are distinct from transport failures and never start paid calls. */
export class AssessmentCliArgumentError extends Error { readonly exitCode = 2; }
const CLI_HELP = `Usage: bun benchmark/calibrate_assessment.ts --target MODEL=THINKING --output FILE [options]
Bounded assessment runs for a selected question bank. No retries unless --max-api-retries is set.
  --target MODEL=THINKING  Repeat for each exact catalog route (default omits reasoning)
  --task-ids ID [ID ...]   Optional diagnostic subset, retaining bank order
  --answer-protocol ID    Diagnostic override: submit-answer-tool-v1 grades only submit_answer arguments (recorded in task snapshots)
  --answer-schemas FILE   Required with --answer-protocol: JSON object mapping each selected task ID to its answer_schema
  --bank-version VERSION  Bank manifest version (default 1.0)
  --output FILE           New JSONL journal; existing files are never overwritten
  --rounds N              1..3 (default 1)
  --round-start N         First repetition label, 1..3 (default 1)
  --max-output-tokens N   128..32768; omit for no response token cap
  --max-turns N           1..12; omit for no turn cap
  --max-tool-calls N      1..12; omit for no tool-call cap
  --timeout N             Seconds for the whole sample, 10..600 (default 600)
  --max-cost-usd N        Optional combined USD ceiling; omit for no ceiling
  --max-requests N        Optional request ceiling; omit for no ceiling
  --concurrency N         1..4 (default 3)
  --max-api-retries N     0..3 transient API retries per request within the sample deadline (default: none)
  --help                  Show this help without requests`;
function parse_arguments(argv: string[]): CalibrationArguments {
    const args: CalibrationArguments = { target: [], task_ids: null, bank_version: '1.0', output: '', rounds: 1, round_start: 1, max_turns: null, max_tool_calls: null, timeout: 600, max_cost_usd: null, max_requests: null, concurrency: 3 };
    const numeric = new Set(['max_api_retries', 'rounds', 'round_start', 'max_output_tokens', 'max_turns', 'max_tool_calls', 'timeout', 'max_cost_usd', 'max_requests', 'concurrency']);
    for (let index = 0; index < argv.length; index++) {
        const token = argv[index]!;
        const equals = token.indexOf('=');
        const flag = equals < 0 ? token : token.slice(0, equals);
        const inline = equals < 0 ? undefined : token.slice(equals + 1);
        const key = flag.slice(2).replaceAll('-', '_');
        if (!flag.startsWith('--') || !['target', 'task_ids', 'bank_version', 'output', 'answer_protocol', 'answer_schemas', ...numeric].includes(key)) throw new AssessmentCliArgumentError('unrecognized argument: ' + token);
        if (key === 'task_ids') {
            const ids = inline === undefined ? [] : [inline];
            while (index + 1 < argv.length && !argv[index + 1]!.startsWith('--')) ids.push(argv[++index]!);
            if (!ids.length) throw new AssessmentCliArgumentError('--task-ids requires at least one ID');
            args.task_ids = ids; continue;
        }
        const value = inline ?? argv[++index];
        if (value === undefined || value.startsWith('--')) throw new AssessmentCliArgumentError('missing value for ' + flag);
        if (key === 'target') args.target.push(value);
        else if (key === 'bank_version') args.bank_version = value;
        else if (key === 'output') args.output = value;
        else if (key === 'answer_schemas') args.answer_schemas = value;
        else if (key === 'answer_protocol') {
            if (value !== SUBMIT_ANSWER_PROTOCOL) throw new AssessmentCliArgumentError('unsupported answer protocol: ' + value);
            args.answer_protocol = value;
        }
        else {
            if (!value.trim() || (key !== 'max_cost_usd' && !/^[+-]?\d+$/.test(value))) throw new AssessmentCliArgumentError('invalid numeric argument: ' + flag);
            (args as unknown as Record<string, unknown>)[key] = Number(value);
        }
    }
    if (!args.target.length || !args.output) throw new AssessmentCliArgumentError('--target and --output are required');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.bank_version)) throw new AssessmentCliArgumentError('bank-version must be a nonempty path-safe string');
    if (args.max_api_retries !== undefined && !(Number.isInteger(args.max_api_retries) && args.max_api_retries >= 0 && args.max_api_retries <= 3)) throw new AssessmentCliArgumentError('max-api-retries must be 0..3');
    if (!(args.rounds >= 1 && args.rounds <= 3 && args.round_start >= 1 && args.round_start <= 3 && args.round_start + args.rounds - 1 <= 3 && (args.max_output_tokens === undefined || (args.max_output_tokens >= 128 && args.max_output_tokens <= 32768)) && (args.max_turns === null || (args.max_turns >= 1 && args.max_turns <= 12)) && (args.max_tool_calls === null || (args.max_tool_calls >= 1 && args.max_tool_calls <= 12)) && args.timeout >= 10 && args.timeout <= 600 && args.concurrency >= 1 && args.concurrency <= 4 && (args.max_requests === null || (args.max_requests >= 1 && args.max_requests <= 500)) && (args.max_cost_usd === null || (Number.isFinite(args.max_cost_usd) && args.max_cost_usd > 0 && args.max_cost_usd <= 10)))) throw new AssessmentCliArgumentError('assessment safety bounds exceeded');
    return args;
}
/** Optional dependency injection keeps CLI acceptance entirely offline. */
export interface CalibrationDependencies {
    load_bank?: (version: string) => Record<string, unknown> & { tasks: RunnerTask[] };
    client_factory?: (base_url: string, api_key: string) => AssessmentClient & { fetch_models_catalog(): Promise<GatewayCatalog> };
    run_sample?: typeof run_assessment_sample;
}
/** Execute the bounded calibration CLI; only explicit invocation performs network requests. */
export async function main(argv = process.argv.slice(2), dependencies: CalibrationDependencies = {}): Promise<void> {
    if (argv.includes('--help') || argv.includes('-h')) { console.log(CLI_HELP); return; }
    const args = parse_arguments(argv);
    const load_bank = dependencies.load_bank ?? (await import('./src/assessment_bank.ts')).load_assessment_bank;
    const bank = load_bank(args.bank_version);
    let tasks = bank.tasks as RunnerTask[];
    if (args.task_ids) {
        if (new Set(args.task_ids).size !== args.task_ids.length || args.task_ids.some(id => !tasks.some(task => task.id === id))) throw new AssessmentCliArgumentError('task IDs must be unique and known');
        tasks = tasks.filter(task => args.task_ids!.includes(task.id));
    }
    // A diagnostic override changes task snapshots, so its hashes never match the unmodified bank.
    if (args.answer_protocol) {
        if (!args.answer_schemas) throw new AssessmentCliArgumentError('--answer-protocol requires --answer-schemas');
        const schemas = parseAssessmentJson(readFileSync(args.answer_schemas, 'utf8'));
        if (!record(schemas) || tasks.some(task => !record(schemas[task.id]))) throw new AssessmentCliArgumentError('answer schemas must cover every selected task');
        tasks = tasks.map(task => ({ ...task, answer_protocol: args.answer_protocol, answer_schema: (schemas as Record<string, unknown>)[task.id] }));
        for (const task of tasks) task_answer_protocol(task);
    } else if (args.answer_schemas) throw new AssessmentCliArgumentError('--answer-schemas requires --answer-protocol');
    const client = (dependencies.client_factory ?? ((base, key) => new GatewayClient(base, key)))(process.env.MAGPIE_BENCH_BASE_URL ?? 'http://127.0.0.1:3425/v1', process.env.MAGPIE_BENCH_API_KEY ?? 'magpie');
    const catalog = await client.fetch_models_catalog();
    const targets: AssessmentTarget[] = [], prices: Record<string, AssessmentPricing> = Object.create(null);
    for (const spec of args.target) {
        const split = spec.lastIndexOf('='), model = spec.slice(0, split), thinking = spec.slice(split + 1);
        if (split < 0 || !Object.hasOwn(catalog, model)) throw new AssessmentCliArgumentError('target requires catalog model=thinking: ' + spec);
        if (thinking !== 'default' && !advertised_thinking_levels(catalog[model]).includes(thinking)) throw new AssessmentCliArgumentError('thinking not advertised for ' + spec);
        if (targets.some(target => target.model === model && target.thinking === thinking)) throw new AssessmentCliArgumentError('duplicate target');
        targets.push({ model, thinking });
        const raw = catalog[model]!.pricing;
        prices[model] = { prompt: calibration_price(record(raw) ? raw.prompt : undefined), completion: calibration_price(record(raw) ? raw.completion : undefined) };
    }
    const config: RunnerConfig = { ...(args.max_output_tokens === undefined ? {} : { max_output_tokens: args.max_output_tokens }), max_turns: args.max_turns, max_tool_calls: args.max_tool_calls, timeout: args.timeout, timeout_scope: 'sample', ...(args.max_api_retries === undefined ? {} : { max_api_retries: args.max_api_retries }) };
    const snapshots = tasks.map(task => Object.fromEntries(Object.entries(task).filter(([, value]) => typeof value !== 'function')));
    const { hashes: sources } = capture_assessment_sources({ source_sha256: bank.source_sha256 as Record<string, unknown>, extension_sha256: bank.extension_sha256 as Record<string, unknown> | undefined });
    const jobs: [RunnerTask, AssessmentTarget, number][] = [];
    for (let round = args.round_start; round < args.round_start + args.rounds; round++) for (const task of tasks) for (const target of targets) jobs.push([task, target, round]);
    const budget = new AssessmentBudget(args.max_cost_usd, args.max_requests, ASSESSMENT_UNCAPPED_OUTPUT_RESERVATION_TOKENS, true);
    mkdirSync(dirname(args.output), { recursive: true });
    const descriptor = openSync(args.output, 'wx', 0o600);
    try {
        const journal = new AssessmentJournal(descriptor);
        const { tasks: _tasks, ...bank_metadata } = bank;
        journal.write({ type: 'metadata', created_at: new Date().toISOString(), targets, tasks: snapshots, task_sha256: assessment_hash(snapshots), source_sha256: sources, config, rounds: args.rounds, round_start: args.round_start, bank: bank_metadata, bank_scope: args.task_ids ? 'subset' : 'whole', max_cost_usd: args.max_cost_usd, max_requests: args.max_requests, prices_per_token: prices, planned_samples: jobs.length,
            note: 'Per-question evidence, not an identity test or validated ability scale. Requested thinking is not proof of effective upstream thinking. Retries only when config.max_api_retries is set; uncached catalog estimates are not invoices.' });
        const observations: AssessmentObservation[] = [];
        const runner = dependencies.run_sample ?? run_assessment_sample;
        // Worker pool: a finished sample immediately frees its slot, so one slow sample no longer
        // idles the rest of a batch. Results keep job order. After a budget stop or a rejected
        // sample no new job starts, and all admitted work settles before the journal closes.
        const results: (AssessmentObservation | undefined)[] = new Array(jobs.length);
        let next = 0, failure: { reason: unknown } | null = null;
        const worker = async () => {
            while (!failure && !budget.stop_reason && next < jobs.length) {
                const index = next++, [task, target, round] = jobs[index]!;
                try { results[index] = await runner(client, task, target, round, config, prices[target.model]!, budget, journal); }
                catch (reason) { failure ??= { reason }; }
            }
        };
        await Promise.all(Array.from({ length: Math.min(args.concurrency, jobs.length) }, worker));
        for (const result of results) if (result) observations.push(result);
        if (failure) throw (failure as { reason: unknown }).reason;
        const summary = { type: 'summary', requests: budget.requests, samples: observations.length, completed: observations.filter(observation => observation.ok).length, planned_samples: jobs.length, stop_reason: budget.stop_reason, missing_cost_calls: budget.missing_cost, known_cost_lower_bound_usd: budget.spent, estimated_uncached_cost_usd: budget.missing_cost ? null : budget.spent };
        journal.write(summary); console.log(JSON.stringify(summary));
    } finally { closeSync(descriptor); }
    if (budget.stop_reason) throw new Error('Assessment stopped: ' + budget.stop_reason);
}
if (import.meta.main) main().catch(error => { console.error(error instanceof AssessmentCliArgumentError ? error.message : 'Assessment calibration failed: ' + error_name(error)); process.exitCode = error instanceof AssessmentCliArgumentError ? 2 : 1; });
