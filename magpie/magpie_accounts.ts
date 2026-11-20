import { GatewayClient } from '../benchmark/src/client.ts';
import { _route_text } from '../benchmark/src/bench_routes.ts';

/** Explicit local Magpie account binding, separate from read-only remote quota identities. */
export interface MagpieAccountBinding {
  provider_id: string;
  account: string;
  account_ref: string;
  models?: string[];
}
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
    try {
      encodeURIComponent(row.account);
    } catch {
      throw new TypeError('Magpie account name must be valid Unicode');
    }
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
 * Discover local pin-able account bindings from the receiving Magpie's quota cards.
 * Remote cards (`from`, `gatewayKey`, multi-hop `via`, or `/` in `provider`) are never
 * converted into pins, and duplicate names within the same provider/kind are skipped
 * because `X-Magpie-Account` matches case-insensitively by account/key name.
 */
export function discoverMagpieLocalAccounts(payload: unknown): MagpieAccountBinding[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length > 2000) return [];
  const entries: { provider_id: string; account: string; kind: string }[] = [];
  const kindCounts = new Map<string, number>();
  for (const row of data) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const card = row as Record<string, unknown>;
    if (card.from !== undefined && card.from !== null && card.from !== '') continue;
    if (card.gatewayKey !== undefined && card.gatewayKey !== null) continue;
    if (Array.isArray(card.via) && card.via.length > 1) continue;
    if (!_route_text(card.provider) || card.provider.includes('/') || ['auto', 'group'].includes(card.provider)) continue;
    if (!_route_text(card.user)) continue;
    try {
      encodeURIComponent(card.user);
    } catch {
      continue;
    }
    const kind = typeof card.kind === 'string' ? card.kind : '';
    const key = JSON.stringify([card.provider, kind, card.user.toLowerCase()]);
    kindCounts.set(key, (kindCounts.get(key) ?? 0) + 1);
    entries.push({ provider_id: card.provider, account: card.user, kind });
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
/** The account header applies only at the receiving Magpie; that gateway must enforce the pin. */
export class MagpieAccountClient extends GatewayClient {
  private readonly account_header: string;
  constructor(base_url: string, api_key: string, account: string) {
    super(base_url, api_key);
    if (!_route_text(account)) throw new TypeError('Magpie account pin is invalid');
    try {
      this.account_header = encodeURIComponent(account);
    } catch {
      throw new TypeError('Magpie account pin is invalid');
    }
  }
  override _headers(): Record<string, string> {
    return { ...super._headers(), 'X-Magpie-Account': this.account_header };
  }
}
