# GitHub Copilot CLI With Two Local Clones

This guide covers the case where the same upstream repository is cloned into
two different host folders and both folders are used by GitHub Copilot CLI at
the same time through Docker-backed CodeGraph MCP servers.

The short rule is:

- Use one MCP server entry per clone folder.
- Use a different `CODEGRAPH_WORKSPACE_KEY` per clone folder.
- Keep one shared `codegraph-cache` volume.
- Prewarm each clone with the exact same mount path and workspace key that the
  MCP entry uses.
- Rebuild `mcp-code-graph:latest` after pulling the build that scopes Docker
  daemon metadata per container.

## Why This Used To Fail

Docker MCP runs one CodeGraph stdio proxy container per Copilot CLI session.
Inside each container, the daemon listens on that container's own
`127.0.0.1`.

Older images wrote one shared daemon metadata file:

```text
/codegraph-home/daemon.json
```

When two MCP containers shared the same `codegraph-cache` volume, container B
could read container A's daemon port and then try to connect to `127.0.0.1`
inside B. That port did not exist in B, so one Copilot session could fail to
start or terminate with a connection timeout.

Current builds write container-scoped daemon metadata:

```text
/codegraph-home/daemon.<container-id>.json
```

The shared volume is still safe because indexes and parse cache live in
Postgres and are isolated by `CODEGRAPH_WORKSPACE_KEY`.

## Example Layout

Assume the same upstream repository is cloned twice:

```text
D:/Personal/Projects/myrepo-a
D:/Personal/Projects/myrepo-b
```

Use these exact host paths as workspace keys:

```text
CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/myrepo-a
CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/myrepo-b
```

Do not use the same workspace key for both clones, even if both clones have the
same Git remote and commit. CodeGraph treats workspace key as the logical
workspace identity.

## 1. Build The Current Docker Image

From the CodeGraph checkout:

```powershell
cd D:\Personal\Projects\code-graph
docker --context desktop-linux build -t mcp-code-graph:latest .
```

If Docker Desktop Linux is already the active context, `docker build ...` is
also fine.

## 2. Start Postgres And Cache Volume

```powershell
cd D:\Personal\Projects\code-graph
docker compose -f compose.postgres.yml up -d
docker --context desktop-linux volume create codegraph-cache
```

Confirm Postgres is healthy:

```powershell
docker --context desktop-linux ps --filter name=codegraph-postgres
```

## 3. Prewarm Clone A

```powershell
docker --context desktop-linux run --rm `
  -v "D:/Personal/Projects/myrepo-a:/workspace:ro" `
  -v "codegraph-cache:/codegraph-home" `
  -e "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/myrepo-a" `
  -e "CODEGRAPH_DATABASE_URL=postgres://codegraph:codegraph_local@host.docker.internal:54329/codegraph" `
  -e "CODEGRAPH_PG_POOL_MAX=10" `
  mcp-code-graph:latest `
  index --root /workspace --workspace-key "D:/Personal/Projects/myrepo-a" --parse-workers 8
```

The important fields in the JSON result are:

```json
{
  "filesTotal": 1234,
  "filesParsed": 1234,
  "workspaceId": "...",
  "snapshotId": "...",
  "indexTimeMs": 123456
}
```

If `filesTotal` is `0`, Docker cannot see the mount. Fix Docker Desktop file
sharing for the drive, then rerun the command.

## 4. Prewarm Clone B

```powershell
docker --context desktop-linux run --rm `
  -v "D:/Personal/Projects/myrepo-b:/workspace:ro" `
  -v "codegraph-cache:/codegraph-home" `
  -e "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/myrepo-b" `
  -e "CODEGRAPH_DATABASE_URL=postgres://codegraph:codegraph_local@host.docker.internal:54329/codegraph" `
  -e "CODEGRAPH_PG_POOL_MAX=10" `
  mcp-code-graph:latest `
  index --root /workspace --workspace-key "D:/Personal/Projects/myrepo-b" --parse-workers 8
```

