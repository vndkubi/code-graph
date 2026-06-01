# CodeGraph

CodeGraph is a local MCP server and persistent semantic indexer for coding agents. It builds a full snapshot of a repository into Postgres, then answers MCP tool calls from indexed symbols, imports, call edges, endpoints, dependency edges, file roles, and source slices.

The goal is to make agents start from a compact graph packet instead of repeatedly scanning raw files. The index is local, snapshot-based, and designed for large Java/Jakarta, TypeScript/JavaScript, and Python repositories.

## What CodeGraph Provides

| Capability | What it does |
| --- | --- |
| Full cold index | Parses every supported file, stores full parse cache, and materializes graph rows into Postgres. |
| Persistent snapshots | Queries read a completed snapshot; failed or in-progress refreshes do not expose partial data. |
| MCP stdio server | Works with VS Code, GitHub Copilot, Codex CLI, and other MCP clients. |
| Incremental refresh | Small edits and deletes can refresh by changed path instead of rebuilding the whole workspace. |
| Agent-ready packets | Tools such as `get_research_pack`, `get_flow_pack`, `get_change_pack`, and `review_patch` return ranked context with bounded evidence. |

## Quick Start

Prerequisites:

- Node.js 20 or newer.
- npm.
- Docker for the local Postgres service, unless you already run Postgres.

The examples use `<hadoop-project>` as a placeholder for the local Hadoop project root.

Start Postgres:

```powershell
docker compose -f compose.postgres.yml up -d
```

Install and build:

```powershell
npm ci
npm run build
```

Prewarm a workspace:

```powershell
node dist/cli.js index --root "<hadoop-project>" --parse-workers 8
```

Run the MCP server:

```powershell
node dist/cli.js mcp --root "<hadoop-project>"
```

For architecture details, see [System Design](docs/system-design.md). For measured indexing and real-agent results, see [Benchmark Results](docs/benchmark-results.md). For Docker and MCP client configuration, see [MCP Setup And Usage](docs/mcp-setup-and-usage.md). For correct MCP-first workflows, see [Using CodeGraph MCP Correctly](docs/using-codegraph-mcp-correctly.md). For task prompts, see [CodeGraph Prompt Guide](docs/prompt-guide.md).

## Why Use CodeGraph Instead Of Baseline File Search

Baseline agents usually search text, open many files, and reconstruct relationships from raw source. CodeGraph pays an index cost once, then returns compact graph-backed packets for repeated questions and edits.

Benchmark numbers below are produced from a fresh local run and internal deterministic proof harnesses. Token counts are estimated with `ceil(character_count / 4)` unless explicitly labeled as actual model usage.

### Fresh Hadoop Full Cold Index

Environment:

- Date: 2026-05-31
- Repository: the Hadoop project
- Hadoop branch and commit: `trunk` at `135e36a1fdb`
- Database: isolated Postgres `codegraph-docbench-postgres` on port `54330`
- Workspace key: `docs-hadoop-fresh`
- Command: `npx tsx src/cli.ts index --root <hadoop-project> --workspace-key docs-hadoop-fresh --parse-workers 8`

| Metric | Fresh run |
| --- | ---: |
| Total index time | `18m58.3s` |
| Manifest scan | `6.2s` |
| Files total | `14,082` |
| Parsed files | `14,082` |
| Parse cache hits | `0` |
| Parse cache rows | `13,996` |
| Symbols | `323,867` |
| Call edges | `1,186,425` |
| Primary/provider call edges | `999,812` |
| Low-signal call edges | `186,613` |

Coverage check: `NameNode.java`, `DataNode.java`, and `FileSystem.java` were indexed. Historical project runs on this workstation have ranged from about `13m10s` to `15m36s`; the fresh isolated run above is the reproducible no-reuse prewarm cost captured for this README.

### Fresh CodeGraph Vs Baseline Retrieval Proofs

