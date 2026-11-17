# Assessment Banks and Grading

[中文](ASSESSMENT_BANK.zh.md)

Assessment 1.0 is the only production/default 14-task bank. Its official manifest is `benchmark/banks/assessment-1.0.json`, and full task prompts are in `benchmark/banks/assessment-1.0.questions.json`. The page and execution service default to 1.0; every bank version and the standalone calibrator use the same manifest-driven loader and grading implementation.

Assessment 2.0 is an `experimental-unvalidated` calibration bank whose final 14-task candidate is dominated by adaptive hidden-DFA identification (11 DFA tasks plus three text-reasoning tasks). Its files are `benchmark/banks/assessment-2.0.json` and `assessment-2.0.questions.json`. Acceptance-only feedback cannot identify arbitrary hidden state names, so the named-state submissions do not define a valid identification objective. Retain the observations for design auditing, not as capability scores or evidence of achieving a target score.

Assessment 2.1 is a separate experimental candidate with 14 tasks: nine static reasoning, code, context and instruction tasks, three finite-candidate black-box identification tasks, and two document investigations. The black-box tasks cover causal experiments, exception semantics and scheduling policies; each has a decision tree proven to identify every candidate within its public probe budget. The document tasks cover tariff amendments and SLA arbitration. The static tasks include compiler guard synthesis with aliased memory and handled exceptions, temporal evidence withdrawal with restored superseded constraints, and finite-width ABA analysis of a 15-event concurrent stack program. The temporal answers are independently checked by permutation filtering and topological state search. The concurrency task asks seven structural possibility and tag-width questions, verified by two separate interpreters over every interleaving. Hidden named-state DFA identification is excluded because acceptance-only feedback cannot determine state names. The earlier DFA-heavy scores cannot establish general ability or achievement of a target score. Its files are `benchmark/banks/assessment-2.1.json` and `assessment-2.1.questions.json`. No experimental bank is a baseline, leaderboard, or replacement for 1.0.

All versions load a manifest `task_file` and exact `grading` descriptors through `src/assessment_bank.ts`; there are no version-specific loader branches. New data-defined tasks use shared exact-field grading with tagged fractions and closed aliases. Declarative `assessment-resource-v1` tasks add fixed in-memory resource networks with stocks, reserves, capacities, contamination, revisions and conflict feedback. `assessment-dfa-v1` adds hidden deterministic automata with bounded adaptive acceptance queries and exact transition-table submissions. Named built-in oracles preserve the original 1.0 grading and tool simulators. Model answers remain data and are never executed.

## Production 1.0 tasks

| ID | Domain | Coverage |
| --- | --- | --- |
| `K04_Genetic_Code` | Knowledge | Specified nonstandard genetic code tables |
| `K05_DNS_Negative_Cache` | Knowledge | RFC 2308 cache keys and TTL |
| `K06_Treaty_Exceptions` | Knowledge | Treaty validity, performance, and boundary exceptions |
| `R01_Stopping_Urn` | Reasoning | Latent-variable posteriors and expectations under a stopping rule |
| `R02_Causal_Counterfactual` | Reasoning | Observation, intervention, and counterfactuals |
| `R03_Parallel_Schedule` | Reasoning | Optimal resource-constrained scheduling and counting solutions |
| `C01_Finally_Aliasing` | Code semantics | `finally`, object aliasing, mutation, and rebinding |
| `C03_Optimistic_Transactions` | Code semantics | Saved read state, version validation, and write skew |
| `X02_Payment_Evidence` | Evidence synthesis | Payment deduplication, reversals, and effective times |
| `X03_Bitemporal_Revisions` | Evidence synthesis | Two time axes, whole-row revisions, and locating evidence |
| `I01_Coupled_Transform` | Instruction following | Filtering, sorting, joining, and checksums |
| `I02_Quoted_Instructions` | Instruction following | Boundaries between trusted instructions and quoted data |
| `T02_Inventory_Impossible` | Tool use | Identifying inventory infeasibility and avoiding invalid actions |
| `T03_Booking_Feedback` | Tool use | Recovering bookings from actual simulator conflict feedback |

Task IDs remain stable; do not rename them to make their numbering visually consecutive. Revision labels in prompts record implementation provenance, not additional selectable bank versions.

## Experimental 2.2 tasks

Assessment 2.2 contains ten frozen tasks: eight text tasks and two fixed-tool tasks. Select it explicitly with `--bank-version 2.2`. The manifest is `benchmark/banks/assessment-2.2.json`; full prompts, tools, documents and grading data are in `benchmark/banks/assessment-2.2.questions.json`. It uses the existing loader and graders without changing 1.0, 2.0 or 2.1 task bytes.

