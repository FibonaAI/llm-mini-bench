import { startMiniBenchService, type MiniBenchOptions } from '../benchmark/backend/mini_bench.ts';
import { MagpieBenchAdapter } from './magpie_adapter.ts';
import { validateMagpieAccountBindings } from './magpie_accounts.ts';

/** Assemble the host adapter and the generic service in Magpie's existing Bun process. */
export function startMagpieBenchService(options: MiniBenchOptions & { accounts?: unknown }) {
  const accounts = validateMagpieAccountBindings(options.accounts);
  return startMiniBenchService({
    ...options,
    adapter: options.adapter ?? new MagpieBenchAdapter(undefined, undefined, undefined, accounts)
  });
}
