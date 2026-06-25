# CodeGraph

[![CI](https://github.com/vndkubi/code-graph/actions/workflows/ci.yml/badge.svg)](https://github.com/vndkubi/code-graph/actions/workflows/ci.yml)

CodeGraph is a local MCP server and semantic indexer for coding agents. It stores each workspace in a per-repository SQLite database at `<repo>/.codegraph/graph.sqlite`; there is no daemon, no HTTP hop, no Docker, and no Postgres runtime dependency.

The goal is to let agents start from compact graph-backed packets instead of repeatedly scanning raw files. The index is snapshot-based and supports Java/Jakarta, TypeScript/JavaScript, Python, JSON, YAML, XML, and properties evidence.

## What It Provides

| Capability | What it does |
| --- | --- |
| Per-repo SQLite graph | Stores files, symbols, imports, call edges, dependency edges, endpoints, and diagnostics in `.codegraph/graph.sqlite`. |
| Local artifact index | `setup` also builds a compact artifact for degraded fallback context when SQLite is unavailable. |
| MCP stdio server | Opens SQLite directly inside the MCP process and handles tool calls in-process. |
| Incremental refresh | Small edits and deletes can refresh by changed path instead of rebuilding the whole workspace. |
| Agent-ready packets | `get_research_pack`, `get_flow_pack`, `get_change_pack`, and `review_patch` return ranked context with bounded evidence. |
| Offline graph export | Generates a static HTML graph viewer from indexed facts. |
| Response metadata | Every tool response includes `_codegraph_meta` with tool name, `duration_ms`, `response_chars`, `tokens_est`, and item counts. |

## Joint Workflow with TokenOpt

When both CodeGraph and TokenOpt MCPs are connected, they coordinate automatically via their `SERVER_INSTRUCTIONS`:

| Role | When TokenOpt present | When standalone |
| --- | --- | --- |
| **TokenOpt** | PRIMARY router — call `contextgate_get_context` first for broad/unknown-owner tasks | N/A |
| **CodeGraph** | `code_graph` provider — fills evidence gaps named by the TokenOpt packet | PRIMARY — use `codegraph_context` directly |

The flow for broad tasks:

1. Call `contextgate_get_context` (TokenOpt) with the full natural task.
2. If the packet has evidence gaps with `tool_categories: ["code_graph"]`, fill them with `codegraph_context` or the appropriate CodeGraph pack tool.
3. Do NOT call CodeGraph first when TokenOpt is connected — its `SERVER_INSTRUCTIONS` will self-direct it to wait for the TokenOpt packet.

The flow for code review:

1. Round 1 (business): `contextgate_get_context` + CodeGraph `get_change_pack` for requirement/impact evidence.
2. Round 2 (technical YAGNI/KISS): No MCPs — direct diff review.
3. Round 3 (checklist): CodeGraph `get_change_pack` only for changed-file coverage.

For exact file/symbol tasks where the owner is already known, skip both MCPs and read directly.

## Quick Start

Prerequisites:

- Node.js 20 or newer.
- npm.

Install from a local checkout:

```powershell
npm ci
npm run build
```

The package is prepared for npm distribution. Until a release is published, use the local checkout commands above. After publication, the intended entrypoint is:

```powershell
npx mcp-code-graph@latest setup --root "<repo>"
npx mcp-code-graph@latest mcp --root "<repo>"
```

Set up a workspace:

```powershell
node dist/cli.js setup --root "<repo>"
```

Run MCP:

```powershell
node dist/cli.js mcp --root "<repo>"
```

Refresh the graph after edits or branch changes:

```powershell
node dist/cli.js index --root "<repo>"
```

Add `.codegraph/` to `.gitignore`; it is local generated state.

## Current Local Benchmark

Run on this repository after the tokenizer/CI feedback pass. These are self-repo deterministic proof harnesses, not external multi-repo claims:

| Benchmark | Result |
| --- | ---: |
| Index smoke | 84 files, 6.81s, 148 MB RSS |
| Setup warm path | 84 parse-cache hits, 740 ms |
| Golden eval | 4/4 correct, 96.0% estimated token saving |
| Context proof | 5/5 MCP correct, 80.1% estimated input-token saving, 74.4% file-open reduction, p95 workflow 658 ms |
| Review proof | 5/5 MCP correct, 85.4% estimated input-token saving, 87.2% file-open reduction, p95 `review_patch` 411 ms |
| Local fallback | 5/5 correct, p50 19 ms, p95 632 ms |

Token counts use the shared `cl100k_base/js-tiktoken` text estimator. Actual model billing can differ because tools, files, cached input, and model runtime accounting are provider-specific.

## CLI Reference

```text
codegraph mcp --root <workspace>       Run MCP stdio proxy
codegraph setup --root <workspace>     Build .codegraph/graph.sqlite and local artifact index
codegraph index --root <workspace>     Build or refresh the SQLite graph index
codegraph atlas --root <workspace>     Generate deterministic repo atlas JSON/Markdown
codegraph graph --root <workspace> --out <graph.html>
                                      Export a self-contained graph viewer
codegraph doctor --root <workspace>    Inspect readiness, freshness, and setup actions
codegraph upgrade-audit --root <workspace> [--policy <path>] [--min-score <number>] [--min-grade <A+|A|B+|B|C|D|F>] [--max-slow-ms <ms>] [--max-slow-ms-p95 <ms>] [--max-invalid-lines <number>] [--max-stale-queries <number>] [--max-degraded-queries <number>] [--max-stale-ratio <percent>] [--max-degraded-ratio <percent>] [--tail <number>] [--since/--until/--tool/--event]
                                      Run a readiness + query-log audit with a super-VIP grade
codegraph status --root <workspace>    Human-readable status report with optional machine-readable --json
codegraph logs --root <workspace> --tail <number> [--summary|--all|--since|--until|--tool|--event|--invalid]
                                      Print recent workspace query events or a compact aggregate summary
codegraph benchmark generate|index|eval|proof|review|fallback|copilot-e2e|codex-e2e
                                      Generate repos, measure indexing, or prove retrieval savings
```

### Codex E2E suite contract

`codex-e2e` checks suite contracts before any paid task run.
You can define required context by:

- `rootProfile.requiredFiles`: repo-relative file paths that must exist in the indexed snapshot.
- `rootProfile.requiredMethods`: symbol names that must exist in symbol indexing.
- `task.expectedFiles` / `task.expectedMethods`: expected evidence from task-level prompts.

If both file and method contracts are missing (at both root and task level), a warning is emitted (`missing_compatibility_contract`) instead of a hard block.

```json
{
  "rootProfile": {
    "name": "example-root",
    "requiredFiles": ["src/index.ts"],
    "requiredMethods": ["start", "stop(orderId)"]
  },
  "tasks": [
    {
      "id": "health-check",
      "prompt": "Explain startup/shutdown flow.",
      "expectedMethods": ["start", "shutdown"],
      "requiredAnswerFields": ["flow", "risks"]
    }
  ]
}
```

Common options:

```text
--workspace-key <key>                  Stable workspace identity for unusual mount paths
--parse-workers <number>               Worker threads for cold/cache-miss parsing
--auto-refresh                         Refresh stale snapshots before MCP tool calls when safe
--refresh-on-start                     Queue a background refresh when MCP starts
--watch                                Watch files and refresh changed paths in the background
--warn-stale                           Include freshness checks in all MCP tool responses
--prewarm                              Index missing snapshots inside MCP startup/runtime
```

## Tool Selection

| Task | Use this first | Why |
| --- | --- | --- |
| Research an area or answer architecture questions | `get_research_pack` | Ranked definitions, related files, flow hints, and bounded evidence. |
| Understand execution flow | `get_flow_pack` | Ordered flow steps, callers/callees, and relevant slices. |
| Implement, debug, refactor, or test | `get_change_pack` | Scoped files, symbols, edit ranges, likely tests, and validation hints. |
| Review a patch | `review_patch` | Risk-focused packet with findings, changed hunks, follow-up slices, and validation gaps. |
| Find symbols or files | `search_symbol`, `search_files`, `search_code` | Intent-aware ranking over indexed facts and source snippets. |
| Find references or calls | `find_references`, `get_callers`, `get_callees` | Uses indexed definitions, imports, and call edges. |
| Check index health | `get_index_stats` | Shows snapshot counts, diagnostics, stale status, and warnings. |

Prefer one pack tool before opening many files. Use granular tools when exact source slices or relationship checks are needed.
`codegraph_context` includes stale-index warnings by default; pass `warnStale: false` only when you intentionally want the smallest possible packet.
For composite latency diagnostics, pass `debugTiming: true` to `codegraph_context` change tasks, `simulate_patch_impact`, or `get_change_pack`; the default responses stay compact and omit timing noise.

## Health Checks

`codegraph doctor --root <workspace>` and MCP `codegraph_status` report a shared readiness contract:

- `state`: `ready`, `artifact_only`, `unindexed`, `missing`, or `invalid`.
- `capabilities`: whether graph queries, the embedded artifact, and facade context are usable.
- `freshness`: whether the SQLite snapshot matches the current git head and dirty state.
- `upgrade-audit`: when requested, an `overall` score plus `grade` (`A+` to `F`) and blocking reasons.
- `nextActions`: exact setup or refresh commands when the workspace needs attention.

For CI-style enforcement, `codegraph status --require-ready` exits non-zero when the workspace is not `ready`, while `codegraph status --require-fresh` also fails when the current snapshot is stale.
Use `codegraph upgrade-audit --min-score <n>` or `--min-grade <grade>` for super-VIP quality gates that fail when quality is below threshold.
You can also use `--policy <path>` (or `CODEGRAPH_UPGRADE_AUDIT_POLICY`) to define these checks in `.codegraph/upgrade-audit.json`.
Set `--max-slow-ms` to enforce a hard latency ceiling for sampled windows, and `--max-slow-ms-p95` to enforce a rolling 95th-percentile ceiling (less sensitive to rare spikes).
Add `--max-invalid-lines` to cap malformed JSON rows in the selected log window and keep your telemetry clean.
Add `--max-stale-queries` / `--max-degraded-queries` to keep stale or degraded query counts bounded for the selected window. Add `--max-stale-ratio` / `--max-degraded-ratio` to enforce quality percent caps for low-volume as well as high-volume windows.

## Development

```powershell
npm run lint
npm run build
npm test
npm run quality-gate
npm run verify
npm run hooks:install
``` 

Recommended local guard: install once per clone and every `git push` will run `npm run verify` automatically.

See [Contributing](CONTRIBUTING.md) for CI-equivalent benchmark smoke commands and benchmark reporting expectations.

## More Docs

- [Migration Guide](docs/MIGRATION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [System Design](docs/system-design.md)
- [MCP Setup And Usage](docs/mcp-setup-and-usage.md)
- [Benchmark Results](docs/benchmark-results.md)

## License

MIT
