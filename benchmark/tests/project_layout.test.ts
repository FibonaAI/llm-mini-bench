import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function projectFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? projectFiles(path) : [path];
  });
}

describe('TypeScript-only project layout', () => {
  test('keeps English default and Chinese document pairs with valid local links', () => {
    const documents = projectFiles(root).filter(path => path.endsWith('.md'));
    const proofFixtures = ['code-proofs', 'inference-proofs', 'information-proof', 'investigation-proofs']
      .map(name => join(root, 'benchmark/tests/fixtures', `assessment-2.2-${name}.md`));
    expect(documents.filter(path => !proofFixtures.includes(path))).toHaveLength(18);
    expect(documents.filter(path => proofFixtures.includes(path)).sort()).toEqual([...proofFixtures].sort());
    for (const path of documents) {
      const content = readFileSync(path, 'utf8');
      // Fixed mathematical certificates are test fixtures, not bilingual usage guides.
      if (!proofFixtures.includes(path)) {
        const counterpart = path.endsWith('.zh.md') ? path.replace(/\.zh\.md$/, '.md') : path.replace(/\.md$/, '.zh.md');
        expect(existsSync(counterpart)).toBe(true);
      }
      expect(path.includes('.zh-CN.')).toBe(false);
      if (!path.endsWith('.zh.md')) expect(content.split('\n')[0]).not.toMatch(/[\u4e00-\u9fff]/);
      for (const [, target] of content.matchAll(/\]\(([^)]+)\)/g)) {
        if (target!.includes('://') || target!.startsWith('#')) continue;
        expect(existsSync(resolve(dirname(path), target!.split('#')[0]!))).toBe(true);
      }
    }
  });

  test('keeps 1.0 as the production default and separates experimental bank data', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('llm-mini-bench');
    expect(pkg.main).toBe('./magpie/index.ts');
    expect(pkg.magpie.page.file).toBe('magpie/page/index.html');
    expect(readdirSync(join(root, 'benchmark/banks')).filter(name => name.endsWith('.json') && !name.endsWith('.questions.json')).sort()).toEqual(['assessment-1.0.json', 'assessment-2.0.json', 'assessment-2.1.json', 'assessment-2.2.json', 'assessment-2.3.json']);
    for (const name of ['src', 'backend', 'web', 'banks', 'baselines', 'tools', 'tests', 'examples']) {
      expect(existsSync(join(root, 'benchmark', name))).toBe(true);
      expect(existsSync(join(root, name))).toBe(false);
    }
    for (const name of ['plugins', 'page', 'benchmark/reports', 'magpie/index.mjs']) expect(existsSync(join(root, name))).toBe(false);
    expect(projectFiles(root).filter(path => path.endsWith('.py'))).toEqual([]);
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  test('publication files are explicit and retain all source, evidence and adapter entry points', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.files).toContain('benchmark/baselines/');
    expect(pkg.files).toContain('benchmark/banks/');
    expect(pkg.files).toContain('benchmark/src/');
    expect(pkg.files).toContain('benchmark/web/');
    expect(pkg.files).toContain('magpie/');
    expect(pkg.files).toContain('bun.lock');
    expect(pkg.files).toContain('README.zh.md');
    for (const path of pkg.files) {
      expect(existsSync(join(root, path))).toBe(true);
      expect(path).not.toMatch(/(?:node_modules|assessment\/|assessment-baselines|routes\.json|\.env|\.playwright-cli|\*\*)/);
    }
    expect(pkg.files).not.toContain('benchmark/');
    expect(pkg.magpie.options).toBeUndefined();
  });

  test('npm and GitHub instructions use unversioned project sources and require no install hooks', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    for (const name of ['README.md', 'README.zh.md']) {
      const content = readFileSync(join(root, name), 'utf8');
      expect(content).toContain(`npm:${pkg.name}`);
      expect(content).toContain('github:FibonaAI/llm-mini-bench');
      expect(content).not.toContain(`@${pkg.version}`);
      expect(content).not.toContain(`#v${pkg.version}`);
    }
    expect(pkg.scripts['test:install']).toBe('bun benchmark/tests/assessment_install_channels.ts');
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) expect(pkg.scripts).not.toHaveProperty(hook);
    expect(existsSync(join(root, 'benchmark/tests/assessment_install_channels.ts'))).toBe(true);
  });

  test('home pages explain user workflows rather than internal architecture or release checks', () => {
    const en = readFileSync(join(root, 'README.md'), 'utf8');
    const zh = readFileSync(join(root, 'README.zh.md'), 'utf8');
    expect(en).toContain('## Start with Magpie');
    expect(zh).toContain('## 在 Magpie 中开始');
    for (const content of [en, zh]) {
      expect(content).not.toContain('benchmark/web/');
      expect(content).not.toContain('magpie/page/');
      expect(content).not.toContain('test:install');
      expect(content).not.toContain('plugin-host');
      expect(content).not.toMatch(/^## (Project layout|目录说明|Release|发布)/m);
    }
  });

  test('CLI help is offline and works without external interpreters on PATH', async () => {
    for (const entry of ['benchmark/bench.ts', 'benchmark/calibrate_assessment.ts', 'benchmark/backend/mini_bench.ts', 'benchmark/tools/analyze_assessment.ts', 'benchmark/tools/import_assessment_baseline.ts', 'benchmark/tools/replay_assessment_evidence.ts']) {
      const child = Bun.spawn([process.execPath, join(root, entry), '--help'], { cwd: tmpdir(), env: { ...process.env, PATH: '' }, stdout: 'pipe', stderr: 'pipe' });
      const [output, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ status, error }).toEqual({ status: 0, error: '' });
      expect(output).toMatch(/usage:/i);
    }
  });

  test('actual plugin serves pinned bank and a clean personal workspace from Bun alone', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mini-bench-bun-host-'));
    const script = `
      const probe = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('probe')});
      const port = probe.port; await probe.stop(true);
      const {default:plugin}=await import(${JSON.stringify(join(root, 'magpie/index.ts'))});
      const token='isolated-host-test-token-0123456789012345';
      await plugin.server({}, {port,token});
      const base='http://127.0.0.1:'+port;
      const headers={'X-Mini-Bench-Token':token};
      const bank=await fetch(base+'/api/bench/banks',{headers}).then(r=>r.json());
      const baseline=await fetch(base+'/api/bench/baselines',{headers}).then(r=>r.json());
      const page=await fetch(base+'/').then(r=>r.status);
      const denied=await fetch(base+'/api/bench/banks').then(r=>r.status);
      const external=await fetch(base+'/api/bench/banks',{headers:{...headers,Origin:'https://example.invalid'}}).then(r=>r.status);
      console.log(JSON.stringify({tasks:bank.banks[0].tasks.length,baselines:baseline.baselines.length,page,denied,external}));
      process.exit(0);
    `;
    try {
      const child = Bun.spawn([process.execPath, '--eval', script], { cwd: directory, env: { ...process.env, PATH: '', MAGPIE_BENCH_DATA_DIR: directory, MAGPIE_BENCH_BASE_URL: 'http://127.0.0.1:1/v1' }, stdout: 'pipe', stderr: 'pipe' });
      const [output, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ status, error }).toEqual({ status: 0, error: '' });
      expect(JSON.parse(output)).toEqual({ tasks: 14, baselines: 0, page: 200, denied: 403, external: 403 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
