import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BenchService, make_handler } from '../backend/mini_bench.ts';

test('opaque sandbox may load module and SVG assets without weakening Host, Origin or API token checks', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mini-bench-static-cors-'));
    const token = 'offline-static-cors-test-token-000000000000';
    const service = new BenchService({ token, data_dir: directory });
    const handler = make_handler(service, fileURLToPath(new URL('../web/', import.meta.url)));
    const request = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
        handler(new Request('http://127.0.0.1:3481' + path, { method, headers: { Host: '127.0.0.1:3481', ...headers } }));
    try {
        for (const [path, mime] of [
            ['/bench.js', 'text/javascript'],
            ['/analysis.js', 'text/javascript'],
            ['/icons/download.svg', 'image/svg+xml']
        ]) {
            const opaque = await request(path!, { Origin: 'null' });
            expect(opaque.status).toBe(200);
            expect(opaque.headers.get('access-control-allow-origin')).toBe('null');
            expect(opaque.headers.get('vary')).toBe('Origin');
            expect(opaque.headers.get('content-type')).toStartWith(mime!);
            expect(opaque.headers.get('x-content-type-options')).toBe('nosniff');
            expect((await opaque.text()).length).toBeGreaterThan(0);
            const foreign = await request(path!, { Origin: 'https://foreign.invalid' });
            expect(foreign.status).toBe(403);
            expect(foreign.headers.has('access-control-allow-origin')).toBe(false);
            const direct = await request(path!);
            expect(direct.status).toBe(200);
            expect(direct.headers.has('access-control-allow-origin')).toBe(false);
            const sameOrigin = await request(path!, { Origin: 'http://127.0.0.1:3481' });
            expect(sameOrigin.status).toBe(200);
            expect(sameOrigin.headers.has('access-control-allow-origin')).toBe(false);
        }
        expect((await request('/bench.js', { Host: 'foreign.invalid', Origin: 'null' })).status).toBe(403);
        expect((await request('/api/bench/banks', { Origin: 'null' })).status).toBe(403);
        expect((await request('/api/bench/banks', { Origin: 'null', 'X-Mini-Bench-Token': 'wrong' })).status).toBe(403);
        const authenticated = await request('/api/bench/banks', { Origin: 'null', 'X-Mini-Bench-Token': token });
        expect(authenticated.status).toBe(200);
        expect(authenticated.headers.get('access-control-allow-origin')).toBe('null');
        expect((await authenticated.json()).banks[0].tasks).toHaveLength(12);
        expect((await request('/api/bench/banks', { Origin: 'https://foreign.invalid', 'X-Mini-Bench-Token': token })).status).toBe(403);
        const preflight = await request(
            '/api/bench/banks',
            { Origin: 'null', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'X-Mini-Bench-Token' },
            'OPTIONS'
        );
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get('access-control-allow-origin')).toBe('null');
        expect(preflight.headers.get('access-control-allow-headers')).toContain('X-Mini-Bench-Token');
        expect((await request('/api/bench/banks', { Origin: 'https://foreign.invalid' }, 'OPTIONS')).status).toBe(403);
    } finally {
        await service.close();
        rmSync(directory, { recursive: true, force: true });
    }
});
