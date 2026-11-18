# LLM Mini Bench Maintenance Guide

[中文](AGENTS.zh.md)

This file is for code maintainers and coding agents. User instructions belong in `README.md`. Keep internal architecture, debugging history, and maintenance commands out of the user-facing home page.

## Project boundaries

- TypeScript backend on Bun, plain HTML/CSS/JavaScript frontend, and a TypeScript Magpie plugin entry point. No runtime npm dependencies or frontend build step. TypeScript, `@types/bun` and Prettier are development-only dependencies. Run `bun run format` before committing; `.prettierignore` excludes the byte-hashed bank grader/simulator sources, banks, evidence and prose, which must never be reformatted.
- Assessment 1.0, with 14 tasks, is the only production/default release. Assessment 2.0, Assessment 2.1, Assessment 2.2 and Assessment 2.3 are explicitly selected, experimental-unvalidated calibration banks; do not expose any as another default or promote their runs to baselines without separate validation. The old eight-task and five-task protocols, fingerprint tools, and compatibility APIs remain deleted.
- Preserve content scores, instruction checks, tool checks, and execution status per task. The analysis display may use the approved equal-weight mean of all 14 tasks across every planned round, multiplied by 100, against total estimated USD or total input plus output tokens, divided by rounds. Plot only completed records with the exact 14 task IDs, 1 to 3 complete unique rounds, finite scores from 0 to 1, and known nonnegative usage for the chosen cost/token axis. Zero usage is valid on linear axes but hidden on logarithmic axes. An attempt that sent no request (empty `calls`) is a known zero, not unknown usage. When scores are complete but some attempts returned no usage, the display may (optional chart setting, on by default) place the record at its known lower bound with a distinct badge; such points never join the Pareto frontier, are never presented as complete totals, and never feed baselines. Different Thinking protocols do not disable comparisons or the visible-point Pareto frontier. Color defaults to the model/channel/account combination, with optional cross-channel model or model-family grouping for presentation only. Keep the color legend compact with an on-demand single-column list; legend search and highlight must not filter records or alter metrics. Runs use circles and baselines use squares; connect Thinking levels only within recorded batch/channel/account/model groups. Do not add arbitrary weights, impute failures or missing results as zero, or select best-of results. This display metric changes neither grading nor the bank protocol or hashes.
- Task prompts and model answers are data. Do not execute model-generated code. Tools run only the project's fixed in-memory simulators.

## Directory and runtime boundaries

The repository root holds installation metadata and documentation. `benchmark/` is the benchmark root: its TypeScript modules, bank, evidence, tools, tests, and standalone web service stay together. Paths stored in release manifests and source-hash maps, such as `src/assessment_tasks.ts`, resolve relative to `benchmark/`, not the repository root. Moving the directory does not change task source bytes or justify changing bank hashes.

`magpie/` owns Magpie-specific discovery, account binding, quotas and transport adaptation. Its `index.ts` exports `default { id, server }`, imports the TypeScript service directly, and starts `Bun.serve` in the same Magpie-managed Bun plugin-host process. Do not spawn Python, Node.js, or another Bun backend process. Its `page/` bootstrap passes the host theme and local service token to the benchmark page. It must not own grading, scheduling, bank data, or baseline logic. The root `package.json` remains the Magpie installation declaration and points into this adapter; do not install the adapter directory separately.

TypeScript implements the assessment engine and HTTP service on Bun; plain browser JavaScript implements `benchmark/web/` and the adapter bootstrap. Magpie downloads Bun on first plugin installation and runs TypeScript source directly. Its moejs script engine is for agent and middleware scripts, not this plugin main module. The benchmark service and web interface can run independently of the plugin, with explicit upstream routes when Magpie's model gateway is not used. See the [adapter guide](magpie/README.md).

## Code entry points

