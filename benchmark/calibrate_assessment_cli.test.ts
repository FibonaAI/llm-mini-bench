import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { load_assessment_bank } from './src/assessment_bank.ts';
import {
    main,
    AssessmentCliArgumentError,
    assessment_hash,
    type RunnerTask,
    type CalibrationDependencies,
    type AssessmentObservation
} from './calibrate_assessment.ts';
const directories: string[] = [];
afterEach(() => {
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function setup(expectedVersion = '1.0') {
    const directory = mkdtempSync(join(tmpdir(), 'assessment-cli-'));
    directories.push(directory);
    const output = join(directory, 'result.jsonl');
    const task = (id: string): RunnerTask => ({
        id,
        title: id,
        domain: 'knowledge',
        kind: 'text',
        prompt: 'Return one JSON object.',
        version: 'synthetic-1',
        grade: () => ({ content_score: 1, content_checks: { answer: true }, instruction_checks: {}, outcome: 'correct' })
    });
    const tasks = [task('B'), task('A')];
    const snapshots = tasks.map(row => Object.fromEntries(Object.entries(row).filter(([, value]) => typeof value !== 'function')));
    const bank = {
        version: expectedVersion,
        title: 'Synthetic selected bank',
        task_ids: ['B', 'A'],
        task_sha256: assessment_hash(snapshots),
        source_sha256: { 'src/assessment_data.ts': 'mocked loader', 'src/assessment_json.ts': 'mocked loader' },
        selection: {},
        scoring_policy: { aggregate: 'none' },
        tasks
    };
    let banks = 0,
        catalogs = 0,
        clients = 0;
    const calls: { id: string; round: number; model: string; thinking: string }[] = [];
    const dependencies: CalibrationDependencies = {
        load_bank(version) {
            expect(version).toBe(expectedVersion);
            banks++;
            return bank;
        },
        client_factory() {
            clients++;
            return {
                async fetch_models_catalog() {
                    catalogs++;
                    return {
                        'mock-channel/mock-model': {
                            id: 'mock-channel/mock-model',
                            reasoning_levels: ['low', 'high'],
                            pricing: { prompt: '0.0000001', completion: '0.0000002' }
                        }
                    };
                },
                post_responses_stream() {
                    throw new Error('mock CLI must not send requests');
                }
            };
        },
        async run_sample(_client, task, target, round, _config, _pricing, _budget, journal) {
            calls.push({ id: task.id, round, ...target });
            const observation = { type: 'observation', task: task.id, model: target.model, thinking: target.thinking, round, ok: true };
            journal.write(observation);
            return observation as AssessmentObservation;
        }
    };
    return {
        output,
        bank,
        calls,
        dependencies,
        counts: () => ({ banks, catalogs, clients }),
        args: ['--target', 'mock-channel/mock-model=low', '--output', output, '--concurrency', '1'],
        records: () =>
            readFileSync(output, 'utf8')
                .trim()
                .split('\n')
                .map(line => JSON.parse(line)) as Record<string, unknown>[]
    };
}
describe('standalone calibration CLI', () => {
    test('uses only selected bank tasks in bank order and records all source provenance', async () => {
        const fixture = setup();
        await main(fixture.args, fixture.dependencies);
        expect(fixture.calls.map(call => call.id)).toEqual(['B', 'A']);
        expect(fixture.counts()).toEqual({ banks: 1, catalogs: 1, clients: 1 });
        const rows = fixture.records(),
            metadata = rows[0]!;
        expect(metadata.bank_scope).toBe('whole');
        expect(metadata.task_sha256).toBe(fixture.bank.task_sha256);
        expect(metadata.bank).not.toHaveProperty('tasks');
        expect(metadata.config).not.toHaveProperty('max_output_tokens');
        expect(metadata).toMatchObject({
            max_cost_usd: null,
            max_requests: null,
            config: { timeout: 600, timeout_scope: 'sample', max_turns: null, max_tool_calls: null }
        });
        const sources = metadata.source_sha256 as Record<string, string>;
        expect(Object.hasOwn(sources, 'src/assessment_bank.ts')).toBe(true);
        expect(Object.hasOwn(sources, 'src/assessment_json.ts')).toBe(true);
        expect(Object.hasOwn(sources, 'src/assessment_bank.py')).toBe(false);
        expect(sources['src/responses_stream.ts']).toMatch(/^[0-9a-f]{64}$/);
        expect(sources['src/bench_routes.ts']).toMatch(/^[0-9a-f]{64}$/);
        expect(rows.at(-1)).toMatchObject({ type: 'summary', samples: 2, completed: 2, planned_samples: 2 });
    });
    test.each(['1.0', '2.2'])('recorded %s source map imports frozen streaming execution without the repository', async version => {
        const fixture = setup(version);
        await main([...fixture.args, '--bank-version', version], {
            ...fixture.dependencies,
            load_bank: () => load_assessment_bank(version)
        });
        const root = join(dirname(fixture.output), 'source');
        for (const path of Object.keys(fixture.records()[0]!.source_sha256 as Record<string, string>)) {
            const destination = join(root, path);
            mkdirSync(dirname(destination), { recursive: true });
            writeFileSync(destination, readFileSync(join(import.meta.dir, path)));
        }
        const child = Bun.spawn([process.execPath, join(root, 'calibrate_assessment.ts'), '--help'], {
            cwd: tmpdir(),
            stdout: 'pipe',
            stderr: 'pipe'
        });
        const [output, error, status] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited
        ]);
        expect({ status, error }).toEqual({ status: 0, error: '' });
        expect(output).toContain('Usage:');
        const bankImport = Bun.spawn(
            [process.execPath, '--eval', `await import(${JSON.stringify(join(root, 'src/assessment_bank.ts'))})`],
            { cwd: tmpdir(), stdout: 'pipe', stderr: 'pipe' }
        );
        expect(await bankImport.exited).toBe(0);
        expect(await new Response(bankImport.stderr).text()).toBe('');
    });
    test('arbitrary path-safe versions use the same loader and source provenance', async () => {
        const fixture = setup('2.0');
        await main([...fixture.args, '--bank-version', '2.0', '--max-output-tokens', '128'], fixture.dependencies);
        expect(fixture.records()[0]!.config).toHaveProperty('max_output_tokens', 128);
        expect(fixture.records()[0]!.bank).toHaveProperty('version', '2.0');
        expect(Object.hasOwn(fixture.records()[0]!.source_sha256 as Record<string, string>, 'src/assessment_data.ts')).toBe(true);
    });
    test('extension source provenance is retained in calibration evidence', async () => {
        const fixture = setup('2.1');
        Object.assign(fixture.bank, { extension_sha256: { 'src/assessment_blackbox.ts': 'mocked loader' } });
        await main([...fixture.args, '--bank-version', '2.1'], fixture.dependencies);
        const sources = fixture.records()[0]!.source_sha256 as Record<string, string>;
        expect(sources['src/assessment_blackbox.ts']).toMatch(/^[0-9a-f]{64}$/);
    });
    test('subsets retain full-bank provenance and bank ordering', async () => {
        const fixture = setup();
        await main([...fixture.args, '--task-ids', 'A'], fixture.dependencies);
        expect(fixture.calls.map(call => call.id)).toEqual(['A']);
        const metadata = fixture.records()[0]!;
        expect(metadata.bank_scope).toBe('subset');
        expect(metadata.task_sha256).not.toBe(fixture.bank.task_sha256);
        expect(metadata.bank).toHaveProperty('task_ids', ['B', 'A']);
        const all = setup();
        await main([...all.args, '--task-ids', 'A', 'B'], all.dependencies);
        expect(all.calls.map(call => call.id)).toEqual(['B', 'A']);
    });
    test('unknown, duplicate or unpublished IDs never construct clients or create output', async () => {
        for (const ids of [['OUTSIDE'], ['A', 'OUTSIDE'], ['A', 'A']]) {
            const fixture = setup();
            await expect(main([...fixture.args, '--task-ids', ...ids], fixture.dependencies)).rejects.toThrow(AssessmentCliArgumentError);
            expect(fixture.counts()).toEqual({ banks: 1, catalogs: 0, clients: 0 });
            expect(existsSync(fixture.output)).toBe(false);
        }
    });
    test('explicit continuation is correctly labeled through round three', async () => {
        const fixture = setup();
        await main([...fixture.args, '--round-start', '2', '--rounds', '2'], fixture.dependencies);
        expect(fixture.calls.map(call => call.round)).toEqual([2, 2, 3, 3]);
        expect(fixture.records()[0]).toMatchObject({ round_start: 2, rounds: 2, planned_samples: 4 });
    });
    test('all safety flags reject invalid values before loading bank or contacting catalog', async () => {
        for (const extra of [
            ['--round-start', '3', '--rounds', '2'],
            ['--rounds', '0'],
            ['--round-start', '4'],
            ['--max-output-tokens', '127'],
            ['--max-turns', '13'],
            ['--max-tool-calls', '13'],
            ['--timeout', '9'],
            ['--concurrency', '5'],
            ['--max-requests', '501'],
            ['--max-cost-usd', 'NaN'],
            ['--max-cost-usd', '11'],
            ['--bank-version', '../2.0'],
            ['--concurrency', '1.5']
        ]) {
            const fixture = setup();
            await expect(main([...fixture.args, ...extra], fixture.dependencies)).rejects.toThrow(AssessmentCliArgumentError);
            expect(fixture.counts()).toEqual({ banks: 0, catalogs: 0, clients: 0 });
            expect(existsSync(fixture.output)).toBe(false);
        }
    });
    test('rejects duplicate targets, unadvertised thinking and unknown model routes', async () => {
        for (const extra of [
            ['--target', 'mock-channel/mock-model=low'],
            ['--target', 'mock-channel/mock-model=unknown'],
            ['--target', 'unknown=low']
        ]) {
            const fixture = setup();
            await expect(main([...fixture.args, ...extra], fixture.dependencies)).rejects.toThrow(AssessmentCliArgumentError);
            expect(existsSync(fixture.output)).toBe(false);
        }
    });
    test('existing evidence is never overwritten; help requires no models', async () => {
        const fixture = setup();
        writeFileSync(fixture.output, 'existing evidence');
        await expect(main(fixture.args, fixture.dependencies)).rejects.toThrow();
        expect(readFileSync(fixture.output, 'utf8')).toBe('existing evidence');
        const help = setup();
        await main(['--help'], help.dependencies);
        expect(help.counts()).toEqual({ banks: 0, catalogs: 0, clients: 0 });
    });
});

