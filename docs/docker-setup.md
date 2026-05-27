# CodeGraph Docker Setup and Operations Guide

This guide explains how to run CodeGraph from Docker, how to prewarm indexes,
and what to do when repositories change, branches are checked out, or multiple
projects share the same Docker cache.

## Mental Model

The Docker image runs the CodeGraph CLI:

```text
node dist/cli.js
```

Inside the container, CodeGraph uses two important paths:

| Path | Purpose |
|------|---------|
| `/workspace` | The source repository mounted from the host. Mount it read-only for MCP usage. |
| `/codegraph-home` | Persistent CodeGraph state, including `codegraph.sqlite`, daemon metadata, logs, and parse cache. |

Always mount a persistent Docker volume to `/codegraph-home`. If the container is
removed but the volume remains, warm indexes and parse cache survive.

Because every Docker run sees the mounted repository as `/workspace`, also set a
unique `CODEGRAPH_WORKSPACE_KEY` for each host project or worktree. A good value
is the absolute host path:

```text
CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/hadoop
CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/elasticsearch
```

Do not reuse the same workspace key for different repositories. The shared
Docker volume already reuses parse cache by file content hash, so different
projects can still benefit from shared cache without sharing a logical workspace
identity.

## Prerequisites

- Docker Desktop, Docker Engine, or a compatible Docker runtime.
- Git available inside the source repository on the host.
- On Windows, use forward slashes in Docker bind mounts, for example
  `D:/Personal/Projects/hadoop:/workspace:ro`.
- On Windows Docker Desktop, make sure the drive that contains the repository is
  shared with Docker. Open Docker Desktop -> Settings -> Resources -> File
  Sharing, add `D:\`, click Apply & Restart, then re-run the index command.
- For large Windows repositories, WSL/ext4 bind mounts are usually faster than
  Docker Desktop bind mounts from `D:\...`.

Check the Docker engine:

```powershell
docker --context desktop-linux ps
```

If your active Docker context is already correct, you can omit
`--context desktop-linux` from the examples below.

## Build the Image

From the CodeGraph repository:

```powershell
cd D:\Personal\Projects\code-graph
docker --context desktop-linux build -t mcp-code-graph:latest .
```

You can also use the helper script:

```powershell
.\docker-build.ps1
```

On Linux, macOS, or WSL:

```bash
./docker-build.sh
```

If your company network requires a custom trusted root certificate for `npm ci`,
pass a PEM/CRT certificate at build time:

```powershell
.\docker-build.ps1 -CaCert C:\temp\corp-root-ca.crt
```

```bash
./docker-build.sh --ca-cert /path/to/corp-root-ca.crt
```

Direct Docker build with a CA secret:

```powershell
$env:DOCKER_BUILDKIT = "1"
docker --context desktop-linux build `
  --secret "id=codegraph_ca,src=C:\temp\corp-root-ca.crt" `
  -t mcp-code-graph:latest .
```

Rebuild the image whenever you change CodeGraph source code, `package-lock.json`,
or `Dockerfile`.

## Export or Load the Image

Export the image when you need to move it to another machine or an isolated
Docker host:

```powershell
.\docker-build.ps1 -Export -Out D:\transfer\mcp-code-graph.tar.gz
```

On Linux, macOS, or WSL:

```bash
./docker-build.sh --export --out /tmp/mcp-code-graph.tar.gz
```

Load it on the target machine:

```powershell
docker load -i D:\transfer\mcp-code-graph.tar.gz
```

After loading, create or reuse a cache volume on that machine and prewarm the
repository there. Index data is machine/cache-volume local; the exported image
does not contain your repository indexes.

## Create the Persistent Cache Volume

Create the cache volume once:

```powershell
docker --context desktop-linux volume create codegraph-cache
```

Use the same volume for indexing and MCP runs:

```text
-v codegraph-cache:/codegraph-home
```

## Prewarm an Index

Prewarm before connecting an MCP client. This avoids paying cold-index cost on
the first architecture or code-research question.

Hadoop:

```powershell
docker --context desktop-linux run --rm `
  -v "D:/Personal/Projects/hadoop:/workspace:ro" `
  -v "codegraph-cache:/codegraph-home" `
  -e "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/hadoop" `
  mcp-code-graph:latest `
  index --root /workspace --parse-workers 8
```

Elasticsearch:

```powershell
docker --context desktop-linux run --rm `
  -v "D:/Personal/Projects/elasticsearch:/workspace:ro" `
  -v "codegraph-cache:/codegraph-home" `
  -e "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/elasticsearch" `
  mcp-code-graph:latest `
  index --root /workspace --parse-workers 8
