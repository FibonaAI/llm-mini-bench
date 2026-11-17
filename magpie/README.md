# Magpie Adapter

[中文](README.zh.md)

This directory connects Magpie to the assessment application in [benchmark/](../benchmark/). It contains no question bank, grading, scheduler, or baseline implementation.

## Installation boundary

For npm and GitHub installation, see the [project README](../README.md). Local development can register the repository root instead:

```sh
/Applications/magpie.app/Contents/MacOS/magpie plugin add "$PWD"
/Applications/magpie.app/Contents/MacOS/magpie plugin on "$PWD"
```

Run these commands from the repository root. Do not register `magpie/` as a separate plugin or copy this directory on its own.

The root [package.json](../package.json) is the installation declaration. Its `main` points to `./magpie/index.ts`, and `magpie.page.file` points to `magpie/page/index.html`. [Magpie downloads Bun on first plugin installation](https://usemagpie.ai/docs/plugins) and runs TypeScript source directly. Plugin use requires no separate Python or Node.js installation, runtime npm dependencies, or build step.

After updating backend code, disable and re-enable only LLM Mini Bench when no evaluations are active, then reload the host page. Refreshing the page alone does not reload the backend. Do not restart or update Magpie as an automatic workaround: host operations can rewrite agent integration files. Plugin lifecycle tests do not verify a real host reload.

## Files and runtimes

| File or directory | Runtime and responsibility |
| --- | --- |
| `index.ts` | TypeScript module exporting `default { id, server }`; validates plugin options, directly imports the service, and manages its lifetime in Magpie’s Bun plugin-host |
| `magpie_service.ts`, `magpie_adapter.ts` | Assemble the generic service and own Magpie catalog HTTP, caching and refresh |
| `magpie_routes.ts`, `magpie_accounts.ts`, `magpie_quotas.ts` | Normalize routes/quotas and apply explicitly configured account pins in the request client |
| `page/index.html`, `page/boot.js` | Browser bootstrap; reads Magpie options and theme, then opens the benchmark page with the local service token |
| `../benchmark/backend/mini_bench.ts` | Bun HTTP service; serves the assessment API and web interface through `Bun.serve` |
| `../benchmark/src/` | TypeScript assessment, grading, routing, scheduling, and baseline logic |
| `../benchmark/web/` | Plain HTML/CSS/browser JavaScript assessment interface |

The adapter and backend execute in the same Magpie-managed Bun process. The adapter does not launch Python, Node.js, or a separate Bun process. Magpie’s moejs engine handles agent and middleware scripts, not this plugin main module.

## Startup and configuration

The page initializes its connection automatically on first open. It generates a 256-bit random local token and a private-range port, saves them through Magpie's supported `options.set` bridge, then reloads only its own frame so the host runtime and remote service proxy use the same settings. Existing valid settings and optional account bindings are preserved. No unauthenticated token-discovery endpoint is exposed.

The adapter imports `benchmark/backend/mini_bench.ts` directly and starts its local server after that handshake. Upstream credentials and explicit route overrides, when needed, must be available in the Magpie plugin-host process environment, not only in a separate CLI terminal.

The benchmark backend and interface can also run with Bun without this adapter. See the [execution guide](../docs/BENCH_EXECUTION.md) for standalone startup and explicit account routes. Do not start another service on the active plugin’s port or data directory.

## Explicit local account bindings

For optional account-specific comparisons, add an `accounts` array without removing the automatically saved connection settings:

```json
{
  "accounts": [
    { "provider_id": "codex", "account": "first@example.invalid", "account_ref": "codex-first", "models": ["codex/gpt-6-luna"] },
    { "provider_id": "relay", "account": "work-key", "account_ref": "relay-work" }
  ]
}
```

Use account names or routing-trace IDs recognized by the receiving Magpie. A missing `models` list exposes all priced catalog models of that local provider; listing a model does not prove the account can serve it. Magpie rejects an unavailable or unknown pin instead of choosing another account. Duplicate display names should use distinct trace IDs. The adapter sends `X-Magpie-Account` and records an opaque binding fingerprint in the plan. Core Bench does not parse that header or account configuration.

This does not pin accounts behind Remote Magpie: the header stops at the receiving gateway. Remote quotas remain informational. Configured bindings are request evidence, not independently verified upstream identity. Magpie may still retry within the selected account; Mini Bench retries transient API failures within its configured request, retry and optional USD limits, without switching account bindings.

## Offline adapter test

From the repository root:

```sh
bun test ./magpie
```

Tests check adapter lifecycle without paid model calls. To validate both distribution shapes, run:

```sh
bun run test:install
```

This optional check requires Git and uses the current Bun executable. It builds the release tarball, installs it by package name/version from an isolated loopback npm registry, and installs the same source from a tagged temporary Git repository. Both installed copies must serve the bank and web page with an empty personal baseline list. It does not invoke the Magpie CLI, register plugins in the real host, contact public registries or start model calls. It verifies the shared Bun install/runtime contract, not the availability of a published npm version or GitHub tag. Full benchmark validation belongs to [AGENTS.md](../AGENTS.md).
