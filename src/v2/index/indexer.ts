import path from 'node:path';
import type { CodeGraphDb } from '../storage/database.js';
import type { ParseResult, SymbolInfo } from '../../analyzers/base-analyzer.js';
import { getGitInfo, type GitInfo } from '../git.js';
import { sha256Json, stableId } from '../hash.js';
import { scanManifest, type ManifestFile, type ManifestPreviousFile } from './manifest.js';
import { parseFilesBatch, symbolFqName, type ParseWorkItem } from './parse.js';
import { roleRank } from './file-role.js';

export interface IndexWorkspaceOptions {
  root: string;
  workspaceKey?: string;
  maxFileSizeBytes?: number;
  force?: boolean;
  parseWorkers?: number;
  incremental?: boolean;
  incrementalFileLimit?: number;
  incrementalFileRatio?: number;
  progress?: (event: IndexProgressEvent) => void;
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
}

export interface IndexProgressEvent {
  phase: 'start' | 'workspace' | 'manifest' | 'diff' | 'parse-cache' | 'parse' | 'write' | 'edges' | 'complete';
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
  blob_hash: string;
  parse_json: string;
}

interface SnapshotSummaryRow {
  head_commit?: string | null;
  dirty_hash: string;
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
}

type SqlValue = string | number | null | undefined;

interface BatchInsertOptions {
  ignoreConflicts?: boolean;
  suffix?: string;
}

interface ParseResultForFile {
  file: ManifestFile;
  result: ParseResult;
}

const MAX_BATCH_PARAMS = 10_000;
const WRITE_FILE_BATCH_SIZE = 250;

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

