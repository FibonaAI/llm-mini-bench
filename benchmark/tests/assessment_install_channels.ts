import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercise Magpie's Bun installation contract, without invoking the host CLI or real registries.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = mkdtempSync(join(tmpdir(), 'mini-bench-install-channels-'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const home = join(artifacts, 'home');
mkdirSync(home);
const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: artifacts,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    BUN_INSTALL_CACHE_DIR: join(artifacts, 'cache')
};
async function command(args: string[], cwd: string): Promise<string> {
    const child = Bun.spawn(args, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
    const [output, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(status, 0, `${args[0]} ${args[1]} failed:\n${error}\n${output}`);
    return output;
}
const source = join(artifacts, 'source');
mkdirSync(source);
// Use the release allowlist, not arbitrary local files, credentials or personal runs.
for (const path of ['package.json', ...pkg.files]) cpSync(join(root, path), join(source, path), { recursive: true });
await command([process.execPath, 'pm', 'pack', '--ignore-scripts', '--destination', artifacts], source);
const archiveName = `${pkg.name.replace(/^@/, '').replaceAll('/', '-')}-${pkg.version}.tgz`;
const archive = readFileSync(join(artifacts, archiveName));
const registryRequests: string[] = [];
const registry = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request): Response {
        const path = new URL(request.url).pathname;
        registryRequests.push(path);
        if (path === '/package.tgz') return new Response(archive, { headers: { 'Content-Type': 'application/octet-stream' } });
        if (decodeURIComponent(path.slice(1)) !== pkg.name) return new Response('Registry fixture has no such package', { status: 404 });
        return Response.json({
            name: pkg.name,
            'dist-tags': { latest: pkg.version },
            versions: {
                [pkg.version]: {
                    ...pkg,
                    devDependencies: undefined,
                    dist: {
                        tarball: `http://127.0.0.1:${registry.port}/package.tgz`,
                        shasum: createHash('sha1').update(archive).digest('hex'),
                        integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64')
                    }
                }
            }
        });
    }
});
async function smoke(channel: string, spec: string, registryUrl?: string) {
    const directory = join(artifacts, channel);
    mkdirSync(directory);
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'isolated-magpie-plugins', private: true }));
    await command([process.execPath, 'add', '--ignore-scripts', ...(registryUrl ? ['--registry', registryUrl] : []), spec], directory);
    const installed = join(directory, 'node_modules', pkg.name);
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.main, './magpie/index.ts');
    assert.equal(manifest.magpie.page.file, 'magpie/page/index.html');
    assert.ok(existsSync(join(installed, manifest.magpie.page.file)));
    const script = `
        const {default:plugin}=await import(${JSON.stringify(join(installed, manifest.main))});
        const {startMagpieBenchService}=await import(${JSON.stringify(join(installed, 'magpie/magpie_service.ts'))});
        const token='isolated-install-test-token-000000000000';
        const running=await startMagpieBenchService({port:0,token,data_dir:${JSON.stringify(join(directory, 'data'))}});
        try {
            const base='http://127.0.0.1:'+running.port;
            const headers={'X-Mini-Bench-Token':token};
            const banks=await fetch(base+'/api/bench/banks',{headers}).then(r=>r.json());
            const baselines=await fetch(base+'/api/bench/baselines',{headers}).then(r=>r.json());
            const page=await fetch(base+'/').then(r=>r.text());
            console.log(JSON.stringify({id:plugin.id,tasks:banks.banks[0].tasks.length,baselines:baselines.baselines.length,page:page.includes('LLM Mini Bench')}));
        } finally {await running.stop();}
    `;
    const child = Bun.spawn([process.execPath, '--eval', script], {
        cwd: directory,
        env: { ...env, MAGPIE_BENCH_BASE_URL: 'http://127.0.0.1:1/v1', MAGPIE_BENCH_DATA_DIR: join(directory, 'data') },
        stdout: 'pipe',
        stderr: 'pipe'
    });
    const [output, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(status, 0, error);
    assert.deepEqual(JSON.parse(output), { id: 'magpie-mini-bench', tasks: 12, baselines: 0, page: true });
    return { channel, version: manifest.version, ...JSON.parse(output) };
}
try {
    const npm = await smoke('npm', `${pkg.name}@${pkg.version}`, `http://127.0.0.1:${registry.port}`);
    assert.ok(registryRequests.includes('/package.tgz'), 'npm channel must install the actual registry tarball');
    await command(['git', 'init', '-b', 'main'], source);
    await command(['git', 'add', '.'], source);
    await command(
        [
            'git',
            '-c',
            'user.name=Install Fixture',
            '-c',
            'user.email=fixture@example.invalid',
            'commit',
            '-m',
            'Isolated plugin installation fixture'
        ],
        source
    );
    await command(['git', 'tag', `v${pkg.version}`], source);
    const git = await smoke('git', `git+file://${source}#v${pkg.version}`);
    console.log(
        JSON.stringify({
            passed: true,
            artifacts,
            channels: [npm, git],
            note: 'Local npm registry and Git ref; no public package/repository or Magpie CLI invoked.'
        })
    );
} finally {
    await registry.stop(true);
}
