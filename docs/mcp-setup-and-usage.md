# MCP Setup And Usage

CodeGraph runs as a single stdio MCP server backed by the repo-local SQLite
database at `.codegraph/graph.sqlite`. Since the TokenOpt fusion, that same
server also exposes the ContextGate evidence-gate tools — there is no second
server to install. See [Architecture](ARCHITECTURE.md) for how the two surfaces
share one process.

## Install

```powershell
npm ci
npm run build
```

## Prepare a repo

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

The server:

- completes the stdio handshake in-process;
- opens the SQLite graph directly and serves CodeGraph packs through `V2QueryService`;
- serves the ContextGate gate tools and enriches their packets with `code_graph`
  evidence **in-process** (no subprocess);
- uses the embedded artifact only as degraded fallback when the SQLite graph is
  unavailable;
- optionally refreshes stale snapshots inline when configured.

## Client config

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

> Register **only this one server**. If you previously configured a separate
> `tokenopt` / `contextgate` MCP server, remove it — its tools are now served
> here. See [Migration](MIGRATION.md).

## Tool exposure: profiles and modes

The exposed `tools/list` surface is controlled by the MCP profile and an optional
TokenOpt mode override.

| Control | Values | Effect |
| --- | --- | --- |
| `--mcp-profile` | `client` (default), `minimal`, `research`, `change`, `review`, `full` | Width of the CodeGraph surface. `client` exposes `codegraph_context` / `codegraph_slice` / `codegraph_status`; `full` exposes every direct pack and follow-up tool. |
| TokenOpt mode | derived: `client`/narrow profiles → `lite`; `full` → `full` | Width of the gate surface bundled in. |
| `TOKENOPT_MCP_MODE` | `lite`, `full`, `broker` | Overrides the gate set. `broker` exposes only `contextgate_get_context`. |

Observed surfaces:

- **`client` profile** (default) → **7 tools**: 3 CodeGraph (`codegraph_context`,
  `codegraph_slice`, `codegraph_status`) + the ContextGate lite gate
  (`contextgate_get_context`, `tokenopt_compile_evidence`, `tokenopt_search`,
  `tokenopt_read_file`).
- **`full` profile** → **45 tools**: the full CodeGraph pack/follow-up surface +
  the full TokenOpt surface (17 gate tools incl. `tokenopt_session_stats`,
  `tokenopt_project_facts`, `tokenopt_run_command`, …).

Use `full` only for benchmarks or power-user clients that intentionally need
direct pack tools; agents should prefer the default `client` profile.

## Useful flags

| Flag | Use |
| --- | --- |
| `--prewarm` | Allow MCP to index a missing workspace at startup/runtime. Prefer explicit `setup`. |
| `--auto-refresh` | Refresh stale snapshots before tool calls when safe. |
| `--refresh-on-start` | Queue a background refresh after MCP starts. |
| `--watch` | Watch files and refresh changed paths after edits. |
| `--warn-stale` | Apply freshness warnings to every tool response (`codegraph_context` already warns by default; `--no-warn-stale` opts out). |
| `--mcp-profile <client\|minimal\|research\|change\|review\|full>` | Control the exposed surface (see above). |
| `--workspace-key <key>` | Stable identity when roots are mounted through unusual paths. |

## Recommended agent tool flow

Because both surfaces live in one server, the agent picks the entry tool by
intent — it does not coordinate two servers.

**Broad / unknown-owner tasks** (investigation, architecture, PBI impact, planning,
request-flow tracing, review):

1. Call `contextgate_get_context` with the full natural task.
2. If `answerable=true` (or the broker says `answer_now`), answer from the packet.
3. Otherwise fill the named gaps: `code_graph` gap → `codegraph_context`;
   `file_read` gap → `codegraph_slice` with the known path; `search` gap →
   `search_symbol` / `tokenopt_search`. The gate already folds in `code_graph`
   evidence when `codegraph.enabled`.

**Concrete diff / PR / changed-file review:**

1. Round 1 (business): `contextgate_get_context` + `get_change_pack` for
   requirement/impact evidence.
2. Round 2 (technical YAGNI/KISS): direct diff review, no MCP.
3. Round 3 (checklist): `get_change_pack` only for changed-file coverage.

**Exact known file/symbol:** skip the gate and read directly — a narrow read is the
cheapest path.

`codegraph_context` includes stale-index warnings by default. Pass
`warnStale: false` only for the smallest possible packet. For slow composite
packets pass `debugTiming: true` to `codegraph_context` change tasks,
`simulate_patch_impact`, or `get_change_pack`.

## Daily workflow

```powershell
node dist/cli.js setup --root "D:\path\to\repo"   # once per repo
node dist/cli.js mcp   --root "D:\path\to\repo"   # serve
node dist/cli.js index --root "D:\path\to\repo"   # after pulls / checkouts / big edits
node dist/cli.js mcp   --root "D:\path\to\repo" --watch --auto-refresh   # active editing
```

## Health and logs

```powershell
node dist/cli.js doctor --root "D:\path\to\repo"
node dist/cli.js status --root "D:\path\to\repo" --json
node dist/cli.js upgrade-audit --root "D:\path\to\repo" --min-grade B+ --require-ready --require-fresh --all --json
node dist/cli.js logs   --root "D:\path\to\repo" --tail 50
node dist/cli.js logs   --root "D:\path\to\repo" --summary --tool "codegraph_context"
```

`doctor` and MCP `codegraph_status` share a readiness contract:

- `state`: `ready`, `artifact_only`, `unindexed`, `missing`, or `invalid`.
- `capabilities`: which local context paths are usable now.
- `freshness`: stale-index detection from the indexed git head and dirty hash.
- `nextActions`: the exact `setup` or `index` command to run when attention is needed.

`upgrade-audit` adds a deterministic health score plus an `A+`–`F` grade; enforce
CI policy with `--min-score` / `--min-grade`, latency ceilings with `--max-slow-ms`
/ `--max-slow-ms-p95`, and quality caps with `--max-stale-ratio` /
`--max-degraded-ratio`. Thresholds can also live in `.codegraph/upgrade-audit.json`
via `--policy` (or `CODEGRAPH_UPGRADE_AUDIT_POLICY`).

`logs` reads `.codegraph/logs/query.jsonl`, written by MCP tool calls. Use
`--summary` for counts by tool plus stale/degraded/fallback totals, and `--since`
/ `--until` / `--tool` / `--event` to scope a window.

## Gate CLI (hooks, instructions, doctor)

The TokenOpt operational surface — hook adapters, instruction emit/install,
exec wrapping, and gate-specific doctors — is reached through `codegraph gate <…>`.
See the [CLI reference](cli.md#gate-subcommands). `codegraph gate mcp` is
intentionally rejected; run the fused server with `codegraph mcp`.

## Troubleshooting

**Tools say the workspace is missing** — run `setup --root <repo>` (or start with
`--prewarm` if runtime indexing is acceptable).

**Results look stale** — run `index --root <repo>` (or use `--auto-refresh`).

**SQLite database is locked** — only one writer can index a root at a time; stop
overlapping `setup` / `index` / auto-refresh processes for the same root.

**`.codegraph` appears in git status** — add `.codegraph/` to `.gitignore`.

**You still see a separate tokenopt/contextgate server** — remove that MCP entry;
the gate tools are served by `codegraph mcp` now. See [Migration](MIGRATION.md).
