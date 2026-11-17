import { expect, test } from 'bun:test';
import { load_assessment_bank, assessment_task_snapshot } from './assessment_bank.ts';
import { AssessmentBudget, run_assessment_sample, type RunnerConfig } from './assessment_runner.ts';
import { build_assessment_baseline, assessment_observations } from './assessment_baselines.ts';
import { capture_assessment_sources } from './assessment_provenance.ts';
import { GatewayClient } from './client.ts';

// The contract checks evidence and identity, not answer quality: an empty answer remains a real zero/partial grade.
test('production runner streamed results promote offline with legacy and new sample policies', async () => {
    const bank = load_assessment_bank(),
        cards = bank.tasks.map(assessment_task_snapshot);
    const requests: Record<string, unknown>[] = [];
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
            const body = (await request.json()) as Record<string, any>;
            requests.push(body);
            expect(body.stream).toBe(true);
            const task = bank.tasks.find(task => task.prompt === body.input[0].content)!;
            const output =
                task.kind === 'tool' && body.input.length === 1
                    ? [
                          {
                              type: 'function_call',
                              call_id: task.id + '-inspect',
                              name: (task.tools as { name: string }[])[0]!.name,
                              arguments: '{}'
                          }
                      ]
                    : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{}' }] }];
            const response = { status: 'completed', output, usage: { input_tokens: 2, output_tokens: 1 } };
            const bytes = new TextEncoder().encode(
                `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`
            );
            return new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(bytes.slice(0, 37));
                        controller.enqueue(bytes.slice(37));
                        controller.close();
                    }
                }),
                { headers: { 'Content-Type': 'text/event-stream' } }
            );
        }
    });
    try {
        const client = new GatewayClient(`http://127.0.0.1:${server.port}`, 'offline-key');
        const policies: { thinking: string; config: RunnerConfig & { max_output_tokens: number | null } }[] = [
            { thinking: 'default', config: { max_output_tokens: null, max_turns: null, max_tool_calls: null, timeout: 120 } },
            {
                thinking: 'none',
                config: {
                    max_output_tokens: null,
                    max_turns: null,
                    max_tool_calls: null,
                    timeout: 300,
                    timeout_scope: 'sample',
                    max_api_retries: 0
                }
            },
            {
                thinking: 'high',
                config: {
                    max_output_tokens: 128,
                    max_turns: 6,
                    max_tool_calls: 5,
                    timeout: 300,
                    timeout_scope: 'sample',
                    max_api_retries: 3
                }
            }
        ];
        for (const { thinking, config } of policies) {
            const target = {
                id: 'offline-target',
                route_id: 'offline-route',
                account_ref: 'offline-account',
                model: 'offline/model',
                thinking
            };
            const records: Record<string, unknown>[] = [],
                samples = [];
            const budget = new AssessmentBudget(null, null);
            for (const task of bank.tasks) {
                const observation = await run_assessment_sample(client, task, target, 1, config, { prompt: 0, completion: 0 }, budget, {
                    write(row) {
                        records.push(row);
                    }
                });
                expect(observation.status).toBe('completed');
                expect(observation.usage).toEqual({
                    input_tokens: task.kind === 'tool' ? 4 : 2,
                    output_tokens: task.kind === 'tool' ? 2 : 1
                });
                if (task.kind === 'tool') expect(observation.tool_trace).toHaveLength(1);
                samples.push({
                    ...observation,
                    run_id: 'offline-run',
                    target_id: target.id,
                    route_id: target.route_id,
                    account_ref: target.account_ref
                });
            }
            const { tasks: _tasks, ...bank_snapshot } = bank;
            const run = {
                id: 'offline-run',
                status: 'completed',
                created_at: '2026-11-11T00:00:00Z',
                plan: {
                    bank_version: '1.0',
                    bank_scope: 'whole',
                    bank_snapshot,
                    task_ids: bank.task_ids,
                    task_snapshots: cards,
                    source_sha256: capture_assessment_sources(bank).hashes,
                    targets: [target],
                    rounds: 1,
                    limits: config
                },
                samples
            };
            const baseline = build_assessment_baseline(run, target.id);
            expect(baseline.samples).toHaveLength(14);
            expect(baseline.limits).toEqual(config);
            expect(baseline.samples.every(sample => sample.execution_protocol.requests[sample.task]!.stream === true)).toBe(true);
            expect(assessment_observations([baseline], [run]).map(row => row.baseline_eligible)).toEqual([true, true]);
            for (const row of records.filter(row => row.type === 'tool_result')) {
                const index = records.indexOf(row);
                expect(records.slice(0, index).some(row => row.type === 'call')).toBe(true);
            }
            const firstCall = records.findIndex(row => row.type === 'call');
            expect(records.slice(0, firstCall).some(row => row.type === 'stream_chunk')).toBe(true);
            const contradictory = structuredClone(run);
            contradictory.samples[1]!.execution_protocol.requests[contradictory.samples[1]!.task] = {};
            expect(() => build_assessment_baseline(contradictory, target.id)).toThrow(
                'sample execution protocol is unknown or contradictory'
            );
        }
        expect(requests).toHaveLength(48);
    } finally {
        server.stop(true);
    }
});
