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

## Useful Flags

| Flag | Use |
| --- | --- |
| `--prewarm` | Allow MCP to index a missing workspace during startup/runtime. Prefer explicit `setup` for normal use. |
| `--auto-refresh` | Refresh stale snapshots before tool calls when safe. |
| `--refresh-on-start` | Queue a background refresh after MCP starts. |
| `--watch` | Watch files and refresh changed paths after edits. |
| `--warn-stale` | Include freshness warnings in tool responses. |
| `--workspace-key <key>` | Use a stable identity when roots are mounted through unusual paths. |

## Daily Workflow

```powershell
node dist/cli.js setup --root "D:\path\to\repo"
node dist/cli.js mcp --root "D:\path\to\repo" --warn-stale
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
node dist/cli.js logs --root "D:\path\to\repo" --tail 50
```

`logs` reads `.codegraph/logs/query.jsonl`, which is created by MCP tool calls. CLI benchmark/query paths may not create this log.

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
