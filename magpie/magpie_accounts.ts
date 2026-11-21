import { GatewayClient } from '../benchmark/src/client.ts';
import { _route_text } from '../benchmark/src/bench_routes.ts';

/** Explicit local Magpie account binding, separate from read-only remote quota identities. */
export interface MagpieAccountBinding {
  provider_id: string;
  account: string;
  account_ref: string;
  models?: string[];
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
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
export function validateMagpieAccountBindings(value: unknown): MagpieAccountBinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) throw new TypeError('Magpie account bindings must be a bounded array');
  const seen = new Set<string>();
  return value.map(row => {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      Object.keys(row).some(key => !['provider_id', 'account', 'account_ref', 'models'].includes(key)) ||
      !_route_text(row.provider_id) ||
      row.provider_id.includes('/') ||
      ['auto', 'group'].includes(row.provider_id) ||
      !_route_text(row.account) ||
      !_route_text(row.account_ref)
    )
      throw new TypeError('Magpie account binding requires a local provider, account and account_ref');
    if (!validAccountHeader(row.account)) throw new TypeError('Magpie account name must be valid Unicode');
    if (
      row.models !== undefined &&
      (!Array.isArray(row.models) ||
        row.models.length > 1000 ||
        row.models.some((model: unknown) => !_route_text(model)) ||
        new Set(row.models).size !== row.models.length)
    )
      throw new TypeError('Magpie account binding models must be unique exact request model IDs');
    const id = JSON.stringify([row.provider_id, row.account.toLowerCase()]);
    if (seen.has(id)) throw new TypeError('Magpie account binding is duplicated');
    seen.add(id);
    return structuredClone(row);
  });
}
/**
 * Discover local pin-able accounts and API keys from Magpie's `/v1/magpie/accounts` list
 * (Magpie v0.1.4621+, identifier-only, including providers without quota cards).
 * Each enabled local entry is pinned verbatim via its gateway-provided `pin` (`<provider>/<id>`).
 */
export function discoverMagpieAccounts(payload: unknown): MagpieAccountBinding[] {
  if (!validAccountsList(payload)) return [];
  const entries: { provider_id: string; pin: string; id: string | null; label: string }[] = [];
  const seenPins = new Set<string>();
  const labelCounts = new Map<string, number>();
  for (const row of payload.data) {
    if (!object(row)) continue;
    if (row.on !== true) continue;
    if (row.from !== undefined && row.from !== null && row.from !== '') continue;
    if (row.gatewayKey !== undefined && row.gatewayKey !== null) continue;
    if (!_route_text(row.provider) || row.provider.includes('/') || ['auto', 'group'].includes(row.provider)) continue;
    if (!_route_text(row.pin) || !validAccountHeader(row.pin)) continue;
    const pinKey = JSON.stringify([row.provider, row.pin.toLowerCase()]);
    if (seenPins.has(pinKey)) continue;
    seenPins.add(pinKey);
    const id = _route_text(row.id) ? row.id : null;
    const label = _route_text(row.label) ? row.label : _route_text(row.user) ? row.user : (id ?? row.pin);
    const labelKey = JSON.stringify([row.provider, label.toLowerCase()]);
    labelCounts.set(labelKey, (labelCounts.get(labelKey) ?? 0) + 1);
    entries.push({ provider_id: row.provider, pin: row.pin, id, label });
  }
  const seenRefs = new Set<string>();
  const discovered: MagpieAccountBinding[] = [];
  const claimRef = (provider_id: string, value: string | null): string | null => {
    if (!value || !_route_text(value) || value.toLowerCase() === 'gateway-default') return null;
    const refKey = JSON.stringify([provider_id, value.toLowerCase()]);
    if (seenRefs.has(refKey)) return null;
    seenRefs.add(refKey);
    return value;
  };
  for (const entry of entries) {
    const labelKey = JSON.stringify([entry.provider_id, entry.label.toLowerCase()]);
    const needsId = (labelCounts.get(labelKey) ?? 0) > 1 || entry.label.toLowerCase() === 'gateway-default' || /^•+$/u.test(entry.label);
    const preferred =
      needsId && entry.id && entry.id.toLowerCase() !== entry.label.toLowerCase() ? `${entry.label} (${entry.id})` : entry.label;
    const account_ref =
      claimRef(entry.provider_id, preferred) ?? claimRef(entry.provider_id, entry.id) ?? claimRef(entry.provider_id, entry.pin);
    if (!account_ref) continue;
    discovered.push({
      provider_id: entry.provider_id,
      account: entry.pin,
      account_ref
    });
    if (discovered.length >= 200) break;
  }
  return discovered;
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
/** Cache read-only local account and API-key pins from Magpie's `/v1/magpie/accounts` endpoint. */
export class MagpieAccountsReader {
  private cached: MagpieAccountBinding[] | null = null;
  private expires = 0;
  private pending: Promise<MagpieAccountBinding[] | null> | null = null;
  constructor(private readonly load: () => Promise<unknown>) {}
  invalidate(): void {
    this.expires = 0;
  }
  async read(refresh = false): Promise<MagpieAccountBinding[] | null> {
    if (!refresh && performance.now() < this.expires) return this.cached === null ? null : structuredClone(this.cached);
    if (!this.pending) this.pending = this.fetch();
    const pending = this.pending;
    try {
      const result = await pending;
      return result === null ? null : structuredClone(result);
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }
  private async fetch(): Promise<MagpieAccountBinding[] | null> {
    try {
      const payload = await this.load();
      this.cached = validAccountsList(payload) ? discoverMagpieAccounts(payload) : null;
    } catch (error) {
      const forbidden = error instanceof Error && /^gateway HTTP error (401|403)$/.test(error.message);
      this.cached = forbidden ? [] : null;
    }
    this.expires = performance.now() + 30000;
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