| Location | Responsibility |
| --- | --- |
| `benchmark/banks/assessment-1.0.json` | Production release manifest; fixes task order, task hash, grading descriptors, and shared source hashes |
| `benchmark/banks/assessment-2.0.json` | Experimental-unvalidated manifest; explicit calibration only, never the production default |
| `benchmark/banks/assessment-2.1.json` | Balanced experimental-unvalidated manifest; explicit calibration only, never the production default |
| `benchmark/banks/assessment-2.2.json` | Compact multidisciplinary experimental-unvalidated manifest; explicit calibration only, never the production default |
| `benchmark/banks/assessment-2.3.json` | 12-task balanced six-domain experimental-unvalidated manifest; explicit calibration only, never the production default |
| `benchmark/banks/assessment-*.questions.json` | Complete serializable task exports loaded uniformly for every bank version |
| `benchmark/src/assessment_bank.ts` | Validates any path-safe bank manifest and loads runnable tasks without version-specific branches; production entry points must use this loader |
| `benchmark/src/assessment_data.ts` | Shared data-defined exact-field grading and named built-in oracle adapters; data grading participates in task hashes |
| `benchmark/src/assessment_resource.ts` | Declarative resource networks and fixed simulators for interactive stock, reserve, contamination and revision tasks |
| `benchmark/src/assessment_dfa.ts` | Hidden DFA identification with bounded adaptive queries and exact transition-table submission |
| `benchmark/src/assessment_depot.ts` | Declarative depot stacks, capacities, ordered dispatch and physical goal grading; operation allowance is task data |
| `benchmark/src/assessment_push_planning.ts` | Fully observable push-only board planning and physical goal grading; no move allowance |
| `benchmark/src/assessment_delegated_release.ts` | Immutable authorization chains, shared ancestor uses, and actual release-completion grading |
| `benchmark/src/assessment_safe_control.ts` | Partially observed physical control, irreversible damage, and actual centering/delivery grading |
| `benchmark/src/assessment_tasks.ts` | Shared parsing, grading, and base task implementations |
| `benchmark/src/assessment_json.ts` | Strict JSON parsing and canonical serialization; included in current bank source hashes |
| `benchmark/src/assessment_knowledge.ts`, `benchmark/src/assessment_challenges.ts` | Knowledge and challenge tasks |
| `benchmark/src/assessment_tools.ts` | In-memory tool state machines and grading |
| `benchmark/src/assessment_baselines.ts`, `benchmark/src/assessment_observations.ts` | Strict baseline validation and separate pure per-task analysis projection; share one query-local source context |
| `benchmark/src/assessment_provenance.ts` | Unified execution source closure and byte/hash capture; includes unconditional loader dependencies even for production 1.0 |
| `benchmark/src/run_protocol.ts` | Request configuration normalization and shared sample protocol identity, retaining omitted/null/stream semantics |
| `benchmark/src/assessment_response.ts` | Visible answer extraction and explicit unit price parsing |
| `benchmark/src/production_bank.ts` | Single source of the production bank version; UI, default tasks and the chart read it |
| `benchmark/src/assessment_answer_protocol.ts` | Opt-in `submit-answer-tool-v1`: per-task `answer_schema`, last valid submission graded, no submission scores zero; new banks should adopt it |
| `benchmark/src/client.ts` | Responses HTTP client; no Chat Completions fallback |
| `benchmark/src/bench_routes.ts`, `benchmark/src/bench_adapter.ts` | Explicit routes and generic adapter contract |
| `magpie/magpie_adapter.ts`, `magpie/magpie_routes.ts`, `magpie/magpie_accounts.ts`, `magpie/magpie_quotas.ts` | Magpie catalog, account binding, request headers and quota normalization |
| `benchmark/src/bench_execution.ts` | Planning, atomic admission/publication, concurrency, retry and cancellation coordination |
| `benchmark/src/bench_execution_storage.ts`, `benchmark/src/bench_execution_queries.ts` | Private durable JSON/journals and lightweight run/task summary projections |
| `benchmark/src/assessment_runner.ts` | Single-sample execution, budgets and synchronous journal contracts, independent of CLI entry points |
| `benchmark/calibrate_assessment.ts` | Standalone calibration CLI using the shared runner; defaults to the 14 released tasks |
| `benchmark/bench.ts` | CLI client and standalone `serve` entry point; client commands use the running service’s scheduler |
| `benchmark/backend/mini_bench.ts`, `benchmark/src/bench_http_body.ts` | HTTP/authentication/service composition and an independent bounded-body reader; adapter owns model catalog caching |
| `benchmark/web/app-context.js` | Shared frontend state, service dependencies and event contracts; compatibility getters reference the same state |
| `benchmark/web/bench.js`, `task-submission.js`, `task-history-view.js`, `runs.js` | Task coordination and polling, submission/retry, inline history/details, and exact target selection respectively |
| `benchmark/web/analysis.js`, `analysis-model.js` | Analysis coordination and cached axis-specific metric derivation; presentation and history membership changes do not rescan task samples |
| `benchmark/web/` | Analysis chart and shared cross-channel search picker with channel/model/thinking filters, using `/api/bench/`; task details remain available without a separate bank page |
| `package.json`, `magpie/index.ts`, `magpie/page/` | Magpie plugin declaration, backend lifecycle, and page bootstrap |
| `benchmark/tools/` | Offline analysis, baseline import and read-only calibration import (`import_calibration.ts`, never retried or promoted) and lossless gzip archiving of terminal-run journals (`compress_journals.ts`, verified by SHA-256, reversible); no requests at module import time |
| `benchmark/tests/` | Offline Bun test suite and frontend validation |

