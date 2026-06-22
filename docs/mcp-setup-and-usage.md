# MCP Setup And Usage

CodeGraph runs as a stdio MCP server backed by the repository-local SQLite database at `.codegraph/graph.sqlite`.

## Install

```powershell
npm ci
npm run build
```

## Prepare A Repo

```powershell
node dist/cli.js setup --root "D:\path\to\repo"
```

This creates:

```text
D:\path\to\repo\.codegraph\graph.sqlite
D:\path\to\repo\.codegraph\artifacts\<workspace-key>\context-index.v1.json
D:\path\to\repo\.codegraph\setup-state.json
```

## Run MCP

```powershell
node dist/cli.js mcp --root "D:\path\to\repo"
```

The MCP proxy:

- completes the stdio handshake in the MCP process;
- opens the SQLite graph directly;
- serves tools through `V2QueryService`;
- uses the embedded artifact only as degraded fallback when SQLite graph context is unavailable;
- optionally refreshes stale snapshots inline when configured.

## Client Config

Generic MCP config:

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "node",
      "args": ["D:/path/to/code-graph/dist/cli.js", "mcp", "--root", "D:/path/to/repo"]
    }
  }
}
```

If `codegraph` is on `PATH`:

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph",
      "args": ["mcp", "--root", "${workspaceFolder}"]
    }
  }
}
```

By default the MCP server uses the client profile: agents only see
`codegraph_context`, `codegraph_slice`, and `codegraph_status` in `tools/list`.
The MCP `initialize` instructions explain that `codegraph_context` is the first
tool and routes internally to the right pack. Use `--mcp-profile full` only for
benchmarks or clients that intentionally need direct pack/follow-up tools.

## Useful Flags

| Flag | Use |
| --- | --- |
| `--prewarm` | Allow MCP to index a missing workspace during startup/runtime. Prefer explicit `setup` for normal use. |
| `--auto-refresh` | Refresh stale snapshots before tool calls when safe. |
| `--refresh-on-start` | Queue a background refresh after MCP starts. |
| `--watch` | Watch files and refresh changed paths after edits. |
| `--warn-stale` | Include freshness warnings in every tool response. `codegraph_context` already warns on stale indexes by default. |
| `--mcp-profile <client|minimal|research|change|review|full>` | Control the exposed `tools/list` surface. Default/client exposes only facade tools; `full` exposes every direct pack and follow-up tool. |
| `--workspace-key <key>` | Use a stable identity when roots are mounted through unusual paths. |

## Daily Workflow

```powershell
node dist/cli.js setup --root "D:\path\to\repo"
node dist/cli.js mcp --root "D:\path\to\repo"
```

After pulls, checkouts, or large edits:

```powershell
node dist/cli.js index --root "D:\path\to\repo"
```

During active local editing:

```powershell
node dist/cli.js mcp --root "D:\path\to\repo" --watch --auto-refresh
```

## Health And Logs

```powershell
node dist/cli.js doctor --root "D:\path\to\repo"
node dist/cli.js upgrade-audit --root "D:\path\to\repo" --min-score 90 --min-grade B+ --all --json
node dist/cli.js upgrade-audit --root "D:\path\to\repo" --max-slow-ms 5000 --require-ready --require-fresh --all --json
node dist/cli.js upgrade-audit --root "D:\path\to\repo" --max-slow-ms 5000 --max-slow-ms-p95 3000 --require-ready --require-fresh --all --json
node dist/cli.js upgrade-audit --root "D:\path\to\repo" --max-invalid-lines 2 --require-ready --require-fresh --all --json
node dist/cli.js upgrade-audit --root "D:\path\to\repo" --max-stale-queries 0 --max-degraded-queries 1 --require-ready --require-fresh --all --json
node dist/cli.js upgrade-audit --root "D:\path\to\repo" --max-stale-ratio 0 --max-degraded-ratio 1.5 --require-ready --require-fresh --all --json
node dist/cli.js upgrade-audit --root "D:\path\to\repo" --policy ".codegraph/upgrade-audit.json" --require-ready --require-fresh --all --json
node dist/cli.js logs --root "D:\path\to\repo" --tail 50
node dist/cli.js logs --root "D:\path\to\repo" --summary --since "2026-06-22T00:00:00Z"
node dist/cli.js logs --root "D:\path\to\repo" --summary --since "2026-06-22T00:00:00Z" --until "2026-06-22T00:05:00Z"
node dist/cli.js logs --root "D:\path\to\repo" --summary --tool "codegraph_context"
node dist/cli.js logs --root "D:\path\to\repo" --all --event "query"
node dist/cli.js logs --root "D:\path\to\repo" --summary --event "query" --tool "codegraph_context" --since "2026-06-22T00:00:00Z"
node dist/cli.js logs --root "D:\path\to\repo" --event "watch"
node dist/cli.js logs --root "D:\path\to\repo" --invalid --event "query"
```

