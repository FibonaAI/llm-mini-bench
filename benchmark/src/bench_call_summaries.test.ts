import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunCallSummaryReader, summarize_call_record } from './bench_call_summaries.ts';
import { observation_usage_accounting } from './assessment_observations.ts';
import { execution_result_quality } from './bench_execution_queries.ts';

const runId = 'a'.repeat(32);
const line = (value: unknown) => JSON.stringify(value) + '\n';

test('call summaries read main and retry journals, skip non-call lines and never return raw bodies', () => {
    const root = mkdtempSync(join(tmpdir(), 'call-summaries-'));
    const directory = join(root, runId),
        retry = join(directory, 'retry-' + 'b'.repeat(32));
    mkdirSync(retry, { recursive: true });
    // Escaped call markers inside stream text must not be mistaken for call records.
    writeFileSync(
        join(directory, 'journal.jsonl'),
        line({ type: 'stream_chunk', raw_stream_text: '{"type":"call"}' }) +
            line({
                type: 'call',
                call_id: 's1:1:1',
                sample_id: 's1',
                attempt_id: 'x',
                turn: 1,
                api_attempt: 1,
                http_status: 200,
                elapsed_seconds: 90.1,
                estimated_uncached_cost_usd: null,
                request: { secret: 'request body' },
                raw_response_text: 'raw stream',
                raw_response: { status: 'failed', error: { code: 'server_error', message: 'connection lost mid-reply' }, output: [] },
                stream: { terminal_event: 'response.failed', termination: 'terminal', first_output_seconds: 2.8, last_progress_seconds: 88 }
            })
    );
    writeFileSync(
        join(retry, 'journal.jsonl'),
        line({
            type: 'call',
            call_id: 's1:1:2',
            sample_id: 's1',
            http_status: -1,
            elapsed_seconds: 300,
            raw_response: { exception: 'TimeoutError' },
            stream: { termination: 'timeout' }
        }) + '{"type":"call", torn'
    );
    const reader = new RunCallSummaryReader(root);
    const calls = reader.read(runId)!;
    expect(calls.map(call => call.call_id)).toEqual(['s1:1:1', 's1:1:2']);
    expect(calls[0]).toMatchObject({
        http_status: 200,
        response_status: 'failed',
        error_code: 'server_error',
        error_message: 'connection lost mid-reply',
        terminal_event: 'response.failed',
        usage_known: false
    });
    expect(calls[1]).toMatchObject({ http_status: -1, local_exception: 'TimeoutError', termination: 'timeout' });
    expect(JSON.stringify(calls)).not.toContain('request body');
    expect(JSON.stringify(calls)).not.toContain('raw stream');
    // Cache refreshes when a journal grows.
    appendFileSync(
        join(directory, 'journal.jsonl'),
        line({
            type: 'call',
            call_id: 's2:1:1',
            sample_id: 's2',
            http_status: 200,
            raw_response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 2 } }
        })
    );
    expect(reader.read(runId)!.map(call => call.call_id)).toEqual(['s1:1:1', 's2:1:1', 's1:1:2']);
    expect(reader.read('../etc')).toBeNull();
    expect(reader.read('c'.repeat(32))).toBeNull();
});

test('call summary truncates long upstream messages', () => {
    const summary = summarize_call_record({
        type: 'call',
        call_id: 'c',
        sample_id: 's',
        raw_response: { error: { code: 'x', message: 'm'.repeat(1000) } }
    });
    expect(summary.error_message!.length).toBe(300);
});

