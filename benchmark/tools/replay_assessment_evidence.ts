import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ASSESSMENT_PROJECT_ROOT, load_assessment_bank } from '../src/assessment_bank.ts';
import { load_assessment_baselines, type AssessmentBaseline } from '../src/assessment_baselines.ts';
import { canonicalAssessmentJson, canonicalAssessmentJsonText, parseAssessmentJson } from '../src/assessment_json.ts';
import { calibration_visible_text } from '../src/assessment_response.ts';

interface HistoricalRegistry { baselines: { id: string; path: string; sha256: string; raw_evidence: { path: string; sha256: string } }[] }
interface RecordedRequest { model: string; reasoning: unknown; max_output_tokens: number; tools?: unknown; parallel_tool_calls?: boolean; input: Record<string, unknown>[] }
interface RecordedCall { type: 'call'; sample_id: string; call_id: string; task: string; model: string; thinking: string; round: number; http_status: number; request: RecordedRequest; raw_response: { status: string; error?: unknown; output: Record<string, unknown>[]; usage: { input_tokens: number; output_tokens: number } }; estimated_uncached_cost_usd: number }
interface RecordedMetadata { type: 'metadata'; source_sha256: Record<string, string> }
interface RecordedObservation extends Record<string, unknown> { type: 'observation'; sample_id: string }
interface RecordedToolResult { type: 'tool_result'; sample_id: string; call_id: string; result: unknown }
type RecordedEvidence = RecordedCall | RecordedMetadata | RecordedObservation | RecordedToolResult;
interface RecordedFunction { call_id: string; name: string; arguments: string }
type ReplaySample = AssessmentBaseline['samples'][number] & {
    calls: string[]; text: string; tool_trace: { call_id: string; name: string; arguments: string; result: unknown }[];
};
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const same = (left: unknown, right: unknown) => canonicalAssessmentJson(left) === canonicalAssessmentJson(right);
const verify = (condition: unknown, reason: string) => { if (!condition) throw new Error('Assessment evidence replay: ' + reason); };

