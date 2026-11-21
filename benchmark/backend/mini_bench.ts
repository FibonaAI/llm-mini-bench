import { PRODUCTION_BANK_VERSION } from '../src/production_bank.ts';
import { RunCallSummaryReader } from '../src/bench_call_summaries.ts';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
    build_assessment_baseline,
    load_assessment_baselines,
    project_validated_baseline_observations,
    type AssessmentBaseline
} from '../src/assessment_baselines.ts';
import { load_assessment_bank } from '../src/assessment_bank.ts';
import {
    assessment_source_signature,
    create_assessment_source_context,
    type AssessmentSourceContext
} from '../src/assessment_provenance.ts';
import { parseAssessmentJson } from '../src/assessment_json.ts';
import { readBenchLimitedBody } from '../src/bench_http_body.ts';
export { readBenchLimitedBody } from '../src/bench_http_body.ts';
import { BenchExecutionService, private_directory, save_execution_json } from '../src/bench_execution.ts';
import { BenchRouteRegistry } from '../src/bench_routes.ts';
import type { BenchServiceAdapter, BenchQuotaCatalog } from '../src/bench_adapter.ts';

type JsonObject = Record<string, unknown>;
/** Benchmark-relative paths do not depend on the plugin host working directory. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Reject oversized JSON before parsing or scheduling paid work. */
export const MAX_BODY = 1024 * 1024;
function object(value: unknown): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function expandHome(path: string): string {
    return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}
/** Plugin embedding accepts only local storage paths and runtime-only credentials. */
export interface MiniBenchOptions {
    port?: number;
    token: string;
    data_dir?: string;
    adapter?: BenchServiceAdapter;
    web_dir?: string;
}
/** Application errors carry public messages, never upstream credential-bearing details. */
class BenchUnavailableError extends Error {}
/** Local Assessment service; no process spawning and no automatic paid-task recovery. */
export class BenchService {
    readonly data_dir: string;
    readonly adapter?: BenchServiceAdapter;
    readonly token: string;
    readonly concurrency: number;
    _bench_execution: BenchExecutionService | undefined;

