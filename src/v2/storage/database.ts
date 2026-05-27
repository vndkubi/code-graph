import { ensureCodeGraphDirs, getCodeGraphPaths, type CodeGraphPaths } from '../paths.js';
import { openPostgresCodeGraphDb, type PostgresCodeGraphDb } from './postgres.js';

export type CodeGraphDb = PostgresCodeGraphDb;

export interface OpenCodeGraphDbResult {
  db: CodeGraphDb;
  paths: CodeGraphPaths;
  backend: 'postgres';
  connectionString: string;
}

export async function openCodeGraphDb(homeOverride?: string): Promise<OpenCodeGraphDbResult> {
  const paths = getCodeGraphPaths(homeOverride);
  ensureCodeGraphDirs(paths);
  const { db, connectionString } = await openPostgresCodeGraphDb();
  return {
    db,
    paths,
    backend: 'postgres',
    connectionString,
  };
}
