import type { WorkspacePaths } from '../paths.js';

export type SqliteValue = string | number | bigint | Buffer | null;
export type SqlValue = string | number | boolean | null | undefined;

export interface QueryResultInfo {
  changes: number;
}

export interface CodeGraphStatement {
  get<T = unknown>(...params: unknown[]): Promise<T | undefined>;
  all<T = unknown>(...params: unknown[]): Promise<T[]>;
  run(...params: unknown[]): Promise<QueryResultInfo>;
}

export interface CopyFromRowsOptions {
  ignoreConflicts?: boolean;
  suffix?: string;
  synchronousCommit?: 'off' | 'on' | 'local';
}

export interface CodeGraphDb {
  prepare(sql: string): CodeGraphStatement;
  get<T = unknown>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  all<T = unknown>(sql: string, ...params: unknown[]): Promise<T[]>;
  run(sql: string, ...params: unknown[]): Promise<QueryResultInfo>;
  scalar(sql: string, ...params: unknown[]): Promise<number>;
  copyFromRows(table: string, columns: string[], rows: unknown[][], options?: CopyFromRowsOptions): Promise<boolean>;
  copyFromTextFiles(table: string, columns: string[], filePaths: string[], options?: CopyFromRowsOptions): Promise<boolean>;
  transaction<T>(fn: () => T | Promise<T>): () => Promise<T>;
  runMaintenance?(): Promise<void>;
  close(): Promise<void>;
}

export interface GraphBackend {
  readonly db: CodeGraphDb;
  readonly workspaceRoot: string;
  readonly dbPath: string;
  readonly paths: WorkspacePaths;
  close(): Promise<void>;
  isHealthy(): boolean;
}

export interface OpenGraphBackendOptions {
  root: string;
  graphDirName?: string;
  walMode?: boolean;
}
