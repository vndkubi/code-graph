# GitHub Copilot CLI MCP Config

This guide shows how to connect CodeGraph to GitHub Copilot CLI through
`~/.copilot/mcp-config.json`.

GitHub Copilot CLI uses a top-level `mcpServers` object in this file. This is
different from VS Code settings, which use `mcp.servers`.

The recommended Docker setup is:

1. Build the CodeGraph Docker image.
2. Start the local Postgres service and create the persistent CodeGraph volume.
3. Prewarm the target repository with `index --root /workspace`.
4. Add a Docker-backed CodeGraph entry to `~/.copilot/mcp-config.json`.
5. Verify Copilot can call a CodeGraph tool.

## Docker + Copilot CLI Step By Step

Use Docker when Copilot should run CodeGraph against a repository mounted into a
container. This is useful when your MCP runtime should match a containerized
toolchain. For very large Windows repositories, Docker Desktop bind mounts from
`D:\...` are still slower than WSL/ext4 or local Node, so prewarm manually.

### 1. Build the Docker image

From the CodeGraph checkout:

```powershell
cd D:\Personal\Projects\code-graph
docker --context desktop-linux build -t mcp-code-graph:latest .
```

If your active Docker context is already Docker Desktop Linux, you can omit
`--context desktop-linux`.

### 2. Start Postgres and create the cache volume

CodeGraph stores indexes in Postgres. The Docker container reaches the host
Postgres service through `host.docker.internal`.

```powershell
cd D:\Personal\Projects\code-graph
docker compose -f compose.postgres.yml up -d
docker --context desktop-linux volume create codegraph-cache
```

Use the same `codegraph-cache` volume for prewarm and MCP runs. It stores
daemon metadata and logs; indexed graph rows and parse cache live in Postgres.

### 3. Prewarm the repository

Every Docker run sees the mounted repository as `/workspace`, so set a stable
`CODEGRAPH_WORKSPACE_KEY` to the host repository path. This prevents different
repositories from colliding as the same `/workspace` identity.

Hadoop example:

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

Run the same command again after the cold prewarm if you want to confirm warm
behavior. A healthy warm run should show `skippedUnchanged: true` or
`filesParsed: 0`, with high `hashCacheHits` and/or `parseCacheHits`.

If `filesTotal` is `0`, Docker is not seeing your repository. On Docker Desktop
for Windows, share the drive that contains the repo: Docker Desktop -> Settings
-> Resources -> File Sharing -> add `D:\`, apply, restart, then rerun prewarm.

### 4. Create `mcp-config.json`

On Windows:

```powershell
New-Item -ItemType Directory -Force "$HOME\.copilot"
notepad "$HOME\.copilot\mcp-config.json"
```

On macOS, Linux, or WSL:

```bash
mkdir -p ~/.copilot
$EDITOR ~/.copilot/mcp-config.json
```

Paste this JSON and replace the host path and server name for your repository.
JSON does not allow comments, so keep the file comment-free.

```json
{
  "mcpServers": {
    "codegraph-hadoop": {
      "type": "local",
      "command": "docker",
      "args": [
        "--context",
        "desktop-linux",
        "run",
        "--rm",
        "-i",
        "-v",
        "D:/Personal/Projects/hadoop:/workspace:ro",
        "-v",
        "codegraph-cache:/codegraph-home",
        "-e",
        "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/hadoop",
        "-e",
        "CODEGRAPH_DATABASE_URL=postgres://codegraph:codegraph_local@host.docker.internal:54329/codegraph",
        "-e",
        "CODEGRAPH_PG_POOL_MAX=10",
        "mcp-code-graph:latest",
        "mcp",
        "--root",
        "/workspace",
        "--no-prewarm"
      ],
      "env": {},
      "tools": ["*"]
    }
  }
}
```

Why these options:

- `type: "local"` tells Copilot CLI to start a local STDIO process.
- `command: "docker"` starts CodeGraph through Docker instead of local Node.
- `--context desktop-linux` makes Windows Docker Desktop target explicit.
- `-i` is required because MCP communicates over stdin/stdout.
- `-v <repo>:/workspace:ro` mounts source read-only inside the container.
- `-v codegraph-cache:/codegraph-home` reuses daemon metadata and logs.
- `CODEGRAPH_WORKSPACE_KEY` must match the prewarm command.
- `CODEGRAPH_DATABASE_URL` must use `host.docker.internal` from inside Docker.
- `--no-prewarm` keeps MCP startup fast. Run the explicit prewarm command after
  checkout, pull, rebase, or large generated-file changes.
- MCP does not enable the filesystem watcher or freshness checks by default.
  This keeps Copilot tool calls from paying Docker bind-mount scans or slow
  `git status` checks on every request.

For smaller repos where startup latency is acceptable, replace `--no-prewarm`
with `--auto-refresh` so CodeGraph refreshes stale snapshots on the first tool
call. For large repos, manual prewarm is more predictable.

Use `--watch` only when you want the daemon to queue background refreshes after
local filesystem events. Current watcher refreshes still run a full manifest
scan, so keep it off for very large Docker bind mounts until path-delta
watching is enabled. Use `--warn-stale` only when stale-index metadata is more
important than lowest-latency Copilot responses.

An editable template is also available at
[`examples/copilot-docker-mcp-config.json`](../examples/copilot-docker-mcp-config.json).

### 5. Configure multiple repositories

Add one server entry per host repository or worktree. Keep the names and
`CODEGRAPH_WORKSPACE_KEY` values unique.

```json
{
  "mcpServers": {
    "codegraph-hadoop": {
      "type": "local",
      "command": "docker",
      "args": [
        "--context",
        "desktop-linux",
        "run",
        "--rm",
        "-i",
        "-v",
        "D:/Personal/Projects/hadoop:/workspace:ro",
        "-v",
        "codegraph-cache:/codegraph-home",
        "-e",
        "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/hadoop",
        "-e",
        "CODEGRAPH_DATABASE_URL=postgres://codegraph:codegraph_local@host.docker.internal:54329/codegraph",
        "-e",
        "CODEGRAPH_PG_POOL_MAX=10",
        "mcp-code-graph:latest",
        "mcp",
        "--root",
        "/workspace",
        "--no-prewarm"
      ],
      "env": {},
      "tools": ["*"]
    },
    "codegraph-elasticsearch": {
      "type": "local",
      "command": "docker",
      "args": [
        "--context",
        "desktop-linux",
        "run",
        "--rm",
        "-i",
        "-v",
        "D:/Personal/Projects/elasticsearch:/workspace:ro",
        "-v",
        "codegraph-cache:/codegraph-home",
        "-e",
        "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/elasticsearch",
        "-e",
        "CODEGRAPH_DATABASE_URL=postgres://codegraph:codegraph_local@host.docker.internal:54329/codegraph",
        "-e",
        "CODEGRAPH_PG_POOL_MAX=10",
        "mcp-code-graph:latest",
        "mcp",
        "--root",
        "/workspace",
        "--no-prewarm"
      ],
      "env": {},
      "tools": ["*"]
    }
  }
}
```

Prewarm each repository with the matching mount path and workspace key before
asking Copilot to use it.

### 6. Verify Copilot sees CodeGraph

Start Copilot CLI interactive mode, then run:

```text
/mcp show
/mcp show codegraph-hadoop
```

Ask Copilot for a direct tool call:

```text
Use codegraph MCP tool get_research_pack for "How does Hadoop handle BlockManager.processReport?" with tokenBudget 2000. Do not use shell search first.
```

For a smaller repo, this simpler smoke test is fine:

```text
Use codegraph MCP tool get_index_stats and tell me the indexed file count.
```

Check CodeGraph logs from the Docker volume:

```powershell
docker --context desktop-linux run --rm `
  -v "codegraph-cache:/codegraph-home" `
  -e "CODEGRAPH_DATABASE_URL=postgres://codegraph:codegraph_local@host.docker.internal:54329/codegraph" `
  mcp-code-graph:latest `
  logs --tail 50
