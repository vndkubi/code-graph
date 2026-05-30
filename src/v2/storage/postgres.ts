import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';

const { Pool } = pg;
type PgRow = pg.QueryResultRow;
type PgQueryable = pg.PoolClient;
const transactionClient = new AsyncLocalStorage<PgQueryable>();

export interface CopyFromRowsOptions {
  ignoreConflicts?: boolean;
  suffix?: string;
}

export interface PostgresOpenResult {
  db: PostgresCodeGraphDb;
  connectionString: string;
}

export interface QueryResultInfo {
  changes: number;
}

export interface PostgresStatement {
  get<T extends PgRow = PgRow>(...params: unknown[]): Promise<T | undefined>;
  all<T extends PgRow = PgRow>(...params: unknown[]): Promise<T[]>;
  run(...params: unknown[]): Promise<QueryResultInfo>;
}

export class PostgresCodeGraphDb {
  constructor(private readonly pool: pg.Pool) {}

  prepare(sql: string): PostgresStatement {
    return {
      get: <T extends PgRow = PgRow>(...params: unknown[]) => this.get<T>(sql, ...params),
      all: <T extends PgRow = PgRow>(...params: unknown[]) => this.all<T>(sql, ...params),
      run: (...params: unknown[]) => this.run(sql, ...params),
    };
  }

