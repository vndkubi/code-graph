import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import type { CodeGraphDb } from '../storage/database.js';
import type { ParseResult, SymbolInfo } from '../../analyzers/base-analyzer.js';
import { getGitInfo, type GitInfo } from '../git.js';
import { sha256Json, stableId } from '../hash.js';
import { scanManifest, scanManifestPaths, type ManifestFile, type ManifestPreviousFile } from './manifest.js';
import {
  parseContextForResult,
  parseFilesBatchToSpool,
  readParseContextItemsJsonl,
  readParseWorkResultsJsonl,
  symbolFqName,
  writeFactShardResult,
  type ParseContextItem,
  type ParseSpool,
  type ParseWorkItem,
} from './parse.js';
import { roleRank } from './file-role.js';
import { buildIndexProviderSet, type IndexProviderSet } from './providers.js';
import {
  addFactShardStats,
  createCopyTextWriter,
  factShardPathsForWorker,
  openFactShardWriter,
  readRawCallFacts,
  type FactShardPaths,
  type FactShardStats,
  type RawCallFact,
} from './fact-shards.js';
import {
  rebuildGraphOverlay as rebuildGraphOverlaySnapshot,
  type GraphOverlayCallFileEdge,
} from '../graph/overlay.js';

export interface IndexWorkspaceOptions {
  root: string;
  workspaceKey?: string;
  maxFileSizeBytes?: number;
  force?: boolean;
  parseWorkers?: number;
  incremental?: boolean;
  incrementalFileLimit?: number;
  incrementalFileRatio?: number;
  indexProviders?: string[] | string;
  scipIndexPath?: string;
  progress?: (event: IndexProgressEvent) => void;
  skipSnapshotStats?: boolean;
}

export interface RefreshWorkspacePathsOptions {
  root: string;
  changedPaths: string[];
  workspaceKey?: string;
  maxFileSizeBytes?: number;
  parseWorkers?: number;
  incrementalFileLimit?: number;
  indexProviders?: string[] | string;
  scipIndexPath?: string;
  progress?: (event: IndexProgressEvent) => void;
  skipSnapshotStats?: boolean;
}

export interface IndexWorkspaceResult {
  workspaceId: string;
  snapshotId: string;
  filesTotal: number;
  filesParsed: number;
  parseCacheHits: number;
  filesHashed: number;
  hashCacheHits: number;
  skippedUnchanged: boolean;
  incrementalUpdated: boolean;
  filesChanged: number;
  filesDeleted: number;
  parseWorkers: number;
  manifestScanMs: number;
  indexTimeMs: number;
  indexProviderIds: string[];
  indexProviderVersions: Record<string, string>;
  pathDeltaUpdated?: boolean;
  pathDeltaFallback?: string;
}

export interface IndexProgressEvent {
  phase: 'start' | 'workspace' | 'manifest' | 'diff' | 'parse-cache' | 'parse' | 'write' | 'edges' | 'analyze' | 'complete';
  status: 'start' | 'progress' | 'complete' | 'skipped' | 'fallback';
  message?: string;
  current?: number;
  total?: number;
  elapsedMs?: number;
  details?: Record<string, string | number | boolean | undefined>;
}

interface WorkspaceRow {
  id: string;
  root: string;
  workspace_key?: string;
  current_snapshot_id?: string;
  last_indexed_head?: string;
}

interface ParseCacheRow {
  provider_id: string;
  provider_version: string;
  blob_hash: string;
  parse_json: string;
}

interface SnapshotSummaryRow {
  head_commit?: string | null;
  dirty_hash: string;
  index_provider_ids?: string;
  index_provider_versions_json?: string;
  index_provider_config_json?: string;
}

interface ManifestChangeSet {
  changedFiles: ManifestFile[];
  deletedPaths: string[];
  unchangedFiles: ManifestFile[];
}

interface ParsePlan {
  file: ManifestFile;
  result?: ParseResult;
  cacheHit: boolean;
  cacheInsert: boolean;
  parseStatus: string;
}

interface PreparedParseBatch {
  plans: ParsePlan[];
  filesParsed: number;
  parseCacheHits: number;
  parseWorkers: number;
  elapsedMs: number;
}

interface PreparedStreamingParseBatch {
  spool: ParseSpool;
  filesParsed: number;
  parseCacheHits: number;
  parseWorkers: number;
  elapsedMs: number;
}

interface PreparedShardedFullParseBatch {
  spool: ParseSpool;
  filesParsed: number;
  parseCacheHits: number;
  parseWorkers: number;
  elapsedMs: number;
  factStats: FactShardStats;
}

type SqlValue = string | number | null | undefined;

const POST_INDEX_ANALYZE_TABLES = [
  'files',
  'symbols',
  'field_usages',
  'call_edges',
  'dependency_edges',
  'imports',
  'endpoints',
  'snapshot_stats',
];

interface BatchInsertOptions {
  ignoreConflicts?: boolean;
  suffix?: string;
  tryCopyWithoutConflict?: boolean;
  synchronousCommit?: 'off' | 'on' | 'local';
}

interface ParseResultForFile {
  file: ManifestFile;
  result: ParseResult;
}

interface MaterializeStats {
  symbols: number;
  annotations: number;
  inheritance: number;
  beans: number;
  endpoints: number;
  imports: number;
  typeRefs: number;
  fieldUsages: number;
  callEdges: number;
}

interface ResolvedCallShard {
  path: string;
  rows: number;
  rawRows: number;
  implementationRows: number;
  callFileEdges: GraphOverlayCallFileEdge[];
}

interface DedupedParseCacheShard {
  path: string;
  tempDir: string;
  rows: number;
  keys: string[];
}

interface CallResolutionContext {
  fieldsByFile: Map<string, Map<string, string>>;
  fieldsByClass: Map<string, Map<string, string>>;
  superClassByClass: Map<string, string>;
  outerClassByClass: Map<string, string>;
  implementationsByInterface: Map<string, string[]>;
  methodOwners: Set<string>;
  methodFiles: Map<string, string>;
  insertedImplementationEdges: Set<string>;
}

interface ClassifiedCallEdge {
  caller: string;
  callee: string;
  confidence: number;
  signalTier: CallSignalTier;
  signalReasons: string[];
}

interface CopyTelemetry {
  attempts: number;
  successes: number;
  fallbacks: number;
  errors: number;
  rows: number;
  ms: number;
  fallbackTables: Set<string>;
  byTable: Map<string, CopyTableTelemetry>;
}

interface CopyTableTelemetry {
  attempts: number;
  successes: number;
  fallbacks: number;
  errors: number;
  rows: number;
  ms: number;
}

interface BulkLoadIndexSpec {
  name: string;
  createSql: string;
}

const MAX_QUERY_BATCH_PARAMS = 10_000;
const MAX_WRITE_BATCH_PARAMS = boundedInt(process.env.CODEGRAPH_WRITE_BATCH_PARAMS, 50_000, 1_000, 60_000);
const PARSE_CACHE_HYDRATE_BATCH_SIZE = boundedInt(process.env.CODEGRAPH_PARSE_CACHE_HYDRATE_BATCH_SIZE, 100, 10, 1_000);
const WRITE_FILE_BATCH_SIZE = boundedInt(process.env.CODEGRAPH_WRITE_FILE_BATCH_SIZE, 1_500, 100, 2_000);
const COPY_INSERT_MIN_ROWS = boundedInt(process.env.CODEGRAPH_COPY_MIN_ROWS, 1_000, 100, 50_000);
const STREAMING_FULL_INDEX_MIN_FILES = boundedInt(process.env.CODEGRAPH_STREAMING_FULL_INDEX_MIN_FILES, 1, 0, 1_000_000);
const SHARDED_FULL_INDEX_MIN_FILES = boundedInt(process.env.CODEGRAPH_SHARDED_FULL_INDEX_MIN_FILES, 1, 0, 1_000_000);
const PARSE_CACHE_COPY_PARALLELISM = boundedInt(process.env.CODEGRAPH_PARSE_CACHE_COPY_PARALLELISM, 1, 1, 8);
const OVERLAP_PARSE_CACHE_COPY = envFlag(process.env.CODEGRAPH_OVERLAP_PARSE_CACHE_COPY);
const BULK_REBUILD_CALL_INDEX_MIN_FILES = boundedInt(process.env.CODEGRAPH_BULK_REBUILD_CALL_INDEX_MIN_FILES, 2_000, 0, 100_000);
const COPY_INSERT_TABLES = new Set([
  'files',
  'parse_cache',
  'symbols',
  'imports',
  'type_refs',
  'field_usages',
  'call_edges',
  'dependency_edges',
  'annotations',
  'endpoints',
  'beans',
  'inheritance',
]);
const PARSE_CACHE_COPY_COLUMNS = ['provider_id', 'provider_version', 'blob_hash', 'language', 'parse_json', 'has_parse_errors', 'parse_confidence', 'created_at'];
const MAX_CALL_ENDPOINT_LENGTH = 2048;
const CALL_ENDPOINT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
type CallSignalTier = 'primary' | 'low_signal' | 'provider';
const LOW_SIGNAL_UNQUALIFIED_CALLS = new Set([
  'assertArrayEquals',
  'assertEquals',
  'assertFalse',
  'assertNotEquals',
  'assertNotNull',
  'assertNull',
  'assertSame',
  'assertThat',
  'assertThrows',
  'assertTrue',
  'containsString',
  'empty',
  'equalTo',
  'expectThrows',
  'fail',
  'greaterThan',
  'greaterThanOrEqualTo',
  'hasSize',
  'instanceOf',
  'is',
  'lessThan',
  'lessThanOrEqualTo',
  'mock',
  'never',
  'not',
  'notNullValue',
  'nullValue',
  'randomAlphaOfLength',
  'randomBoolean',
  'randomFrom',
  'randomInt',
  'randomIntBetween',
  'sameInstance',
  'verify',
  'when',
]);

const HTTP_METHOD_ANNOTATIONS = new Map([
  ['GET', 'GET'],
  ['POST', 'POST'],
  ['PUT', 'PUT'],
  ['DELETE', 'DELETE'],
  ['PATCH', 'PATCH'],
  ['HEAD', 'HEAD'],
  ['OPTIONS', 'OPTIONS'],
  ['GetMapping', 'GET'],
  ['PostMapping', 'POST'],
  ['PutMapping', 'PUT'],
  ['DeleteMapping', 'DELETE'],
  ['PatchMapping', 'PATCH'],
  ['RequestMapping', 'REQUEST'],
]);

const BEAN_ANNOTATIONS = new Set([
  'Stateless',
  'Stateful',
  'Singleton',
  'ApplicationScoped',
  'RequestScoped',
  'SessionScoped',
  'ConversationScoped',
  'Dependent',
  'Named',
  'ManagedBean',
  'Model',
  'MessageDriven',
  'TransactionScoped',
  'ViewScoped',
  'FlowScoped',
  'ClientWindowScoped',
  'NoneScoped',
  'CustomScoped',
  'Service',
  'Component',
  'Repository',
  'Controller',
  'RestController',
]);

const FULL_BULK_LOAD_INDEXES: BulkLoadIndexSpec[] = [
  { name: 'idx_files_snapshot_hash', createSql: 'CREATE INDEX IF NOT EXISTS idx_files_snapshot_hash ON files(snapshot_id, blob_hash)' },
  { name: 'idx_symbols_name', createSql: 'CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(snapshot_id, simple_name, kind)' },
  { name: 'idx_symbols_file', createSql: 'CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(snapshot_id, file)' },
  { name: 'idx_symbols_fq', createSql: 'CREATE INDEX IF NOT EXISTS idx_symbols_fq ON symbols(snapshot_id, fq_name)' },
  { name: 'idx_symbols_framework_role', createSql: 'CREATE INDEX IF NOT EXISTS idx_symbols_framework_role ON symbols(snapshot_id, framework_role)' },
  { name: 'idx_imports_source', createSql: 'CREATE INDEX IF NOT EXISTS idx_imports_source ON imports(snapshot_id, source)' },
  { name: 'idx_imports_file', createSql: 'CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(snapshot_id, file)' },
  { name: 'idx_type_refs_type', createSql: 'CREATE INDEX IF NOT EXISTS idx_type_refs_type ON type_refs(snapshot_id, referenced_type)' },
  { name: 'idx_field_usages_name', createSql: 'CREATE INDEX IF NOT EXISTS idx_field_usages_name ON field_usages(snapshot_id, field_name)' },
  { name: 'idx_field_usages_owner_name', createSql: 'CREATE INDEX IF NOT EXISTS idx_field_usages_owner_name ON field_usages(snapshot_id, owner_class, field_name)' },
  { name: 'idx_field_usages_file', createSql: 'CREATE INDEX IF NOT EXISTS idx_field_usages_file ON field_usages(snapshot_id, file)' },
  { name: 'idx_field_usages_enclosing', createSql: 'CREATE INDEX IF NOT EXISTS idx_field_usages_enclosing ON field_usages(snapshot_id, enclosing_symbol)' },
  { name: 'idx_call_edges_file', createSql: 'CREATE INDEX IF NOT EXISTS idx_call_edges_file ON call_edges(snapshot_id, file)' },
  { name: 'idx_call_edges_signal_file', createSql: 'CREATE INDEX IF NOT EXISTS idx_call_edges_signal_file ON call_edges(snapshot_id, signal_tier, file)' },
  { name: 'idx_dependency_from', createSql: 'CREATE INDEX IF NOT EXISTS idx_dependency_from ON dependency_edges(snapshot_id, from_file)' },
  { name: 'idx_dependency_to', createSql: 'CREATE INDEX IF NOT EXISTS idx_dependency_to ON dependency_edges(snapshot_id, to_file)' },
  { name: 'idx_annotations_annotation', createSql: 'CREATE INDEX IF NOT EXISTS idx_annotations_annotation ON annotations(snapshot_id, annotation)' },
  { name: 'idx_endpoints_path', createSql: 'CREATE INDEX IF NOT EXISTS idx_endpoints_path ON endpoints(snapshot_id, method, path)' },
  { name: 'idx_beans_type', createSql: 'CREATE INDEX IF NOT EXISTS idx_beans_type ON beans(snapshot_id, bean_type)' },
  { name: 'idx_inheritance_parent', createSql: 'CREATE INDEX IF NOT EXISTS idx_inheritance_parent ON inheritance(snapshot_id, parent_type)' },
  { name: 'idx_symbols_simple_name_trgm', createSql: 'CREATE INDEX IF NOT EXISTS idx_symbols_simple_name_trgm ON symbols USING gin (simple_name gin_trgm_ops)' },
  { name: 'idx_symbols_fq_name_trgm', createSql: 'CREATE INDEX IF NOT EXISTS idx_symbols_fq_name_trgm ON symbols USING gin (fq_name gin_trgm_ops)' },
  { name: 'idx_symbols_file_trgm', createSql: 'CREATE INDEX IF NOT EXISTS idx_symbols_file_trgm ON symbols USING gin (file gin_trgm_ops)' },
  { name: 'idx_field_usages_name_trgm', createSql: 'CREATE INDEX IF NOT EXISTS idx_field_usages_name_trgm ON field_usages USING gin (field_name gin_trgm_ops)' },
  { name: 'idx_call_edges_caller_signal_trgm', createSql: "CREATE INDEX IF NOT EXISTS idx_call_edges_caller_signal_trgm ON call_edges USING gin (caller gin_trgm_ops) WHERE signal_tier IN ('primary', 'provider')" },
  { name: 'idx_call_edges_callee_signal_trgm', createSql: "CREATE INDEX IF NOT EXISTS idx_call_edges_callee_signal_trgm ON call_edges USING gin (callee gin_trgm_ops) WHERE signal_tier IN ('primary', 'provider')" },
  { name: 'idx_files_path_trgm', createSql: 'CREATE INDEX IF NOT EXISTS idx_files_path_trgm ON files USING gin (path gin_trgm_ops)' },
  { name: 'idx_endpoints_path_trgm', createSql: 'CREATE INDEX IF NOT EXISTS idx_endpoints_path_trgm ON endpoints USING gin (path gin_trgm_ops)' },
];

export class V2Indexer {
  private copyTelemetry: CopyTelemetry = emptyCopyTelemetry();

  constructor(private readonly db: CodeGraphDb) {}

  async registerWorkspace(root: string, workspaceKey?: string): Promise<{ workspaceId: string; root: string; workspaceKey?: string; currentSnapshotId?: string }> {
    const realRoot = path.resolve(root);
    const resolvedWorkspaceKey = normalizeWorkspaceKey(workspaceKey ?? process.env.CODEGRAPH_WORKSPACE_KEY);
    const git = resolvedWorkspaceKey ? workspaceKeyRegisterGitInfo(realRoot) : getGitInfo(realRoot);
    return this.registerWorkspaceWithGit(realRoot, workspaceKey, git);
  }

  private async registerWorkspaceWithGit(root: string, workspaceKey: string | undefined, git: GitInfo): Promise<{ workspaceId: string; root: string; workspaceKey?: string; currentSnapshotId?: string }> {
    const realRoot = path.resolve(root);
    const resolvedWorkspaceKey = normalizeWorkspaceKey(workspaceKey ?? process.env.CODEGRAPH_WORKSPACE_KEY);
    const workspaceId = stableId(workspaceIdentityParts(realRoot, git, resolvedWorkspaceKey));
    const now = new Date().toISOString();

    await this.db.prepare(`
      INSERT INTO workspaces (id, root, workspace_key, git_remote, git_common_dir, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        root = excluded.root,
        workspace_key = excluded.workspace_key,
        git_remote = COALESCE(excluded.git_remote, workspaces.git_remote),
        git_common_dir = COALESCE(excluded.git_common_dir, workspaces.git_common_dir),
        last_seen_at = excluded.last_seen_at
    `).run(workspaceId, realRoot, resolvedWorkspaceKey, git.remoteUrl, git.gitCommonDir, now, now);

    const row = await this.db.prepare('SELECT current_snapshot_id FROM workspaces WHERE id = ?')
      .get(workspaceId) as { current_snapshot_id?: string } | undefined;

    return { workspaceId, root: realRoot, workspaceKey: resolvedWorkspaceKey, currentSnapshotId: row?.current_snapshot_id };
  }

