# LLM Mini Bench Maintenance Guide

[中文](AGENTS.zh.md)

This file is for code maintainers and coding agents. User instructions belong in `README.md`. Keep internal architecture, debugging history, and maintenance commands out of the user-facing home page.

## Project boundaries

- TypeScript backend on Bun, plain HTML/CSS/JavaScript frontend, and a TypeScript Magpie plugin entry point. No runtime npm dependencies or frontend build step. TypeScript, `@types/bun` and Prettier are development-only dependencies. Run `bun run format` before committing; `.prettierignore` excludes the byte-hashed bank grader/simulator sources, banks, evidence and prose, which must never be reformatted.
- Assessment 1.0, with 12 tasks across six domains, is the sole production question bank. Earlier prototype and test banks, fingerprint tools, and compatibility APIs remain deleted.
- Preserve content scores, instruction checks, tool checks, and execution status per task. The analysis display may use the approved equal-weight mean of all 12 tasks across every planned round, multiplied by 100, against total estimated USD, total input plus output tokens, or total elapsed time, divided by rounds. Plot only completed records with the exact 12 task IDs, 1 to 3 complete unique rounds, finite scores from 0 to 1, and known nonnegative usage or duration for the chosen axis. Zero-cost records plot on the left axis in both logarithmic and linear cost views without joining the Pareto frontier; zero usage on token/duration axes is valid on linear axes and hidden on logarithmic axes. An attempt that sent no request (empty `calls`) is a known zero, not unknown usage. Whole-sample timeouts score `0` and let the run complete while remaining retryable; records with sample timeouts, post-submission aborts (`ended_after_submission`), missing `submit_answer` calls (`no_submission`), or incomplete usage plotted at its known lower bound (optional chart setting, on by default) carry a distinct anomaly badge, never join the Pareto frontier, and never present partial usage as complete totals (timed-out and incomplete-usage runs also never feed baselines). Different Thinking protocols do not disable comparisons or the visible-point Pareto frontier. Color defaults to the model/channel/account combination, with optional cross-channel model, model-family, or evaluation-date grouping for presentation only. Keep the color legend compact with an on-demand single-column list; legend search and highlight must not filter records or alter metrics. Runs use circles and baselines use squares; connect Thinking levels only within recorded batch/channel/account/model groups. Do not add arbitrary weights, impute API failures or missing/ungradable results as zero, or select best-of results. This display metric changes neither grading nor the bank protocol or hashes.
- Task prompts and model answers are data. Do not execute model-generated code. Tools run only the project's fixed in-memory simulators.

## Directory and runtime boundaries

The repository root holds installation metadata and documentation. `benchmark/` is the benchmark root: its TypeScript modules, bank, evidence, tools, tests, and standalone web service stay together. Paths stored in release manifests and source-hash maps, such as `src/assessment_tasks.ts`, resolve relative to `benchmark/`, not the repository root. Moving the directory does not change task source bytes or justify changing bank hashes.

`magpie/` owns Magpie-specific discovery, account binding, quotas and transport adaptation. Its `index.ts` exports `default { id, server }`, imports the TypeScript service directly, and starts `Bun.serve` in the same Magpie-managed Bun plugin-host process. Do not spawn Python, Node.js, or another Bun backend process. Its `page/` bootstrap passes the host theme and local service token to the benchmark page. It must not own grading, scheduling, bank data, or baseline logic. The root `package.json` remains the Magpie installation declaration and points into this adapter; do not install the adapter directory separately.

TypeScript implements the assessment engine and HTTP service on Bun; plain browser JavaScript implements `benchmark/web/` and the adapter bootstrap. Magpie downloads Bun on first plugin installation and runs TypeScript source directly. Its moejs script engine is for agent and middleware scripts, not this plugin main module. The benchmark service and web interface can run independently of the plugin, with explicit upstream routes when Magpie's model gateway is not used. See the [adapter guide](magpie/README.md).

## Code entry points

