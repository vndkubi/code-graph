# CodeGraph MCP Setup and Usage Guide

This guide explains how to run CodeGraph as an MCP server, how to prewarm indexes, and how to keep answers correct when files or branches change.

## Mental Model

CodeGraph has three local pieces:

| Piece | Purpose |
| --- | --- |
| MCP stdio proxy | The process launched by VS Code, Copilot CLI, Codex CLI, or another MCP client. |
| Local daemon | The long-running process that owns workspace registration, refreshes, and query routing. |
| Postgres database | The persistent semantic index, parse cache, snapshots, symbols, imports, calls, endpoints, and dependency graph. |

Each MCP client passes a workspace root. The daemon maps that root, or a configured `CODEGRAPH_WORKSPACE_KEY`, to a workspace record in Postgres. Queries always read a completed snapshot, so a failed or in-progress refresh does not expose a partial index.

## Local Setup Without Docker

Use local Node when you want the fastest experience on a normal workstation, especially for large repositories on Windows where Docker Desktop bind mounts can be slower.

### Prerequisites

- Node.js 20 or newer.
- npm.
- Docker only for the local Postgres service, unless you already run Postgres elsewhere.
- A source repository to index.

### 1. Start Postgres

```powershell
docker compose -f compose.postgres.yml up -d
```

The default local database URL is:

```text
postgres://codegraph:codegraph_local@127.0.0.1:54329/codegraph
```

### 2. Install And Build CodeGraph

```powershell
npm ci
npm run build
```

### 3. Cold Index A Workspace

```powershell
node dist/cli.js index --root "D:\Personal\Projects\hadoop" --parse-workers 8
```

Use `--workspace-key` when the same repository can appear under different container paths or when you want a stable explicit identity:

```powershell
node dist/cli.js index `
  --root "D:\Personal\Projects\hadoop" `
  --workspace-key "D:/Personal/Projects/hadoop" `
  --parse-workers 8
```

### 4. Run The MCP Server

```powershell
node dist/cli.js mcp --root "D:\Personal\Projects\hadoop"
```

This command is an MCP stdio server. It normally stays running and waits for an MCP client instead of printing a success message and exiting.

For daily use, configure your editor or agent to launch the MCP command instead of running it manually.

## Docker Setup

Use Docker when the MCP server must run in a container or when you need a portable runtime. Keep Postgres persistent and keep `/codegraph-home` persistent so daemon metadata and logs survive container restarts.

### 1. Build The Image

```powershell
docker --context desktop-linux build -t mcp-code-graph:latest .
```

If your active Docker context already points at Docker Desktop Linux, plain `docker build -t mcp-code-graph:latest .` is enough.

### 2. Start Postgres And Cache Volume

```powershell
docker compose -f compose.postgres.yml up -d
docker --context desktop-linux volume create codegraph-cache
```

### 3. Prewarm A Repository

```powershell
docker --context desktop-linux run --rm `
  -v "D:/Personal/Projects/hadoop:/workspace:ro" `
  -v "codegraph-cache:/codegraph-home" `
  -e "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/hadoop" `
  -e "CODEGRAPH_DATABASE_URL=postgres://codegraph:codegraph_local@host.docker.internal:54329/codegraph" `
  -e "CODEGRAPH_PG_POOL_MAX=10" `
  mcp-code-graph:latest `
  index --root /workspace --parse-workers 8
```

Every Docker run sees the source repository as `/workspace`, so set `CODEGRAPH_WORKSPACE_KEY` to a unique host path or stable name for each repository or worktree.

### 4. Run The Docker MCP Server

```powershell
docker --context desktop-linux run --rm -i `
  -v "D:/Personal/Projects/hadoop:/workspace:ro" `
  -v "codegraph-cache:/codegraph-home" `
  -e "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/hadoop" `
  -e "CODEGRAPH_DATABASE_URL=postgres://codegraph:codegraph_local@host.docker.internal:54329/codegraph" `
  -e "CODEGRAPH_PG_POOL_MAX=10" `
  mcp-code-graph:latest `
  mcp --root /workspace
