import { describe, expect, test } from 'bun:test';
import { createMagpieBenchPlugin } from '../mini_bench_plugin.ts';

const token = 'test-only-token-0123456789-0123456789';

describe('Magpie in-process service lifecycle', () => {
  test('rejects invalid configuration without creating a service', async () => {
    let starts = 0;
    const lifecycle = createMagpieBenchPlugin(async ({ port }) => {
      starts++;
      return { port, stop() {} };
    });
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
      return {
        port: options.port,
        async stop() {
          stops++;
        }
      };
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
    let starts = 0,
      stops = 0;
    const lifecycle = createMagpieBenchPlugin(async ({ port }) => {
      starts++;
      return {
        port,
        stop() {
          stops++;
        }
      };
    });
    const first = [{ provider_id: 'fixture', account: 'a@example.invalid', account_ref: 'a' }];
    await lifecycle.plugin.server({}, { token, accounts: first });
    await lifecycle.plugin.server({}, { token, accounts: structuredClone(first) });
    expect(starts).toBe(1);
    await expect(lifecycle.plugin.server({}, { token, accounts: [{ ...first[0], key: 'inline-secret' }] })).rejects.toThrow(
      'account binding'
    );
    expect(stops).toBe(0);
    await lifecycle.plugin.server({}, { token, accounts: [{ ...first[0], account: 'b@example.invalid' }] });
    expect(starts).toBe(2);
    expect(stops).toBe(1);
    await lifecycle.stop();
  });

  test('recovers from failed starts and stops an active service when token is cleared', async () => {
    let starts = 0,
      stops = 0;
    const lifecycle = createMagpieBenchPlugin(async ({ port }) => {
      if (++starts === 1) throw new Error('Test service startup failed');
      return {
        port,
        stop() {
          stops++;
        }
      };
    });
    await expect(lifecycle.plugin.server({}, { token })).rejects.toThrow('Test service startup failed');
    await lifecycle.plugin.server({}, { token });
    await lifecycle.plugin.server({}, { token: '' });
    expect(starts).toBe(2);
    expect(stops).toBe(1);
  });
});

describe('busy port recovery', () => {
  const busy = () => Object.assign(new Error('Failed to start server. Is port in use?'), { code: 'EADDRINUSE' });
  const manualSleep = () => {
    const waits: { ms: number; signal?: AbortSignal; resolve: () => void }[] = [];
    return {
      waits,
      sleep: (ms: number, signal?: AbortSignal) =>
        new Promise<void>(resolve => {
          waits.push({ ms, signal, resolve });
          signal?.addEventListener('abort', () => resolve(), { once: true });
        }),
      tick: async () => {
        waits.shift()?.resolve();
        for (let i = 0; i < 5; i++) await Promise.resolve();
        await new Promise(r => setTimeout(r, 0));
      }
    };
  };

  test('a port held by an old host is retried in the background until it frees', async () => {
    let attempts = 0;
    const clock = manualSleep();
    const lifecycle = createMagpieBenchPlugin(
      async ({ port }) => {
        if (++attempts < 3) throw busy();
        return { port, stop() {} };
      },
      { sleep: clock.sleep, delays: [1, 1, 1] }
    );
    expect(await lifecycle.plugin.server({}, { token, port: 3499 })).toEqual({});
    expect(attempts).toBe(1);
    // Same configuration while waiting does not start a second retry loop.
    await lifecycle.plugin.server({}, { token, port: 3499 });
    expect(attempts).toBe(1);
    await clock.tick();
    expect(attempts).toBe(2);
    await clock.tick();
    expect(attempts).toBe(3);
    await clock.tick();
    expect(attempts).toBe(3);
  });

  test('continues polling at low frequency after initial backoff when an old host drains slowly', async () => {
    let attempts = 0;
    const observedDelays: number[] = [];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
    const clock = manualSleep();
    try {
      const lifecycle = createMagpieBenchPlugin(
        async ({ port }) => {
          if (++attempts < 6) throw busy();
          return { port, stop() {} };
        },
        {
          sleep: (ms, signal) => {
            observedDelays.push(ms);
            return clock.sleep(ms, signal);
          },
          delays: [10, 20],
          pollDelayMs: 30000
        }
      );
      await lifecycle.plugin.server({}, { token, port: 3499 });
      expect(attempts).toBe(1);
      for (let i = 0; i < 4; i++) await clock.tick();
      expect(attempts).toBe(5);
      // Repeated identical server() calls during slow polling do not start a second loop.
      await lifecycle.plugin.server({}, { token, port: 3499 });
      expect(attempts).toBe(5);
      await clock.tick();
      expect(attempts).toBe(6);
      expect(observedDelays).toEqual([10, 20, 30000, 30000, 30000]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('3499');
      await lifecycle.stop();
    } finally {
      console.warn = originalWarn;
    }
  });

  test('stop aborts an in-flight slow-poll wait immediately without further attempts', async () => {
    let attempts = 0;
    let lastSignal: AbortSignal | undefined;
    const clock = manualSleep();
    const lifecycle = createMagpieBenchPlugin(
      async () => {
        attempts++;
        throw busy();
      },
      {
        sleep: (ms, signal) => {
          lastSignal = signal;
          return clock.sleep(ms, signal);
        },
        delays: [10],
        pollDelayMs: 30000
      }
    );
    await lifecycle.plugin.server({}, { token, port: 3499 });
    expect(attempts).toBe(1);
    expect(lastSignal?.aborted).toBe(false);
    await lifecycle.stop();
    expect(lastSignal?.aborted).toBe(true);
    await clock.tick();
    expect(attempts).toBe(1);
  });

  test('a newer configuration or stop cancels the pending retry; other errors still fail', async () => {
    const ports: number[] = [];
    const clock = manualSleep();
    const lifecycle = createMagpieBenchPlugin(
      async ({ port }) => {
        ports.push(port);
        if (port === 3499) throw busy();
        return { port, stop() {} };
      },
      { sleep: clock.sleep, delays: [1, 1] }
    );
    await lifecycle.plugin.server({}, { token, port: 3499 });
    await lifecycle.plugin.server({}, { token, port: 3500 });
    await clock.tick();
    await clock.tick();
    expect(ports).toEqual([3499, 3500]);
    const failing = createMagpieBenchPlugin(async () => {
      throw new Error('boom');
    });
    await expect(failing.plugin.server({}, { token, port: 3501 })).rejects.toThrow('boom');
  });
});