```

Run the same command a second time to confirm warm behavior. A healthy warm run
should report one or more of:

- `skippedUnchanged: true`
- `filesParsed: 0`
- high `parseCacheHits`
- high `hashCacheHits`

Use fewer parse workers if the machine is memory constrained. The current
runtime caps requested parse workers at 16.

## Run the MCP Server Manually

This smoke test starts an MCP stdio process. It is expected to keep running.
Stop it with `Ctrl+C` after confirming it starts without errors.

```powershell
docker --context desktop-linux run --rm -i `
  -v "D:/Personal/Projects/hadoop:/workspace:ro" `
  -v "codegraph-cache:/codegraph-home" `
  -e "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/hadoop" `
  mcp-code-graph:latest `
  mcp --root /workspace --auto-refresh
```

For the fastest benchmark-style architecture answers on a known-warm snapshot,
you can expose only the answer-ready tools:

```powershell
docker --context desktop-linux run --rm -i `
  -v "D:/Personal/Projects/hadoop:/workspace:ro" `
  -v "codegraph-cache:/codegraph-home" `
  -e "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/hadoop" `
  -e "CODEGRAPH_MCP_TOOLS=get_flow_pack,get_research_pack" `
  mcp-code-graph:latest `
  mcp --root /workspace
```

Use this restricted mode when measuring token/time savings for architecture
questions. Use the full tool set for general editing, code review, and ad-hoc
exploration.

## MCP Client Configuration

### VS Code / Copilot

Use `${workspaceFolder}` so each editor window passes the correct source path
and workspace key:

```jsonc
{
  "mcp": {
    "servers": {
      "code-graph": {
        "type": "stdio",
        "command": "docker",
        "args": [
          "run",
          "--rm",
          "-i",
          "-v",
          "${workspaceFolder}:/workspace:ro",
          "-v",
          "codegraph-cache:/codegraph-home",
          "-e",
          "CODEGRAPH_WORKSPACE_KEY=${workspaceFolder}",
          "mcp-code-graph:latest",
          "mcp",
          "--root",
          "/workspace",
          "--auto-refresh"
        ]
      }
    }
  }
}
```

### Codex CLI

Use one MCP server entry per project or worktree:

```toml
# C:/Users/<your-user>/.codex/config.toml
[mcp_servers.code_graph_hadoop]
command = "docker"
args = [
  "run",
  "--rm",
  "-i",
  "-v",
  "D:/Personal/Projects/hadoop:/workspace:ro",
  "-v",
  "codegraph-cache:/codegraph-home",
  "-e",
  "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/hadoop",
  "mcp-code-graph:latest",
  "mcp",
  "--root",
  "/workspace",
  "--auto-refresh"
]
```

For multiple projects, see:

- `examples/docker-multi-project.codex.toml.example`
- `examples/vscode-docker-mcp.settings.jsonc`

## Branch and Checkout Scenarios

### Scenario 1: You checkout another branch in the same folder

Host action:

```powershell
cd D:\Personal\Projects\hadoop
git checkout feature/my-branch
```

Recommended action for predictable performance:

```powershell
docker --context desktop-linux run --rm `
  -v "D:/Personal/Projects/hadoop:/workspace:ro" `
  -v "codegraph-cache:/codegraph-home" `
  -e "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/hadoop" `
  mcp-code-graph:latest `
  index --root /workspace --parse-workers 8
```

Then ask the agent again. If an MCP process is already running with the same
`CODEGRAPH_WORKSPACE_KEY`, it will read the updated current snapshot from the
shared SQLite cache; restarting the MCP client is usually not required.

If you started MCP with `--auto-refresh`, CodeGraph can refresh stale snapshots
on the next tool call. Manual prewarm is still better for large repositories
because the first question will not pay the refresh cost.

### Scenario 2: You keep switching branches in one folder

Use a stable workspace key for that folder:

```text
CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/hadoop
```

After each checkout, either:

- run `index --root /workspace` manually, or
- keep MCP configured with `--auto-refresh` and accept that the first query
  after checkout may be slower.

CodeGraph tracks `head_commit`, `tree_hash`, and dirty working-tree state. If
the branch switch changes many files, the indexer may build a new snapshot. It
still reuses parse cache by file content hash where possible.

### Scenario 3: You need two branches open at the same time

Use `git worktree` or separate clones. Do not open two branches from the same
filesystem folder at the same time.

Example:

```powershell
cd D:\Personal\Projects\hadoop
git worktree add D:\Personal\Projects\hadoop-main main
git worktree add D:\Personal\Projects\hadoop-feature feature/my-branch
```

Prewarm each worktree with a different key:

```powershell
docker --context desktop-linux run --rm `
  -v "D:/Personal/Projects/hadoop-main:/workspace:ro" `
  -v "codegraph-cache:/codegraph-home" `
  -e "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/hadoop-main" `
  mcp-code-graph:latest `
  index --root /workspace --parse-workers 8

docker --context desktop-linux run --rm `
  -v "D:/Personal/Projects/hadoop-feature:/workspace:ro" `
  -v "codegraph-cache:/codegraph-home" `
  -e "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/hadoop-feature" `
  mcp-code-graph:latest `
  index --root /workspace --parse-workers 8