export class V2Indexer {
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
    const start = Date.now();
    const realRoot = path.resolve(options.root);
    options.progress?.({
      phase: 'start',
      status: 'start',
      message: `indexing ${realRoot}`,
      elapsedMs: 0,
      details: { root: realRoot, workspaceKey: options.workspaceKey ?? process.env.CODEGRAPH_WORKSPACE_KEY },
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
        elapsedMs: event.elapsedMs,
        details: {
          filesHashed: event.filesHashed,
          hashCacheHits: event.hashCacheHits,
        },
      }),
    });
    const latestSnapshot = latestSnapshotId ? await this.snapshotSummary(latestSnapshotId) : undefined;
    if (!options.force
      && latestSnapshotId
      && latestSnapshot
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
      };
    }

    const changes = diffManifestFiles(manifest.files, previousFiles ?? []);
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
    if (latestSnapshotId && shouldUseIncrementalUpdate(changes, manifest.files.length, options)) {
      const prepared = await this.prepareParseBatch(workspace.root, changes.changedFiles, options.parseWorkers, options.progress);
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
        progress: options.progress,
      });
    }

    const snapshotId = stableId([
      workspace.workspaceId,
      git.headCommit,
      git.treeHash,
      git.dirtyHash,
      sha256Json(manifest.files.map(f => [f.relPath, f.blobHash])),
      String(Date.now()),
    ]);
    const now = new Date().toISOString();

    let filesParsed = 0;
    let parseCacheHits = 0;
    const previousByPath = new Map((previousFiles ?? []).map(file => [file.path, file]));
    const prepared = await this.prepareParseBatch(workspace.root, changes.changedFiles, options.parseWorkers, options.progress);
    const parsePlanByPath = new Map(prepared.plans.map(plan => [plan.file.relPath, plan]));
    filesParsed = prepared.filesParsed;
    parseCacheHits = changes.unchangedFiles.length + prepared.parseCacheHits;

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
          manifest_scan_ms, files_total
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'indexing', ?, ?)
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
      );

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
      await this.insertFiles(snapshotId, manifest.files, parseStatusByPath);

      let filesWritten = 0;
      let lastWriteProgressAt = 0;
      for (const fileBatch of chunkArray(manifest.files, WRITE_FILE_BATCH_SIZE)) {
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
        await this.insertParseCaches(parseCacheItems, now);
        await this.materializeParseResults(snapshotId, materializeItems);

        filesWritten += fileBatch.length;
        const currentFile = fileBatch[fileBatch.length - 1]!;
        lastWriteProgressAt = reportProgressEvery(options.progress, lastWriteProgressAt, {
          phase: 'write',
          status: filesWritten === manifest.files.length ? 'complete' : 'progress',
          message: `writing ${currentFile.relPath}`,
          current: filesWritten,
          total: manifest.files.length,
          elapsedMs: Date.now() - start,
        });
      }

      if (latestSnapshotId) {
        options.progress?.({
          phase: 'edges',
          status: 'start',
          message: 'copying unchanged graph rows',
          elapsedMs: Date.now() - start,
        });
        await this.copyUnchangedRows(latestSnapshotId, snapshotId);
      }
      options.progress?.({
        phase: 'edges',
        status: 'start',
        message: 'resolving call edges',
        elapsedMs: Date.now() - start,
      });
      await this.resolveCallEdges(snapshotId);
      options.progress?.({
        phase: 'edges',
        status: 'start',
        message: 'rebuilding dependency edges',
        elapsedMs: Date.now() - start,
      });
      await this.rebuildDependencyEdges(snapshotId);
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

    options.progress?.({
      phase: 'complete',
      status: 'complete',
      message: 'index complete',
      current: manifest.files.length,
      total: manifest.files.length,
      elapsedMs: Date.now() - start,
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
    };
  }

  private async getWorkspace(workspaceId: string): Promise<WorkspaceRow | undefined> {
    return await this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as WorkspaceRow | undefined;
  }

  private async snapshotSummary(snapshotId: string): Promise<SnapshotSummaryRow | undefined> {
    return await this.db.prepare('SELECT head_commit, dirty_hash FROM snapshots WHERE id = ?')
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
    requestedWorkers: number | undefined,
    progress?: (event: IndexProgressEvent) => void,
  ): Promise<PreparedParseBatch> {
    const start = Date.now();
    const plans: ParsePlan[] = [];
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
      elapsedMs: 0,
    });
    const cachedByBlobHash = await this.parseCacheByBlobHash(files
      .filter(file => file.parseable && file.language)
      .map(file => file.blobHash));

    for (const file of files) {
      if (!file.parseable || !file.language) {
        plans.push({
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
          elapsedMs: Date.now() - start,
          details: { parseCacheHits, queuedForParse: workItems.length },
        });
        continue;
      }

      const cached = cachedByBlobHash.get(file.blobHash);
      if (cached) {
        const result = JSON.parse(cached) as ParseResult;
        parseCacheHits++;
        plans.push({
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
          elapsedMs: Date.now() - start,
          details: { parseCacheHits, queuedForParse: workItems.length },
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
        elapsedMs: Date.now() - start,
        details: { parseCacheHits, queuedForParse: workItems.length },
      });
    }

    progress?.({
      phase: 'parse-cache',
      status: 'complete',
      message: 'parse cache check complete',
      current: files.length,
      total: files.length,
      elapsedMs: Date.now() - start,
      details: { parseCacheHits, queuedForParse: workItems.length },
    });

    const parsed = parseFilesBatch(workItems, {
      workers: requestedWorkers,
      progress: event => progress?.({
        phase: 'parse',
        status: event.status,
        current: event.completed,
        total: event.total,
        elapsedMs: event.elapsedMs,
        details: { workers: event.workers },
      }),
    });
    const parsedByPath = new Map(parsed.map(item => [item.key, item.result]));
    for (const file of files) {
      if (!file.parseable || !file.language) continue;
      if (plans.some(plan => plan.file.relPath === file.relPath)) continue;
      const result = parsedByPath.get(file.relPath);
      if (!result) continue;
      plans.push({
        file,
        result,
        cacheHit: false,
        cacheInsert: true,
        parseStatus: result.hasParseErrors ? 'error' : 'ok',
      });
    }

    const order = new Map(files.map((file, index) => [file.relPath, index]));
    plans.sort((a, b) => (order.get(a.file.relPath) ?? 0) - (order.get(b.file.relPath) ?? 0));

    return {
      plans,
      filesParsed: workItems.length,
      parseCacheHits,
      parseWorkers: parseFilesBatchWorkerCount(workItems.length, requestedWorkers),
    };
  }

  private async parseCacheByBlobHash(blobHashes: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(blobHashes)];
    const cached = new Map<string, string>();
    for (const batch of chunkArray(unique, MAX_BATCH_PARAMS)) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = await this.db.prepare(`
        SELECT blob_hash, parse_json
        FROM parse_cache
        WHERE blob_hash IN (${placeholders})
      `).all(...batch) as ParseCacheRow[];
      for (const row of rows) cached.set(row.blob_hash, row.parse_json);
    }
    return cached;
  }

  private async insertParseCaches(items: ParseResultForFile[], now: string): Promise<void> {
    await this.insertRows(
      'parse_cache',
      ['blob_hash', 'language', 'parse_json', 'has_parse_errors', 'parse_confidence', 'created_at'],
      items
        .filter(item => item.file.language)
        .map(item => [
          item.file.blobHash,
          item.file.language,
          JSON.stringify(item.result),
          item.result.hasParseErrors ? 1 : 0,
          item.result.parseConfidence,
          now,
        ]),
      { ignoreConflicts: true },
    );
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
            files_total = ?
        WHERE id = ?
      `).run(
        args.git.branch,
        args.git.headCommit,
        args.git.treeHash,
        args.git.dirtyHash,
        args.manifestScanMs,
        args.manifestFilesTotal,
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
      for (const fileBatch of chunkArray(args.changes.changedFiles, WRITE_FILE_BATCH_SIZE)) {
        const parseCacheItems: ParseResultForFile[] = [];
        const materializeItems: ParseResultForFile[] = [];
        for (const file of fileBatch) {
          const plan = parsePlanByPath.get(file.relPath);
          if (!plan?.result) continue;
          materializeItems.push({ file, result: plan.result });
          if (plan.cacheInsert) parseCacheItems.push({ file, result: plan.result });
        }
        await this.insertParseCaches(parseCacheItems, now);
        await this.materializeParseResults(args.snapshotId, materializeItems);

        filesWritten += fileBatch.length;
        const currentFile = fileBatch[fileBatch.length - 1]!;
        lastWriteProgressAt = reportProgressEvery(args.progress, lastWriteProgressAt, {
          phase: 'write',
          status: filesWritten === args.changes.changedFiles.length ? 'complete' : 'progress',
          message: `writing ${currentFile.relPath}`,
          current: filesWritten,
          total: args.changes.changedFiles.length,
          elapsedMs: Date.now() - args.start,
        });
      }

      args.progress?.({
        phase: 'edges',
        status: 'start',
        message: 'resolving call edges',
        elapsedMs: Date.now() - args.start,
      });
      await this.resolveCallEdges(args.snapshotId, changedPaths);
      args.progress?.({
        phase: 'edges',
        status: 'start',
        message: 'rebuilding dependency edges',
        elapsedMs: Date.now() - args.start,
      });
      await this.rebuildDependencyEdges(args.snapshotId, dependencySources);

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
    };
  }

  private async deleteIndexedRowsForFiles(snapshotId: string, files: Set<string>): Promise<void> {
    if (files.size === 0) return;
    const values = [...files];
    const placeholders = values.map(() => '?').join(', ');
    for (const table of ['symbols', 'imports', 'type_refs', 'call_edges', 'annotations', 'endpoints', 'beans', 'inheritance']) {
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

  private async insertFiles(snapshotId: string, files: ManifestFile[], parseStatusByPath: Map<string, string>): Promise<void> {
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
      {
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
    for (const table of ['symbols', 'imports', 'type_refs', 'call_edges', 'annotations', 'endpoints', 'beans', 'inheritance']) {
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

  private async materializeParseResults(snapshotId: string, items: ParseResultForFile[]): Promise<void> {
    const symbolRows: SqlValue[][] = [];
    const annotationRows: SqlValue[][] = [];
    const inheritanceRows: SqlValue[][] = [];
    const beanRows: SqlValue[][] = [];
    const endpointRows: SqlValue[][] = [];
    const importRows: SqlValue[][] = [];
    const typeRefRows: SqlValue[][] = [];
    const callRows: SqlValue[][] = [];

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

      for (const call of result.calls) {
        callRows.push([snapshotId, call.caller, call.callee, file.relPath, call.line, 0.4, 'name-only', file.role]);
      }
    }

    await this.insertRows('symbols', copyableColumnsFor('symbols'), symbolRows, { ignoreConflicts: true });
    await this.insertRows('annotations', copyableColumnsFor('annotations'), annotationRows);
    await this.insertRows('inheritance', copyableColumnsFor('inheritance'), inheritanceRows);
    await this.insertRows('beans', copyableColumnsFor('beans'), beanRows);
    await this.insertRows('endpoints', copyableColumnsFor('endpoints'), endpointRows);
    await this.insertRows('imports', copyableColumnsFor('imports'), importRows);
    await this.insertRows('type_refs', copyableColumnsFor('type_refs'), typeRefRows);
    await this.insertRows('call_edges', copyableColumnsFor('call_edges'), callRows);
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
    const rows = await this.db.prepare(`
      SELECT rowid AS row_id, caller, callee, file, line, file_role
      FROM call_edges
      WHERE snapshot_id = ? AND resolution_kind = 'name-only' AND callee LIKE '%.%'
      ${fileFilter ? `AND file IN (${filePlaceholders})` : ''}
    `).all(...(fileFilter ? [snapshotId, ...fileFilter] : [snapshotId])) as Array<{
      row_id: number;
      caller: string;
      callee: string;
      file: string;
      line: number;
      file_role: string;
    }>;

    const fieldsByFile = new Map<string, Map<string, string>>();
    const fields = await this.db.prepare(`
      SELECT file, simple_name, return_type
      FROM symbols
      WHERE snapshot_id = ? AND kind = 'field' AND return_type IS NOT NULL
      ${fileFilter ? `AND file IN (${filePlaceholders})` : ''}
    `).all(...(fileFilter ? [snapshotId, ...fileFilter] : [snapshotId])) as Array<{ file: string; simple_name: string; return_type: string }>;
    for (const field of fields) {
      let byName = fieldsByFile.get(field.file);
      if (!byName) {
        byName = new Map();
        fieldsByFile.set(field.file, byName);
      }
      byName.set(field.simple_name, field.return_type);
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
        ]);
      }
    };

    for (const row of rows) {
      const dot = row.callee.lastIndexOf('.');
      if (dot <= 0) continue;
      const receiver = row.callee.substring(0, dot);
      const normalizedReceiver = receiver.startsWith('this.') ? receiver.substring('this.'.length) : receiver;
      const method = row.callee.substring(dot + 1);
      const fieldType = fieldsByFile.get(row.file)?.get(normalizedReceiver);
      if (fieldType) {
        edgeUpdates.push([row.row_id, `${fieldType}.${method}`, 0.8, 'receiver-field']);
        queueImplementationEdges(row, fieldType, method);
        continue;
      }
      if (/^[A-Z]/.test(receiver)) {
        edgeUpdates.push([row.row_id, row.callee, 0.8, 'static-or-type-receiver']);
        queueImplementationEdges(row, receiver, method);
      }
    }

    await this.updateCallEdges(edgeUpdates);
    await this.insertRows('call_edges', copyableColumnsFor('call_edges'), implementationEdgeRows);
  }

  private async updateCallEdges(rows: SqlValue[][]): Promise<void> {
    if (rows.length === 0) return;
    const columns = ['row_id', 'callee', 'confidence', 'resolution_kind'];
    const maxRows = Math.max(1, Math.floor(MAX_BATCH_PARAMS / columns.length));
    for (const batch of chunkArray(rows, maxRows)) {
      const params: SqlValue[] = [];
      const placeholders = batch.map(row => {
        if (row.length !== columns.length) {
          throw new Error(`Expected ${columns.length} values for call_edges update, received ${row.length}.`);
        }
        params.push(...row.map(value => value === undefined ? null : value));
        return `(${columns.map(() => '?').join(', ')})`;
      }).join(', ');
      await this.db.prepare(`
        UPDATE call_edges AS target
        SET callee = updates.callee::text,
            confidence = updates.confidence::double precision,
            resolution_kind = updates.resolution_kind::text
        FROM (VALUES ${placeholders}) AS updates(row_id, callee, confidence, resolution_kind)
        WHERE target.id = updates.row_id::bigint
      `).run(...params);
    }
  }

  private async insertRows(
    table: string,
    columns: string[],
    rows: SqlValue[][],
    options: BatchInsertOptions = {},
  ): Promise<void> {
    if (rows.length === 0) return;
    const maxRows = Math.max(1, Math.floor(MAX_BATCH_PARAMS / columns.length));
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
    case 'call_edges':
      return ['snapshot_id', 'caller', 'callee', 'file', 'line', 'confidence', 'resolution_kind', 'file_role'];
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

function normalizeWorkspaceKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase().replace(/\\/g, '/') : undefined;
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
  return Math.min(4, itemCount);
}

function optionalStringsEqual(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? undefined) === (right ?? undefined);
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