  async get<T extends PgRow = PgRow>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const result = await this.query<T>(sql, params);
    return result.rows[0];
  }

  async all<T extends PgRow = PgRow>(sql: string, ...params: unknown[]): Promise<T[]> {
    const result = await this.query<T>(sql, params);
    return result.rows;
  }

  async run(sql: string, ...params: unknown[]): Promise<QueryResultInfo> {
    const result = await this.query(sql, params);
    return { changes: result.rowCount ?? 0 };
  }

  async scalar(sql: string, ...params: unknown[]): Promise<number> {
    const row = await this.get<Record<string, unknown>>(sql, ...params);
    return row ? Number(Object.values(row)[0] ?? 0) : 0;
  }

  async copyFromRows(
    table: string,
    columns: string[],
    rows: unknown[][],
    options: CopyFromRowsOptions = {},
  ): Promise<boolean> {
    if (rows.length === 0) return true;
    const activeClient = transactionClient.getStore();
    const client = activeClient ?? await this.pool.connect();
    const savepoint = activeClient ? `codegraph_copy_${Date.now().toString(36)}` : undefined;
    try {
      if (savepoint) await client.query(`SAVEPOINT ${savepoint}`);
      await this.copyFromRowsUnsafe(client, table, columns, rows, options);
      if (savepoint) await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return true;
    } catch {
      if (savepoint) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      }
      return false;
    } finally {
      if (!activeClient) client.release();
    }
  }

  transaction<T>(fn: () => T | Promise<T>): () => Promise<T> {
    return () => this.runTransaction(fn);
  }

  private async runTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await transactionClient.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async query<T extends PgRow = PgRow>(sql: string, params: unknown[]): Promise<pg.QueryResult<T>> {
    const converted = convertSql(sql);
    return (transactionClient.getStore() ?? this.pool).query(converted, params) as Promise<pg.QueryResult<T>>;
  }

  private async copyFromRowsUnsafe(
    client: pg.PoolClient,
    table: string,
    columns: string[],
    rows: unknown[][],
    options: CopyFromRowsOptions,
  ): Promise<void> {
    if (options.ignoreConflicts || options.suffix) {
      const tempTable = `__codegraph_copy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
      await client.query(`CREATE TEMP TABLE ${quoteIdentifier(tempTable)} (LIKE ${quoteIdentifier(table)} INCLUDING DEFAULTS) ON COMMIT DROP`);
      await copyRowsInto(client, tempTable, columns, rows);
      const columnList = columns.map(quoteIdentifier).join(', ');
      const selectList = columns.map(quoteIdentifier).join(', ');
      const suffix = options.suffix ?? 'ON CONFLICT DO NOTHING';
      await client.query(`
        INSERT INTO ${quoteIdentifier(table)} (${columnList})
        SELECT ${selectList}
        FROM ${quoteIdentifier(tempTable)}
        ${suffix}
      `);
      await client.query(`DROP TABLE ${quoteIdentifier(tempTable)}`);
      return;
    }

    await copyRowsInto(client, table, columns, rows);
  }
}

export async function openPostgresCodeGraphDb(): Promise<PostgresOpenResult> {
  const connectionString = process.env.CODEGRAPH_DATABASE_URL
    ?? 'postgres://codegraph:codegraph_local@127.0.0.1:54329/codegraph';
  const statementTimeout = positiveInt(process.env.CODEGRAPH_DB_STATEMENT_TIMEOUT_MS, 30000);
  const lockTimeout = positiveInt(process.env.CODEGRAPH_DB_LOCK_TIMEOUT_MS, 5000);
  const maxParallelWorkersPerGather = nonNegativeInt(process.env.CODEGRAPH_DB_MAX_PARALLEL_WORKERS_PER_GATHER, 0);
  const pool = new Pool({
    connectionString,
    max: positiveInt(process.env.CODEGRAPH_PG_POOL_MAX, 10),
    connectionTimeoutMillis: positiveInt(process.env.CODEGRAPH_PG_CONNECTION_TIMEOUT_MS, 2000),
    idleTimeoutMillis: positiveInt(process.env.CODEGRAPH_PG_IDLE_TIMEOUT_MS, 30000),
    application_name: process.env.CODEGRAPH_PG_APPLICATION_NAME ?? 'codegraph',
    options: `-c statement_timeout=${statementTimeout} -c lock_timeout=${lockTimeout} -c max_parallel_workers_per_gather=${maxParallelWorkersPerGather}`,
  });
  await migratePostgres(pool);
  return {
    db: new PostgresCodeGraphDb(pool),
    connectionString,
  };
}

async function migratePostgres(pool: pg.Pool): Promise<void> {
  const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'postgres-schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('codegraph_schema_migration'))");
    await client.query(schema);
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('codegraph_schema_migration'))").catch(() => undefined);
    client.release();
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

async function copyRowsInto(client: pg.PoolClient, table: string, columns: string[], rows: unknown[][]): Promise<void> {
  const columnList = columns.map(quoteIdentifier).join(', ');
  const stream = client.query(copyFrom(
    `COPY ${quoteIdentifier(table)} (${columnList}) FROM STDIN WITH (FORMAT text)`,
  ) as never) as Writable;
  const finished = new Promise<void>((resolve, reject) => {
    stream.once('finish', resolve);
    stream.once('error', reject);
  });
  for (const row of rows) {
    const line = `${row.map(copyTextValue).join('\t')}\n`;
    if (!stream.write(line)) await once(stream, 'drain');
  }
  stream.end();
  await finished;
}

function copyTextValue(value: unknown): string {
  if (value === null || value === undefined) return '\\N';
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function convertSql(sql: string): string {
  const insertOrIgnore = /\bINSERT OR IGNORE INTO\b/i.test(sql);
  let index = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let result = '';

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i] ?? '';
    const next = sql[i + 1] ?? '';

    if (inLineComment) {
      result += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      result += ch;
      if (ch === '*' && next === '/') {
        result += next;
        i++;
        inBlockComment = false;
      }
      continue;
    }
    if (!inSingle && !inDouble && ch === '-' && next === '-') {
      result += ch + next;
      i++;
      inLineComment = true;
      continue;
    }
    if (!inSingle && !inDouble && ch === '/' && next === '*') {
      result += ch + next;
      i++;
      inBlockComment = true;
      continue;
    }
    if (!inDouble && ch === "'") {
      result += ch;
      if (inSingle && next === "'") {
        result += next;
        i++;
      } else {
        inSingle = !inSingle;
      }
      continue;
    }
    if (!inSingle && ch === '"') {
      result += ch;
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === '?') {
      index++;
      result += `$${index}`;
      continue;
    }
    result += ch;
  }

  return translateSqliteSyntax(result, insertOrIgnore);
}

function translateSqliteSyntax(sql: string, insertOrIgnore: boolean): string {
  let translated = sql
    .replace(/\bINSERT OR IGNORE INTO\b/gi, 'INSERT INTO')
    .replace(/\bSELECT rowid AS row_id\b/gi, 'SELECT id AS row_id')
    .replace(/\browid\b/gi, 'id')
    .replace(/\bcolumn\b/gi, '"column"');
  if (insertOrIgnore && !/\bON CONFLICT\b/i.test(translated)) {
    translated = `${translated.trimEnd()} ON CONFLICT DO NOTHING`;
  }
  return translated;
}
