import { validateMagpieAccountBindings } from './magpie_accounts.ts';

type MiniBenchHandle = { port: number; stop(): void | Promise<void> };
type MiniBenchStarter = (options: { token: string; port: number; accounts?: unknown }) => MiniBenchHandle | Promise<MiniBenchHandle>;
type MagpieBenchOptions = { token?: unknown; port?: unknown; accounts?: unknown };
type Sleep = (milliseconds: number) => Promise<void>;

/** How long a busy port is retried before giving up; a host restart can hold the old listener briefly. */
export const PORT_RETRY_DELAYS_MS = [500, 1000, 2000, 3000, 5000, 5000, 10000, 10000, 15000, 15000, 30000, 30000];

const portInUse = (error: unknown) => error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'EADDRINUSE';

/**
 * Own only the plugin's in-process service; never stop Magpie's shared Bun host.
 * A busy port (for example an old host still draining after a reload) does not fail the
 * plugin permanently: the start is retried in the background until the port frees or
 * the retry budget runs out. Any newer configuration or stop cancels that retry.
 */
export function createMagpieBenchPlugin(
  startService: MiniBenchStarter,
  {
    sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    delays = PORT_RETRY_DELAYS_MS
  }: { sleep?: Sleep; delays?: readonly number[] } = {}
) {
  let active: { handle: MiniBenchHandle; token: string; port: number; accounts: string } | undefined;
  let waiting: { token: string; port: number; accounts: string } | undefined;
  let generation = 0;
  let transition: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = transition.catch(() => undefined).then(operation);
    transition = next;
    return next;
  };
  const stopActive = async () => {
    generation++;
    waiting = undefined;
    if (active) {
      await active.handle.stop();
      active = undefined;
    }
  };
  const retryBusyPort = (
    config: { token: string; port: number; accounts: string },
    options: { token: string; port: number; accounts?: unknown },
    mine: number
  ) => {
    void (async () => {
      for (const delay of delays) {
        await sleep(delay);
        const started = await enqueue(async () => {
          if (mine !== generation) return true; // Superseded by a newer configuration or stop.
          try {
            const handle = await startService(options);
            active = { handle, ...config };
            waiting = undefined;
            return true;
          } catch (error) {
            if (portInUse(error)) return false;
            waiting = undefined;
            console.error('LLM Mini Bench failed to start after the port became available.');
            return true;
          }
        });
        if (started) return;
      }
      if (mine === generation) {
        waiting = undefined;
        console.error(`LLM Mini Bench port ${config.port} stayed in use; reopen the plugin after freeing it.`);
      }
    })();
  };
  return {
    plugin: {
      id: 'magpie-mini-bench',
      server: async (_input: unknown, options: MagpieBenchOptions = {}) =>
        enqueue(async () => {
          const token = typeof options.token === 'string' ? options.token : '';
          if (token.length < 32) {
            await stopActive();
            // The page creates and persists its private settings through Magpie's bridge.
            // First installation waits for that handshake instead of requiring manual setup.
            return {};
          }
          const port = Number(options.port ?? 3481);
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error('LLM Mini Bench port must be between 1 and 65535.');
          }
          const bindings = validateMagpieAccountBindings(options.accounts);
          const accounts = JSON.stringify(bindings);
          const same = (value?: { token: string; port: number; accounts: string }) =>
            value?.port === port && value.token === token && value.accounts === accounts;
          if (same(active) || same(waiting)) return {};
          await stopActive();
          const config = { token, port, accounts };
          const startOptions = { token, port, ...(options.accounts !== undefined ? { accounts: bindings } : {}) };
          try {
            const handle = await startService(startOptions);
            active = { handle, ...config };
          } catch (error) {
            if (!portInUse(error)) throw error;
            waiting = config;
            retryBusyPort(config, startOptions, generation);
          }
          return {};
        })
    },
    stop: () => enqueue(stopActive)
  };
}
