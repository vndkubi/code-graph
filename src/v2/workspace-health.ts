import fs from 'node:fs';
import path from 'node:path';
import { getGitFreshnessInfo } from './git.js';
import { getWorkspacePaths } from './paths.js';
import { localArtifactStatus, type LocalArtifactStatus } from './mcp/local-artifact.js';
import { getCurrentSnapshotInfo } from './storage/sqlite-backend.js';

export type WorkspaceReadinessState = 'ready' | 'artifact_only' | 'unindexed' | 'missing' | 'invalid';

export interface WorkspaceReadinessRuntime {
  dbPath?: string;
  workspaceId?: string;
  snapshotId?: string;
}

export interface WorkspaceReadinessAction {
  label: string;
  command: string;
  reason: string;
}

export interface WorkspaceFreshness {
  available: boolean;
  isStale: boolean;
  snapshotCreatedAt?: string;
  snapshotHeadCommit?: string;
  currentHeadCommit?: string;
  snapshotDirtyHash?: string;
  currentDirtyHash?: string;
  warning?: string;
}

export interface WorkspaceReadiness {
  ok: boolean;
  state: WorkspaceReadinessState;
  root: string;
  backend: 'sqlite';
  paths: {
    graphDir: string;
    dbPath: string;
    artifactPath: string;
    setupStatePath: string;
    queryLogPath: string;
  };
  capabilities: {
    graphQueries: boolean;
    freshGraph: boolean;
    embeddedArtifact: boolean;
    facadeContext: boolean;
  };
  database: {
    ok: boolean;
    state: 'ready' | 'unindexed' | 'missing';
    dbPath: string;
    workspaceId?: string;
    snapshotId?: string;
  };
  artifact: LocalArtifactStatus;
  freshness?: WorkspaceFreshness;
  nextActions: WorkspaceReadinessAction[];
}

export function inspectWorkspaceReadiness(
  root: string,
  runtime: WorkspaceReadinessRuntime = {},
): WorkspaceReadiness {
  const rootDir = path.resolve(root);
  const paths = getWorkspacePaths(rootDir);
  const artifact = localArtifactStatus(rootDir);
  const dbPath = runtime.dbPath ?? paths.dbPath;
  const dbExists = fs.existsSync(dbPath);
  const snapshot = getCurrentSnapshotInfo(rootDir, { snapshotId: runtime.snapshotId });
  const snapshotId = runtime.snapshotId ?? snapshot?.snapshotId;
  const graphReady = Boolean(snapshotId);
  const databaseState = graphReady ? 'ready' : dbExists ? 'unindexed' : 'missing';
  const state = readinessState(graphReady, databaseState, artifact);
  const freshness = snapshot ? workspaceFreshness(rootDir, snapshot) : undefined;
  const capabilities = {
    graphQueries: graphReady,
    freshGraph: graphReady && freshness?.isStale !== true,
    embeddedArtifact: artifact.ok,
    facadeContext: graphReady || artifact.ok,
  };

  return {
    ok: capabilities.facadeContext,
    state,
    root: rootDir,
    backend: 'sqlite',
    paths: {
      graphDir: paths.graphDir,
      dbPath,
      artifactPath: artifact.artifactPath,
      setupStatePath: paths.setupStatePath,
      queryLogPath: paths.queryLogPath,
    },
    capabilities,
    database: {
      ok: graphReady,
      state: databaseState,
      dbPath,
      workspaceId: runtime.workspaceId ?? snapshot?.workspaceId,
      snapshotId,
    },
    artifact,
    freshness,
    nextActions: nextActionsFor(state, rootDir, freshness),
  };
}

function workspaceFreshness(
  root: string,
  snapshot: {
    createdAt?: string;
    headCommit?: string;
    dirtyHash?: string;
  },
): WorkspaceFreshness {
  const git = getGitFreshnessInfo(root);
  const isStale = git.available
    ? git.headCommit !== snapshot.headCommit || git.dirtyHash !== snapshot.dirtyHash
    : false;
  return {
    available: git.available,
    isStale,
    snapshotCreatedAt: snapshot.createdAt,
    snapshotHeadCommit: snapshot.headCommit,
    currentHeadCommit: git.headCommit,
    snapshotDirtyHash: snapshot.dirtyHash,
    currentDirtyHash: git.dirtyHash,
    warning: isStale
      ? 'Index may be stale. Run codegraph index --root <workspace>, or enable MCP auto-refresh for small active workspaces.'
      : undefined,
  };
}

function readinessState(
  graphReady: boolean,
  databaseState: 'ready' | 'unindexed' | 'missing',
  artifact: LocalArtifactStatus,
): WorkspaceReadinessState {
  if (graphReady || databaseState === 'ready') return 'ready';
  if (artifact.state === 'ready') return 'artifact_only';
  if (artifact.state === 'invalid') return 'invalid';
  if (databaseState === 'unindexed') return 'unindexed';
  return 'missing';
}

function nextActionsFor(
  state: WorkspaceReadinessState,
  root: string,
  freshness?: WorkspaceFreshness,
): WorkspaceReadinessAction[] {
  if (state === 'ready' && freshness?.isStale) {
    return [{
      label: 'Refresh SQLite graph',
      command: `codegraph index --root ${quoteCliPath(root)}`,
      reason: 'Refresh the SQLite graph so query results match the current working tree.',
    }];
  }
  switch (state) {
    case 'ready':
      return [];
    case 'artifact_only':
      return [{
        label: 'Build SQLite graph',
        command: `codegraph index --root ${quoteCliPath(root)}`,
        reason: 'Enable precise graph queries, impact analysis, and indexed source slices.',
      }];
    case 'invalid':
      return [{
        label: 'Rebuild setup',
        command: `codegraph setup --root ${quoteCliPath(root)}`,
        reason: 'Rebuild the invalid embedded artifact and SQLite graph.',
      }];
    case 'unindexed':
      return [{
        label: 'Finish setup',
        command: `codegraph setup --root ${quoteCliPath(root)}`,
        reason: 'Build both the SQLite graph and embedded artifact index.',
      }];
    case 'missing':
      return [{
        label: 'Run setup',
        command: `codegraph setup --root ${quoteCliPath(root)}`,
        reason: 'Build both the SQLite graph and embedded artifact index.',
      }];
  }
}

function quoteCliPath(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
