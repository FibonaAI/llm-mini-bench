import { GatewayClient } from '../benchmark/src/client.ts';
import { _route_text } from '../benchmark/src/bench_routes.ts';

/** Explicit local Magpie account binding, separate from read-only remote quota identities. */
export interface MagpieAccountBinding {
  provider_id: string;
  account: string;
  account_ref: string;
  models?: string[];
  disabled?: boolean;
}
/** Account bindings plus deduplicated full model metadata from `/v1/magpie/accounts?models=full`. */
export interface MagpieAccountsCatalog {
  accounts: MagpieAccountBinding[];
  models: Record<string, unknown>[];
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const DISCOVERED_MODEL_META_KEYS = [
  'id',
  'owned_by',
  'display_name',
  'kind',
  'pricing',
  'reasoning_levels',
  'supported_reasoning_levels',
  'magpie_via'
] as const;
function pickDiscoveredModelMetadata(raw: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of DISCOVERED_MODEL_META_KEYS) {
    const val = raw[key];
    if (val !== undefined) picked[key] = typeof val === 'object' && val !== null ? structuredClone(val) : val;
  }
  return picked;
}
const isChatKind = (kind: unknown): boolean => kind === undefined || kind === 'chat';
function mergeDiscoveredModelMetadata(existing: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const existingIsChat = isChatKind(existing.kind);
  const incomingIsChat = isChatKind(incoming.kind);
  // Chat entries take precedence over duplicate non-chat entries of the same ID, matching /v1/models.
  if (existingIsChat && !incomingIsChat) return existing;
  if (!existingIsChat && incomingIsChat) return incoming;
  const merged = { ...existing };
  for (const key of DISCOVERED_MODEL_META_KEYS) {
    if (merged[key] === undefined && incoming[key] !== undefined) merged[key] = incoming[key];
  }
  return merged;
}
const validAccountHeader = (account: string): boolean => {
  try {
    encodeURIComponent(account);
    return true;
  } catch {
    return false;
  }
};
const validAccountsList = (payload: unknown): payload is { data: unknown[] } =>
  object(payload) && Array.isArray(payload.data) && payload.data.length <= 2000;
/** Validate plugin configuration without accepting keys, endpoints or arbitrary HTTP headers. */
export function validateMagpieAccountBindings(value: unknown, cloneOutput = true): MagpieAccountBinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) throw new TypeError('Magpie account bindings must be a bounded array');
  const seen = new Set<string>();
  return value.map(row => {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      Object.keys(row).some(key => !['provider_id', 'account', 'account_ref', 'models', 'disabled'].includes(key)) ||
      !_route_text(row.provider_id) ||
      row.provider_id.includes('/') ||
      ['auto', 'group'].includes(row.provider_id) ||
      !_route_text(row.account) ||
      !_route_text(row.account_ref)
    )
      throw new TypeError('Magpie account binding requires a local provider, account and account_ref');
    if (row.disabled !== undefined && typeof row.disabled !== 'boolean')
      throw new TypeError('Magpie account binding disabled flag must be a boolean');
    if (!validAccountHeader(row.account)) throw new TypeError('Magpie account name must be valid Unicode');
    if (
      row.models !== undefined &&
      (!Array.isArray(row.models) ||
        row.models.length > 10000 ||
        row.models.some((model: unknown) => !_route_text(model)) ||
        new Set(row.models).size !== row.models.length)
    )
      throw new TypeError('Magpie account binding models must be unique exact request model IDs');
    const id = JSON.stringify([row.provider_id, row.account.toLowerCase()]);
    if (seen.has(id)) throw new TypeError('Magpie account binding is duplicated');
    seen.add(id);
    return cloneOutput ? structuredClone(row) : (row as MagpieAccountBinding);
  });
}
/**
 * Discover local pin-able accounts, API keys, and their full served model catalog from Magpie's
 * `/v1/magpie/accounts?models=full` list (v0.1.4621+ for accounts, v0.1.4794+ for string model IDs,
 * v0.1.4805+ for full `/v1/models`-shaped model metadata objects, v0.1.4862+ for pinning disabled
 * accounts/keys of enabled providers).
 * Each local entry of an enabled provider is pinned verbatim via its gateway-provided `pin`
 * (`<provider>/<id>`). Providers with no enabled local entries (e.g., whole provider switched off)
 * remain excluded because the gateway only plans enabled providers.
 */
