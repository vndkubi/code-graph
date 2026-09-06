# Migration Guide: Two MCP Servers → One Fused Server

TokenOpt/ContextGate was **fused into CodeGraph**: one npm package, one MCP
server, one CLI, with CodeGraph as the base. This guide covers moving an existing
setup that ran CodeGraph and TokenOpt as two separate MCP servers onto the single
fused server.

> This reverses the earlier separation plan. The old
> `tokenopt-separation-and-mcp-plan.md` carries a SUPERSEDED banner.

## Why

On a host with several MCP servers, two overlapping servers (CodeGraph +
TokenOpt) caused:

- **Decision overload** — the agent faced two overlapping toolsets and defaulted
  to native file reads, so token savings never materialized.
- **Double-spend** — both servers served overlapping evidence for the same files
  (file-level vs symbol-level of the same files), doubling tokens and tool
  descriptions in the system prompt.

The root cause was *instruction + duplicate evidence slot*, not the raw number of
servers. Fusing them yields **one evidence slot per source** and a single tool
surface. The ContextGate broker now calls the CodeGraph query engine in-process,
so there is no subprocess spawn and no second server to install.

## What changed

| Before (two servers) | After (fused) |
| --- | --- |
| Separate `codegraph` and `tokenopt`/`contextgate` MCP servers | One `codegraph mcp` server exposing both surfaces |
| ContextGate spawned the `codegraph` CLI as a subprocess to enrich packets | ContextGate calls `V2QueryService` **in-process** (subprocess kept only as a standalone-hook fallback) |
| `tokenopt mcp` to run the gate server | `codegraph mcp` runs both; `codegraph gate mcp` is rejected |
| `tokenopt <…>` CLI for hooks/instructions/doctor | `codegraph gate <…>` (the `tokenopt` bin alias is preserved) |
| Two sets of tool descriptions in the system prompt | One combined `tools/list` and one merged instruction block |

## Steps

### 1. Update MCP client config

Register **only** `codegraph`. Remove the separate `tokenopt` / `contextgate`
server entry:

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

If you keep a stale second server, you reintroduce exactly the decision-overload
and double-spend this fusion removes.

### 2. Map the gate CLI

| Old | New |
| --- | --- |
| `tokenopt doctor` | `codegraph gate doctor` |
| `tokenopt report` | `codegraph gate report` |
| `tokenopt exec -- <command>` | `codegraph gate exec -- <command>` |
| `tokenopt mcp` | `codegraph mcp` (the fused server) |

The standalone-era agent integrations (`hook codex|copilot`, `install codex`,
`setup copilot`, `instructions …`) and the TokenOpt benchmark harnesses
(`benchmark suite|workflow-ab|codex-daily`) were removed after the fusion:
agents connect to the fused MCP server directly instead of being wired through
per-host hooks, and measurement lives in `codegraph benchmark …`.

### 3. Profiles and modes

Tool exposure is unified under the CodeGraph profile, with a TokenOpt override:

- `--mcp-profile client` (default) → **4 facade tools**: `codegraph_context`,
  `codegraph_slice`, `codegraph_checkpoint`, `codegraph_status`. Single-gate surface —
  `codegraph_context` routes into the TokenOpt evidence flow internally.
- `--mcp-profile full` → full CodeGraph + full TokenOpt surface.
- `TOKENOPT_MCP_MODE` — unset (default): embedded TokenOpt gate tools hidden on
  every profile except `full`; `lite|full|broker` forces that gate set on any
  profile (`broker` = `contextgate_get_context` only); `off` hides it even on
  `full`.

### 4. Verify

```powershell
node dist/cli.js mcp --root "<repo>"        # one server, both surfaces
node dist/cli.js gate doctor                # gate wiring OK
```

In `client` profile, `tools/list` should show exactly `codegraph_context`,
`codegraph_slice`, and `codegraph_status`; `contextgate_get_context` appears
only on `full` profile or with `TOKENOPT_MCP_MODE` set.

## Note on the earlier SQLite migration

The pre-fusion CodeGraph already removed its daemon, localhost HTTP API, and
Postgres dependency in favor of a per-repo SQLite database at
`<repo>/.codegraph/graph.sqlite` (`better-sqlite3`). That is the current and only
runtime model — see [Architecture](ARCHITECTURE.md). Nothing in the fusion
changes it; the gate simply queries that same engine in-process.