  async indexWorkspace(options: IndexWorkspaceOptions): Promise<IndexWorkspaceResult> {
    this.copyTelemetry = emptyCopyTelemetry();
    const start = Date.now();
    const realRoot = path.resolve(options.root);
    const providerSet = buildIndexProviderSet({
      root: realRoot,
      indexProviders: options.indexProviders,
      scipIndexPath: options.scipIndexPath,
    });
    options.progress?.({
      phase: 'start',
      status: 'start',
      message: `indexing ${realRoot}`,
      elapsedMs: 0,
      details: {
        root: realRoot,
        workspaceKey: options.workspaceKey ?? process.env.CODEGRAPH_WORKSPACE_KEY,
        indexProviders: providerSet.providerIds.join(','),
      },
    });
    const git = getGitInfo(realRoot);
    const workspace = await this.registerWorkspaceWithGit(realRoot, options.workspaceKey, git);
    options.progress?.({
      phase: 'workspace',
      status: 'complete',
      message: 'workspace registered',
      elapsedMs: Date.now() - start,
      details: {
        workspaceId: workspace.workspaceId,
        branch: git.branch,
        headCommit: git.headCommit,
      },
    });
    const latestSnapshotId = (await this.getWorkspace(workspace.workspaceId))?.current_snapshot_id;
    const previousFiles = latestSnapshotId && !options.force ? await this.previousFilesForSnapshot(latestSnapshotId) : undefined;
    const manifest = scanManifest(workspace.root, {
      maxFileSizeBytes: options.maxFileSizeBytes,
      previousFiles,
      progress: event => options.progress?.({
        phase: 'manifest',
        status: event.status,
        message: event.currentPath ? `scanning ${event.currentPath}` : undefined,
        current: event.filesFound,
        elapsedMs: Date.now() - start,
        details: {
          filesHashed: event.filesHashed,
          hashCacheHits: event.hashCacheHits,
          phaseElapsedMs: event.elapsedMs,
        },
      }),
    });
    const latestSnapshot = latestSnapshotId ? await this.snapshotSummary(latestSnapshotId) : undefined;
    const providerMatchesLatest = snapshotProviderMatches(latestSnapshot, providerSet);
    if (!options.force
      && latestSnapshotId
      && latestSnapshot
      && providerMatchesLatest
      && optionalStringsEqual(latestSnapshot.head_commit, git.headCommit)
      && latestSnapshot.dirty_hash === git.dirtyHash
      && previousFiles
      && manifestMatchesPreviousFiles(manifest.files, previousFiles)) {
      await this.db.prepare(`
        UPDATE workspaces
        SET last_seen_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), workspace.workspaceId);

      options.progress?.({
        phase: 'complete',
        status: 'skipped',
        message: 'index is already current',
        current: manifest.files.length,
        total: manifest.files.length,
        elapsedMs: Date.now() - start,
      });

      return {
        workspaceId: workspace.workspaceId,
        snapshotId: latestSnapshotId,
        filesTotal: manifest.files.length,
        filesParsed: 0,
        parseCacheHits: manifest.files.length,
        filesHashed: manifest.filesHashed,
        hashCacheHits: manifest.hashCacheHits,
        skippedUnchanged: true,
        incrementalUpdated: false,
        filesChanged: 0,
        filesDeleted: 0,
        parseWorkers: 0,
        manifestScanMs: manifest.scanTimeMs,
        indexTimeMs: Date.now() - start,
        indexProviderIds: providerSet.providerIds,
        indexProviderVersions: providerSet.providerVersions,
      };
    }

    const reusablePreviousFiles = providerMatchesLatest ? previousFiles : undefined;
    const changes = diffManifestFiles(manifest.files, reusablePreviousFiles ?? []);
    options.progress?.({
      phase: 'diff',
      status: 'complete',
      message: 'manifest diff complete',
      current: changes.changedFiles.length,
      total: manifest.files.length,
      elapsedMs: Date.now() - start,
      details: {
        changedFiles: changes.changedFiles.length,
        deletedFiles: changes.deletedPaths.length,
        unchangedFiles: changes.unchangedFiles.length,
      },
    });
    if (latestSnapshotId && providerMatchesLatest && shouldUseIncrementalUpdate(changes, manifest.files.length, options)) {
      const prepared = await this.prepareParseBatch(workspace.root, changes.changedFiles, providerSet, options.parseWorkers, start, options.progress);
      return this.updateSnapshotIncrementally({
        start,
        workspaceId: workspace.workspaceId,
        snapshotId: latestSnapshotId,
        workspaceRoot: workspace.root,
        git,
        manifestFilesTotal: manifest.files.length,
        manifestScanMs: manifest.scanTimeMs,
        filesHashed: manifest.filesHashed,
        hashCacheHits: manifest.hashCacheHits,
        changes,
        prepared,
        providerSet,
        progress: options.progress,
      });
    }

    const snapshotId = stableId([
      workspace.workspaceId,
      git.headCommit,
      git.treeHash,
      git.dirtyHash,
      sha256Json(manifest.files.map(f => [f.relPath, f.blobHash])),
      providerSet.id,
      providerSet.version,
      String(Date.now()),
    ]);
    const now = new Date().toISOString();

    let filesParsed = 0;
    let parseCacheHits = 0;
    const previousByPath = new Map((reusablePreviousFiles ?? []).map(file => [file.path, file]));
    if (shouldUseShardedFullIndex(changes, providerSet)) {
      const shardedPrepared = await this.prepareShardedFullParseBatch(
        workspace.root,
        changes.changedFiles,
        providerSet,
        snapshotId,
        now,
        options.parseWorkers,
        start,
        options.progress,
      );
      if (shardedPrepared) {
        try {
          return await this.writeShardedFullSnapshot({
            start,
            workspaceId: workspace.workspaceId,
            workspaceRoot: workspace.root,
            git,
            snapshotId,
            now,
            manifest,
            changes,
            prepared: shardedPrepared,
            providerSet,
            skipSnapshotStats: options.skipSnapshotStats,
            progress: options.progress,
          });
        } finally {
          shardedPrepared.spool.close();
        }
      }
    }
    if (shouldUseStreamingFullIndex(changes, providerSet)) {
      const streamingPrepared = await this.prepareStreamingFullParseBatch(
        workspace.root,
        changes.changedFiles,
        providerSet,
        options.parseWorkers,
        start,
        options.progress,
      );
      if (streamingPrepared) {
        try {
          return await this.writeStreamingFullSnapshot({
            start,
            workspaceId: workspace.workspaceId,
            workspaceRoot: workspace.root,
            git,
            snapshotId,
            now,
            manifest,
            changes,
            prepared: streamingPrepared,
            providerSet,
            skipSnapshotStats: options.skipSnapshotStats,
            progress: options.progress,
          });
        } finally {
          streamingPrepared.spool.close();
        }
      }
    }
    const prepared = await this.prepareParseBatch(workspace.root, changes.changedFiles, providerSet, options.parseWorkers, start, options.progress);
    const parsePlanByPath = new Map(prepared.plans.map(plan => [plan.file.relPath, plan]));
    filesParsed = prepared.filesParsed;
    parseCacheHits = changes.unchangedFiles.length + prepared.parseCacheHits;
    const rebuildCallSearchIndexes = changes.changedFiles.length >= BULK_REBUILD_CALL_INDEX_MIN_FILES;
    const preResolveCallEdges = changes.unchangedFiles.length === 0;
    const callResolutionContext = preResolveCallEdges
      ? this.buildCallResolutionContext(prepared.plans)
      : undefined;

    const tx = this.db.transaction(async () => {
      options.progress?.({
        phase: 'write',
        status: 'start',
        message: 'writing snapshot rows',
        current: 0,
        total: manifest.files.length,
        elapsedMs: Date.now() - start,
      });
      await this.db.prepare(`
        INSERT INTO snapshots (
          id, workspace_id, branch, head_commit, tree_hash, dirty_hash, created_at, status,
          manifest_scan_ms, files_total,
          index_provider_ids, index_provider_versions_json, index_provider_config_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'indexing', ?, ?, ?, ?, ?)
      `).run(
        snapshotId,
        workspace.workspaceId,
        git.branch,
        git.headCommit,
        git.treeHash,
        git.dirtyHash,
        now,
        manifest.scanTimeMs,
        manifest.files.length,
        providerIdsText(providerSet),
        JSON.stringify(providerSet.providerVersions),
        JSON.stringify(providerSet.config),
      );

      if (rebuildCallSearchIndexes) {
        options.progress?.({
          phase: 'write',
          status: 'start',
          message: 'dropping call search indexes for bulk load',
          elapsedMs: Date.now() - start,
        });
        await this.dropCallSearchIndexesForBulkLoad();
      }

      const parseStatusByPath = new Map<string, string>();
      for (const file of manifest.files) {
        const previous = previousByPath.get(file.relPath);
        if (previous && previous.blobHash === file.blobHash) {
          parseStatusByPath.set(file.relPath, previous.parseStatus ?? 'ok');
          continue;
        }

        const plan = parsePlanByPath.get(file.relPath);
        parseStatusByPath.set(file.relPath, plan?.parseStatus ?? 'skipped');
      }
      const filesWriteStart = Date.now();
      await this.insertFiles(snapshotId, manifest.files, parseStatusByPath, { upsert: false });
      options.progress?.({
        phase: 'write',
        status: 'progress',
        message: 'file manifest written',
        current: manifest.files.length,
        total: manifest.files.length,
        elapsedMs: Date.now() - start,
        details: { phaseElapsedMs: Date.now() - filesWriteStart, ...this.copyTelemetryDetails() },
      });

      let filesWritten = 0;
      let lastWriteProgressAt = 0;
      const materializeTotals = emptyMaterializeStats();
      const parseCacheInsertKeys = new Set<string>();
      for (const fileBatch of chunkArray(manifest.files, WRITE_FILE_BATCH_SIZE)) {
        const batchWriteStart = Date.now();
        const parseCacheItems: ParseResultForFile[] = [];
        const materializeItems: ParseResultForFile[] = [];
        for (const file of fileBatch) {
          const previous = previousByPath.get(file.relPath);
          if (previous && previous.blobHash === file.blobHash) continue;

          const plan = parsePlanByPath.get(file.relPath);
          if (!plan?.result) continue;
          materializeItems.push({ file, result: plan.result });
          if (plan.cacheInsert) parseCacheItems.push({ file, result: plan.result });
        }
        await this.insertParseCaches(parseCacheItems, now, providerSet, parseCacheInsertKeys);
        addMaterializeStats(materializeTotals, await this.materializeParseResults(snapshotId, materializeItems, callResolutionContext));

        filesWritten += fileBatch.length;
        const currentFile = fileBatch[fileBatch.length - 1]!;
        lastWriteProgressAt = reportProgressEvery(options.progress, lastWriteProgressAt, {
          phase: 'write',
          status: filesWritten === manifest.files.length ? 'complete' : 'progress',
          message: `writing ${currentFile.relPath}`,
          current: filesWritten,
          total: manifest.files.length,
          elapsedMs: Date.now() - start,
          details: {
            phaseElapsedMs: Date.now() - batchWriteStart,
            symbols: materializeTotals.symbols,
            callEdges: materializeTotals.callEdges,
            typeRefs: materializeTotals.typeRefs,
            ...this.copyTelemetryDetails(),
          },
        });
      }

      if (latestSnapshotId && providerMatchesLatest) {
        options.progress?.({
          phase: 'edges',
          status: 'start',
          message: 'copying unchanged graph rows',
          elapsedMs: Date.now() - start,
        });
        await this.copyUnchangedRows(latestSnapshotId, snapshotId);
      }
      const resolveStart = Date.now();
      options.progress?.({
        phase: 'edges',
        status: 'start',
        message: preResolveCallEdges ? 'call edges pre-resolved during materialization' : 'resolving call edges',
        elapsedMs: Date.now() - start,
        details: { preResolved: preResolveCallEdges },
      });
      if (!preResolveCallEdges) {
        await this.resolveCallEdges(snapshotId);
      }
      options.progress?.({
        phase: 'edges',
        status: 'complete',
        message: preResolveCallEdges ? 'call edge DB resolve skipped' : 'call edges resolved',
        elapsedMs: Date.now() - start,
        details: { phaseElapsedMs: Date.now() - resolveStart, preResolved: preResolveCallEdges },
      });
      if (rebuildCallSearchIndexes) {
        const indexRebuildStart = Date.now();
        options.progress?.({
          phase: 'edges',
          status: 'start',
          message: 'rebuilding call search indexes',
          elapsedMs: Date.now() - start,
        });
        await this.rebuildCallSearchIndexesAfterBulkLoad();
        options.progress?.({
          phase: 'edges',
          status: 'complete',
          message: 'call search indexes rebuilt',
          elapsedMs: Date.now() - start,
          details: { phaseElapsedMs: Date.now() - indexRebuildStart },
        });
      }
      const dependencyRebuildStart = Date.now();
      options.progress?.({
        phase: 'edges',
        status: 'start',
        message: 'rebuilding dependency edges',
        elapsedMs: Date.now() - start,
      });
      await this.rebuildDependencyEdges(snapshotId);
      options.progress?.({
        phase: 'edges',
        status: 'complete',
        message: 'dependency edges rebuilt',
        elapsedMs: Date.now() - start,
        details: { phaseElapsedMs: Date.now() - dependencyRebuildStart },
      });
      await this.rebuildGraphOverlay(snapshotId, options.progress, start);
      if (!options.skipSnapshotStats) {
        await this.refreshSnapshotStats(snapshotId);
      }
      await this.db.prepare(`
        UPDATE snapshots
        SET status = 'ready',
            index_time_ms = ?,
            files_parsed = ?,
            parse_cache_hits = ?
        WHERE id = ?
      `).run(Date.now() - start, filesParsed, parseCacheHits, snapshotId);
      await this.db.prepare(`
        UPDATE workspaces
        SET current_snapshot_id = ?, last_indexed_head = ?, last_seen_at = ?
        WHERE id = ?
      `).run(snapshotId, git.headCommit, now, workspace.workspaceId);
    });

    await tx();
    await this.maintainQueryPlanner(options.progress, start);

    options.progress?.({
      phase: 'complete',
      status: 'complete',
      message: 'index complete',
      current: manifest.files.length,
      total: manifest.files.length,
      elapsedMs: Date.now() - start,
      details: this.copyTelemetryDetails(),
    });

    return {
      workspaceId: workspace.workspaceId,
      snapshotId,
      filesTotal: manifest.files.length,
      filesParsed,
      parseCacheHits,
      filesHashed: manifest.filesHashed,
      hashCacheHits: manifest.hashCacheHits,
      skippedUnchanged: false,
      incrementalUpdated: false,
      filesChanged: changes.changedFiles.length,
      filesDeleted: changes.deletedPaths.length,
      parseWorkers: prepared.parseWorkers,
      manifestScanMs: manifest.scanTimeMs,
      indexTimeMs: Date.now() - start,
      indexProviderIds: providerSet.providerIds,
      indexProviderVersions: providerSet.providerVersions,
    };
  }

  async refreshWorkspacePaths(options: RefreshWorkspacePathsOptions): Promise<IndexWorkspaceResult> {
    this.copyTelemetry = emptyCopyTelemetry();
    const start = Date.now();
    const realRoot = path.resolve(options.root);
    const providerSet = buildIndexProviderSet({
      root: realRoot,
      indexProviders: options.indexProviders,
      scipIndexPath: options.scipIndexPath,
    });
    const normalizedChangedPaths = uniqueStrings(options.changedPaths
      .map(file => normalizeRefreshPath(realRoot, file))
      .filter(Boolean));
    const fileLimit = options.incrementalFileLimit ?? 200;
    if (normalizedChangedPaths.length === 0) {
      const result = await this.indexWorkspace({ ...options, root: realRoot });
      return { ...result, pathDeltaUpdated: false, pathDeltaFallback: 'no-paths' };
    }
    if (normalizedChangedPaths.length > fileLimit) {
      const result = await this.indexWorkspace({ ...options, root: realRoot });
      return { ...result, pathDeltaUpdated: false, pathDeltaFallback: 'path-count-exceeds-limit' };
    }

    options.progress?.({
      phase: 'start',
      status: 'start',
      message: `path-delta refresh ${realRoot}`,
      elapsedMs: 0,
      details: {
        changedPaths: normalizedChangedPaths.length,
        workspaceKey: options.workspaceKey ?? process.env.CODEGRAPH_WORKSPACE_KEY,
        indexProviders: providerSet.providerIds.join(','),
      },
    });
    const git = getGitInfo(realRoot);
    const workspace = await this.registerWorkspaceWithGit(realRoot, options.workspaceKey, git);
    const latestSnapshotId = (await this.getWorkspace(workspace.workspaceId))?.current_snapshot_id;
    if (!latestSnapshotId) {
      const result = await this.indexWorkspace({ ...options, root: realRoot });
      return { ...result, pathDeltaUpdated: false, pathDeltaFallback: 'no-current-snapshot' };
    }
    const latestSnapshot = await this.snapshotSummary(latestSnapshotId);
    if (!snapshotProviderMatches(latestSnapshot, providerSet)) {
      const result = await this.indexWorkspace({ ...options, root: realRoot });
      return { ...result, pathDeltaUpdated: false, pathDeltaFallback: 'index-provider-changed' };
    }
    const previousFiles = await this.previousFilesForSnapshot(latestSnapshotId);
    const previousByPath = new Map(previousFiles.map(file => [file.path, file]));
    const pathManifest = scanManifestPaths(realRoot, normalizedChangedPaths, {
      maxFileSizeBytes: options.maxFileSizeBytes,
      previousFiles,
    });
    const changedFiles = pathManifest.files.filter(file => previousByPath.get(file.relPath)?.blobHash !== file.blobHash);
    const deletedPaths = uniqueStrings([
      ...pathManifest.deletedPaths,
      ...normalizedChangedPaths.filter(file => previousByPath.has(file) && !pathManifest.files.some(changed => changed.relPath === file)),
    ]).filter(file => previousByPath.has(file));
    const changeCount = changedFiles.length + deletedPaths.length;
    options.progress?.({
      phase: 'diff',
      status: 'complete',
      message: 'path-delta diff complete',
      current: changeCount,
      total: normalizedChangedPaths.length,
      elapsedMs: Date.now() - start,
      details: {
        changedFiles: changedFiles.length,
        deletedFiles: deletedPaths.length,
        skippedPaths: pathManifest.skippedPaths.length,
      },
    });

    if (changeCount === 0) {
      return {
        workspaceId: workspace.workspaceId,
        snapshotId: latestSnapshotId,
        filesTotal: previousFiles.length,
        filesParsed: 0,
        parseCacheHits: 0,
        filesHashed: pathManifest.filesHashed,
        hashCacheHits: pathManifest.hashCacheHits,
        skippedUnchanged: true,
        incrementalUpdated: false,
        filesChanged: 0,
        filesDeleted: 0,
        parseWorkers: 0,
        manifestScanMs: pathManifest.scanTimeMs,
        indexTimeMs: Date.now() - start,
        indexProviderIds: providerSet.providerIds,
        indexProviderVersions: providerSet.providerVersions,
        pathDeltaUpdated: true,
      };
    }

    const prepared = await this.prepareParseBatch(realRoot, changedFiles, providerSet, options.parseWorkers, start, options.progress);
    const addedCount = changedFiles.filter(file => !previousByPath.has(file.relPath)).length;
    const filesTotal = Math.max(0, previousFiles.length + addedCount - deletedPaths.length);
    const result = await this.updateSnapshotIncrementally({
      start,
      workspaceId: workspace.workspaceId,
      snapshotId: latestSnapshotId,
      workspaceRoot: realRoot,
      git,
      manifestFilesTotal: filesTotal,
      manifestScanMs: pathManifest.scanTimeMs,
      filesHashed: pathManifest.filesHashed,
      hashCacheHits: pathManifest.hashCacheHits,
      changes: {
        changedFiles,
        deletedPaths,
        unchangedFiles: [],
      },
      prepared,
      providerSet,
      skipSnapshotStats: options.skipSnapshotStats,
      progress: options.progress,
    });
    return { ...result, pathDeltaUpdated: true };
  }

  private async refreshSnapshotStats(snapshotId: string): Promise<void> {
    const now = new Date().toISOString();
    const count = (sql: string, ...params: unknown[]) => this.db.scalar(sql, ...params);
    const [
      files,
      symbols,
      imports,
      fieldUsages,
      callEdges,
      callEdgesPrimary,
      callEdgesLowSignal,
      callEdgesProvider,
      dependencyEdges,
      graphNodes,
      graphEdges,
      endpoints,
      beans,
      endpointPathUnresolved,
    ] = await Promise.all([
      count('SELECT COUNT(*) FROM files WHERE snapshot_id = ?', snapshotId),
      count('SELECT COUNT(*) FROM symbols WHERE snapshot_id = ?', snapshotId),
      count('SELECT COUNT(*) FROM imports WHERE snapshot_id = ?', snapshotId),
      count('SELECT COUNT(*) FROM field_usages WHERE snapshot_id = ?', snapshotId),
      count('SELECT COUNT(*) FROM call_edges WHERE snapshot_id = ?', snapshotId),
      count("SELECT COUNT(*) FROM call_edges WHERE snapshot_id = ? AND signal_tier IN ('primary', 'provider')", snapshotId),
      count("SELECT COUNT(*) FROM call_edges WHERE snapshot_id = ? AND signal_tier = 'low_signal'", snapshotId),
      count("SELECT COUNT(*) FROM call_edges WHERE snapshot_id = ? AND signal_tier = 'provider'", snapshotId),
      count('SELECT COUNT(*) FROM dependency_edges WHERE snapshot_id = ?', snapshotId),
      count('SELECT COUNT(*) FROM graph_nodes WHERE snapshot_id = ?', snapshotId),
      count('SELECT COUNT(*) FROM graph_edges WHERE snapshot_id = ?', snapshotId),
      count('SELECT COUNT(*) FROM endpoints WHERE snapshot_id = ?', snapshotId),
      count('SELECT COUNT(*) FROM beans WHERE snapshot_id = ?', snapshotId),
      count("SELECT COUNT(*) FROM endpoints WHERE snapshot_id = ? AND path_resolution != 'exact'", snapshotId),
    ]);
    const fileRoles = await this.db.prepare(`
      SELECT file_role, COUNT(*) AS count
      FROM files
      WHERE snapshot_id = ?
      GROUP BY file_role
      ORDER BY file_role
    `).all(snapshotId) as Array<{ file_role: string; count: number | string }>;
    const parseFailures = await this.db.prepare(`
      SELECT path, language, parse_status
      FROM files
      WHERE snapshot_id = ? AND parse_status = 'error'
      ORDER BY path
      LIMIT 50
    `).all(snapshotId) as Array<{ path: string; language?: string; parse_status: string }>;
    const endpointWarnings = await this.db.prepare(`
      SELECT method, path, path_resolution, path_resolution_reason, handler_symbol, file, line
      FROM endpoints
      WHERE snapshot_id = ? AND path_resolution != 'exact'
      ORDER BY file, line
      LIMIT 50
    `).all(snapshotId) as Array<Record<string, unknown>>;
    const importCounts = await this.db.prepare(`
      SELECT source, COUNT(*) AS count
      FROM imports
      WHERE snapshot_id = ?
        AND source NOT LIKE 'java.%'
        AND source NOT LIKE 'javax.%'
        AND source NOT LIKE 'jakarta.%'
        AND source NOT LIKE 'org.springframework.%'
        AND source NOT LIKE 'lombok.%'
        AND source NOT LIKE 'org.junit.%'
        AND source NOT LIKE 'org.mockito.%'
        AND source NOT LIKE 'com.fasterxml.%'
        AND source NOT LIKE 'org.slf4j.%'
      GROUP BY source
      ORDER BY count DESC, source
      LIMIT 200
    `).all(snapshotId) as Array<{ source: string; count: number | string }>;
    const knownTypes = new Set((await this.db.prepare(`
      SELECT fq_name, simple_name
      FROM symbols
      WHERE snapshot_id = ? AND kind IN ('class', 'interface', 'enum', 'type')
    `).all(snapshotId) as Array<{ fq_name: string; simple_name: string }>)
      .flatMap(row => [row.fq_name, row.simple_name]));
    const topUnresolvedImports = importCounts
      .filter(row => !knownTypes.has(row.source) && !knownTypes.has(simpleTypeName(row.source)))
      .slice(0, 20)
      .map(row => ({ source: row.source, count: Number(row.count) }));
    const topUnresolvedCalls = await this.db.prepare(`
      SELECT callee, COUNT(*) AS count, MAX(confidence) AS max_confidence
      FROM call_edges
      WHERE snapshot_id = ? AND resolution_kind = 'name-only' AND signal_tier IN ('primary', 'provider')
      GROUP BY callee
      ORDER BY count DESC, callee
      LIMIT 20
    `).all(snapshotId) as Array<{ callee: string; count: number | string; max_confidence: number | string }>;

    await this.db.prepare(`
      INSERT INTO snapshot_stats (
        snapshot_id,
        files,
        symbols,
        imports,
        field_usages,
        call_edges,
        call_edges_primary,
        call_edges_low_signal,
        call_edges_provider,
        dependency_edges,
        graph_nodes,
        graph_edges,
        endpoints,
        beans,
        endpoint_path_unresolved,
        file_roles_json,
        parse_failures_json,
        endpoint_warnings_json,
        top_unresolved_imports_json,
        top_unresolved_calls_json,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_id) DO UPDATE SET
        files = excluded.files,
        symbols = excluded.symbols,
        imports = excluded.imports,
        field_usages = excluded.field_usages,
        call_edges = excluded.call_edges,
        call_edges_primary = excluded.call_edges_primary,
        call_edges_low_signal = excluded.call_edges_low_signal,
        call_edges_provider = excluded.call_edges_provider,
        dependency_edges = excluded.dependency_edges,
        graph_nodes = excluded.graph_nodes,
        graph_edges = excluded.graph_edges,
        endpoints = excluded.endpoints,
        beans = excluded.beans,
        endpoint_path_unresolved = excluded.endpoint_path_unresolved,
        file_roles_json = excluded.file_roles_json,
        parse_failures_json = excluded.parse_failures_json,
        endpoint_warnings_json = excluded.endpoint_warnings_json,
        top_unresolved_imports_json = excluded.top_unresolved_imports_json,
        top_unresolved_calls_json = excluded.top_unresolved_calls_json,
        updated_at = excluded.updated_at
    `).run(
      snapshotId,
      files,
      symbols,
      imports,
      fieldUsages,
      callEdges,
      callEdgesPrimary,
      callEdgesLowSignal,
      callEdgesProvider,
      dependencyEdges,
      graphNodes,
      graphEdges,
      endpoints,
      beans,
      endpointPathUnresolved,
      JSON.stringify(fileRoles.map(row => ({ file_role: row.file_role, count: Number(row.count) }))),
      JSON.stringify(parseFailures),
      JSON.stringify(endpointWarnings),
      JSON.stringify(topUnresolvedImports),
      JSON.stringify(topUnresolvedCalls.map(row => ({
        callee: row.callee,
        count: Number(row.count),
        maxConfidence: Number(row.max_confidence),
      }))),
      now,
    );
  }

  private async rebuildGraphOverlay(
    snapshotId: string,
    progress: IndexWorkspaceOptions['progress'],
    start: number,
    details: Record<string, string | number | boolean | undefined> = {},
    callFileEdges?: GraphOverlayCallFileEdge[],
  ): Promise<void> {
    if (!shouldBuildGraphOverlay()) {
      progress?.({
        phase: 'edges',
        status: 'skipped',
        message: 'graph overlay disabled',
        elapsedMs: Date.now() - start,
        details: { ...details, graphOverlayEnabled: false },
      });
      return;
    }
    const overlayStart = Date.now();
    progress?.({
      phase: 'edges',
      status: 'start',
      message: 'rebuilding graph overlay',
      elapsedMs: Date.now() - start,
      details,
    });
    const stats = await rebuildGraphOverlaySnapshot(this.db, snapshotId, { callFileEdges });
    progress?.({
      phase: 'edges',
      status: 'complete',
      message: 'graph overlay rebuilt',
      elapsedMs: Date.now() - start,
      details: {
        ...details,
        phaseElapsedMs: Date.now() - overlayStart,
        graphNodes: stats.nodes,
        graphEdges: stats.edges,
        fieldUsageEdgesIncluded: stats.fieldUsageEdgesIncluded,
      },
    });
  }

  private async maintainQueryPlanner(progress: IndexWorkspaceOptions['progress'], start: number): Promise<void> {
    if (!envFlag(process.env.CODEGRAPH_FULL_ANALYZE) && this.db.runMaintenance) {
      progress?.({
        phase: 'analyze',
        status: 'start',
        message: 'running lightweight SQLite maintenance',
        current: 0,
        total: 1,
        elapsedMs: Date.now() - start,
      });
      await this.db.runMaintenance();
      progress?.({
        phase: 'analyze',
        status: 'complete',
        message: 'SQLite maintenance complete',
        current: 1,
        total: 1,
        elapsedMs: Date.now() - start,
      });
      return;
    }

    progress?.({
      phase: 'analyze',
      status: 'start',
      message: 'updating SQLite planner statistics',
      current: 0,
      total: POST_INDEX_ANALYZE_TABLES.length,
      elapsedMs: Date.now() - start,
    });
    let current = 0;
    for (const table of POST_INDEX_ANALYZE_TABLES) {
      await this.db.prepare(`ANALYZE ${table}`).run();
      current++;
      progress?.({
        phase: 'analyze',
        status: current === POST_INDEX_ANALYZE_TABLES.length ? 'complete' : 'progress',
        message: `analyzed ${table}`,
        current,
        total: POST_INDEX_ANALYZE_TABLES.length,
        elapsedMs: Date.now() - start,
      });
    }
  }

  private async getWorkspace(workspaceId: string): Promise<WorkspaceRow | undefined> {
    return await this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as WorkspaceRow | undefined;
  }

  private async snapshotSummary(snapshotId: string): Promise<SnapshotSummaryRow | undefined> {
    return await this.db.prepare(`
      SELECT head_commit, dirty_hash, index_provider_ids, index_provider_versions_json, index_provider_config_json
      FROM snapshots
      WHERE id = ?
    `)
      .get(snapshotId) as SnapshotSummaryRow | undefined;
  }

  private async previousFilesForSnapshot(snapshotId: string): Promise<ManifestPreviousFile[]> {
    const rows = await this.db.prepare(`
      SELECT path, blob_hash, mtime_ms, size, parse_status
      FROM files
      WHERE snapshot_id = ?
    `).all(snapshotId) as Array<{ path: string; blob_hash: string; mtime_ms: number; size: number; parse_status: string }>;
    return rows.map(row => ({
      path: row.path,
      blobHash: row.blob_hash,
      mtimeMs: row.mtime_ms,
      size: row.size,
      parseStatus: row.parse_status,
    }));
  }

  private async prepareParseBatch(
    root: string,
    files: ManifestFile[],
    providerSet: IndexProviderSet,
    requestedWorkers: number | undefined,
    indexStart: number,
    progress?: (event: IndexProgressEvent) => void,
  ): Promise<PreparedParseBatch> {
    const start = Date.now();
    const plans: ParsePlan[] = [];
    const plannedPaths = new Set<string>();
    const addPlan = (plan: ParsePlan): void => {
      plans.push(plan);
      plannedPaths.add(plan.file.relPath);
    };
    const workItems: ParseWorkItem[] = [];
    let parseCacheHits = 0;
    let checkedFiles = 0;
    let lastCacheProgressAt = 0;

    progress?.({
      phase: 'parse-cache',
      status: 'start',
      message: 'checking parse cache',
      current: 0,
      total: files.length,
      elapsedMs: Date.now() - indexStart,
      details: { phaseElapsedMs: 0 },
    });
    const cachedByBlobHash = await this.parseCacheByBlobHash(files
      .filter(file => file.parseable && file.language)
      .map(file => file.blobHash), providerSet);

    for (const file of files) {
      if (!file.parseable || !file.language) {
        addPlan({
          file,
          cacheHit: false,
          cacheInsert: false,
          parseStatus: 'skipped',
        });
        checkedFiles++;
        lastCacheProgressAt = reportProgressEvery(progress, lastCacheProgressAt, {
          phase: 'parse-cache',
          status: 'progress',
          message: `checking ${file.relPath}`,
          current: checkedFiles,
          total: files.length,
          elapsedMs: Date.now() - indexStart,
          details: { parseCacheHits, queuedForParse: workItems.length, phaseElapsedMs: Date.now() - start },
        });
        continue;
      }

      const cached = cachedByBlobHash.get(file.blobHash);
      if (cached) {
        const result = JSON.parse(cached) as ParseResult;
        parseCacheHits++;
        addPlan({
          file,
          result,
          cacheHit: true,
          cacheInsert: false,
          parseStatus: result.hasParseErrors ? 'error' : 'ok',
        });
        checkedFiles++;
        lastCacheProgressAt = reportProgressEvery(progress, lastCacheProgressAt, {
          phase: 'parse-cache',
          status: 'progress',
          message: `checking ${file.relPath}`,
          current: checkedFiles,
          total: files.length,
          elapsedMs: Date.now() - indexStart,
          details: { parseCacheHits, queuedForParse: workItems.length, phaseElapsedMs: Date.now() - start },
        });
        continue;
      }

      workItems.push({
        key: file.relPath,
        absPath: file.absPath,
        rootDir: root,
        size: file.size,
      });
      checkedFiles++;
      lastCacheProgressAt = reportProgressEvery(progress, lastCacheProgressAt, {
        phase: 'parse-cache',
        status: 'progress',
        message: `checking ${file.relPath}`,
        current: checkedFiles,
        total: files.length,
        elapsedMs: Date.now() - indexStart,
        details: { parseCacheHits, queuedForParse: workItems.length, phaseElapsedMs: Date.now() - start },
      });
    }

    progress?.({
      phase: 'parse-cache',
      status: 'complete',
      message: 'parse cache check complete',
      current: files.length,
      total: files.length,
      elapsedMs: Date.now() - indexStart,
      details: { parseCacheHits, queuedForParse: workItems.length, phaseElapsedMs: Date.now() - start },
    });

    const parsed = providerSet.parseFiles(workItems, {
      workers: requestedWorkers,
      progress: event => progress?.({
        phase: 'parse',
        status: event.status,
        message: event.message,
        current: event.completed,
        total: event.total,
        elapsedMs: Date.now() - indexStart,
        details: { workers: event.workers, phaseElapsedMs: event.elapsedMs },
      }),
    });
    const planStart = Date.now();
    const parsedByPath = new Map(parsed.map(item => [item.key, item.result]));
    for (const file of files) {
      if (!file.parseable || !file.language) continue;
      if (plannedPaths.has(file.relPath)) continue;
      const result = parsedByPath.get(file.relPath);
      if (!result) continue;
      addPlan({
        file,
        result,
        cacheHit: false,
        cacheInsert: true,
        parseStatus: result.hasParseErrors ? 'error' : 'ok',
      });
    }

    const order = new Map(files.map((file, index) => [file.relPath, index]));
    plans.sort((a, b) => (order.get(a.file.relPath) ?? 0) - (order.get(b.file.relPath) ?? 0));
    progress?.({
      phase: 'parse',
      status: 'complete',
      message: 'parse plans prepared',
      current: plans.length,
      total: files.length,
      elapsedMs: Date.now() - indexStart,
      details: {
        filesParsed: workItems.length,
        parseCacheHits,
        planElapsedMs: Date.now() - planStart,
        phaseElapsedMs: Date.now() - start,
      },
    });

    return {
      plans,
      filesParsed: workItems.length,
      parseCacheHits,
      parseWorkers: parseFilesBatchWorkerCount(workItems.length, requestedWorkers),
      elapsedMs: Date.now() - start,
    };
  }

  private async prepareStreamingFullParseBatch(
    root: string,
    files: ManifestFile[],
    providerSet: IndexProviderSet,
    requestedWorkers: number | undefined,
    indexStart: number,
    progress?: (event: IndexProgressEvent) => void,
  ): Promise<PreparedStreamingParseBatch | undefined> {
    const start = Date.now();
    const parseableFiles = files.filter(file => file.parseable && file.language);
    progress?.({
      phase: 'parse-cache',
      status: 'start',
      message: 'checking parse cache for streaming full index',
      current: 0,
      total: files.length,
      elapsedMs: Date.now() - indexStart,
      details: { phaseElapsedMs: 0, streaming: true },
    });
    const cacheHits = await this.parseCacheHitBlobHashes(parseableFiles.map(file => file.blobHash), providerSet);
    let parseCacheHits = 0;
    for (const file of parseableFiles) {
      if (cacheHits.has(file.blobHash)) parseCacheHits++;
    }

    if (parseCacheHits > 0) {
      progress?.({
        phase: 'parse-cache',
        status: 'fallback',
        message: 'streaming full index skipped because parse cache hits require provider merge fallback',
        current: parseCacheHits,
        total: files.length,
        elapsedMs: Date.now() - indexStart,
        details: { parseCacheHits, phaseElapsedMs: Date.now() - start, streaming: false },
      });
      return undefined;
    }

    const workItems: ParseWorkItem[] = parseableFiles.map(file => ({
      key: file.relPath,
      absPath: file.absPath,
      rootDir: root,
      size: file.size,
    }));
    progress?.({
      phase: 'parse-cache',
      status: 'complete',
      message: 'parse cache check complete',
      current: files.length,
      total: files.length,
      elapsedMs: Date.now() - indexStart,
      details: { parseCacheHits, queuedForParse: workItems.length, phaseElapsedMs: Date.now() - start, streaming: true },
    });

    const spool = parseFilesBatchToSpool(workItems, {
      workers: requestedWorkers,
      progress: event => progress?.({
        phase: 'parse',
        status: event.status,
        message: event.message,
        current: event.completed,
        total: event.total,
        elapsedMs: Date.now() - indexStart,
        details: { workers: event.workers, phaseElapsedMs: event.elapsedMs, streaming: true },
      }),
    });

    return {
      spool,
      filesParsed: workItems.length,
      parseCacheHits,
      parseWorkers: spool.workerCount,
      elapsedMs: Date.now() - start,
    };
  }

  private async prepareShardedFullParseBatch(
    root: string,
    files: ManifestFile[],
    providerSet: IndexProviderSet,
    snapshotId: string,
    now: string,
    requestedWorkers: number | undefined,
    indexStart: number,
    progress?: (event: IndexProgressEvent) => void,
  ): Promise<PreparedShardedFullParseBatch | undefined> {
    const start = Date.now();
    const parseableFiles = files.filter(file => file.parseable && file.language);
    progress?.({
      phase: 'parse-cache',
      status: 'start',
      message: 'checking parse cache for sharded full index',
      current: 0,
      total: files.length,
      elapsedMs: Date.now() - indexStart,
      details: { phaseElapsedMs: 0, sharded: true },
    });
    const cacheHits = await this.parseCacheHitBlobHashes(parseableFiles.map(file => file.blobHash), providerSet);
    let parseCacheHits = 0;
    for (const file of parseableFiles) {
      if (cacheHits.has(file.blobHash)) parseCacheHits++;
    }

    const cacheInsertBlobHashes = new Set<string>();
    const cacheHitFiles: ManifestFile[] = [];
    const workItems: ParseWorkItem[] = [];
    for (const file of parseableFiles) {
      if (cacheHits.has(file.blobHash)) {
        cacheHitFiles.push(file);
        continue;
      }
      const cacheInsert = !cacheInsertBlobHashes.has(file.blobHash);
      cacheInsertBlobHashes.add(file.blobHash);
      workItems.push({
        key: file.relPath,
        absPath: file.absPath,
        rootDir: root,
        size: file.size,
        blobHash: file.blobHash,
        language: file.language,
        role: file.role,
        cacheInsert,
      });
    }
    progress?.({
      phase: 'parse-cache',
      status: 'complete',
      message: 'parse cache check complete',
      current: files.length,
      total: files.length,
      elapsedMs: Date.now() - indexStart,
      details: { parseCacheHits, queuedForParse: workItems.length, phaseElapsedMs: Date.now() - start, sharded: true },
    });

    const spool = parseFilesBatchToSpool(workItems, {
      workers: requestedWorkers,
      spoolResults: false,
      factShard: {
        snapshotId,
        providerId: providerSet.id,
        providerVersion: providerSet.version,
        createdAt: now,
      },
      progress: event => progress?.({
        phase: 'parse',
        status: event.status,
        message: event.message,
        current: event.completed,
        total: event.total,
        elapsedMs: Date.now() - indexStart,
        details: { workers: event.workers, phaseElapsedMs: event.elapsedMs, sharded: true },
      }),
    });
    if (cacheHitFiles.length > 0) {
      await this.appendCachedParseFactsToSpool({
        root,
        snapshotId,
        now,
        providerSet,
        files: cacheHitFiles,
        spool,
        indexStart,
        progress,
      });
    }

    return {
      spool,
      filesParsed: workItems.length,
      parseCacheHits,
      parseWorkers: spool.workerCount,
      elapsedMs: Date.now() - start,
      factStats: spool.factStats,
    };
  }

  private async parseCacheHitBlobHashes(blobHashes: string[], providerSet: IndexProviderSet): Promise<Set<string>> {
    const unique = [...new Set(blobHashes)];
    const cached = new Set<string>();
    if (unique.length === 0) return cached;
    const hasAnyCache = await this.db.prepare(`
      SELECT blob_hash
      FROM parse_cache
      WHERE provider_id = ? AND provider_version = ?
      LIMIT 1
    `).get(providerSet.id, providerSet.version) as { blob_hash: string } | undefined;
    if (!hasAnyCache) return cached;
    for (const batch of chunkArray(unique, MAX_QUERY_BATCH_PARAMS)) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = await this.db.prepare(`
        SELECT blob_hash
        FROM parse_cache
        WHERE provider_id = ?
          AND provider_version = ?
          AND blob_hash IN (${placeholders})
      `).all(providerSet.id, providerSet.version, ...batch) as Array<{ blob_hash: string }>;
      for (const row of rows) cached.add(row.blob_hash);
    }
    return cached;
  }

  private async appendCachedParseFactsToSpool(args: {
    root: string;
    snapshotId: string;
    now: string;
    providerSet: IndexProviderSet;
    files: ManifestFile[];
    spool: ParseSpool;
    indexStart: number;
    progress?: (event: IndexProgressEvent) => void;
  }): Promise<void> {
    const start = Date.now();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cache-facts-'));
    const contextPath = path.join(tempDir, 'cached.context.json');
    const factPaths = factShardPathsForWorker(tempDir, 0);
    const factStatsPath = path.join(tempDir, 'cached.fact.stats.json');
    const contextFd = fs.openSync(contextPath, 'w');
    const factWriter = openFactShardWriter(factPaths);
    let completed = 0;
    let lastProgressAt = 0;
    let failed = false;
    try {
      const filesByBlob = new Map<string, ManifestFile[]>();
      for (const file of args.files) {
        const files = filesByBlob.get(file.blobHash) ?? [];
        files.push(file);
        filesByBlob.set(file.blobHash, files);
      }
      for (const blobHashBatch of chunkArray([...filesByBlob.keys()], PARSE_CACHE_HYDRATE_BATCH_SIZE)) {
        const placeholders = blobHashBatch.map(() => '?').join(', ');
        const rows = await this.db.prepare(`
          SELECT blob_hash, parse_json
          FROM parse_cache
          WHERE provider_id = ?
            AND provider_version = ?
            AND blob_hash IN (${placeholders})
        `).all(args.providerSet.id, args.providerSet.version, ...blobHashBatch) as ParseCacheRow[];
        const parseJsonByBlob = new Map(rows.map(row => [row.blob_hash, row.parse_json]));
        for (const blobHash of blobHashBatch) {
          const parseJson = parseJsonByBlob.get(blobHash);
          if (!parseJson) throw new Error(`Missing parse_cache row for cached blob ${blobHash}.`);
          const result = JSON.parse(parseJson) as ParseResult;
          for (const file of filesByBlob.get(blobHash) ?? []) {
            fs.writeSync(contextFd, `${JSON.stringify(parseContextForResult(file.relPath, result))}\n`);
            writeFactShardResult(factWriter, {
              snapshotId: args.snapshotId,
              providerId: args.providerSet.id,
              providerVersion: args.providerSet.version,
              createdAt: args.now,
            }, {
              key: file.relPath,
              absPath: file.absPath,
              rootDir: args.root,
              size: file.size,
              blobHash: file.blobHash,
              language: file.language,
              role: file.role,
              cacheInsert: false,
            }, result);
            completed++;
          }
        }
        lastProgressAt = reportProgressEvery(args.progress, lastProgressAt, {
          phase: 'parse-cache',
          status: completed === args.files.length ? 'complete' : 'progress',
          message: 'hydrating cached parse facts',
          current: completed,
          total: args.files.length,
          elapsedMs: Date.now() - args.indexStart,
          details: { phaseElapsedMs: Date.now() - start, sharded: true, cacheHydrate: true },
        });
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      fs.closeSync(contextFd);
      factWriter.close();
      if (!failed) fs.writeFileSync(factStatsPath, JSON.stringify(factWriter.stats));
      if (failed) fs.rmSync(tempDir, { recursive: true, force: true });
    }

    args.spool.contextShardPaths.push(contextPath);
    args.spool.factShardPaths.push(factPaths);
    args.spool.factStatsPaths.push(factStatsPath);
    args.spool.factStatsByShard.push(factWriter.stats);
    addFactShardStats(args.spool.factStats, factWriter.stats);
    args.spool.resultCount += args.files.length;
    const previousClose = args.spool.close;
    args.spool.close = () => {
      previousClose();
      fs.rmSync(tempDir, { recursive: true, force: true });
    };
  }

  private async parseCacheByBlobHash(blobHashes: string[], providerSet: IndexProviderSet): Promise<Map<string, string>> {
    const unique = [...new Set(blobHashes)];
    const cached = new Map<string, string>();
    for (const batch of chunkArray(unique, MAX_QUERY_BATCH_PARAMS)) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = await this.db.prepare(`
        SELECT blob_hash, parse_json
        FROM parse_cache
        WHERE provider_id = ?
          AND provider_version = ?
          AND blob_hash IN (${placeholders})
      `).all(providerSet.id, providerSet.version, ...batch) as ParseCacheRow[];
      for (const row of rows) cached.set(row.blob_hash, row.parse_json);
    }
    return cached;
  }

  private async insertParseCaches(
    items: ParseResultForFile[],
    now: string,
    providerSet: IndexProviderSet,
    insertedKeys?: Set<string>,
  ): Promise<void> {
    const rows: SqlValue[][] = [];
    for (const item of items) {
      if (!item.file.language) continue;
      const key = `${providerSet.id}\0${providerSet.version}\0${item.file.blobHash}`;
      if (insertedKeys?.has(key)) continue;
      insertedKeys?.add(key);
      rows.push([
        providerSet.id,
        providerSet.version,
        item.file.blobHash,
        item.file.language,
        JSON.stringify(item.result),
        item.result.hasParseErrors ? 1 : 0,
        item.result.parseConfidence,
        now,
      ]);
    }
    await this.insertRows(
      'parse_cache',
      PARSE_CACHE_COPY_COLUMNS,
      rows,
      parseCacheCopyOptions({ ignoreConflicts: true }),
    );
  }

  private async copyParseCacheShardsForShardedFullIndex(
    args: {
      start: number;
      prepared: PreparedShardedFullParseBatch;
      progress?: (event: IndexProgressEvent) => void;
    },
    factPaths: FactShardPaths[],
  ): Promise<void> {
    const parseCacheCopyStart = Date.now();
    let copyDetails: Record<string, string | number | boolean | undefined> = {
      sharded: true,
      parallelism: PARSE_CACHE_COPY_PARALLELISM,
    };
    let dedupedShard: DedupedParseCacheShard | undefined;
    try {
      const existingParseCacheRows = await this.db.scalar('SELECT COUNT(*) FROM parse_cache');
      if (existingParseCacheRows === 0 && shouldUseParseCacheDirectCopy()) {
        await this.copyTextShards(
          'parse_cache',
          PARSE_CACHE_COPY_COLUMNS,
          factShardFiles(factPaths, 'parseCache'),
          args.prepared.factStats.parseCache,
          parseCacheCopyOptions(),
        );
        copyDetails = {
          sharded: true,
          parseCacheDirectCopy: true,
          parseCacheRows: args.prepared.factStats.parseCache,
          parseCacheExistingRows: 0,
        };
      } else if (shouldUseParseCacheDedupCopy()) {
        dedupedShard = await this.writeDedupedParseCacheShard(factPaths, args.prepared.spool.factStatsByShard);
        const existingRows = dedupedShard.keys.length > 0
          ? await this.countExistingParseCacheRows(dedupedShard.keys)
          : 0;
        await this.copyTextShards(
          'parse_cache',
          PARSE_CACHE_COPY_COLUMNS,
          [dedupedShard.path],
          dedupedShard.rows,
          existingRows === 0
            ? parseCacheCopyOptions()
            : parseCacheCopyOptions({ ignoreConflicts: true }),
        );
        copyDetails = {
          sharded: true,
          parseCacheDeduped: true,
          parseCacheRows: dedupedShard.rows,
          parseCacheSourceRows: args.prepared.factStats.parseCache,
          parseCacheExistingRows: existingRows,
          parseCacheDirectCopy: existingRows === 0,
        };
      } else {
        copyDetails = {
          sharded: true,
          parallelism: PARSE_CACHE_COPY_PARALLELISM,
          parseCacheDirectCopy: false,
          parseCacheExistingRows: existingParseCacheRows,
        };
        await this.copyTextShardsByShardParallel(
          'parse_cache',
          PARSE_CACHE_COPY_COLUMNS,
          factPaths,
          args.prepared.spool.factStatsByShard,
          'parseCache',
          'parseCache',
          PARSE_CACHE_COPY_PARALLELISM,
          parseCacheCopyOptions({ ignoreConflicts: true }),
        );
      }
    } finally {
      if (dedupedShard) {
        fs.rmSync(dedupedShard.tempDir, { recursive: true, force: true });
      }
    }
    args.progress?.({
      phase: 'write',
      status: 'progress',
      message: 'parse cache shard copied',
      current: args.prepared.factStats.parseCache,
      total: args.prepared.filesParsed,
      elapsedMs: Date.now() - args.start,
      details: { phaseElapsedMs: Date.now() - parseCacheCopyStart, ...copyDetails, ...this.copyTelemetryDetails() },
    });
  }

  private async writeShardedFullSnapshot(args: {
    start: number;
    workspaceId: string;
    workspaceRoot: string;
    git: GitInfo;
    snapshotId: string;
    now: string;
    manifest: ReturnType<typeof scanManifest>;
    changes: ManifestChangeSet;
    prepared: PreparedShardedFullParseBatch;
    providerSet: IndexProviderSet;
    skipSnapshotStats?: boolean;
    progress?: (event: IndexProgressEvent) => void;
  }): Promise<IndexWorkspaceResult> {
    const fileByPath = new Map(args.manifest.files.map(file => [file.relPath, file]));
    const parseStatusByPath = new Map<string, string>();
    const context = createCallResolutionContext();
    const contextStart = Date.now();
    let contextFiles = 0;
    for (const item of this.parseContextItemsFromSpool(args.prepared.spool)) {
      parseStatusByPath.set(item.key, item.parseStatus);
      addParseContextItemToCallResolutionContext(context, item);
      contextFiles++;
    }
    args.progress?.({
      phase: 'parse',
      status: 'complete',
      message: 'sharded parse context built',
      current: contextFiles,
      total: args.prepared.filesParsed,
      elapsedMs: Date.now() - args.start,
      details: { phaseElapsedMs: Date.now() - contextStart, sharded: true },
    });

    const factPaths = args.prepared.spool.factShardPaths;
    if (args.prepared.filesParsed > 0 && factPaths.length === 0) {
      throw new Error('Sharded full index did not produce fact shards.');
    }

    const callShardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-call-'));
    let resolvedCallShard: ResolvedCallShard | undefined;
    const parseCacheCopy = OVERLAP_PARSE_CACHE_COPY
      ? this.copyParseCacheShardsForShardedFullIndex(args, factPaths)
          .then(() => undefined, error => error as unknown)
      : undefined;
    try {
      if (!OVERLAP_PARSE_CACHE_COPY) {
        await this.copyParseCacheShardsForShardedFullIndex(args, factPaths);
      }
      const callResolveStart = Date.now();
      let callResolveError: unknown;
      try {
        resolvedCallShard = this.writeResolvedCallShard(
          args.snapshotId,
          factShardFiles(factPaths, 'rawCallEdges'),
          path.join(callShardDir, 'call_edges.copy'),
          fileByPath,
          context,
        );
      } catch (error) {
        callResolveError = error;
      }
      if (parseCacheCopy) {
        const parseCacheCopyError = await parseCacheCopy;
        if (parseCacheCopyError) throw parseCacheCopyError;
      }
      if (callResolveError) throw callResolveError;
      if (!resolvedCallShard) throw new Error('Call fact shard was not resolved.');
      args.progress?.({
        phase: 'edges',
        status: 'complete',
        message: 'call fact shard resolved',
        current: resolvedCallShard.rawRows,
        total: args.prepared.factStats.rawCallEdges,
        elapsedMs: Date.now() - args.start,
        details: {
          phaseElapsedMs: Date.now() - callResolveStart,
          callEdges: resolvedCallShard.rows,
          implementationCallEdges: resolvedCallShard.implementationRows,
          preResolved: true,
          sharded: true,
        },
      });

      const rebuildCallSearchIndexes = args.changes.changedFiles.length >= BULK_REBUILD_CALL_INDEX_MIN_FILES;
      const rebuildFullBulkIndexes = shouldUseFullBulkIndexRebuild(args.changes);
      const tx = this.db.transaction(async () => {
        args.progress?.({
          phase: 'write',
          status: 'start',
          message: 'writing sharded full snapshot rows',
          current: 0,
          total: args.manifest.files.length,
          elapsedMs: Date.now() - args.start,
          details: { sharded: true },
        });
        await this.db.prepare(`
          INSERT INTO snapshots (
            id, workspace_id, branch, head_commit, tree_hash, dirty_hash, created_at, status,
            manifest_scan_ms, files_total,
            index_provider_ids, index_provider_versions_json, index_provider_config_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 'indexing', ?, ?, ?, ?, ?)
        `).run(
          args.snapshotId,
          args.workspaceId,
          args.git.branch,
          args.git.headCommit,
          args.git.treeHash,
          args.git.dirtyHash,
          args.now,
          args.manifest.scanTimeMs,
          args.manifest.files.length,
          providerIdsText(args.providerSet),
          JSON.stringify(args.providerSet.providerVersions),
          JSON.stringify(args.providerSet.config),
        );

        if (rebuildFullBulkIndexes) {
          args.progress?.({
            phase: 'write',
            status: 'start',
            message: 'dropping full bulk-load indexes for sharded bulk load',
            elapsedMs: Date.now() - args.start,
            details: { sharded: true, indexCount: FULL_BULK_LOAD_INDEXES.length },
          });
          await this.dropFullBulkLoadIndexes();
        } else if (rebuildCallSearchIndexes) {
          args.progress?.({
            phase: 'write',
            status: 'start',
            message: 'dropping call search indexes for sharded bulk load',
            elapsedMs: Date.now() - args.start,
            details: { sharded: true },
          });
          await this.dropCallSearchIndexesForBulkLoad();
        }

        const filesWriteStart = Date.now();
        await this.insertFiles(args.snapshotId, args.manifest.files, parseStatusByPath, { upsert: false });
        args.progress?.({
          phase: 'write',
          status: 'progress',
          message: 'file manifest written',
          current: args.manifest.files.length,
          total: args.manifest.files.length,
          elapsedMs: Date.now() - args.start,
          details: { phaseElapsedMs: Date.now() - filesWriteStart, sharded: true, ...this.copyTelemetryDetails() },
        });

        await this.copyFactShardTable('symbols', factPaths, 'symbols', args.prepared.factStats.symbols);
        await this.copyFactShardTable('annotations', factPaths, 'annotations', args.prepared.factStats.annotations);
        await this.copyFactShardTable('inheritance', factPaths, 'inheritance', args.prepared.factStats.inheritance);
        await this.copyFactShardTable('beans', factPaths, 'beans', args.prepared.factStats.beans);
        await this.copyFactShardTable('endpoints', factPaths, 'endpoints', args.prepared.factStats.endpoints);
        await this.copyFactShardTable('imports', factPaths, 'imports', args.prepared.factStats.imports);
        await this.copyFactShardTable('type_refs', factPaths, 'typeRefs', args.prepared.factStats.typeRefs);
        await this.copyFactShardTable('field_usages', factPaths, 'fieldUsages', args.prepared.factStats.fieldUsages);
        await this.copyTextShards(
          'call_edges',
          copyableColumnsFor('call_edges'),
          [resolvedCallShard!.path],
          resolvedCallShard!.rows,
        );
        args.progress?.({
          phase: 'write',
          status: 'complete',
          message: 'fact shards copied',
          current: args.prepared.filesParsed,
          total: args.prepared.filesParsed,
          elapsedMs: Date.now() - args.start,
          details: {
            symbols: args.prepared.factStats.symbols,
            fieldUsages: args.prepared.factStats.fieldUsages,
            callEdges: resolvedCallShard!.rows,
            typeRefs: args.prepared.factStats.typeRefs,
            sharded: true,
            ...this.copyTelemetryDetails(),
          },
        });

        if (!rebuildFullBulkIndexes && rebuildCallSearchIndexes) {
          const indexRebuildStart = Date.now();
          args.progress?.({
            phase: 'edges',
            status: 'start',
            message: 'rebuilding call search indexes',
            elapsedMs: Date.now() - args.start,
            details: { sharded: true },
          });
          await this.rebuildCallSearchIndexesAfterBulkLoad();
          args.progress?.({
            phase: 'edges',
            status: 'complete',
            message: 'call search indexes rebuilt',
            elapsedMs: Date.now() - args.start,
            details: { phaseElapsedMs: Date.now() - indexRebuildStart, sharded: true },
          });
        }

        const dependencyRebuildStart = Date.now();
        args.progress?.({
          phase: 'edges',
          status: 'start',
          message: 'rebuilding dependency edges',
          elapsedMs: Date.now() - args.start,
          details: { sharded: true },
        });
        await this.rebuildDependencyEdges(args.snapshotId);
        args.progress?.({
          phase: 'edges',
          status: 'complete',
          message: 'dependency edges rebuilt',
          elapsedMs: Date.now() - args.start,
          details: { phaseElapsedMs: Date.now() - dependencyRebuildStart, sharded: true },
        });
        await this.rebuildGraphOverlay(args.snapshotId, args.progress, args.start, { sharded: true }, resolvedCallShard?.callFileEdges);

        if (rebuildFullBulkIndexes) {
          const indexRebuildStart = Date.now();
          args.progress?.({
            phase: 'edges',
            status: 'start',
            message: 'rebuilding full bulk-load indexes',
            elapsedMs: Date.now() - args.start,
            details: { sharded: true, indexCount: FULL_BULK_LOAD_INDEXES.length },
          });
          await this.rebuildFullBulkLoadIndexes();
          args.progress?.({
            phase: 'edges',
            status: 'complete',
            message: 'full bulk-load indexes rebuilt',
            elapsedMs: Date.now() - args.start,
            details: { phaseElapsedMs: Date.now() - indexRebuildStart, sharded: true, indexCount: FULL_BULK_LOAD_INDEXES.length },
          });
        }

        if (!args.skipSnapshotStats) {
          await this.refreshSnapshotStats(args.snapshotId);
        }
        await this.db.prepare(`
          UPDATE snapshots
          SET status = 'ready',
              index_time_ms = ?,
              files_parsed = ?,
              parse_cache_hits = ?
          WHERE id = ?
        `).run(Date.now() - args.start, args.prepared.filesParsed, args.prepared.parseCacheHits, args.snapshotId);
        await this.db.prepare(`
          UPDATE workspaces
          SET current_snapshot_id = ?, last_indexed_head = ?, last_seen_at = ?
          WHERE id = ?
        `).run(args.snapshotId, args.git.headCommit, args.now, args.workspaceId);
      });

      await tx();
    } finally {
      fs.rmSync(callShardDir, { recursive: true, force: true });
    }

    await this.maintainQueryPlanner(args.progress, args.start);

    args.progress?.({
      phase: 'complete',
      status: 'complete',
      message: 'sharded full index complete',
      current: args.manifest.files.length,
      total: args.manifest.files.length,
      elapsedMs: Date.now() - args.start,
      details: { sharded: true, ...this.copyTelemetryDetails() },
    });

    return {
      workspaceId: args.workspaceId,
      snapshotId: args.snapshotId,
      filesTotal: args.manifest.files.length,
      filesParsed: args.prepared.filesParsed,
      parseCacheHits: args.prepared.parseCacheHits,
      filesHashed: args.manifest.filesHashed,
      hashCacheHits: args.manifest.hashCacheHits,
      skippedUnchanged: false,
      incrementalUpdated: false,
      filesChanged: args.changes.changedFiles.length,
      filesDeleted: args.changes.deletedPaths.length,
      parseWorkers: args.prepared.parseWorkers,
      manifestScanMs: args.manifest.scanTimeMs,
      indexTimeMs: Date.now() - args.start,
      indexProviderIds: args.providerSet.providerIds,
      indexProviderVersions: args.providerSet.providerVersions,
    };
  }

  private async writeStreamingFullSnapshot(args: {
    start: number;
    workspaceId: string;
    workspaceRoot: string;
    git: GitInfo;
    snapshotId: string;
    now: string;
    manifest: ReturnType<typeof scanManifest>;
    changes: ManifestChangeSet;
    prepared: PreparedStreamingParseBatch;
    providerSet: IndexProviderSet;
    skipSnapshotStats?: boolean;
    progress?: (event: IndexProgressEvent) => void;
  }): Promise<IndexWorkspaceResult> {
    const fileByPath = new Map(args.manifest.files.map(file => [file.relPath, file]));
    const parseStatusByPath = new Map<string, string>();
    const context = createCallResolutionContext();
    const contextStart = Date.now();
    let contextFiles = 0;
    for (const item of this.parseContextItemsFromSpool(args.prepared.spool)) {
      parseStatusByPath.set(item.key, item.parseStatus);
      addParseContextItemToCallResolutionContext(context, item);
      contextFiles++;
    }
    args.progress?.({
      phase: 'parse',
      status: 'complete',
      message: 'streaming parse context built',
      current: contextFiles,
      total: args.prepared.filesParsed,
      elapsedMs: Date.now() - args.start,
      details: { phaseElapsedMs: Date.now() - contextStart, streaming: true },
    });

    const rebuildCallSearchIndexes = args.changes.changedFiles.length >= BULK_REBUILD_CALL_INDEX_MIN_FILES;
    const tx = this.db.transaction(async () => {
      args.progress?.({
        phase: 'write',
        status: 'start',
        message: 'writing streaming full snapshot rows',
        current: 0,
        total: args.manifest.files.length,
        elapsedMs: Date.now() - args.start,
        details: { streaming: true },
      });
      await this.db.prepare(`
        INSERT INTO snapshots (
          id, workspace_id, branch, head_commit, tree_hash, dirty_hash, created_at, status,
          manifest_scan_ms, files_total,
          index_provider_ids, index_provider_versions_json, index_provider_config_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'indexing', ?, ?, ?, ?, ?)
      `).run(
        args.snapshotId,
        args.workspaceId,
        args.git.branch,
        args.git.headCommit,
        args.git.treeHash,
        args.git.dirtyHash,
        args.now,
        args.manifest.scanTimeMs,
        args.manifest.files.length,
        providerIdsText(args.providerSet),
        JSON.stringify(args.providerSet.providerVersions),
        JSON.stringify(args.providerSet.config),
      );

      if (rebuildCallSearchIndexes) {
        args.progress?.({
          phase: 'write',
          status: 'start',
          message: 'dropping call search indexes for streaming bulk load',
          elapsedMs: Date.now() - args.start,
          details: { streaming: true },
        });
        await this.dropCallSearchIndexesForBulkLoad();
      }

      const filesWriteStart = Date.now();
      await this.insertFiles(args.snapshotId, args.manifest.files, parseStatusByPath, { upsert: false });
      args.progress?.({
        phase: 'write',
        status: 'progress',
        message: 'file manifest written',
        current: args.manifest.files.length,
        total: args.manifest.files.length,
        elapsedMs: Date.now() - args.start,
        details: { phaseElapsedMs: Date.now() - filesWriteStart, streaming: true, ...this.copyTelemetryDetails() },
      });

      let filesWritten = 0;
      let lastWriteProgressAt = 0;
      const materializeTotals = emptyMaterializeStats();
      const parseCacheInsertKeys = new Set<string>();
      let batch: ParseResultForFile[] = [];
      const flushBatch = async () => {
        if (batch.length === 0) return;
        const batchWriteStart = Date.now();
        const currentBatch = batch;
        batch = [];
        await this.insertParseCaches(currentBatch, args.now, args.providerSet, parseCacheInsertKeys);
        addMaterializeStats(materializeTotals, await this.materializeParseResults(args.snapshotId, currentBatch, context));
        filesWritten += currentBatch.length;
        const currentFile = currentBatch[currentBatch.length - 1]!.file;
        lastWriteProgressAt = reportProgressEvery(args.progress, lastWriteProgressAt, {
          phase: 'write',
          status: filesWritten === args.prepared.filesParsed ? 'complete' : 'progress',
          message: `streaming write ${currentFile.relPath}`,
          current: filesWritten,
          total: args.prepared.filesParsed,
          elapsedMs: Date.now() - args.start,
          details: {
            phaseElapsedMs: Date.now() - batchWriteStart,
            symbols: materializeTotals.symbols,
            callEdges: materializeTotals.callEdges,
            typeRefs: materializeTotals.typeRefs,
            streaming: true,
            ...this.copyTelemetryDetails(),
          },
        });
      };

      for (const item of this.parseResultItemsFromSpool(args.prepared.spool, fileByPath)) {
        batch.push(item);
        if (batch.length >= WRITE_FILE_BATCH_SIZE) await flushBatch();
      }
      await flushBatch();

      const resolveStart = Date.now();
      args.progress?.({
        phase: 'edges',
        status: 'complete',
        message: 'call edge DB resolve skipped',
        elapsedMs: Date.now() - args.start,
        details: { phaseElapsedMs: Date.now() - resolveStart, preResolved: true, streaming: true },
      });
      if (rebuildCallSearchIndexes) {
        const indexRebuildStart = Date.now();
        args.progress?.({
          phase: 'edges',
          status: 'start',
          message: 'rebuilding call search indexes',
          elapsedMs: Date.now() - args.start,
          details: { streaming: true },
        });
        await this.rebuildCallSearchIndexesAfterBulkLoad();
        args.progress?.({
          phase: 'edges',
          status: 'complete',
          message: 'call search indexes rebuilt',
          elapsedMs: Date.now() - args.start,
          details: { phaseElapsedMs: Date.now() - indexRebuildStart, streaming: true },
        });
      }
      const dependencyRebuildStart = Date.now();
      args.progress?.({
        phase: 'edges',
        status: 'start',
        message: 'rebuilding dependency edges',
        elapsedMs: Date.now() - args.start,
        details: { streaming: true },
      });
      await this.rebuildDependencyEdges(args.snapshotId);
      args.progress?.({
        phase: 'edges',
        status: 'complete',
        message: 'dependency edges rebuilt',
        elapsedMs: Date.now() - args.start,
        details: { phaseElapsedMs: Date.now() - dependencyRebuildStart, streaming: true },
      });
      await this.rebuildGraphOverlay(args.snapshotId, args.progress, args.start, { streaming: true });
      if (!args.skipSnapshotStats) {
        await this.refreshSnapshotStats(args.snapshotId);
      }
      await this.db.prepare(`
        UPDATE snapshots
        SET status = 'ready',
            index_time_ms = ?,
            files_parsed = ?,
            parse_cache_hits = ?
        WHERE id = ?
      `).run(Date.now() - args.start, args.prepared.filesParsed, args.prepared.parseCacheHits, args.snapshotId);
      await this.db.prepare(`
        UPDATE workspaces
        SET current_snapshot_id = ?, last_indexed_head = ?, last_seen_at = ?
        WHERE id = ?
      `).run(args.snapshotId, args.git.headCommit, args.now, args.workspaceId);
    });

    await tx();
    await this.maintainQueryPlanner(args.progress, args.start);

    args.progress?.({
      phase: 'complete',
      status: 'complete',
      message: 'streaming index complete',
      current: args.manifest.files.length,
      total: args.manifest.files.length,
      elapsedMs: Date.now() - args.start,
      details: { streaming: true, ...this.copyTelemetryDetails() },
    });

    return {
      workspaceId: args.workspaceId,
      snapshotId: args.snapshotId,
      filesTotal: args.manifest.files.length,
      filesParsed: args.prepared.filesParsed,
      parseCacheHits: args.prepared.parseCacheHits,
      filesHashed: args.manifest.filesHashed,
      hashCacheHits: args.manifest.hashCacheHits,
      skippedUnchanged: false,
      incrementalUpdated: false,
      filesChanged: args.changes.changedFiles.length,
      filesDeleted: args.changes.deletedPaths.length,
      parseWorkers: args.prepared.parseWorkers,
      manifestScanMs: args.manifest.scanTimeMs,
      indexTimeMs: Date.now() - args.start,
      indexProviderIds: args.providerSet.providerIds,
      indexProviderVersions: args.providerSet.providerVersions,
    };
  }

  private async updateSnapshotIncrementally(args: {
    start: number;
    workspaceId: string;
    snapshotId: string;
    workspaceRoot: string;
    git: GitInfo;
    manifestFilesTotal: number;
    manifestScanMs: number;
    filesHashed: number;
    hashCacheHits: number;
    changes: ManifestChangeSet;
    prepared: PreparedParseBatch;
    providerSet: IndexProviderSet;
    skipSnapshotStats?: boolean;
    progress?: (event: IndexProgressEvent) => void;
  }): Promise<IndexWorkspaceResult> {
    const now = new Date().toISOString();
    const changedPaths = new Set(args.changes.changedFiles.map(file => file.relPath));
    const deletedPaths = new Set(args.changes.deletedPaths);
    const affectedPaths = new Set([...changedPaths, ...deletedPaths]);
    args.progress?.({
      phase: 'edges',
      status: 'start',
      message: 'detecting affected dependency sources',
      elapsedMs: Date.now() - args.start,
    });
    const dependencySources = await this.affectedDependencySources(args.snapshotId, affectedPaths);
    for (const file of changedPaths) dependencySources.add(file);
    const parsePlanByPath = new Map(args.prepared.plans.map(plan => [plan.file.relPath, plan]));

    const tx = this.db.transaction(async () => {
      args.progress?.({
        phase: 'write',
        status: 'start',
        message: 'updating snapshot rows',
        current: 0,
        total: args.changes.changedFiles.length,
        elapsedMs: Date.now() - args.start,
      });
      await this.db.prepare(`
        UPDATE snapshots
        SET status = 'indexing',
            branch = ?,
            head_commit = ?,
            tree_hash = ?,
            dirty_hash = ?,
            manifest_scan_ms = ?,
            files_total = ?,
            index_provider_ids = ?,
            index_provider_versions_json = ?,
            index_provider_config_json = ?
        WHERE id = ?
      `).run(
        args.git.branch,
        args.git.headCommit,
        args.git.treeHash,
        args.git.dirtyHash,
        args.manifestScanMs,
        args.manifestFilesTotal,
        providerIdsText(args.providerSet),
        JSON.stringify(args.providerSet.providerVersions),
        JSON.stringify(args.providerSet.config),
        args.snapshotId,
      );

      await this.deleteIndexedRowsForFiles(args.snapshotId, affectedPaths);
      await this.deleteDependencyEdgesForSources(args.snapshotId, dependencySources);

      const parseStatusByPath = new Map(
        args.changes.changedFiles.map(file => [
          file.relPath,
          parsePlanByPath.get(file.relPath)?.parseStatus ?? 'skipped',
        ]),
      );
      await this.insertFiles(args.snapshotId, args.changes.changedFiles, parseStatusByPath);

      let filesWritten = 0;
      let lastWriteProgressAt = 0;
      const materializeTotals = emptyMaterializeStats();
      const parseCacheInsertKeys = new Set<string>();
      for (const fileBatch of chunkArray(args.changes.changedFiles, WRITE_FILE_BATCH_SIZE)) {
        const batchWriteStart = Date.now();
        const parseCacheItems: ParseResultForFile[] = [];
        const materializeItems: ParseResultForFile[] = [];
        for (const file of fileBatch) {
          const plan = parsePlanByPath.get(file.relPath);
          if (!plan?.result) continue;
          materializeItems.push({ file, result: plan.result });
          if (plan.cacheInsert) parseCacheItems.push({ file, result: plan.result });
        }
        await this.insertParseCaches(parseCacheItems, now, args.providerSet, parseCacheInsertKeys);
        addMaterializeStats(materializeTotals, await this.materializeParseResults(args.snapshotId, materializeItems));

        filesWritten += fileBatch.length;
        const currentFile = fileBatch[fileBatch.length - 1]!;
        lastWriteProgressAt = reportProgressEvery(args.progress, lastWriteProgressAt, {
          phase: 'write',
          status: filesWritten === args.changes.changedFiles.length ? 'complete' : 'progress',
          message: `writing ${currentFile.relPath}`,
          current: filesWritten,
          total: args.changes.changedFiles.length,
          elapsedMs: Date.now() - args.start,
          details: {
            phaseElapsedMs: Date.now() - batchWriteStart,
            symbols: materializeTotals.symbols,
            callEdges: materializeTotals.callEdges,
            typeRefs: materializeTotals.typeRefs,
            ...this.copyTelemetryDetails(),
          },
        });
      }

      const resolveStart = Date.now();
      args.progress?.({
        phase: 'edges',
        status: 'start',
        message: 'resolving call edges',
        elapsedMs: Date.now() - args.start,
      });
      await this.resolveCallEdges(args.snapshotId, changedPaths);
      args.progress?.({
        phase: 'edges',
        status: 'complete',
        message: 'call edges resolved',
        elapsedMs: Date.now() - args.start,
        details: { phaseElapsedMs: Date.now() - resolveStart },
      });
      const dependencyRebuildStart = Date.now();
      args.progress?.({
        phase: 'edges',
        status: 'start',
        message: 'rebuilding dependency edges',
        elapsedMs: Date.now() - args.start,
      });
      await this.rebuildDependencyEdges(args.snapshotId, dependencySources);
      args.progress?.({
        phase: 'edges',
        status: 'complete',
        message: 'dependency edges rebuilt',
        elapsedMs: Date.now() - args.start,
        details: { phaseElapsedMs: Date.now() - dependencyRebuildStart },
      });
      await this.rebuildGraphOverlay(args.snapshotId, args.progress, args.start);

      if (!args.skipSnapshotStats) {
        await this.refreshSnapshotStats(args.snapshotId);
      }
      await this.db.prepare(`
        UPDATE snapshots
        SET status = 'ready',
            index_time_ms = ?,
            files_parsed = ?,
            parse_cache_hits = ?
        WHERE id = ?
      `).run(Date.now() - args.start, args.prepared.filesParsed, args.prepared.parseCacheHits, args.snapshotId);
      await this.db.prepare(`
        UPDATE workspaces
        SET current_snapshot_id = ?, last_indexed_head = ?, last_seen_at = ?
        WHERE id = ?
      `).run(args.snapshotId, args.git.headCommit, now, args.workspaceId);
    });

    await tx();

    args.progress?.({
      phase: 'complete',
      status: 'complete',
      message: 'incremental index complete',
      current: args.changes.changedFiles.length,
      total: args.changes.changedFiles.length,
      elapsedMs: Date.now() - args.start,
    });

    return {
      workspaceId: args.workspaceId,
      snapshotId: args.snapshotId,
      filesTotal: args.manifestFilesTotal,
      filesParsed: args.prepared.filesParsed,
      parseCacheHits: args.prepared.parseCacheHits,
      filesHashed: args.filesHashed,
      hashCacheHits: args.hashCacheHits,
      skippedUnchanged: false,
      incrementalUpdated: true,
      filesChanged: args.changes.changedFiles.length,
      filesDeleted: args.changes.deletedPaths.length,
      parseWorkers: args.prepared.parseWorkers,
      manifestScanMs: args.manifestScanMs,
      indexTimeMs: Date.now() - args.start,
      indexProviderIds: args.providerSet.providerIds,
      indexProviderVersions: args.providerSet.providerVersions,
    };
  }

  private async deleteIndexedRowsForFiles(snapshotId: string, files: Set<string>): Promise<void> {
    if (files.size === 0) return;
    const values = [...files];
    const placeholders = values.map(() => '?').join(', ');
    for (const table of ['symbols', 'imports', 'type_refs', 'field_usages', 'call_edges', 'annotations', 'endpoints', 'beans', 'inheritance']) {
      await this.db.prepare(`
        DELETE FROM ${table}
        WHERE snapshot_id = ? AND file IN (${placeholders})
      `).run(snapshotId, ...values);
    }
    await this.db.prepare(`
      DELETE FROM files
      WHERE snapshot_id = ? AND path IN (${placeholders})
    `).run(snapshotId, ...values);
  }

  private async affectedDependencySources(snapshotId: string, changedOrDeletedFiles: Set<string>): Promise<Set<string>> {
    const affected = new Set<string>();
    if (changedOrDeletedFiles.size === 0) return affected;
    const values = [...changedOrDeletedFiles];
    const placeholders = values.map(() => '?').join(', ');
    const rows = await this.db.prepare(`
      SELECT DISTINCT from_file
      FROM dependency_edges
      WHERE snapshot_id = ?
        AND (from_file IN (${placeholders}) OR to_file IN (${placeholders}))
    `).all(snapshotId, ...values, ...values) as Array<{ from_file: string }>;
    for (const row of rows) affected.add(row.from_file);
    return affected;
  }

  private async deleteDependencyEdgesForSources(snapshotId: string, sourceFiles: Set<string>): Promise<void> {
    if (sourceFiles.size === 0) return;
    const values = [...sourceFiles];
    const placeholders = values.map(() => '?').join(', ');
    await this.db.prepare(`
      DELETE FROM dependency_edges
      WHERE snapshot_id = ? AND from_file IN (${placeholders})
    `).run(snapshotId, ...values);
  }

  private async insertFiles(
    snapshotId: string,
    files: ManifestFile[],
    parseStatusByPath: Map<string, string>,
    options: { upsert?: boolean } = {},
  ): Promise<void> {
    await this.insertRows(
      'files',
      ['snapshot_id', 'path', 'blob_hash', 'mtime_ms', 'size', 'language', 'file_role', 'parse_status'],
      files.map(file => [
        snapshotId,
        file.relPath,
        file.blobHash,
        file.mtimeMs,
        file.size,
        file.language,
        file.role,
        parseStatusByPath.get(file.relPath) ?? 'skipped',
      ]),
      options.upsert === false
        ? undefined
        : {
            suffix: `
          ON CONFLICT (snapshot_id, path) DO UPDATE SET
            blob_hash = excluded.blob_hash,
            mtime_ms = excluded.mtime_ms,
            size = excluded.size,
            language = excluded.language,
            file_role = excluded.file_role,
            parse_status = excluded.parse_status
        `,
          },
    );
  }

  private async copyUnchangedRows(fromSnapshotId: string, toSnapshotId: string): Promise<void> {
    for (const table of ['symbols', 'imports', 'type_refs', 'field_usages', 'call_edges', 'annotations', 'endpoints', 'beans', 'inheritance']) {
      await this.copyRowsForUnchangedFiles(table, fromSnapshotId, toSnapshotId);
    }
  }

  private async copyRowsForUnchangedFiles(table: string, fromSnapshotId: string, toSnapshotId: string): Promise<void> {
    const fileColumn = 'file';
    const cols = copyableColumnsFor(table);
    const selectCols = cols.map(col => col === 'snapshot_id' ? '? AS snapshot_id' : `src.${col}`).join(', ');
    const insertCols = cols.join(', ');
    await this.db.prepare(`
      INSERT INTO ${table} (${insertCols})
      SELECT ${selectCols}
      FROM ${table} src
      JOIN files old_file
        ON old_file.snapshot_id = ?
       AND old_file.path = src.${fileColumn}
      JOIN files new_file
        ON new_file.snapshot_id = ?
       AND new_file.path = src.${fileColumn}
       AND new_file.blob_hash = old_file.blob_hash
      WHERE src.snapshot_id = ?
    `).run(toSnapshotId, fromSnapshotId, toSnapshotId, fromSnapshotId);
  }

  private buildCallResolutionContext(plans: ParsePlan[]): CallResolutionContext {
    const context = createCallResolutionContext();

    for (const plan of plans) {
      if (!plan.result) continue;
      addParseResultToCallResolutionContext(context, plan.file, plan.result);
    }

    return context;
  }

  private *parseResultItemsFromSpool(
    spool: ParseSpool,
    fileByPath: Map<string, ManifestFile>,
  ): Iterable<ParseResultForFile> {
    for (const shardPath of spool.shardPaths) {
      for (const item of readParseWorkResultsJsonl(shardPath)) {
        const file = fileByPath.get(item.key);
        if (file) yield { file, result: item.result };
      }
    }
  }

  private *parseContextItemsFromSpool(spool: ParseSpool): Iterable<ParseContextItem> {
    for (const shardPath of spool.contextShardPaths) {
      for (const item of readParseContextItemsJsonl(shardPath)) {
        yield item;
      }
    }
  }

  private writeResolvedCallShard(
    snapshotId: string,
    rawCallShardPaths: string[],
    outputPath: string,
    fileByPath: Map<string, ManifestFile>,
    context: CallResolutionContext,
  ): ResolvedCallShard {
    const writer = createCopyTextWriter(outputPath);
    let rawRows = 0;
    let implementationRows = 0;
    const callFileAggregates = new Map<string, GraphOverlayCallFileEdge>();
    try {
      for (const shardPath of rawCallShardPaths) {
        for (const raw of readRawCallFacts(shardPath)) {
          rawRows++;
          const file = fileByPath.get(raw.file) ?? minimalManifestFile(raw.file, raw.fileRole);
          const implementationCallRows: SqlValue[][] = [];
          const normalizedCall: ClassifiedCallEdge = {
            caller: raw.caller,
            callee: raw.callee,
            confidence: raw.confidence,
            signalTier: raw.signalTier as CallSignalTier,
            signalReasons: [],
          };
          if (!shouldAttemptPreResolveRawCall(raw)) {
            writer.writeRawLine(raw.rawLine);
            recordCallFileAggregate(
              callFileAggregates,
              context,
              raw.file,
              raw.callee,
              raw.confidence,
              raw.signalTier,
            );
            continue;
          }
          const resolvedCall = preResolveCallEdge(
            snapshotId,
            file,
            rawCallInfo(raw),
            normalizedCall,
            context,
            implementationCallRows,
          );
          writer.write([
            snapshotId,
            raw.caller,
            resolvedCall?.callee ?? raw.callee,
            raw.file,
            raw.line,
            resolvedCall?.confidence ?? raw.confidence,
            resolvedCall?.resolutionKind ?? raw.resolutionKind,
            raw.fileRole,
            raw.signalTier,
            raw.signalReasonsJson,
          ]);
          recordCallFileAggregate(
            callFileAggregates,
            context,
            raw.file,
            resolvedCall?.callee ?? raw.callee,
            resolvedCall?.confidence ?? raw.confidence,
            raw.signalTier,
          );
          for (const row of implementationCallRows) {
            writer.write(row);
            recordCallFileAggregate(
              callFileAggregates,
              context,
              String(row[3] ?? ''),
              String(row[2] ?? ''),
              Number(row[5] ?? 0),
              row[8] as CallSignalTier,
            );
            implementationRows++;
          }
        }
      }
    } finally {
      writer.close();
    }
    return {
      path: outputPath,
      rows: writer.rows,
      rawRows,
      implementationRows,
      callFileEdges: [...callFileAggregates.values()],
    };
  }

  private async materializeParseResults(
    snapshotId: string,
    items: ParseResultForFile[],
    callResolutionContext?: CallResolutionContext,
  ): Promise<MaterializeStats> {
    const symbolRows: SqlValue[][] = [];
    const annotationRows: SqlValue[][] = [];
    const inheritanceRows: SqlValue[][] = [];
    const beanRows: SqlValue[][] = [];
    const endpointRows: SqlValue[][] = [];
    const importRows: SqlValue[][] = [];
    const typeRefRows: SqlValue[][] = [];
    const fieldUsageRows: SqlValue[][] = [];
    const callRows: SqlValue[][] = [];
    const implementationCallRows: SqlValue[][] = [];

    for (const { file, result } of items) {
      const classesByName = new Map<string, SymbolInfo>();
      for (const sym of result.symbols) {
        if ((sym.kind === 'class' || sym.kind === 'interface') && sym.name) {
          classesByName.set(sym.name, sym);
        }
      }

      for (const sym of result.symbols) {
        const fqName = symbolFqName(sym);
        symbolRows.push([
          snapshotId,
          fqName,
          sym.name,
          sym.kind,
          file.relPath,
          sym.line,
          sym.column,
          sym.endLine,
          sym.signature,
          sym.visibility,
          sym.parent,
          sym.packageName,
          sym.returnType,
          JSON.stringify(sym.parameterTypes ?? []),
          JSON.stringify(sym.annotations ?? []),
          sym.frameworkRole,
          JSON.stringify(sym.frameworkMeta ?? {}),
          file.role,
        ]);

        for (const annotation of sym.annotations ?? []) {
          annotationRows.push([snapshotId, fqName, annotation, file.relPath, sym.line]);
        }

        const child = fqName.replace(/\([^)]*\)$/, '');
        if (sym.extends) {
          inheritanceRows.push([snapshotId, child, sym.extends, 'extends', file.relPath, sym.line, 0.8]);
        }
        for (const parent of sym.implements ?? []) {
          inheritanceRows.push([snapshotId, child, parent, 'implements', file.relPath, sym.line, 0.8]);
        }

        const beanRow = beanRowForSymbol(snapshotId, file, sym, fqName);
        if (beanRow) beanRows.push(beanRow);
        const endpointRow = endpointRowForSymbol(snapshotId, file, sym, fqName, classesByName);
        if (endpointRow) endpointRows.push(endpointRow);
      }

      for (const imp of result.imports) {
        importRows.push([
          snapshotId,
          file.relPath,
          imp.source,
          JSON.stringify(imp.symbols),
          imp.line,
          imp.isExternal ? 1 : 0,
          file.role,
        ]);
      }

      for (const ref of result.typeReferences ?? []) {
        typeRefRows.push([snapshotId, file.relPath, ref.referencedType, ref.context, ref.line, file.role]);
      }

      for (const usage of result.fieldUsages ?? []) {
        fieldUsageRows.push([
          snapshotId,
          usage.fieldName,
          usage.fieldFqName,
          usage.ownerClass,
          file.relPath,
          usage.line,
          usage.column,
          usage.enclosingClass,
          usage.enclosingSymbol,
          usage.accessKind,
          usage.receiverText,
          usage.context,
          usage.confidence,
          usage.resolutionKind,
          file.role,
        ]);
      }

      for (const call of result.calls) {
        const normalizedCall = classifyCallEdge(call);
        if (!normalizedCall) continue;
        const resolvedCall = callResolutionContext
          ? preResolveCallEdge(snapshotId, file, call, normalizedCall, callResolutionContext, implementationCallRows)
          : undefined;
        callRows.push([
          snapshotId,
          normalizedCall.caller,
          resolvedCall?.callee ?? normalizedCall.callee,
          file.relPath,
          call.line,
          resolvedCall?.confidence ?? normalizedCall.confidence,
          resolvedCall?.resolutionKind ?? call.resolutionKind ?? 'name-only',
          file.role,
          normalizedCall.signalTier,
          JSON.stringify(normalizedCall.signalReasons),
        ]);
      }
    }

    await this.insertRows(
      'symbols',
      copyableColumnsFor('symbols'),
      dedupeRowsBy(symbolRows, row => `${row[0]}\0${row[1]}\0${row[4]}\0${row[5]}`),
      { ignoreConflicts: true, tryCopyWithoutConflict: true },
    );
    await this.insertRows('annotations', copyableColumnsFor('annotations'), annotationRows);
    await this.insertRows('inheritance', copyableColumnsFor('inheritance'), inheritanceRows);
    await this.insertRows('beans', copyableColumnsFor('beans'), beanRows);
    await this.insertRows('endpoints', copyableColumnsFor('endpoints'), endpointRows);
    await this.insertRows('imports', copyableColumnsFor('imports'), importRows);
    await this.insertRows('type_refs', copyableColumnsFor('type_refs'), typeRefRows);
    await this.insertRows('field_usages', copyableColumnsFor('field_usages'), fieldUsageRows);
    await this.insertRows('call_edges', copyableColumnsFor('call_edges'), callRows);
    await this.insertRows('call_edges', copyableColumnsFor('call_edges'), implementationCallRows);
    return {
      symbols: symbolRows.length,
      annotations: annotationRows.length,
      inheritance: inheritanceRows.length,
      beans: beanRows.length,
      endpoints: endpointRows.length,
      imports: importRows.length,
      typeRefs: typeRefRows.length,
      fieldUsages: fieldUsageRows.length,
      callEdges: callRows.length + implementationCallRows.length,
    };
  }

  private async rebuildDependencyEdges(snapshotId: string, sourceFiles?: Set<string>): Promise<void> {
    if (!sourceFiles) {
      await this.db.prepare('DELETE FROM dependency_edges WHERE snapshot_id = ?').run(snapshotId);
    } else if (sourceFiles.size === 0) {
      return;
    }

    const sourceFilter = sourceFiles ? [...sourceFiles] : undefined;
    const sourcePlaceholders = sourceFilter?.map(() => '?').join(', ');
    const imports = await this.db.prepare(`
      SELECT file, source FROM imports
      WHERE snapshot_id = ? AND is_external = 0
      ${sourceFilter ? `AND file IN (${sourcePlaceholders})` : ''}
    `).all(...(sourceFilter ? [snapshotId, ...sourceFilter] : [snapshotId])) as Array<{ file: string; source: string }>;
    const typeRefs = await this.db.prepare(`
      SELECT file, referenced_type FROM type_refs
      WHERE snapshot_id = ?
      ${sourceFilter ? `AND file IN (${sourcePlaceholders})` : ''}
    `).all(...(sourceFilter ? [snapshotId, ...sourceFilter] : [snapshotId])) as Array<{ file: string; referenced_type: string }>;

    const classToFile = new Map<string, string>();
    const symbols = await this.db.prepare(`
      SELECT simple_name, fq_name, file FROM symbols
      WHERE snapshot_id = ? AND kind IN ('class', 'interface', 'enum', 'type')
      ORDER BY file, line, fq_name
    `).all(snapshotId) as Array<{ simple_name: string; fq_name: string; file: string }>;
    for (const sym of symbols) {
      if (!classToFile.has(sym.simple_name)) classToFile.set(sym.simple_name, sym.file);
      if (!classToFile.has(sym.fq_name)) classToFile.set(sym.fq_name, sym.file);
    }

    const edgeRows: SqlValue[][] = [];
    const seen = new Set<string>();
    const addEdge = (from: string, to: string | undefined, kind: string, confidence: number, resolutionKind: string) => {
      if (!to || to === from) return;
      if (sourceFiles && !sourceFiles.has(from)) return;
      const key = `${from}\0${to}\0${kind}`;
      if (seen.has(key)) return;
      seen.add(key);
      edgeRows.push([snapshotId, from, to, kind, confidence, resolutionKind]);
    };

    for (const imp of imports) {
      const simple = imp.source.split('.').pop() ?? imp.source;
      addEdge(imp.file, classToFile.get(imp.source) ?? classToFile.get(simple), 'compile', 0.8, 'import');
    }
    for (const ref of typeRefs) {
      addEdge(ref.file, classToFile.get(ref.referenced_type), 'compile', 0.6, 'type-ref');
    }

    const javaTypesByFqName = new Map<string, string[]>();
    const javaTypes = await this.db.prepare(`
      SELECT fq_name, file
      FROM symbols
      WHERE snapshot_id = ?
        AND kind IN ('class', 'interface')
        AND file_role IN ('main_source', 'generated')
    `).all(snapshotId) as Array<{ fq_name: string; file: string }>;
    for (const row of javaTypes) {
      const files = javaTypesByFqName.get(row.fq_name) ?? [];
      files.push(row.file);
      javaTypesByFqName.set(row.fq_name, files);
    }

    const mybatisXmlMappers = await this.db.prepare(`
      SELECT fq_name, file, framework_meta_json
      FROM symbols
      WHERE snapshot_id = ?
        AND framework_role = 'mybatis:mapper-xml'
    `).all(snapshotId) as Array<{ fq_name: string; file: string; framework_meta_json?: string }>;
    for (const mapper of mybatisXmlMappers) {
      const meta = parseJsonObject(mapper.framework_meta_json);
      const namespace = typeof meta.namespace === 'string' && meta.namespace ? meta.namespace : mapper.fq_name;
      for (const javaFile of javaTypesByFqName.get(namespace) ?? []) {
        addEdge(mapper.file, javaFile, 'config', 0.95, 'mybatis-namespace');
        addEdge(javaFile, mapper.file, 'config', 0.95, 'mybatis-namespace');
      }
    }

    await this.insertRows('dependency_edges', copyableColumnsFor('dependency_edges'), edgeRows);
  }

  private async resolveCallEdges(snapshotId: string, files?: Set<string>): Promise<void> {
    if (files && files.size === 0) return;
    const fileFilter = files ? [...files] : undefined;
    const filePlaceholders = fileFilter?.map(() => '?').join(', ');
    const rows = (await this.db.prepare(`
      SELECT rowid AS row_id, caller, callee, file, line, file_role
      FROM call_edges
      WHERE snapshot_id = ?
        AND resolution_kind = 'name-only'
        AND signal_tier = 'primary'
      ${fileFilter ? `AND file IN (${filePlaceholders})` : ''}
    `).all(...(fileFilter ? [snapshotId, ...fileFilter] : [snapshotId])) as Array<{
      row_id: number;
      caller: string;
      callee: string;
      file: string;
      line: number;
      file_role: string;
    }>).filter(row => isPreResolvableCallCallee(row.callee));

    const fieldsByFile = new Map<string, Map<string, string>>();
    const fieldsByClass = new Map<string, Map<string, string>>();
    const fields = await this.db.prepare(`
      SELECT file, simple_name, return_type, parent
      FROM symbols
      WHERE snapshot_id = ? AND kind = 'field' AND return_type IS NOT NULL
      ${fileFilter ? `AND file IN (${filePlaceholders})` : ''}
    `).all(...(fileFilter ? [snapshotId, ...fileFilter] : [snapshotId])) as Array<{ file: string; simple_name: string; return_type: string; parent?: string }>;
    for (const field of fields) {
      let byName = fieldsByFile.get(field.file);
      if (!byName) {
        byName = new Map();
        fieldsByFile.set(field.file, byName);
      }
      byName.set(field.simple_name, field.return_type);
      if (field.parent) {
        let byClass = fieldsByClass.get(field.parent);
        if (!byClass) {
          byClass = new Map();
          fieldsByClass.set(field.parent, byClass);
        }
        byClass.set(field.simple_name, field.return_type);
      }
    }

    const superClassByClass = new Map<string, string>();
    const extendsRows = await this.db.prepare(`
      SELECT child_type, parent_type
      FROM inheritance
      WHERE snapshot_id = ? AND kind = 'extends'
    `).all(snapshotId) as Array<{ child_type: string; parent_type: string }>;
    for (const row of extendsRows) {
      superClassByClass.set(simpleTypeName(row.child_type), simpleTypeName(row.parent_type));
    }

    const outerClassByClass = new Map<string, string>();
    const nestedClassRows = await this.db.prepare(`
      SELECT simple_name, parent
      FROM symbols
      WHERE snapshot_id = ? AND kind = 'class' AND parent IS NOT NULL
    `).all(snapshotId) as Array<{ simple_name: string; parent: string }>;
    for (const row of nestedClassRows) {
      outerClassByClass.set(row.simple_name, row.parent);
    }

    const implementationsByInterface = new Map<string, string[]>();
    const implementations = await this.db.prepare(`
      SELECT parent_type, child_type
      FROM inheritance
      WHERE snapshot_id = ? AND kind = 'implements'
    `).all(snapshotId) as Array<{ parent_type: string; child_type: string }>;
    for (const impl of implementations) {
      const parent = simpleTypeName(impl.parent_type);
      const child = simpleTypeName(impl.child_type);
      const current = implementationsByInterface.get(parent) ?? [];
      current.push(child);
      implementationsByInterface.set(parent, current);
    }

    const methodOwners = new Set(
      (await this.db.prepare(`
        SELECT parent, simple_name
        FROM symbols
        WHERE snapshot_id = ? AND kind = 'method' AND parent IS NOT NULL
      `).all(snapshotId) as Array<{ parent: string; simple_name: string }>)
        .map(row => `${row.parent}.${row.simple_name}`),
    );

    const edgeUpdates: SqlValue[][] = [];
    const implementationEdgeRows: SqlValue[][] = [];
    const insertedImplementationEdges = new Set<string>();
    const queueImplementationEdges = (
      row: typeof rows[number],
      receiverType: string,
      method: string,
    ): void => {
      const implementations = implementationsByInterface.get(simpleTypeName(receiverType)) ?? [];
      for (const implementation of implementations) {
        if (!methodOwners.has(`${implementation}.${method}`)) continue;
        const callee = `${implementation}.${method}`;
        const key = `${row.caller}\0${callee}\0${row.file}\0${row.line}`;
        if (insertedImplementationEdges.has(key)) continue;
        insertedImplementationEdges.add(key);
        implementationEdgeRows.push([
          snapshotId,
          row.caller,
          callee,
          row.file,
          row.line,
          0.65,
          'interface-implementation',
          row.file_role,
          'primary',
          JSON.stringify(['interface implementation expansion']),
        ]);
      }
    };

    for (const row of rows) {
      const resolved = resolveMethodOwnerCall({
        file: row.file,
        caller: row.caller,
        callee: row.callee,
        fieldsByFile,
        fieldsByClass,
        superClassByClass,
        outerClassByClass,
        methodOwners,
      });
      if (resolved) {
        edgeUpdates.push([row.row_id, resolved.callee, resolved.confidence, resolved.resolutionKind]);
        if (resolved.receiverTypeForImplementations) {
          queueImplementationEdges(row, resolved.receiverTypeForImplementations, resolved.method);
        }
        continue;
      }
    }

    await this.updateCallEdges(edgeUpdates);
    await this.insertRows('call_edges', copyableColumnsFor('call_edges'), implementationEdgeRows);
  }

  private async updateCallEdges(rows: SqlValue[][]): Promise<void> {
    if (rows.length === 0) return;
    const update = this.db.prepare(`
      UPDATE call_edges
      SET callee = ?,
          confidence = ?,
          resolution_kind = ?
      WHERE id = ?
    `);
    for (const row of rows) {
      if (row.length !== 4) {
        throw new Error(`Expected 4 values for call_edges update, received ${row.length}.`);
      }
      await update.run(row[1], row[2], row[3], row[0]);
    }
  }

  private async dropCallSearchIndexesForBulkLoad(): Promise<void> {
    await this.db.prepare('DROP INDEX IF EXISTS idx_call_edges_caller_signal_trgm').run();
    await this.db.prepare('DROP INDEX IF EXISTS idx_call_edges_callee_signal_trgm').run();
  }

  private async dropFullBulkLoadIndexes(): Promise<void> {
    for (const spec of FULL_BULK_LOAD_INDEXES) {
      await this.db.prepare(`DROP INDEX IF EXISTS ${spec.name}`).run();
    }
  }

  private async rebuildCallSearchIndexesAfterBulkLoad(): Promise<void> {
    await this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_call_edges_caller_signal_trgm ON call_edges USING gin (caller gin_trgm_ops)
      WHERE signal_tier IN ('primary', 'provider')
    `).run();
    await this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_call_edges_callee_signal_trgm ON call_edges USING gin (callee gin_trgm_ops)
      WHERE signal_tier IN ('primary', 'provider')
    `).run();
  }

  private async rebuildFullBulkLoadIndexes(): Promise<void> {
    for (const spec of FULL_BULK_LOAD_INDEXES) {
      await this.db.prepare(spec.createSql).run();
    }
  }

  private copyTelemetryDetails(): Record<string, string | number | boolean | undefined> {
    return {
      copyAttempts: this.copyTelemetry.attempts,
      copySuccesses: this.copyTelemetry.successes,
      copyFallbacks: this.copyTelemetry.fallbacks,
      copyErrors: this.copyTelemetry.errors,
      copyRows: this.copyTelemetry.rows,
      copyMs: this.copyTelemetry.ms,
      copyFallbackTables: this.copyTelemetry.fallbackTables.size > 0
        ? [...this.copyTelemetry.fallbackTables].sort().join(',')
        : undefined,
      copyTables: this.copyTelemetry.byTable.size > 0
        ? [...this.copyTelemetry.byTable.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([table, stats]) => `${table}:${stats.rows}/${stats.ms}ms/${stats.fallbacks}fb/${stats.errors}err`)
            .join(',')
        : undefined,
    };
  }

  private async writeDedupedParseCacheShard(
    factPaths: FactShardPaths[],
    statsByShard: FactShardStats[],
  ): Promise<DedupedParseCacheShard> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-parse-cache-'));
    const outputPath = path.join(tempDir, 'parse_cache.copy');
    const output = fs.createWriteStream(outputPath, { encoding: 'utf8' });
    const finished = new Promise<void>((resolve, reject) => {
      output.once('finish', resolve);
      output.once('error', reject);
    });
    const seen = new Set<string>();
    const keys: string[] = [];
    let rows = 0;
    try {
      for (let index = 0; index < factPaths.length; index++) {
        const rowCount = statsByShard[index]?.parseCache ?? 0;
        if (rowCount === 0) continue;
        const filePath = factPaths[index]?.parseCache;
        if (!filePath) continue;
        const reader = createInterface({
          input: fs.createReadStream(filePath, { encoding: 'utf8' }),
          crlfDelay: Infinity,
        });
        for await (const line of reader) {
          if (line.length === 0) continue;
          const key = parseCacheCopyLineKey(line);
          if (seen.has(key)) continue;
          seen.add(key);
          keys.push(key);
          rows++;
          if (!output.write(`${line}\n`)) {
            await Promise.race([once(output, 'drain'), finished]);
          }
        }
      }
      output.end();
      await finished;
      return { path: outputPath, tempDir, rows, keys };
    } catch (error) {
      output.destroy();
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  private async countExistingParseCacheRows(keys: string[]): Promise<number> {
    let count = 0;
    for (const batch of chunkArray(keys, 1_000)) {
      const params: string[] = [];
      const placeholders = batch.map(key => {
        const parts = key.split('\0');
        if (parts.length !== 3) {
          throw new Error('Invalid parse_cache dedupe key.');
        }
        params.push(parts[0]!, parts[1]!, parts[2]!);
        return '(?, ?, ?)';
      }).join(', ');
      count += await this.db.scalar(`
        SELECT COUNT(*)
        FROM parse_cache
        WHERE (provider_id, provider_version, blob_hash) IN (${placeholders})
      `, ...params);
    }
    return count;
  }

  private async copyFactShardTable(
    table: string,
    factPaths: FactShardPaths[],
    shardKey: keyof FactShardPaths,
    rowCount: number,
    options: BatchInsertOptions = {},
  ): Promise<void> {
    await this.copyTextShards(table, copyableColumnsFor(table), factShardFiles(factPaths, shardKey), rowCount, options);
  }

  private async copyFactShardTableByShard(
    table: string,
    factPaths: FactShardPaths[],
    statsByShard: FactShardStats[],
    shardKey: keyof FactShardPaths,
    statsKey: keyof FactShardStats,
    options: BatchInsertOptions = {},
  ): Promise<void> {
    await this.copyTextShardsByShard(table, copyableColumnsFor(table), factPaths, statsByShard, shardKey, statsKey, options);
  }

  private async copyTextShardsByShard(
    table: string,
    columns: string[],
    factPaths: FactShardPaths[],
    statsByShard: FactShardStats[],
    shardKey: keyof FactShardPaths,
    statsKey: keyof FactShardStats,
    options: BatchInsertOptions = {},
  ): Promise<void> {
    for (let index = 0; index < factPaths.length; index++) {
      const rowCount = statsByShard[index]?.[statsKey] ?? 0;
      if (rowCount === 0) continue;
      await this.copyTextShards(table, columns, [factPaths[index]![shardKey]], rowCount, options);
    }
  }

  private async copyTextShardsByShardParallel(
    table: string,
    columns: string[],
    factPaths: FactShardPaths[],
    statsByShard: FactShardStats[],
    shardKey: keyof FactShardPaths,
    statsKey: keyof FactShardStats,
    parallelism: number,
    options: BatchInsertOptions = {},
  ): Promise<void> {
    const shards = factPaths
      .map((paths, index) => ({ path: paths[shardKey], rows: statsByShard[index]?.[statsKey] ?? 0 }))
      .filter(shard => shard.rows > 0);
    if (shards.length === 0) return;
    if (parallelism <= 1 || shards.length === 1) {
      for (const shard of shards) {
        await this.copyTextShards(table, columns, [shard.path], shard.rows, options);
      }
      return;
    }

    let nextIndex = 0;
    const workerCount = Math.min(parallelism, shards.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextIndex < shards.length) {
        const shard = shards[nextIndex++];
        if (!shard) continue;
        await this.copyTextShards(table, columns, [shard.path], shard.rows, options);
      }
    }));
  }

  private async copyTextShards(
    table: string,
    columns: string[],
    filePaths: string[],
    rowCount: number,
    options: BatchInsertOptions = {},
  ): Promise<void> {
    if (rowCount === 0) return;
    const startedAt = Date.now();
    this.recordCopyAttempt(table, rowCount);
    try {
      await this.db.copyFromTextFiles(table, columns, filePaths, options);
      const elapsedMs = Date.now() - startedAt;
      this.recordCopySuccess(table, elapsedMs);
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      this.recordCopyFallback(table, elapsedMs);
      this.recordCopyError(table);
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`COPY failed for ${table} from ${filePaths.length} shard file(s): ${reason}`);
    }
  }

  private async tryCopyRows(
    table: string,
    columns: string[],
    rows: SqlValue[][],
    options: BatchInsertOptions,
    strictOnFailure: boolean,
  ): Promise<boolean> {
    const startedAt = Date.now();
    this.recordCopyAttempt(table, rows.length);
    const copied = await this.db.copyFromRows(table, columns, rows, options);
    const elapsedMs = Date.now() - startedAt;
    if (copied) {
      this.recordCopySuccess(table, elapsedMs);
      return true;
    }

    this.recordCopyFallback(table, elapsedMs);
    if (strictOnFailure && envFlag(process.env.CODEGRAPH_COPY_STRICT)) {
      this.recordCopyError(table);
      throw new Error(`COPY failed for ${table} (${rows.length} rows). Disable CODEGRAPH_COPY_STRICT to allow INSERT fallback.`);
    }
    return false;
  }

  private recordCopyAttempt(table: string, rows: number): void {
    const stats = this.copyStatsForTable(table);
    stats.attempts++;
    stats.rows += rows;
    this.copyTelemetry.attempts++;
    this.copyTelemetry.rows += rows;
  }

  private recordCopySuccess(table: string, elapsedMs: number): void {
    const stats = this.copyStatsForTable(table);
    stats.successes++;
    stats.ms += elapsedMs;
    this.copyTelemetry.successes++;
    this.copyTelemetry.ms += elapsedMs;
  }

  private recordCopyFallback(table: string, elapsedMs: number): void {
    const stats = this.copyStatsForTable(table);
    stats.fallbacks++;
    stats.ms += elapsedMs;
    this.copyTelemetry.fallbacks++;
    this.copyTelemetry.ms += elapsedMs;
    this.copyTelemetry.fallbackTables.add(table);
  }

  private recordCopyError(table: string): void {
    const stats = this.copyStatsForTable(table);
    stats.errors++;
    this.copyTelemetry.errors++;
  }

  private copyStatsForTable(table: string): CopyTableTelemetry {
    let stats = this.copyTelemetry.byTable.get(table);
    if (!stats) {
      stats = { attempts: 0, successes: 0, fallbacks: 0, errors: 0, rows: 0, ms: 0 };
      this.copyTelemetry.byTable.set(table, stats);
    }
    return stats;
  }

  private async insertRows(
    table: string,
    columns: string[],
    rows: SqlValue[][],
    options: BatchInsertOptions = {},
  ): Promise<void> {
    if (rows.length === 0) return;
    if (COPY_INSERT_TABLES.has(table) && rows.length >= COPY_INSERT_MIN_ROWS) {
      if (options.tryCopyWithoutConflict && (options.ignoreConflicts || options.suffix)) {
        const copied = await this.tryCopyRows(table, columns, rows, {}, false);
        if (copied) return;
      }
      const copied = await this.tryCopyRows(table, columns, rows, options, true);
      if (copied) return;
    }
    const maxRows = Math.max(1, Math.floor(MAX_WRITE_BATCH_PARAMS / columns.length));
    const insertKeyword = options.ignoreConflicts ? 'INSERT OR IGNORE INTO' : 'INSERT INTO';
    const columnList = columns.map(sqlColumnName).join(', ');
    for (const batch of chunkArray(rows, maxRows)) {
      const params: SqlValue[] = [];
      const placeholders = batch.map(row => {
        if (row.length !== columns.length) {
          throw new Error(`Expected ${columns.length} values for ${table}, received ${row.length}.`);
        }
        params.push(...row.map(value => value === undefined ? null : value));
        return `(${columns.map(() => '?').join(', ')})`;
      }).join(', ');
      await this.db.prepare(`
        ${insertKeyword} ${table} (${columnList})
        VALUES ${placeholders}
        ${options.suffix ?? ''}
      `).run(...params);
    }
  }
}

export function scoreFileRole(role: string): number {
  return roleRank(role as never);
}

interface EndpointPathResolution {
  path: string;
  resolution: 'exact' | 'partial';
  reason?: string;
}

function beanRowForSymbol(snapshotId: string, file: ManifestFile, sym: SymbolInfo, fqName: string): SqlValue[] | undefined {
  if (sym.kind !== 'class' && sym.kind !== 'interface') return undefined;
  const annotations = sym.annotations ?? [];
  const beanAnnotation = annotations.find(a => BEAN_ANNOTATIONS.has(a));
  if (!beanAnnotation) return undefined;
  return [
    snapshotId,
    sym.name,
    fqName,
    beanAnnotation,
    JSON.stringify(annotations.filter(a => a.endsWith('Qualifier'))),
    'annotation',
    file.relPath,
    sym.line,
    0.8,
  ];
}

function endpointRowForSymbol(
  snapshotId: string,
  file: ManifestFile,
  sym: SymbolInfo,
  fqName: string,
  classesByName: Map<string, SymbolInfo>,
): SqlValue[] | undefined {
  const annotations = sym.annotations ?? [];

  if (sym.kind === 'class' || sym.kind === 'interface') {
    if (annotations.includes('ServerEndpoint')) {
      const endpointPath = resolveClassEndpointPath(sym);
      return [
        snapshotId,
        'WEBSOCKET',
        endpointPath.path,
        endpointPath.resolution,
        endpointPath.reason,
        fqName,
        sym.name,
        file.relPath,
        sym.line,
        'websocket',
        endpointPath.resolution === 'exact' ? 0.8 : 0.5,
        file.role,
      ];
    }

    if (annotations.includes('WebServlet')) {
      const endpointPath = resolveClassEndpointPath(sym);
      return [
        snapshotId,
        'SERVLET',
        endpointPath.path,
        endpointPath.resolution,
        endpointPath.reason,
        fqName,
        sym.name,
        file.relPath,
        sym.line,
        'servlet',
        endpointPath.resolution === 'exact' ? 0.75 : 0.5,
        file.role,
      ];
    }
  }

  if (sym.kind !== 'method') return undefined;

  if (
    sym.frameworkRole === 'openapi:endpoint'
    || sym.frameworkRole === 'postman:request'
    || sym.frameworkRole === 'elastic-rest:endpoint'
  ) {
    const method = String(sym.frameworkMeta?.httpMethod ?? 'GET').toUpperCase();
    const endpointPath = String(sym.frameworkMeta?.path ?? '/');
    const framework = sym.frameworkRole === 'elastic-rest:endpoint'
      ? 'elastic-rest'
      : sym.frameworkRole.startsWith('openapi') ? 'openapi' : 'postman';
    return [
      snapshotId,
      method,
      endpointPath,
      'exact',
      null,
      fqName,
      sym.parent,
      file.relPath,
      sym.line,
      framework,
      0.75,
      file.role,
    ];
  }

  const methodAnnotation = annotations.find(a => HTTP_METHOD_ANNOTATIONS.has(a));
  if (!methodAnnotation) return undefined;

  const httpMethod = sym.frameworkMeta?.httpMethod ?? HTTP_METHOD_ANNOTATIONS.get(methodAnnotation) ?? 'REQUEST';
  const endpointPath = resolveEndpointPath(sym, classesByName.get(sym.parent ?? ''));
  return [
    snapshotId,
    httpMethod,
    endpointPath.path,
    endpointPath.resolution,
    endpointPath.reason,
    fqName,
    sym.parent,
    file.relPath,
    sym.line,
    methodAnnotation.includes('Mapping') ? 'spring' : 'jakarta',
    endpointPath.resolution === 'exact' ? 0.85 : 0.55,
    file.role,
  ];
}

function resolveEndpointPath(methodSym: SymbolInfo, classSym: SymbolInfo | undefined): EndpointPathResolution {
  const classMeta = classSym?.frameworkMeta ?? {};
  const methodMeta = methodSym.frameworkMeta ?? {};
  const classPath = classMeta.path;
  const methodPath = methodMeta.path;
  const path = composeEndpointPath(classPath, methodPath);
  const reasons = [
    classMeta.pathResolution === 'partial' ? classMeta.pathResolutionReason : undefined,
    methodMeta.pathResolution === 'partial' ? methodMeta.pathResolutionReason : undefined,
  ].filter((reason): reason is string => Boolean(reason));

  if (reasons.length > 0) {
    return { path, resolution: 'partial', reason: reasons.join('; ') };
  }
  if (classPath === undefined && methodPath === undefined) {
    return {
      path,
      resolution: 'partial',
      reason: 'No class-level or method-level path literal/constant was found; using root fallback.',
    };
  }
  return { path, resolution: 'exact' };
}

function resolveClassEndpointPath(sym: SymbolInfo): EndpointPathResolution {
  const meta = sym.frameworkMeta ?? {};
  const path = composeEndpointPath(meta.path, undefined);
  if (meta.pathResolution === 'partial') {
    return {
      path,
      resolution: 'partial',
      reason: meta.pathResolutionReason,
    };
  }
  if (meta.path === undefined) {
    return {
      path,
      resolution: 'partial',
      reason: 'No class-level path literal/constant was found; using root fallback.',
    };
  }
  return { path, resolution: 'exact' };
}

function composeEndpointPath(classPath: string | undefined, methodPath: string | undefined): string {
  const parts = [classPath, methodPath]
    .filter((part): part is string => part !== undefined)
    .map(part => part.trim())
    .filter(part => part.length > 0 && part !== '/');
  if (parts.length === 0) return '/';
  const joined = parts
    .map((part, index) => index === 0 ? part.replace(/\/+$/g, '') : part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

function simpleTypeName(typeName: string): string {
  const withoutParams = typeName.replace(/\([^)]*\)$/, '');
  const parts = withoutParams.split('.').filter(Boolean);
  return parts[parts.length - 1] ?? withoutParams;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function copyableColumnsFor(table: string): string[] {
  switch (table) {
    case 'symbols':
      return [
        'snapshot_id', 'fq_name', 'simple_name', 'kind', 'file', 'line', 'column', 'end_line',
        'signature', 'visibility', 'parent', 'package_name', 'return_type', 'parameter_types_json',
        'annotations_json', 'framework_role', 'framework_meta_json', 'file_role',
      ];
    case 'imports':
      return ['snapshot_id', 'file', 'source', 'imported_symbols_json', 'line', 'is_external', 'file_role'];
    case 'type_refs':
      return ['snapshot_id', 'file', 'referenced_type', 'context', 'line', 'file_role'];
    case 'field_usages':
      return [
        'snapshot_id', 'field_name', 'field_fq_name', 'owner_class', 'file', 'line', 'column',
        'enclosing_class', 'enclosing_symbol', 'access_kind', 'receiver_text', 'context',
        'confidence', 'resolution_kind', 'file_role',
      ];
    case 'call_edges':
      return [
        'snapshot_id', 'caller', 'callee', 'file', 'line', 'confidence', 'resolution_kind', 'file_role',
        'signal_tier', 'signal_reasons_json',
      ];
    case 'dependency_edges':
      return ['snapshot_id', 'from_file', 'to_file', 'kind', 'confidence', 'resolution_kind'];
    case 'annotations':
      return ['snapshot_id', 'symbol_fq_name', 'annotation', 'file', 'line'];
    case 'endpoints':
      return [
        'snapshot_id', 'method', 'path', 'path_resolution', 'path_resolution_reason',
        'handler_symbol', 'controller', 'file', 'line', 'framework', 'confidence', 'file_role',
      ];
    case 'beans':
      return ['snapshot_id', 'bean_type', 'implementation', 'scope', 'qualifiers_json', 'source', 'file', 'line', 'confidence'];
    case 'inheritance':
      return ['snapshot_id', 'child_type', 'parent_type', 'kind', 'file', 'line', 'confidence'];
    default:
      throw new Error(`Unsupported copy table: ${table}`);
  }
}

function sqlColumnName(column: string): string {
  return column;
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function dedupeRowsBy<T extends unknown[]>(rows: T[], keyForRow: (row: T) => string): T[] {
  if (rows.length <= 1) return rows;
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const row of rows) {
    const key = keyForRow(row);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function normalizeRefreshPath(root: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const absolute = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(root, trimmed);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return relative.replace(/\\/g, '/');
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function envFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function parseCacheCopyOptions(options: BatchInsertOptions = {}): BatchInsertOptions {
  if (envFlag(process.env.CODEGRAPH_DISABLE_PARSE_CACHE_ASYNC_COMMIT)) return options;
  return { ...options, synchronousCommit: 'off' };
}

function shouldUseParseCacheDirectCopy(): boolean {
  return envFlag(process.env.CODEGRAPH_ENABLE_PARSE_CACHE_DIRECT_COPY);
}

function shouldUseParseCacheDedupCopy(): boolean {
  return envFlag(process.env.CODEGRAPH_ENABLE_PARSE_CACHE_DEDUP_COPY);
}

function shouldBuildGraphOverlay(): boolean {
  return envFlag(process.env.CODEGRAPH_ENABLE_GRAPH_OVERLAY);
}

function parseCacheCopyLineKey(line: string): string {
  const first = line.indexOf('\t');
  const second = first >= 0 ? line.indexOf('\t', first + 1) : -1;
  const third = second >= 0 ? line.indexOf('\t', second + 1) : -1;
  if (first < 0 || second < 0 || third < 0) {
    throw new Error('Malformed parse_cache COPY shard row.');
  }
  return `${line.slice(0, first)}\0${line.slice(first + 1, second)}\0${line.slice(second + 1, third)}`;
}

function normalizeWorkspaceKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase().replace(/\\/g, '/') : undefined;
}

function snapshotProviderMatches(snapshot: SnapshotSummaryRow | undefined, providerSet: IndexProviderSet): boolean {
  if (!snapshot) return false;
  return (snapshot.index_provider_ids ?? '') === providerIdsText(providerSet)
    && (snapshot.index_provider_versions_json ?? '') === JSON.stringify(providerSet.providerVersions)
    && (snapshot.index_provider_config_json ?? '') === JSON.stringify(providerSet.config);
}

function providerIdsText(providerSet: IndexProviderSet): string {
  return providerSet.providerIds.join(',');
}

function workspaceKeyRegisterGitInfo(root: string): GitInfo {
  return {
    root,
    dirtyHash: 'workspace-key-register',
    available: false,
  };
}

function manifestMatchesPreviousFiles(files: ManifestFile[], previousFiles: ManifestPreviousFile[]): boolean {
  if (files.length !== previousFiles.length) return false;
  const previousByPath = new Map(previousFiles.map(file => [file.path, file]));
  return files.every(file => previousByPath.get(file.relPath)?.blobHash === file.blobHash);
}

function diffManifestFiles(files: ManifestFile[], previousFiles: ManifestPreviousFile[]): ManifestChangeSet {
  const previousByPath = new Map(previousFiles.map(file => [file.path, file]));
  const currentPaths = new Set(files.map(file => file.relPath));
  const changedFiles: ManifestFile[] = [];
  const unchangedFiles: ManifestFile[] = [];
  for (const file of files) {
    const previous = previousByPath.get(file.relPath);
    if (previous && previous.blobHash === file.blobHash) {
      unchangedFiles.push(file);
    } else {
      changedFiles.push(file);
    }
  }
  return {
    changedFiles,
    unchangedFiles,
    deletedPaths: previousFiles
      .map(file => file.path)
      .filter(file => !currentPaths.has(file)),
  };
}

function shouldUseIncrementalUpdate(changes: ManifestChangeSet, filesTotal: number, options: IndexWorkspaceOptions): boolean {
  if (options.force || options.incremental === false) return false;
  const changedCount = changes.changedFiles.length + changes.deletedPaths.length;
  if (changedCount === 0) return false;
  const fileLimit = options.incrementalFileLimit ?? 500;
  const ratioLimit = Math.ceil(filesTotal * (options.incrementalFileRatio ?? 0.2));
  return changedCount <= Math.max(1, Math.min(fileLimit, ratioLimit));
}

function reportProgressEvery(
  progress: ((event: IndexProgressEvent) => void) | undefined,
  lastProgressAt: number,
  event: IndexProgressEvent,
): number {
  if (!progress) return lastProgressAt;
  const now = Date.now();
  const shouldReport = event.status === 'complete'
    || (event.current !== undefined && event.current % 500 === 0)
    || now - lastProgressAt >= 5_000;
  if (!shouldReport) return lastProgressAt;
  progress(event);
  return now;
}

function parseFilesBatchWorkerCount(itemCount: number, requested: number | undefined): number {
  if (itemCount <= 1) return 0;
  if (requested !== undefined && Number.isFinite(requested)) {
    return Math.max(1, Math.min(Math.floor(requested), 16, itemCount));
  }
  return Math.min(defaultParseWorkerLimit(), itemCount);
}

function emptyMaterializeStats(): MaterializeStats {
  return {
    symbols: 0,
    annotations: 0,
    inheritance: 0,
    beans: 0,
    endpoints: 0,
    imports: 0,
    typeRefs: 0,
    fieldUsages: 0,
    callEdges: 0,
  };
}

function addMaterializeStats(total: MaterializeStats, batch: MaterializeStats): void {
  total.symbols += batch.symbols;
  total.annotations += batch.annotations;
  total.inheritance += batch.inheritance;
  total.beans += batch.beans;
  total.endpoints += batch.endpoints;
  total.imports += batch.imports;
  total.typeRefs += batch.typeRefs;
  total.fieldUsages += batch.fieldUsages;
  total.callEdges += batch.callEdges;
}

function factShardFiles(paths: FactShardPaths[], key: keyof FactShardPaths): string[] {
  return paths.map(shard => shard[key]);
}

function rawCallInfo(raw: RawCallFact): { caller: string; callee: string; line: number; resolutionKind?: string } {
  return {
    caller: raw.caller,
    callee: raw.callee,
    line: raw.line,
    resolutionKind: raw.resolutionKind,
  };
}

function recordCallFileAggregate(
  aggregates: Map<string, GraphOverlayCallFileEdge>,
  context: CallResolutionContext,
  fromFile: string,
  callee: string,
  confidence: number,
  signalTier: CallSignalTier,
): void {
  if (!fromFile || !callee || !['primary', 'provider'].includes(signalTier)) return;
  const targetFile = context.methodFiles.get(callee)
    ?? context.methodFiles.get(stripCallParams(callee));
  if (!targetFile || targetFile === fromFile) return;
  const key = `${fromFile}\0${targetFile}`;
  const existing = aggregates.get(key);
  if (existing) {
    existing.edge_count++;
    existing.confidence = Math.max(existing.confidence, confidence);
    return;
  }
  aggregates.set(key, {
    from_file: fromFile,
    to_file: targetFile,
    edge_count: 1,
    confidence,
  });
}

function stripCallParams(value: string): string {
  return value.replace(/\([^)]*\)\s*$/, '');
}

function minimalManifestFile(relPath: string, role: string): ManifestFile {
  return {
    relPath,
    absPath: relPath,
    blobHash: '',
    mtimeMs: 0,
    size: 0,
    language: undefined,
    parseable: true,
    role: role as ManifestFile['role'],
  };
}

function createCallResolutionContext(): CallResolutionContext {
  return {
    fieldsByFile: new Map(),
    fieldsByClass: new Map(),
    superClassByClass: new Map(),
    outerClassByClass: new Map(),
    implementationsByInterface: new Map(),
    methodOwners: new Set(),
    methodFiles: new Map(),
    insertedImplementationEdges: new Set(),
  };
}

function addParseResultToCallResolutionContext(
  context: CallResolutionContext,
  file: ManifestFile,
  result: ParseResult,
): void {
  for (const sym of result.symbols) {
    if (sym.kind === 'field' && sym.returnType) {
      let fields = context.fieldsByFile.get(file.relPath);
      if (!fields) {
        fields = new Map();
        context.fieldsByFile.set(file.relPath, fields);
      }
      fields.set(sym.name, sym.returnType);
      if (sym.parent) {
        let classFields = context.fieldsByClass.get(sym.parent);
        if (!classFields) {
          classFields = new Map();
          context.fieldsByClass.set(sym.parent, classFields);
        }
        classFields.set(sym.name, sym.returnType);
      }
    }

    if (sym.kind === 'method' && sym.parent) {
      const method = `${sym.parent}.${sym.name}`;
      context.methodOwners.add(method);
      if (!context.methodFiles.has(method)) context.methodFiles.set(method, file.relPath);
    }

    if (sym.kind === 'class' && sym.extends) {
      context.superClassByClass.set(sym.name, simpleTypeName(sym.extends));
    }
    if (sym.kind === 'class' && sym.parent) {
      context.outerClassByClass.set(sym.name, sym.parent);
    }

    if ((sym.kind === 'class' || sym.kind === 'interface') && sym.implements?.length) {
      const child = simpleTypeName(symbolFqName(sym).replace(/\([^)]*\)$/, ''));
      for (const parent of sym.implements) {
        const parentKey = simpleTypeName(parent);
        const implementations = context.implementationsByInterface.get(parentKey) ?? [];
        implementations.push(child);
        context.implementationsByInterface.set(parentKey, implementations);
      }
    }
  }
}

function addParseContextItemToCallResolutionContext(
  context: CallResolutionContext,
  item: ParseContextItem,
): void {
  if (item.fields.length > 0) {
    const fields = context.fieldsByFile.get(item.key) ?? new Map<string, string>();
    for (const [name, returnType] of item.fields) {
      fields.set(name, returnType);
    }
    context.fieldsByFile.set(item.key, fields);
  }
  for (const [ownerClass, fieldName, returnType] of item.fieldsByClass ?? []) {
    const fields = context.fieldsByClass.get(ownerClass) ?? new Map<string, string>();
    fields.set(fieldName, returnType);
    context.fieldsByClass.set(ownerClass, fields);
  }
  for (const method of item.methods) {
    context.methodOwners.add(method);
  }
  for (const [method, file] of item.methodFiles ?? []) {
    if (!context.methodFiles.has(method)) context.methodFiles.set(method, file);
  }
  for (const [parent, child] of item.implementations) {
    const implementations = context.implementationsByInterface.get(parent) ?? [];
    implementations.push(child);
    context.implementationsByInterface.set(parent, implementations);
  }
  for (const [child, parent] of item.classExtends ?? []) {
    context.superClassByClass.set(child, parent);
  }
  for (const [child, parent] of item.classParents ?? []) {
    context.outerClassByClass.set(child, parent);
  }
}

function emptyCopyTelemetry(): CopyTelemetry {
  return {
    attempts: 0,
    successes: 0,
    fallbacks: 0,
    errors: 0,
    rows: 0,
    ms: 0,
    fallbackTables: new Set(),
    byTable: new Map(),
  };
}

function shouldUseShardedFullIndex(changes: ManifestChangeSet, providerSet: IndexProviderSet): boolean {
  return changes.unchangedFiles.length === 0
    && changes.changedFiles.length >= SHARDED_FULL_INDEX_MIN_FILES
    && providerSet.providerIds.length === 1
    && providerSet.providerIds[0] === 'tree-sitter'
    && !envFlag(process.env.CODEGRAPH_DISABLE_SHARDED_FULL_INDEX);
}

function shouldUseStreamingFullIndex(changes: ManifestChangeSet, providerSet: IndexProviderSet): boolean {
  return envFlag(process.env.CODEGRAPH_ENABLE_STREAMING_FULL_INDEX)
    && changes.unchangedFiles.length === 0
    && changes.changedFiles.length >= STREAMING_FULL_INDEX_MIN_FILES
    && providerSet.providerIds.length === 1
    && providerSet.providerIds[0] === 'tree-sitter'
    && !envFlag(process.env.CODEGRAPH_DISABLE_STREAMING_FULL_INDEX);
}

function shouldUseFullBulkIndexRebuild(changes: ManifestChangeSet): boolean {
  return changes.unchangedFiles.length === 0
    && changes.changedFiles.length >= BULK_REBUILD_CALL_INDEX_MIN_FILES
    && !envFlag(process.env.CODEGRAPH_DISABLE_FULL_BULK_INDEX_REBUILD);
}

function optionalStringsEqual(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? undefined) === (right ?? undefined);
}

function classifyCallEdge(call: {
  caller: string;
  callee: string;
  confidence?: number;
  resolutionKind?: string;
}): ClassifiedCallEdge | undefined {
  const semanticProviderCall = call.resolutionKind === 'scip-reference';
  const caller = normalizedCallEndpoint(call.caller, semanticProviderCall);
  const callee = normalizedCallEndpoint(call.callee, semanticProviderCall);
  if (!caller || !callee) return undefined;
  const baseConfidence = call.confidence ?? 0.4;
  if (semanticProviderCall) {
    return {
      caller,
      callee,
      confidence: Math.max(baseConfidence, 0.9),
      signalTier: 'provider',
      signalReasons: ['semantic provider fact'],
    };
  }

  const signalReasons: string[] = [];
  if (!CALL_ENDPOINT_PATTERN.test(caller)) signalReasons.push('caller is an expression');
  if (!CALL_ENDPOINT_PATTERN.test(callee)) signalReasons.push('callee is an expression');
  if (!callee.includes('.') && LOW_SIGNAL_UNQUALIFIED_CALLS.has(callee)) {
    signalReasons.push('low-signal unqualified helper call');
  }

  const signalTier: CallSignalTier = signalReasons.length > 0 ? 'low_signal' : 'primary';
  return {
    caller,
    callee,
    confidence: signalTier === 'low_signal' ? Math.min(baseConfidence, 0.25) : baseConfidence,
    signalTier,
    signalReasons,
  };
}

function preResolveCallEdge(
  snapshotId: string,
  file: ManifestFile,
  call: { caller: string; callee: string; line: number; resolutionKind?: string },
  normalizedCall: ClassifiedCallEdge,
  context: CallResolutionContext,
  implementationCallRows: SqlValue[][],
): { callee: string; confidence: number; resolutionKind: string } | undefined {
  const resolutionKind = call.resolutionKind ?? 'name-only';
  if (!isPreResolvableCallResolutionKind(resolutionKind)) return undefined;
  if (normalizedCall.signalTier !== 'primary') return undefined;
  if (!isPreResolvableCallCallee(normalizedCall.callee)) return undefined;

  const resolved = resolveMethodOwnerCall({
    file: file.relPath,
    caller: call.caller,
    callee: normalizedCall.callee,
    resolutionKind,
    fieldsByFile: context.fieldsByFile,
    fieldsByClass: context.fieldsByClass,
    superClassByClass: context.superClassByClass,
    outerClassByClass: context.outerClassByClass,
    methodOwners: context.methodOwners,
  });
  if (!resolved) return undefined;
  if (resolved.receiverTypeForImplementations) {
    queueImplementationCallEdges(snapshotId, file, normalizedCall, call.line, resolved.receiverTypeForImplementations, resolved.method, context, implementationCallRows);
  }
  return {
    callee: resolved.callee,
    confidence: resolved.confidence,
    resolutionKind: resolved.resolutionKind,
  };
}

function resolveFieldReceiverType(args: {
  file: string;
  caller: string;
  receiver: string;
  fieldsByFile: Map<string, Map<string, string>>;
  fieldsByClass: Map<string, Map<string, string>>;
  superClassByClass: Map<string, string>;
  outerClassByClass: Map<string, string>;
}): string | undefined {
  const direct = args.fieldsByFile.get(args.file)?.get(args.receiver);
  if (direct) return direct;

  let currentClass = enclosingClassFromCaller(args.caller);
  const seenOuter = new Set<string>();
  while (currentClass && !seenOuter.has(currentClass)) {
    seenOuter.add(currentClass);
    let searchClass: string | undefined = currentClass;
    const seenSuper = new Set<string>();
    while (searchClass && !seenSuper.has(searchClass)) {
      seenSuper.add(searchClass);
      const fromClass = args.fieldsByClass.get(searchClass)?.get(args.receiver);
      if (fromClass) return fromClass;
      searchClass = args.superClassByClass.get(searchClass);
    }
    currentClass = args.outerClassByClass.get(currentClass);
  }
  return undefined;
}

function resolveMethodOwnerCall(args: {
  file: string;
  caller: string;
  callee: string;
  resolutionKind?: string;
  fieldsByFile: Map<string, Map<string, string>>;
  fieldsByClass: Map<string, Map<string, string>>;
  superClassByClass: Map<string, string>;
  outerClassByClass: Map<string, string>;
  methodOwners: Set<string>;
}): { callee: string; confidence: number; resolutionKind: string; method: string; receiverTypeForImplementations?: string } | undefined {
  if (SIMPLE_METHOD_PATTERN.test(args.callee)) {
    const owner = resolveEnclosingMethodOwner({
      caller: args.caller,
      method: args.callee,
      mode: 'implicit',
      methodOwners: args.methodOwners,
      superClassByClass: args.superClassByClass,
      outerClassByClass: args.outerClassByClass,
    });
    if (!owner) return undefined;
    return {
      callee: `${owner}.${args.callee}`,
      confidence: 0.82,
      resolutionKind: 'enclosing-method',
      method: args.callee,
    };
  }

  if (!RECEIVER_METHOD_PATTERN.test(args.callee)) return undefined;
  const dot = args.callee.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const receiver = args.callee.substring(0, dot);
  const method = args.callee.substring(dot + 1);
  if (receiver === 'this' || receiver === 'super') {
    const owner = resolveEnclosingMethodOwner({
      caller: args.caller,
      method,
      mode: receiver === 'super' ? 'super' : 'this',
      methodOwners: args.methodOwners,
      superClassByClass: args.superClassByClass,
      outerClassByClass: args.outerClassByClass,
    });
    if (!owner) return undefined;
    return {
      callee: `${owner}.${method}`,
      confidence: 0.82,
      resolutionKind: receiver === 'super' ? 'super-method' : 'enclosing-method',
      method,
    };
  }

  const fieldType = resolveFieldReceiverType({
    file: args.file,
    caller: args.caller,
    receiver,
    fieldsByFile: args.fieldsByFile,
    fieldsByClass: args.fieldsByClass,
    superClassByClass: args.superClassByClass,
    outerClassByClass: args.outerClassByClass,
  });
  if (fieldType) {
    return {
      callee: `${fieldType}.${method}`,
      confidence: 0.8,
      resolutionKind: 'receiver-field',
      method,
      receiverTypeForImplementations: fieldType,
    };
  }

  if (/^[A-Z]/.test(receiver)) {
    return {
      callee: args.callee,
      confidence: 0.8,
      resolutionKind: args.resolutionKind === 'method-reference'
        ? 'method-reference'
        : args.resolutionKind === 'receiver-type'
          ? 'receiver-type'
          : 'static-or-type-receiver',
      method,
      receiverTypeForImplementations: receiver,
    };
  }
  return undefined;
}

function resolveEnclosingMethodOwner(args: {
  caller: string;
  method: string;
  mode: 'implicit' | 'this' | 'super';
  methodOwners: Set<string>;
  superClassByClass: Map<string, string>;
  outerClassByClass: Map<string, string>;
}): string | undefined {
  const currentClass = enclosingClassFromCaller(args.caller);
  if (!currentClass) return undefined;
  if (args.mode === 'this') {
    return resolveMethodInClassChain(currentClass, args.method, args.methodOwners, args.superClassByClass);
  }
  if (args.mode === 'super') {
    return resolveMethodInClassChain(args.superClassByClass.get(currentClass), args.method, args.methodOwners, args.superClassByClass);
  }

  let searchOuter: string | undefined = currentClass;
  const seenOuter = new Set<string>();
  while (searchOuter && !seenOuter.has(searchOuter)) {
    seenOuter.add(searchOuter);
    const owner = resolveMethodInClassChain(searchOuter, args.method, args.methodOwners, args.superClassByClass);
    if (owner) return owner;
    searchOuter = args.outerClassByClass.get(searchOuter);
  }
  return undefined;
}

function resolveMethodInClassChain(
  startClass: string | undefined,
  method: string,
  methodOwners: Set<string>,
  superClassByClass: Map<string, string>,
): string | undefined {
  let current = startClass;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (methodOwners.has(`${current}.${method}`)) return current;
    current = superClassByClass.get(current);
  }
  return undefined;
}

function enclosingClassFromCaller(caller: string): string | undefined {
  let normalized = caller;
  while (/\.\blambda\d+_\d+$/.test(normalized)) {
    normalized = normalized.replace(/\.\blambda\d+_\d+$/, '');
  }
  const dot = normalized.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return normalized.substring(0, dot);
}

function shouldAttemptPreResolveRawCall(raw: RawCallFact): boolean {
  return isPreResolvableCallResolutionKind(raw.resolutionKind)
    && raw.signalTier === 'primary'
    && isPreResolvableCallCallee(raw.callee);
}

function isPreResolvableCallResolutionKind(resolutionKind: string | undefined): boolean {
  return !resolutionKind
    || resolutionKind === 'name-only'
    || resolutionKind === 'method-reference'
    || resolutionKind === 'receiver-type';
}

const SIMPLE_METHOD_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RECEIVER_METHOD_PATTERN = /^(this|super|[A-Za-z_$][A-Za-z0-9_$]*)[.][A-Za-z_$][A-Za-z0-9_$]*$/;

function isPreResolvableCallCallee(callee: string): boolean {
  return SIMPLE_METHOD_PATTERN.test(callee) || RECEIVER_METHOD_PATTERN.test(callee);
}

function queueImplementationCallEdges(
  snapshotId: string,
  file: ManifestFile,
  normalizedCall: ClassifiedCallEdge,
  line: number,
  receiverType: string,
  method: string,
  context: CallResolutionContext,
  implementationCallRows: SqlValue[][],
): void {
  const implementations = context.implementationsByInterface.get(simpleTypeName(receiverType)) ?? [];
  for (const implementation of implementations) {
    if (!context.methodOwners.has(`${implementation}.${method}`)) continue;
    const callee = `${implementation}.${method}`;
    const key = `${normalizedCall.caller}\0${callee}\0${file.relPath}\0${line}`;
    if (context.insertedImplementationEdges.has(key)) continue;
    context.insertedImplementationEdges.add(key);
    implementationCallRows.push([
      snapshotId,
      normalizedCall.caller,
      callee,
      file.relPath,
      line,
      0.65,
      'interface-implementation',
      file.role,
      'primary',
      JSON.stringify(['interface implementation expansion']),
    ]);
  }
}

function normalizedCallEndpoint(value: string, allowProviderSymbol: boolean): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_CALL_ENDPOINT_LENGTH) return undefined;
  if (/[\r\n]/.test(trimmed)) return undefined;
  if (allowProviderSymbol) return trimmed;
  return trimmed;
}

function defaultParseWorkerLimit(): number {
  const configured = Number(process.env.CODEGRAPH_PARSE_WORKERS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.min(Math.floor(configured), 16));
  }
  const cpuCount = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.max(1, Math.min(8, cpuCount - 1));
}

function workspaceIdentityParts(realRoot: string, git: GitInfo, workspaceKey: string | undefined): Array<string | undefined> {
  if (workspaceKey) return ['workspace-key', workspaceKey];
  return [
    'workspace-path',
    realRoot.toLowerCase().replace(/\\/g, '/'),
    git.remoteUrl,
    git.gitCommonDir,
  ];
}
