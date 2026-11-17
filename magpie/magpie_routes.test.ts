import { describe, expect, test } from 'bun:test';
import { MagpieBenchRoutes as BenchGatewayRoutes } from './magpie_routes.ts';
function model(changes: Record<string, unknown> = {}) { return { id: 'channel/model', reasoning_levels: ['none', 'high'], pricing: { prompt: '0.000001', completion: '0.000002' }, ...changes }; }
describe('Magpie catalog routes', () => {
    test('only explicit priced models, concurrent readers and lazy credential rotation', async () => {
        let loads = 0, key = 'first';
        const routes = new BenchGatewayRoutes(async () => { loads++; return [model(), model({ id: 'unknown', pricing: {} }), model({ id: 'negative', pricing: { prompt: -1, completion: 0 } })]; }, 'http://127.0.0.1:3425/v1', () => key, 2);
        expect(loads).toBe(0);
        const [a, b] = await Promise.all([routes.public_routes(), routes.public_routes()]);
        expect(loads).toBe(1); expect(a).toEqual(b); expect(a).not.toBe(b); expect(a).toHaveLength(1);
        expect(a[0]!.account_evidence).toBe('gateway_binding');
        expect(a[0]!.id).toMatch(/^gateway-[0-9a-f]{24}$/);
        expect((await routes.resolve(a[0]!.id)).api_key).toBe('first');
        key = 'rotated'; expect((await routes.resolve(a[0]!.id)).api_key).toBe('rotated');
        a[0]!.pricing.prompt = 100; expect((await routes.public_routes())[0]!.pricing.prompt).toBe(0.000001);
        expect(loads).toBe(4);
    });
    test('catalog metadata preserves provider instances without parsing model IDs or exposing other fields', async () => {
        const catalog = [
            model({ id: 'chatgpt-api/shared', owned_by: 'chatgpt-api', display_name: 'Shared model' }),
            model({ id: 'chatgpt-api-2/shared', owned_by: 'chatgpt-api-2', display_name: 'Shared model' }),
            model({ id: 'remote-magpie/openai/shared', owned_by: 'remote-magpie', display_name: 'Remote model', provider_type: 'openai', icon: 'private-icon', account_id: 'private-account', api_key: 'private-key' }),
            model({ id: 'group/custom', owned_by: 'group', display_name: 'Custom group' }),
            model({ id: 'looks-like-provider/model' })
        ];
        const routes = new BenchGatewayRoutes(() => catalog, 'https://example.com', () => 'key', 2);
        const rows = await routes.public_routes();
        expect(rows.map(row => row.provider_id)).toEqual(['chatgpt-api', 'chatgpt-api-2', 'remote-magpie', 'group', undefined]);
        expect(new Set(rows.map(row => row.id)).size).toBe(5);
        for (const [index, row] of rows.entries()) {
            expect(row.model).toBe(catalog[index]!.id); expect(row.label).toBe(catalog[index]!.id);
            expect(row.account_ref).toBe('gateway-default'); expect(row.account_evidence).toBe('gateway_binding');
            expect(row.provider_evidence).toBe(index < 4 ? 'gateway_catalog' : undefined);
        }
        expect(rows[2]!.model_display_name).toBe('Remote model');
        expect(JSON.stringify(rows)).not.toMatch(/provider_type|private-icon|private-account|private-key|account_id/);
        rows[0]!.provider_id = 'changed';
        expect((await routes.resolve(rows[0]!.id)).provider_id).toBe('chatgpt-api');
    });
    test('invalid optional catalog metadata is omitted without removing otherwise usable routes', async () => {
        const values = [null, 123, '', ' padded', 'bad\nname', 'x'.repeat(257)];
        const routes = new BenchGatewayRoutes(() => values.map((value, index) => model({ id: `route-${index}/model`, owned_by: value, display_name: value })), 'https://example.com', () => 'key', 1);
        const rows = await routes.public_routes();
        expect(rows).toHaveLength(values.length);
        for (const row of rows) for (const key of ['provider_id', 'provider_evidence', 'model_display_name']) expect(row).not.toHaveProperty(key);
    });
    test('remote catalogs expose one route namespace without changing identities or retaining via tokens', async () => {
        const catalog = [
            model({ id: 'office/relay-a/vendor/model', owned_by: 'office', magpie_via: ['private-peer-token', 'private-local-token'] }),
            model({ id: 'home/relay-a/vendor/model', owned_by: 'home', magpie_via: ['private-peer-token', 'private-local-token'], kind: 'chat' }),
            model({ id: 'office/auto/model', owned_by: 'office', magpie_via: ['peer', 'local'] }),
            model({ id: 'office/group/custom', owned_by: 'office', magpie_via: ['peer', 'local'] }),
            model({ id: 'office/another-remote/relay-a/model', owned_by: 'office', magpie_via: ['deep-peer', 'peer', 'local'] }),
            model({ id: 'office/legacy.relay/model', owned_by: 'office', magpie_via: Array(9).fill('hop') })
        ];
        const routes = new BenchGatewayRoutes(() => catalog, 'https://example.com', () => 'key', 2);
        const rows = await routes.public_routes();
        expect(rows.map(row => row.remote_route)).toEqual(['relay-a', 'relay-a', 'auto', 'group', 'another-remote', 'legacy.relay'].map(namespace => ({ namespace, evidence: 'magpie_via_catalog' })));
        expect(rows.map(row => row.provider_id)).toEqual(['office', 'home', 'office', 'office', 'office', 'office']);
        expect(rows[0]!.id).not.toBe(rows[1]!.id);
        expect(new Set(rows.map(row => JSON.stringify([row.provider_id, row.remote_route?.namespace]))).size).toBe(6);
        const withoutMetadata = new BenchGatewayRoutes(() => catalog.map(row => ({ ...row, magpie_via: undefined })), 'https://example.com', () => 'key', 2);
        expect(rows.map(row => row.id)).toEqual((await withoutMetadata.public_routes()).map(row => row.id));
        for (const [index, row] of rows.entries()) {
            expect(row.model).toBe(catalog[index]!.id); expect(row.label).toBe(catalog[index]!.id);
            expect(row.account_ref).toBe('gateway-default'); expect(row.account_evidence).toBe('gateway_binding');
        }
        expect(JSON.stringify(rows)).not.toMatch(/private-peer-token|private-local-token|deep-peer|magpie_via"/);
        rows[0]!.remote_route!.namespace = 'mutated';
        const resolved = await routes.resolve(rows[0]!.id);
        expect(resolved.remote_route).toEqual({ namespace: 'relay-a', evidence: 'magpie_via_catalog' });
        resolved.remote_route!.namespace = 'mutated-again';
        expect((await routes.public_routes())[0]!.remote_route!.namespace).toBe('relay-a');
        catalog[0]!.id = 'changed/at/source';
        await expect(routes.resolve(rows[0]!.id)).rejects.toThrow('unavailable');
        expect((await routes.public_routes())[0]!.model).toBe('changed/at/source');
    });
    test('remote route namespace uses bounded display text, not inferred provider slug rules', async () => {
        const namespace = 'n'.repeat(129);
        const routes = new BenchGatewayRoutes(() => [
            model({ id: `office/${namespace}/model`, owned_by: 'office', magpie_via: ['p'.repeat(128), 'local'] }),
            model({ id: 'office/listed alias/model', owned_by: 'office', magpie_via: ['peer', 'local'] })
        ], 'https://example.com', () => 'key', 1);
        expect((await routes.public_routes()).map(row => row.remote_route?.namespace)).toEqual([namespace, 'listed alias']);
    });
    test('missing or invalid remote via falls back without inferring from provider names or slash models', async () => {
        const invalidVia: unknown[] = [undefined, null, 'peer/local', [], ['local'], ['peer', null], ['peer', 1], ['peer', ''], ['peer', ' padded'], ['peer', 'bad\nname'], ['peer', 'x'.repeat(129)], Array(10).fill('hop')];
        for (const magpie_via of invalidVia) {
            const routes = new BenchGatewayRoutes(() => [model({ id: 'remote-magpie/openai/model', owned_by: 'remote-magpie', magpie_via })], 'https://example.com', () => 'key', 1);
            const rows = await routes.public_routes();
            expect(rows).toHaveLength(1); expect(rows[0]).not.toHaveProperty('remote_route');
        }
        const routes = new BenchGatewayRoutes(() => [
            model({ id: 'openrouter/anthropic/model', owned_by: 'openrouter', magpie_via: ['local'] }),
            model({ id: 'openrouter/anthropic/other', owned_by: 'openrouter' }),
            model({ id: 'remote-magpie/openai/model', owned_by: 'remote-magpie' })
        ], 'https://example.com', () => 'key', 1);
        for (const row of await routes.public_routes()) expect(row).not.toHaveProperty('remote_route');
    });
    test('local groups and unparseable route paths do not become remote provider identities', async () => {
        const catalog = [
            ['group/custom', 'office'], ['auto/model', 'office'],
            ['group/relay/model', 'group'], ['auto/relay/model', 'auto'],
            ['office/relay/model', 'different-owner'], ['office/relay/other', undefined],
            ['office/model', 'office'], ['office//model', 'office'], ['office/relay/', 'office'],
            ['office/ padded/model', 'office'], ['office/padded /model', 'office'],
            ['office/relay/ padded', 'office']
        ].map(([id, owned_by]) => model({ id, owned_by, magpie_via: ['peer', 'local'] }));
        const routes = new BenchGatewayRoutes(() => catalog, 'https://example.com', () => 'key', 1);
        const rows = await routes.public_routes();
        expect(rows).toHaveLength(catalog.length);
        for (const row of rows) expect(row).not.toHaveProperty('remote_route');
    });
    test('remote discovery ignores all explicitly non-chat catalog kinds, including duplicate image IDs', async () => {
        const routes = new BenchGatewayRoutes(() => [
            model({ id: 'office/relay/model', owned_by: 'office', magpie_via: ['peer', 'local'] }),
            ...['image', 'video', 'decision', 'embedding', '', null, 1].map(kind => model({ id: 'office/relay/model', kind })),
            model({ id: 'office/relay/chat', kind: 'chat' })
        ], 'https://example.com', () => 'key', 1);
        expect((await routes.public_routes()).map(row => row.model)).toEqual(['office/relay/model', 'office/relay/chat']);
    });
    test('empty and failed discovery remain retryable, duplicate models are rejected', async () => {
        let loads = 0;
        const routes = new BenchGatewayRoutes(() => { loads++; if (loads === 1) throw new Error('offline'); return loads === 2 ? [] : [model()]; }, 'https://example.com', () => 'key', 1);
        await expect(routes.public_routes()).rejects.toThrow('offline');
        expect(await routes.public_routes()).toEqual([]); expect(await routes.public_routes()).toHaveLength(1); expect(await routes.public_routes()).toHaveLength(1); expect(loads).toBe(4);
        const duplicates = new BenchGatewayRoutes(() => [model(), model({ pricing: {} })], 'https://example.com', () => 'key', 1);
        await expect(duplicates.public_routes()).rejects.toThrow('duplicate model IDs');
    });
    test('invalid URL, unknown route and credential fail closed', async () => {
        expect(() => new BenchGatewayRoutes(() => [], 'http://remote.example', () => 'key', 1)).toThrow();
        const routes = new BenchGatewayRoutes(() => [model()], 'https://example.com', () => 'bad key', 1);
        await expect(routes.resolve('unknown')).rejects.toThrow('unavailable');
        await expect(routes.resolve((await routes.public_routes())[0]!.id)).rejects.toThrow('credential');
    });
});
