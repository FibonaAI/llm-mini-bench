# Assessment Bank and Grading

[中文](ASSESSMENT_BANK.zh.md)

Assessment 1.0 is the production 12-task bank. Its official manifest is `benchmark/banks/assessment-1.0.json`, and full task prompts are in `benchmark/banks/assessment-1.0.questions.json`. The page, execution service, and standalone calibrator all use the same manifest-driven loader (`src/assessment_bank.ts`) and grading implementation.

Data-defined text tasks use shared exact-field grading (`assessment-exact-fields-v1`) with tagged fractions and closed aliases. Interactive tool tasks use fixed in-memory simulators bound through `src/assessment_interactive.ts` (`assessment-documents-v1`, `assessment-blackbox-v1`, and `assessment-delegated-release-v1`). Model answers remain data and are never executed.

## Production 1.0 tasks

| ID | Domain | Coverage |
| --- | --- | --- |
| `K23_HTTP_Conditional_Cache_Precedence` | Knowledge | RFC 9110/9111 conditional precedence, validator strength, and `304` freshness updates |
| `K23_IEEE754_ThreeValued_Semantics` | Knowledge | IEEE 754-2019 binary64 rounding/FMA/NaN rules and ISO SQL three-valued logic |
| `R23_InContext_Glyph_Morphism` | Reasoning | In-context algebraic morphism induction, dynamic chain reduction, and inverse synthesis |
| `R23_InContext_Conservation_Frames` | Reasoning | In-context conservation law discovery and multi-step lattice state/frustration tracking |
| `C23_Async_Generator_Finally_Override` | Code semantics | `async function*`, `yield*` delegation, `return()`/`throw()` in `finally`, and microtask ordering |
| `C23_MVCC_Savepoint_SSI` | Code semantics | MVCC snapshot visibility, `ROLLBACK TO SAVEPOINT` lock retention, and SSI safe snapshots |
| `X23_Subagent_MultiTrack_Reconciliation` | Evidence synthesis | Multi-track subagent audit reconciliation, worktree provenance, and quorum rules |
| `E23_Tight_Conditional_Audit` | Evidence synthesis | Tight-budget document investigation, field-level authority isolation, and conditional waivers |
| `I23_MultiAgent_DAG_Orchestration` | Instruction following | Multi-agent DAG scheduling, two-stage verifier sign-off, and resource contention |
| `I23_Polysemy_Contextual_Translation` | Instruction following | Contextual legal-historical polysemy disambiguation and reverse-decoy translation audit |
| `T23_Adaptive_Fault_Diagnosis` | Tool use | Two-probe adaptive minimax fault identification over nine candidate fault modes |
| `T23_Delegated_Authority_Release` | Tool use | Delegated authority chain verification, ancestor scope narrowing, and zero invalid actions |

Task IDs remain stable; do not rename them to make their numbering visually consecutive. Revision labels in prompts record implementation provenance, not additional selectable bank versions.

## Grading principles

- **Content score**: Each task reports `content_score` in `[0, 1]` as the fraction of its semantic checks passed. There is no inferred domain weighting.
- **Format and instruction separation**: `instruction_checks` are reported separately from `content_checks`.
- **Abstention and ungradable outputs**: Whole-answer abstentions (`"UNKNOWN"`, `"UNSURE"`, `"ABSTAIN"`, `"不知道"`) receive `content_score: 0` and `outcome: "abstained"`. Malformed or missing text outputs that cannot be graded remain `content_score: null`.
- **Tool-submitted answers (`submit-answer-tool-v1`)**: All twelve Assessment 1.0 tasks declare `answer_protocol: "submit-answer-tool-v1"` and an exact `answer_schema`. The runner injects a strict `submit_answer` function tool and grades the last valid `submit_answer` call's raw JSON arguments string, ignoring surrounding prose or earlier drafts. If a completed turn never calls `submit_answer` with a JSON object, it receives `content_score: 0` and `outcome: "no_submission"` with `instruction_checks.submitted_via_tool: false`. If an upstream error, timeout, or cap aborts a turn after a valid `submit_answer` call was already recorded, the runner grades that last submission, marks `status: "completed"`, and records `ended_after_submission`.

Exceeding the turn, request, or token budget in a tool loop is recorded separately as an execution failure. All tasks use fixed graders, with no model judge and no execution of model-generated programs.

## Score-cost display

