import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BenchRouteRegistry, _validate_route_url } from './bench_routes.ts';

const directories: string[] = [];
function directory() { const value = mkdtempSync(join(tmpdir(), 'bench-route-test-')); directories.push(value); return value; }
const envName = 'BENCH_TEST_PRIVATE_API_KEY';
function fixture(changes: Record<string, unknown> = {}) { return { id: 'route-a', label: 'Account A / model', account_ref: 'account-a', base_url: 'https://gateway.example/v1', model: 'provider/model-name', api_key_env: envName, thinking_levels: ['none', 'low', 'high'], pricing: { prompt: 0.000001, completion: 0.000003 }, account_concurrency: 1, ...changes }; }
function registry(rows: unknown[]) { const path = join(directory(), 'routes.json'); writeFileSync(path, JSON.stringify({ routes: rows })); return new BenchRouteRegistry(path); }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); delete process.env[envName]; });

describe('explicit route configuration', () => {
    test('missing configuration is empty without writing files', () => {
        const path = join(directory(), 'missing.json');
        expect(new BenchRouteRegistry().public_routes()).toEqual([]);
        expect(new BenchRouteRegistry(path).public_routes()).toEqual([]);
        expect(existsSync(path)).toBe(false);
    });
    test('public catalog redacts credentials and all returned values are isolated', () => {
        const routes = registry([fixture()]);
        expect(() => routes.resolve('route-a')).toThrow('credential');
        process.env[envName] = 'secret-one';
        const publicRows = routes.public_routes();
        for (const secret of [envName, 'https://gateway.example', 'secret-one']) expect(JSON.stringify(publicRows)).not.toContain(secret);
        publicRows[0]!.thinking_levels.push('mutated'); publicRows[0]!.pricing.prompt = 99;
        const resolved = routes.resolve('route-a');
        expect(resolved.api_key).toBe('secret-one');
        expect(resolved.thinking_levels).not.toContain('mutated');
        expect(resolved.pricing.prompt).toBe(0.000001);
        resolved.pricing.prompt = 123;
        process.env[envName] = 'rotated-secret';
        expect(routes.resolve('route-a').api_key).toBe('rotated-secret');
        expect(routes.resolve('route-a').pricing.prompt).toBe(0.000001);
        expect(() => routes.resolve('unknown')).toThrow('not configured');
    });
    test('invalid inline credentials, prices, fields, concurrency and efforts fail closed', () => {
        for (const changes of [{ api_key: 'secret' }, { id: '' }, { id: ' x' }, { model: 'bad\nname' }, { api_key_env: 'not a name' }, { pricing: { prompt: '0', completion: 0 } }, { pricing: { prompt: false, completion: 0 } }, { pricing: { prompt: -1, completion: 0 } }, { pricing: { prompt: 0 } }, { account_concurrency: true }, { account_concurrency: 0 }, { thinking_levels: ['default'] }, { thinking_levels: ['mixed'] }, { thinking_levels: ['none', 'none'] }]) expect(() => registry([fixture(changes)])).toThrow();
        expect(() => registry([fixture(), fixture()])).toThrow('duplicate');
        expect(() => registry([fixture(), fixture({ id: 'route-b', account_concurrency: 2 })])).toThrow('agree');
        const path = join(directory(), 'float-concurrency.json');
        writeFileSync(path, JSON.stringify({ routes: [fixture()] }).replace('"account_concurrency":1', '"account_concurrency":1.0'));
        expect(() => new BenchRouteRegistry(path)).toThrow('account_concurrency');
    });
    test('configured routes keep their strict schema and do not infer provider metadata', () => {
        const row = registry([fixture()]).public_routes()[0]!;
        for (const key of ['provider_id', 'provider_evidence', 'model_display_name', 'remote_route']) {
            expect(row).not.toHaveProperty(key);
            expect(() => registry([fixture({ [key]: 'injected' })])).toThrow('exact route fields');
        }
    });
    test('duplicate JSON and nonfinite constants are rejected', () => {
        const path = join(directory(), 'routes.json');
        for (const text of ['{"routes":[],"routes":[]}', '{"routes":NaN}', '{"routes":[],"extra":true}', '[]', '{"routes":[1e999]}']) {
            writeFileSync(path, text); expect(() => new BenchRouteRegistry(path)).toThrow();
        }
    });
    test('credentials are validated without echoing secrets or environment names', () => {
        const routes = registry([fixture()]);
        for (const credential of ['', 'has space', 'bad\nheader', 'bad\x7f']) { process.env[envName] = credential; expect(() => routes.resolve('route-a')).toThrow('missing or invalid'); }
    });
    test('HTTPS and exact loopback URLs only, without URL parsing normalization bypasses', () => {
        for (const url of ['https://gateway.example/v1', 'https://localhost:443/v1', 'http://localhost/v1', 'http://localhost./v1', 'http://127.0.0.2:123/v1', 'http://[::1]:123/v1', 'http://[::ffff:127.0.0.1]:123/v1']) expect(_validate_route_url(url), url).toBe(true);
        for (const url of ['http://example.com', 'ftp://example.com', 'https://user:pass@example.com', 'https://example.com?key=x', 'https://example.com#x', 'https://example.com\\@evil', 'https://exa mple.com', 'https://%65xample.com', 'https://example.com:', 'https://example.com:0', 'https://example.com:65536', 'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://0177.0.0.1', 'http://[::ffff:10.0.0.1]', 'https://bad..host', 'https://-bad.example']) expect(_validate_route_url(url), url).toBe(false);
    });
});