## Local validation

Run from the repository root. Use Bun 1.4.0 or later and install development dependencies with `bun install`:


```sh
# Backend, bank, simulator, protocol, baseline, HTTP, CLI, and adapter tests; mocked gateways
bun run test

# TypeScript checks for .ts plus relaxed checkJs for the browser JavaScript (tsconfig.web.json); no build output
bun run typecheck

# Optional install-channel acceptance; requires Git, uses a loopback registry and temporary repo
bun run test:install

# Optional browser acceptance; requires playwright-cli and Chromium, with mocked APIs
bun run test:browser
bun run test:browser:sandbox

# Standalone calibration and offline tool help; no model requests
bun benchmark/calibrate_assessment.ts --help
bun benchmark/tools/analyze_assessment.ts --help
bun benchmark/tools/import_assessment_baseline.ts --help
```

Preserve the narrowly scoped `Origin: null` CORS headers on static JS/SVG responses: Magpie embeds pages in an opaque-origin `sandbox="allow-scripts"` iframe. The sandbox browser test must use real HTTP responses, not mocked response headers. UI releases also require acceptance in the actual Magpie window; switching tabs can retain an old iframe, so reload the host page after restarting the service. Never start paid evaluations for UI acceptance.

Validate runtime behavior with Bun and run TypeScript checks before delivery. Frontend validation uses temporary directories and mock APIs, not real models. Browser acceptance runs one sequential session split into named steps under `benchmark/tests/browser/` (`NN-name.js`, concatenated in order; later steps rely on earlier state). A failure reports `[browser step NAME]` and saves `failure-NAME.png`. It must cover at least chart eligibility and axis modes, instance-safe selection, planning, starting, cancellation, searchable task history, per-task details, complete baselines, and empty states.

The standalone backend entry point is `bun benchmark/bench.ts serve --port 3481`. It requires `MAGPIE_BENCH_TOKEN` with at least 32 characters. Run persistent services as managed tmux tasks with an explicit notification mechanism. Do not compete with an active plugin for its port or data directory. Tests must use temporary data directories and random ports.

## Bank changes

1. Each manifest selects its official tasks and a serializable `task_file`; grading descriptors cover exactly those task IDs. Do not export an entire candidate set or add version-specific loader branches. Revision labels in task implementations are not selectable bank versions.
2. Byte hashes of the four original grader modules, shared strict JSON parser, shared data-grading adapter, declarative resource simulator, and hidden-DFA simulator are part of bank validation. Even comment-only changes alter source hashes. Data-defined expected answers participate in task hashes; named 1.0 grading keeps its original task snapshots and task hash. Do not bypass validation or overwrite expected values just to make tests pass.
3. Before changing prompts, tools, grading, or measurement protocols, explain the effect on comparability with existing results. Then update the corresponding version, manifest, task export, independent answer tests, and baselines.
4. `benchmark/tests/assessment_bank.test.ts` checks uniform loading, the official 14-task export, and correct answers. `benchmark/tests/assessment_2.test.ts` independently enumerates or replays every experimental 2.0 answer; `benchmark/tests/assessment_2_1.test.ts` checks balanced coverage and every 2.1 expected answer, with independent finite oracles in `assessment_2_1_oracles.test.ts` and `assessment_2_1_hard_oracles.test.ts`. `benchmark/tests/assessment_2_2.test.ts` checks compact coverage and unchanged production defaults; `assessment_2_2_*oracle*.test.ts` independently checks its answers and simulator paths. Other `assessment_*.test.ts` files cover parsing boundaries, independent enumeration, and tool behavior. Retain at least these behavioral checks; do not hide incompatibility by deleting tests.
5. If execution code changes but tasks do not, leave bank hashes unchanged. Save the execution source hashes for that run rather than presenting historical results as if they came from current code.

## Baselines and evidence

