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
    const id = JSON.stringify([row.provider_id, row.account]);
    if (seen.has(id)) throw new TypeError('Magpie account binding is duplicated');
    seen.add(id);
    return structuredClone(row);
  });
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
