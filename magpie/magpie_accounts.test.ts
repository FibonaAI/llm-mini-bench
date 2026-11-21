import { describe, expect, test } from 'bun:test';
import {
  discoverMagpieAccounts,
  discoverMagpieLocalAccounts,
  MagpieAccountClient,
  validateMagpieAccountBindings
} from './magpie_accounts.ts';
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
        { provider_id: 'openai', account: 'openai/key0000001', account_ref: 'a' },
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
        { provider_id: 'fixture', account: 'fixture/a@example.invalid', account_ref: 'a' },
        { provider_id: 'fixture', account: 'fixture/b@example.invalid', account_ref: 'b' },
        { provider_id: 'office', account: 'office/remote@example.invalid', account_ref: 'remote' }
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
    expect(routes.create_client(first)._headers()['X-Magpie-Account']).toBe(encodeURIComponent('fixture/a@example.invalid'));
    expect(routes.create_client(second)._headers()['X-Magpie-Account']).toBe(encodeURIComponent('fixture/b@example.invalid'));
    expect(routes.create_client(await routes.resolve(catalog[0]!.id))._headers()).not.toHaveProperty('X-Magpie-Account');
    expect(() => routes.create_client({ ...first, binding_ref: 'unknown' })).toThrow('binding is unavailable');
  });
  test('discovers local accounts and API keys from /v1/magpie/accounts with verbatim pins and unambiguous labels', () => {
    const discovered = discoverMagpieAccounts({
      object: 'list',
      data: [
        { provider: 'openai', providerName: 'OpenAI', id: 'key0000001', pin: 'openai/key0000001', kind: 'key', label: 'a', on: true },
        { provider: 'openai', providerName: 'OpenAI', id: 'key0000002', pin: 'openai/key0000002', kind: 'key', label: 'b', on: true },
        { provider: 'openai', providerName: 'OpenAI', id: 'key0000003', pin: 'openai/key0000003', kind: 'key', label: '•••', on: true },
        { provider: 'openai', providerName: 'OpenAI', id: 'disabled01', pin: 'openai/disabled01', kind: 'key', label: 'off', on: false },
        { provider: 'openai', providerName: 'OpenAI', id: 'key0000001', pin: 'openai/KEY0000001', kind: 'key', label: 'dup', on: true },
        { provider: 'relay', id: 'k1', pin: 'relay/k1', kind: 'key', label: 'prod', on: true },
        { provider: 'relay', id: 'k2', pin: 'relay/k2', kind: 'key', label: 'Prod', on: true },
        { provider: 'relay', id: 'k3', pin: 'relay/k3', kind: 'key', label: 'gateway-default', on: true },
        { provider: 'deepseek', id: 'solo1', pin: 'deepseek/solo1', kind: 'key', label: 'sk-ds…1111', on: true },
        {
          provider: 'codex',
          id: 'user@example.invalid',
          pin: 'codex/user@example.invalid',
          kind: 'account',
          user: 'user@example.invalid',
          plan: 'pro',
          on: true
        },
        {
          provider: 'codex',
          id: '测试账号',
          pin: 'codex/测试账号',
          kind: 'account',
          label: '测试账号',
          user: 'cjk@example.invalid',
          on: true
        },
        { provider: 'office/codex', id: 'remote1', pin: 'office/codex/remote1', kind: 'account', label: 'remote', on: true },
        { provider: 'auto', id: 'a1', pin: 'auto/a1', kind: 'key', label: 'auto', on: true },
        { provider: 'group', id: 'g1', pin: 'group/g1', kind: 'key', label: 'group', on: true },
        { provider: 'from-remote', id: 'r1', pin: 'from-remote/r1', kind: 'key', label: 'r1', from: 'office', on: true },
        { provider: 'missing-pin', id: 'm1', kind: 'key', label: 'm1', on: true }
      ]
    });
    expect(discovered).toEqual([
      { provider_id: 'openai', account: 'openai/key0000001', account_ref: 'a' },
      { provider_id: 'openai', account: 'openai/key0000002', account_ref: 'b' },
      { provider_id: 'openai', account: 'openai/key0000003', account_ref: '••• (key0000003)' },
      { provider_id: 'relay', account: 'relay/k1', account_ref: 'prod (k1)' },
      { provider_id: 'relay', account: 'relay/k2', account_ref: 'Prod (k2)' },
      { provider_id: 'relay', account: 'relay/k3', account_ref: 'gateway-default (k3)' },
      { provider_id: 'deepseek', account: 'deepseek/solo1', account_ref: 'sk-ds…1111' },
      { provider_id: 'codex', account: 'codex/user@example.invalid', account_ref: 'user@example.invalid' },
      { provider_id: 'codex', account: 'codex/测试账号', account_ref: '测试账号' }
    ]);
    expect(discoverMagpieAccounts(null)).toEqual([]);
    expect(discoverMagpieAccounts({ data: 'invalid' })).toEqual([]);
  });
  test('auto-discovers local subscription and multi-key accounts from quota cards while excluding remote and ambiguous cards', () => {
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
        { provider: 'local-from', user: 'from@example.invalid', from: 'office', kind: 'subscription' },
        { provider: 'local-gw', user: 'gw@example.invalid', gatewayKey: 'key-1', kind: 'subscription' },
        { provider: 'multi-hop', user: 'hop@example.invalid', via: ['peer', 'local'], kind: 'subscription' },
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
  test('adapter reads /v1/magpie/accounts, respects manual precedence across pin forms, excludes remote routes, and handles 403', async () => {
    let accountsMode: 'ok' | 'forbidden' | 'recovered' = 'ok';
    const requests: string[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push(url.pathname);
        if (url.pathname === '/v1/models') {
          return Response.json({
            data: [
              { id: 'openai/gpt-6-luna', owned_by: 'openai', pricing: { prompt: 0.000001, completion: 0.000002 } },
              { id: 'codex/gpt-6-luna', owned_by: 'codex', pricing: { prompt: 0.000001, completion: 0.000002 } },
              {
                id: 'office/openai/gpt-6-luna',
                owned_by: 'office',
                magpie_via: ['remote-hop', 'local-hop'],
                pricing: { prompt: 0.000001, completion: 0.000002 }
              },
              {
                id: 'auto/gpt-6-luna',
                owned_by: 'office',
                magpie_via: ['remote-hop', 'local-hop'],
                pricing: { prompt: 0.000001, completion: 0.000002 }
              }
            ]
          });
        }
        if (url.pathname === '/v1/magpie/accounts') {
          if (accountsMode === 'forbidden') return new Response('forbidden', { status: 403 });
          if (accountsMode === 'recovered') {
            return Response.json({
              object: 'list',
              data: [{ provider: 'openai', id: 'newkey1111', pin: 'openai/newkey1111', kind: 'key', label: 'c', on: true }]
            });
          }
          return Response.json({
            object: 'list',
            data: [
              { provider: 'office', id: 'key0000004', pin: 'office/key0000004', kind: 'key', label: 'sk-test…0004', on: true },
              { provider: 'openai', id: 'key0000001', pin: 'openai/key0000001', kind: 'key', label: 'a', on: true },
              { provider: 'openai', id: 'key0000002', pin: 'openai/key0000002', kind: 'key', label: 'b', on: true },
              { provider: 'openai', id: 'key0000003', pin: 'openai/key0000003', kind: 'key', label: '•••', on: true },
              {
                provider: 'codex',
                id: 'first@example.invalid',
                pin: 'codex/first@example.invalid',
                kind: 'account',
                label: 'first@example.invalid',
                on: true
              },
              {
                provider: 'codex',
                id: 'second@example.invalid',
                pin: 'codex/second@example.invalid',
                kind: 'account',
                label: 'second@example.invalid',
                on: true
              }
            ]
          });
        }
        if (url.pathname === '/v1/magpie/quotas/cards') {
          return Response.json({ data: [{ provider: 'codex', user: 'stale-quota@example.invalid', kind: 'subscription' }] });
        }
        return new Response('not found', { status: 404 });
      }
    });
    try {
      const adapter = new MagpieBenchAdapter(`http://127.0.0.1:${server.port}/v1`, 'magpie', 18, [
        { provider_id: 'openai', account: 'openai#key0000001', account_ref: 'openai-manual-a' },
        { provider_id: 'codex', account: 'first@example.invalid', account_ref: 'codex-primary' }
      ]);
      const routes = await adapter.routes.public_routes();
      expect(requests).toEqual(['/v1/models', '/v1/magpie/accounts']);
      expect(routes.map(row => [row.model, row.account_ref, row.account_evidence])).toEqual([
        ['openai/gpt-6-luna', 'gateway-default', 'gateway_binding'],
        ['openai/gpt-6-luna', 'openai-manual-a', 'configured_binding'],
        ['openai/gpt-6-luna', 'b', 'gateway_account_binding'],
        ['openai/gpt-6-luna', '••• (key0000003)', 'gateway_account_binding'],
        ['codex/gpt-6-luna', 'gateway-default', 'gateway_binding'],
        ['codex/gpt-6-luna', 'codex-primary', 'configured_binding'],
        ['codex/gpt-6-luna', 'second@example.invalid', 'gateway_account_binding'],
        ['office/openai/gpt-6-luna', 'gateway-default', 'gateway_binding'],
        ['auto/gpt-6-luna', 'gateway-default', 'gateway_binding']
      ]);
      const pinnedB = await adapter.routes.resolve(routes[2]!.id);
      const pinnedAnon = await adapter.routes.resolve(routes[3]!.id);
      expect(adapter.routes.create_client(pinnedB)._headers()['X-Magpie-Account']).toBe(encodeURIComponent('openai/key0000002'));
      expect(adapter.routes.create_client(pinnedAnon)._headers()['X-Magpie-Account']).toBe(encodeURIComponent('openai/key0000003'));
      // 403 on /v1/magpie/accounts clears discovered bindings without falling back to stale quota cards,
      // while already-resolved routes stay usable for in-flight runs.
      accountsMode = 'forbidden';
      adapter.refresh();
      const forbiddenRoutes = await adapter.routes.public_routes();
      expect(forbiddenRoutes.filter(row => row.account_evidence === 'gateway_account_binding')).toEqual([]);
      expect(requests.includes('/v1/magpie/quotas/cards')).toBe(false);
      expect(adapter.routes.create_client(pinnedB)._headers()['X-Magpie-Account']).toBe(encodeURIComponent('openai/key0000002'));
      await expect(adapter.routes.resolve(pinnedB.id)).rejects.toThrow('unavailable');
      // Recovery after refresh restores fresh /v1/magpie/accounts entries.
      accountsMode = 'recovered';
      adapter.refresh();
      const recovered = await adapter.routes.public_routes();
      expect(recovered.filter(row => row.account_evidence === 'gateway_account_binding').map(row => row.account_ref)).toEqual(['c']);
    } finally {
      server.stop(true);
    }
  });
  test('adapter falls back to /v1/magpie/quotas/cards when /v1/magpie/accounts is unavailable (older Magpie) and degrades on quota errors', async () => {
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
      if (path === '/magpie/accounts') throw new TypeError('gateway HTTP error 404');
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
      for (const account of ['openai/key0000001', 'a@example.invalid', '测试账号', '50%off']) {
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