    private closed = false;
    private close_promise: Promise<void> | null = null;
    constructor(options: Partial<MiniBenchOptions> = {}) {
        this.token = options.token ?? process.env.MAGPIE_BENCH_TOKEN ?? '';
        if (Array.from(this.token).length < 32) throw new TypeError('MAGPIE_BENCH_TOKEN must be at least 32 characters');
        const concurrency = process.env.MAGPIE_BENCH_CONCURRENCY ?? '18';
        if (!/^\d+$/.test(concurrency) || Number(concurrency) < 1 || Number(concurrency) > 64)
            throw new TypeError('MAGPIE_BENCH_CONCURRENCY must be an integer from 1 to 64');
        this.concurrency = Number(concurrency);
        this.data_dir = resolve(expandHome(options.data_dir ?? process.env.MAGPIE_BENCH_DATA_DIR ?? '~/.local/share/magpie-mini-bench'));
        this.adapter = options.adapter;
        private_directory(this.data_dir);
        private_directory(join(this.data_dir, 'assessment-baselines'));
    }
    private _call_summaries: RunCallSummaryReader | null = null;
    /** Read-only call diagnosis cache; never reads request bodies or raw streams into responses. */
    call_summaries(root: string): RunCallSummaryReader {
        return (this._call_summaries ??= new RunCallSummaryReader(root));
    }
    bench_execution(): BenchExecutionService {
        if (this.closed) throw new BenchUnavailableError('Assessment service is closed');
        if (!this._bench_execution) {
            const override = process.env.MAGPIE_BENCH_ROUTES_FILE;
            if (override !== undefined && !override.trim()) throw new TypeError('Bench routes file override must not be empty');
            const path = expandHome(override ?? join(this.data_dir, 'routes.json'));
            let entryExists = false;
            try {
                lstatSync(path);
                entryExists = true;
            } catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
            }
            const routes = override !== undefined || entryExists || !this.adapter ? new BenchRouteRegistry(path) : this.adapter.routes;
            this._bench_execution = new BenchExecutionService(join(this.data_dir, 'assessment'), routes, this.concurrency);
        }
        return this._bench_execution;
    }
    async close(): Promise<void> {
        if (this.close_promise) return this.close_promise;
        this.closed = true;
        this.close_promise = this._bench_execution?.close() ?? Promise.resolve();
        return this.close_promise;
    }
    async models(): Promise<JsonObject[]> {
        return this.adapter ? structuredClone(await this.adapter.models()) : [];
    }
    async quota_cards(refresh = false): Promise<BenchQuotaCatalog> {
        return this.adapter?.quotas ? this.adapter.quotas.read(refresh) : { status: 'unavailable', fetched_at: null, cards: [] };
    }
    private _baselines_cache: { key: string; baselines: AssessmentBaseline[] } | null = null;
    private _observations_cache: { key: string; etag: string; body: string; gzip: Uint8Array<ArrayBuffer> | null } | null = null;
    private _banks_cache: { key: string; body: string; gzip: Uint8Array<ArrayBuffer> | null } | null = null;
    private _tasks_cache: { revision: number; body: string; gzip: Uint8Array<ArrayBuffer> | null } | null = null;
    private _runs_cache: { revision: number; body: string; gzip: Uint8Array<ArrayBuffer> | null } | null = null;
    private baselines_signature(): { signature: string; paths: string[] } {
        const paths: string[] = [];
        const parts: string[] = [];
        // Historical fixtures are retained for offline replay, never mixed into personal workspaces.
        const directory = join(this.data_dir, 'assessment-baselines');
        if (existsSync(directory)) {
            for (const name of readdirSync(directory).sort()) {
                if (!name.endsWith('.json')) continue;
                const full = join(directory, name);
                paths.push(full);
                try {
                    const st = statSync(full);
                    parts.push(`${name}:${st.size}:${st.mtimeMs}`);
                } catch {
                    parts.push(`${name}:missing`);
                }
            }
        }
        return { signature: parts.join('|'), paths };
    }
    baselines(context?: AssessmentSourceContext, sourceSig = assessment_source_signature()): AssessmentBaseline[] {
        const { signature, paths } = this.baselines_signature();
        const key = `${sourceSig}\u0000${signature}`;
        if (!context && this._baselines_cache?.key === key) return this._baselines_cache.baselines;
        const resolvedContext = context ?? create_assessment_source_context();
        const baselines = load_assessment_baselines(paths, resolvedContext);
        const deduped = [...new Map(baselines.map(baseline => [baseline.id, baseline])).values()];
        if (!context) this._baselines_cache = { key, baselines: deduped };
        return deduped;
    }
    create_run_baseline(run_id: string, target_id: string) {
        const run = this.bench_execution().get_run(run_id);
        if (!run) return null;
        const baseline = build_assessment_baseline(run, target_id);
        save_execution_json(join(this.data_dir, 'assessment-baselines', randomUUID().replaceAll('-', '') + '.json'), baseline);
        this._baselines_cache = null;
        this._observations_cache = null;
        return baseline;
    }
    observations() {
        const execution = this.bench_execution(),
            sourceSig = assessment_source_signature(),
            context = create_assessment_source_context();
        const baselineRows = project_validated_baseline_observations(this.baselines(undefined, sourceSig));
        const runRows = execution.list_observations(context, sourceSig);
        return [...baselineRows, ...runRows];
    }
    cached_observations_payload(): { etag: string; body: string; gzip: Uint8Array<ArrayBuffer> | null } {
        const execution = this.bench_execution();
        const sourceSig = assessment_source_signature();
        const { signature: baselineSig } = this.baselines_signature();
        const key = `${sourceSig}\u0000${baselineSig}\u0000${execution.revision}`;
        if (this._observations_cache?.key === key) return this._observations_cache;
        const observations = this.observations();
        const observationsJson = JSON.stringify(observations);
        const etag = createHash('sha256').update(observationsJson).digest('hex').slice(0, 32);
        const body = `{"etag":${JSON.stringify(etag)},"observations":${observationsJson}}`;
        this._observations_cache = { key, etag, body, gzip: null };
        return this._observations_cache;
    }
    cached_banks_payload(): { body: string; gzip: Uint8Array<ArrayBuffer> | null } {
        const sourceSig = assessment_source_signature();
        if (this._banks_cache?.key === sourceSig) return this._banks_cache;
        const bank = load_assessment_bank(PRODUCTION_BANK_VERSION);
        const tasks = bank.tasks.map(task => Object.fromEntries(Object.entries(task).filter(([, value]) => typeof value !== 'function')));
        const body = JSON.stringify({
            execution_policy: 'sample-timeout-v1',
            banks: [
                {
                    id: 'assessment-' + bank.version,
                    version: bank.version,
                    production: true,
                    kind: 'assessment',
                    title: 'Mini Bench',
                    task_sha256: bank.task_sha256,
                    tasks,
                    scoring_policy: bank.scoring_policy
                }
            ]
        });
        this._banks_cache = { key: sourceSig, body, gzip: null };
        return this._banks_cache;
    }
    cached_tasks_payload(execution: BenchExecutionService): { body: string; gzip: Uint8Array<ArrayBuffer> | null } {
        if (execution.list_tasks !== BenchExecutionService.prototype.list_tasks)
            return { body: JSON.stringify({ tasks: execution.list_tasks() }), gzip: null };
        const revision = execution.revision;
        if (this._tasks_cache?.revision === revision) return this._tasks_cache;
        const body = execution.serialize_tasks_payload();
        this._tasks_cache = { revision, body, gzip: null };
        return this._tasks_cache;
    }
    cached_runs_payload(execution: BenchExecutionService): { body: string; gzip: Uint8Array<ArrayBuffer> | null } {
        if (execution.list_runs !== BenchExecutionService.prototype.list_runs)
            return { body: JSON.stringify({ runs: execution.list_runs() }), gzip: null };
        const revision = execution.revision;
        if (this._runs_cache?.revision === revision) return this._runs_cache;
        const body = execution.serialize_runs_payload();
        this._runs_cache = { revision, body, gzip: null };
        return this._runs_cache;
    }
}
function secureRequest(request: Request): boolean {
    const host = request.headers.get('host') ?? '';
    try {
        const parsed = new URL('http://' + host);
        if (
            !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
            parsed.username ||
            parsed.password ||
            parsed.pathname !== '/' ||
            parsed.search ||
            parsed.hash
        )
            return false;
        // URL parsing canonicalizes host spellings; allow only the original loopback spelling.
        if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) return false;
        const origin = request.headers.get('origin');
        if (origin && origin !== 'null') {
            const source = new URL(origin);
            if (
                !['http:', 'https:'].includes(source.protocol) ||
                source.username ||
                source.password ||
                source.pathname !== '/' ||
                source.search ||
                source.hash
            )
                return false;
            const authority = origin.match(/^https?:\/\/([^/]+)(?:\/)?$/)?.[1];
            if (authority !== host) return false;
        }
        return true;
    } catch {
        return false;
    }
}
async function requestBody(request: Request): Promise<JsonObject> {
    if (request.headers.has('transfer-encoding')) throw new TypeError('transfer encoding is not supported');
    const size = request.headers.get('content-length');
    if (size === null || !/^\d+$/.test(size) || Number(size) > MAX_BODY)
        throw new TypeError('request body exceeds size limit or is missing');
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
        throw new TypeError('content type must be application/json');
    let body: unknown;
    try {
        const bytes = await readBenchLimitedBody(request.body, MAX_BODY);
        if (bytes.length !== Number(size)) throw new TypeError('invalid body size');
        body = parseAssessmentJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
        throw new TypeError('invalid JSON body');
    }
    if (!object(body)) throw new TypeError('JSON body must be an object');
    return body;
}
/** JSON responses at least this large are gzip-encoded when the client accepts it. */
export const JSON_GZIP_MIN_BYTES = 2048;
/** Embeddable Bun fetch handler enforces token, Host, Origin, and strict request bodies. */
export function make_handler(service: BenchService, web_dir?: string): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
        const headers = new Headers({
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer'
        });
        if (request.headers.get('origin') === 'null') {
            headers.set('Access-Control-Allow-Origin', 'null');
            headers.set('Vary', 'Origin');
        }
        // Larger JSON bodies (observations, task/run lists polled every 2 s) compress roughly 10x.
        const acceptsGzip = /\bgzip\b/i.test(request.headers.get('accept-encoding') ?? '');
        const jsonCached = (status: number, cached: { body: string; gzip: Uint8Array<ArrayBuffer> | null }) => {
            if (!acceptsGzip || cached.body.length < JSON_GZIP_MIN_BYTES) return new Response(cached.body, { status, headers });
            if (!cached.gzip) cached.gzip = Bun.gzipSync(cached.body);
            headers.set('Content-Encoding', 'gzip');
            headers.append('Vary', 'Accept-Encoding');
            return new Response(cached.gzip, { status, headers });
        };
        const json = (status: number, value: unknown) => {
            const body = JSON.stringify(value);
            if (!acceptsGzip || body.length < JSON_GZIP_MIN_BYTES) return new Response(body, { status, headers });
            headers.set('Content-Encoding', 'gzip');
            headers.append('Vary', 'Accept-Encoding');
            return new Response(Bun.gzipSync(body), { status, headers });
        };
        if (!secureRequest(request)) return json(403, { error: 'loopback host and same-origin requests only' });
        if (request.method === 'OPTIONS') {
            if (request.headers.get('origin') !== 'null') return json(403, { error: 'origin not allowed' });
            headers.set('Access-Control-Allow-Methods', 'GET, POST');
            headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Mini-Bench-Token');
            return new Response(null, { status: 204, headers });
        }
        const path = new URL(request.url).pathname;
        if (path.startsWith('/api/')) {
            const actual = Buffer.from(request.headers.get('X-Mini-Bench-Token') ?? ''),
                expected = Buffer.from(service.token);
            if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
                return json(403, { error: 'invalid or missing bench token' });
        }
        try {
            if (path.startsWith('/api/bench/')) {
                if (request.method === 'GET' && path === '/api/bench/banks') return jsonCached(200, service.cached_banks_payload());
                if (request.method === 'GET' && path === '/api/bench/baselines') return json(200, { baselines: service.baselines() });
                if (request.method === 'GET' && path === '/api/bench/observations') {
                    // `known` lets a client that already holds this exact list skip the download.
                    const cached = service.cached_observations_payload();
                    if (new URL(request.url).searchParams.get('known') === cached.etag)
                        return json(200, { etag: cached.etag, unchanged: true });
                    return jsonCached(200, cached);
                }
                const execution = service.bench_execution();
                if (request.method === 'GET' && path === '/api/bench/quota-cards')
                    return json(200, await service.quota_cards(new URL(request.url).searchParams.get('refresh') === '1'));
                if (request.method === 'GET' && path === '/api/bench/routes') {
                    if (new URL(request.url).searchParams.get('refresh') === '1') service.adapter?.refresh();
                    return json(200, { routes: await execution.routes.public_routes() });
                }
                if (request.method === 'POST' && path === '/api/bench/task-plans')
                    return json(200, await execution.plan_task(await requestBody(request)));
                if (request.method === 'GET' && path === '/api/bench/tasks')
                    return jsonCached(200, service.cached_tasks_payload(execution));
                if (request.method === 'POST' && path === '/api/bench/tasks')
                    return json(202, { id: await execution.start_task(await requestBody(request)) });
                const taskMatch = path.match(/^\/api\/bench\/tasks\/([0-9a-f]{32})(\/cancel|\/retry)?$/);
                if (taskMatch) {
                    if (request.method === 'GET' && !taskMatch[2]) {
                        const task = execution.get_task(taskMatch[1]!);
                        return task ? json(200, task) : json(404, { error: 'task not found' });
                    }
                    if (request.method === 'POST' && taskMatch[2] === '/retry') {
                        const body = await requestBody(request);
                        if (Object.keys(body).length !== 1 || typeof body.request_id !== 'string')
                            throw new TypeError('retry request must contain only request_id');
                        return json(202, await execution.retry_task(taskMatch[1]!, body.request_id));
                    }
                    if (request.method === 'POST' && taskMatch[2] === '/cancel')
                        return execution.cancel_task(taskMatch[1]!) ? json(200, { ok: true }) : json(404, { error: 'task not found' });
                }
                if (request.method === 'POST' && path === '/api/bench/plans')
                    return json(200, await execution.plan(await requestBody(request)));
                if (request.method === 'GET' && path === '/api/bench/runs') return jsonCached(200, service.cached_runs_payload(execution));
                if (request.method === 'POST' && path === '/api/bench/runs')
                    return json(202, { id: await execution.start_run(await requestBody(request)) });
                const match = path.match(/^\/api\/bench\/runs\/([0-9a-f]{32})(\/cancel|\/retry|\/baseline|\/calls)?$/);
                if (match) {
                    const id = match[1]!;
                    if (request.method === 'GET' && match[2] === '/calls') {
                        const execution = service.bench_execution();
                        const exists =
                            execution.has_run(id) ||
                            (execution.get_run !== BenchExecutionService.prototype.get_run && Boolean(execution.get_run(id)));
                        if (!exists) return json(404, { error: 'run not found' });
                        return json(200, { calls: (await service.call_summaries(execution.data_dir).read(id)) ?? [] });
                    }
                    if (request.method === 'GET' && !match[2]) {
                        const run = execution.get_run(id);
                        return run ? json(200, run) : json(404, { error: 'run not found' });
                    }
                    if (request.method === 'POST' && match[2] === '/retry') {
                        const body = await requestBody(request);
                        if (
                            Object.keys(body).some(key => !['request_id', 'policy'].includes(key)) ||
                            typeof body.request_id !== 'string' ||
                            (body.policy !== undefined && body.policy !== 'sample-timeout-v1')
                        )
                            throw new TypeError('retry request requires request_id and an optional supported policy');
                        return json(202, {
                            id: await execution.retry_run(id, body.request_id, body.policy as 'sample-timeout-v1' | undefined)
                        });
                    }
                    if (request.method === 'POST' && match[2] === '/baseline') {
                        const body = await requestBody(request);
                        if (Object.keys(body).length !== 1 || typeof body.target_id !== 'string')
                            throw new TypeError('baseline request must contain only target_id');
                        const baseline = service.create_run_baseline(id, body.target_id);
                        return baseline ? json(201, { baseline }) : json(404, { error: 'run not found' });
                    }
                    if (request.method === 'POST' && match[2] === '/cancel')
                        return execution.cancel_run(id) ? json(200, { ok: true }) : json(404, { error: 'run not found' });
                }
                return json(404, { error: 'not found' });
            }
            if (request.method === 'GET' && path === '/api/models') return json(200, { models: await service.models() });
            if (request.method === 'GET' && web_dir && !path.startsWith('/api/')) {
                const root = realpathSync(web_dir);
                let candidate: string;
                try {
                    candidate = realpathSync(resolve(root, path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '')));
                } catch {
                    return json(404, { error: 'not found' });
                }
                const inside = relative(root, candidate);
                const extension = extname(candidate);
                const mime: Record<string, string> = {
                    '.html': 'text/html',
                    '.css': 'text/css',
                    '.js': 'text/javascript',
                    '.svg': 'image/svg+xml',
                    '.png': 'image/png',
                    '.ico': 'image/x-icon'
                };
                if (inside && !inside.startsWith('..') && !inside.startsWith('/') && extension in mime && lstatSync(candidate).isFile()) {
                    // Magpie's allow-scripts iframe has an opaque origin. Modules and SVG
                    // masks need the same narrowly scoped Origin:null CORS headers as the API.
                    headers.set('Content-Type', mime[extension] + '; charset=utf-8');
                    return new Response(readFileSync(candidate), { status: 200, headers });
                }
            }
            return json(404, { error: 'not found' });
        } catch (error) {
            if (error instanceof Error && 'code' in error) return json(500, { error: 'storage error' });
            if (error instanceof BenchUnavailableError || service._bench_execution?._closing)
                return json(503, {
                    error: 'execution service unavailable; inspect storage and restart before submitting again'
                });
            // Validation errors originate in local validators, not arbitrary upstream exceptions.
            if (error instanceof TypeError || error instanceof SyntaxError) return json(400, { error: error.message });
            return json(500, { error: 'assessment service error' });
        }
    };
}
/** Start the loopback server inside the current Bun host; stop drains admitted calls. */
export async function startMiniBenchService(
    options: MiniBenchOptions
): Promise<{ port: number; service: BenchService; stop: () => Promise<void> }> {
    const configuredPort = options.port === undefined ? process.env.MAGPIE_BENCH_PORT : undefined;
    if (configuredPort !== undefined && !/^\d+$/.test(configuredPort)) throw new TypeError('LLM Mini Bench port is outside safety bounds');
    const port = options.port ?? Number(configuredPort ?? 3481);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('LLM Mini Bench port is outside safety bounds');
    const service = new BenchService(options);
    let server: ReturnType<typeof Bun.serve>;
    try {
        server = Bun.serve({
            hostname: '127.0.0.1',
            port,
            maxRequestBodySize: MAX_BODY,
            idleTimeout: 180,
            fetch: make_handler(service, options.web_dir ?? join(PROJECT_ROOT, 'web')),
            error: () =>
                new Response(JSON.stringify({ error: 'invalid HTTP request' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
                })
        });
    } catch (error) {
        await service.close();
        throw error;
    }
    let stopping: Promise<void> | null = null;
    return {
        port: server.port!,
        service,
        stop: () => (stopping ??= Promise.all([service.close(), server.stop()]).then(() => {}))
    };
}
/** Standalone service remains import-safe for embedding by the Magpie adapter. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
    if (argv.includes('--help')) {
        console.log(
            'Usage: bun benchmark/backend/mini_bench.ts [--port PORT] [--data-dir PATH] [--web-dir PATH]\nRequires MAGPIE_BENCH_TOKEN (at least 32 characters).'
        );
        return;
    }
    const options: MiniBenchOptions = { token: process.env.MAGPIE_BENCH_TOKEN ?? '' };
    for (let index = 0; index < argv.length; index++) {
        const name = argv[index],
            value = argv[++index];
        if (!value) throw new TypeError('LLM Mini Bench option requires a value');
        if (name === '--port') {
            if (!/^\d+$/.test(value)) throw new TypeError('LLM Mini Bench port must be an integer');
            options.port = Number(value);
        } else if (name === '--data-dir') options.data_dir = value;
        else if (name === '--web-dir') options.web_dir = value;
        else throw new TypeError('LLM Mini Bench unknown option');
    }
    const server = await startMiniBenchService(options);
    console.log('LLM Mini Bench listening on http://127.0.0.1:' + server.port);
    const stop = () => {
        void server.stop().then(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
}
if (import.meta.main)
    main().catch(() => {
        console.error('LLM Mini Bench service failed to start; check local configuration');
        process.exitCode = 1;
    });
