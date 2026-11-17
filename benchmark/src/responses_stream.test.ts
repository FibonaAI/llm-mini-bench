import { describe, expect, test } from 'bun:test';
import { GatewayClient } from './client.ts';
import { ResponsesStreamDecoder, responses_stream_telemetry } from './responses_stream.ts';
import { AssessmentBudget, run_assessment_sample } from '../calibrate_assessment.ts';
import { execution_protocol_hash, target_execution_protocol } from './run_protocol.ts';

const answer = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '42世界' }] }], usage: { input_tokens: 2, output_tokens: 3 } };
const event = (type: string, rest: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`;
const complete = event('response.completed', { response: answer });
const sse = (text: string) => new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
const task = { id: 'fixture', domain: 'test', kind: 'text', prompt: '42', grade: (text: string) => ({ content_score: text === '42世界' ? 1 : 0 }) };
const config = { max_turns: null, max_tool_calls: null, timeout: 2, timeout_scope: 'sample' as const, max_api_retries: 0 };
const pricing = { prompt: 0, completion: 0 };

describe('Responses SSE decoding', () => {
    test('arbitrary character boundaries, CRLF/CR, BOM, comments and multiline data', () => {
        for (const newline of ['\n', '\r\n', '\r']) {
            const telemetry = responses_stream_telemetry(), frames: string[] = [];
            const decoder = new ResponsesStreamDecoder(telemetry, () => 1, text => frames.push(text));
            const text = '\uFEFF: heartbeat\n\n' + event('response.created', { response: { status: 'in_progress' } }) + complete.replace('data: {', 'data: {\ndata: ');
            for (const character of text.replaceAll('\n', newline)) decoder.push(character);
            decoder.finish();
            expect(decoder.response).toEqual(answer);
            expect(telemetry.event_count).toBe(2);
            expect(telemetry.first_output_seconds).toBeNull();
            expect(telemetry.terminal_event).toBe('response.completed');
            expect(frames.join('')).toContain('heartbeat');
        }
    });
    test('heartbeats are not output progress; deltas are receipt evidence only', () => {
        const telemetry = responses_stream_telemetry(); let time = 1;
        const decoder = new ResponsesStreamDecoder(telemetry, () => time++);
        decoder.push(': ping\n\n'); expect(telemetry.event_count).toBe(0);
        decoder.push(event('response.created')); expect(telemetry.first_output_seconds).toBeNull();
        decoder.push(event('response.reasoning_summary_text.delta', { delta: 'Checking' }));
        expect(telemetry.first_output_seconds).toBe(2);
        decoder.push(event('response.function_call_arguments.delta', { delta: '{}' }));
        expect(telemetry.last_progress_seconds).toBe(3);
    });
    test('truncation, DONE-only, duplicate keys and terminal mismatches fail closed', () => {
        for (const raw of ['', ': ping\n\n', 'data: [DONE]\n\n', 'data: {"type":"response.created","type":"response.completed"}\n\n', event('response.completed', { response: { status: 'in_progress' } }), 'event: other\ndata: {"type":"response.created"}\n\n', complete.trimEnd()]) {
            const decoder = new ResponsesStreamDecoder(responses_stream_telemetry(), () => 0);
            expect(() => { decoder.push(raw); decoder.finish(); }).toThrow();
        }
    });
    test('failed, incomplete and error events remain unsuccessful terminal responses', () => {
        for (const type of ['response.failed', 'response.incomplete', 'error']) {
            const decoder = new ResponsesStreamDecoder(responses_stream_telemetry(), () => 0);
            decoder.push(event(type, type === 'error' ? { message: 'failure' } : { response: { status: type.split('.')[1], usage: null } }));
            decoder.finish(); expect(decoder.response?.status).not.toBe('completed');
        }
    });
    test('streaming changes request provenance without rewriting old hashes', () => {
        const old = target_execution_protocol([{ id: 'x' }], 'high');
        const current = target_execution_protocol([{ id: 'x' }], 'high', true);
        expect(current.requests.x!.stream).toBe(true);
        expect(old.requests.x).not.toHaveProperty('stream');
        expect(execution_protocol_hash(current)).not.toBe(execution_protocol_hash(old));
        expect(() => execution_protocol_hash({ ...old, requests: { x: { stream: false } } })).toThrow();
    });
});

describe('Responses SSE HTTP and runner integration', () => {
    test('sends stream true and persists complete frames before grading, including split UTF-8', async () => {
        let sent: any;
        const frames: string[] = [];
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
            sent = await request.json();
            const bytes = new TextEncoder().encode(event('response.output_text.delta', { delta: '世界' }) + complete);
            return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
        } });
        try {
            const client = new GatewayClient(`http://127.0.0.1:${server.port}`, 'test-secret');
            const records: any[] = [];
            const result = await run_assessment_sample(client, { ...task, grade(text) { expect(records.some(row => row.type === 'stream_chunk')).toBe(true); expect(records.at(-1).type).toBe('call'); return task.grade(text); } }, { model: 'm', thinking: 'high' }, 1, config, pricing, new AssessmentBudget(null, null), { write(row) { records.push(row); if (row.type === 'stream_chunk') frames.push(String(row.raw_stream_text)); } });
            expect(sent.stream).toBe(true); expect(sent.reasoning).toEqual({ effort: 'high' });
            expect(result.status).toBe('completed'); expect(result.grade?.content_score).toBe(1);
            const call = records.find(row => row.type === 'call');
            expect(call.stream.event_count).toBe(2); expect(call.stream.terminal_event).toBe('response.completed');
            expect(call.raw_response.usage).toEqual(answer.usage); expect(frames.join('')).toContain('世界');
            expect(result.execution_protocol.requests.fixture!.stream).toBe(true);
        } finally { server.stop(true); }
    });
    test('does not downgrade JSON success or follow redirects; retains HTTP retry status', async () => {
        let status = 200, hits = 0;
        const target = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { hits++; return sse(complete); } });
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return Response.json(answer, { status, headers: { Location: `http://127.0.0.1:${target.port}`, 'Retry-After': '1' } }); } });
        try {
            const client = new GatewayClient(`http://127.0.0.1:${server.port}`, 'private-key');
            expect((await client.post_responses_stream({}))[0]).toBe(-1);
            status = 302; expect((await client.post_responses_stream({}))[0]).toBe(302);
            status = 429; const result = await client.post_responses_stream({}); expect(result[0]).toBe(429); expect(result[2]['retry-after']).toBe('1');
            expect(hits).toBe(0);
        } finally { server.stop(true); target.stop(true); }
    });
    test('returns immediately at terminal event without waiting for connection close', async () => {
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(complete)); } }), { headers: { 'Content-Type': 'text/event-stream' } }); } });
        try {
            const telemetry = responses_stream_telemetry();
            const result = await new GatewayClient(`http://127.0.0.1:${server.port}`, 'key').post_responses_stream({}, 0.3, { telemetry });
            expect(result[0]).toBe(200); expect(telemetry.termination).toBe('terminal');
        } finally { server.stop(true); }
    });
    test('partial stream deadline aborts, retains progress and never grades partial output', async () => {
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(event('response.output_text.delta', { delta: '42世界' }))); } }), { headers: { 'Content-Type': 'text/event-stream' } }); } });
        try {
            const records: any[] = []; let graded = false;
            const result = await run_assessment_sample(new GatewayClient(`http://127.0.0.1:${server.port}`, 'key'), { ...task, grade() { graded = true; return {}; } }, { model: 'm', thinking: 'high' }, 1, { ...config, timeout: 0.1 }, pricing, new AssessmentBudget(null, null), { write(row) { records.push(row); } });
            expect(result.status).toBe('api_failure'); expect(result.runner_error).toBe('SampleTimeout'); expect(graded).toBe(false);
            const call = records.find(row => row.type === 'call');
            expect(call.stream.first_output_seconds).not.toBeNull(); expect(call.stream.terminal_event).toBeNull(); expect(call.stream.termination).toBe('timeout');
            expect(records.some(row => row.type === 'stream_chunk')).toBe(true);
        } finally { server.stop(true); }
    });
    test('journal storage errors stop streaming without grading or retrying', async () => {
        let requests = 0;
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return sse(complete); } });
        try {
            const client = new GatewayClient(`http://127.0.0.1:${server.port}`, 'key');
            await expect(run_assessment_sample(client, task, { model: 'm', thinking: 'high' }, 1, { ...config, max_api_retries: 3 }, pricing, new AssessmentBudget(null, null), { write() { throw new Error('disk full'); } })).rejects.toThrow('disk full');
            expect(requests).toBe(1);
        } finally { server.stop(true); }
    });
    test('cancellation aborts a stalled stream without grading or issuing a continuation', async () => {
        let cancelled = false, requests = 0, graded = false;
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
            requests++; cancelled = true;
            return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(event('response.created'))); } }), { headers: { 'Content-Type': 'text/event-stream' } });
        } });
        try {
            const records: any[] = [];
            const result = await run_assessment_sample(new GatewayClient(`http://127.0.0.1:${server.port}`, 'key'), { ...task, grade() { graded = true; return {}; } }, { model: 'm', thinking: 'high' }, 1, config, pricing, new AssessmentBudget(null, null), { write(row) { records.push(row); } }, () => cancelled);
            expect(result.status).toBe('cancelled'); expect(graded).toBe(false); expect(requests).toBe(1);
            expect(records.find(row => row.type === 'call').stream.termination).toBe('aborted');
        } finally { server.stop(true); }
    });
    test('an early EOF is retried within policy, preserving the failed stream and final usage', async () => {
        let requests = 0;
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return sse(requests === 1 ? event('response.output_text.delta', { delta: 'partial' }) : complete); } });
        try {
            const records: any[] = [];
            const result = await run_assessment_sample(new GatewayClient(`http://127.0.0.1:${server.port}`, 'key'), task, { model: 'm', thinking: 'high' }, 1, { ...config, max_api_retries: 1 }, pricing, new AssessmentBudget(null, null), { write(row) { records.push(row); } }, undefined, async () => {});
            expect(result.status).toBe('completed'); expect(requests).toBe(2); expect(result.grade?.content_score).toBe(1);
            const calls = records.filter(row => row.type === 'call');
            expect(calls[0].stream.termination).toBe('protocol_error'); expect(calls[0].raw_response_text).toContain('partial');
            expect(calls[1].stream.terminal_event).toBe('response.completed');
            expect(result.usage).toBeNull(); expect(result.estimated_uncached_cost_usd).toBeNull();
        } finally { server.stop(true); }
    });
    test('complete tool calls execute only after terminal event and retain ordered continuation', async () => {
        let requests = 0, executed = 0;
        const records: any[] = [];
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
            const body: any = await request.json(); requests++;
            if (requests === 1) return sse(event('response.function_call_arguments.delta', { delta: '{' }) + event('response.completed', { response: { ...answer, output: [{ type: 'function_call', call_id: 'tool-1', name: 'fixed', arguments: '{}' }] } }));
            expect(body.input.at(-1).call_id).toBe('tool-1'); expect(body.input.at(-1).type).toBe('function_call_output');
            return sse(complete);
        } });
        try {
            const result = await run_assessment_sample(new GatewayClient(`http://127.0.0.1:${server.port}`, 'key'), { ...task, kind: 'tool', tools: [], make_simulator: () => ({ call() { expect(records.at(-1).type).toBe('call'); executed++; return { ok: true }; }, grade: task.grade }) }, { model: 'm', thinking: 'high' }, 1, config, pricing, new AssessmentBudget(null, null), { write(row) { records.push(row); } });
            expect(result.status).toBe('completed'); expect(executed).toBe(1); expect(requests).toBe(2);
            expect(result.usage).toEqual({ input_tokens: 4, output_tokens: 6 });
        } finally { server.stop(true); }
    });
});
