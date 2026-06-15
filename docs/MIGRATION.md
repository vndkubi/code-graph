# Migration Guide: No Daemon, Per-Repo SQLite

This release removes the daemon/Postgres runtime and stores each workspace in its own SQLite database:

```text
<repo>/.codegraph/graph.sqlite
```

## Breaking Changes

### Daemon Commands Removed

Removed:

```bash
codegraph daemon start
codegraph daemon stop
codegraph daemon status
codegraph daemon run
```

Use direct MCP instead:

```bash
codegraph mcp --root /path/to/repo
```

The MCP process opens `.codegraph/graph.sqlite` directly and calls `V2QueryService` in-process.

### Postgres Removed

Removed runtime requirements:

- `CODEGRAPH_DATABASE_URL`
- Docker Compose Postgres
- `pg`
- `pg-copy-streams`
- Postgres schema migrations

Use:

```bash
codegraph setup --root /path/to/repo
codegraph index --root /path/to/repo
```

### Global Home Removed

The old global home layout is no longer used for graph data. `CODEGRAPH_HOME` is ignored by graph storage.

Old:

```bash
codegraph index --root /path/to/repo --home ~/.codegraph
```

New:

```bash
codegraph index --root /path/to/repo
```

Generated files live under the repository:

```text
.codegraph/
  graph.sqlite
  artifacts/
  logs/
  setup-state.json
```

Add `.codegraph/` to `.gitignore`.

## New Daily Flow

```bash
npm ci
npm run build
codegraph setup --root /path/to/repo
codegraph mcp --root /path/to/repo
```

Refresh after edits or branch changes:

```bash
codegraph index --root /path/to/repo
```

Inspect health:

```bash
codegraph doctor --root /path/to/repo
```

Read query logs:

```bash
codegraph logs --root /path/to/repo --tail 50
```

## MCP Client Config

Most clients keep the same command shape:

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

Run `codegraph setup --root <repo>` before starting the client for the fastest startup. Use `--prewarm` only when you explicitly want MCP to index a missing workspace during startup/runtime.

## Data Migration

There is no automatic migration from old Postgres/global data.

1. Leave old data in place or delete it manually.
2. Run `codegraph setup --root /path/to/repo`.
3. Confirm `codegraph doctor --root /path/to/repo` reports `backend: sqlite` and `state: ready`.

## Troubleshooting

### Workspace is not indexed yet

Run:

```bash
codegraph setup --root /path/to/repo
```

### Database is locked

SQLite WAL handles normal read/write concurrency, but only one writer can index at a time.

- Ensure only one `codegraph index`, `setup`, or MCP auto-refresh writer is active for the same repo.
- Stop stale Node processes if a previous index was interrupted.

### Benchmark scans local artifacts

Keep generated folders ignored:

```gitignore
.codegraph/
.tmp/
```
