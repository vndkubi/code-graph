CREATE TABLE IF NOT EXISTS codegraph_schema (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  workspace_key TEXT,
  git_remote TEXT,
  git_common_dir TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_indexed_head TEXT,
  current_snapshot_id TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  branch TEXT,
  head_commit TEXT,
  tree_hash TEXT,
  dirty_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  manifest_scan_ms INTEGER NOT NULL DEFAULT 0,
  index_time_ms INTEGER NOT NULL DEFAULT 0,
  files_total INTEGER NOT NULL DEFAULT 0,
  files_parsed INTEGER NOT NULL DEFAULT 0,
  parse_cache_hits INTEGER NOT NULL DEFAULT 0,
  index_provider_ids TEXT NOT NULL DEFAULT 'tree-sitter',
  index_provider_versions_json TEXT NOT NULL DEFAULT '{}',
  index_provider_config_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS files (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  blob_hash TEXT NOT NULL,
  mtime_ms DOUBLE PRECISION NOT NULL,
  size INTEGER NOT NULL,
  language TEXT,
  file_role TEXT NOT NULL,
  parse_status TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, path)
);

CREATE TABLE IF NOT EXISTS parse_cache (
  provider_id TEXT NOT NULL DEFAULT 'tree-sitter',
  provider_version TEXT NOT NULL DEFAULT 'tree-sitter-analyzer-v1',
  blob_hash TEXT NOT NULL,
  language TEXT NOT NULL,
  parse_json TEXT NOT NULL,
  has_parse_errors INTEGER NOT NULL,
  parse_confidence DOUBLE PRECISION NOT NULL,
  created_at TEXT NOT NULL,
  CONSTRAINT parse_cache_provider_pkey PRIMARY KEY (provider_id, provider_version, blob_hash)
);

ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS index_provider_ids TEXT NOT NULL DEFAULT 'tree-sitter';
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS index_provider_versions_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS index_provider_config_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE parse_cache ADD COLUMN IF NOT EXISTS provider_id TEXT NOT NULL DEFAULT 'tree-sitter';
ALTER TABLE parse_cache ADD COLUMN IF NOT EXISTS provider_version TEXT NOT NULL DEFAULT 'tree-sitter-analyzer-v1';

DO $$
DECLARE
  existing_primary_key TEXT;
BEGIN
  SELECT conname INTO existing_primary_key
  FROM pg_constraint
  WHERE conrelid = 'parse_cache'::regclass
    AND contype = 'p';

  IF existing_primary_key IS NOT NULL AND existing_primary_key <> 'parse_cache_provider_pkey' THEN
    EXECUTE format('ALTER TABLE parse_cache DROP CONSTRAINT %I', existing_primary_key);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'parse_cache'::regclass
      AND conname = 'parse_cache_provider_pkey'
  ) THEN
    ALTER TABLE parse_cache
      ADD CONSTRAINT parse_cache_provider_pkey PRIMARY KEY (provider_id, provider_version, blob_hash);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS symbols (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  fq_name TEXT NOT NULL,
  simple_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  "column" INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  signature TEXT NOT NULL,
  visibility TEXT NOT NULL,
  parent TEXT,
  package_name TEXT,
  return_type TEXT,
  parameter_types_json TEXT,
  annotations_json TEXT,
  framework_role TEXT,
  framework_meta_json TEXT,
  file_role TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, fq_name, file, line)
);

CREATE TABLE IF NOT EXISTS imports (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  source TEXT NOT NULL,
  imported_symbols_json TEXT NOT NULL,
  line INTEGER NOT NULL,
  is_external INTEGER NOT NULL,
  file_role TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS type_refs (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  referenced_type TEXT NOT NULL,
  context TEXT NOT NULL,
  line INTEGER NOT NULL,
  file_role TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS call_edges (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  caller TEXT NOT NULL,
  callee TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  resolution_kind TEXT NOT NULL,
  file_role TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dependency_edges (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  from_file TEXT NOT NULL,
  to_file TEXT NOT NULL,
  kind TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  resolution_kind TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS annotations (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  symbol_fq_name TEXT NOT NULL,
  annotation TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS endpoints (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  path_resolution TEXT NOT NULL DEFAULT 'exact',
  path_resolution_reason TEXT,
  handler_symbol TEXT NOT NULL,
  controller TEXT,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  framework TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  file_role TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS beans (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  bean_type TEXT NOT NULL,
  implementation TEXT NOT NULL,
  scope TEXT,
  qualifiers_json TEXT NOT NULL,
  source TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  confidence DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS inheritance (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  child_type TEXT NOT NULL,
  parent_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  confidence DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspaces_root ON workspaces(root);
CREATE INDEX IF NOT EXISTS idx_snapshots_workspace_created ON snapshots(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_snapshot_hash ON files(snapshot_id, blob_hash);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(snapshot_id, simple_name, kind);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(snapshot_id, file);
CREATE INDEX IF NOT EXISTS idx_symbols_fq ON symbols(snapshot_id, fq_name);
CREATE INDEX IF NOT EXISTS idx_symbols_framework_role ON symbols(snapshot_id, framework_role);
CREATE INDEX IF NOT EXISTS idx_imports_source ON imports(snapshot_id, source);
CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(snapshot_id, file);
CREATE INDEX IF NOT EXISTS idx_type_refs_type ON type_refs(snapshot_id, referenced_type);
DROP INDEX IF EXISTS idx_call_edges_caller;
DROP INDEX IF EXISTS idx_call_edges_callee;
CREATE INDEX IF NOT EXISTS idx_call_edges_file ON call_edges(snapshot_id, file);
CREATE INDEX IF NOT EXISTS idx_dependency_from ON dependency_edges(snapshot_id, from_file);
CREATE INDEX IF NOT EXISTS idx_dependency_to ON dependency_edges(snapshot_id, to_file);
CREATE INDEX IF NOT EXISTS idx_annotations_annotation ON annotations(snapshot_id, annotation);
CREATE INDEX IF NOT EXISTS idx_endpoints_path ON endpoints(snapshot_id, method, path);
CREATE INDEX IF NOT EXISTS idx_beans_type ON beans(snapshot_id, bean_type);
CREATE INDEX IF NOT EXISTS idx_inheritance_parent ON inheritance(snapshot_id, parent_type);

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_symbols_simple_name_trgm ON symbols USING gin (simple_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_symbols_fq_name_trgm ON symbols USING gin (fq_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_symbols_file_trgm ON symbols USING gin (file gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_call_edges_caller_trgm ON call_edges USING gin (caller gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_call_edges_callee_trgm ON call_edges USING gin (callee gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_files_path_trgm ON files USING gin (path gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_endpoints_path_trgm ON endpoints USING gin (path gin_trgm_ops);

INSERT INTO codegraph_schema(version, applied_at)
VALUES (1, NOW()::TEXT)
ON CONFLICT (version) DO NOTHING;

INSERT INTO codegraph_schema(version, applied_at)
VALUES (2, NOW()::TEXT)
ON CONFLICT (version) DO NOTHING;
