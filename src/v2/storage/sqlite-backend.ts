import fs from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType, Statement } from 'better-sqlite3';
import { ensureWorkspaceDirs, getWorkspacePaths, type WorkspacePaths } from '../paths.js';
import type {
  CodeGraphDb,
  CodeGraphStatement,
  CopyFromRowsOptions,
  GraphBackend,
  OpenGraphBackendOptions,
  QueryResultInfo,
  SqliteValue,
} from './graph-backend.js';

const SCHEMA_VERSION = 4;
const SQLITE_MAX_BATCH_PARAMS = 24_000;

export class SQLiteGraphBackend implements GraphBackend {
  readonly db: SQLiteCodeGraphDb;
  readonly workspaceRoot: string;
  readonly dbPath: string;
  readonly paths: WorkspacePaths;

  constructor(options: OpenGraphBackendOptions) {
    this.workspaceRoot = path.resolve(options.root);
    this.paths = getWorkspacePaths(this.workspaceRoot, options.graphDirName);
    this.dbPath = this.paths.dbPath;
    ensureWorkspaceDirs(this.paths);

    const rawDb = new Database(this.dbPath);
    configurePragmas(rawDb, options.walMode !== false);
    migrate(rawDb);
    this.db = new SQLiteCodeGraphDb(rawDb);
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  isHealthy(): boolean {
    try {
      this.db.raw.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }
}

export class SQLiteCodeGraphDb implements CodeGraphDb {
  private closed = false;
  private transactionDepth = 0;

  constructor(readonly raw: DatabaseType) {}

  prepare(sql: string): CodeGraphStatement {
    const translated = translateSqlForSqlite(sql);
    if (!translated) return new NoopStatement();
    return new SQLiteStatement(this.raw.prepare(translated));
  }

  async get<T = unknown>(
    sql: string,
    ...params: unknown[]
  ): Promise<T | undefined> {
    return this.prepare(sql).get<T>(...params);
  }

  async all<T = unknown>(
    sql: string,
    ...params: unknown[]
  ): Promise<T[]> {
    return this.prepare(sql).all<T>(...params);
  }

  async run(sql: string, ...params: unknown[]): Promise<QueryResultInfo> {
    return this.prepare(sql).run(...params);
  }

  async scalar(sql: string, ...params: unknown[]): Promise<number> {
    const row = await this.get(sql, ...params);
    return row ? Number(Object.values(row)[0] ?? 0) : 0;
  }

  async copyFromRows(
    table: string,
    columns: string[],
    rows: unknown[][],
    options: CopyFromRowsOptions = {},
  ): Promise<boolean> {
    if (rows.length === 0) return true;
    if (columns.length === 0) return true;
    const columnList = columns.map(quoteIdentifier).join(', ');
    const verb = options.ignoreConflicts && !options.suffix ? 'INSERT OR IGNORE' : 'INSERT';
    const suffix = options.suffix ? ` ${options.suffix.trim()}` : '';
    const maxRows = Math.max(1, Math.floor(SQLITE_MAX_BATCH_PARAMS / columns.length));

    try {
      for (let index = 0; index < rows.length; index += maxRows) {
        const batch = rows.slice(index, index + maxRows);
        const params: SqliteValue[] = [];
        const valuesSql = batch.map(row => {
          if (row.length !== columns.length) {
            throw new Error(`Expected ${columns.length} values for ${table}, received ${row.length}.`);
          }
          params.push(...row.map(sqliteValue));
          return `(${columns.map(() => '?').join(', ')})`;
        }).join(', ');
        const sql = `${verb} INTO ${quoteIdentifier(table)} (${columnList}) VALUES ${valuesSql}${suffix}`;
        this.raw.prepare(sql).run(...params);
      }
      return true;
    } catch {
      return false;
    }
  }

  async copyFromTextFiles(
    table: string,
    columns: string[],
    filePaths: string[],
    options: CopyFromRowsOptions = {},
  ): Promise<boolean> {
    if (filePaths.length === 0) return true;
    const chunk: unknown[][] = [];
    const flush = async (): Promise<void> => {
      if (chunk.length === 0) return;
      const copied = await this.copyFromRows(table, columns, chunk.splice(0), options);
      if (!copied) throw new Error(`SQLite bulk insert failed for ${table}.`);
    };

    for (const filePath of filePaths) {
      const reader = createInterface({
        input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
        crlfDelay: Infinity,
      });
      for await (const line of reader) {
        if (line.length === 0) continue;
        chunk.push(parseCopyTextLine(line));
        if (chunk.length >= 1000) await flush();
      }
    }
    await flush();
    return true;
  }

  transaction<T>(fn: () => T | Promise<T>): () => Promise<T> {
    return async () => {
      const savepoint = this.transactionDepth > 0 ? `codegraph_tx_${this.transactionDepth}` : undefined;
      if (savepoint) {
        this.raw.prepare(`SAVEPOINT ${savepoint}`).run();
      } else {
        this.raw.prepare('BEGIN IMMEDIATE').run();
      }
      this.transactionDepth++;
      try {
        const result = await fn();
        this.transactionDepth--;
        if (savepoint) {
          this.raw.prepare(`RELEASE SAVEPOINT ${savepoint}`).run();
        } else {
          this.raw.prepare('COMMIT').run();
        }
        return result;
      } catch (error) {
        this.transactionDepth--;
        if (savepoint) {
          this.raw.prepare(`ROLLBACK TO SAVEPOINT ${savepoint}`).run();
          this.raw.prepare(`RELEASE SAVEPOINT ${savepoint}`).run();
        } else {
          this.raw.prepare('ROLLBACK').run();
        }
        throw error;
      }
    };
  }

  async runMaintenance(): Promise<void> {
    try {
      this.raw.pragma('optimize');
    } catch {
      // Best-effort planner maintenance; never load-bearing for correctness.
    }
    try {
      this.raw.pragma('wal_checkpoint(PASSIVE)');
    } catch {
      // Ignore readonly/non-WAL/locked checkpoint failures.
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.raw.close();
  }
}

export function openSQLiteGraphBackend(root: string, graphDirName?: string): SQLiteGraphBackend {
  return new SQLiteGraphBackend({ root, graphDirName });
}

export function isWorkspaceIndexed(root: string, graphDirName?: string): boolean {
  const paths = getWorkspacePaths(path.resolve(root), graphDirName);
  if (!fs.existsSync(paths.dbPath)) return false;
  const db = new Database(paths.dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT current_snapshot_id FROM workspaces LIMIT 1')
      .get() as { current_snapshot_id?: string } | undefined;
    return Boolean(row?.current_snapshot_id);
  } catch {
    return false;
  } finally {
    db.close();
  }
}

export function getCurrentSnapshotId(root: string, graphDirName?: string): string | undefined {
  const paths = getWorkspacePaths(path.resolve(root), graphDirName);
  if (!fs.existsSync(paths.dbPath)) return undefined;
  const db = new Database(paths.dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT current_snapshot_id FROM workspaces LIMIT 1')
      .get() as { current_snapshot_id?: string } | undefined;
    return row?.current_snapshot_id;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

class SQLiteStatement implements CodeGraphStatement {
  constructor(private readonly statement: Statement) {}

  async get<T = unknown>(...params: unknown[]): Promise<T | undefined> {
    return this.statement.get(...params.map(sqliteValue)) as T | undefined;
  }

  async all<T = unknown>(...params: unknown[]): Promise<T[]> {
    return this.statement.all(...params.map(sqliteValue)) as T[];
  }

  async run(...params: unknown[]): Promise<QueryResultInfo> {
    const result = this.statement.run(...params.map(sqliteValue));
    return { changes: result.changes };
  }
}

class NoopStatement implements CodeGraphStatement {
  async get<T = unknown>(): Promise<T | undefined> {
    return undefined;
  }

  async all<T = unknown>(): Promise<T[]> {
    return [];
  }

  async run(): Promise<QueryResultInfo> {
    return { changes: 0 };
  }
}

function configurePragmas(db: DatabaseType, walMode: boolean): void {
  db.pragma('busy_timeout = 5000');
  if (walMode) db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -64000');
  db.pragma('mmap_size = 268435456');
}

function migrate(db: DatabaseType): void {
  createSchema(db);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

function createSchema(db: DatabaseType): void {
  db.exec(`
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

    CREATE TABLE IF NOT EXISTS snapshot_stats (
      snapshot_id TEXT PRIMARY KEY REFERENCES snapshots(id) ON DELETE CASCADE,
      files INTEGER NOT NULL DEFAULT 0,
      symbols INTEGER NOT NULL DEFAULT 0,
      imports INTEGER NOT NULL DEFAULT 0,
      field_usages INTEGER NOT NULL DEFAULT 0,
      call_edges INTEGER NOT NULL DEFAULT 0,
      call_edges_primary INTEGER NOT NULL DEFAULT 0,
      call_edges_low_signal INTEGER NOT NULL DEFAULT 0,
      call_edges_provider INTEGER NOT NULL DEFAULT 0,
      dependency_edges INTEGER NOT NULL DEFAULT 0,
      graph_nodes INTEGER NOT NULL DEFAULT 0,
      graph_edges INTEGER NOT NULL DEFAULT 0,
      endpoints INTEGER NOT NULL DEFAULT 0,
      beans INTEGER NOT NULL DEFAULT 0,
      endpoint_path_unresolved INTEGER NOT NULL DEFAULT 0,
      file_roles_json TEXT NOT NULL DEFAULT '[]',
      parse_failures_json TEXT,
      endpoint_warnings_json TEXT,
      top_unresolved_imports_json TEXT,
      top_unresolved_calls_json TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      blob_hash TEXT NOT NULL,
      mtime_ms REAL NOT NULL,
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
      parse_confidence REAL NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (provider_id, provider_version, blob_hash)
    );

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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      file TEXT NOT NULL,
      source TEXT NOT NULL,
      imported_symbols_json TEXT NOT NULL,
      line INTEGER NOT NULL,
      is_external INTEGER NOT NULL,
      file_role TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS type_refs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      file TEXT NOT NULL,
      referenced_type TEXT NOT NULL,
      context TEXT NOT NULL,
      line INTEGER NOT NULL,
      file_role TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS field_usages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      field_name TEXT NOT NULL,
      field_fq_name TEXT,
      owner_class TEXT,
      file TEXT NOT NULL,
      line INTEGER NOT NULL,
      "column" INTEGER NOT NULL,
      enclosing_class TEXT,
      enclosing_symbol TEXT,
      access_kind TEXT NOT NULL,
      receiver_text TEXT,
      context TEXT NOT NULL,
      confidence REAL NOT NULL,
      resolution_kind TEXT NOT NULL,
      file_role TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS call_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      caller TEXT NOT NULL,
      callee TEXT NOT NULL,
      file TEXT NOT NULL,
      line INTEGER NOT NULL,
      confidence REAL NOT NULL,
      resolution_kind TEXT NOT NULL,
      file_role TEXT NOT NULL,
      signal_tier TEXT NOT NULL DEFAULT 'primary',
      signal_reasons_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS dependency_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      from_file TEXT NOT NULL,
      to_file TEXT NOT NULL,
      kind TEXT NOT NULL,
      confidence REAL NOT NULL,
      resolution_kind TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS graph_nodes (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      node_type TEXT NOT NULL,
      label TEXT NOT NULL,
      file TEXT,
      line INTEGER,
      role TEXT,
      language TEXT,
      file_role TEXT,
      parent_node_id TEXT,
      stats_json TEXT NOT NULL DEFAULT '{}',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (snapshot_id, node_id)
    );

    CREATE TABLE IF NOT EXISTS graph_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      confidence REAL NOT NULL,
      edge_count INTEGER NOT NULL DEFAULT 1,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      UNIQUE (snapshot_id, from_node_id, to_node_id, edge_type)
    );

    CREATE TABLE IF NOT EXISTS annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      symbol_fq_name TEXT NOT NULL,
      annotation TEXT NOT NULL,
      file TEXT NOT NULL,
      line INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS endpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      confidence REAL NOT NULL,
      file_role TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS beans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      bean_type TEXT NOT NULL,
      implementation TEXT NOT NULL,
      scope TEXT,
      qualifiers_json TEXT NOT NULL,
      source TEXT NOT NULL,
      file TEXT NOT NULL,
      line INTEGER NOT NULL,
      confidence REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inheritance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      child_type TEXT NOT NULL,
      parent_type TEXT NOT NULL,
      kind TEXT NOT NULL,
      file TEXT NOT NULL,
      line INTEGER NOT NULL,
      confidence REAL NOT NULL
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
    CREATE INDEX IF NOT EXISTS idx_field_usages_name ON field_usages(snapshot_id, field_name);
    CREATE INDEX IF NOT EXISTS idx_field_usages_owner_name ON field_usages(snapshot_id, owner_class, field_name);
    CREATE INDEX IF NOT EXISTS idx_field_usages_file ON field_usages(snapshot_id, file);
    CREATE INDEX IF NOT EXISTS idx_field_usages_enclosing ON field_usages(snapshot_id, enclosing_symbol);
    CREATE INDEX IF NOT EXISTS idx_call_edges_file ON call_edges(snapshot_id, file);
    CREATE INDEX IF NOT EXISTS idx_call_edges_signal_file ON call_edges(snapshot_id, signal_tier, file);
    CREATE INDEX IF NOT EXISTS idx_call_edges_caller ON call_edges(snapshot_id, caller);
    CREATE INDEX IF NOT EXISTS idx_call_edges_callee ON call_edges(snapshot_id, callee);
    CREATE INDEX IF NOT EXISTS idx_dependency_from ON dependency_edges(snapshot_id, from_file);
    CREATE INDEX IF NOT EXISTS idx_dependency_to ON dependency_edges(snapshot_id, to_file);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(snapshot_id, node_type);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_file ON graph_nodes(snapshot_id, file);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(snapshot_id, from_node_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(snapshot_id, to_node_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(snapshot_id, edge_type);
    CREATE INDEX IF NOT EXISTS idx_annotations_annotation ON annotations(snapshot_id, annotation);
    CREATE INDEX IF NOT EXISTS idx_endpoints_path ON endpoints(snapshot_id, method, path);
    CREATE INDEX IF NOT EXISTS idx_beans_type ON beans(snapshot_id, bean_type);
    CREATE INDEX IF NOT EXISTS idx_inheritance_parent ON inheritance(snapshot_id, parent_type);
  `);

  ensureColumn(db, 'snapshots', 'index_provider_ids', "TEXT NOT NULL DEFAULT 'tree-sitter'");
  ensureColumn(db, 'snapshots', 'index_provider_versions_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'snapshots', 'index_provider_config_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'snapshot_stats', 'parse_failures_json', 'TEXT');
  ensureColumn(db, 'snapshot_stats', 'endpoint_warnings_json', 'TEXT');
  ensureColumn(db, 'snapshot_stats', 'top_unresolved_imports_json', 'TEXT');
  ensureColumn(db, 'snapshot_stats', 'top_unresolved_calls_json', 'TEXT');
  ensureColumn(db, 'snapshot_stats', 'field_usages', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'snapshot_stats', 'graph_nodes', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'snapshot_stats', 'graph_edges', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'call_edges', 'signal_tier', "TEXT NOT NULL DEFAULT 'primary'");
  ensureColumn(db, 'call_edges', 'signal_reasons_json', "TEXT NOT NULL DEFAULT '[]'");

  db.prepare('INSERT OR IGNORE INTO codegraph_schema(version, applied_at) VALUES (?, ?)').run(SCHEMA_VERSION, new Date().toISOString());
}

function ensureColumn(db: DatabaseType, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>;
  if (rows.some(row => row.name === column)) return;
  db.exec(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(column)} ${definition}`);
}

function translateSqlForSqlite(sql: string): string | undefined {
  const trimmed = sql.trim();
  if (!trimmed) return undefined;
  if (/^SET\s+(LOCAL\s+)?/i.test(trimmed)) return undefined;
  if (/^CREATE\s+EXTENSION\b/i.test(trimmed)) return undefined;
  if (/\bUSING\s+gin\b/i.test(trimmed)) return undefined;

  return trimmed
    .replace(/\bILIKE\b/gi, 'LIKE')
    .replace(/::\s*(?:integer|bigint|text|double precision|real|numeric|boolean)\b/gi, '')
    .replace(/\bNOW\(\)/gi, "datetime('now')")
    .replace(/\bSELECT\s+rowid\s+AS\s+row_id\b/gi, 'SELECT id AS row_id');
}

function sqliteValue(value: unknown): SqliteValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || Buffer.isBuffer(value)) {
    return value;
  }
  return String(value);
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function parseCopyTextLine(line: string): unknown[] {
  return line.split('\t').map(decodeCopyTextValue);
}

function decodeCopyTextValue(value: string): unknown {
  if (value === '\\N') return null;
  let out = '';
  for (let index = 0; index < value.length; index++) {
    const ch = value[index] ?? '';
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = value[++index] ?? '';
    switch (next) {
      case 't':
        out += '\t';
        break;
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case '\\':
        out += '\\';
        break;
      default:
        out += next;
        break;
    }
  }
  return out;
}
