import type { ExecutionRoutes } from './bench_execution.ts';

/** Read-only account visibility supplied by an adapter, never proof of execution binding. */
export interface BenchQuotaCard {
    provider_path: string;
    user: string | null;
    alias: string | null;
    read_at: string | null;
    windows: { name: string; used: number | null; resets_at: string | null }[];
}
/** Availability of display data is independent from executable targets. */
export interface BenchQuotaCatalog {
    status: 'available' | 'unavailable' | 'forbidden' | 'stale';
    fetched_at: string | null;
    cards: BenchQuotaCard[];
}
/** Host integrations supply normalized catalogs and transport without entering the scheduler. */
export interface BenchServiceAdapter {
    routes: ExecutionRoutes;
    models(): Promise<Record<string, unknown>[]>;
    refresh(): void;
    quotas?: { read(refresh?: boolean): Promise<BenchQuotaCatalog> };
}
