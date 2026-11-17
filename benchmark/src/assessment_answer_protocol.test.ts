import { expect, test } from 'bun:test';
import { AssessmentBudget, run_assessment_sample, type AssessmentClient, type RunnerConfig, type RunnerTask } from './assessment_runner.ts';
import { assessment_sample_protocol } from './run_protocol.ts';
import { load_assessment_bank } from './assessment_bank.ts';
import { SUBMIT_ANSWER_PROTOCOL, task_answer_protocol } from './assessment_answer_protocol.ts';

type Output = Record<string, unknown>;
const schema = { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] };
const config: RunnerConfig = { max_turns: null, max_tool_calls: null, timeout: 30, timeout_scope: 'sample', max_api_retries: 2 };
const target = { model: 'offline/model', thinking: 'high' };
const message = (text: string): Output => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const submit = (id: string, args: string): Output => ({ type: 'function_call', call_id: id, name: 'submit_answer', arguments: args });

/** Scripted client: each request receives the next list of output items. */
function scripted(turns: (Output[] | 'fail')[]) {
    const bodies: Record<string, any>[] = [];
    const client: AssessmentClient = {
        post_responses_stream(body) {
            bodies.push(structuredClone(body));
            const turn = turns[bodies.length - 1];
            if (turn === undefined || turn === 'fail') return [502, 0.1, {}, { error: 'bad gateway' }];
            return [200, 0.1, {}, { status: 'completed', output: turn, usage: { input_tokens: 3, output_tokens: 2 } }];
        }
    };
    return { client, bodies };
}
const textTask = (
    grade = (text: string) => ({
        content_score: text === '{"answer":42}' ? 1 : 0,
        outcome: 'graded',
        instruction_checks: { json_only: true }
    })
): RunnerTask => ({
    id: 'T1',
    domain: 'reasoning',
    kind: 'text',
    prompt: 'Compute.',
    answer_protocol: SUBMIT_ANSWER_PROTOCOL,
    answer_schema: schema,
    grade
});
const run = (client: AssessmentClient, task: RunnerTask) =>
    run_assessment_sample(
        client,
        task,
        target,
        1,
        config,
        { prompt: 0, completion: 0 },
        new AssessmentBudget(null, null),
        { write() {} },
        undefined,
        async () => {}
    );

test('text answers are ignored; only the submitted arguments are graded after the agent ends', async () => {
    const { client, bodies } = scripted([[message('{"answer":1} thinking...'), submit('c1', '{"answer":42}')], [message('Done.')]]);
    const observation = await run(client, textTask());
    expect(observation.status).toBe('completed');
    expect(observation.grade).toMatchObject({ content_score: 1, instruction_checks: { submitted_via_tool: true } });
    expect(observation.answer_submission).toMatchObject({
        call_id: 'c1',
        answer: { answer: 42 },
        submissions: 1,
        ended_after_submission: null
    });
    expect(bodies[0]!.tools).toEqual([{ type: 'function', name: 'submit_answer', description: expect.any(String), parameters: schema }]);
    expect(bodies[0]!.instructions).toContain('submit_answer');
    // The agent is told the answer was recorded and is allowed to end its own turn.
    expect(bodies[1]!.input.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'c1' });
    expect(JSON.parse(bodies[1]!.input.at(-1).output)).toMatchObject({ accepted: true });
});

test('the last valid submission wins; invalid arguments are rejected back to the model', async () => {
    const { client, bodies } = scripted([
        [submit('a', '{"answer":7}')],
        [submit('b', 'not json')],
        [submit('c', '{"answer":42}')],
        [message('')]
    ]);
    const observation = await run(client, textTask());
    expect(observation.grade).toMatchObject({ content_score: 1 });
    expect(observation.answer_submission).toMatchObject({ call_id: 'c', submissions: 3 });
    expect(JSON.parse(bodies[2]!.input.at(-1).output)).toMatchObject({ accepted: false });
    const earlier = scripted([[submit('a', '{"answer":42}')], [submit('b', '{"answer":7}')], [message('ok')]]);
    expect((await run(earlier.client, textTask())).grade).toMatchObject({ content_score: 0 });
});

test('an agent that ends without submitting scores a valid zero, even with a correct text answer', async () => {
    const { client } = scripted([[message('{"answer":42}')]]);
    const observation = await run(client, textTask());
    expect(observation.status).toBe('completed');
    expect(observation.grade).toEqual({
        content_score: 0,
        content_checks: {},
        instruction_checks: { submitted_via_tool: false },
        tool_checks: {},
        outcome: 'no_submission'
    });
    const empty = scripted([[message('')]]);
    expect((await run(empty.client, textTask())).grade).toMatchObject({ content_score: 0, outcome: 'no_submission' });
});

test('unknown tools get an error result instead of ending a text task', async () => {
    const { client, bodies } = scripted([
        [{ type: 'function_call', call_id: 'x', name: 'web_search', arguments: '{}' }],
        [submit('s', '{"answer":42}')],
        [message('done')]
    ]);
    const observation = await run(client, textTask());
    expect(observation.grade).toMatchObject({ content_score: 1 });
    expect(JSON.parse(bodies[1]!.input.at(-1).output).error).toContain('unknown tool');
});