```

Add `--auto-refresh` only when you want the first tool call after a small stale change to refresh the snapshot inline. For large repositories, prewarm manually after a branch checkout or large pull.

## MCP Client Configuration

### VS Code Or GitHub Copilot

Use a local Node command when CodeGraph is installed on the host:

```jsonc
{
  "mcp": {
    "servers": {
      "codegraph": {
        "command": "node",
        "args": [
          "D:/Personal/Projects/code-graph/dist/cli.js",
          "mcp",
          "--root",
          "${workspaceFolder}",
          "--watch"
        ]
      }
    }
  }
}
```

Use Docker when the MCP runtime should be containerized:

```jsonc
{
  "mcp": {
    "servers": {
      "codegraph": {
        "command": "docker",
        "args": [
          "--context",
          "desktop-linux",
          "run",
          "--rm",
          "-i",
          "-v",
          "${workspaceFolder}:/workspace:ro",
          "-v",
          "codegraph-cache:/codegraph-home",
          "-e",
          "CODEGRAPH_WORKSPACE_KEY=${workspaceFolder}",
          "-e",
          "CODEGRAPH_DATABASE_URL=postgres://codegraph:codegraph_local@host.docker.internal:54329/codegraph",
          "-e",
          "CODEGRAPH_PG_POOL_MAX=10",
          "mcp-code-graph:latest",
          "mcp",
          "--root",
          "/workspace"
        ]
      }
    }
  }
}
```

### GitHub Copilot CLI

Create or edit `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "codegraph-hadoop": {
      "command": "node",
      "args": [
        "D:/Personal/Projects/code-graph/dist/cli.js",
        "mcp",
        "--root",
        "D:/Personal/Projects/hadoop",
        "--workspace-key",
        "D:/Personal/Projects/hadoop"
      ]
    }
  }
}
```

For Docker-backed Copilot CLI, use the Docker command from the VS Code example and keep the same `CODEGRAPH_WORKSPACE_KEY` used during prewarm.

### Codex CLI

Add one MCP server per project or worktree:

```toml
[mcp_servers.codegraph_hadoop]
command = "node"
args = [
  "D:/Personal/Projects/code-graph/dist/cli.js",
  "mcp",
  "--root",
  "D:/Personal/Projects/hadoop",
  "--workspace-key",
  "D:/Personal/Projects/hadoop"
]
```

For two branches open at the same time, create two entries that point at two different worktree paths and use two different workspace keys.

## Use Cases

### First Cold Index Or Prewarm

Run an explicit index before connecting the MCP client:

```powershell
node dist/cli.js index --root "D:\Personal\Projects\hadoop" --parse-workers 8
```

This builds a full snapshot and writes parse cache, symbols, imports, call edges, endpoints, dependencies, and snapshot stats to Postgres.

### Warm Unchanged Workspace

Run the same index command again. CodeGraph should reuse file hashes, parse cache, and existing snapshot data where possible. This is useful after restarting the daemon or after a machine reboot.

### Edit One File On The Current Branch

Recommended setup:

```powershell
node dist/cli.js mcp --root "D:\Personal\Projects\hadoop" --watch
```

With `--watch`, filesystem changes are batched and refreshed with path-delta indexing. Small edits update only the changed paths and deletions instead of rebuilding the whole workspace.

If you do not use `--watch`, ask the tool with `autoRefresh: true` or run:

```powershell
node dist/cli.js index --root "D:\Personal\Projects\hadoop"
```

### Delete Or Rename Files

Use `--watch` for normal local edits. The watcher sends changed and deleted paths to the daemon, and CodeGraph refreshes the current snapshot with path-delta indexing when the change set is small.

For large rename waves or generated-file churn, run an explicit full refresh:

```powershell
node dist/cli.js index --root "D:\Personal\Projects\hadoop"
```

### Checkout A New Branch In The Same Folder

After a branch checkout, the filesystem may change too much for inline refresh. For correctness on large repositories, prewarm manually:

```powershell
git -C "D:\Personal\Projects\hadoop" checkout feature/my-branch
node dist/cli.js index --root "D:\Personal\Projects\hadoop" --parse-workers 8
```

If MCP is already running with the same workspace key, later tool calls read the new completed snapshot from Postgres. Restarting the MCP client is usually not required.

### Pull, Rebase, Or Generate Many Files

Run an explicit index after the operation:

```powershell
git -C "D:\Personal\Projects\hadoop" pull --rebase
node dist/cli.js index --root "D:\Personal\Projects\hadoop" --parse-workers 8
```

This avoids stale answers and avoids paying a large refresh cost inside the first MCP query.

### Two Branches At The Same Time

Use `git worktree` or separate clones. Do not open two branches from one filesystem folder at the same time.

```powershell
git -C "D:\Personal\Projects\hadoop" worktree add "D:\Personal\Projects\hadoop-feature" feature/my-branch

