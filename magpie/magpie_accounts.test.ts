import { describe, expect, test } from 'bun:test';
import { discoverMagpieLocalAccounts, MagpieAccountClient, validateMagpieAccountBindings } from './magpie_accounts.ts';
import { MagpieBenchAdapter } from './magpie_adapter.ts';
import { MagpieBenchRoutes } from './magpie_routes.ts';

describe('Magpie account adapter', () => {
  test('validates explicit local bindings without deriving them from quota cards', () => {
    expect(validateMagpieAccountBindings(undefined)).toEqual([]);
    const value = [{ provider_id: 'fixture', account: '测试账号', account_ref: 'subscription-a', models: ['fixture/gpt-6-luna'] }];
    const bindings = validateMagpieAccountBindings(value);
    value[0]!.account = 'changed';
    expect(bindings[0]!.account).toBe('测试账号');
    for (const row of [
      {},
      { ...bindings[0], provider_id: 'remote/codex' },
      { ...bindings[0], provider_id: 'auto' },
      { ...bindings[0], account: 'bad\nheader' },
      { ...bindings[0], key: 'inline-secret' },
      { ...bindings[0], models: [null] }
    ])
      expect(() => validateMagpieAccountBindings([row])).toThrow();
    expect(() => validateMagpieAccountBindings([...bindings, ...bindings])).toThrow('duplicated');
    expect(() =>
      validateMagpieAccountBindings([
        { provider_id: 'openai', account: 'KeyA', account_ref: 'key-a' },
        { provider_id: 'openai', account: 'keya', account_ref: 'key-a-dup' }
      ])
    ).toThrow('duplicated');
    expect(
      validateMagpieAccountBindings([
        { provider_id: 'openai', account: 'a', account_ref: 'openai-a' },
        { provider_id: 'openai', account: 'sk-p…1234', account_ref: 'openai-unnamed' },
        { provider_id: 'openai', account: 'openai#k9f2a1', account_ref: 'openai-dup-2' }
      ])
    ).toHaveLength(3);
  });
  test('same model retains separate account targets; remote quotas never become pins', async () => {
    const rows = [
      { id: 'fixture/gpt-6-luna', owned_by: 'fixture', pricing: { prompt: 0, completion: 0 } },
      { id: 'office/codex/gpt-6-luna', owned_by: 'office', magpie_via: ['remote', 'local'], pricing: { prompt: 0, completion: 0 } }
    ];
    const routes = new MagpieBenchRoutes(
      () => rows,
      'http://127.0.0.1:3425/v1',
      () => 'gateway-key',
      18,
      [
        { provider_id: 'fixture', account: 'a@example.invalid', account_ref: 'a' },
        { provider_id: 'fixture', account: 'b@example.invalid', account_ref: 'b' },
        { provider_id: 'office', account: 'remote@example.invalid', account_ref: 'remote' }
      ]
    );
    const catalog = await routes.public_routes();
    expect(catalog).toHaveLength(4);
    const pinned = catalog.filter(row => row.binding_ref);
    expect(pinned.map(row => row.account_ref)).toEqual(['a', 'b']);
    expect(new Set(pinned.map(row => row.id)).size).toBe(2);
    expect(pinned.every(row => row.account_concurrency === 1)).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain('gateway-key');
    const first = await routes.resolve(pinned[0]!.id);
    const second = await routes.resolve(pinned[1]!.id);
    expect(routes.create_client(first)._headers()['X-Magpie-Account']).toBe(encodeURIComponent('a@example.invalid'));
    expect(routes.create_client(second)._headers()['X-Magpie-Account']).toBe(encodeURIComponent('b@example.invalid'));
    expect(routes.create_client(await routes.resolve(catalog[0]!.id))._headers()).not.toHaveProperty('X-Magpie-Account');
    expect(() => routes.create_client({ ...first, binding_ref: 'unknown' })).toThrow('binding is unavailable');
  });
  test('auto-discovers local subscription and multi-key accounts while excluding remote and ambiguous cards', () => {
    const discovered = discoverMagpieLocalAccounts({
      data: [
        { provider: 'codex', user: 'first@example.invalid', kind: 'subscription', via: ['local-id'] },
        { provider: 'codex', user: 'second@example.invalid', kind: 'subscription', via: ['local-id'] },
        { provider: 'devin', user: 'second@example.invalid · workspace-a', alias: 'second@example.invalid', kind: 'subscription' },
        { provider: 'openrouter', user: 'bench-a', kind: 'balance' },
        { provider: 'openrouter', user: 'bench-b', kind: 'balance' },
        { provider: 'opencode-go', user: null, kind: 'plan' },
        { provider: 'dup-provider', user: 'same-key', kind: 'balance' },
        { provider: 'dup-provider', user: 'Same-Key', kind: 'balance' },
        { provider: 'split-kind', user: 'one-key', kind: 'plan' },
        { provider: 'split-kind', user: 'one-key', kind: 'balance' },
        { provider: 'homelab/codex', user: 'remote@example.invalid', from: 'homelab', kind: 'subscription', via: ['a', 'b'] },
        { provider: 'office/openai', user: 'slash@example.invalid', kind: 'balance' },
        { provider: 'local-from', user: 'from@example.invalid', from: 'other-magpie', kind: 'subscription' },
        { provider: 'local-hop', user: 'hop@example.invalid', via: ['hop-1', 'hop-2'], kind: 'subscription' },
        { provider: 'remote-gw', user: 'gw-key', gatewayKey: { limit: 10 }, kind: 'balance' },
        { provider: 'auto', user: 'auto@example.invalid', kind: 'subscription' },
        { provider: 'group', user: 'group@example.invalid', kind: 'subscription' }
      ]
    });
    expect(discovered).toEqual([
      { provider_id: 'codex', account: 'first@example.invalid', account_ref: 'first@example.invalid' },
      { provider_id: 'codex', account: 'second@example.invalid', account_ref: 'second@example.invalid' },
      { provider_id: 'devin', account: 'second@example.invalid · workspace-a', account_ref: 'second@example.invalid · workspace-a' },
      { provider_id: 'openrouter', account: 'bench-a', account_ref: 'bench-a' },
      { provider_id: 'openrouter', account: 'bench-b', account_ref: 'bench-b' },
      { provider_id: 'split-kind', account: 'one-key', account_ref: 'one-key' }
    ]);
  });
  test('adapter merges discovered local accounts with explicit config precedence and degrades on quota errors', async () => {
    let failQuotas = false;
    let cards: Record<string, unknown>[] = [
      { provider: 'codex', user: 'first@example.invalid', kind: 'subscription' },
      { provider: 'codex', user: 'second@example.invalid', kind: 'subscription' },
      { provider: 'office/codex', user: 'remote@example.invalid', from: 'office', kind: 'subscription' }
    ];
    const adapter = new MagpieBenchAdapter('http://127.0.0.1:3425/v1', 'gateway-key', 18, [
      { provider_id: 'codex', account: 'first@example.invalid', account_ref: 'codex-primary' }
    ]);
    adapter.gateway = async path => {
      if (path === '/models') {
        return {
          data: [
            { id: 'codex/gpt-5.4', owned_by: 'codex', pricing: { prompt: 0.000001, completion: 0.000002 } },
            {
              id: 'office/codex/gpt-5.4',
              owned_by: 'office',
              magpie_via: ['remote-hop', 'local-hop'],
              pricing: { prompt: 0.000001, completion: 0.000002 }
            }
          ]
        };
      }
      if (path === '/magpie/quotas/cards') {
        if (failQuotas) throw new TypeError('gateway HTTP error 403');
        return { data: cards };
      }
      throw new TypeError('unexpected path ' + path);
    };
    const routes = await adapter.routes.public_routes();
    expect(routes.map(row => [row.model, row.account_ref, row.account_evidence])).toEqual([
      ['codex/gpt-5.4', 'gateway-default', 'gateway_binding'],
      ['codex/gpt-5.4', 'codex-primary', 'configured_binding'],
      ['codex/gpt-5.4', 'second@example.invalid', 'gateway_account_binding'],
      ['office/codex/gpt-5.4', 'gateway-default', 'gateway_binding']
    ]);
    const discoveredRoute = await adapter.routes.resolve(routes[2]!.id);
    expect(adapter.routes.create_client(discoveredRoute)._headers()['X-Magpie-Account']).toBe(encodeURIComponent('second@example.invalid'));
    // Refresh after quota denial keeps catalog & manual bindings working, clears discovered routes,
    // while an already-resolved route keeps its binding for an in-flight run.
    failQuotas = true;
    adapter.refresh();
    const degraded = await adapter.routes.public_routes();
    expect(degraded.map(row => [row.model, row.account_ref, row.account_evidence])).toEqual([
      ['codex/gpt-5.4', 'gateway-default', 'gateway_binding'],
      ['codex/gpt-5.4', 'codex-primary', 'configured_binding'],
      ['office/codex/gpt-5.4', 'gateway-default', 'gateway_binding']
    ]);
    expect(adapter.routes.create_client(discoveredRoute)._headers()['X-Magpie-Account']).toBe(encodeURIComponent('second@example.invalid'));
    await expect(adapter.routes.resolve(discoveredRoute.id)).rejects.toThrow('unavailable');
    // Recovery after refresh restores discovered accounts.
    failQuotas = false;
    cards = [{ provider: 'codex', user: 'third@example.invalid', kind: 'subscription' }];
    adapter.refresh();
    const recovered = await adapter.routes.public_routes();
    expect(recovered.filter(row => row.account_evidence === 'gateway_account_binding').map(row => row.account_ref)).toEqual([
      'third@example.invalid'
    ]);
  });
  test('HTTP transport sends encoded pins without rewriting model IDs or following redirects', async () => {
    const calls: { pin: string | null; model: string }[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        calls.push({ pin: request.headers.get('X-Magpie-Account'), model: (await request.json()).model });
        return Response.json({ status: 'completed', output_text: 'ok' });
      }
    });
    try {
      for (const account of ['a@example.invalid', '测试账号', '50%off']) {
        const client = new MagpieAccountClient(`http://127.0.0.1:${server.port}`, 'gateway-key', account);
        expect((await client.post_responses_non_stream({ model: 'fixture/gpt-6-luna', input: 'ping' }))[0]).toBe(200);
        expect(decodeURIComponent(calls.at(-1)!.pin!)).toBe(account);
        expect(calls.at(-1)!.model).toBe('fixture/gpt-6-luna');
      }
    } finally {
      server.stop(true);
    }
  });
});