test('an upstream failure after a valid submission grades that submission; without one it stays an API failure', async () => {
    const after = scripted([[submit('s', '{"answer":42}')], 'fail']);
    const observation = await run(after.client, textTask());
    expect(observation.status).toBe('completed');
    expect(observation.grade).toMatchObject({ content_score: 1 });
    expect(observation.answer_submission).toMatchObject({ ended_after_submission: 'api_failure' });
    const before = scripted(['fail']);
    const failed = await run(before.client, textTask());
    expect(failed.status).toBe('api_failure');
    expect(failed.grade).toBeNull();
});

test('interactive tasks keep their tools, and the simulator grades the submitted object', async () => {
    const graded: string[] = [];
    const task: RunnerTask = {
        id: 'I1',
        domain: 'tool_use',
        kind: 'tool',
        prompt: 'Inspect.',
        answer_protocol: SUBMIT_ANSWER_PROTOCOL,
        answer_schema: { type: 'object', properties: { report: { type: 'string' } } },
        tools: [{ type: 'function', name: 'inspect', parameters: { type: 'object' } }],
        make_simulator: () => ({
            call: name => ({ ok: name === 'inspect' }),
            grade: text => {
                graded.push(text);
                return { content_score: 0.5, outcome: 'partial' };
            }
        })
    };
    const { client, bodies } = scripted([
        [{ type: 'function_call', call_id: 'i', name: 'inspect', arguments: '{}' }],
        [submit('s', '{"report":"x"}')],
        [message('')]
    ]);
    const observation = await run(client, task);
    expect(bodies[0]!.tools.map((tool: { name: string }) => tool.name)).toEqual(['inspect', 'submit_answer']);
    expect(graded).toEqual(['{"report":"x"}']);
    expect(observation.grade).toMatchObject({ content_score: 0.5, instruction_checks: { submitted_via_tool: true } });
    expect(observation.tool_trace.map(step => step.name)).toEqual(['inspect', 'submit_answer']);
});

test('the protocol is opt-in, fails closed on unknown identifiers and changes the protocol hash', () => {
    expect(task_answer_protocol({})).toBeNull();
    expect(() => task_answer_protocol({ answer_protocol: 'submit-v0' })).toThrow('Unsupported task answer_protocol');
    // A free-form schema is not enough: the answer fields must be named.
    for (const answer_schema of [
        undefined,
        { type: 'object' },
        { type: 'object', properties: {} },
        { type: 'object', properties: { a: {} }, required: ['b'] }
    ])
        expect(() => task_answer_protocol({ answer_protocol: SUBMIT_ANSWER_PROTOCOL, answer_schema })).toThrow('answer_schema');
    const base = { id: 'T1', prompt: 'p', kind: 'text', answer_schema: schema };
    const legacy = assessment_sample_protocol(base, 'high', config, true).assessment_protocol_sha256;
    const submitted = assessment_sample_protocol(
        { ...base, answer_protocol: SUBMIT_ANSWER_PROTOCOL },
        'high',
        config,
        true
    ).assessment_protocol_sha256;
    expect(submitted).not.toBe(legacy);
    // Production 1.0 tasks never opt in.
    expect(load_assessment_bank('1.0').tasks.every(task => task_answer_protocol(task) === null)).toBe(true);
});

test('real data-defined graders score a submitted object exactly as a pure JSON answer', async () => {
    const bank = load_assessment_bank('2.3');
    const task = bank.tasks.find(
        task => task.kind === 'text' && (task.grading as Record<string, unknown>)?.type === 'assessment-exact-fields-v1'
    );
    if (!task) return;
    const expected = (task.grading as { expected: Record<string, unknown> }).expected;
    const { client } = scripted([[message('reasoning {not json}'), submit('s', JSON.stringify(expected))], [message('')]]);
    const properties = Object.fromEntries(Object.keys(expected).map(key => [key, {}]));
    const observation = await run(client, {
        ...task,
        answer_protocol: SUBMIT_ANSWER_PROTOCOL,
        answer_schema: { type: 'object', properties }
    });
    expect(observation.grade).toMatchObject({ content_score: 1 });
});

test('a streamed response.failed server_error is retried within the sample; other failure codes are not', async () => {
    const failed = (code: string) =>
        [200, 0.1, {}, { status: 'failed', output: [], error: { code, message: 'connection lost mid-reply' } }] as const;
    const bodies: unknown[] = [];
    const flaky: AssessmentClient = {
        post_responses_stream(body) {
            bodies.push(body);
            if (bodies.length === 1) return [...failed('server_error')] as never;
            if (bodies.length === 2)
                return [
                    200,
                    0.1,
                    {},
                    { status: 'completed', output: [submit('s', '{"answer":42}')], usage: { input_tokens: 3, output_tokens: 2 } }
                ];
            return [200, 0.1, {}, { status: 'completed', output: [message('')], usage: { input_tokens: 3, output_tokens: 2 } }];
        }
    };
    const observation = await run(flaky, textTask());
    expect(observation.status).toBe('completed');
    expect(observation.grade).toMatchObject({ content_score: 1 });
    expect(observation.api_request_count).toBe(3);
    let calls = 0;
    const permanent: AssessmentClient = {
        post_responses_stream() {
            calls++;
            return [...failed('invalid_prompt')] as never;
        }
    };
    expect((await run(permanent, textTask())).status).toBe('api_failure');
    expect(calls).toBe(1);
});