Clone B should often get many `parseCacheHits` if Clone A has the same file
contents. That is expected and desirable. It means both logical workspaces are
separate, but the content parse cache is reused.

## 5. Configure Copilot CLI

Edit:

```powershell
notepad "$HOME\.copilot\mcp-config.json"
```

Use one server entry per clone:

```json
{
  "mcpServers": {
    "codegraph-myrepo-a": {
      "type": "local",
      "command": "docker",
      "args": [
        "--context",
        "desktop-linux",
        "run",
        "--rm",
        "-i",
        "-v",
        "D:/Personal/Projects/myrepo-a:/workspace:ro",
        "-v",
        "codegraph-cache:/codegraph-home",
        "-e",
        "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/myrepo-a",
        "-e",
        "CODEGRAPH_DATABASE_URL=postgres://codegraph:codegraph_local@host.docker.internal:54329/codegraph",
        "-e",
        "CODEGRAPH_PG_POOL_MAX=10",
        "mcp-code-graph:latest",
        "mcp",
        "--root",
        "/workspace",
        "--home",
        "/codegraph-home",
        "--workspace-key",
        "D:/Personal/Projects/myrepo-a",
        "--no-prewarm"
      ],
      "env": {},
      "tools": ["*"],
      "timeout": 180000
    },
    "codegraph-myrepo-b": {
      "type": "local",
      "command": "docker",
      "args": [
        "--context",
        "desktop-linux",
        "run",
        "--rm",
        "-i",
        "-v",
        "D:/Personal/Projects/myrepo-b:/workspace:ro",
        "-v",
        "codegraph-cache:/codegraph-home",
        "-e",
        "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/myrepo-b",
        "-e",
        "CODEGRAPH_DATABASE_URL=postgres://codegraph:codegraph_local@host.docker.internal:54329/codegraph",
        "-e",
        "CODEGRAPH_PG_POOL_MAX=10",
        "mcp-code-graph:latest",
        "mcp",
        "--root",
        "/workspace",
        "--home",
        "/codegraph-home",
        "--workspace-key",
        "D:/Personal/Projects/myrepo-b",
        "--no-prewarm"
      ],
      "env": {},
      "tools": ["*"],
      "timeout": 180000
    }
  }
}
```

Use `--no-prewarm` for large repositories. This keeps Copilot startup fast and
uses the snapshot you explicitly prewarmed.

## 6. Verify Each Clone Separately

Terminal A:

```powershell
cd D:\Personal\Projects\myrepo-a
gh copilot -p "Use MCP server codegraph-myrepo-a and call get_index_stats. Return the indexed file count only." --allow-all-tools --allow-all-paths
```

Terminal B:

```powershell
cd D:\Personal\Projects\myrepo-b
gh copilot -p "Use MCP server codegraph-myrepo-b and call get_index_stats. Return the indexed file count only." --allow-all-tools --allow-all-paths
```

Both should complete without MCP startup timeout.

## 7. Verify Both Clones Concurrently

Open two terminals and start these at nearly the same time.

Terminal A:

```powershell
cd D:\Personal\Projects\myrepo-a
gh copilot --output-format=json --stream off --allow-all-tools --allow-all-paths `
  -p "Use CodeGraph MCP server codegraph-myrepo-a. Call get_flow_pack for target request flow through the main service. Do not use shell or grep. Answer from the MCP evidence."
```

Terminal B:

```powershell
cd D:\Personal\Projects\myrepo-b
gh copilot --output-format=json --stream off --allow-all-tools --allow-all-paths `
  -p "Use CodeGraph MCP server codegraph-myrepo-b. Call get_flow_pack for target request flow through the main service. Do not use shell or grep. Answer from the MCP evidence."
```

In JSONL output, a real MCP call appears as `tool.execution_start` with a name
similar to:

```text
codegraph-myrepo-a-get_flow_pack
codegraph-myrepo-b-get_flow_pack
```

