import { describe, expect, test } from 'bun:test';
import { GatewayClient } from './client.ts';
import { AssessmentBudget, AssessmentJournal, run_assessment_sample } from '../calibrate_assessment.ts';

describe('Responses-only HTTP transport', () => {
    test('sends exact model and explicit account credentials, parses complete Responses payload', async () => {
        const calls: { path: string; authorization: string | null; body: unknown }[] = [];
        const server = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            async fetch(request) {
                const path = new URL(request.url).pathname;
                const body = request.method === 'POST' ? await request.json() : null;
                calls.push({ path, authorization: request.headers.get('authorization'), body });
                return Response.json(
                    path === '/v1/models'
                        ? { data: [{ id: 'same-model', pricing: { prompt: 0, completion: 0 } }] }
                        : { status: 'completed', output_text: '42', usage: { input_tokens: 10, output_tokens: 2 } }
                );
            }
        });
        try {
            const base = `http://127.0.0.1:${server.port}`;
            const first = new GatewayClient(base, 'secret-account-a'),
                second = new GatewayClient(base + '/v1/', 'secret-account-b');
            expect(await first.fetch_models_catalog()).toHaveProperty('same-model');
            const [a, b] = await Promise.all([
                first.post_responses_non_stream({ model: 'same-model', input: 'test', reasoning: { effort: 'none' } }),
                second.post_responses_non_stream({ model: 'same-model', input: 'test', reasoning: { effort: 'high' } })
            ]);
            expect(a[0]).toBe(200);
            expect(b[0]).toBe(200);
            expect(a[3]).toHaveProperty('output_text', '42');
            expect(calls.map(call => call.path)).toEqual(['/v1/models', '/v1/responses', '/v1/responses']);
            expect(
                calls
                    .slice(1)
                    .map(call => call.authorization)
                    .sort()
            ).toEqual(['Bearer secret-account-a', 'Bearer secret-account-b']);
        } finally {
            server.stop(true);
        }
    });
    test('neither catalog nor model requests forward credentials across redirects or retry', async () => {
        let received = 0,
            sent = 0;
        const target = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            fetch() {
                received++;
                return Response.json({});
            }
        });
        const origin = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            fetch() {
                sent++;
                return new Response('', { status: 302, headers: { Location: `http://127.0.0.1:${target.port}/received` } });
            }
        });
        try {
            const client = new GatewayClient(`http://127.0.0.1:${origin.port}`, 'private-key');
            expect((await client.post_responses_non_stream({ model: 'm', input: 'test' }))[0]).toBe(302);
            expect(await client.fetch_models_catalog()).toEqual({});
            expect(received).toBe(0);
            expect(sent).toBe(2);
        } finally {
            origin.stop(true);
            target.stop(true);
        }
    });
    test('strict JSON, raw HTTP error capture and sanitized transport failures', async () => {
        let text = '{"status":"completed","status":"incomplete"}',
            status = 200;
        const server = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            fetch() {
                return new Response(text, { status });
            }
        });
        const client = new GatewayClient(`http://127.0.0.1:${server.port}`, 'private-key');
        try {
            const malformed = await client.post_responses_non_stream({});
            expect(malformed[0]).toBe(-1);
            expect(malformed[4]).toBe(text);
            status = 429;
            text = 'x'.repeat(1000);
            const error = await client.post_responses_non_stream({});
            expect(error[0]).toBe(429);
            expect(error[3]).toEqual({ raw_error: 'x'.repeat(400) });
            expect(error[4]).toBe(text);
        } finally {
            server.stop(true);
        }
        const failed = await client.post_responses_non_stream({});
        expect(failed[0]).toBe(-1);
        expect(failed[4]).toBeUndefined();
        expect(JSON.stringify(failed[3])).not.toContain('private-key');
        expect(JSON.stringify(failed[3])).not.toContain('127.0.0.1');
    });
    test('runner rejects non-integer usage tokens during streaming without storing stream_chunk rows', async () => {
        const raw = '{"status":"completed","usage":{"input_tokens":10.0,"output_tokens":5},"output":[],"output_text":"42"}';
        const terminal = `data: {"type":"response.completed","response":${raw}}\n\n`;
        const server = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            fetch() {
                return new Response(terminal, { headers: { 'Content-Type': 'text/event-stream' } });
            }
        });
        try {
            const client = new GatewayClient(`http://127.0.0.1:${server.port}`, 'private-key');
            const budget = new AssessmentBudget(1, 1),
                pricing = { prompt: 0, completion: 0 };
            let evidence = '';
            const observation = await run_assessment_sample(
                client,
                {
                    id: 'test',
                    domain: 'test',
                    kind: 'text',
                    prompt: 'Return 42',
                    grade() {
                        throw new Error('invalid usage must not reach grading');
                    }
                },
                { model: 'm', thinking: 'high' },
                1,
                { max_output_tokens: 100, max_turns: 1, max_tool_calls: 1, timeout: 10 },
                pricing,
                budget,
                new AssessmentJournal({
                    write(line) {
                        evidence += line;
                    }
                })
            );
            expect(observation.status).toBe('usage_or_cap_failure');
            expect(budget.stop_reason).toBe('missing_usage_cost');
            const rows = evidence
                .trim()
                .split('\n')
                .map(line => JSON.parse(line));
            const call = rows.find(row => row.type === 'call');
            expect(call).toBeDefined();
            expect(call.raw_response_text).toBeUndefined();
            expect(rows.some(row => row.type === 'stream_chunk')).toBe(false);
        } finally {
            server.stop(true);
        }
    });
    test('rejects remote cleartext and URL/header credential injection', () => {
        for (const base of ['http://remote.example', 'https://user:pass@example.com', 'https://example.com?key=secret'])
            expect(() => new GatewayClient(base, 'key')).toThrow(TypeError);
        for (const key of ['', 'bad\nheader', 'bad key']) expect(() => new GatewayClient('https://example.com', key)).toThrow(TypeError);
    });
});
