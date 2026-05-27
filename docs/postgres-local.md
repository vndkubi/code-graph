# Local Postgres Storage

This is the default local storage profile for large repositories such as Hadoop
and Elasticsearch when several agents call CodeGraph tools concurrently. The v2
runtime opens Postgres through an async `pg` pool; there is no SQLite runtime
fallback.

## Local Service

Start Postgres:

```powershell
docker compose -f compose.postgres.yml up -d
```

Connection settings:

```text
CODEGRAPH_DATABASE_URL=postgres://codegraph:codegraph_local@127.0.0.1:54329/codegraph
CODEGRAPH_PG_POOL_MAX=10
CODEGRAPH_DB_STATEMENT_TIMEOUT_MS=30000
CODEGRAPH_DB_LOCK_TIMEOUT_MS=5000
CODEGRAPH_AUTO_REFRESH=false
CODEGRAPH_REFRESH_ON_START=true
```

Check health:

```powershell
docker compose -f compose.postgres.yml ps
docker compose -f compose.postgres.yml exec codegraph-postgres psql -U codegraph -d codegraph -c "select version();"
```

Stop without deleting data:

```powershell
docker compose -f compose.postgres.yml down
```

Reset the local database:

```powershell
docker compose -f compose.postgres.yml down -v
```

## Runtime Decisions

Use one CodeGraph daemon per local machine. MCP stdio proxies still scope
requests to a workspace, and all storage traffic goes through Postgres.

Use a single `pg` pool with:

- `max: 10`
- `connectionTimeoutMillis: 2000`
- `idleTimeoutMillis: 30000`
- `statement_timeout: 30000`
- `lock_timeout: 5000`
- `application_name: codegraph`

Do not split projects by database user for performance. A Postgres user is an
auth/permission boundary, not a query-planning boundary. Start with one local
database and one app user, then isolate by `workspace_id`/`snapshot_id`.

If shared tables become too large after retaining many snapshots, use one of
these in order:

1. aggressive old-snapshot cleanup per workspace
2. hash/list partitioning on `workspace_id`
3. separate database per project only for extreme isolation

Separate databases reduce table and index size per project, but they also need
separate pools and migrations. They do not make ten concurrent queries inside
one project faster than a correctly indexed schema with a pool.

Keep index writes serialized:

- writer concurrency: `1`
- use a per-workspace advisory lock before refresh/index
- refresh only publishes `workspaces.current_snapshot_id` after the snapshot is
  ready
- default MCP pack tools should not enable `autoRefresh`
- MCP startup can queue a background refresh with `--refresh-on-start` or
  `CODEGRAPH_REFRESH_ON_START=true`

Allow read queries to use the pool concurrently:

- ordinary lookup tools can consume one connection per request
- pack tools should avoid unbounded internal fan-out so one request does not
  occupy the full pool
- cap expensive result sets before ranking in JavaScript

## Schema Choices

Keep the existing relational model:

- `workspaces`
- `snapshots`
- `files`
- `parse_cache`
- `symbols`
- `imports`
- `type_refs`
- `call_edges`
- `dependency_edges`
- `annotations`
- `endpoints`
- `beans`
- `inheritance`

Use `TEXT` ids and content hashes to keep migration simple. Keep large parse
cache payloads as `TEXT`; CodeGraph only looks them up by `blob_hash` and does
not query inside them. Metadata JSON can also stay `TEXT` initially to preserve
current ranking and filter behavior. Add JSONB only where queries prove it is
worth the migration cost.

Install this extension during migration:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

Use normal btree indexes for exact graph lookups and trigram GIN indexes for
substring search:

```sql
CREATE INDEX IF NOT EXISTS idx_symbols_name
  ON symbols(snapshot_id, simple_name, kind);
CREATE INDEX IF NOT EXISTS idx_symbols_file
  ON symbols(snapshot_id, file);
CREATE INDEX IF NOT EXISTS idx_symbols_fq
  ON symbols(snapshot_id, fq_name);
CREATE INDEX IF NOT EXISTS idx_call_edges_caller
  ON call_edges(snapshot_id, caller);
CREATE INDEX IF NOT EXISTS idx_call_edges_callee
  ON call_edges(snapshot_id, callee);
CREATE INDEX IF NOT EXISTS idx_dependency_from
  ON dependency_edges(snapshot_id, from_file);
CREATE INDEX IF NOT EXISTS idx_dependency_to
  ON dependency_edges(snapshot_id, to_file);

CREATE INDEX IF NOT EXISTS idx_symbols_simple_name_trgm
  ON symbols USING gin (simple_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_symbols_fq_name_trgm
  ON symbols USING gin (fq_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_symbols_file_trgm
  ON symbols USING gin (file gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_files_path_trgm
  ON files USING gin (path gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_endpoints_path_trgm
  ON endpoints USING gin (path gin_trgm_ops);
```

## Verification

Build and run the Postgres-backed integration suite:

```powershell
$env:CODEGRAPH_DATABASE_URL="postgres://codegraph:codegraph_local@127.0.0.1:54329/codegraph"
npm run build
npm test -- --run tests/v2/index-query.test.ts
```

The expected concurrency target is not unlimited parallelism. The target is
stable latency under a burst of agent tool calls while preventing index refreshes
from consuming the entire database.