## 8. Inspect CodeGraph Logs

Show recent daemon/query logs from the shared cache volume:

```powershell
docker --context desktop-linux run --rm `
  -v "codegraph-cache:/codegraph-home" `
  --entrypoint sh `
  mcp-code-graph:latest `
  -lc "ls -1 /codegraph-home/daemon*.json 2>/dev/null; tail -80 /codegraph-home/logs/daemon.jsonl 2>/dev/null; tail -40 /codegraph-home/logs/daemon.jsonl.bootstrap.log 2>/dev/null"
```

Expected daemon metadata now looks like:

```text
/codegraph-home/daemon.aab36709501a.json
/codegraph-home/daemon.e7bbd340d1ef.json
```

You should not rely on one shared `daemon.json` for concurrent Docker MCP
containers.

## 9. Refresh After Branch Changes

If you checkout, pull, rebase, or regenerate files in one clone, refresh only
that clone's workspace key:

```powershell
docker --context desktop-linux run --rm `
  -v "D:/Personal/Projects/myrepo-a:/workspace:ro" `
  -v "codegraph-cache:/codegraph-home" `
  -e "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/myrepo-a" `
  -e "CODEGRAPH_DATABASE_URL=postgres://codegraph:codegraph_local@host.docker.internal:54329/codegraph" `
  -e "CODEGRAPH_PG_POOL_MAX=10" `
  mcp-code-graph:latest `
  index --root /workspace --workspace-key "D:/Personal/Projects/myrepo-a" --parse-workers 8
```

Do not refresh clone B unless clone B changed.

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| One of two Copilot sessions fails to start MCP | Old image still uses one shared daemon metadata file | Rebuild `mcp-code-graph:latest` from the current CodeGraph checkout. |
| `filesTotal: 0` during prewarm | Docker bind mount is empty or drive sharing is disabled | Fix Docker Desktop file sharing, verify the host path, and rerun prewarm. |
| Both clones return the same files/branch unexpectedly | Both MCP entries reuse the same `CODEGRAPH_WORKSPACE_KEY` | Set workspace key to each clone's host path and prewarm both again. |
| Copilot starts but uses shell/grep instead of CodeGraph | Prompt did not force the MCP tool or tool permission was not granted | Ask for `get_flow_pack`, `get_research_pack`, or `get_index_stats` explicitly and run with `--allow-all-tools` in non-interactive tests. |
| `Timed out waiting for codegraph daemon to start` | Stale metadata from an old image or Postgres lock contention after an aborted index | Rebuild the image, restart stuck index containers, inspect `daemon.jsonl.bootstrap.log`, and restart Postgres if the DB is locked. |
| `connect ECONNREFUSED host.docker.internal:54329` | Postgres is not running or not reachable from Docker | Run `docker compose -f compose.postgres.yml up -d` from the CodeGraph checkout. |

## Real Test Result From This Repository

This was validated on Windows Docker Desktop with two local clones of this
repository under `.tmp-debug-home/copilot-real-runs`.

Index results:

| Clone | Files | Parsed | Parse cache hits | Index time |
|-------|------:|-------:|-----------------:|-----------:|
| Clone A | 57 | 57 | 0 | 8.6s |
| Clone B | 57 | 0 | 57 | 6.3s |

Concurrent Copilot CLI results:

| Run | Tool | Exit | Duration | MCP timeout errors |
|-----|------|-----:|---------:|-------------------:|
| Clone A symbol test | `codegraph-clone-a-search_symbol` | 0 | 20.1s | 0 real MCP startup errors |
| Clone B symbol test | `codegraph-clone-b-search_symbol` | 0 | 20.0s | 0 real MCP startup errors |
| Clone A flow test | `codegraph-clone-a-get_flow_pack` | 0 | 36.7s | 0 |
| Clone B flow test | `codegraph-clone-b-get_flow_pack` | 0 | 36.2s | 0 |

