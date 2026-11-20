import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { GatewayClient } from '../benchmark/src/client.ts';
import type { ExecutionRoute } from '../benchmark/src/bench_execution.ts';
import { MagpieAccountClient, validateMagpieAccountBindings, type MagpieAccountBinding } from './magpie_accounts.ts';
import {
  _route_price,
  _route_text,
  _validate_route_url,
  type BenchPublicRoute,
  type BenchResolvedRoute,
  type BenchRouteMetadata
} from '../benchmark/src/bench_routes.ts';
import { advertised_thinking_levels } from '../benchmark/src/run_protocol.ts';
import { calibration_price } from '../benchmark/src/assessment_response.ts';
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Magpie v0.1.3078 viaOf also includes remote members of local groups; those are not remote entries. */
function remote_route_metadata(model: Record<string, unknown>): BenchRouteMetadata['remote_route'] {
  const via = model.magpie_via;
  if (!Array.isArray(via) || via.length < 2 || via.length > 9 || !via.every(hop => _route_text(hop, 128))) return undefined;
  if (!_route_text(model.id) || !_route_text(model.owned_by) || /^(?:group|auto)\//.test(model.id)) return undefined;
  const prefix = model.owned_by + '/';
  if (!model.id.startsWith(prefix)) return undefined;
  const remoteModel = model.id.slice(prefix.length),
    separator = remoteModel.indexOf('/');
  if (separator < 1) return undefined;
  const namespace = remoteModel.slice(0, separator),
    remainder = remoteModel.slice(separator + 1);
  if (!_route_text(namespace) || !_route_text(remainder)) return undefined;
  // Entry.ID is provider ID + '/' + listed model ID. Listed-as aliases can change the
  // latter, so expose one route namespace only; never retain random magpie_via IDs.
  return { namespace, evidence: 'magpie_via_catalog' };
}
type BoundAccount = MagpieAccountBinding & { evidence: 'configured_binding' | 'gateway_account_binding' };
/** Lazy gateway catalog adapter with one shared concurrency pool, not verified upstream accounts. */
export class MagpieBenchRoutes {
  private loading: Promise<BenchPublicRoute[]> | null = null;
  private readonly accounts: MagpieAccountBinding[];
  private readonly active_bindings = new Map<string, MagpieAccountBinding>();
  private readonly resolved_bindings = new Map<string, MagpieAccountBinding>();
  constructor(
    private readonly catalog_loader: () => unknown[] | Promise<unknown[]>,
    private readonly base_url: string,
    private readonly credential_loader: () => unknown,
    private readonly concurrency: number,
    accounts: MagpieAccountBinding[] = [],
    private readonly discovered_accounts_loader: () => MagpieAccountBinding[] | Promise<MagpieAccountBinding[]> = () => []
  ) {
    this.accounts = validateMagpieAccountBindings(accounts);
    if (!_validate_route_url(base_url)) throw new TypeError('Bench gateway must use HTTPS or loopback HTTP without URL credentials');
  }
  /** Coalesce reads; freshness belongs to the catalog loader, not a permanent route snapshot. */
  async public_routes(): Promise<BenchPublicRoute[]> {
    if (!this.loading) this.loading = this.load_catalog_routes();
    const loading = this.loading;
    try {
      return structuredClone(await loading);
    } finally {
      if (this.loading === loading) this.loading = null;
    }
  }
  private merged_accounts(discoveredRaw: unknown): BoundAccount[] {
    const manualAccounts = new Set(this.accounts.map(binding => JSON.stringify([binding.provider_id, binding.account.toLowerCase()])));
    const manualRefs = new Set(this.accounts.map(binding => JSON.stringify([binding.provider_id, binding.account_ref.toLowerCase()])));
    const merged: BoundAccount[] = this.accounts.map(binding => ({ ...binding, evidence: 'configured_binding' }));
    let discovered: MagpieAccountBinding[] = [];
    try {
      discovered = validateMagpieAccountBindings(discoveredRaw);
    } catch {
      discovered = [];
    }
    for (const binding of discovered) {
      const accountKey = JSON.stringify([binding.provider_id, binding.account.toLowerCase()]);
      const refKey = JSON.stringify([binding.provider_id, binding.account_ref.toLowerCase()]);
      if (manualAccounts.has(accountKey) || manualRefs.has(refKey)) continue;
      merged.push({ ...binding, evidence: 'gateway_account_binding' });
    }
    return merged;
  }
  private async load_catalog_routes(): Promise<BenchPublicRoute[]> {
    const [catalog, discoveredRaw] = await Promise.all([
      this.catalog_loader(),
      Promise.resolve()
        .then(() => this.discovered_accounts_loader())
        .catch(() => [] as MagpieAccountBinding[])
    ]);
    const bindings = this.merged_accounts(discoveredRaw);
    const routes: BenchPublicRoute[] = [];
    const seen = new Set<string>();
    const nextActive = new Map<string, MagpieAccountBinding>();
    for (const model of catalog) {
      if (!record(model) || !_route_text(model.id) || (model.kind !== undefined && model.kind !== 'chat')) continue;
      if (seen.has(model.id)) throw new TypeError('Bench gateway catalog contains duplicate model IDs');
      seen.add(model.id);
      if (!record(model.pricing)) continue;
      let pricing;
      try {
        const parse = (value: unknown) => _route_price(typeof value === 'string' ? calibration_price(value) : value);
        pricing = { prompt: parse(model.pricing.prompt), completion: parse(model.pricing.completion) };
      } catch {
        continue;
      }
      const remote_route = remote_route_metadata(model);
      const baseRoute: BenchPublicRoute = {
        id: 'gateway-' + createHash('sha256').update(model.id).digest('hex').slice(0, 24),
        label: model.id,
        model: model.id,
        account_ref: 'gateway-default',
        account_evidence: 'gateway_binding',
        thinking_levels: advertised_thinking_levels(model).filter(level => _route_text(level, 64)),
        pricing,
        account_concurrency: this.concurrency,
        ...(_route_text(model.owned_by) ? { provider_id: model.owned_by, provider_evidence: 'gateway_catalog' as const } : {}),
        ...(_route_text(model.display_name) ? { model_display_name: model.display_name } : {}),
        ...(remote_route ? { remote_route } : {})
      };
      routes.push(baseRoute);
      if (
        !baseRoute.provider_id ||
        baseRoute.remote_route ||
        ['auto', 'group'].includes(baseRoute.provider_id) ||
        !baseRoute.model.startsWith(baseRoute.provider_id + '/')
      )
        continue;
      for (const binding of bindings) {
        if (binding.provider_id !== baseRoute.provider_id || (binding.models && !binding.models.includes(baseRoute.model))) continue;
        const binding_ref = this.account_binding_ref(baseRoute.model, binding);
        nextActive.set(binding_ref, binding);
        routes.push({
          ...baseRoute,
          id: 'magpie-account-' + binding_ref.slice(0, 24),
          label: baseRoute.label + ' / ' + binding.account_ref,
          account_ref: binding.account_ref,
          account_evidence: binding.evidence,
          account_concurrency: 1,
          binding_ref
        });
      }
    }
    this.active_bindings.clear();
    for (const [ref, binding] of nextActive) this.active_bindings.set(ref, binding);
    return routes;
  }
  private account_binding_ref(model: string, binding: MagpieAccountBinding): string {
    return createHash('sha256')
      .update(JSON.stringify([this.base_url, model, binding.provider_id, binding.account, binding.account_ref]))
      .digest('hex');
  }
  /** Bind the private account selector to the exact immutable route resolved for this execution. */
  create_client(route: ExecutionRoute): GatewayClient {
    if (!route.binding_ref) return new GatewayClient(route.base_url, route.api_key);
    const binding =
      this.active_bindings.get(route.binding_ref) ??
      this.resolved_bindings.get(route.binding_ref) ??
      this.accounts.find(
        account => account.provider_id === route.provider_id && this.account_binding_ref(route.model, account) === route.binding_ref
      );
    if (!binding || binding.provider_id !== route.provider_id || this.account_binding_ref(route.model, binding) !== route.binding_ref)
      throw new TypeError('Magpie account binding is unavailable');
    return new MagpieAccountClient(route.base_url, route.api_key, binding.account);
  }
  /** Capture adapter source bytes beside generic execution sources without modifying the bank. */
  execution_sources(): Record<string, Uint8Array> {
    return Object.fromEntries(
      ['magpie_accounts.ts', 'magpie_routes.ts', 'magpie_adapter.ts', 'magpie_quotas.ts', 'magpie_service.ts'].map(name => [
        'adapter/' + name,
        readFileSync(new URL(name, import.meta.url))
      ])
    );
  }
  /** Credentials are refreshed only on resolution and never appear in public catalog entries. */
  async resolve(route_id: string): Promise<BenchResolvedRoute> {
    const route = (await this.public_routes()).find(row => row.id === route_id);
    if (!route) throw new TypeError('Bench gateway route is unavailable or has no valid pricing');
    if (route.binding_ref) {
      const binding = this.active_bindings.get(route.binding_ref);
      if (binding) {
        if (this.resolved_bindings.size >= 5000 && !this.resolved_bindings.has(route.binding_ref)) {
          const oldest = this.resolved_bindings.keys().next().value;
          if (oldest !== undefined) this.resolved_bindings.delete(oldest);
        }
        this.resolved_bindings.set(route.binding_ref, binding);
      }
    }
    const credential = this.credential_loader();
    if (typeof credential !== 'string' || !credential || /[\s\x00-\x1f\x7f]/u.test(credential))
      throw new TypeError('Bench gateway credential is missing or invalid');
    return { ...route, base_url: this.base_url, api_key: credential };
  }
}
