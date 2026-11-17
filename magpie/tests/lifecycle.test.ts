import { describe, expect, test } from 'bun:test';
import { createMagpieBenchPlugin } from '../mini_bench_plugin.ts';

const token = 'test-only-token-0123456789-0123456789';

describe('Magpie in-process service lifecycle', () => {
  test('rejects invalid configuration without creating a service', async () => {
    let starts = 0;
    const lifecycle = createMagpieBenchPlugin(async ({ port }) => { starts++; return { port, stop() {} }; });
    expect(lifecycle.plugin.id).toBe('magpie-mini-bench');
    expect(await lifecycle.plugin.server({}, {})).toEqual({});
    for (const port of [0, 65536, 1.5, 'invalid']) {
      await expect(lifecycle.plugin.server({}, { token, port })).rejects.toThrow('port must be between');
    }
    expect(starts).toBe(0);
  });

  test('serializes concurrent starts and restarts only on configuration changes', async () => {
    const calls: { token: string; port: number }[] = [];
    let stops = 0;
    const lifecycle = createMagpieBenchPlugin(async options => {
      calls.push(options);
      return { port: options.port, async stop() { stops++; } };
    });
    await Promise.all(Array.from({ length: 4 }, () => lifecycle.plugin.server({}, { token, port: 3499 })));
    expect(calls).toEqual([{ token, port: 3499 }]);
    await lifecycle.plugin.server({}, { token: token + '-rotated', port: 3499 });
    expect(stops).toBe(1);
    expect(calls).toHaveLength(2);
    await lifecycle.plugin.server({}, { token });
    expect(calls.at(-1)?.port).toBe(3481);
    expect(stops).toBe(2);
    await lifecycle.stop();
    await lifecycle.stop();
    expect(stops).toBe(3);
  });

  test('account configuration changes reload only this service and invalid edits retain it', async () => {
    let starts = 0, stops = 0;
    const lifecycle = createMagpieBenchPlugin(async ({ port }) => { starts++; return { port, stop() { stops++; } }; });
    const first = [{ provider_id: 'fixture', account: 'a@example.invalid', account_ref: 'a' }];
    await lifecycle.plugin.server({}, { token, accounts: first });
    await lifecycle.plugin.server({}, { token, accounts: structuredClone(first) });
    expect(starts).toBe(1);
    await expect(lifecycle.plugin.server({}, { token, accounts: [{ ...first[0], key: 'inline-secret' }] })).rejects.toThrow('account binding');
    expect(stops).toBe(0);
    await lifecycle.plugin.server({}, { token, accounts: [{ ...first[0], account: 'b@example.invalid' }] });
    expect(starts).toBe(2);
    expect(stops).toBe(1);
    await lifecycle.stop();
  });

  test('recovers from failed starts and stops an active service when token is cleared', async () => {
    let starts = 0, stops = 0;
    const lifecycle = createMagpieBenchPlugin(async ({ port }) => {
      if (++starts === 1) throw new Error('Test service startup failed');
      return { port, stop() { stops++; } };
    });
    await expect(lifecycle.plugin.server({}, { token })).rejects.toThrow('Test service startup failed');
    await lifecycle.plugin.server({}, { token });
    await lifecycle.plugin.server({}, { token: '' });
    expect(starts).toBe(2);
    expect(stops).toBe(1);
  });
});
