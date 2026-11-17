import { describe, expect, test } from 'bun:test';
import { AssessmentBudget, AssessmentJournal, assessment_arguments, run_assessment_sample, type RunnerTask, type RunnerConfig, type AssessmentClient, type RunnerSimulator } from './calibrate_assessment.ts';
import type { GatewayResponse } from './src/client.ts';
import { parseAssessmentJson } from './src/assessment_json.ts';

function response(output: unknown[] = [], text?: string, changes: Record<string, unknown> = {}) { return { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 }, output, ...(text === undefined ? {} : { output_text: text }), ...changes }; }
function functionCall(id = 'fc1', arguments_ = '{"value":2}') { return { type: 'function_call', call_id: id, name: 'act', arguments: arguments_ }; }
class Simulator implements RunnerSimulator {
    actions: [string, unknown][] = [];
    call(name: string, arguments_: unknown): Record<string, unknown> { if (!arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)) return { error: 'invalid arguments' }; this.actions.push([name, arguments_]); return { ok: true }; }
    grade(_text: string) { return { content_score: Number(!!this.actions.length), outcome: 'correct' }; }
}
async function runSample(payloads: unknown[], settings: Partial<RunnerConfig> = {}, options: { thinking?: string; tool?: boolean; simulator?: RunnerSimulator; cancelled?: () => boolean; client?: AssessmentClient; grade?: RunnerTask['grade'] } = {}) {
    const requests: Record<string, unknown>[] = [], records: Record<string, unknown>[] = [];
    const simulator = options.simulator ?? new Simulator();
    const task: RunnerTask = { id: 'test', domain: 'reasoning', kind: options.tool ? 'tool' : 'text', prompt: 'Solve', grade: options.grade ?? (text => ({ content_score: Number(text === '42'), outcome: 'correct' })) };
    if (options.tool) Object.assign(task, { make_simulator: () => simulator, tools: [{ type: 'function', name: 'act' }] });
    const budget = new AssessmentBudget(1, 20), config = { max_output_tokens: 100, timeout: 10, max_turns: 4, max_tool_calls: 3, ...settings };
    const client: AssessmentClient = options.client ?? { async post_responses_stream(body) { requests.push(structuredClone(body)); return [200, 0.1, {}, payloads.shift()] as GatewayResponse; } };
    const journal = new AssessmentJournal({ write(text) { records.push(JSON.parse(text)); } });
    const result = await run_assessment_sample(client, task, { model: 'test', thinking: options.thinking ?? 'default' }, 1, config, { prompt: 0.000001, completion: 0.000002 }, budget, journal, options.cancelled);
    return { result, requests, simulator, budget, records };
}
describe('assessment sample runner', () => {
    test('thinking comes from target and default omits reasoning', async () => {
        let run = await runSample([response([], '42')]); expect(run.result.ok).toBe(true); expect(run.requests[0]).not.toHaveProperty('reasoning');
        run = await runSample([response([], '42')], {}, { thinking: 'none' }); expect(run.requests[0]!.reasoning).toEqual({ effort: 'none' });
    });
    test('uncapped output omits the request field and accepts usage above the reservation estimate', async () => {
        const run = await runSample([response([], '42', { usage: { input_tokens: 10, output_tokens: 40000 } })], { max_output_tokens: undefined });
        expect(run.result.ok).toBe(true); expect(run.result.usage!.output_tokens).toBe(40000);
        expect(run.requests[0]).not.toHaveProperty('max_output_tokens');
        expect(run.result.execution_protocol.requests.test).not.toHaveProperty('max_output_tokens');
        expect(run.budget.stop_reason).toBeNull();
    });
    test('replays all output and call IDs, journals raw calls before tools and grading', async () => {
        const output = [{ type: 'reasoning', id: 'r1', summary: [] }, functionCall()];
        const run = await runSample([response(output), response([], 'done')], {}, { tool: true });
        expect(run.result.ok).toBe(true);
        const history = run.requests[1]!.input as Record<string, unknown>[];
        expect(history.slice(1, 3)).toEqual(output); expect(history[3]!.call_id).toBe('fc1');
        expect((run.simulator as Simulator).actions).toEqual([['act', { value: 2 }]]);
        expect(run.records.map(row => row.type)).toEqual(['call', 'tool_result', 'call', 'observation']);
        expect(run.result.usage).toEqual({ input_tokens: 20, output_tokens: 10 });
        expect(run.result.estimated_uncached_cost_usd).toBeCloseTo(0.00004);
    });
    test('missing usage and cap violations are ungraded and stop admission', async () => {
        const missing = await runSample([response([], '42', { usage: null })]);
        expect(missing.result.ok).toBe(false); expect(missing.result.grade).toBeNull(); expect(missing.result.usage).toBeNull(); expect(missing.result.estimated_uncached_cost_usd).toBeNull(); expect(missing.budget.stop_reason).toBe('missing_usage_cost');
        expect(missing.budget.admit({ max_output_tokens: 1 }, { prompt: 0, completion: 0 })).toBeNull();
        const cap = await runSample([response([], '42')], { max_output_tokens: 4 }); expect(cap.result.grade).toBeNull(); expect(cap.budget.stop_reason).toBe('upstream_output_cap_exceeded');
        for (const usage of [{ input_tokens: true, output_tokens: 1 }, { input_tokens: 1, output_tokens: -1 }, { input_tokens: 1.2, output_tokens: 1 }, parseAssessmentJson('{"input_tokens":10.0,"output_tokens":5}')]) expect((await runSample([response([], '42', { usage })])).result.usage).toBeNull();
    });
    test('incomplete, invalid output, empty answer and transport failures retain observations, not zero grades', async () => {
        const cases: [unknown, string][] = [[response([], '42', { status: 'incomplete' }), 'response_incomplete_or_error'], [response([], undefined, { output: [null] }), 'invalid_response_output'], [response([], '   '), 'empty_final_answer']];
        for (const [payload, outcome] of cases) {
            const run = await runSample([payload]); expect(run.result.status).toBe(outcome); expect(run.result.grade).toBeNull(); expect(run.records.at(-1)!.type).toBe('observation');
        }
        const failed = await runSample([], {}, { client: { post_responses_stream() { throw new TypeError('secret transport detail'); } } });
        expect(failed.budget.stop_reason).toBe('transport_failure'); expect(JSON.stringify(failed.records)).not.toContain('secret transport detail');
    });
    test('multiple tool calls execute in returned order and continue with every matching output', async () => {
        const output = [{type:'reasoning',id:'r',summary:[]},functionCall('a','{"value":2}'),functionCall('b','{"value":3}')];
        const simulator = new Simulator();let state=1;
        simulator.call=(name,args)=>{simulator.actions.push([name,args]);state=state*Number((args as {value:number}).value);return {state};};
        const run = await runSample([response(output), response([], 'done')], {}, { tool: true,simulator });
        expect(run.result.status).toBe('completed');expect(simulator.actions).toEqual([['act',{value:2}],['act',{value:3}]]);
        expect(run.requests.every(body=>!Object.hasOwn(body,'parallel_tool_calls'))).toBe(true);
        const history=run.requests[1]!.input as Record<string,unknown>[];
        expect(history.slice(1,4)).toEqual(output);
        expect(history.slice(4)).toEqual([{type:'function_call_output',call_id:'a',output:'{"state":2}'},{type:'function_call_output',call_id:'b',output:'{"state":6}'}]);
        expect(run.records.map(row=>row.type)).toEqual(['call','tool_result','tool_result','call','observation']);
        expect(run.result.tool_execution_policy).toBe('ordered-batch-v1');
    });
    test('duplicate and missing call IDs fail without executing again', async () => {
        let run = await runSample([response([functionCall()]), response([functionCall()])], {}, { tool: true }); expect(run.result.status).toBe('invalid_tool_call_id'); expect(run.result.tool_trace).toHaveLength(1);
        run = await runSample([response([{ ...functionCall(), call_id: null }])], {}, { tool: true }); expect(run.result.status).toBe('invalid_tool_call_id'); expect(run.result.tool_trace).toHaveLength(0);
        run = await runSample([response([functionCall('duplicate'),functionCall('duplicate')])], {}, {tool:true});expect(run.result.status).toBe('invalid_tool_call_id');expect((run.simulator as Simulator).actions).toEqual([]);
    });
    test('invalid and deep arguments reach simulator invariant checks as null', async () => {
        for (const arguments_ of ['{"x":1,"x":2}', '{"x":NaN}', '[]', '{"bad":' + '['.repeat(1200) + '0' + ']'.repeat(1200) + '}']) {
            const run = await runSample([response([functionCall('a', arguments_)]), response([], 'done')], {}, { tool: true });
            expect(run.result.ok).toBe(true); expect((run.simulator as Simulator).actions).toEqual([]); expect(run.result.tool_trace[0]!.result).toHaveProperty('argument_parse_error');
        }
    });
    test('turn and tool call limits leave grade null', async () => {
        const turn = await runSample([response([functionCall()])], { max_turns: 1 }, { tool: true }); expect(turn.result.status).toBe('turn_limit'); expect(turn.result.grade).toBeNull();
        const tools = await runSample([response([functionCall('a')]), response([functionCall('b')])], { max_tool_calls: 1 }, { tool: true }); expect(tools.result.status).toBe('tool_call_limit'); expect(tools.result.grade).toBeNull();
    });
    test('local grading and simulator errors preserve raw calls and observation', async () => {
        const grade = await runSample([response([], '42')], {}, { grade() { throw new Error('broken grader'); } }); expect(grade.result.status).toBe('grading_error'); expect(grade.result.grade).toBeNull();
        const simulator = new Simulator(); simulator.call = () => { throw new Error('broken simulator'); };
        const run = await runSample([response([functionCall()])], {}, { tool: true, simulator }); expect(run.result.status).toBe('simulator_error'); expect(run.result.grade).toBeNull(); expect(run.records.map(row => row.type)).toEqual(['call', 'tool_result', 'observation']);
    });
    test('cancellation before and after transport does not grade or execute tools', async () => {
        const before = await runSample([], {}, { cancelled: () => true }); expect(before.result.status).toBe('cancelled'); expect(before.budget.requests).toBe(0);
        let checks = 0;
        const after = await runSample([response([functionCall()])], {}, { tool: true, cancelled: () => ++checks >= 2 }); expect(after.result.status).toBe('cancelled'); expect(after.result.tool_trace).toEqual([]); expect(after.records.map(row => row.type)).toEqual(['call', 'observation']);
    });
    test('loop limits alter assessment identity but not request hash', async () => {
        const first = await runSample([response([], '42')], { max_turns: 1 }), second = await runSample([response([], '42')], { max_turns: 2 });
        expect(first.result.execution_protocol_sha256).toBe(second.result.execution_protocol_sha256); expect(first.result.assessment_protocol_sha256).not.toBe(second.result.assessment_protocol_sha256); expect(first.result.sample_id).not.toBe(second.result.sample_id);
    });
    test('storage failure prevents grading and simulator execution', async () => {
        let graded = false;
        await expect(run_assessment_sample({ post_responses_stream: () => [200, 0, {}, response([], '42')] }, { id: 'x', domain: 'test', kind: 'text', prompt: 'test', grade() { graded = true; return {}; } }, { model: 'm', thinking: 'default' }, 1, { max_output_tokens: 100, max_turns: 1, max_tool_calls: 1, timeout: 10 }, { prompt: 0, completion: 0 }, new AssessmentBudget(1, 1), { write() { throw new Error('disk full'); } })).rejects.toThrow('disk full');
        expect(graded).toBe(false);
    });
});
describe('budget and argument validation', () => {
    test('inflight reservations and request limits are atomic', () => {
        const budget = new AssessmentBudget(0.01, 2), pricing = { prompt: 0, completion: 0.001 };
        expect(budget.admit({ max_output_tokens: 6 }, pricing)).toBe(0.006); expect(budget.admit({ max_output_tokens: 6 }, pricing)).toBeNull(); expect(budget.requests).toBe(1);
        const requests = new AssessmentBudget(1, 1); requests.admit({ max_output_tokens: 1 }, pricing); expect(requests.admit({ max_output_tokens: 1 }, pricing)).toBeNull(); expect(requests.stop_reason).toBe('request_limit');
    });
    test('uncapped budget reservations are estimates rather than response caps', () => {
        const budget = new AssessmentBudget(1, 1), pricing = { prompt: 0, completion: 0.000002 };
        const reservation = budget.admit({}, pricing)!; expect(reservation).toBeCloseTo(0.065536);
        expect(budget.settle(reservation, response([], '42', { usage: { input_tokens: 10, output_tokens: 40000 } }), pricing, undefined)).toBeCloseTo(0.08);
        expect(budget.spent).toBeCloseTo(0.08); expect(budget.stop_reason).toBeNull();
    });
    test('unlimited budgets allow later samples after a transport failure', () => {
        const budget = new AssessmentBudget(null, null, 32768, true), pricing = { prompt: 0, completion: 0.000002 };
        const reservation = budget.admit({}, pricing)!;
        expect(budget.settle(reservation, { exception: 'TimeoutError' }, pricing, undefined, true)).toBeNull();
        expect(budget.missing_cost).toBe(1); expect(budget.stop_reason).toBeNull();
        expect(budget.admit({}, pricing)).not.toBeNull();
    });
    test('bounded JSON object parser', () => {
        for (const invalid of ['[]', '{"x":NaN}', '{"x":1,"x":2}', null, ' '.repeat(100001)]) expect(() => assessment_arguments(invalid)).toThrow();
        expect(assessment_arguments('{"x":2}')).toEqual({ x: 2 });
    });
});
