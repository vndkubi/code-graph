import fs from 'node:fs';
import path from 'node:path';

export interface WorkspacePaths {
  root: string;
  graphDir: string;
  dbPath: string;
  sourceCacheDir: string;
  artifactDir: string;
  setupStatePath: string;
  logDir: string;
  queryLogPath: string;
}

export function getWorkspacePaths(root: string, graphDirName = '.codegraph'): WorkspacePaths {
  const resolvedRoot = path.resolve(root);
  const graphDir = path.join(resolvedRoot, graphDirName);
  const logDir = path.join(graphDir, 'logs');
  return {
    root: resolvedRoot,
    graphDir,
    dbPath: path.join(graphDir, 'graph.sqlite'),
    sourceCacheDir: path.join(graphDir, 'source-cache'),
    artifactDir: path.join(graphDir, 'artifacts'),
    setupStatePath: path.join(graphDir, 'setup-state.json'),
    logDir,
    queryLogPath: path.join(logDir, 'query.jsonl'),
  };
}

export function ensureWorkspaceDirs(paths: WorkspacePaths): void {
  fs.mkdirSync(paths.graphDir, { recursive: true });
  fs.mkdirSync(paths.sourceCacheDir, { recursive: true });
  fs.mkdirSync(paths.artifactDir, { recursive: true });
  fs.mkdirSync(paths.logDir, { recursive: true });
}