```

The same `codegraph-cache` volume is fine. The workspace keys isolate current
snapshots, and the parse cache can still be reused for identical file content.

### Scenario 4: You pulled, rebased, generated files, or changed many files

Run a manual refresh:

```powershell
docker --context desktop-linux run --rm `
  -v "D:/Personal/Projects/elasticsearch:/workspace:ro" `
  -v "codegraph-cache:/codegraph-home" `
  -e "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/elasticsearch" `
  mcp-code-graph:latest `
  index --root /workspace --parse-workers 8
```

For small edits, CodeGraph uses an incremental path when the changed/deleted
file count is below the configured threshold. For large branch changes, it may
build a new snapshot and copy/reuse unchanged indexed rows and parse cache.

Use `--no-incremental` only when you intentionally want to force a full snapshot
rebuild for debugging or benchmark comparison:

```powershell
docker --context desktop-linux run --rm `
  -v "D:/Personal/Projects/elasticsearch:/workspace:ro" `
  -v "codegraph-cache:/codegraph-home" `
  -e "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/elasticsearch" `
  mcp-code-graph:latest `
  index --root /workspace --no-incremental --parse-workers 8
```

### Scenario 5: You changed CodeGraph itself

Rebuild the Docker image:

```powershell
cd D:\Personal\Projects\code-graph
docker --context desktop-linux build -t mcp-code-graph:latest .
```

Keep the existing `codegraph-cache` volume unless you intentionally need a cold
run. After a rebuild, prewarm each important repository once to confirm the new
image and the existing cache are compatible.

If you see a schema-version error from `codegraph.sqlite`, create a new volume
or reset the old one.

## Cold, Warm, and Incremental Measurements

### Cold index

Reset the cache volume only for an intentional cold measurement:

```powershell
docker --context desktop-linux volume rm codegraph-cache
docker --context desktop-linux volume create codegraph-cache
```

Then measure:

```powershell
Measure-Command {
  docker --context desktop-linux run --rm `
    -v "D:/Personal/Projects/hadoop:/workspace:ro" `
    -v "codegraph-cache:/codegraph-home" `
    -e "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/hadoop" `
    mcp-code-graph:latest `
    index --root /workspace --parse-workers 8
}
```

### Warm unchanged index

Run the same command again without changing files. The JSON output should show
that the snapshot was skipped or no files were parsed.

### Incremental edit

After changing one or a few files on the host, run the same `index` command.
Look for:

```json
{
  "incrementalUpdated": true,
  "filesChanged": 1,
  "filesParsed": 1
}
```

The exact values depend on which files changed and whether parse cache already
contains the new content.

## Debugging and Inspection

Inspect the CodeGraph home volume:

```powershell
docker --context desktop-linux run --rm `
  -v "codegraph-cache:/codegraph-home" `
  --entrypoint sh `
  mcp-code-graph:latest `
  -lc "ls -lh /codegraph-home && du -sh /codegraph-home"
```

Run `doctor`:

```powershell
docker --context desktop-linux run --rm `
  -v "codegraph-cache:/codegraph-home" `
  mcp-code-graph:latest `
  doctor
```

Read recent daemon/query logs:

```powershell
docker --context desktop-linux run --rm `
  -v "codegraph-cache:/codegraph-home" `
  mcp-code-graph:latest `
  logs --tail 100
```

## Performance Recommendations for Large Repositories

- Prewarm before connecting the MCP client.
- Keep `/codegraph-home` persistent.
- Use a stable, unique `CODEGRAPH_WORKSPACE_KEY` per host project or worktree.
- Use WSL/ext4 or Linux-native source paths when Docker Desktop bind mounts from
  Windows become the bottleneck.
- For architecture benchmarks, expose only `get_flow_pack,get_research_pack` and
  ask questions with exact class/function names when possible.
- For day-to-day correctness after branch changes, use `--auto-refresh`; for
  strict performance benchmarks on a known-warm snapshot, omit `--auto-refresh`
  and manually run `index` after each checkout.
- Do not delete the Docker cache volume unless you intentionally want a cold
  start measurement.

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| `Cannot connect to the Docker daemon` | Docker Desktop or Docker context is not running | Start Docker Desktop and run `docker --context desktop-linux ps`. |
| Docker cannot mount `D:/...`, `/workspace` is empty, or the index sees no project files | The Windows drive is not shared with Docker Desktop | Docker Desktop -> Settings -> Resources -> File Sharing -> Add `D:\` -> Apply & Restart, then re-run the index command. |
| Every repo looks like the same workspace | Missing or reused `CODEGRAPH_WORKSPACE_KEY` | Use a unique host path or stable key per repo/worktree. |
| Warm run parses everything again | Different cache volume, different workspace key, or changed branch/files | Reuse the same volume/key and inspect index output fields. |
| First MCP question after checkout is slow | `--auto-refresh` is refreshing a stale snapshot | Prewarm manually after checkout before asking the agent. |
| MCP answers from an old branch | MCP was run without `--auto-refresh` and the index was not refreshed | Run `index --root /workspace` with the same workspace key. |
| Daemon crashes immediately on a Docker bind mount with a Chokidar/inotify error | Docker/WSL2/Windows NTFS can reject file watcher setup or emit watcher errors | Use the current build. Watcher errors are swallowed, and watcher setup failures are logged without breaking workspace registration. |
| MCP initialize times out with `fetch failed` or exit code 1 on a large Windows bind mount | Git metadata commands such as `git status --porcelain` are too slow on Docker Desktop/WSL2 NTFS and block registration | Use the current build. Git helper commands time out after 5 seconds, so CodeGraph registers without slow git metadata instead of missing the MCP initialize deadline. |
| Docker index is much slower than local Node | Docker Desktop bind mount overhead | Prefer WSL/ext4 or local Node for very large repos. |
| Build fails at `npm ci` behind corporate TLS | Missing corporate root CA | Build with `-CaCert` or `--ca-cert`. |
| Unsupported SQLite schema version | Old cache volume with incompatible DB schema | Use a new volume or reset `codegraph-cache`. |

### `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` during Docker build

This is an npm/Node TLS trust failure inside the Docker build container. It
usually means your network uses a corporate HTTPS inspection proxy and the
container does not trust the corporate root CA.

There are two common variants:

| Failing URL | Meaning | Fix |
|-------------|---------|-----|
| `registry.npmjs.org` | npm cannot verify the registry TLS issuer | Build with `-CaCert` or `--ca-cert`. |
| `unofficial-builds.nodejs.org/...node-headers...` | a native addon such as `better-sqlite3` fell back to `node-gyp` and tried to download Alpine/musl Node headers | Use the current Dockerfile. It sets both `NPM_CONFIG_*` and `npm_config_*` values plus `npm ci --build-from-source --nodedir=/usr/local`, so native addons use the local Node headers already in the image. |
| Native addons compile again in the runtime stage | Runtime ran `npm ci --omit=dev` after the builder already compiled native modules | Use the current Dockerfile. It builds once in the builder, runs `npm prune --omit=dev`, and copies pruned `node_modules` into runtime. |

Fix it by exporting the corporate root certificate as PEM/CRT and building with
the CA secret:

```powershell
.\docker-build.ps1 -CaCert C:\temp\corp-root-ca.crt
```

The `-CaCert`/`--ca-cert` file may contain either one root CA certificate or a
PEM bundle/chain. During build, CodeGraph registers it with the OS trust store
and appends it to the CA bundle used by npm.

Or with raw Docker:

```powershell
$env:DOCKER_BUILDKIT = "1"
docker --context desktop-linux build `
  --secret "id=codegraph_ca,src=C:\temp\corp-root-ca.crt" `
  -t mcp-code-graph:latest .
```

If you have the certificate in Windows Certificate Manager, export the trusted
root CA and PEM-encode it:

```powershell
$cert = Get-ChildItem Cert:\CurrentUser\Root | Where-Object Thumbprint -eq "<THUMBPRINT>"
Export-Certificate -Cert $cert -FilePath C:\temp\corp-root-ca.cer | Out-Null
certutil -encode C:\temp\corp-root-ca.cer C:\temp\corp-root-ca.crt
```

Do not fix this by setting `strict-ssl=false`; that disables TLS verification
instead of teaching the container to trust the correct issuer.

If the error still points at `unofficial-builds.nodejs.org` after this fix,
rebuild without using old Docker layers:

```powershell
.\docker-build.ps1 -CaCert C:\temp\corp-root-ca.crt -NoCache
```

or:

```powershell
$env:DOCKER_BUILDKIT = "1"
docker build --no-cache `
  --secret "id=codegraph_ca,src=C:\temp\corp-root-ca.crt" `
  -t mcp-code-graph:latest .
```
