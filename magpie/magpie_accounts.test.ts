import { describe, expect, test } from 'bun:test';
import {
  discoverMagpieAccountCatalog,
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
      { ...bindings[0], disabled: 'yes' },
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
        { provider: 'openai', providerName: 'OpenAI', id: 'disabled01', pin: 'openai/disabled01', kind: 'key', label: 'off', on: false },
        { provider: 'openai', providerName: 'OpenAI', id: 'key0000002', pin: 'openai/key0000002', kind: 'key', label: 'b', on: true },
        { provider: 'openai', providerName: 'OpenAI', id: 'key0000003', pin: 'openai/key0000003', kind: 'key', label: '•••', on: true },
        { provider: 'openai', providerName: 'OpenAI', id: 'key0000001', pin: 'openai/KEY0000001', kind: 'key', label: 'dup', on: true },
        { provider: 'all-off', providerName: 'Disabled Provider', id: 'off1', pin: 'all-off/off1', kind: 'key', label: 'gone', on: false },
        { provider: 'all-off', providerName: 'Disabled Provider', id: 'off2', pin: 'all-off/off2', kind: 'key', label: 'gone2', on: false },
        { provider: 'relay', id: 'k1', pin: 'relay/k1', kind: 'key', label: 'prod', on: true },
        { provider: 'relay', id: 'k2', pin: 'relay/k2', kind: 'key', label: 'Prod', on: false },
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
      { provider_id: 'openai', account: 'openai/disabled01', account_ref: 'off', disabled: true },
      { provider_id: 'relay', account: 'relay/k1', account_ref: 'prod (k1)' },
      { provider_id: 'relay', account: 'relay/k3', account_ref: 'gateway-default (k3)' },
      { provider_id: 'relay', account: 'relay/k2', account_ref: 'Prod (k2)', disabled: true },
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
        requests.push(url.pathname + url.search);
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
      expect(requests).toEqual(['/v1/models', '/v1/magpie/accounts?models=full']);
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
      if (path === '/magpie/accounts?models=full') throw new TypeError('gateway HTTP error 404');
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
  test('adapter reads full per-account model metadata from /v1/magpie/accounts?models=full, preserves pricing/thinking/display_name, filters non-chat & bad pricing, and stays compatible with string IDs', async () => {
    const adapter = new MagpieBenchAdapter('http://127.0.0.1:3425/v1', 'gateway-key', 18, [
      { provider_id: 'openai', account: 'openai/key1', account_ref: 'openai-manual-a' }
    ]);
    adapter.gateway = async path => {
      if (path === '/models') {
        return {
          data: [
            {
              id: 'openai/gpt-6-luna',
              owned_by: 'openai',
              display_name: 'GPT-6 Luna',
              reasoning_levels: ['low', 'high'],
              pricing: { prompt: '0.000001', completion: '0.000002' }
            },
            {
              id: 'openai/unpriced-chat',
              owned_by: 'openai',
              display_name: 'Unpriced Chat',
              reasoning_levels: ['medium']
            },
            {
              id: 'openai/bad-pricing',
              owned_by: 'openai',
              pricing: { prompt: -1, completion: 0 }
            },
            {
              id: 'openai/gpt-image-2',
              owned_by: 'openai',
              kind: 'image'
            },
            {
              id: 'office/openai/gpt-6-luna',
              owned_by: 'office',
              magpie_via: ['remote-hop', 'local-hop'],
              pricing: { prompt: '0.000001', completion: '0.000002' }
            }
          ]
        };
      }
      if (path === '/magpie/accounts?models=full') {
        return {
          object: 'list',
          data: [
            {
              provider: 'openai',
              id: 'key1',
              pin: 'openai/key1',
              kind: 'key',
              label: 'a',
              on: true,
              models: [
                {
                  id: 'openai/gpt-6-luna',
                  owned_by: 'openai',
                  display_name: 'GPT-6 Luna',
                  reasoning_levels: ['low', 'high'],
                  pricing: { prompt: '0.000001', completion: '0.000002' }
                },
                {
                  id: 'openai/gpt-5',
                  owned_by: 'openai',
                  display_name: 'GPT-5',
                  reasoning_levels: ['minimal', 'low', 'medium', 'high'],
                  pricing: { prompt: '0.00000125', completion: '0.00001' }
                },
                {
                  id: 'openai/gpt-5-mini',
                  owned_by: 'openai',
                  display_name: 'GPT-5 Mini',
                  reasoning_levels: ['low', 'high']
                },
                {
                  id: 'openai/hidden-bad-pricing',
                  owned_by: 'openai',
                  pricing: { prompt: -0.5, completion: 0 }
                },
                {
                  id: 'openai/hidden-audio',
                  owned_by: 'openai',
                  kind: 'audio',
                  pricing: { prompt: '0.000001', completion: '0.000002' }
                },
                {
                  id: 'other/cross-provider-spoof',
                  owned_by: 'other',
                  pricing: { prompt: '0.000001', completion: '0.000002' }
                },
                { id: 'openai/unpriced-chat', owned_by: 'openai', display_name: 'Unpriced Chat', reasoning_levels: ['medium'] },
                { id: 'openai/bad-pricing', owned_by: 'openai', pricing: { prompt: -1, completion: 0 } },
                { id: 'openai/gpt-image-2', owned_by: 'openai', kind: 'image' }
              ]
            },
            {
              provider: 'openai',
              id: 'key2',
              pin: 'openai/key2',
              kind: 'key',
              label: 'b',
              on: true,
              models: [
                {
                  id: 'openai/gpt-6-luna',
                  owned_by: 'openai',
                  display_name: 'GPT-6 Luna',
                  reasoning_levels: ['low', 'high'],
                  pricing: { prompt: '0.000001', completion: '0.000002' }
                },
                {
                  id: 'openai/gpt-5',
                  owned_by: 'openai',
                  display_name: 'GPT-5',
                  reasoning_levels: ['minimal', 'low', 'medium', 'high'],
                  pricing: { prompt: '0.00000125', completion: '0.00001' }
                }
              ]
            },
            {
              provider: 'openai',
              id: 'key3',
              pin: 'openai/key3',
              kind: 'key',
              label: 'empty',
              on: true,
              models: []
            },
            {
              provider: 'office',
              id: 'peerkey',
              pin: 'office/peerkey',
              kind: 'key',
              label: 'sk-peer',
              on: true,
              models: [
                {
                  id: 'office/openai/gpt-6-luna',
                  owned_by: 'office',
                  pricing: { prompt: '0.000001', completion: '0.000002' }
                },
                {
                  id: 'office/openai/hidden-remote-model',
                  owned_by: 'office',
                  display_name: 'Hidden Remote',
                  reasoning_levels: ['medium'],
                  pricing: { prompt: '0.000003', completion: '0.000006' }
                },
                'bare-remote-alias'
              ]
            }
          ]
        };
      }
      throw new TypeError('unexpected path ' + path);
    };
    const routes = await adapter.routes.public_routes();
    const byModel = (modelId: string) => routes.filter(row => row.model === modelId);

    // Non-chat models (catalog or hidden), malformed/negative pricing, and cross-provider spoofed IDs are never exposed.
    expect(byModel('openai/gpt-image-2')).toEqual([]);
    expect(byModel('openai/hidden-audio')).toEqual([]);
    expect(byModel('openai/bad-pricing')).toEqual([]);
    expect(byModel('openai/hidden-bad-pricing')).toEqual([]);
    expect(byModel('other/cross-provider-spoof')).toEqual([]);

    // Catalog-priced model keeps full metadata, manual override, and omits key3 (empty models list).
    expect(byModel('openai/gpt-6-luna').map(r => [r.account_ref, r.account_evidence, r.pricing, r.thinking_levels])).toEqual([
      ['gateway-default', 'gateway_binding', { prompt: 0.000001, completion: 0.000002 }, ['low', 'high']],
      ['openai-manual-a', 'configured_binding', { prompt: 0.000001, completion: 0.000002 }, ['low', 'high']],
      ['b', 'gateway_account_binding', { prompt: 0.000001, completion: 0.000002 }, ['low', 'high']]
    ]);

    // Unpriced /v1/models chat model listed in account.models keeps catalog display_name & thinking_levels with pricing: null.
    const unpricedChat = byModel('openai/unpriced-chat');
    expect(unpricedChat.map(r => [r.account_ref, r.pricing, r.model_display_name, r.thinking_levels, r.provider_evidence])).toEqual([
      ['gateway-default', null, 'Unpriced Chat', ['medium'], 'gateway_catalog'],
      ['openai-manual-a', null, 'Unpriced Chat', ['medium'], 'gateway_catalog']
    ]);

    // Hidden provider model (not in /v1/models) retains full pricing, display_name, and thinking_levels from models=full.
    expect(
      byModel('openai/gpt-5').map(r => [
        r.account_ref,
        r.account_evidence,
        r.pricing,
        r.model_display_name,
        r.thinking_levels,
        r.provider_evidence
      ])
    ).toEqual([
      [
        'gateway-default',
        'gateway_binding',
        { prompt: 0.00000125, completion: 0.00001 },
        'GPT-5',
        ['minimal', 'low', 'medium', 'high'],
        'gateway_accounts'
      ],
      [
        'openai-manual-a',
        'configured_binding',
        { prompt: 0.00000125, completion: 0.00001 },
        'GPT-5',
        ['minimal', 'low', 'medium', 'high'],
        'gateway_accounts'
      ],
      [
        'b',
        'gateway_account_binding',
        { prompt: 0.00000125, completion: 0.00001 },
        'GPT-5',
        ['minimal', 'low', 'medium', 'high'],
        'gateway_accounts'
      ]
    ]);

    // Hidden model without pricing keeps display_name and thinking_levels with pricing: null, and respects per-account exclusions.
    expect(
      byModel('openai/gpt-5-mini').map(r => [r.account_ref, r.account_evidence, r.pricing, r.model_display_name, r.thinking_levels])
    ).toEqual([
      ['gateway-default', 'gateway_binding', null, 'GPT-5 Mini', ['low', 'high']],
      ['openai-manual-a', 'configured_binding', null, 'GPT-5 Mini', ['low', 'high']]
    ]);

    // Resolving a hidden pinned model preserves pricing and creates a MagpieAccountClient with X-Magpie-Account intact.
    const pinnedGpt5 = byModel('openai/gpt-5').find(r => r.account_ref === 'b')!;
    const resolvedGpt5 = await adapter.routes.resolve(pinnedGpt5.id);
    expect(resolvedGpt5.pricing).toEqual({ prompt: 0.00000125, completion: 0.00001 });
    expect(adapter.routes.create_client(resolvedGpt5)._headers()['X-Magpie-Account']).toBe(encodeURIComponent('openai/key2'));

    // Remote peer hidden models retain full metadata + remote_route namespace and never get local account pins.
    const remoteHidden = byModel('office/openai/hidden-remote-model');
    expect(remoteHidden).toHaveLength(1);
    expect(remoteHidden[0]!.account_evidence).toBe('gateway_binding');
    expect(remoteHidden[0]!.pricing).toEqual({ prompt: 0.000003, completion: 0.000006 });
    expect(remoteHidden[0]!.model_display_name).toBe('Hidden Remote');
    expect(remoteHidden[0]!.thinking_levels).toEqual(['medium']);
    expect(remoteHidden[0]!.remote_route).toEqual({ namespace: 'openai', evidence: 'magpie_via_catalog' });
    // Bare string IDs (legacy models=1 format) remain supported with pricing: null and no local pins on remote peers.
    const remoteBare = byModel('office/bare-remote-alias');
    expect(remoteBare).toHaveLength(1);
    expect(remoteBare[0]!.account_evidence).toBe('gateway_binding');
    expect(remoteBare[0]!.pricing).toBeNull();

    // Direct unit check on discoverMagpieAccountCatalog deduplication and non-chat exclusion from account.models.
    const parsed = discoverMagpieAccountCatalog({
      object: 'list',
      data: [
        {
          provider: 'openai',
          id: 'k1',
          pin: 'openai/k1',
          label: 'k1',
          on: true,
          models: [
            {
              id: 'openai/gpt-5',
              display_name: 'GPT-5',
              reasoning_levels: ['high'],
              pricing: { prompt: '0.000001', completion: '0.000002' }
            },
            { id: 'openai/gpt-image-2', kind: 'image' },
            'gpt-legacy'
          ]
        },
        {
          provider: 'openai',
          id: 'k2',
          pin: 'openai/k2',
          label: 'k2',
          on: true,
          models: [{ id: 'openai/gpt-5', display_name: 'GPT-5' }]
        }
      ]
    });
    expect(parsed.accounts.map(a => [a.account, a.models])).toEqual([
      ['openai/k1', ['openai/gpt-5', 'openai/gpt-legacy']],
      ['openai/k2', ['openai/gpt-5']]
    ]);
    expect(parsed.models).toHaveLength(2);

    // Duplicate non-chat entries of the same ID must never clobber a valid chat model (matching /v1/models).
    const mixed = discoverMagpieAccountCatalog({
      object: 'list',
      data: [
        {
          provider: 'openai',
          id: 'k1',
          pin: 'openai/k1',
          label: 'k1',
          on: true,
          models: [
            { id: 'openai/dual-a', kind: 'chat', display_name: 'Dual A', pricing: { prompt: '0.000001', completion: '0.000002' } },
            { id: 'openai/dual-a', kind: 'image' },
            { id: 'openai/dual-b', kind: 'image' }
          ]
        },
        {
          provider: 'openai',
          id: 'k2',
          pin: 'openai/k2',
          label: 'k2',
          on: true,
          models: [{ id: 'openai/dual-b', display_name: 'Dual B', pricing: { prompt: '0.000003', completion: '0.000004' } }]
        }
      ]
    });
    expect(mixed.models.map(m => [m.id, m.kind ?? 'chat', m.display_name])).toEqual([
      ['openai/dual-a', 'chat', 'Dual A'],
      ['openai/dual-b', 'chat', 'Dual B']
    ]);
  });

  test('exposes disabled accounts of enabled providers with account_disabled, excludes whole-provider-off, and omits gateway-default for disabled-only models', async () => {
    const adapter = new MagpieBenchAdapter('http://127.0.0.1:3425/v1', 'magpie', 18, [
      { provider_id: 'openai', account: 'openai/off-manual', account_ref: 'manual-off-key' }
    ]);
    adapter.gateway = async (path: string) => {
      if (path === '/models') {
        return {
          data: [{ id: 'openai/gpt-5', owned_by: 'openai', display_name: 'GPT-5', pricing: { prompt: 0.000001, completion: 0.000002 } }]
        };
      }
      if (path === '/magpie/accounts?models=full') {
        return {
          object: 'list',
          data: [
            {
              provider: 'openai',
              id: 'off-spare',
              pin: 'openai/off-spare',
              kind: 'key',
              label: 'spare',
              on: false,
              models: [
                { id: 'openai/gpt-5', display_name: 'GPT-5', pricing: { prompt: '0.000001', completion: '0.000002' } },
                {
                  id: 'openai/gpt-5-preview',
                  display_name: 'GPT-5 Preview',
                  reasoning_levels: ['high'],
                  pricing: { prompt: '0.000002', completion: '0.000004' }
                }
              ]
            },
            {
              provider: 'openai',
              id: 'off-manual',
              pin: 'openai/off-manual',
              kind: 'key',
              label: 'manual-off',
              on: false,
              models: [{ id: 'openai/gpt-5', display_name: 'GPT-5', pricing: { prompt: '0.000001', completion: '0.000002' } }]
            },
            {
              provider: 'openai',
              id: 'on-main',
              pin: 'openai/on-main',
              kind: 'key',
              label: 'main',
              on: true,
              models: [{ id: 'openai/gpt-5', display_name: 'GPT-5', pricing: { prompt: '0.000001', completion: '0.000002' } }]
            },
            {
              provider: 'switched-off',
              id: 'dead-key',
              pin: 'switched-off/dead-key',
              kind: 'key',
              label: 'dead',
              on: false,
              models: [{ id: 'switched-off/m1', display_name: 'Dead Model', pricing: { prompt: '0.000001', completion: '0.000002' } }]
            }
          ]
        };
      }
      throw new TypeError('unexpected path ' + path);
    };

    const routes = await adapter.routes.public_routes();
    // Whole provider switched off (no on:true accounts) is never exposed.
    expect(routes.some(r => r.provider_id === 'switched-off')).toBe(false);

    // Shared model has gateway-default, manual binding (inherits disabled), enabled account, then disabled account.
    const gpt5Routes = routes.filter(r => r.model === 'openai/gpt-5');
    expect(gpt5Routes.map(r => [r.account_ref, r.account_evidence, r.account_disabled ?? false])).toEqual([
      ['gateway-default', 'gateway_binding', false],
      ['manual-off-key', 'configured_binding', true],
      ['main', 'gateway_account_binding', false],
      ['spare', 'gateway_account_binding', true]
    ]);

    // Model served only by disabled account omits gateway-default and keeps only the pinned disabled binding.
    const previewRoutes = routes.filter(r => r.model === 'openai/gpt-5-preview');
    expect(previewRoutes.map(r => [r.account_ref, r.account_evidence, r.account_disabled ?? false])).toEqual([
      ['manual-off-key', 'configured_binding', true],
      ['spare', 'gateway_account_binding', true]
    ]);

    // Resolving a disabled pinned route still pins verbatim via X-Magpie-Account.
    const spareRoute = previewRoutes.find(r => r.account_ref === 'spare')!;
    const resolved = await adapter.routes.resolve(spareRoute.id);
    expect(adapter.routes.create_client(resolved)._headers()['X-Magpie-Account']).toBe(encodeURIComponent('openai/off-spare'));

    // Under the 200-entry cap, enabled accounts are prioritized ahead of disabled accounts.
    const capped = discoverMagpieAccounts({
      object: 'list',
      data: [
        ...Array.from({ length: 10 }, (_, i) => ({
          provider: 'openai',
          id: `off-${i}`,
          pin: `openai/off-${i}`,
          kind: 'key',
          label: `off-${i}`,
          on: false
        })),
        ...Array.from({ length: 195 }, (_, i) => ({
          provider: 'openai',
          id: `on-${i}`,
          pin: `openai/on-${i}`,
          kind: 'key',
          label: `on-${i}`,
          on: true
        }))
      ]
    });
    expect(capped).toHaveLength(200);
    expect(capped.filter(a => !a.disabled)).toHaveLength(195);
    expect(capped.filter(a => a.disabled)).toHaveLength(5);
  });
});
