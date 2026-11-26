import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { GatewayClient } from '../benchmark/src/client.ts';
import type { ExecutionRoute } from '../benchmark/src/bench_execution.ts';
import {
  MagpieAccountClient,
  validateMagpieAccountBindings,
  type MagpieAccountBinding,
  type MagpieAccountsCatalog
} from './magpie_accounts.ts';
import {
  _route_price,
  _route_text,
  _validate_route_url,
  type AssessmentPricing,
  type BenchPublicRoute,
  type BenchResolvedRoute,
  type BenchRouteMetadata
} from '../benchmark/src/bench_routes.ts';
import { advertised_thinking_levels } from '../benchmark/src/run_protocol.ts';
import { calibration_price } from '../benchmark/src/assessment_response.ts';
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Local Magpie routing groups (`auto/...`, `group/...`) report `owned_by` as their primary upstream; keep them under their own routing group instead of mixing them into a direct provider channel. */
function local_routing_group(model_id: string): 'auto' | 'group' | undefined {
  const match = /^(auto|group)\/(.+)$/.exec(model_id);
  return match && _route_text(match[2]) ? (match[1] as 'auto' | 'group') : undefined;
}
/** Extract one remote namespace below a confirmed remote Magpie peer; never infer without magpie_via evidence. */
function remote_route_from_prefix(model_id: string, provider_id: string): BenchRouteMetadata['remote_route'] {
  if (!_route_text(model_id) || !_route_text(provider_id) || /^(?:group|auto)\//.test(model_id)) return undefined;
  const prefix = provider_id + '/';
  if (!model_id.startsWith(prefix)) return undefined;
  const remoteModel = model_id.slice(prefix.length),
    separator = remoteModel.indexOf('/');
  if (separator < 1) return undefined;
  const namespace = remoteModel.slice(0, separator),
    remainder = remoteModel.slice(separator + 1);
  if (!_route_text(namespace) || !_route_text(remainder)) return undefined;
  // Entry.ID is provider ID + '/' + listed model ID. Listed-as aliases can change the
  // latter, so expose one route namespace only; never retain random magpie_via IDs.
  return { namespace, evidence: 'magpie_via_catalog' };
}
/** Magpie v0.1.3078 viaOf also includes remote members of local groups; those are not remote entries. */
function remote_route_metadata(model: Record<string, unknown>): BenchRouteMetadata['remote_route'] {
  const via = model.magpie_via;
  if (!Array.isArray(via) || via.length < 2 || via.length > 9 || !via.every(hop => _route_text(hop, 128))) return undefined;
  if (!_route_text(model.id) || !_route_text(model.owned_by)) return undefined;
  return remote_route_from_prefix(model.id, model.owned_by);
}
/** Distinguish valid numeric pricing, absent pricing, and malformed/negative pricing. */
function parse_catalog_pricing(raw: unknown): { state: 'valid'; pricing: AssessmentPricing } | { state: 'missing' } | { state: 'invalid' } {
  if (raw === undefined) return { state: 'missing' };
  if (!record(raw)) return { state: 'invalid' };
  if (Object.keys(raw).length === 0) return { state: 'missing' };
  try {
    const parse = (value: unknown) => _route_price(typeof value === 'string' ? calibration_price(value) : value);
    return { state: 'valid', pricing: { prompt: parse(raw.prompt), completion: parse(raw.completion) } };
  } catch {
    return { state: 'invalid' };
  }
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
    private readonly discovered_accounts_loader: () =>
      MagpieAccountBinding[] | MagpieAccountsCatalog | Promise<MagpieAccountBinding[] | MagpieAccountsCatalog> = () => []
  ) {
    this.accounts = validateMagpieAccountBindings(accounts);
    if (!_validate_route_url(base_url)) throw new TypeError('Bench gateway must use HTTPS or loopback HTTP without URL credentials');
  }
  /** Coalesce reads; freshness belongs to the catalog loader, not a permanent route snapshot. */
  private async load_routes_shared(): Promise<BenchPublicRoute[]> {
    if (!this.loading) this.loading = this.load_catalog_routes();
    const loading = this.loading;
    try {
      return await loading;
    } finally {
      if (this.loading === loading) this.loading = null;
    }
  }
  async public_routes(): Promise<BenchPublicRoute[]> {
    return structuredClone(await this.load_routes_shared());
  }
  private merged_accounts(discovered: MagpieAccountBinding[]): BoundAccount[] {
    const manualAccounts = new Set<string>();
    const manualRefs = new Set<string>();
    const bareAccount = (provider_id: string, account: string) => {
      const lower = account.toLowerCase();
      const prefix = provider_id.toLowerCase();
      return lower.startsWith(prefix + '/') || lower.startsWith(prefix + '#') ? lower.slice(prefix.length + 1) : lower;
    };
    for (const binding of this.accounts) {
      manualAccounts.add(JSON.stringify([binding.provider_id, binding.account.toLowerCase()]));
      manualAccounts.add(JSON.stringify([binding.provider_id, bareAccount(binding.provider_id, binding.account)]));
      manualRefs.add(JSON.stringify([binding.provider_id, binding.account_ref.toLowerCase()]));
    }
    const merged: BoundAccount[] = this.accounts.map(binding => ({ ...binding, evidence: 'configured_binding' }));
    for (const binding of discovered) {
      const accountKey = JSON.stringify([binding.provider_id, binding.account.toLowerCase()]);
      const bareKey = JSON.stringify([binding.provider_id, bareAccount(binding.provider_id, binding.account)]);
      const refKey = JSON.stringify([binding.provider_id, binding.account_ref.toLowerCase()]);
      if (manualAccounts.has(accountKey) || manualAccounts.has(bareKey) || manualAccounts.has(refKey) || manualRefs.has(refKey)) continue;
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
    const rawAccounts = Array.isArray(discoveredRaw) ? discoveredRaw : discoveredRaw.accounts;
    const rawDiscoveredModels = Array.isArray(discoveredRaw) ? [] : discoveredRaw.models;
    let discovered: MagpieAccountBinding[] = [];
    try {
      discovered = validateMagpieAccountBindings(rawAccounts);
    } catch {
      discovered = [];
    }
    const bindings = this.merged_accounts(discovered);
    const discoveredModels = new Map<string, string>();
    for (const binding of discovered) {
      if (!binding.models) continue;
      for (const fullModel of binding.models) {
        if (fullModel.startsWith(binding.provider_id + '/') && !discoveredModels.has(fullModel)) {
          discoveredModels.set(fullModel, binding.provider_id);
        }
      }
    }
    const routes: BenchPublicRoute[] = [];
    const seen = new Set<string>();
    const nonChatCatalogIds = new Set<string>();
    const discoveredModelMeta = new Map<string, Record<string, unknown>>();
    for (const model of rawDiscoveredModels) {
      if (!record(model) || !_route_text(model.id)) continue;
      if (model.kind !== undefined && model.kind !== 'chat') {
        nonChatCatalogIds.add(model.id);
        continue;
      }
      if (!discoveredModelMeta.has(model.id)) discoveredModelMeta.set(model.id, model);
    }
    const providersWithRemote = new Set<string>();
    const providersWithDirect = new Set<string>();
    const nextActive = new Map<string, MagpieAccountBinding>();
    const appendRouteWithBindings = (baseRoute: BenchPublicRoute) => {
      routes.push(baseRoute);
      if (
        !baseRoute.provider_id ||
        baseRoute.remote_route ||
        (providersWithRemote.has(baseRoute.provider_id) && !providersWithDirect.has(baseRoute.provider_id)) ||
        ['auto', 'group'].includes(baseRoute.provider_id) ||
        !baseRoute.model.startsWith(baseRoute.provider_id + '/')
      )
        return;
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
    };
    for (const model of catalog) {
      if (!record(model) || !_route_text(model.id)) continue;
      if (model.kind !== undefined && model.kind !== 'chat') {
        nonChatCatalogIds.add(model.id);
        continue;
      }
      if (seen.has(model.id)) throw new TypeError('Bench gateway catalog contains duplicate model IDs');
      seen.add(model.id);
      const fallbackMeta = discoveredModelMeta.get(model.id);
      const remote_route = remote_route_metadata(model) ?? (fallbackMeta ? remote_route_metadata(fallbackMeta) : undefined);
      const provider_id = local_routing_group(model.id) ?? (_route_text(model.owned_by) ? model.owned_by : undefined);
      if (provider_id && !['auto', 'group'].includes(provider_id)) {
        if (remote_route) providersWithRemote.add(provider_id);
        else providersWithDirect.add(provider_id);
      }
      let parsedPricing = parse_catalog_pricing(model.pricing);
      if (parsedPricing.state === 'missing' && fallbackMeta) {
        parsedPricing = parse_catalog_pricing(fallbackMeta.pricing);
      }
      if (parsedPricing.state === 'invalid') continue;
      if (parsedPricing.state === 'missing' && !discoveredModels.has(model.id)) continue;
      const pricing = parsedPricing.state === 'valid' ? parsedPricing.pricing : null;
      const catalogThinking = advertised_thinking_levels(model).filter(level => _route_text(level, 64));
      const thinking_levels =
        catalogThinking.length > 0
          ? catalogThinking
          : fallbackMeta
            ? advertised_thinking_levels(fallbackMeta).filter(level => _route_text(level, 64))
            : [];
      const display_name = _route_text(model.display_name)
        ? model.display_name
        : fallbackMeta && _route_text(fallbackMeta.display_name)
          ? fallbackMeta.display_name
          : undefined;
      const baseRoute: BenchPublicRoute = {
        id: 'gateway-' + createHash('sha256').update(model.id).digest('hex').slice(0, 24),
        label: model.id,
        model: model.id,
        account_ref: 'gateway-default',
        account_evidence: 'gateway_binding',
        thinking_levels,
        pricing,
        account_concurrency: this.concurrency,
        ...(provider_id ? { provider_id, provider_evidence: 'gateway_catalog' as const } : {}),
        ...(display_name ? { model_display_name: display_name } : {}),
        ...(remote_route ? { remote_route } : {})
      };
      appendRouteWithBindings(baseRoute);
    }
    for (const [fullModel, provider_id] of discoveredModels) {
      if (seen.has(fullModel) || nonChatCatalogIds.has(fullModel)) continue;
      const meta = discoveredModelMeta.get(fullModel);
      const parsedPricing = meta ? parse_catalog_pricing(meta.pricing) : ({ state: 'missing' } as const);
      if (parsedPricing.state === 'invalid') continue;
      const pricing = parsedPricing.state === 'valid' ? parsedPricing.pricing : null;
      const thinking_levels = meta ? advertised_thinking_levels(meta).filter(level => _route_text(level, 64)) : [];
      const display_name = meta && _route_text(meta.display_name) ? meta.display_name : undefined;
      const isRemoteProvider = providersWithRemote.has(provider_id) && !providersWithDirect.has(provider_id);
      const remote_route =
        (meta ? remote_route_metadata(meta) : undefined) ??
        (isRemoteProvider ? remote_route_from_prefix(fullModel, provider_id) : undefined);
      const baseRoute: BenchPublicRoute = {
        id: 'gateway-' + createHash('sha256').update(fullModel).digest('hex').slice(0, 24),
        label: fullModel,
        model: fullModel,
        account_ref: 'gateway-default',
        account_evidence: 'gateway_binding',
        thinking_levels,
        pricing,
        account_concurrency: this.concurrency,
        provider_id,
        provider_evidence: 'gateway_accounts',
        ...(display_name ? { model_display_name: display_name } : {}),
        ...(remote_route ? { remote_route } : {})
      };
      appendRouteWithBindings(baseRoute);
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
  /** Resolve a batch of route IDs against one coalesced catalog read instead of rebuilding routes per target. */
  async resolve_many(route_ids: string[]): Promise<Map<string, BenchResolvedRoute>> {
    const unique = [...new Set(route_ids)];
    const routes = await this.load_routes_shared();
    const byId = new Map(routes.map(row => [row.id, row]));
    const matched: BenchPublicRoute[] = [];
    for (const route_id of unique) {
      const route = byId.get(route_id);
      if (!route) throw new TypeError('Bench gateway route is unavailable or has no valid pricing');
      matched.push(route);
    }
    const credential = this.credential_loader();
    if (typeof credential !== 'string' || !credential || /[\s\x00-\x1f\x7f]/u.test(credential))
      throw new TypeError('Bench gateway credential is missing or invalid');
    const resolved = new Map<string, BenchResolvedRoute>();
    for (const route of matched) {
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
      resolved.set(route.id, { ...structuredClone(route), base_url: this.base_url, api_key: credential });
    }
    return resolved;
  }
  /** Credentials are refreshed only on resolution and never appear in public catalog entries. */
  async resolve(route_id: string): Promise<BenchResolvedRoute> {
    return (await this.resolve_many([route_id])).get(route_id)!;
  }
}
