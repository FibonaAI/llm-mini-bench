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

## Import a baseline from a complete run


```sh
bun benchmark/tools/import_assessment_baseline.ts /path/to/assessment/RUN_ID/run.json \
  --target-id TARGET_ID --output-dir benchmark/baselines
```

The input must be a complete `run.json` saved by the execution service, not the calibrator's JSONL or an old baseline summary. The tool validates all 14 tasks in 1.0, every planned round, the bank hash, source code, and per-sample execution protocols. It accepts only completed, gradable results.

The output filename is generated from the content hash of the full snapshot. Importing the same evidence again does not overwrite different content. The bundled baseline directory is part of the project. Save personal baselines through the plugin page instead to avoid writing personal data into the project.

## Replay bundled historical evidence

```sh
bun benchmark/tools/replay_assessment_evidence.ts
```

This command verifies the registered snapshot and raw-file digests, then replays 19 saved responses, five simulator calls, and 14 grades with the current TypeScript implementation. It prints a report without making network requests or modifying the historical evidence. Use `--output NEW_FILE` to save a report to a new file. The report distinguishes historical Python source hashes from current TypeScript source hashes; matching results do not make those sources identical.

## Live evaluation entry points

`bun benchmark/bench.ts start` and `bun benchmark/calibrate_assessment.ts` send requests and may incur charges. They are not offline validation. See the [project home page](../../README.md) for routine use and the [execution guide](../../docs/BENCH_EXECUTION.md) for detailed budget and route configuration.
