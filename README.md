# LLM Mini Bench

[中文](README.zh.md)

**A quick, low-cost first look at a language model's capabilities.**

Before committing to a model, run a small set of tasks to see where it answers correctly, follows instructions, handles tools or falls short. LLM Mini Bench makes it easy to compare models, accounts and Thinking settings, with the answers and estimated costs available for inspection.

It works independently or inside Magpie.

## What it tests

Mini Bench has **14 tasks** across six areas:

| Area | Tasks |
| --- | --- |
| Knowledge | Genetic codes, DNS caching, treaty rules |
| Reasoning | Probability, causal counterfactuals, scheduling |
| Code semantics | References and `finally`, concurrent transactions |
| Evidence synthesis | Payment records, bitemporal revisions |
| Instruction following | Coupled transformations, quoted instructions |
| Tool use | Inventory constraints, booking conflict recovery |

The bank is intentionally small. Use it to screen candidates and decide what to test next, not as a comprehensive measure of ability or a model leaderboard. Tool tasks run in simulators, never against real inventory or calendars.

## Start with Magpie

In Magpie's Plugins page, install **one** of these sources:

| Channel | Source |
| --- | --- |
| npm | `npm:llm-mini-bench` |
| GitHub | `github:FibonaAI/llm-mini-bench` |

The npm package and GitHub source must be published before they can be installed. Magpie manages the runtime. Open **模型评测** after installation; the plugin initializes its local connection automatically and loads Magpie's model catalog. No token or port setup is required.

### Run a first comparison

1. Open **任务** and select a model and Thinking setting. Add other models or settings if you want a side-by-side comparison.
2. Choose **1 round** for a quick first pass over all 14 tasks. The default is 3 rounds if you want to check consistency.
3. Check the automatically updated run count, sample count and execution limits, then click **开始评测** (Start evaluation).
4. Open **分析** to compare scores and estimated costs. Select a result to inspect individual answers, instruction checks and tool calls.

Each selected combination is a separate run. You can cancel one run or the whole task; requests already sent may still incur charges. Tool tasks may make multiple requests per sample.

Magpie chooses accounts automatically by default. To compare specific local accounts, see [account binding](magpie/README.md#explicit-local-account-bindings). Local account pins do not reach accounts behind Remote Magpie.

## Read the results

The chart compares the **equal-weight mean of all 14 task scores on a 100-point scale** with **estimated USD or total input + output tokens per round**. The chart’s “着色” control defaults to provider/model combinations and also offers model, model-family or evaluation-date coloring. Date coloring uses the same multicolor palette. Circles are personal runs and squares are baselines; latest records are filled and historical records are hollow. Hover, focus or selection reveals distinct visible Thinking levels only within the same recorded batch, exact request model, channel and account. Scores, instruction compliance, tool checks and execution status remain separately inspectable.

- Only complete runs covering all 14 tasks and every planned round, with valid scores and known usage for the selected axis, appear on the chart.
- Failed or missing results are not scored as zero. Zero-cost results appear on linear axes, not logarithmic axes.
- Compare matching task banks and execution settings. Thinking `default` leaves reasoning unspecified; it is not explicit `none`.
- Account and model labels describe requested routing, not independently verified upstream identity.

Save complete, gradable runs as baselines to compare with later results. Your workspace starts empty and shows only your own runs and saved baselines. See [task and grading details](docs/ASSESSMENT_BANK.md).

## Run without Magpie

Requires [Bun](https://bun.com/) 1.4.0 or later:

```sh
git clone https://github.com/FibonaAI/llm-mini-bench.git
cd llm-mini-bench
```

Configure [upstream routes and credentials](docs/BENCH_EXECUTION.md#configure-two-routes), then start the local service:

```sh
export MAGPIE_BENCH_TOKEN="$(openssl rand -hex 32)"
bun benchmark/bench.ts serve
```

Open `http://127.0.0.1:3481/#token=YOUR_TOKEN`, replacing `YOUR_TOKEN` with the value of `MAGPIE_BENCH_TOKEN`. Keep it private. Starting the service sends no model requests.

The [execution guide](docs/BENCH_EXECUTION.md) covers standalone configuration and CLI use, including planning, starting and cancelling tasks.

## Costs and privacy

- Model requests may incur charges. New tasks use one whole-sample timeout (600 seconds by default), with no token, request-count, USD, tool-call or interaction-turn cap. Costs are estimates, not bills.
- Questions and answers pass through your selected upstream. Use only channels you trust.
- Transient API errors retry up to 3 times after the initial request. Exhausted API failures can be retried explicitly in task history; successful samples are retained and results update afterward. Capability limits are “incomplete”, not API failures. Task-creation timeouts still require checking history before another submission.
- The service listens only on loopback. Do not expose its port or share its authentication token.
- Personal results are stored in `~/.local/share/magpie-mini-bench/` by default. They include full prompts, answers and tool traces; review them before sharing.