| Location | Responsibility |
| --- | --- |
| `benchmark/banks/assessment-1.0.json` | Production release manifest; fixes task order, task hash, grading descriptors, and source hashes |
| `benchmark/banks/assessment-1.0.questions.json` | Complete serializable 12-task export for Assessment 1.0 |
| `benchmark/src/assessment_bank.ts` | Validates the bank manifest and loads runnable tasks |
| `benchmark/src/assessment_data.ts` | Shared data-defined exact-field grading (`assessment-exact-fields-v1`); participates in task hashes |
| `benchmark/src/assessment_interactive.ts` | Interactive tool task builder dispatching to the fixed in-memory simulators |
| `benchmark/src/assessment_documents.ts` | Bounded document investigation simulator (`assessment-documents-v1`) |
| `benchmark/src/assessment_blackbox.ts` | Finite-candidate adaptive probe fault-diagnosis simulator (`assessment-blackbox-v1`) |
| `benchmark/src/assessment_delegated_release.ts` | Immutable authorization chains, shared ancestor uses, and release-completion grading (`assessment-delegated-release-v1`) |
| `benchmark/src/assessment_tasks.ts` | Shared answer parsing, exact rational arithmetic, and exact-field grading |
| `benchmark/src/assessment_json.ts` | Strict JSON parsing and canonical serialization; included in bank source hashes |
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
| `benchmark/src/bench_db.ts`, `benchmark/src/bench_execution_storage.ts`, `benchmark/src/bench_execution_queries.ts` | Single-file SQLite storage (`mini-bench.sqlite`), redacted Pi Session-style event logging, and lightweight run/task summary projections |
| `benchmark/src/assessment_runner.ts` | Single-sample execution, budgets and synchronous journal contracts, independent of CLI entry points |
| `benchmark/calibrate_assessment.ts` | Standalone calibration CLI using the shared runner; defaults to the 12 released tasks |
| `benchmark/bench.ts` | CLI client and standalone `serve` entry point; client commands use the running service’s scheduler |
| `benchmark/backend/mini_bench.ts`, `benchmark/src/bench_http_body.ts` | HTTP/authentication/service composition and an independent bounded-body reader; adapter owns model catalog caching |
| `benchmark/web/app-context.js` | Shared frontend state, service dependencies and event contracts; compatibility getters reference the same state |
| `benchmark/web/bench.js`, `task-submission.js`, `task-history-view.js`, `runs.js` | Task coordination and polling, submission/retry, inline history/details, and exact target selection respectively |
| `benchmark/web/analysis.js`, `analysis-model.js` | Analysis coordination and cached axis-specific metric derivation; presentation and history membership changes do not rescan task samples |
| `benchmark/web/account-mask.js` | Presentation-only account/email masking across DOM text, tooltips, ARIA labels, and SVG annotations without mutating recorded identities |
| `benchmark/web/` | Analysis chart and shared cross-channel search picker with channel/model/thinking filters, using `/api/bench/`; task details remain available without a separate bank page |
| `package.json`, `magpie/index.ts`, `magpie/page/` | Magpie plugin declaration, backend lifecycle, and page bootstrap |
| `benchmark/tools/` | Offline analysis, baseline import, read-only calibration import (`import_calibration.ts`, directly into SQLite, never retried or promoted), legacy directory migration (`migrate_legacy_storage.ts`), and legacy journal archiving (`compress_journals.ts`); no requests at module import time |
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
2. Byte hashes of `src/assessment_tasks.ts`, `src/assessment_json.ts`, `src/assessment_data.ts`, and the interactive simulator modules in `extension_sha256` are part of bank validation. Even comment-only changes alter source hashes. Data-defined expected answers and simulator configurations participate in task hashes. Do not bypass validation or overwrite expected values just to make tests pass.
3. Before changing prompts, tools, grading, or measurement protocols, explain the effect on comparability with existing results. Then update the corresponding version, manifest, task export, independent answer tests, and baselines.
4. `benchmark/tests/assessment_bank.test.ts` checks manifest validation and the official 12-task export; `benchmark/tests/assessment_oracles.test.ts` independently verifies every Assessment 1.0 expected answer and simulator path from first principles. Retain at least these behavioral checks; do not hide incompatibility by deleting tests.
5. If execution code changes but tasks do not, leave bank hashes unchanged. Save the execution source hashes for that run rather than presenting historical results as if they came from current code.

## Baselines and evidence

