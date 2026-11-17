# Mini Bench Baselines

[中文](README.zh.md)

This directory contains only `assessment-baseline-v1` snapshots that pass completeness checks. Each baseline preserves every planned round of all 14 tasks, with per-task content scores and instruction checks. No bank-wide total or ability weights are calculated. Partial task sets, failed runs, and ungradable samples cannot be filled in with zero scores or imported as baselines.

These files are offline verification evidence, not initial user data. The application does not load this directory into personal workspaces; only baselines saved under the configured data directory are displayed.

The baseline snapshot, raw JSONL, and verification report are all stored in this directory. Historical path fields inside the raw record remain unchanged; resolve the current file location from the baseline snapshot’s `evidence.path`, relative to `benchmark/`. The bundled snapshot and raw JSONL retain their original bytes.

## Bundled observation

The only current reference is one complete round for `remote-magpie/openai/gpt-6-luna` with requested thinking `high`, collected on 2026-11-10. All 14 tasks completed and were gradable. This single observation is not a calibrated leaderboard and does not establish model ranking, repeatability, or broad ability.

Paths in saved source-hash maps are relative to the benchmark root, `benchmark/`. Raw evidence is retained in [`baselines/assessment-bank-1.0-smoke.jsonl`](assessment-bank-1.0-smoke.jsonl). Offline verification results are in [`baselines/assessment-baseline-verification.json`](assessment-baseline-verification.json). The TypeScript replay report distinguishes original Python provenance from current TypeScript source hashes and checks the saved request protocols, recomputed grades, and simulated tool calls offline. It records behavioral equivalence for this evidence, not source equality, and makes no new model calls.

[assessment-historical-provenance.json](assessment-historical-provenance.json) pins the exact bundled snapshot digest and its original Python provenance. The snapshot retains the original grading and execution program’s source hashes; it does not present historical execution as execution by the current program. This exception does not accept arbitrary historical personal baselines. The original record had no account binding: `account_ref` is `null` and `account_evidence` is `unrecorded`. Requested thinking does not independently verify which thinking setting the upstream actually used. Usage comes from saved responses. Cost is the sum of per-call estimates, not a bill.

## Import a new baseline

Run from the repository root:


```bash
bun benchmark/tools/import_assessment_baseline.ts /path/to/run.json \
  --target-id TARGET_ID --output-dir benchmark/baselines
```

The input must be a native Bench `run.json` whose target completed every Mini Bench task and every planned round. The tool validates task snapshots, source hashes, per-sample protocols, and gradability, then writes a JSON file named by its content hash. It does not call models or support old-bank reports.

The loader rejects old schemas, damaged files, and incompatible provenance. New baselines must match the current task and source evidence. The explicitly pinned bundled historical observation is checked against its original provenance. Historical personal runs remain visible, but incompatible runs cannot be promoted by replacing their source hashes. To recheck the bundled evidence:


```bash
bun benchmark/tools/replay_assessment_evidence.ts
```