| ID | Coverage |
| --- | --- |
| `F_Marginal_Compatibility` | Global compatibility of binary marginals and sharp attainable bounds |
| `F_Private_Recommendations` | Private, blind and public information, obedience constraints and a secondary optimum |
| `F_Distributed_Guessing` | Local views, extremal covering and separate rule symmetries |
| `R22_Private_Information_Announcements` | Negative announcements, higher-order knowledge and a public-bit counterfactual |
| `CFinal_Aliased_Rotation_Fusion` | Aliased program equivalence, minimal guards and information loss |
| `CFinal_Erased_Token_Batching` | Ambiguous tokenization, shortest losses and an unbounded family |
| `CFinal_Snapshot_Serial_Witness` | Snapshot/serial equivalence, observed reads and minimal witness portfolios |
| `E_Final_Scoped_Release_Evidence` | Six-document investigation of authority, time, scope and conditional evidence transfer |
| `I_Final_Reconcile_Uncertain_Identity` | Authorized corrections, uncertain matching and bounds without following embedded requests |
| `T_Final_Reserve_Change_Dispatch` | Actual dispatch under changed reserves, conflict feedback and irreversible contamination |

Independent executable checks are in `benchmark/tests/assessment_2_2_*oracle*.test.ts`; mathematical and finite-state certificates are in `benchmark/tests/fixtures/assessment-2.2-*.md`. The token-batching family has an all-n argument, not just finite examples. Dispatch checks cover all four reserve-change combinations and multiple valid controllers, not a single preferred trace. Tests use Bun and fixed author-written computations; model-generated code is never executed.

Text and document tasks use equal-weight exact semantic fields. The dispatch task retains the resource grader: its content score includes physical goals, truthful reporting, inspection, conflict feedback and valid operations. Instruction and tool checks are also retained separately; its content score is not purely a final-answer metric.

A complete experimental calibration mean uses all ten tasks in every prespecified round, with equal task weights. Any missing, failed or ungradable sample leaves that whole-bank total null; partial observed means must be labeled and cannot replace it. Slow completion by some models is reported per model, not automatically treated as grounds to discard a task. Development-model observations are not held-out validation, proof of a target difficulty, or a leaderboard. The production analysis chart below still requires the exact 1.0 task IDs and does not plot 2.2 as a production comparison.

## Experimental 2.3 tasks

Assessment 2.3 contains twelve frozen tasks across all six domains (`knowledge`, `reasoning`, `code`, `context`, `instruction`, and `tool_use`, with two tasks per domain: nine text tasks and three fixed-tool tasks). Select it explicitly with `--bank-version 2.3`. The manifest is `benchmark/banks/assessment-2.3.json`, and full prompts, documents, ledgers, and grading data are in `benchmark/banks/assessment-2.3.questions.json`. Independent Bun oracles are in `benchmark/tests/assessment_2_3.test.ts` and `benchmark/tests/assessment_2_3_oracles.test.ts`. It uses the existing loader, exact-fields grader, and interactive document/blackbox/delegated-release simulators without altering `1.0`, `2.0`, `2.1`, or `2.2`.

## Grading rules

- `content_score` is a per-task semantic score from 0 to 1. Some tasks award partial credit across multiple semantic checks.
- `instruction_checks` separately records output format and instruction requirements. Correct content does not automatically mean every instruction was followed.
- Tool tasks run in isolated in-memory state and retain call traces, final state, tool checks, and outcomes. Invalid actions do not modify simulator state, but they affect the corresponding checks.
- Explicitly wrong answers and deliberate abstentions may score zero. Request failures, unparseable or ungradable results, and unfinished execution are not zero scores.
- Every planned round is retained; there is no best-of selection. The display mean below gives each task equal weight, without treating subquestions or repeated rounds as independent ability dimensions.

### Tool-submitted answers (`submit-answer-tool-v1`)

A task may declare `answer_protocol: "submit-answer-tool-v1"` and an `answer_schema` (a JSON Schema object naming the answer fields and value types, never values). The runner then adds a `submit_answer` tool whose parameters are that schema, plus fixed instructions, alongside any task tools. Visible text is never parsed for an answer:

- The agent runs until it ends its turn without a tool call. The arguments of its **last valid** `submit_answer` call are graded by the task's existing grader. Invalid arguments are returned to the model as a rejection, so it may resubmit.
- Ending without any submission is a valid zero (`outcome: "no_submission"`), even if the text contains a correct answer. Models that cannot call tools therefore score zero; there is no separate route capability gate.
- A timeout or upstream failure after a valid submission still grades that submission (`answer_submission.ended_after_submission`). Without a submission it remains an execution failure, never zero.
- `ambiguous` and `ungradable` cannot occur under this protocol.