test('a slow sample frees no slot until it ends, but other slots keep starting new samples', async () => {
    const f = setup();
    const started: string[] = [];
    let releaseSlow!: () => void;
    const slow = new Promise<void>(resolve => {
        releaseSlow = resolve;
    });
    f.dependencies.run_sample = async (_client, task, target, round, _config, _pricing, _budget, journal) => {
        const key = `${task.id}:${round}`;
        started.push(key);
        if (key === 'B:1') await slow;
        else await new Promise(resolve => setTimeout(resolve, 1));
        const observation = { type: 'observation', task: task.id, model: target.model, thinking: target.thinking, round, ok: true };
        journal.write(observation);
        return observation as AssessmentObservation;
    };
    const run = main([...f.args.slice(0, -1), '2', '--rounds', '3'], f.dependencies);
    for (let i = 0; i < 50 && started.length < 6; i++) await new Promise(resolve => setTimeout(resolve, 2));
    // With batch waiting only two samples could start while B:1 is stuck; the pool runs all others.
    expect(started).toHaveLength(6);
    releaseSlow();
    await run;
    // Journal summary still counts every sample and observations keep job order.
    expect(f.records().filter(row => row.type === 'observation')).toHaveLength(6);
    expect(f.records().at(-1)).toMatchObject({ type: 'summary', samples: 6, planned_samples: 6 });
});
