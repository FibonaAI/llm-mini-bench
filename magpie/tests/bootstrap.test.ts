import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createMagpieBenchPlugin } from '../mini_bench_plugin.ts';
import { startMagpieBenchService } from '../magpie_service.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = readFileSync(new URL('../page/boot.js', import.meta.url), 'utf8');
function harness(initial: Record<string, unknown> = {}, overrides: { setError?: boolean; remote?: string; hostname?: string } = {}) {
  let options = structuredClone(initial), writes = 0, reloads = 0;
  const redirects: string[] = [];
  const status = { textContent: '' };
  const starts: { token: string; port: number; accounts?: unknown }[] = [];
  const lifecycle = createMagpieBenchPlugin(async value => { starts.push(value); return { port: value.port, stop() {} }; });
  const bridge = {
    ready: Promise.resolve({ dark: true, tokens: {} }), service: overrides.remote ?? '',
    options: {
      get: async () => structuredClone(options),
      set: async (next: Record<string, unknown>) => {
        writes++;
        if (overrides.setError) throw new Error('private-token-in-error');
        options = structuredClone(next);
        await lifecycle.plugin.server({}, options);
        return structuredClone(options);
      }
    }
  };
  const run = () => runInNewContext(source, {
    window: { magpie: bridge }, crypto, Uint8Array, Uint16Array, URL, URLSearchParams,
    document: { getElementById: () => status },
    location: { hostname: overrides.hostname ?? 'localhost', reload() { reloads++; }, replace(value: string) { redirects.push(value); } }
  });
  return { run, status, starts, lifecycle, redirects, get options() { return options; }, get writes() { return writes; }, get reloads() { return reloads; } };
}

test('first plugin open generates private settings through the host bridge, then reconnects without user input', async () => {
  const h = harness();
  try {
    await h.run();
    expect(h.options.token).toMatch(/^[a-f0-9]{64}$/);
    expect(h.options.port).toBeGreaterThanOrEqual(49152);
    expect(h.options.port).toBeLessThanOrEqual(65535);
    expect(h.writes).toBe(1);
    expect(h.reloads).toBe(1);
    expect(h.redirects).toEqual([]);
    expect(h.starts).toHaveLength(1);
    await h.run();
    expect(h.writes).toBe(1);
    const target = new URL(h.redirects[0]!);
    expect(target.port).toBe(String(h.options.port));
    expect(new URLSearchParams(target.hash.slice(1)).get('token')).toBe(h.options.token as string);
    expect(target.searchParams.get('theme')).toBe('dark');
    expect(target.searchParams.has('token')).toBe(false);
    expect(target.searchParams.has('v')).toBe(false);
  } finally { await h.lifecycle.stop(); }
});

test('empty settings reach an authenticated real service through the automatic page handshake', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'llm-mini-bench-auto-start-'));
  let options: Record<string, unknown> = {}, reloads = 0;
  const redirects: string[] = [];
  const lifecycle = createMagpieBenchPlugin(value => startMagpieBenchService({ ...value, data_dir: directory }));
  const context = {
    window: { magpie: { ready: Promise.resolve({ dark: false }), options: {
      get: async () => options,
      set: async (next: Record<string, unknown>) => { options = structuredClone(next); await lifecycle.plugin.server({}, options); return options; }
    } } }, crypto, Uint8Array, Uint16Array, URL, URLSearchParams,
    document: { getElementById: () => ({ textContent: '' }) },
    location: { hostname: 'localhost', reload() { reloads++; }, replace(value: string) { redirects.push(value); } }
  };
  try {
    await lifecycle.plugin.server({}, {});
    await runInNewContext(source, context);
    expect(reloads).toBe(1);
    await runInNewContext(source, context);
    const target = new URL(redirects[0]!);
    const token = new URLSearchParams(target.hash.slice(1)).get('token')!;
    const response = await fetch(target.origin + '/api/bench/banks', { headers: { 'X-Mini-Bench-Token': token, Origin: 'null' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('null');
    expect((await response.json()).banks[0].tasks).toHaveLength(14);
    expect((await fetch(target.origin + '/api/bench/banks')).status).toBe(403);
  } finally { await lifecycle.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('existing settings and account bindings are retained without regenerating authentication', async () => {
  const saved = { token: 'existing-private-token-0000000000000000', port: 3481, accounts: [{ provider_id: 'fixture', account: 'a', account_ref: 'a' }] };
  const h = harness(saved);
  await h.run();
  expect(h.options).toEqual(saved);
  expect(h.writes).toBe(0);
  expect(h.reloads).toBe(0);
  expect(h.redirects[0]).toContain('127.0.0.1:3481/');
});

test('separate plugin installations get different secrets and preserve unrelated options', async () => {
  const a = harness({ accounts: [], custom: 'kept' }), b = harness();
  try {
    await Promise.all([a.run(), b.run()]);
    expect(a.options.token).not.toBe(b.options.token);
    expect(a.options.custom).toBe('kept');
    expect(a.options.accounts).toEqual([]);
  } finally { await Promise.all([a.lifecycle.stop(), b.lifecycle.stop()]); }
});

test('failed host persistence never redirects or reveals exception details', async () => {
  const h = harness({}, { setError: true });
  await h.run();
  expect(h.redirects).toEqual([]);
  expect(h.reloads).toBe(0);
  expect(h.status.textContent).toContain('暂时无法初始化');
  expect(h.status.textContent).not.toContain('private-token');
});

test('remote host proxy remains in use after automatic setup', async () => {
  const h = harness({ token: 'existing-private-token-0000000000000000', port: 50001 }, { remote: 'https://host.example/_magpie/service/', hostname: 'host.example' });
  await h.run();
  const target = new URL(h.redirects[0]!);
  expect(target.origin).toBe('https://host.example');
  expect(target.pathname).toBe('/_magpie/service/');
  expect(h.writes).toBe(0);
});
