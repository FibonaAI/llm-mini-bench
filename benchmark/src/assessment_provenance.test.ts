import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ASSESSMENT_PROJECT_ROOT, load_assessment_bank } from './assessment_bank.ts';
import { ASSESSMENT_INTERACTIVE_SOURCE_PATHS } from './assessment_interactive.ts';
import { assessment_execution_source_paths, capture_assessment_sources, create_assessment_source_context } from './assessment_provenance.ts';
import { BenchExecutionService } from './bench_execution.ts';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'assessment-provenance-')); directories.push(path); return path; };

test('production 1.0 archives the unconditional loader closure without changing bank hashes', async () => {
    const bank = load_assessment_bank();
    expect(bank.extension_sha256).toBeUndefined();
    const paths = assessment_execution_source_paths(bank), { sources, hashes } = capture_assessment_sources(bank);
    for (const path of [...ASSESSMENT_INTERACTIVE_SOURCE_PATHS, 'src/assessment_runner.ts', 'src/bench_execution_storage.ts', 'src/bench_execution_queries.ts', 'src/assessment_provenance.ts', 'src/assessment_baselines.ts', 'src/assessment_observations.ts', 'src/bench_http_body.ts']) expect(paths).toContain(path);
    for (const [path, digest] of Object.entries(bank.source_sha256)) expect(hashes[path]).toBe(digest);
    const root = temporary();
    for (const [path, bytes] of sources) {
        expect(hashes[path]).toBe(createHash('sha256').update(bytes).digest('hex'));
        const destination = join(root, path); mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, bytes);
    }
    // Bank data are not execution sources. Copy their unchanged bytes beside the frozen module root.
    for (const path of ['banks/assessment-1.0.json', 'banks/assessment-1.0.questions.json']) {
        mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), readFileSync(join(ASSESSMENT_PROJECT_ROOT, path)));
    }
    const program = `const {load_assessment_bank}=await import(${JSON.stringify(join(root, 'src/assessment_bank.ts'))}); const bank=load_assessment_bank(); if(bank.task_ids.length!==14) throw new Error('Wrong production bank'); await import(${JSON.stringify(join(root, 'src/bench_execution.ts'))}); await import(${JSON.stringify(join(root, 'src/assessment_baselines.ts'))}); console.log(bank.task_sha256);`;
    const child = Bun.spawn([process.execPath, '--eval', program], { cwd: tmpdir(), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_PATH: '' } });
    const [output, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ status, error }).toEqual({ status: 0, error: '' }); expect(output.trim()).toBe(bank.task_sha256);
    const cli = Bun.spawn([process.execPath, join(root, 'calibrate_assessment.ts'), '--help'], { cwd: tmpdir(), stdout: 'pipe', stderr: 'pipe' });
    const [help, cliError, cliStatus] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    expect({ status: cliStatus, error: cliError }).toEqual({ status: 0, error: '' }); expect(help).toContain('Usage:');
});

test('service and calibration source registry select identical core bytes for every bank', async () => {
    const routes = { resolve() { return { account_ref: 'offline', base_url: 'http://127.0.0.1:1', model: 'offline/model', api_key: 'fixture-key', thinking_levels: [], account_concurrency: 1, pricing: { prompt: 0, completion: 0 } }; }, public_routes() { return []; } };
    const service = new BenchExecutionService(temporary(), routes);
    try {
        for (const version of ['1.0', '2.0', '2.1', '2.2', '2.3']) {
            const plan = await service.plan({ bank_version: version, targets: [{ id: 'offline', route_id: 'offline', thinking: 'default' }] });
            expect(plan.source_sha256).toEqual(capture_assessment_sources(load_assessment_bank(version)).hashes);
        }
    } finally { await service.close(); }
});

test('source verification contexts are lazy, query-local and retain a failed load', () => {
    let loads = 0;
    const context = create_assessment_source_context(() => { loads++; return load_assessment_bank(); });
    expect(loads).toBe(0); expect(context.production_bank()).toBe(context.production_bank());
    expect(context.production_cards()).toBe(context.production_cards()); expect(loads).toBe(1);
    const failure = new TypeError('Assessment bank: invalid source bytes');
    const bad = create_assessment_source_context(() => { loads++; throw failure; });
    for (let index = 0; index < 3; index++) expect(() => bad.production_bank()).toThrow(failure);
    expect(loads).toBe(2);
    create_assessment_source_context(() => { loads++; return load_assessment_bank(); }).production_bank(); expect(loads).toBe(3);
});
