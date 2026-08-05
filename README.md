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
| Session evidence reuse | Pass a stable `sessionId` on every pack call and CodeGraph omits source bodies it already delivered (`reusedFromEarlierCall`), cutting duplicate tokens across a multi-step task; `freshEvidence: true` forces full bodies. |
| Response metadata | Every tool response includes `_codegraph_meta` with tool name, `duration_ms`, `response_chars`, `tokens_est`, and item counts. |

## Built-in TokenOpt / ContextGate gate

TokenOpt/ContextGate is now **fused into CodeGraph** — one package, one MCP server, one CLI. The ContextGate broker enriches its packets by calling the CodeGraph query engine **in-process**, so there is no second MCP server to install and no subprocess spawn / double-spend.

The default surface is deliberately **single-gate**: one entry point instead of several competing "call me first" tools (see [docs/mcp-adoption-plan.md](docs/mcp-adoption-plan.md)).

| Surface | Tools | Role |
| --- | --- | --- |
| **CodeGraph gate** (default `client` profile) | `codegraph_context`, `codegraph_slice`, `codegraph_checkpoint`, `codegraph_status` | `codegraph_context` is THE entry point — it classifies the task, requests a Luna scope plan when ambiguous, and routes to the right bounded pack. `codegraph_checkpoint` persists explicit multi-phase task state. |
| **Direct packs + TokenOpt gate** (`full` profile) | `get_research_pack`, `get_change_pack`, `review_patch`, `contextgate_get_context`, `tokenopt_*`, … | Benchmark/power-user flows |

The flow for broad tasks:

1. Call `codegraph_context` with the user's task verbatim (same `sessionId` on every call of a conversation).
2. For PR review, pass `prUrl` or `baseRef` + `headRef` when available; a GitHub PR URL or `from <base> to <head>` phrase in the task is parsed into an immutable, batched review.
3. If `answerable=true`, answer from the packet. If the packet names an exact missing file/line/symbol, fetch just that with `codegraph_slice`.

For exact file/symbol tasks where the owner is already known, skip the gate and read directly.

**Tool exposure** is controlled by `--mcp-profile` (default `client` → the 4 facade tools; `full` → every tool on both surfaces). The embedded TokenOpt gate tools are hidden outside `full`; `TOKENOPT_MCP_MODE=lite|full|broker` restores them on any profile, `off` hides them even on `full`. `CODEGRAPH_RELEVANCE_GATE` defaults to `shadow`; set `enforce` only after the release benchmark gates pass, or `off` for an explicit opt-out.

**CLI:** the TokenOpt gate surface (init, exec, report, doctor) lives under `codegraph gate <…>` (e.g. `codegraph gate doctor`). The legacy `tokenopt` binary alias maps to the same commands.

## Quick Start

Prerequisites:

- Node.js 20 or newer.
- npm.

Install from a local checkout:

```powershell
npm ci
npm run build
```

Install from npm (published as `@vndkubi/codegraph-mcp`):

