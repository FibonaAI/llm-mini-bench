import { validateMagpieAccountBindings } from './magpie_accounts.ts';

type MiniBenchHandle = { port: number; stop(): void | Promise<void> };
type MiniBenchStarter = (options: { token: string; port: number; accounts?: unknown }) => MiniBenchHandle | Promise<MiniBenchHandle>;
type MagpieBenchOptions = { token?: unknown; port?: unknown; accounts?: unknown };

/** Own only the plugin's in-process service; never stop Magpie's shared Bun host. */
export function createMagpieBenchPlugin(startService: MiniBenchStarter) {
  let active: { handle: MiniBenchHandle; token: string; port: number; accounts: string } | undefined;
  let transition: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = transition.catch(() => undefined).then(operation);
    transition = next;
    return next;
  };
  const stopActive = async () => {
    if (active) {
      await active.handle.stop();
      active = undefined;
    }
  };
  return {
    plugin: {
      id: 'magpie-mini-bench',
      server: async (_input: unknown, options: MagpieBenchOptions = {}) => enqueue(async () => {
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
        if (active?.port === port && active.token === token && active.accounts === accounts) return {};
        await stopActive();
        const handle = await startService({ token, port, ...(options.accounts !== undefined ? { accounts: bindings } : {}) });
        active = { handle, token, port, accounts };
        return {};
      }),
    },
    stop: () => enqueue(stopActive),
  };
}