For a target with `R` planned rounds, the analysis chart uses `100 × sum(content_score) / (12 × R)` on the vertical axis against one of three selectable horizontal axes: `estimated_cost_usd / R` (estimated USD per round), total input + output tokens divided by `R`, or `elapsed_seconds / R` (elapsed time per round). This is an equal-weight summary of saved content scores, not a new grader or a change to the Mini Bench bank protocol or hashes. Instruction and tool checks remain separate.

A point requires status `completed`, exactly the 12 canonical task IDs, and an integer `R` from 1 to 3. Each task must have exactly one finished sample for every round from 1 through `R`, with a finite content score in `[0, 1]`. Missing, duplicate, API-failed, or ungradable samples make the record ineligible; they are never filled with zero. Whole-sample timeouts (`SampleTimeout` / `status: "timeout"`) are scored `0` so the run can still complete while remaining explicitly retryable. The selected horizontal metric must be known, finite, and nonnegative, including tool continuation requests. Unknown cost stays `null`; an attempt that sent no request is a known zero. Zero-cost records plot on the left axis in both logarithmic and linear cost views without joining the Pareto frontier; zero usage on other axes stays valid on linear axes and hidden on logarithmic axes. With complete scores but unknown-usage attempts, the display may plot a clearly badged known lower bound (never presented as a complete total). Any plotted record with execution anomalies — sample timeouts, post-submission aborts (`ended_after_submission`), missing `submit_answer` calls (`no_submission`), or incomplete usage — carries an amber anomaly badge and is excluded from the Pareto frontier.

Records that cannot be plotted retain their per-task and raw details. Meeting the chart requirements does not make different protocols comparable or make a run eligible to save as a baseline (for example, runs with timed-out samples or incomplete usage cannot be saved as baselines). The chart flags only directly recorded execution anomalies; it never infers model or account anomalies.

## Comparability

When comparing results, check the bank version, task snapshots, task source hashes, Thinking, and execution protocol. Output token limits, tool call limits, turn limits, and timeouts are part of the sample protocol. Unknown historical settings must not be filled in with current defaults.

The manifest records the core TypeScript source hashes (`src/assessment_tasks.ts`, `src/assessment_json.ts`, and `src/assessment_data.ts`) plus the interactive simulator modules in `extension_sha256` (`src/assessment_interactive.ts`, `src/assessment_blackbox.ts`, `src/assessment_documents.ts`, and `src/assessment_delegated_release.ts`). Calibration and service runs retain the complete execution source closure. Data-defined expected answers and simulator configurations participate in the task hash (`d58ddb12…fed8`).

This is a small exploratory capability bank with limited coverage. A single completed round does not establish repeatability or a general model ranking.

## Standalone calibration

Run from the repository root with Bun.

The following command sends model requests and may incur charges. Confirm that the target and Thinking level exist in the model catalog, and set `MAGPIE_BENCH_BASE_URL` and `MAGPIE_BENCH_API_KEY` first:

```sh
bun benchmark/calibrate_assessment.ts \
  --target 'YOUR_EXACT_MODEL_ID=high' \
  --output /tmp/assessment-1.0-run.jsonl \
  --rounds 1 --timeout 600
```

It loads the complete Assessment 1.0 bank by default. `--task-ids` selects a diagnostic subset from the bank; subset results cannot be promoted to a complete baseline. Write to a new output file rather than overwriting existing results.

The standalone calibrator applies response-token, request-count, or USD caps only when the corresponding option is explicitly passed. The default per-sample timeout is 600 seconds (configurable from 10 to 600 seconds). Samples run through a worker pool so finishing one sample immediately starts the next. `--max-api-retries 0..3` retries transient API failures within the sample deadline (default 0). Transport timeouts or missing usage fail only the affected sample without aborting the rest of the run. To inspect calibration results on the task and analysis pages, import the JSONL read-only with `benchmark/tools/import_calibration.ts`.

Offline summaries make no requests. Per-task `content_mean` includes only gradable answers; `failure_as_zero_mean` treats failed or ungradable samples as zero for execution-level diagnostics without changing saved grades or chart eligibility:

```sh
bun benchmark/tools/analyze_assessment.ts /tmp/assessment-1.0-run.jsonl \
  --output /tmp/assessment-1.0-summary.json
```

For routine multi-model and multi-account runs, use the [execution service](BENCH_EXECUTION.md), which manages concurrency and saves a complete `run.json` that can be validated and saved as a baseline.
