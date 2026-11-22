import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calibration_run, main, CALIBRATION_IMPORT_KIND } from './import_calibration.ts';
import { BenchDatabase } from '../src/bench_db.ts';
import { BenchExecutionService } from '../src/bench_execution.ts';

const metadata = {
    type: 'metadata',
    created_at: '2026-11-18T00:00:00Z',
    bank: { version: '2.3', task_ids: ['A', 'B'] },
    bank_scope: 'whole',
    tasks: [{ id: 'A' }, { id: 'B' }],
    targets: [{ model: 'm/x', thinking: 'high' }],
    rounds: 1,
    planned_samples: 2,
    config: { timeout: 600 },
    source_sha256: {}
};
const observation = (task: string, status = 'completed') => ({
    type: 'observation',
    task,
    model: 'm/x',
    thinking: 'high',
    round: 1,
    status,
    sample_id: task,
    calls: [task + ':1'],
    grade: status === 'completed' ? { content_score: 1 } : null,
    usage: { input_tokens: 1, output_tokens: 1 },
    estimated_uncached_cost_usd: 0.001
});

test('calibration journals become read-only runs with explicit status and no route identity', () => {
    const source = { file: 'x.jsonl', sha256: 'f'.repeat(64) };
    const done = calibration_run([metadata, observation('A'), observation('B'), { type: 'summary' }], 'r'.repeat(32), source);
    expect(done).toMatchObject({
        status: 'completed',
        execution_kind: CALIBRATION_IMPORT_KIND,
        imported_from: source,
        plan: { bank_version: '2.3', bank_scope: 'whole', sample_count: 2 }
    });
    expect((done.plan as any).targets[0]).toMatchObject({ id: 'target-1', route_id: null });
    expect((done.samples as any[]).every(sample => sample.target_id === 'target-1' && !('type' in sample))).toBe(true);
    expect(
        calibration_run([metadata, observation('A'), observation('B', 'api_failure'), { type: 'summary' }], 'r'.repeat(32), source).status
    ).toBe('failed');
    expect(calibration_run([metadata, observation('A')], 'r'.repeat(32), source).status).toBe('interrupted');
    expect(() => calibration_run([observation('A')], 'r'.repeat(32), source)).toThrow('metadata');
    expect(() => calibration_run([metadata, { ...observation('A'), model: 'other' }], 'r'.repeat(32), source)).toThrow('undeclared target');
});

test('import writes directly into SQLite privately, is idempotent and is never retried by the service', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'calibration-import-'));
    const input = join(directory, 'calibration.jsonl');
    const bytes =
        [
            metadata,
            { type: 'stream_chunk', sample_id: 'A', call_id: 'A:1', raw_stream_text: 'ignored' },
            {
                type: 'call',
                sample_id: 'A',
                call_id: 'A:1',
                turn: 1,
                http_status: 200,
                raw_response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } }
            },
            observation('A'),
            observation('B', 'api_failure'),
            { type: 'summary' }
        ]
            .map(row => JSON.stringify(row))
            .join('\n') + '\n';
    writeFileSync(input, bytes);
    const data = join(directory, 'data');
    expect(main(['--input', input, '--data-dir', data])).toBe(0);
    expect(main(['--input', input, '--data-dir', data])).toBe(0);
    const dbPath = join(data, 'mini-bench.sqlite');
    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    expect(existsSync(join(data, 'assessment'))).toBe(false);
    const db = new BenchDatabase(dbPath);
    const runs = db.list_run_ids();
    expect(runs).toHaveLength(1);
    const events = db.read_run_session_events(runs[0]!);
    expect(events.some(event => event.kind === 'llm_turn' && event.call_id === 'A:1')).toBe(true);
    db.close();
    const service = new BenchExecutionService(data, {
        resolve: () => {
            throw new Error('no route');
        },
        public_routes: () => []
    } as never);
    try {
        expect(service.list_runs()[0]).toMatchObject({ status: 'failed', execution_kind: CALIBRATION_IMPORT_KIND, retryable_samples: 0 });
        await expect(service.retry_run(runs[0]!, 'a'.repeat(32))).rejects.toThrow('read-only');
    } finally {
        await service.close();
    }
});