node dist/cli.js index --root "D:\Personal\Projects\hadoop" --workspace-key "hadoop-main"
node dist/cli.js index --root "D:\Personal\Projects\hadoop-feature" --workspace-key "hadoop-feature"
```

Configure one MCP server per worktree. Each worktree gets its own current snapshot while sharing the same Postgres database and parse cache.

### Multiple Repositories

Use one Postgres service and one daemon per machine. Give each repository a unique root or workspace key:

```powershell
node dist/cli.js index --root "D:\Personal\Projects\hadoop" --workspace-key "D:/Personal/Projects/hadoop"
node dist/cli.js index --root "D:\Personal\Projects\elasticsearch" --workspace-key "D:/Personal/Projects/elasticsearch"
```

## Correctness Rules

| Situation | Recommended behavior |
| --- | --- |
| Small local edit | Use `--watch`, or query with `autoRefresh: true`. |
| Single file delete | Use `--watch`; path-delta refresh removes the deleted file from the snapshot. |
| Branch checkout in a large repo | Run explicit `index --root ...` after checkout. |
| Large pull, rebase, or generated-file burst | Run explicit `index --root ...`; avoid inline refresh during the first query. |
| Two branches at once | Use worktrees or separate clones with different workspace keys. |
| Docker `/workspace` mount | Always set a stable unique `CODEGRAPH_WORKSPACE_KEY`. |

`--auto-refresh` checks freshness before tool calls and can refresh stale snapshots inline. It skips inline refresh when the indexed file count exceeds `CODEGRAPH_AUTO_REFRESH_FILE_LIMIT` and returns a warning instead. Raise that limit only if you accept slower first-query latency.

## Tool Selection

| Task | First tool |
| --- | --- |
| Architecture or read-only research | `get_research_pack` |
| Understand execution flow | `get_flow_pack` |
| Implement, debug, or refactor | `get_change_pack` |
| Review a patch or diff | `review_patch` |
| Find a class, method, config key, or endpoint symbol | `search_symbol` |
| Find relevant files by path, role, symbols, or endpoints | `search_files` |
| Find callers, callees, imports, or definitions | `find_references`, `get_callers`, `get_callees` |
| Trace dependencies or dependents | `trace_dependencies` |
| Inspect index health | `get_index_stats` |

Prefer one bounded pack tool before opening many source files. Use granular search and slice tools only for missing facts or exact edit context.

## Verify That The MCP Is Used

Ask the agent a direct tool check:

```text
Use the CodeGraph MCP tool get_index_stats and tell me the indexed file count.
```

Then inspect the daemon log:

```powershell
node dist/cli.js logs --tail 50
```

If the log contains an event with `toolName`, the MCP tool was called.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `filesTotal` is `0` in Docker | Docker sees an empty `/workspace` mount | Share the drive in Docker Desktop, fix the bind mount, and rerun `index --root /workspace`. |
| Every Docker repo looks like the same workspace | Missing or reused `CODEGRAPH_WORKSPACE_KEY` | Set a unique host path or stable key per repo or worktree. |
| MCP answers from an old branch | Snapshot was not refreshed after checkout | Run explicit `index --root ...` with the same workspace key. |
| First query after checkout is slow | `--auto-refresh` is doing the refresh inline | Prewarm manually after checkout. |
| `connect ECONNREFUSED 127.0.0.1:54329` | Postgres is not running | Run `docker compose -f compose.postgres.yml up -d`. |
| Docker cannot reach Postgres on `127.0.0.1` | Container localhost is not host localhost | Use `host.docker.internal` from Docker containers. |
| Docker cold index is very slow on Windows | Docker Desktop bind mount overhead | Prefer local Node, WSL/ext4, or Linux-native source paths for large repositories. |
| MCP starts but the agent does not use it | Client config points to the wrong command or server | Ask for `get_index_stats`, then check `node dist/cli.js logs --tail 50`. |
| `autoRefresh=true` does not build the first snapshot | Auto-refresh is for existing snapshots, not empty first-time indexes | Run explicit `index --root ...` once before using MCP. |

