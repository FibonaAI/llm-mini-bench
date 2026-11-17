import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { parseAssessmentJson, assessmentJsonNumberToken } from './assessment_json.ts';

/** Explicit USD per token prices; unknown usage is never zero. */
export interface AssessmentPricing { prompt: number; completion: number }
/** Catalog-declared provider identity is not proof of the provider or account that served a call. */
export interface BenchRouteMetadata {
    provider_id?: string;
    provider_evidence?: string;
    model_display_name?: string;
    /** One catalog route namespace below a remote instance, not a verified provider or account. */
    remote_route?: { namespace: string; evidence: string };
    /** Opaque adapter binding fingerprint; a changed binding invalidates a reviewed plan. */
    binding_ref?: string;
}
/** Public route catalogs never include endpoints, credential environment names or credentials. */
export interface BenchPublicRoute extends BenchRouteMetadata {
    id: string; label: string; account_ref: string; model: string;
    thinking_levels: string[]; pricing: AssessmentPricing; account_concurrency: number;
    account_evidence?: string;
}
/** Private resolved route, for service execution only; never persist this object. */
export interface BenchResolvedRoute extends BenchPublicRoute { base_url: string; api_key: string; api_key_env?: string }
interface ConfiguredRoute extends BenchPublicRoute { base_url: string; api_key_env: string }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** Bound route display text and forbid control characters. */
export function _route_text(value: unknown, maximum = 256): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value);
}
/** Require HTTPS or literal loopback HTTP without credentials, queries or fragments. */
export function _validate_route_url(value: unknown): value is string {
    if (!_route_text(value, 2048) || /[\s\\?#]/u.test(value)) return false;
    const match = /^(https?):\/\/([^/]+)(?:\/.*)?$/i.exec(value);
    if (!match) return false;
    const authority = match[2]!;
    if (/[@%]/.test(authority) || authority.endsWith(':')) return false;
    const parts = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::([0-9]+))?$/.exec(authority);
    if (!parts) return false;
    const rawHost = parts[1]!;
    const host = rawHost.startsWith('[') ? rawHost.slice(1, -1) : rawHost;
    if (parts[2] && !(Number(parts[2]) >= 1 && Number(parts[2]) <= 65535)) return false;
    if (host.endsWith('..')) return false;
    const ip = isIP(host);
    if (rawHost.startsWith('[') && ip !== 6) return false;
    if (!ip && (host.length > 253 || !host.replace(/\.$/, '').split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)))) return false;
    try {
        const parsed = new URL(value);
        // WHATWG URL parsing normalizes legacy numeric IPv4 forms; refuse these aliases.
        if (!ip && isIP(parsed.hostname)) return false;
        if (parsed.protocol === 'https:') return true;
        if (host.toLowerCase() === 'localhost' || host.toLowerCase() === 'localhost.') return true;
        if (ip === 4) return host.split('.')[0] === '127';
        if (ip === 6) {
            const normalized = parsed.hostname.toLowerCase();
            if (normalized === '[::1]') return true;
            const mapped = /^\[::ffff:([0-9a-f]+):[0-9a-f]+\]$/.exec(normalized);
            return !!mapped && (parseInt(mapped[1]!, 16) >>> 8) === 127;
        }
    } catch { return false; }
    return false;
}
/** Route files require numeric, finite nonnegative USD per token values. */
export function _route_price(value: unknown): number {
    if (typeof value !== 'number') throw new TypeError('Bench route pricing must use numeric USD per token, not strings or booleans');
    if (!Number.isFinite(value) || value < 0) throw new TypeError('Bench route pricing must be finite and nonnegative');
    return value;
}
/** Load explicit routes once, resolving current process credentials lazily. */
export class BenchRouteRegistry {
    private readonly routes = new Map<string, ConfiguredRoute>();
    constructor(path?: string | null) {
        if (path == null) return;
        let content: string;
        try { content = readFileSync(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        let configuration: unknown;
        try { configuration = parseAssessmentJson(content); } catch { throw new TypeError('Bench route configuration must be valid JSON with unique keys and finite constants'); }
        if (!record(configuration) || Object.keys(configuration).join(',') !== 'routes' || !Array.isArray(configuration.routes)) throw new TypeError('Bench route configuration must contain only a routes array');
        const required = ['id', 'label', 'account_ref', 'base_url', 'model', 'api_key_env', 'thinking_levels', 'pricing', 'account_concurrency'].sort().join(',');
        const accountLimits = new Map<string, number>();
        for (const [index, row] of configuration.routes.entries()) {
            const prefix = `Bench route configuration entry ${index}: `;
            if (!record(row) || Object.keys(row).sort().join(',') !== required) throw new TypeError(prefix + 'exact route fields are required; inline credentials are not allowed');
            if (!['id', 'label', 'account_ref', 'model'].every(key => _route_text(row[key]))) throw new TypeError(prefix + 'id, label, account_ref and model must be nonempty bounded text');
            if (this.routes.has(row.id as string)) throw new TypeError(prefix + 'duplicate route id');
            if (typeof row.api_key_env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.api_key_env)) throw new TypeError(prefix + 'api_key_env must name an environment variable, never contain a credential');
            if (!_validate_route_url(row.base_url)) throw new TypeError(prefix + 'base_url must be HTTPS or loopback HTTP without userinfo, query or fragment');
            const levels = row.thinking_levels;
            if (!Array.isArray(levels) || !levels.every(level => _route_text(level, 64) && !['default', 'mixed', 'unknown'].includes(level)) || new Set(levels).size !== levels.length) throw new TypeError(prefix + 'thinking_levels must be unique explicit efforts; default is implicit, mixed and unknown are reserved');
            if (!record(row.pricing) || Object.keys(row.pricing).sort().join(',') !== 'completion,prompt') throw new TypeError(prefix + 'pricing requires exactly prompt and completion USD per token');
            const pricing = { prompt: _route_price(row.pricing.prompt), completion: _route_price(row.pricing.completion) };
            const concurrency = row.account_concurrency;
            if (typeof concurrency !== 'number' || !Number.isSafeInteger(concurrency) || concurrency < 1 || /[.eE]/.test(assessmentJsonNumberToken(row, 'account_concurrency') ?? '')) throw new TypeError(prefix + 'account_concurrency must be a positive integer');
            const account = row.account_ref as string;
            if (accountLimits.has(account) && accountLimits.get(account) !== concurrency) throw new TypeError(prefix + 'routes for one account_ref must agree on account_concurrency');
            accountLimits.set(account, concurrency);
            this.routes.set(row.id as string, { id: row.id as string, label: row.label as string, account_ref: account, model: row.model as string, base_url: row.base_url, api_key_env: row.api_key_env, thinking_levels: [...levels] as string[], pricing, account_concurrency: concurrency });
        }
    }
    public_routes(): BenchPublicRoute[] {
        return [...this.routes.values()].map(({ base_url: _url, api_key_env: _env, ...row }) => structuredClone(row));
    }
    resolve(route_id: string): BenchResolvedRoute {
        const row = this.routes.get(route_id);
        if (!row) throw new TypeError('Bench route is not configured');
        const credential = process.env[row.api_key_env];
        if (!credential || /[\s\x00-\x1f\x7f]/u.test(credential)) throw new TypeError('Bench route credential is missing or invalid in the service environment');
        return { ...structuredClone(row), api_key: credential };
    }
}