```

A real MCP call should produce a log line with `event: "query"` and a
`toolName` such as `get_research_pack`, `get_index_stats`, or `search_symbol`.

### 7. Refresh after checkout or large changes

After `git checkout`, `git pull`, `git rebase`, or generated-file changes, run
the same Docker prewarm command again:

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

The MCP config can stay unchanged because it uses the same workspace key and
Postgres database.

## Optional Local Node Setup

Use local Node when you want the fastest path on the host filesystem and do not
need a containerized runtime.

### 1. Build CodeGraph

```powershell
cd D:\Personal\Projects\code-graph
npm install
npm run build
```

### 2. Prewarm the target repository

```powershell
node D:\Personal\Projects\code-graph\dist\cli.js index `
  --root D:\Personal\Projects\your-repo `
  --workspace-key D:\Personal\Projects\your-repo
```

### 3. Add a local server to `mcp-config.json`

```json
{
  "mcpServers": {
    "codegraph-your-repo": {
      "type": "local",
      "command": "node",
      "args": [
        "D:/Personal/Projects/code-graph/dist/cli.js",
        "mcp",
        "--root",
        "D:/Personal/Projects/your-repo",
        "--workspace-key",
        "D:/Personal/Projects/your-repo",
        "--no-prewarm"
      ],
      "env": {},
      "tools": ["*"]
    }
  }
}
```

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Copilot lists no CodeGraph server | Config file path or JSON shape is wrong. | Use `~/.copilot/mcp-config.json` with top-level `mcpServers`, then run `/mcp show` inside Copilot CLI. |
| Docker says it cannot connect to the daemon | Docker Desktop or the selected Docker context is not running. | Start Docker Desktop and run `docker --context desktop-linux ps`. |
| Index reports `filesTotal: 0` | Docker cannot see the bind mount. | Share the Windows drive in Docker Desktop, verify the host path, then rerun prewarm. |
| First query is slow | The repo was not prewarmed, or `--auto-refresh` is refreshing a stale snapshot. | Run the explicit Docker `index --root /workspace` command before asking Copilot. |
| Copilot terminates with a connection timeout | MCP startup or a tool call is blocked by prewarm, watcher refresh, stale checks, or a missing prewarm snapshot. | Rebuild the latest image, prewarm manually, keep the Copilot entry on `--no-prewarm`, and do not add `--watch`, `--warn-stale`, or `--auto-refresh` for large Docker bind mounts. |
| Answers look stale after checkout | The index still points at the previous checkout. | Run the Docker prewarm command again with the same workspace key. |
| Copilot uses grep/read instead of CodeGraph | The prompt did not request CodeGraph, the MCP server did not start, or tools are disabled by policy. | Ask for a direct CodeGraph tool call and inspect `/mcp show` plus CodeGraph logs. |
| `connect ECONNREFUSED host.docker.internal:54329` | Postgres is not running or the container cannot reach it. | Run `docker compose -f compose.postgres.yml up -d` from the CodeGraph checkout. |

## References

- [Adding MCP servers for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
- [GitHub Copilot CLI command reference: MCP server configuration](https://docs.github.com/copilot/reference/cli-command-reference)
