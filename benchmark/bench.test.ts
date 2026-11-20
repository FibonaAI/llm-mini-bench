import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bench_api_request, main } from './bench.ts';

const stops: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const stop of stops.reverse()) await stop();
    stops.length = 0;
});
function server(handler: (request: Request) => Response | Promise<Response>) {
    const service = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
    stops.push(() => service.stop());
    return 'http://127.0.0.1:' + service.port;
}
test('CLI rejects non-loopback origins and missing token before transport', async () => {
    for (const url of [
        'https://localhost',
        'http://evil.example',
        'http://127.1',
        'http://2130706433',
        'http://user:pass@localhost',
        'http://localhost/path',
        'http://localhost/?query=x',
        'http://localhost/#fragment'
    ])
        await expect(bench_api_request(url, 'token', 'GET', 'runs')).rejects.toThrow('loopback HTTP origin');
    await expect(bench_api_request('http://localhost', '', 'GET', 'runs')).rejects.toThrow('TOKEN');
});
test('CLI passes token only to configured API origin and never follows redirects', async () => {
    let downstream = 0;
    const target = server(() => {
        downstream++;
        return Response.json({});
    });
    const source = server(request => {
        expect(request.headers.get('X-Mini-Bench-Token')).toBe('private-token');
        return new Response('', { status: 302, headers: { Location: target + '/capture' } });
    });
    await expect(bench_api_request(source, 'private-token', 'GET', 'runs')).rejects.toThrow('HTTP 302');
    expect(downstream).toBe(0);
});
test('CLI sends plan/start/show/cancel with stable API shapes', async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const url = server(async request => {
        requests.push({
            path: new URL(request.url).pathname,
            method: request.method,
            body: request.method === 'POST' ? await request.json() : null
        });
        return Response.json({ ok: true });
    });
    const directory = mkdtempSync(join(tmpdir(), 'mini-bench-cli-'));
    stops.push(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, 'plan.json');
    writeFileSync(file, '{"targets":[{"route_id":"a","thinking":"high"}]}');
    const token = process.env.MAGPIE_BENCH_TOKEN;
    process.env.MAGPIE_BENCH_TOKEN = 'private-token';
    const output = spyOn(console, 'log').mockImplementation(() => {});
    try {
        for (const command of [
            ['routes'],
            ['banks'],
            ['runs'],
            ['plan', file],
            ['start', file],
            ['show', 'a'.repeat(32)],
            ['cancel', 'a'.repeat(32)],
            ['tasks'],
            ['task-plan', file],
            ['task-start', file],
            ['task-show', 'b'.repeat(32)],
            ['task-cancel', 'b'.repeat(32)]
        ])
            expect(await main(['--url', url, ...command])).toBe(0);
        expect(requests.map(row => [row.method, row.path])).toEqual([
            ['GET', '/api/bench/routes'],
            ['GET', '/api/bench/banks'],
            ['GET', '/api/bench/runs'],
            ['POST', '/api/bench/plans'],
            ['POST', '/api/bench/runs'],
            ['GET', '/api/bench/runs/' + 'a'.repeat(32)],
            ['POST', '/api/bench/runs/' + 'a'.repeat(32) + '/cancel'],
            ['GET', '/api/bench/tasks'],
            ['POST', '/api/bench/task-plans'],
            ['POST', '/api/bench/tasks'],
            ['GET', '/api/bench/tasks/' + 'b'.repeat(32)],
            ['POST', '/api/bench/tasks/' + 'b'.repeat(32) + '/cancel']
        ]);
        expect(requests[3]!.body).toEqual({ targets: [{ route_id: 'a', thinking: 'high' }] });
    } finally {
        output.mockRestore();
        if (token === undefined) delete process.env.MAGPIE_BENCH_TOKEN;
        else process.env.MAGPIE_BENCH_TOKEN = token;
    }
});
test('invalid plans and malformed run IDs never submit', async () => {
    let calls = 0;
    const url = server(() => {
        calls++;
        return Response.json({});
    });
    const directory = mkdtempSync(join(tmpdir(), 'mini-bench-cli-invalid-'));
    stops.push(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, 'plan.json'),
        errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
        for (const content of ['[]', '{', '{"a":1,"a":2}', '{"x":NaN}', '{"x":1e999}']) {
            writeFileSync(file, content);
            expect(await main(['--url', url, 'start', file])).toBe(1);
        }
        expect(await main(['--url', url, 'cancel', '../etc'])).toBe(1);
        expect(await main(['--url', url, 'task-cancel', '../etc'])).toBe(1);
        expect(calls).toBe(0);
    } finally {
        errors.mockRestore();
    }
});
test('CLI forwards parsed numeric spellings without turning floats into integers', async () => {
    let received = '';
    const url = server(async request => {
        received = await request.text();
        return Response.json({});
    });
    const { parseAssessmentJson } = await import('./src/assessment_json.ts');
    await bench_api_request(url, 'token', 'POST', 'plans', parseAssessmentJson('{"rounds":1.0,"limits":{"max_requests":1e0}}'));
    expect(received).toContain('"rounds":1.0');
    expect(received).toContain('"max_requests":1e0');
});

test('CLI unavailable error warns that submitted run may still exist', async () => {
    const server_ = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({}) });
    const url = 'http://127.0.0.1:' + server_.port;
    await server_.stop();
    await expect(bench_api_request(url, 'token', 'POST', 'runs', {})).rejects.toThrow('check tasks and runs before resubmitting');
});
test('CLI and standalone serve help are import safe', async () => {
    const output = spyOn(console, 'log').mockImplementation(() => {});
    try {
        expect(await main(['--help'])).toBe(0);
        expect(await main(['serve', '--help'])).toBe(0);
        expect(output).toHaveBeenCalledTimes(2);
    } finally {
        output.mockRestore();
    }
});
