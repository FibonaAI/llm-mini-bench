import { describe, expect, test } from 'bun:test';
import { MagpieAccountClient, validateMagpieAccountBindings } from './magpie_accounts.ts';
import { MagpieBenchRoutes } from './magpie_routes.ts';

describe('Magpie account adapter', () => {
    test('validates explicit local bindings without deriving them from quota cards', () => {
        expect(validateMagpieAccountBindings(undefined)).toEqual([]);
        const value = [{ provider_id: 'fixture', account: '测试账号', account_ref: 'subscription-a', models: ['fixture/gpt-6-luna'] }];
        const bindings = validateMagpieAccountBindings(value);
        value[0]!.account = 'changed';
        expect(bindings[0]!.account).toBe('测试账号');
        for (const row of [{}, { ...bindings[0], provider_id: 'remote/codex' }, { ...bindings[0], provider_id: 'auto' }, { ...bindings[0], account: 'bad\nheader' }, { ...bindings[0], key: 'inline-secret' }, { ...bindings[0], models: [null] }])
            expect(() => validateMagpieAccountBindings([row])).toThrow();
        expect(() => validateMagpieAccountBindings([...bindings, ...bindings])).toThrow('duplicated');
    });
    test('same model retains separate account targets; remote quotas never become pins', async () => {
        const rows = [{ id: 'fixture/gpt-6-luna', owned_by: 'fixture', pricing: { prompt: 0, completion: 0 } }, { id: 'office/codex/gpt-6-luna', owned_by: 'office', magpie_via: ['remote', 'local'], pricing: { prompt: 0, completion: 0 } }];
        const routes = new MagpieBenchRoutes(() => rows, 'http://127.0.0.1:3425/v1', () => 'gateway-key', 18, [
            { provider_id: 'fixture', account: 'a@example.invalid', account_ref: 'a' },
            { provider_id: 'fixture', account: 'b@example.invalid', account_ref: 'b' },
            { provider_id: 'office', account: 'remote@example.invalid', account_ref: 'remote' }
        ]);
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
    test('HTTP transport sends encoded pins without rewriting model IDs or following redirects', async () => {
        const calls: { pin: string | null; model: string }[] = [];
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
            calls.push({ pin: request.headers.get('X-Magpie-Account'), model: (await request.json()).model });
            return Response.json({ status: 'completed', output_text: 'ok' });
        } });
        try {
            for (const account of ['a@example.invalid', '测试账号', '50%off']) {
                const client = new MagpieAccountClient(`http://127.0.0.1:${server.port}`, 'gateway-key', account);
                expect((await client.post_responses_non_stream({ model: 'fixture/gpt-6-luna', input: 'ping' }))[0]).toBe(200);
                expect(decodeURIComponent(calls.at(-1)!.pin!)).toBe(account);
                expect(calls.at(-1)!.model).toBe('fixture/gpt-6-luna');
            }
        } finally { server.stop(true); }
    });
});
