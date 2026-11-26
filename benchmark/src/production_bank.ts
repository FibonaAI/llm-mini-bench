/**
 * Official released Mini Bench banks served side-by-side in the workspace.
 * Each bank retains its own manifest, grading descriptors, baselines, and analysis scope.
 */
export const RELEASED_BANK_VERSIONS = ['2.0', '1.0'] as const;
export type ReleasedBankVersion = (typeof RELEASED_BANK_VERSIONS)[number];

/** Default bank selected when opening the web workspace. */
export const DEFAULT_UI_BANK_VERSION: ReleasedBankVersion = '2.0';

/** Default bank when programmatic/CLI callers omit `bank_version`. */
export const PRODUCTION_BANK_VERSION: ReleasedBankVersion = '1.0';

export function is_released_bank_version(value: unknown): value is ReleasedBankVersion {
    return typeof value === 'string' && (RELEASED_BANK_VERSIONS as readonly string[]).includes(value);
}
