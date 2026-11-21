import { parseAssessmentJson } from '../benchmark/src/assessment_json.ts';
import { readBenchLimitedBody } from '../benchmark/src/bench_http_body.ts';
import { _validate_route_url } from '../benchmark/src/bench_routes.ts';
import type { BenchServiceAdapter } from '../benchmark/src/bench_adapter.ts';
import { MagpieBenchRoutes } from './magpie_routes.ts';
import { MagpieAccountsReader, type MagpieAccountBinding } from './magpie_accounts.ts';
import { MagpieQuotaCatalogReader } from './magpie_quotas.ts';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Own Magpie discovery, caching and transport; the benchmark consumes only normalized targets. */
export class MagpieBenchAdapter implements BenchServiceAdapter {
  readonly routes: MagpieBenchRoutes;
  readonly quotas = new MagpieQuotaCatalogReader(() => this.gateway('/magpie/quotas/cards'));
  private readonly accounts_catalog = new MagpieAccountsReader(() => this.gateway('/magpie/accounts'));
  _models_cache: JsonObject[] | null = null;
  _models_cache_time = 0;
  private models_inflight: Promise<JsonObject[]> | null = null;
  readonly base_url: string;
  constructor(
    base_url = process.env.MAGPIE_BENCH_BASE_URL ?? 'http://127.0.0.1:3425/v1',
    readonly api_key = process.env.MAGPIE_BENCH_API_KEY ?? 'magpie',
    concurrency = Number(process.env.MAGPIE_BENCH_CONCURRENCY ?? 18),
    accounts: MagpieAccountBinding[] = []
  ) {
    if (!_validate_route_url(base_url)) throw new TypeError('Magpie gateway endpoint is invalid');
    this.base_url = base_url.replace(/\/+$/, '');
    if (!this.base_url.endsWith('/v1')) this.base_url += '/v1';
    this.routes = new MagpieBenchRoutes(
      () => this.models(),
      this.base_url,
      () => this.api_key,
      concurrency,
      accounts,
      () => this.discover_local_accounts()
    );
  }
  private async discover_local_accounts(): Promise<MagpieAccountBinding[]> {
    const listed = await this.accounts_catalog.read();
    if (listed !== null) return listed;
    return this.quotas.readLocalAccounts().catch(() => [] as MagpieAccountBinding[]);
  }
  refresh(): void {
    this._models_cache_time = -Infinity;
    this.quotas.invalidate();
    this.accounts_catalog.invalidate();
  }
  async gateway(path: string, body?: JsonObject): Promise<JsonObject> {
    let response: Response;
    try {
      response = await fetch(this.base_url + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: 'Bearer ' + this.api_key,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // Magpie emits remote-hop evidence only for this catalog handshake.
          ...(path === '/models' && body === undefined ? { 'X-Magpie-Drawers': '1' } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(body === undefined ? 15000 : 120000)
      });
    } catch {
      throw new TypeError('gateway unavailable or timed out');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new TypeError('gateway HTTP error ' + response.status);
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBenchLimitedBody(response.body, 4 * 1024 * 1024);
    } catch {
      throw new TypeError('gateway response exceeds size limit or could not be read');
    }
    let value: unknown;
    try {
      value = parseAssessmentJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new TypeError('gateway returned invalid JSON');
    }
    if (!object(value)) throw new TypeError('gateway response must be an object');
    return value;
  }
  async models(): Promise<JsonObject[]> {
    if (this._models_cache !== null && performance.now() / 1000 - this._models_cache_time < 60) return structuredClone(this._models_cache);
    if (!this.models_inflight) {
      this.models_inflight = (async () => {
        const payload = await this.gateway('/models');
        const models = Object.hasOwn(payload, 'data') ? payload.data : payload.models;
        if (!Array.isArray(models)) throw new TypeError('gateway returned invalid models list');
        const filtered = models.filter(
          (entry): entry is JsonObject =>
            object(entry) && typeof entry.id === 'string' && (entry.kind === undefined || entry.kind === 'chat')
        );
        this._models_cache = structuredClone(filtered);
        this._models_cache_time = performance.now() / 1000;
        return filtered;
      })();
    }
    const pending = this.models_inflight;
    try {
      return structuredClone(await pending);
    } finally {
      if (this.models_inflight === pending) this.models_inflight = null;
    }
  }
}
