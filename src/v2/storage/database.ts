import { openSQLiteGraphBackend, type SQLiteGraphBackend } from './sqlite-backend.js';
import type { CodeGraphDb } from './graph-backend.js';
import type { WorkspacePaths } from '../paths.js';

export type { CodeGraphDb } from './graph-backend.js';

export interface OpenCodeGraphDbResult {
  db: CodeGraphDb;
  paths: WorkspacePaths;
  backend: 'sqlite';
  dbPath: string;
  graph: SQLiteGraphBackend;
}

export async function openCodeGraphDb(root = process.cwd(), graphDirName?: string): Promise<OpenCodeGraphDbResult> {
  const graph = openSQLiteGraphBackend(root, graphDirName);
  return {
    db: graph.db,
    paths: graph.paths,
    backend: 'sqlite',
    dbPath: graph.dbPath,
    graph,
  };
}
