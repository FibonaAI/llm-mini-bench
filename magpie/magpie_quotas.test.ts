import { expect, test } from 'bun:test';
import { MagpieQuotaCatalogReader as BenchQuotaCatalogReader, normalize_quota_cards } from './magpie_quotas.ts';
const card = { provider: 'office/codex', user: 'test@example.invalid', readAt: '2026-11-11T00:00:00Z', windows: [{ name: '7 days', used: 23, resetsAt: '2026-11-12T00:00:00Z' }] };

test('quota cards whitelist fields, retain zero usage and distinguish missing user', () => {
    const cards = normalize_quota_cards({ data: [{ ...card, secret: 'never-public', balance: { key: 'secret' } }, { provider: 'office/relay', windows: [{ name: 'Daily', used: 0 }, { name: 'Unknown' }] }] });
    expect(cards[0]!.provider_path).toBe('office/codex');
    expect(cards[1]!.user).toBeNull();
    expect(cards[1]!.windows.map(w => w.used)).toEqual([0, null]);
    expect(JSON.stringify(cards)).not.toMatch(/secret|never-public|balance/);
    expect(normalize_quota_cards({ data: [{ provider: 'x//y' }, { provider: 'bad\npath' }] })).toEqual([]);
    expect(() => normalize_quota_cards({ models: [] })).toThrow('invalid');
});

test('quota cache coalesces, returns defensive copies, and refreshes without mutating upstream', async () => {
    let loads = 0;
    const reader = new BenchQuotaCatalogReader(async () => { loads++; return { data: [card] }; });
    const [a,b] = await Promise.all([reader.read(), reader.read()]);
    expect(loads).toBe(1); expect(a).toEqual(b); expect(a).not.toBe(b);
    a.cards[0]!.user = 'mutated';
    expect((await reader.read()).cards[0]!.user).toBe(card.user);
    await reader.read(true); expect(loads).toBe(2);
});

test('outage marks old quota data stale; denied access removes cached identities', async () => {
    let failure = '';
    const reader = new BenchQuotaCatalogReader(async () => { if (failure) throw new Error(failure); return { data: [card] }; });
    const initial = await reader.read();
    failure = 'private endpoint unreachable';
    const stale = await reader.read(true);
    expect(stale.status).toBe('stale'); expect(stale.fetched_at).toBe(initial.fetched_at); expect(stale.cards).toEqual(initial.cards);
    failure = 'gateway HTTP error 403';
    expect(await reader.read(true)).toEqual({ status:'forbidden', fetched_at:null, cards:[] });
    failure = 'offline'; expect((await reader.read(true)).status).toBe('unavailable');
    failure = ''; expect((await reader.read(true)).status).toBe('available');
});

test('empty quota list is available but is not proof of zero upstream accounts', async () => {
    const reader = new BenchQuotaCatalogReader(async () => ({ data: [] }));
    expect((await reader.read()).status).toBe('available');
    expect((await reader.read()).cards).toEqual([]);
});
