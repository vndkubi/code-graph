# GitHub Copilot CLI MCP Config

This guide sets up CodeGraph in GitHub Copilot CLI through
`~/.copilot/mcp-config.json`.

GitHub Copilot CLI uses an `mcpServers` object in this file. This is different
from VS Code settings, which use `mcp.servers`.

## 1. Build CodeGraph

From the CodeGraph checkout:

```powershell
cd D:\Personal\Projects\code-graph
npm install
npm run build
```

The MCP entrypoint used by Copilot is:

```text
D:/Personal/Projects/code-graph/dist/cli.js
```

Use forward slashes in JSON paths on Windows. They avoid escaping backslashes.

## 2. Prewarm the target repository

Prewarm before connecting Copilot. This avoids a cold index during MCP startup
or the first question.

```powershell
node D:\Personal\Projects\code-graph\dist\cli.js index `
  --root D:\Personal\Projects\your-repo `
  --workspace-key D:\Personal\Projects\your-repo
```

Use the same `--workspace-key` in the MCP config. This keeps the prewarmed
snapshot and the Copilot MCP server attached to the same workspace identity.

## 3. Create the Copilot config file

On Windows:

```powershell
New-Item -ItemType Directory -Force "$HOME\.copilot"
notepad "$HOME\.copilot\mcp-config.json"
```

On macOS or Linux:

```bash
mkdir -p ~/.copilot
$EDITOR ~/.copilot/mcp-config.json
```

## 4. Add a local CodeGraph server

Use one server entry per repository or worktree.

```json
{
  "mcpServers": {
    "codegraph-your-repo": {
      "type": "stdio",
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
      "tools": ["*"],
      "timeout": 180000
    }
  }
}
```

Why these options:

- `--root` is the source repository Copilot should query.
- `--workspace-key` must match the prewarm command when you use one.
- `--no-prewarm` keeps MCP startup fast. Run `codegraph index` manually after a
  checkout or large change instead of indexing inside Copilot startup.
- `tools: ["*"]` exposes all CodeGraph tools. Use a smaller list if your
  environment requires tool allowlisting.
- `timeout` is in milliseconds. Normal warm CodeGraph calls should be much
  faster, but this avoids short client-side timeouts on large workspaces.

## 5. Multiple repositories

Add another server entry with a different name and root.

```json
{
  "mcpServers": {
    "codegraph-hadoop": {
      "type": "stdio",
      "command": "node",
      "args": [
        "D:/Personal/Projects/code-graph/dist/cli.js",
        "mcp",
        "--root",
        "D:/Personal/Projects/hadoop",
        "--workspace-key",
        "D:/Personal/Projects/hadoop",
        "--no-prewarm"
      ],
      "env": {},
      "tools": ["*"],
      "timeout": 180000
    },
    "codegraph-elasticsearch": {
      "type": "stdio",
      "command": "node",
      "args": [
        "D:/Personal/Projects/code-graph/dist/cli.js",
        "mcp",
        "--root",
        "D:/Personal/Projects/elasticsearch",
        "--workspace-key",
        "D:/Personal/Projects/elasticsearch",
        "--no-prewarm"
      ],
      "env": {},
      "tools": ["*"],
      "timeout": 180000
    }
  }
}
```

Prewarm each repository with the matching `--workspace-key`.

## 6. Optional Docker config

Use Docker when Copilot should run CodeGraph inside the same environment as the
source tree. Keep the source mount read-only and persist `/codegraph-home`.

```json
{
  "mcpServers": {
    "codegraph-docker-your-repo": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-v",
        "D:/Personal/Projects/your-repo:/workspace:ro",
        "-v",
        "codegraph-cache:/codegraph-home",
        "-e",
        "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/your-repo",
        "mcp-code-graph:latest",
        "mcp",
        "--root",
        "/workspace",
        "--no-prewarm"
      ],
      "env": {},
      "tools": ["*"],
      "timeout": 180000
    }
  }
}
```

Prewarm with the same Docker volume and workspace key:

```powershell
docker run --rm `
  -v "D:/Personal/Projects/your-repo:/workspace:ro" `
  -v "codegraph-cache:/codegraph-home" `
  -e "CODEGRAPH_WORKSPACE_KEY=D:/Personal/Projects/your-repo" `
  mcp-code-graph:latest `
  index --root /workspace
```

## 7. Verify Copilot sees CodeGraph

List configured MCP servers:

```powershell
copilot mcp list
copilot mcp get codegraph-your-repo --json
```

Then ask Copilot:

```text
Use codegraph MCP tool get_index_stats and tell me the indexed file count.
```

For large repositories mounted through Docker Desktop, prefer a flow-pack smoke
test because `get_index_stats` includes stale-file diagnostics that may rescan
the bind mount:

```text
Use codegraph MCP get_flow_pack for "How does Hadoop handle BlockManager.processReport?" with tokenBudget 2000. Do not use shell search first.
```

Check CodeGraph daemon logs from the CodeGraph checkout:

```powershell
node D:\Personal\Projects\code-graph\dist\cli.js logs --tail 20
```

A real MCP call should produce a log line with `event: "query"` and a
`toolName` such as `get_index_stats`, `get_flow_pack`, or `search_symbol`.

## 8. Refresh after checkout or large changes

For predictable performance, refresh manually:

```powershell
node D:\Personal\Projects\code-graph\dist\cli.js index `
  --root D:\Personal\Projects\your-repo `
  --workspace-key D:\Personal\Projects\your-repo
```

For small repositories, you can add `--auto-refresh` to the MCP args. For large
repositories, manual prewarm is more predictable because it keeps indexing out
of Copilot tool calls.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Cannot find module ... dist/cli.js` | CodeGraph was not built, or the path points to an old clone. | Run `npm run build` and verify the exact `dist/cli.js` path. |
| Copilot lists no CodeGraph server | Config file path or JSON shape is wrong. | Use `~/.copilot/mcp-config.json` and the top-level `mcpServers` object. |
| First query is slow | The repository was not prewarmed, or the MCP server was started without a current snapshot. | Run `codegraph index` with the same `--root` and `--workspace-key`. |
| Answers look stale after branch checkout | The index still points at the previous checkout. | Run `codegraph index` again after checkout. |
| Copilot uses grep/read instead of CodeGraph | The prompt did not request CodeGraph, or the server did not start. | Ask for `get_index_stats` explicitly and inspect CodeGraph logs. |

## References

- [Adding MCP servers for GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
- [GitHub Copilot CLI command reference: MCP server configuration](https://docs.github.com/copilot/reference/cli-command-reference#mcp-server-configuration)