The task fields participate in task snapshots and protocol hashes, so opting in requires a new bank version. Production 1.0 and existing experimental banks do not opt in. A free-form object schema was rejected after a live smoke test: several models wrapped the whole answer into one invented string argument.

Exceeding the turn, request, or token budget in a tool loop is recorded separately as an execution failure. All tasks use fixed graders, with no model judge and no execution of model-generated programs.

## Production 1.0 score-cost display

For a target with `R` planned rounds, the analysis chart uses `100 × sum(content_score) / (14 × R)` on the vertical axis and `estimated_cost_usd / R` on the horizontal axis. This is an equal-weight summary of saved content scores, not a new grader or a change to the Mini Bench bank protocol or hashes. Instruction and tool checks remain separate.

A point requires status `completed`, exactly the 14 canonical task IDs, and an integer `R` from 1 to 3. Each task must have exactly one completed sample for every round from 1 through `R`, with a finite content score in `[0, 1]`. Missing, duplicate, failed, or ungradable samples make the record ineligible; they are never filled with zero. Cost must be known, finite, and nonnegative, including tool continuation requests. Unknown cost stays `null`; an attempt that sent no request is a known zero. Zero cost is valid on a linear axis and hidden on a logarithmic axis. With complete scores but unknown-usage attempts, the display may plot a clearly badged known lower bound that is excluded from the frontier; it is never a complete total.

Records that cannot be plotted retain their per-task and raw details. Plot eligibility does not establish protocol comparability or eligibility for a new baseline. The chart does not infer anomalous models or accounts.

## Comparability

When comparing results, check the bank version, task snapshots, task source hashes, Thinking, and execution protocols. Output token limits, tool call limits, turn limits, and timeouts are also part of the sample protocol. Do not fill unknown historical parameters with current defaults.

The TypeScript implementation preserves the 1.0 task prompts, order, and task hash. Current manifests record eight shared TypeScript source hashes: the four original grader modules, shared strict JSON parser, shared data-grading adapter, declarative resource simulator, and hidden-DFA simulator. Banks using optional black-box, document, depot, push-only board, delegated-release or safe physical-control formats also pin their adapter and simulators in `extension_sha256`; calibration and service runs retain these source hashes alongside the shared sources. Data-defined expected answers participate in task hashes; named 1.0 descriptors do not alter its original task snapshots. Historical snapshots keep their original four-file Python grading source map. Offline replay can establish equivalent grades and simulator behavior for saved evidence; it does not make the source hashes equal or prove all historical runs comparable.

This is a small exploratory ability bank with limited coverage. A complete single-round run does not establish repeatability, and the current reference baseline does not establish model rankings.

## Standalone calibration

Run the commands below with Bun from the repository root.

The following command sends model requests and may incur charges. First confirm that the target model and Thinking level exist in the catalog, and set `MAGPIE_BENCH_BASE_URL` and `MAGPIE_BENCH_API_KEY`:

```sh
bun benchmark/calibrate_assessment.ts \
  --target 'YOUR_EXACT_MODEL_ID=high' \
  --output /tmp/assessment-1.0-run.jsonl \
  --rounds 1 --timeout 600
```

The default is the complete production 1.0 bank. Add `--bank-version 2.0`, `--bank-version 2.1`, `--bank-version 2.2` or `--bank-version 2.3` to select an experimental bank explicitly; experimental runs cannot be promoted to baselines. `--task-ids` selects a diagnostic subset only from the chosen bank; subset results cannot be promoted to complete baselines. Output must use a new file rather than overwrite existing results.

The standalone calibrator omits response token, request-count, and USD ceilings unless the corresponding options are supplied. Its default per-sample timeout is 600 seconds (accepted range 10-600). Samples run in a worker pool: a finished sample immediately frees its slot. `--max-api-retries 0..3` retries transient API failures within the sample deadline (default none). A transport timeout or missing-usage response fails only that sample and does not abort the remaining calibration. To view a calibration on the task and analysis pages, import it read-only with `benchmark/tools/import_calibration.ts`. Uncapped output uses a 32,768-token budget reservation estimate, never a response truncation limit; actual usage and estimated cost are still journaled.

Offline summarization sends no requests. Per-task `content_mean` includes only gradable answers; `failure_as_zero_mean` additionally counts failed or ungradable samples as zero for execution-level diagnosis without changing saved grades or chart eligibility.

```sh
bun benchmark/tools/analyze_assessment.ts /tmp/assessment-1.0-run.jsonl \
  --output /tmp/assessment-1.0-summary.json
```

For routine multi-model or multi-account runs, use the [execution service](BENCH_EXECUTION.md). It manages concurrency centrally and saves complete `run.json` files that can be validated and saved directly as baselines.