```powershell
npx @vndkubi/codegraph-mcp@latest setup --root "<repo>"
npx @vndkubi/codegraph-mcp@latest mcp --root "<repo>"
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

Run on this repository after the right-sizing + ranking pass (relevance-cliff trimming with an outlier guard and a `minKeep` floor, keepRatio=0.5 default; stem-aware file ranking; `__tests__/` role classification). These are self-repo deterministic proof harnesses, not external multi-repo claims or a production savings guarantee. Token and round-trip cost varies by repository/task; release decisions require the current benchmark gates to pass:

| Benchmark | Result |
| --- | ---: |
| Index smoke | 84 files, 6.81s, 148 MB RSS |
| Setup warm path | 84 parse-cache hits, 740 ms |
| Golden eval | 4/4 correct, 98.0% estimated token saving |
| Context proof | 5/5 MCP correct, 86.9% estimated input-token saving, 91.4% file-open reduction, p95 workflow 406 ms |
| Review proof | 5/5 MCP correct, 87.3% estimated input-token saving, 96.9% file-open reduction, p95 `review_patch` 411 ms |
| Local fallback | 5/5 correct, p50 19 ms, p95 632 ms |
| Evidence right-sizing | Quality-neutral on a broad multi-file suite: trimming ON matches the no-trim baseline on both repos (internal 2/3 tasks recall 0.83; external 4/5 recall 0.93) while saving input tokens. The earlier keepRatio=0.8 default was a net quality loss on broad tasks (internal 1/3 0.61, external 2/5 0.70) and was corrected to 0.5 + outlier guard + minKeep floor + stem-aware ranking. |
| Broad-task recall (`benchmark recall`) | Internal 2/3 allFound, avg recall 0.83; external corpus 4/5, 0.93 — right-sizing ON equals the no-trim baseline on both. Point `--root`/`--tasks` at any repo. |
| Test-impact selection (`benchmark affected-tests`) | Every directly-coupled test recovered (recall 1.0, worst 1.0) while cutting the suite ~76–79% on average (internal 41 tests → ~8.7 selected; external 86 → ~21.4). Reverse local-import reachability; `affected-tests --changed <files>` for a real diff. |

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
codegraph affected-tests --root <workspace> --changed <file[,file...]> [--max-depth N] [--limit N]
                                      Test-impact selection: tests reachable from the changed files
                                      via the reverse local-import graph (run a targeted subset, not all)
codegraph status --root <workspace>    Human-readable status report with optional machine-readable --json
codegraph logs --root <workspace> --tail <number> [--summary|--all|--since|--until|--tool|--event|--invalid]
                                      Print recent workspace query events or a compact aggregate summary
codegraph benchmark generate|index|eval|proof|review|fallback|route-gate|quality-trend|evidence-audit|recall|affected-tests|copilot-e2e|codex-e2e|claude-e2e
                                      Generate repos, measure indexing, or prove retrieval savings
                                      (quality-trend [--out <report.md>] appends a dated correctness/
                                      token-saving row so ranking/resolver regressions surface over time;
                                      evidence-audit measures Waste% (evidence sent but not needed for a
                                      correct answer) and Gap% (needed evidence the packet never delivered)
                                      so packets can be right-sized: exactly what the agent needs, no more;
                                      recall [--root <repo>] [--tasks <suite.json>] [--max-files N]
                                      [--keep-ratio R] measures broad multi-file recall (allFound, avg
                                      recall, recall@N) with right-sizing ON vs the no-trim baseline —
                                      point it at any repo to check retrieval on a real corpus)
```

### Codex E2E suite contract

`codex-e2e` checks suite contracts before any paid task run.
You can define required context by:

- `rootProfile.requiredFiles`: repo-relative file paths that must exist in the indexed snapshot.
- `rootProfile.requiredMethods`: symbol names that must exist in symbol indexing.
- `task.expectedFiles` / `task.expectedMethods`: expected evidence from task-level prompts.

If both file and method contracts are missing (at both root and task level), a warning is emitted (`missing_compatibility_contract`) instead of a hard block.

Claude cold-start experiments can compare `--claude-mcp-load eager|lazy` and
`--claude-startup-profile standard|lean`. `lean` is intended for repeatable
headless benchmarks; it deliberately removes unrelated startup surfaces and
auto-memory, so do not use it as a substitute for realistic interactive runs.

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
--warn-stale                           Freshness/stale-index checks are ON by default for all MCP
                                       tool responses; pass --no-warn-stale to opt out
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

- [Architecture](docs/ARCHITECTURE.md) — fused single-server design, storage, flows
- [MCP Setup And Usage](docs/mcp-setup-and-usage.md) — install, profiles, agent tool flow
- [CLI Reference](docs/cli.md) — `codegraph` commands and `codegraph gate <…>`
- [Migration Guide](docs/MIGRATION.md) — moving from two MCP servers to one fused server

## License

MIT