/** Replay registered historical responses and fixed simulators offline, never executing model-produced code. */
export function replay_assessment_evidence() {
    const registry = parseAssessmentJson(readFileSync(join(ASSESSMENT_PROJECT_ROOT, 'baselines/assessment-historical-provenance.json'), 'utf8')) as HistoricalRegistry;
    verify(registry.baselines.length === 1, 'exactly one retained historical observation is required');
    const entry = registry.baselines[0]!;
    const baselinePath = join(ASSESSMENT_PROJECT_ROOT, entry.path), baselineBytes = readFileSync(baselinePath);
    verify(digest(baselineBytes) === entry.sha256, 'baseline byte hash mismatch');
    verify(digest(canonicalAssessmentJsonText(baselineBytes.toString('utf8'), ['id'])) === entry.id, 'historical Python canonical snapshot ID mismatch');
    const baselines = load_assessment_baselines([baselinePath]);
    verify(baselines.length === 1, 'baseline structural and protocol validation failed');
    const baseline = baselines[0]!;
    const rawBytes = readFileSync(join(ASSESSMENT_PROJECT_ROOT, entry.raw_evidence.path));
    verify(digest(rawBytes) === entry.raw_evidence.sha256, 'raw evidence byte hash mismatch');
    const records = rawBytes.toString('utf8').split(/\r?\n/).filter(line => line.trim()).map(line => parseAssessmentJson(line) as RecordedEvidence);
    const metadata = records.filter(record => record.type === 'metadata');
    verify(metadata.length === 1, 'metadata count mismatch');
    const originals = new Map(records.filter(record => record.type === 'observation').map(record => [record.sample_id, record]));
    const calls = new Map(records.filter(record => record.type === 'call').map(record => [record.call_id, record]));
    const bank = load_assessment_bank(), tasks = new Map(bank.tasks.map(task => [task.id, task]));
    verify(originals.size === 14 && calls.size === 19, 'recorded sample or response count mismatch');
    verify(same(baseline.source_sha256, metadata[0]!.source_sha256), 'historical execution sources were relabeled');
    verify(baseline.target.account_ref === null && baseline.target.account_evidence === 'unrecorded', 'account identity must remain unrecorded');
    let simulatorCalls = 0, grades = 0;
    const usedCalls = new Set(), replayedTasks = [];
    for (const value of baseline.samples) {
        const sample = value as ReplaySample;
        const task = tasks.get(sample.task)!;
        const simulator = task.kind === 'tool' ? task.make_simulator!() : null;
        const original = originals.get(sample.sample_id);
        verify(original, 'missing original observation');
        for (const [key, value] of Object.entries(original!)) verify(same(sample[key], value), 'original field changed: ' + sample.task + ':' + key);
        let traceIndex = 0, finalText = '', previous: RecordedCall | null = null;
        for (const callId of sample.calls) {
            verify(!usedCalls.has(callId), 'response call reused'); usedCalls.add(callId);
            const call = calls.get(callId)!;
            verify(call && call.http_status === 200 && call.raw_response.status === 'completed' && !call.raw_response.error, 'unsuccessful recorded response');
            verify(call.sample_id === sample.sample_id && call.task === sample.task && call.model === sample.model && call.thinking === sample.thinking && call.round === sample.round, 'response identity differs');
            verify(same({ reasoning: call.request.reasoning, max_output_tokens: call.request.max_output_tokens }, sample.execution_protocol.requests[sample.task]), 'request protocol differs');
            verify(call.request.model === sample.model && call.request.input[0]!.role === 'user' && call.request.input[0]!.content === task.prompt, 'request prompt or model differs');
            if (simulator) verify(same(call.request.tools, task.tools) && call.request.parallel_tool_calls === false, 'tool request schema differs');
            if (previous) {
                const trace = sample.tool_trace[traceIndex - 1]!;
                const prefix = [...previous.request.input, ...previous.raw_response.output];
                verify(call.request.input.length === prefix.length + 1 && same(call.request.input.slice(0, -1), prefix), 'tool continuation history differs');
                const result = call.request.input.at(-1)!;
                verify(result.type === 'function_call_output' && result.call_id === trace.call_id && typeof result.output === 'string' && same(parseAssessmentJson(result.output), trace.result), 'tool continuation result differs');
            } else verify(call.request.input.length === 1, 'initial request contains unexpected history');
            const functions = call.raw_response.output.filter(item => item.type === 'function_call') as unknown as RecordedFunction[];
            finalText = calibration_visible_text(call.raw_response);
            if (functions.length) {
                verify(simulator && functions.length === 1, 'invalid fixed simulator sequence');
                const action = functions[0]!, trace = sample.tool_trace[traceIndex++]!;
                verify(trace && action.call_id === trace.call_id && action.name === trace.name && action.arguments === trace.arguments, 'tool trace differs from raw response');
                const result = simulator!.call(action.name, parseAssessmentJson(action.arguments));
                verify(same(result, trace.result), 'simulator result differs: ' + sample.task);
                const journal = records.filter((record): record is RecordedToolResult => record.type === 'tool_result' && record.sample_id === sample.sample_id && record.call_id === action.call_id);
                verify(journal.length === 1 && same(journal[0]!.result, result), 'tool journal differs');
                simulatorCalls++;
            } else verify(callId === sample.calls.at(-1), 'final response precedes further calls');
            previous = call;
        }
        verify(traceIndex === sample.tool_trace.length && finalText === sample.text, 'final text or tool trace length differs');
        verify(same(simulator ? simulator.grade(finalText) : task.grade(finalText), sample.grade), 'grade differs: ' + sample.task);
        grades++;
        replayedTasks.push({ task: sample.task, response_calls: sample.calls.length, simulator_calls: traceIndex, grade_reproduced: true });
    }
    verify(usedCalls.size === 19 && simulatorCalls === 5 && grades === 14, 'replay completeness mismatch');
    return { schema: 'assessment-evidence-verification-v1', bank_version: '1.0', baseline_id: baseline.id, raw_evidence: baseline.evidence,
        provenance: { historical_implementation: 'python-historical', historical_baseline_sha256: entry.sha256,
            historical_task_source_sha256: baseline.bank_snapshot.source_sha256, historical_execution_source_sha256: baseline.source_sha256,
            current_implementation: 'typescript-bun', current_task_source_sha256: bank.source_sha256,
            registry: 'baselines/assessment-historical-provenance.json', equivalence_scope: 'All retained 19 responses, 5 simulator calls and 14 grades reproduce; this is evidence replay, not proof of equivalence for every possible input.' },
        verification: { whole_bank_tasks: 14, prespecified_rounds: baseline.rounds, completed_gradable_samples: grades,
            recorded_response_calls: usedCalls.size, replayed_simulator_calls: simulatorCalls, task_hash_matches_current: true,
            four_task_source_hashes_match_current: false, all_recorded_grades_reproduced: true, all_request_protocols_verified: true,
            all_sample_protocol_hashes_recomputed: true, all_original_observation_fields_preserved: true, historical_snapshot_id_verified: true, paid_model_calls: 0 },
        tasks: replayedTasks,
        identity_limits: { route: baseline.target.model, thinking_requested: baseline.target.thinking, account_identity: 'unrecorded',
            upstream_effective_thinking: 'not independently verified', historical_execution_source_hashes: 'retained verbatim; not relabeled as current runner bytes' },
        recorded_usage: { input_tokens: [...calls.values()].reduce((sum, call) => sum + call.raw_response.usage.input_tokens, 0), output_tokens: [...calls.values()].reduce((sum, call) => sum + call.raw_response.usage.output_tokens, 0) },
        estimated_uncached_cost_usd: [...calls.values()].reduce((sum, call) => sum + call.estimated_uncached_cost_usd, 0),
        cost_note: 'Sum of all 19 recorded per-call estimates, not an invoice.',
        interpretation: 'One complete observed target-round; per-question content and instruction checks only. No aggregate score, learned weights, model identification, or population capability claim.',
        reproduce: 'bun benchmark/tools/replay_assessment_evidence.ts' };
}

/** Print verification, or exclusively create an explicitly requested report path. */
export function main(argv = process.argv.slice(2)): number {
    const { values } = parseArgs({ args: argv, options: { output: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) { console.log('Usage: bun benchmark/tools/replay_assessment_evidence.ts [--output NEW_FILE]\nReplay retained evidence with the current fixed TypeScript graders; no network calls.'); return 0; }
    const report = JSON.stringify(replay_assessment_evidence(), null, 2) + '\n';
    if (values.output) writeFileSync(values.output, report, { flag: 'wx' }); else process.stdout.write(report);
    return 0;
}
if (import.meta.main) { try { process.exitCode = main(); } catch (error) { console.error((error as Error).message); process.exitCode = 2; } }
