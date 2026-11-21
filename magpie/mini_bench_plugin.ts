import { validateMagpieAccountBindings } from './magpie_accounts.ts';

type MiniBenchHandle = { port: number; stop(): void | Promise<void> };
type MiniBenchStarter = (options: { token: string; port: number; accounts?: unknown }) => MiniBenchHandle | Promise<MiniBenchHandle>;
type MagpieBenchOptions = { token?: unknown; port?: unknown; accounts?: unknown };
type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

/** Initial backoff schedule while waiting for a draining host to release the service port. */
export const PORT_RETRY_DELAYS_MS = [500, 1000, 2000, 3000, 5000, 5000, 10000, 10000, 15000, 15000, 30000, 30000];
/** Steady-state polling interval once the initial backoff window elapses. */
export const PORT_RETRY_POLL_MS = 30000;

const portInUse = (error: unknown) => error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'EADDRINUSE';

const defaultSleep: Sleep = (ms, signal) =>
  new Promise<void>(resolve => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Own only the plugin's in-process service; never stop Magpie's shared Bun host.
 * A busy port (for example an old host still draining long-running requests after a memory
 * recycle) does not fail the plugin permanently: the start is retried rapidly at first and
 * then polled at a low frequency until the port frees. Any newer configuration or stop cancels
 * that retry immediately, and the unref'd timer never keeps the host alive on exit.
 */
export function createMagpieBenchPlugin(
  startService: MiniBenchStarter,
  {
    sleep = defaultSleep,
    delays = PORT_RETRY_DELAYS_MS,
    pollDelayMs = PORT_RETRY_POLL_MS
  }: { sleep?: Sleep; delays?: readonly number[]; pollDelayMs?: number | null } = {}
) {
  let active: { handle: MiniBenchHandle; token: string; port: number; accounts: string } | undefined;
  let waiting: { token: string; port: number; accounts: string } | undefined;
  let retryAbort: AbortController | undefined;
  let generation = 0;
  let transition: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = transition.catch(() => undefined).then(operation);
    transition = next;
    return next;
  };
  const stopActive = async () => {
    generation++;
    retryAbort?.abort();
    retryAbort = undefined;
    waiting = undefined;
    if (active) {
      await active.handle.stop();
      active = undefined;
    }
  };
  const retryBusyPort = (
    config: { token: string; port: number; accounts: string },
    options: { token: string; port: number; accounts?: unknown },
    mine: number,
    signal: AbortSignal
  ) => {
    void (async () => {
      let step = 0;
      let loggedSlowWait = false;
      while (mine === generation && !signal.aborted) {
        const delay = step < delays.length ? delays[step++]! : pollDelayMs;
        if (delay === null || delay <= 0) break;
        await sleep(delay, signal);
        const started = await enqueue(async () => {
          if (mine !== generation) return true; // Superseded by a newer configuration or stop.
          try {
            const handle = await startService(options);
            active = { handle, ...config };
            waiting = undefined;
            if (retryAbort?.signal === signal) retryAbort = undefined;
            return true;
          } catch (error) {
            if (portInUse(error)) return false;
            waiting = undefined;
            if (retryAbort?.signal === signal) retryAbort = undefined;
            console.error('LLM Mini Bench failed to start after the port became available.');
            return true;
          }
        });
        if (started) return;
        if (step >= delays.length && !loggedSlowWait && mine === generation && pollDelayMs !== null && pollDelayMs > 0) {
          loggedSlowWait = true;
          console.warn(`LLM Mini Bench port ${config.port} is still in use; continuing to retry every ${Math.round(pollDelayMs / 1000)}s.`);
        }
      }
      if (mine === generation) {
        waiting = undefined;
        if (retryAbort?.signal === signal) retryAbort = undefined;
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
            const controller = new AbortController();
            retryAbort = controller;
            retryBusyPort(config, startOptions, generation, controller.signal);
          }
          return {};
        })
    },
    stop: () => enqueue(stopActive)
  };
}
