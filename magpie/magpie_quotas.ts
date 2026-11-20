import { _route_text } from '../benchmark/src/bench_routes.ts';
import type { BenchQuotaCard, BenchQuotaCatalog } from '../benchmark/src/bench_adapter.ts';
import { discoverMagpieLocalAccounts, type MagpieAccountBinding } from './magpie_accounts.ts';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown) => (_route_text(v) ? v : null);
const date = (v: unknown) => (typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);
/** Whitelist read-only quota fields; no keys, raw errors, links or mutation capabilities. */
export function normalize_quota_cards(payload: unknown): BenchQuotaCard[] {
  if (!object(payload) || !Array.isArray(payload.data) || payload.data.length > 2000) throw new TypeError('Bench quota catalog is invalid');
  return payload.data.flatMap((card): BenchQuotaCard[] => {
    if (!object(card) || !_route_text(card.provider, 1024) || card.provider.split('/').some(part => !_route_text(part))) return [];
    return [
      {
        provider_path: card.provider,
        user: text(card.user),
        alias: text(card.alias),
        read_at: date(card.readAt),
        windows: (Array.isArray(card.windows) ? card.windows.slice(0, 64) : []).flatMap(window =>
          object(window) && text(window.name)
            ? [
                {
                  name: text(window.name)!,
                  used: typeof window.used === 'number' && Number.isFinite(window.used) && window.used >= 0 ? window.used : null,
                  resets_at: date(window.resetsAt)
                }
              ]
            : []
        )
      }
    ];
  });
}
/** Cache only read-only quota GETs; an outage can retain explicitly stale display data. */
export class MagpieQuotaCatalogReader {
  private cached: BenchQuotaCatalog = { status: 'unavailable', fetched_at: null, cards: [] };
  private localAccounts: MagpieAccountBinding[] = [];
  private expires = 0;
  private pending: Promise<BenchQuotaCatalog> | null = null;
  constructor(private readonly load: () => Promise<unknown>) {}
  invalidate(): void {
    this.expires = 0;
  }
  async read(refresh = false): Promise<BenchQuotaCatalog> {
    if (!refresh && performance.now() < this.expires) return structuredClone(this.cached);
    if (!this.pending) this.pending = this.fetch();
    const pending = this.pending;
    try {
      return structuredClone(await pending);
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }
  async readLocalAccounts(refresh = false): Promise<MagpieAccountBinding[]> {
    await this.read(refresh);
    return structuredClone(this.localAccounts);
  }
  private async fetch(): Promise<BenchQuotaCatalog> {
    try {
      const payload = await this.load();
      const cards = normalize_quota_cards(payload);
      this.localAccounts = discoverMagpieLocalAccounts(payload);
      this.cached = { status: 'available', fetched_at: new Date().toISOString(), cards };
    } catch (error) {
      const forbidden = error instanceof Error && /^gateway HTTP error (401|403)$/.test(error.message);
      if (forbidden) this.localAccounts = [];
      this.cached = forbidden
        ? { status: 'forbidden', fetched_at: null, cards: [] }
        : { ...this.cached, status: this.cached.fetched_at ? 'stale' : 'unavailable' };
    }
    this.expires = performance.now() + 30000;
    return this.cached;
  }
}
