#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import {
    assessmentJsonNumberToken,
    canonicalAssessmentJson,
    parseAssessmentJson
} from './src/assessment_json.ts';

function serializeBenchPlan(value: unknown): string {
    // Validate finite plain JSON first, then retain parsed integer-versus-float tokens on the wire.
    canonicalAssessmentJson(value);
    const encode = (item: unknown, parent?: object, key?: string): string => {
        if (typeof item === 'number' && parent && key !== undefined) {
            return assessmentJsonNumberToken(parent, key) ?? String(item);
        }
        if (Array.isArray(item))
            return '[' + item.map((child, index) => encode(child, item, String(index))).join(',') + ']';
        if (item !== null && typeof item === 'object')
            return (
                '{' +
                Object.entries(item)
                    .map(([key, child]) => JSON.stringify(key) + ':' + encode(child, item, key))
                    .join(',') +
                '}'
            );
        return JSON.stringify(item);
    };
    return encode(value);
}

/** Call only a loopback HTTP origin, never follow a credential-bearing redirect. */
export async function bench_api_request(
    base_url: string,
    token: string,
    method: string,
    path: string,
    body?: unknown
): Promise<unknown> {
    let parsed: URL;
    try {
        parsed = new URL(base_url);
    } catch {
        throw new TypeError('Bench CLI URL must be a loopback HTTP origin');
    }
    if (
        !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?\/?$/i.test(base_url) ||
        parsed.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        parsed.pathname !== '/'
    )
        throw new TypeError('Bench CLI URL must be a loopback HTTP origin');
    if (!token) throw new TypeError('Bench CLI requires MAGPIE_BENCH_TOKEN');
    if (!/^(routes|banks|runs|plans|tasks|task-plans|(?:runs|tasks)\/[0-9a-f]{32}(?:\/cancel)?)$/.test(path))
        throw new TypeError('Bench CLI invalid API path');
    const serialized = body === undefined ? undefined : serializeBenchPlan(body);
    let response: Response;
    try {
        response = await fetch(parsed.origin + '/api/bench/' + path, {
            method,
            headers: { 'X-Mini-Bench-Token': token, 'Content-Type': 'application/json' },
            body: serialized,
            redirect: 'manual',
            signal: AbortSignal.timeout(30000)
        });
    } catch {
        throw new TypeError(
            'Bench API unavailable or timed out; a submitted task or run may still exist, check tasks and runs before resubmitting'
        );
    }
    let value: unknown;
    try {
        value = parseAssessmentJson(await response.text());
    } catch {
        value = null;
    }
    if (!response.ok) {
        const detail =
            value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
                ? value.error
                : 'request rejected';
        throw new TypeError('Bench API HTTP ' + response.status + ': ' + detail);
    }
    if (value === null) throw new TypeError('Bench API returned invalid JSON');
    return value;
}
/** Submit to the existing service, rather than creating another scheduler. */
export async function main(argv = process.argv.slice(2)): Promise<number> {
    if (argv[0] === 'serve') {
        const { main: serve } = await import('./backend/mini_bench.ts');
        await serve(argv.slice(1));
        return 0;
    }
    if (argv.includes('--help')) {
        console.log(
            'Usage: bun benchmark/bench.ts serve [--port PORT] [--data-dir PATH]\n       bun benchmark/bench.ts [--url LOOPBACK_ORIGIN] routes|banks|tasks|runs\n       bun benchmark/bench.ts [--url LOOPBACK_ORIGIN] task-plan|task-start FILE\n       bun benchmark/bench.ts [--url LOOPBACK_ORIGIN] task-show|task-cancel TASK_ID\n       bun benchmark/bench.ts [--url LOOPBACK_ORIGIN] plan|start FILE\n       bun benchmark/bench.ts [--url LOOPBACK_ORIGIN] show|cancel RUN_ID\nTask limits are per run; inspect total_max_cost_usd before starting. Requires MAGPIE_BENCH_TOKEN. After submission timeout, inspect tasks and runs before resubmitting.'
        );
        return 0;
    }
    try {
        const args = [...argv];
        let url = process.env.MAGPIE_BENCH_URL ?? 'http://127.0.0.1:3481';
        if (args[0] === '--url') {
            args.shift();
            url = args.shift() ?? '';
        }
        const command = args.shift();
        let method = 'GET',
            path: string,
            body: unknown = undefined;
        if (command === 'routes' || command === 'banks' || command === 'runs' || command === 'tasks') {
            path = command;
            if (args.length) throw new TypeError('Bench CLI unexpected argument');
        } else if (command === 'plan' || command === 'start' || command === 'task-plan' || command === 'task-start') {
            if (args.length !== 1) throw new TypeError('Bench CLI requires one JSON plan file');
            body = parseAssessmentJson(readFileSync(args[0]!, 'utf8'));
            if (!body || typeof body !== 'object' || Array.isArray(body))
                throw new TypeError('Bench plan must be a JSON object');
            method = 'POST';
            path = ({ plan: 'plans', start: 'runs', 'task-plan': 'task-plans', 'task-start': 'tasks' })[command];
        } else if (command === 'show' || command === 'cancel' || command === 'task-show' || command === 'task-cancel') {
            if (args.length !== 1 || !/^[0-9a-f]{32}$/.test(args[0]!))
                throw new TypeError('Bench task or run ID must contain 32 lowercase hexadecimal characters');
            path = (command.startsWith('task-') ? 'tasks/' : 'runs/') + args[0];
            if (command === 'cancel' || command === 'task-cancel') {
                method = 'POST';
                path += '/cancel';
                body = {};
            }
        } else throw new TypeError('Bench CLI requires routes, banks, tasks, task-plan, task-start, task-show, task-cancel, runs, plan, start, show or cancel');
        const result = await bench_api_request(url, process.env.MAGPIE_BENCH_TOKEN ?? '', method, path, body);
        console.log(JSON.stringify(result, null, 2));
        return 0;
    } catch (error) {
        console.error(
            error instanceof Error && 'code' in error
                ? 'Bench CLI could not read plan file'
                : error instanceof Error
                  ? error.message
                  : 'Bench CLI request failed'
        );
        return 1;
    }
}
if (import.meta.main) process.exitCode = await main();
