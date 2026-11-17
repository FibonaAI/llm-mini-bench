/**
 * The single production bank served to the UI, used as the default for new tasks and plotted on
 * the analysis chart. Promote a validated bank by changing only this value (and its manifest
 * status); experimental banks stay explicit-only. Baseline promotion keeps its own 1.0 schema.
 */
export const PRODUCTION_BANK_VERSION = '1.0';
