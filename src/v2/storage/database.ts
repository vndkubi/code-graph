import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { ensureCodeGraphDirs, getCodeGraphPaths, type CodeGraphPaths } from '../paths.js';

export interface OpenCodeGraphDbResult {
  db: DatabaseType;
  paths: CodeGraphPaths;
}

const SCHEMA_VERSION = 2;

export function openCodeGraphDb(homeOverride?: string): OpenCodeGraphDbResult {
  const paths = getCodeGraphPaths(homeOverride);
  ensureCodeGraphDirs(paths);
  const db = new Database(paths.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  migrate(db);
  return { db, paths };
}

export function migrate(db: DatabaseType): void {
  const current = Number(db.pragma('user_version', { simple: true }) ?? 0);
  if (current > SCHEMA_VERSION) {
    throw new Error(`Unsupported codegraph.sqlite schema version ${current}; this binary supports ${SCHEMA_VERSION}`);
  }
  if (current === SCHEMA_VERSION) return;

  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        root TEXT NOT NULL,
        git_remote TEXT,
        git_common_dir TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_indexed_head TEXT,
        current_snapshot_id TEXT
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
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
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS files (
        snapshot_id TEXT NOT NULL,
        path TEXT NOT NULL,
        blob_hash TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL,
        language TEXT,
        file_role TEXT NOT NULL,
        parse_status TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, path),
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS parse_cache (
        blob_hash TEXT PRIMARY KEY,
        language TEXT NOT NULL,
        parse_json TEXT NOT NULL,
        has_parse_errors INTEGER NOT NULL,
        parse_confidence REAL NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS symbols (
        snapshot_id TEXT NOT NULL,
        fq_name TEXT NOT NULL,
        simple_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        column INTEGER NOT NULL,
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
        PRIMARY KEY (snapshot_id, fq_name, file, line),
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS imports (
        snapshot_id TEXT NOT NULL,
        file TEXT NOT NULL,
        source TEXT NOT NULL,
        imported_symbols_json TEXT NOT NULL,
        line INTEGER NOT NULL,
        is_external INTEGER NOT NULL,
        file_role TEXT NOT NULL,
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS type_refs (
        snapshot_id TEXT NOT NULL,
        file TEXT NOT NULL,
        referenced_type TEXT NOT NULL,
        context TEXT NOT NULL,
        line INTEGER NOT NULL,
        file_role TEXT NOT NULL,
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS call_edges (
        snapshot_id TEXT NOT NULL,
        caller TEXT NOT NULL,
        callee TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        confidence REAL NOT NULL,
        resolution_kind TEXT NOT NULL,
        file_role TEXT NOT NULL,
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS dependency_edges (
        snapshot_id TEXT NOT NULL,
        from_file TEXT NOT NULL,
        to_file TEXT NOT NULL,
        kind TEXT NOT NULL,
        confidence REAL NOT NULL,
        resolution_kind TEXT NOT NULL,
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS annotations (
        snapshot_id TEXT NOT NULL,
        symbol_fq_name TEXT NOT NULL,
        annotation TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS endpoints (
        snapshot_id TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        path_resolution TEXT NOT NULL DEFAULT 'exact',
        path_resolution_reason TEXT,
        handler_symbol TEXT NOT NULL,
        controller TEXT,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        framework TEXT NOT NULL,
        confidence REAL NOT NULL,
        file_role TEXT NOT NULL,
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS beans (
        snapshot_id TEXT NOT NULL,
        bean_type TEXT NOT NULL,
        implementation TEXT NOT NULL,
        scope TEXT,
        qualifiers_json TEXT NOT NULL,
        source TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        confidence REAL NOT NULL,
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS inheritance (
        snapshot_id TEXT NOT NULL,
        child_type TEXT NOT NULL,
        parent_type TEXT NOT NULL,
        kind TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        confidence REAL NOT NULL,
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_workspaces_root ON workspaces(root);
      CREATE INDEX IF NOT EXISTS idx_snapshots_workspace_created ON snapshots(workspace_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_files_snapshot_hash ON files(snapshot_id, blob_hash);
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(snapshot_id, simple_name, kind);
      CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(snapshot_id, file);
      CREATE INDEX IF NOT EXISTS idx_symbols_fq ON symbols(snapshot_id, fq_name);
      CREATE INDEX IF NOT EXISTS idx_imports_source ON imports(snapshot_id, source);
      CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(snapshot_id, file);
      CREATE INDEX IF NOT EXISTS idx_type_refs_type ON type_refs(snapshot_id, referenced_type);
      CREATE INDEX IF NOT EXISTS idx_call_edges_caller ON call_edges(snapshot_id, caller);
      CREATE INDEX IF NOT EXISTS idx_call_edges_callee ON call_edges(snapshot_id, callee);
      CREATE INDEX IF NOT EXISTS idx_dependency_from ON dependency_edges(snapshot_id, from_file);
      CREATE INDEX IF NOT EXISTS idx_dependency_to ON dependency_edges(snapshot_id, to_file);
      CREATE INDEX IF NOT EXISTS idx_endpoints_path ON endpoints(snapshot_id, method, path);
      CREATE INDEX IF NOT EXISTS idx_beans_type ON beans(snapshot_id, bean_type);
      CREATE INDEX IF NOT EXISTS idx_inheritance_parent ON inheritance(snapshot_id, parent_type);
    `);
    ensureColumn(db, 'endpoints', 'path_resolution', "TEXT NOT NULL DEFAULT 'exact'");
    ensureColumn(db, 'endpoints', 'path_resolution_reason', 'TEXT');
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

function ensureColumn(db: DatabaseType, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some(col => col.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