| Proof | Tasks | Baseline correct | CodeGraph correct | Quality maintained | Input token reduction | File-open reduction | p95 latency |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| Context proof | 10 | 7/10 | 10/10 | yes | 91.1% | 96.0% | 9.7s |
| Review proof | 10 | 7/10 | 10/10 | yes | 96.1% | 97.3% | 980ms |

The baseline proof scans and opens matching files directly. The CodeGraph proof uses graph tools first, then bounded slices or review packets. This validates context reduction only when correctness is maintained or improved.

## Tool Selection

| Task | Use this first | Why |
| --- | --- | --- |
| Research an area or answer architecture questions | `get_research_pack` | Ranked definitions, related files, flow hints, and bounded evidence. |
| Understand execution flow | `get_flow_pack` | Ordered flow steps, callers/callees, and relevant slices. |
| Implement, debug, refactor, or test | `get_change_pack` | Scoped files, symbols, edit ranges, likely tests, and validation hints. |
| Review a patch | `review_patch` | Risk-focused packet with findings, changed hunks, required follow-up slices, and validation gaps. |
| Find a symbol | `search_symbol` | Intent-aware symbol ranking with filters for kind, annotations, framework role, tests, and generated files. |
| Find files | `search_files` | Ranks paths by symbols, endpoints, imports, dependencies, and file role. |
| Find references, calls, or field usage | `find_references`, `get_callers`, `get_callees` | Uses indexed definitions, imports, call edges, and opt-in Java field usages. |
| Trace dependencies | `trace_dependencies` | Walks dependency or dependent edges with depth and file-role filters. |
| Check index health | `get_index_stats` | Shows snapshot counts, diagnostics, stale status, and framework warnings. |

Prefer one pack tool before opening many files. Use granular tools only when the pack reports missing facts or when exact source slices are needed.

## Branches, Edits, And Freshness

CodeGraph keeps correctness by snapshotting each workspace:

- Small edits and deletes: run MCP with `--watch`, or query with `autoRefresh: true`, so CodeGraph can refresh changed paths.
- Large branch checkouts or pulls: run explicit `index --root ...` after the Git operation.
- Two branches at once: use `git worktree` or separate clones, each with a different root or `CODEGRAPH_WORKSPACE_KEY`.
- Docker: always set `CODEGRAPH_WORKSPACE_KEY`, because every repository is mounted as `/workspace` inside the container.

See [System Design](docs/system-design.md) for the internal architecture and indexing/query flow. See [Benchmark Results](docs/benchmark-results.md) for local Hadoop indexing and Codex CLI MCP comparisons. See [MCP Setup And Usage](docs/mcp-setup-and-usage.md) for detailed setup, client config, branch workflows, and troubleshooting. See [Using CodeGraph MCP Correctly](docs/using-codegraph-mcp-correctly.md) for MCP-first workflow rules and [CodeGraph Prompt Guide](docs/prompt-guide.md) for copy-paste prompts by task type.

## CLI Reference

```text
codegraph mcp --root <workspace>       Run MCP stdio proxy and auto-start daemon
codegraph daemon start|stop|status     Manage the local daemon
codegraph index --root <workspace>     Prewarm or refresh the persistent index
codegraph graph --root <workspace> --out <graph.html>
                                      Export a self-contained graph viewer
codegraph doctor                       Inspect local configuration
codegraph logs --tail <number>         Print recent daemon query/index events
codegraph benchmark generate|index|eval|proof|review|copilot-e2e
                                      Generate repos, measure indexing, or prove retrieval savings
```

Common options:

```text
--workspace-key <key>                  Stable workspace identity, especially for Docker
--parse-workers <number>               Worker threads for cold/cache-miss parsing
--auto-refresh                         Refresh stale snapshots before MCP tool calls when safe
--refresh-on-start                     Queue a background refresh when MCP starts
--watch                                Watch files and refresh changed paths in the background
--warn-stale                           Include freshness checks in MCP responses
--mcp-tools <a,b,c>                    Expose only selected MCP tools
```

## Development

```powershell
npm run lint
npm run build
npm test
```

## License

MIT