- Accept only `assessment-baseline-v1` for the production Assessment 1.0 bank. All 12 tasks, every planned round, task snapshots, all current source hashes, Thinking, and per-sample protocols must pass `build_assessment_baseline` validation.
- `bank_scope=subset` cannot be promoted to a complete baseline. Missing provenance, ungradable results, and old schemas cannot be upgraded by filling in defaults or changing version numbers.
- Persist raw calls, failed attempts, and tool traces before grading. Missing token counts and costs remain `null`. Aggregates include tool continuation requests; estimates are not bills.
- Personal workspaces start empty: do not automatically load external baselines into the service or analysis display. Browser tests that need observations must seed their temporary data directories explicitly.
- Personal runs, tasks, immutable attempt histories, compact Pi Session-style events, and personal baselines live in a single private SQLite database (`mini-bench.sqlite`, WAL mode, `0o600`) under the data directory. Content-addressed bank/task/source snapshots are deduplicated in SQLite without copying per-run `source/*.ts` files or storing raw `stream_chunk` SSE logs. On startup after claiming its port, the service automatically migrates any legacy `assessment/` and `assessment-baselines/` directories into SQLite (`benchmark/src/bench_legacy_migration.ts`), checkpoints WAL, and cleans up only verified legacy entries, derived caches, and now-empty legacy directories while preserving unreadable items and unrelated files; `benchmark/tools/migrate_legacy_storage.ts` provides an offline CLI with `--dry-run` and `--cleanup`. Do not read or write retired personal `runs/`, `baselines/`, or custom old-bank files. Deleting personal data outside the project requires separate authorization.
- Catalog `provider_id` is the exact `owned_by` instance claim, not a verified serving provider or a provider type. Remote route expansion requires bounded `magpie_via` catalog evidence and the formal owner-prefixed route ID; exclude local `auto/` and `group/` entries, expand one namespace only, and preserve the full request model. Retain `remote_route` metadata in new snapshots, never reconstruct it for history or persist random hop IDs as identity. The catalog handshake adds non-chat models, which must be filtered out. Preserve recorded metadata in snapshots; never backfill historical identity from the current catalog. `gateway-default` is a concurrency pool, not an upstream account. Unknown provider types and icons use neutral presentation. Do not invent anomaly labels or detectors.
- Identical bank content alone is not sufficient. Execution settings such as Thinking, output budgets, and tool turn limits must also be comparable. Target `thinking` is optional at the engine level: omitted or `default` sends no `reasoning` and is not explicit `none`; `mixed` and `unknown` are reserved. The task UI offers only `default` for routes without advertised levels and only explicit advertised levels for routes that have them.

## Security and operational constraints

- Real evaluations, calibrations, and additional live tests may incur charges. Confirm models, accounts, counts, and budgets before execution. Passing offline tests does not authorize real requests.
- Reference upstream credentials only through service-process environment variables. Do not put them in route JSON, the frontend, logs, or documentation. Account names and echoed model names do not verify actual identity.
- Preserve loopback binding, token and Host/Origin checks, strict JSON, and requests that do not follow redirects. Error responses must not expose credentials or full exception details.
- Transient API errors may retry up to `max_api_retries` (default 3 retries after the initial attempt), within the same account and whole-sample deadline. New tasks default to a 600-second whole-sample timeout with no token/request/USD/tool/turn caps. Saved legacy runs retain their original explicit limits when manually retried. Never retry capability failures, switch accounts, or automatically resume after restart. Manual retries cover failed, timed-out, interrupted, and cancelled samples, retain prior attempts and completed samples, and require explicit user action. After a task submission timeout, inspect history before resubmitting; task creation is not automatically retried.
- A task contains independently persisted single-target child runs. New tasks default to 3 whole-bank rounds, 6 concurrent samples per run, and 3 concurrent runs per task; each task manages its own `run_concurrency` and `sample_concurrency` independently and interleaves child runs across channels and models. Direct runs share the global limit (`MAGPIE_BENCH_CONCURRENCY`, default 18), per-account concurrency limits, and the per-target serial limit. Commit all child evidence and task membership before dispatch, and preserve prior attempt rows immutably in SQLite. Scheduler changes must cover cancellation, publication failure, storage failure, and restart boundaries.
- New tasks expose only whole-sample timeout (default 600 seconds), plus rounds and concurrency; do not reintroduce request/token/USD/tool/turn caps. Show sample count and timeout before submission. Preserve recorded legacy limits on retries. Never imply Magpie catalog routes pin accounts. The host gateway may also retry internally; account pinning and upstream no-retry require explicit supported host capabilities, not generated route names.

## Maintenance practices

Follow the existing TypeScript style, with clear names and small functions. Do not reformat the whole project as part of a local change. Update relevant tests with new functionality, and describe only current behavior in documentation.

Keep only current usage documentation. Do not add superseded proposals, prototype archives, or historical compatibility guides. Current baseline evidence retained in `benchmark/baselines/` is not temporary data. You may clean up `.playwright-cli/`, test caches, and `.DS_Store`. Before release, check that the project contains no tokens, personal data, browser caches, or temporary validation artifacts.

Package contents are controlled by the root `package.json` `files` allowlist. Keep runtime source snapshots, bank manifests, bundled evidence, web assets and the Magpie entry point together. Before publishing, inspect `npm pack --dry-run --json --ignore-scripts`, unpack an actual archive into a temporary directory, and run the offline tests and plugin startup smoke there. Never include personal `assessment/`, `assessment-baselines/`, route credentials, browser caches or validation logs. Confirm the project license and destination before tagging, pushing or publishing.

User documentation starts at [README.md](README.md). Execution protocols and the API are documented in [docs/BENCH_EXECUTION.md](docs/BENCH_EXECUTION.md); grading is documented in [docs/ASSESSMENT_BANK.md](docs/ASSESSMENT_BANK.md).