export function discoverMagpieAccountCatalog(payload: unknown): MagpieAccountsCatalog {
  if (!validAccountsList(payload)) return { accounts: [], models: [] };
  type ParsedEntry = {
    provider_id: string;
    pin: string;
    id: string | null;
    label: string;
    disabled: boolean;
    rawModels?: unknown[];
  };
  const parsed: ParsedEntry[] = [];
  const enabledProviders = new Set<string>();
  const seenPins = new Set<string>();
  for (const row of payload.data) {
    if (!object(row)) continue;
    if (typeof row.on !== 'boolean') continue;
    if (row.from !== undefined && row.from !== null && row.from !== '') continue;
    if (row.gatewayKey !== undefined && row.gatewayKey !== null) continue;
    if (!_route_text(row.provider) || row.provider.includes('/') || ['auto', 'group'].includes(row.provider)) continue;
    if (!_route_text(row.pin) || !validAccountHeader(row.pin)) continue;
    const pinKey = JSON.stringify([row.provider, row.pin.toLowerCase()]);
    if (seenPins.has(pinKey)) continue;
    seenPins.add(pinKey);
    const id = _route_text(row.id) ? row.id : null;
    const label = _route_text(row.label) ? row.label : _route_text(row.user) ? row.user : (id ?? row.pin);
    if (row.on) enabledProviders.add(row.provider);
    parsed.push({
      provider_id: row.provider,
      pin: row.pin,
      id,
      label,
      disabled: !row.on,
      ...(Array.isArray(row.models) ? { rawModels: row.models } : {})
    });
  }
  const entries: { provider_id: string; pin: string; id: string | null; label: string; disabled: boolean; models?: string[] }[] = [];
  const labelCounts = new Map<string, number>();
  const modelsById = new Map<string, Record<string, unknown>>();
  for (const row of parsed) {
    if (row.disabled && !enabledProviders.has(row.provider_id)) continue;
    const labelKey = JSON.stringify([row.provider_id, row.label.toLowerCase()]);
    labelCounts.set(labelKey, (labelCounts.get(labelKey) ?? 0) + 1);
    let models: string[] | undefined;
    if (row.rawModels) {
      const seenModels = new Set<string>();
      const prefix = row.provider_id + '/';
      models = [];
      for (const rawModel of row.rawModels) {
        let fullModel: string | null = null;
        if (object(rawModel)) {
          if (!_route_text(rawModel.id) || !rawModel.id.startsWith(prefix) || !_route_text(rawModel.id.slice(prefix.length))) continue;
          const existing = modelsById.get(rawModel.id);
          if (!existing) {
            modelsById.set(rawModel.id, pickDiscoveredModelMetadata(rawModel));
          } else {
            const existingIsChat = isChatKind(existing.kind);
            const incomingIsChat = isChatKind(rawModel.kind);
            if (
              (!existingIsChat && incomingIsChat) ||
              (existingIsChat === incomingIsChat &&
                DISCOVERED_MODEL_META_KEYS.some(key => existing[key] === undefined && rawModel[key] !== undefined))
            ) {
              modelsById.set(rawModel.id, mergeDiscoveredModelMetadata(existing, pickDiscoveredModelMetadata(rawModel)));
            }
          }
          if (rawModel.kind !== undefined && rawModel.kind !== 'chat') continue;
          fullModel = rawModel.id;
        } else if (_route_text(rawModel)) {
          const candidate = prefix + rawModel;
          if (!_route_text(candidate)) continue;
          fullModel = candidate;
        }
        if (!fullModel || seenModels.has(fullModel)) continue;
        seenModels.add(fullModel);
        models.push(fullModel);
        if (models.length >= 10000) break;
      }
    }
    entries.push({
      provider_id: row.provider_id,
      pin: row.pin,
      id: row.id,
      label: row.label,
      disabled: row.disabled,
      ...(models !== undefined ? { models } : {})
    });
  }
  // Keep provider encounter order, with enabled accounts before disabled ones within each provider,
  // and prioritize enabled accounts if the 200-entry cap is reached.
  const providerOrder: string[] = [];
  const providerRank = new Map<string, number>();
  for (const entry of entries) {
    if (!providerRank.has(entry.provider_id)) {
      providerRank.set(entry.provider_id, providerOrder.length);
      providerOrder.push(entry.provider_id);
    }
  }
  const enabledEntries = entries.filter(entry => !entry.disabled);
  const disabledEntries = entries.filter(entry => entry.disabled);
  const seenRefs = new Set<string>();
  const resolved: MagpieAccountBinding[] = [];
  const claimRef = (provider_id: string, value: string | null): string | null => {
    if (!value || !_route_text(value) || value.toLowerCase() === 'gateway-default') return null;
    const refKey = JSON.stringify([provider_id, value.toLowerCase()]);
    if (seenRefs.has(refKey)) return null;
    seenRefs.add(refKey);
    return value;
  };
  for (const entry of [...enabledEntries, ...disabledEntries]) {
    const labelKey = JSON.stringify([entry.provider_id, entry.label.toLowerCase()]);
    const needsId = (labelCounts.get(labelKey) ?? 0) > 1 || entry.label.toLowerCase() === 'gateway-default' || /^•+$/u.test(entry.label);
    const preferred =
      needsId && entry.id && entry.id.toLowerCase() !== entry.label.toLowerCase() ? `${entry.label} (${entry.id})` : entry.label;
    const account_ref =
      claimRef(entry.provider_id, preferred) ?? claimRef(entry.provider_id, entry.id) ?? claimRef(entry.provider_id, entry.pin);
    if (!account_ref) continue;
    resolved.push({
      provider_id: entry.provider_id,
      account: entry.pin,
      account_ref,
      ...(entry.disabled ? { disabled: true } : {}),
      ...(entry.models !== undefined ? { models: entry.models } : {})
    });
    if (resolved.length >= 200) break;
  }
  const discovered = resolved.sort(
    (left, right) =>
      (providerRank.get(left.provider_id) ?? 0) - (providerRank.get(right.provider_id) ?? 0) ||
      Number(Boolean(left.disabled)) - Number(Boolean(right.disabled))
  );
  return { accounts: discovered, models: [...modelsById.values()] };
}
/** Discover local pin-able account bindings from `/v1/magpie/accounts`. */
export function discoverMagpieAccounts(payload: unknown): MagpieAccountBinding[] {
  return discoverMagpieAccountCatalog(payload).accounts;
}
/**
 * Fallback discovery from the receiving Magpie's quota cards for older gateways without
 * `/v1/magpie/accounts`. Remote cards (`from`, `gatewayKey`, multi-hop `via`, or `/` in
 * `provider`) are never converted into pins, and duplicate names within the same
 * provider/kind are skipped because `X-Magpie-Account` matches case-insensitively by name.
 */