test('attempts that sent no request are known zero usage; unknown attempts stay counted for lower bounds', () => {
    const samples = [
        // Retry recovered after a never-sent attempt: the total is fully known.
        {
            calls: ['n:1'],
            usage: { input_tokens: 10, output_tokens: 5 },
            estimated_uncached_cost_usd: 0.02,
            latest_attempt_usage: { input_tokens: 10, output_tokens: 5 },
            latest_attempt_cost_usd: 0.02,
            attempts: [{ status: 'budget_not_admitted', calls: [], usage: null, estimated_uncached_cost_usd: null }]
        },
        // A timed-out attempt returned no usage: it stays unknown.
        {
            calls: ['t:2'],
            usage: null,
            estimated_uncached_cost_usd: null,
            latest_attempt_usage: { input_tokens: 4, output_tokens: 1 },
            latest_attempt_cost_usd: 0.01,
            attempts: [{ status: 'api_failure', calls: ['t:1'], usage: null, estimated_uncached_cost_usd: null }]
        },
        { calls: ['k:1'], usage: { input_tokens: 1, output_tokens: 1 }, estimated_uncached_cost_usd: 0.001 }
    ];
    const accounting = observation_usage_accounting(samples);
    expect(accounting).toMatchObject({
        unknown_usage_attempts: 1,
        unknown_cost_attempts: 1,
        attempts: 5,
        usage_known: { input_tokens: 15, output_tokens: 7 }
    });
    expect(accounting.cost_known).toBeCloseTo(0.031);
    expect(observation_usage_accounting([samples[0]!, samples[2]!])).toMatchObject({
        unknown_cost_attempts: 0,
        usage_known: { input_tokens: 11, output_tokens: 6 }
    });
    // Samples without call evidence are not assumed to have sent nothing.
    expect(observation_usage_accounting([{ usage: null, estimated_uncached_cost_usd: null }]).unknown_cost_attempts).toBe(1);
});

test('result quality ignores never-sent prior attempts but keeps genuinely unknown ones', () => {
    const quality = execution_result_quality({
        samples: [
            {
                status: 'completed',
                grade: { content_score: 1 },
                usage: { input_tokens: 1, output_tokens: 1 },
                estimated_uncached_cost_usd: 0.1,
                attempts: [{ status: 'budget_not_admitted', calls: [] }]
            },
            {
                status: 'completed',
                grade: { content_score: 1 },
                usage: null,
                estimated_uncached_cost_usd: null,
                attempts: [{ status: 'api_failure', calls: ['x'] }]
            }
        ]
    } as never);
    expect(quality.prior_unknown_usage_samples).toBe(1);
    expect(quality.prior_unknown_cost_samples).toBe(1);
});

test('journal scanning propagates visitor errors and accepts a strict parser', async () => {
    const { scan_journal_call_records } = await import('./bench_call_summaries.ts');
    const root = mkdtempSync(join(tmpdir(), 'call-scan-'));
    const path = join(root, 'journal.jsonl');
    writeFileSync(
        path,
        line({ type: 'call', call_id: 'a' }) +
            line({ type: 'stream_chunk', raw_stream_text: 'x'.repeat(3 << 20) }) +
            line({ type: 'call', call_id: 'b' })
    );
    const seen: string[] = [];
    scan_journal_call_records(
        path,
        record => {
            seen.push(String(record.call_id));
        },
        text => JSON.parse(text)
    );
    expect(seen).toEqual(['a', 'b']);
    expect(() =>
        scan_journal_call_records(path, () => {
            throw new TypeError('evidence mismatch');
        })
    ).toThrow('evidence mismatch');
});

test('service journals keep stream chunks to their identity and text only', async () => {
    const { RunJournal, SampleJournal } = await import('./bench_execution_storage.ts');
    const directory = mkdtempSync(join(tmpdir(), 'compact-journal-'));
    const path = join(directory, 'journal.jsonl');
    const run = new RunJournal(path, ['secret-key']);
    const sample = new SampleJournal(
        run,
        { run_id: 'r', target_id: 't', route_id: 'route', account_ref: 'acct', account_evidence: 'gateway_binding', attempt_id: 'att' },
        () => {}
    );
    sample.write({
        type: 'stream_chunk',
        task: 'K04',
        model: 'm',
        thinking: 'high',
        round: 1,
        domain: 'd',
        sample_id: 's',
        call_id: 'x',
        turn: 1,
        api_attempt: 2,
        chunk_index: 0,
        elapsed_seconds: 0.5,
        raw_stream_text: 'data: secret-key\n\n'
    });
    sample.write({ type: 'call', task: 'K04', sample_id: 's', call_id: 'x', turn: 1, api_attempt: 2, raw_stream_chunks: 1 });
    run.close?.();
    const [chunk, call] = readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map(text => JSON.parse(text));
    // redaction_applied is added only because this chunk contained a secret.
    expect(Object.keys(chunk).sort()).toEqual([
        'attempt_id',
        'call_id',
        'chunk_index',
        'elapsed_seconds',
        'raw_stream_text',
        'redaction_applied',
        'sample_id',
        'type'
    ]);
    expect(chunk.call_id).toBe('att:1:2');
    expect(chunk.raw_stream_text).not.toContain('secret-key');
    expect(call).toMatchObject({ call_id: 'att:1:2', task: 'K04', run_id: 'r', route_id: 'route' });
});
