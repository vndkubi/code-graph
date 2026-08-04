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

## Running alongside GitHub / Jira / Confluence MCP servers

A tool the model cannot see is a tool it will not call. Every major client now
hides MCP tools once the combined surface gets large, and a GitHub or Atlassian
server alone can carry dozens of tools. CodeGraph's three tools lose that
competition by default — not on merit, but on visibility. Each client needs one
setting:

**Claude Code** defers MCP tools behind a tool-search step by default (requires
v2.1.121+ for `alwaysLoad`). Opt the three-tool surface back into the initial
tool list:

```json
{
  "mcpServers": {
    "codegraph": {
      "type": "stdio",
      "command": "codegraph",
      "args": ["mcp", "--root", "${workspaceFolder}", "--mcp-profile", "client"],
      "alwaysLoad": true
    }
  }
}
```

`ENABLE_TOOL_SEARCH=auto` is the broader alternative: it loads schemas upfront
while they fit inside ~10% of the context window and defers only the overflow.
Keep `--mcp-profile client` — `full` puts 28 tools in the initial list and gives
back the context `alwaysLoad` just bought.

**VS Code Copilot** caps a request at 128 tools and groups the excess into
"virtual tools" the model must activate before it can call anything inside. With
a GitHub and an Atlassian server connected you are usually over that line, so
CodeGraph ends up behind a group. Either raise
`github.copilot.chat.virtualTools.threshold`, or disable the tools you do not
use on the other servers from the chat tools picker.

**Codex** filters per server in `~/.codex/config.toml`. Trim the competing
surfaces rather than growing yours:

```toml
[mcp_servers.github]
enabled_tools = ["get_issue", "get_pull_request", "list_pull_requests"]
```

**All clients:** run `codegraph onboard` so the routing block lands in
`CLAUDE.md` and `.github/copilot-instructions.md`. Instruction files are never
deferred, never truncated, and never grouped — when the tool surface is crowded
they are the only channel that always reaches the model.

**External-artifact tasks.** A task phrased as "implement JIRA-1234" reads as an
external-artifact task, and agents routinely fetch the ticket and then fall back
to grep instead of asking the code graph. Fetch the artifact with the Jira,
Confluence or GitHub tool first, then pass its body to `codegraph_context` as
the task text. The generated instruction files state this rule.

## Tool exposure: profiles and modes

The exposed `tools/list` surface is controlled by the MCP profile and an optional
TokenOpt mode override. The default is a **single-gate surface**: one entry point
(`codegraph_context`) instead of several competing "call me first" tools — models
pick tools more reliably when exactly one claims the first call
(docs/mcp-adoption-plan.md, Phase 2).

| Control | Values | Effect |
| --- | --- | --- |
| `--mcp-profile` | `client` (default), `minimal`, `research`, `change`, `review`, `full` | Width of the CodeGraph surface. `client` exposes `codegraph_context` / `codegraph_slice` / `codegraph_status`; `full` exposes every direct pack and follow-up tool. |
| `TOKENOPT_MCP_MODE` | unset (default), `lite`, `full`, `broker`, `off` | Embedded TokenOpt/ContextGate gate tools. Unset → hidden on every profile except `full`; `lite`/`full`/`broker` force that gate set on any profile; `off` hides it even on `full`. |

Observed surfaces:

- **`client` profile** (default) → **3 tools**: `codegraph_context`,
  `codegraph_slice`, `codegraph_status`. The TokenOpt evidence flow still runs —
  `codegraph_context` routes into the same packs internally.
- **`full` profile** → the full CodeGraph pack/follow-up surface + the full
  TokenOpt gate surface (`contextgate_get_context`, `tokenopt_*`).

Use `full` (or `TOKENOPT_MCP_MODE`) only for benchmarks or power-user clients
that intentionally need direct pack/gate tools; agents should get the default
`client` profile.

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

One entry point, by design:

1. Any repo question, or before any edit → `codegraph_context` with the user's
   task verbatim (it classifies the task and routes to the right pack —
   research, flow, change, review, evidence — internally).
2. For review input, include `prUrl` or `baseRef` + `headRef` when possible. A
   GitHub PR URL or “from <base> to <head>” phrase in the task is also parsed;
   MCP resolves an immutable worktree, indexes the head, and batches the review
   before returning the packet.
3. `answerable=true` / `sufficientForAnswer=true` → answer from the packet; do
   not re-verify the same ground with grep/read/shell.
3. Packet names an exact missing file/line/symbol → `codegraph_slice` (batch
   multiple ranges via `slices[]`).
4. Pass the same `sessionId` on every call of a conversation so
   already-delivered evidence is not re-sent.

**Exact known file/symbol:** skip the gate and read directly — a narrow read is
the cheapest path.

**Full profile only** (benchmarks/power users): the direct pack tools and the
ContextGate flow (`contextgate_get_context` first, then gap-filling) are
available, but `codegraph_context` remains the recommended first call for broad
tasks.

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

## Gate CLI (config, exec, report, doctor)

The TokenOpt operational surface reached through `codegraph gate <…>` is
`init`, `exec`, `report`, and `doctor` — config scaffolding, command wrapping
with output compression, session reporting, and gate wiring diagnostics. There
is no hook adapter or instruction installer in this build; that surface lives
only in the standalone TokenOpt repository. See the
[CLI reference](cli.md#gate-subcommands). `codegraph gate mcp` is intentionally
rejected; run the fused server with `codegraph mcp`.

## Troubleshooting

**Tools say the workspace is missing** — run `setup --root <repo>` (or start with
`--prewarm` if runtime indexing is acceptable).

**Results look stale** — run `index --root <repo>` (or use `--auto-refresh`).

**SQLite database is locked** — only one writer can index a root at a time; stop
overlapping `setup` / `index` / auto-refresh processes for the same root.

**`.codegraph` appears in git status** — add `.codegraph/` to `.gitignore`.

**You still see a separate tokenopt/contextgate server** — remove that MCP entry;
the gate tools are served by `codegraph mcp` now. See [Migration](MIGRATION.md).