export function discoverMagpieLocalAccounts(payload: unknown): MagpieAccountBinding[] {
  if (!validAccountsList(payload)) return [];
  const entries: { provider_id: string; account: string; kind: string }[] = [];
  const kindCounts = new Map<string, number>();
  for (const row of payload.data) {
    if (!object(row)) continue;
    if (row.from !== undefined && row.from !== null && row.from !== '') continue;
    if (row.gatewayKey !== undefined && row.gatewayKey !== null) continue;
    if (Array.isArray(row.via) && row.via.length > 1) continue;
    if (!_route_text(row.provider) || row.provider.includes('/') || ['auto', 'group'].includes(row.provider)) continue;
    if (!_route_text(row.user) || !validAccountHeader(row.user)) continue;
    const kind = typeof row.kind === 'string' ? row.kind : '';
    const key = JSON.stringify([row.provider, kind, row.user.toLowerCase()]);
    kindCounts.set(key, (kindCounts.get(key) ?? 0) + 1);
    entries.push({ provider_id: row.provider, account: row.user, kind });
  }
  const ambiguous = new Set<string>();
  for (const entry of entries) {
    const kindKey = JSON.stringify([entry.provider_id, entry.kind, entry.account.toLowerCase()]);
    if ((kindCounts.get(kindKey) ?? 0) > 1) ambiguous.add(JSON.stringify([entry.provider_id, entry.account.toLowerCase()]));
  }
  const seen = new Set<string>();
  const discovered: MagpieAccountBinding[] = [];
  for (const entry of entries) {
    const id = JSON.stringify([entry.provider_id, entry.account.toLowerCase()]);
    if (ambiguous.has(id) || seen.has(id)) continue;
    seen.add(id);
    discovered.push({
      provider_id: entry.provider_id,
      account: entry.account,
      account_ref: entry.account
    });
    if (discovered.length >= 200) break;
  }
  return discovered;
}
/** Cache read-only local account pins and per-account model metadata from Magpie's `/v1/magpie/accounts` endpoint. */
export class MagpieAccountsReader {
  private cached: MagpieAccountsCatalog | null = null;
  private expires = 0;
  private _generation = 0;
  private pending: Promise<MagpieAccountsCatalog | null> | null = null;
  constructor(private readonly load: () => Promise<unknown>) {}
  get generation(): number {
    return this._generation;
  }
  get isFresh(): boolean {
    return performance.now() < this.expires && this.cached !== null;
  }
  invalidate(): void {
    this.expires = 0;
    this._generation++;
  }
  async readReadonly(refresh = false): Promise<MagpieAccountsCatalog | null> {
    if (!refresh && performance.now() < this.expires) return this.cached;
    if (!this.pending) this.pending = this.fetch();
    const pending = this.pending;
    try {
      return await pending;
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }
  async read(refresh = false): Promise<MagpieAccountsCatalog | null> {
    const result = await this.readReadonly(refresh);
    return result === null ? null : structuredClone(result);
  }
  private async fetch(): Promise<MagpieAccountsCatalog | null> {
    try {
      const payload = await this.load();
      this.cached = validAccountsList(payload) ? discoverMagpieAccountCatalog(payload) : null;
    } catch (error) {
      const forbidden = error instanceof Error && /^gateway HTTP error (401|403)$/.test(error.message);
      this.cached = forbidden ? { accounts: [], models: [] } : null;
    }
    this.expires = performance.now() + 30000;
    this._generation++;
    return this.cached;
  }
}
/** The account header applies only at the receiving Magpie; that gateway must enforce the pin. */
export class MagpieAccountClient extends GatewayClient {
  private readonly account_header: string;
  constructor(base_url: string, api_key: string, account: string) {
    super(base_url, api_key);
    if (!_route_text(account) || !validAccountHeader(account)) throw new TypeError('Magpie account pin is invalid');
    this.account_header = encodeURIComponent(account);
  }
  override _headers(): Record<string, string> {
    return { ...super._headers(), 'X-Magpie-Account': this.account_header };
  }
}