- Accept only `assessment-baseline-v1` for the production Assessment 1.0 bank. All 14 tasks, every planned round, task snapshots, all current source hashes, Thinking, and per-sample protocols must pass `build_assessment_baseline` validation. Experimental 2.0, 2.1, 2.2 and 2.3 runs are calibration evidence only and cannot be promoted.
- `bank_scope=subset` cannot be promoted to a complete baseline. Missing provenance, ungradable results, and old schemas cannot be upgraded by filling in defaults or changing version numbers.
- Persist raw calls, failed attempts, and tool traces before grading. Missing token counts and costs remain `null`. Aggregates include tool continuation requests; estimates are not bills.
- Personal workspaces start empty: do not automatically load bundled test baselines into the service or analysis display. Browser tests that need observations must seed their temporary data directories explicitly.
- Preserve the bundled historical baseline and raw JSONL bytes. `benchmark/baselines/assessment-historical-provenance.json` pins the exact historical snapshot digest and original Python provenance. TypeScript offline replay establishes behavioral equivalence, not source equality. Never rewrite historical hashes as current hashes.
- Historical Assessment 1.0 personal runs remain visible. Incompatible provenance cannot be promoted to a new baseline; do not extend the bundled evidence exception to arbitrary personal snapshots.
- Bundled baseline snapshots, raw observations, and verification reports all live in `benchmark/baselines/`. The project currently includes one complete single-round observation. Do not describe it as a validated leaderboard.
- Personal runs live in `assessment/` under the data directory; personal baselines live in `assessment-baselines/`. Do not read or write retired personal `runs/`, `baselines/`, or custom old-bank files. Deleting personal data outside the project requires separate authorization.
- Catalog `provider_id` is the exact `owned_by` instance claim, not a verified serving provider or a provider type. Remote route expansion requires bounded `magpie_via` catalog evidence and the formal owner-prefixed route ID; exclude local `auto/` and `group/` entries, expand one namespace only, and preserve the full request model. Retain `remote_route` metadata in new snapshots, never reconstruct it for history or persist random hop IDs as identity. The catalog handshake adds non-chat models, which must be filtered out. Preserve recorded metadata in snapshots; never backfill historical identity from the current catalog. `gateway-default` is a concurrency pool, not an upstream account. Unknown provider types and icons use neutral presentation. Do not invent anomaly labels or detectors.
- Identical bank content alone is not sufficient. Execution settings such as Thinking, output budgets, and tool turn limits must also be comparable. `default` omits `reasoning`; it is not explicit `none`.

## Security and operational constraints

- Real evaluations, calibrations, and additional live tests may incur charges. Confirm models, accounts, counts, and budgets before execution. Passing offline tests does not authorize real requests.
- Reference upstream credentials only through service-process environment variables. Do not put them in route JSON, the frontend, logs, or documentation. Account names and echoed model names do not verify actual identity.
- Preserve loopback binding, token and Host/Origin checks, strict JSON, and requests that do not follow redirects. Error responses must not expose credentials or full exception details.
- Transient API errors may retry up to `max_api_retries` (default 3 retries after the initial attempt), within the same account and whole-sample deadline. New tasks default to a 600-second whole-sample timeout with no token/request/USD/tool/turn caps. Saved legacy runs retain their original explicit limits when manually retried. Never retry capability failures, switch accounts, or automatically resume after restart. Manual retries retain prior attempts and completed samples, and require explicit user action. After a task submission timeout, inspect history before resubmitting; task creation is not automatically retried.
- A task contains independently persisted single-target child runs. New tasks default to 3 whole-bank rounds, 6 concurrent samples per run, and 3 concurrent runs per task; the global default is 18. Account and global caps can reduce effective concurrency. Direct runs retain their per-target serial limit. Commit all child evidence and task membership before dispatch, and preserve historical run bytes. Scheduler changes must cover cancellation, publication failure, storage failure, and restart boundaries.
- New tasks expose only whole-sample timeout (default 600 seconds), plus rounds and concurrency; do not reintroduce request/token/USD/tool/turn caps. Show sample count and timeout before submission. Preserve recorded legacy limits on retries. Never imply Magpie catalog routes pin accounts. The host gateway may also retry internally; account pinning and upstream no-retry require explicit supported host capabilities, not generated route names.

## Maintenance practices

Follow the existing TypeScript style, with clear names and small functions. Do not reformat the whole project as part of a local change. Update relevant tests with new functionality, and describe only current behavior in documentation.

Keep only current usage documentation. Do not add superseded proposals, prototype archives, or historical compatibility guides. Current baseline evidence retained in `benchmark/baselines/` is not temporary data. You may clean up `.playwright-cli/`, test caches, and `.DS_Store`. Before release, check that the project contains no tokens, personal data, browser caches, or temporary validation artifacts.

Package contents are controlled by the root `package.json` `files` allowlist. Keep runtime source snapshots, bank manifests, bundled evidence, web assets and the Magpie entry point together. Before publishing, inspect `npm pack --dry-run --json --ignore-scripts`, unpack an actual archive into a temporary directory, and run the offline tests and plugin startup smoke there. Never include personal `assessment/`, `assessment-baselines/`, route credentials, browser caches or validation logs. Confirm the project license and destination before tagging, pushing or publishing.

User documentation starts at [README.md](README.md). Execution protocols and the API are documented in [docs/BENCH_EXECUTION.md](docs/BENCH_EXECUTION.md); grading is documented in [docs/ASSESSMENT_BANK.md](docs/ASSESSMENT_BANK.md).
