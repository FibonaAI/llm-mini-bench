# Mini Bench Utilities

[中文](README.zh.md)

Run these Bun commands from the repository root. Relative input and output paths resolve from the current working directory; use absolute paths for files elsewhere. These utilities process saved local data only; they do not call models.

## Summarize calibration records


```sh
bun benchmark/tools/analyze_assessment.ts INPUT.jsonl --output SUMMARY.json
```

The input is JSONL produced by `benchmark/calibrate_assessment.ts`. The output preserves each target, each task, and every repeated round, recording content scores, instruction checks, and execution failures separately. It does not generate bank-wide weights or automatic rankings. The output file must not already exist.

## Report exception-aware completion scores

```sh
bun benchmark/tools/report_assessment_completion.ts \
  --input INPUT.jsonl --output COMPLETION.json
```

This supplemental metric keeps completed finite grades, counts explicit task failures and ambiguous/ungradable final submissions as zero, and excludes API, transport and other infrastructure exceptions. For each model/Thinking target, exceptions may occupy at most 30% of all planned task-round samples. Exactly 3 of 10 or 6 of 20 is acceptable; a higher fraction produces `assessment_valid: false` and `score_percent: null`. The score is the sum of included grades divided by the number of included samples, multiplied by 100. Always report the exception count alongside the score: excluding exceptions can bias comparisons.

An old `SampleTimeout` or `TimeoutError` alone is an unattributed timeout exception, not evidence of a computational failure. Stream activity also does not establish the cause. The pure scoring API accepts separately verified computation-deadline evidence. It also accepts a reviewed task-deadline finding when raw evidence shows substantive reasoning or answer output continuing until a recorded local sample timeout, without claiming continuous upstream compute time. Neither the current runner nor this CLI infers these findings from event counts, heartbeats or timing alone.

Missing, duplicate or unexpected samples are rejected. Repeated `--input` flags may combine distinct targets only when bank content, source hashes, configuration and round plans match. The report records input and report-source digests, does not replay graders itself, and refuses to overwrite a file. It leaves raw records, production chart eligibility and baseline rules unchanged.

## Archive journals of finished runs

```sh
bun benchmark/tools/compress_journals.ts [--data-dir DIR] [--dry-run] [--decompress]
```

Losslessly gzips `journal.jsonl` of every terminal run and retry generation in the personal workspace; queued, running and cancelling runs are skipped. Each archive is decompressed and compared by SHA-256 with the original before the plain file is removed, and `journal.archive.json` records the original size and digest. Interrupted runs of the tool resume safely, and a plain file that no longer matches its recorded digest is kept and reported. The service reads `journal.jsonl.gz` transparently (failure diagnosis, manual retries). `--decompress` restores the exact original bytes and verifies them. Raw SSE journals typically compress about 14x.

## Migrate a legacy file workspace into SQLite

```sh
bun benchmark/tools/migrate_legacy_storage.ts [--data-dir DIR] [--dry-run] [--cleanup]
```

Migrates legacy file-per-run workspaces (`<data-dir>/assessment/` and `<data-dir>/assessment-baselines/`) into `<data-dir>/mini-bench.sqlite`. The Mini Bench service also performs this migration and cleanup automatically on startup once it claims its port. Preserves all runs, tasks, samples, immutable attempt histories, compact Pi Session-style events (calls, tool results, retries, grades), and baselines while discarding raw SSE stream chunks, duplicated `source/*.ts` copies, `run-before.json` archives, and `.run-index-cache.json`. Pass `--cleanup` to delete verified legacy entries, derived cache/temp files, and newly empty legacy directories after WAL checkpointing; corrupted or unreadable items and unrelated files are preserved untouched, and re-running is idempotent.

## Show a calibration in the workspace

```sh
bun benchmark/tools/import_calibration.ts --input INPUT.jsonl [--data-dir DIR]
```

Converts one `benchmark/calibrate_assessment.ts` journal into a read-only run directly inside `mini-bench.sqlite` (default `MAGPIE_BENCH_DATA_DIR` or `~/.local/share/magpie-mini-bench`), so the task page and analysis page can show its matrix, failure causes and scores. Structured session events are stored without copying raw SSE streams, and the input digest is recorded; importing the same file again does nothing. Imported runs are labeled as calibration imports, have no route identity, can never be retried and can never be promoted to baselines. Experimental banks stay off the production chart. Reload the plugin (or restart the service) afterwards, because runs are loaded at startup.

## Import a baseline from a complete run

```sh
bun benchmark/tools/import_assessment_baseline.ts --run-id RUN_ID [--data-dir DIR] \
  --target-id TARGET_ID --output-dir benchmark/baselines
```

Or pass a standalone exported run JSON file instead of `--run-id`. The tool validates all 12 tasks in Assessment 1.0, every planned round, the bank hash, source code, and per-sample execution protocols. It accepts only completed, gradable results.

The output filename is generated from the content hash of the full snapshot. Importing the same evidence again does not overwrite different content. Save personal baselines through the plugin page instead to avoid writing personal data into the project.

## Live evaluation entry points

`bun benchmark/bench.ts start` and `bun benchmark/calibrate_assessment.ts` send requests and may incur charges. They are not offline validation. See the [project home page](../../README.md) for routine use and the [execution guide](../../docs/BENCH_EXECUTION.md) for detailed budget and route configuration.
