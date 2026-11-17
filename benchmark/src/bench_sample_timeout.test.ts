import { expect, test } from 'bun:test';
import { AssessmentBudget, run_assessment_sample, type RunnerConfig, type RunnerTask } from '../calibrate_assessment.ts';
import { BenchExecutionService } from './bench_execution.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config: RunnerConfig = {
    max_output_tokens: null,
    max_turns: null,
    max_tool_calls: null,
    timeout: 0.03,
    timeout_scope: 'sample',
    max_api_retries: 3
};
const pricing = { prompt: 0.000001, completion: 0.000001 };
const answer = {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
    usage: { input_tokens: 10, output_tokens: 50000 }
};
const task: RunnerTask = {
    id: 'deadline-test',
    domain: 'test',
    kind: 'knowledge',
    prompt: 'fixed fixture',
    grade: () => ({ content_score: 1 })
};
const target = { model: 'fixture', thinking: 'default' };

test('production plans default to only a whole-sample deadline, with no hidden execution caps', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mini-bench-deadline-plan-'));
    const service = new BenchExecutionService(directory, {
        resolve: () => ({
            model: 'fixture',
            base_url: 'http://127.0.0.1:1/v1',
            api_key: 'fixture',
            account_ref: 'fixture',
            thinking_levels: [],
            account_concurrency: 1,
            pricing
        }),
        public_routes: () => []
    });
    try {
        const plan = await service.plan_task({ targets: [{ route_id: 'fixture' }] });
        expect(plan.limits).toEqual({
            max_requests: null,
            max_cost_usd: null,
            max_output_tokens: null,
            max_turns: null,
            max_tool_calls: null,
            max_api_retries: 3,
            timeout: 600,
            timeout_scope: 'sample'
        });
        expect(plan.total_max_cost_usd).toBeNull();
        expect(service._runs.size).toBe(0);
    } finally {
        await service.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('uncapped sample completes more than six turns and five tools without sending an output token cap', async () => {
    let calls = 0,
        tools = 0;
    const records: any[] = [];
    const toolTask: RunnerTask = {
        ...task,
        kind: 'tool',
        tools: [],
        make_simulator: () => ({
            call: () => {
                tools++;
                return { ok: true };
            },
            grade: () => ({ content_score: 1 })
        })
    };
    const client = {
        post_responses_stream: async (body: any) => {
            expect(Object.hasOwn(body, 'max_output_tokens')).toBe(false);
            calls++;
            return [
                200,
                0,
                {},
                calls <= 12
                    ? { ...answer, output: [{ type: 'function_call', call_id: 'tool-' + calls, name: 'fixed', arguments: '{}' }] }
                    : answer
            ] as any;
        }
    };
    const result = await run_assessment_sample(
        client,
        toolTask,
        target,
        1,
        { ...config, timeout: 1 },
        pricing,
        new AssessmentBudget(null, null),
        { write: r => records.push(r) }
    );
    expect(result.status).toBe('completed');
    expect(calls).toBe(13);
    expect(tools).toBe(12);
    expect(result.usage?.output_tokens).toBe(650000);
    expect(records.filter(row => row.type === 'call')).toHaveLength(13);
});

test('whole-sample timeout settles unknown usage, fails only that sample, and allows the next sample', async () => {
    const budget = new AssessmentBudget(null, null),
        records: any[] = [];
    let requests = 0;
    const started = Date.now();
    const failed = await run_assessment_sample(
        {
            post_responses_stream: () => {
                requests++;
                return new Promise(() => {});
            }
        },
        task,
        target,
        1,
        config,
        pricing,
        budget,
        { write: r => records.push(r) }
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(failed.status).toBe('api_failure');
    expect(failed.runner_error).toBe('SampleTimeout');
    expect(requests).toBe(1);
    expect(failed.usage).toBeNull();
    expect(budget.stop_reason).toBeNull();
    expect(records.filter(row => row.type === 'call')).toHaveLength(1);
    const completed = await run_assessment_sample(
        { post_responses_stream: async () => [200, 0, {}, answer] },
        task,
        target,
        2,
        config,
        pricing,
        budget,
        { write: r => records.push(r) }
    );
    expect(completed.status).toBe('completed');
    expect(budget.requests).toBe(2);
});

test('API backoff shares the sample deadline rather than granting a fresh timeout on every retry', async () => {
    let calls = 0;
    const waits: number[] = [];
    const result = await run_assessment_sample(
        {
            post_responses_stream: async () => {
                calls++;
                return [503, 0, {}, {}];
            }
        },
        task,
        target,
        1,
        config,
        pricing,
        new AssessmentBudget(null, null),
        { write() {} },
        undefined,
        async ms => {
            waits.push(ms);
            await Bun.sleep(ms + 2);
        }
    );
    expect(result.status).toBe('api_failure');
    expect(result.runner_error).toBe('SampleTimeout');
    expect(calls).toBe(1);
    expect(waits[0]).toBeLessThanOrEqual(30);
});

test('saved legacy request-scoped tool limits still replay without silently adopting the new policy', async () => {
    let calls = 0;
    const result = await run_assessment_sample(
        {
            post_responses_stream: async () => {
                calls++;
                return [
                    200,
                    0,
                    {},
                    {
                        ...answer,
                        output: [{ type: 'function_call', call_id: String(calls), name: 'fixed', arguments: '{}' }],
                        usage: { input_tokens: 1, output_tokens: 1 }
                    }
                ];
            }
        },
        { ...task, kind: 'tool', tools: [], make_simulator: () => ({ call: () => ({ ok: true }), grade: () => ({}) }) },
        target,
        1,
        { max_output_tokens: 8192, max_turns: 6, max_tool_calls: 1, timeout: 120, max_api_retries: 3 },
        pricing,
        new AssessmentBudget(3, 150),
        { write() {} }
    );
    expect(result.status).toBe('tool_call_limit');
    expect(calls).toBe(2);
});