`doctor` and MCP `codegraph_status` return the same readiness fields:

- `state`: `ready`, `artifact_only`, `unindexed`, `missing`, or `invalid`.
- `capabilities`: which local context paths are usable now.
- `freshness`: stale-index detection based on the indexed git head and dirty hash.
- `nextActions`: the exact `setup` or `index` command to run when attention is needed.
`upgrade-audit` adds a deterministic health score plus a VIP grade (`A+` to `F`)
  when `codegraph upgrade-audit` is used. You can enforce CI policy with
  `--min-score` or `--min-grade` (or use `CODEGRAPH_UPGRADE_AUDIT_MIN_SCORE` /
  `CODEGRAPH_UPGRADE_AUDIT_MIN_GRADE` environment variables). You can also use
  `--policy <path>` (or `CODEGRAPH_UPGRADE_AUDIT_POLICY`) to load policy thresholds
  from JSON in the workspace.
  Use
`--max-slow-ms` (or `CODEGRAPH_UPGRADE_AUDIT_MAX_SLOW_MS`) to enforce hard latency
ceilings for sampled query windows, and `--max-slow-ms-p95` (or
`CODEGRAPH_UPGRADE_AUDIT_MAX_SLOW_MS_P95`) to enforce p95 latency stability. Use
`--max-invalid-lines` (or `CODEGRAPH_UPGRADE_AUDIT_MAX_INVALID_LINES`) to fail
when malformed JSON rows appear in the selected window.
Use `--max-stale-queries` (or `CODEGRAPH_UPGRADE_AUDIT_MAX_STALE_QUERIES`) and
`--max-degraded-queries` (or `CODEGRAPH_UPGRADE_AUDIT_MAX_DEGRADED_QUERIES`) to bound
quality regressions in the selected log window. Use `--max-stale-ratio` and
`--max-degraded-ratio` (or `CODEGRAPH_UPGRADE_AUDIT_MAX_STALE_RATIO` /
`CODEGRAPH_UPGRADE_AUDIT_MAX_DEGRADED_RATIO`) to cap ratio-based drift in CI windows
that vary in volume.

`logs` reads `.codegraph/logs/query.jsonl`, which is created by MCP tool
calls. Entries include route, duration, response size, stale-index state, and
opt-in debug timing summaries when present. `codegraph_status` entries include
readiness state and capability summaries. Use `--summary` for quick counts by
tool, stale/degraded/fallback totals, and slowest calls. Supported events are
`query` and `watch` namespaces (for example `watch`, `watch.refresh.failed`).
`watch` is useful for filtering watcher startup/health noise, while query filters
all answerable/facade calls. Pair `--summary` with
`--since` to narrow audits after a regression window or deployment event, and
`--tool` to focus on one facade/follow-up tool only. CLI benchmark/query paths
may not create this log.

## Recommended Tool Flow

Use the facade first, then drill down only when the packet asks for exact
follow-up evidence:

1. `codegraph_context` first for repository questions, investigations, PBI
   evidence, planning, changes, request-flow tracing, or review.
2. Answer directly when the packet says it is sufficient or answerable.
3. `codegraph_slice` / `get_file_slice` only for exact file, line, or symbol
   evidence named by the packet.
4. `search_symbol`, `search_files`, or `search_code` only for specific missing
   facts named by the packet.
5. `codegraph_status` / `get_index_stats` when results look stale or incomplete.

`codegraph_context` includes stale-index warnings by default so first packets do
not silently rely on old graph facts. Pass `warnStale: false` only for the
smallest possible packet, or start MCP with `--warn-stale` to apply freshness
checks to every tool.

For slow composite packets, pass `debugTiming: true` to `codegraph_context`
change tasks, `simulate_patch_impact`, or `get_change_pack`. The response
includes phase durations such as context packet, call expansion, field impact,
and response budgeting only when this flag is set.

## Troubleshooting

### MCP starts but tools say the workspace is missing

Run:

```powershell
node dist/cli.js setup --root "D:\path\to\repo"
```

Or start MCP with `--prewarm` if runtime indexing is acceptable.

### Results look stale

Run:

```powershell
node dist/cli.js index --root "D:\path\to\repo"
```

Or use `--auto-refresh`.

### SQLite database is locked

Only one writer can index a repository at a time. Stop overlapping `setup`, `index`, or MCP auto-refresh processes for that same root.

### `.codegraph` appears in git status

Add:

```gitignore
.codegraph/
```
