# Mini Bench Baselines

[中文](README.zh.md)

This directory holds validated `assessment-baseline-v1` snapshots exported for offline reference. Each baseline preserves every planned round of all 12 Assessment 1.0 tasks, with per-task content scores, instruction checks, and tool checks. Partial task sets, failed runs, and ungradable samples cannot be filled in with zero scores or imported as baselines.

These files are offline reference evidence, not initial user data. The application starts personal workspaces empty and displays only runs and baselines saved under the configured data directory.

## Import a baseline

Run from the repository root:

```bash
bun benchmark/tools/import_assessment_baseline.ts /path/to/run.json \
  --target-id TARGET_ID --output-dir benchmark/baselines
```

The input must be a native Bench `run.json` whose target completed every Assessment 1.0 task and every planned round. The tool validates task snapshots, source hashes, per-sample protocols, and gradability, then writes a JSON file named by its content hash. It does not call models.
