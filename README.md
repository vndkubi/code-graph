# CodeGraph

CodeGraph is a local MCP server and semantic indexer for coding agents. It stores each workspace in a per-repository SQLite database at `<repo>/.codegraph/graph.sqlite`; there is no daemon, no HTTP hop, no Docker, and no Postgres runtime dependency.

The goal is to let agents start from compact graph-backed packets instead of repeatedly scanning raw files. The index is snapshot-based and supports Java/Jakarta, TypeScript/JavaScript, Python, JSON, YAML, XML, and properties evidence.

## What It Provides

| Capability | What it does |
| --- | --- |
| Per-repo SQLite graph | Stores files, symbols, imports, call edges, dependency edges, endpoints, and diagnostics in `.codegraph/graph.sqlite`. |
| Local artifact index | `setup` also builds a compact artifact for fast facade tools and fallback context. |
| MCP stdio server | Opens SQLite directly inside the MCP process and handles tool calls in-process. |
| Incremental refresh | Small edits and deletes can refresh by changed path instead of rebuilding the whole workspace. |
| Agent-ready packets | `get_research_pack`, `get_flow_pack`, `get_change_pack`, and `review_patch` return ranked context with bounded evidence. |
| Offline graph export | Generates a static HTML graph viewer from indexed facts. |

## Quick Start

Prerequisites:

- Node.js 20 or newer.
- npm.

Install and build:

```powershell
npm ci
npm run build
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

Run on this repository after the SQLite refactor:

| Benchmark | Result |
| --- | ---: |
| Cold index | 74 files, 3.18s, 148 MB RSS |
| Setup warm path | 74 parse-cache hits, 584 ms |
| Golden eval | 4/4 correct, 96.6% estimated token saving |
| Context proof | 5/5 MCP correct, 83.5% estimated input-token saving, 74.3% file-open reduction, p95 workflow 512 ms |
| Review proof | 5/5 MCP correct, 89.1% estimated input-token saving, 85.7% file-open reduction, p95 `review_patch` 198 ms |
| Local fallback | 5/5 correct, p50 56 ms, p95 99 ms |

Token counts use the deterministic benchmark estimator `ceil(character_count / 4)`.

## CLI Reference

```text
codegraph mcp --root <workspace>       Run MCP stdio proxy
codegraph setup --root <workspace>     Build .codegraph/graph.sqlite and local artifact index
codegraph index --root <workspace>     Build or refresh the SQLite graph index
codegraph atlas --root <workspace>     Generate deterministic repo atlas JSON/Markdown
codegraph graph --root <workspace> --out <graph.html>
                                      Export a self-contained graph viewer
codegraph doctor --root <workspace>    Inspect workspace graph configuration
codegraph logs --root <workspace> --tail <number>
                                      Print recent workspace query events
codegraph benchmark generate|index|eval|proof|review|fallback|copilot-e2e|codex-e2e
                                      Generate repos, measure indexing, or prove retrieval savings
```

Common options:

```text
--workspace-key <key>                  Stable workspace identity for unusual mount paths
--parse-workers <number>               Worker threads for cold/cache-miss parsing
--auto-refresh                         Refresh stale snapshots before MCP tool calls when safe
--refresh-on-start                     Queue a background refresh when MCP starts
--watch                                Watch files and refresh changed paths in the background
--warn-stale                           Include freshness checks in MCP responses
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

## Development

```powershell
npm run lint
npm run build
npm test
```

## More Docs

- [Migration Guide](docs/MIGRATION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [System Design](docs/system-design.md)
- [MCP Setup And Usage](docs/mcp-setup-and-usage.md)
- [Benchmark Results](docs/benchmark-results.md)

## License

MIT
