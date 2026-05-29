import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { classifyFile, type FileRole } from './file-role.js';
import { sha256File } from '../hash.js';

export interface ManifestFile {
  absPath: string;
  relPath: string;
  mtimeMs: number;
  size: number;
  blobHash: string;
  language?: string;
  role: FileRole;
  parseable: boolean;
}

export interface ManifestScanResult {
  root: string;
  files: ManifestFile[];
  scannedAt: string;
  scanTimeMs: number;
  filesHashed: number;
  hashCacheHits: number;
}

export interface ManifestPathScanResult extends ManifestScanResult {
  deletedPaths: string[];
  skippedPaths: string[];
}

export interface ManifestPreviousFile {
  path: string;
  blobHash: string;
  mtimeMs: number;
  size: number;
  parseStatus?: string;
}

export interface ManifestScanOptions {
  maxFileSizeBytes?: number;
  previousFiles?: ManifestPreviousFile[];
  progress?: (event: ManifestScanProgressEvent) => void;
}

export interface ManifestScanProgressEvent {
  phase: 'manifest';
  status: 'start' | 'progress' | 'complete';
  currentPath?: string;
  filesFound: number;
  filesHashed: number;
  hashCacheHits: number;
  elapsedMs: number;
}

interface GitHashLookup {
  root: string;
  rootPrefix: string;
  entriesByPath: Map<string, GitIndexEntry>;
}

interface GitIndexEntry {
  blobHash: string;
  mtimeSec: number;
  mtimeNanos: number;
  size: number;
}

const DEFAULT_SKIP_DIRS = new Set([
  '.git',
  '.idea',
  '.vscode',
  'node_modules',
  'target',
  'build',
  'dist',
  'bin',
  'obj',
  '.gradle',
  '__pycache__',
]);

export function scanManifest(root: string, options: ManifestScanOptions = {}): ManifestScanResult {
  const start = Date.now();
  const rootDir = path.resolve(root);
  const maxFileSizeBytes = options.maxFileSizeBytes ?? 5 * 1024 * 1024;
  const files: ManifestFile[] = [];
  const previousByPath = new Map((options.previousFiles ?? []).map(file => [file.path, file]));
  const gitHashes = loadGitHashLookup(rootDir);
  const stats = { filesHashed: 0, hashCacheHits: 0, lastProgressAt: start };

  options.progress?.({
    phase: 'manifest',
    status: 'start',
    filesFound: 0,
    filesHashed: 0,
    hashCacheHits: 0,
    elapsedMs: 0,
  });

  walk(rootDir, rootDir, files, maxFileSizeBytes, previousByPath, gitHashes, stats, start, options.progress);

  options.progress?.({
    phase: 'manifest',
    status: 'complete',
    filesFound: files.length,
    filesHashed: stats.filesHashed,
    hashCacheHits: stats.hashCacheHits,
    elapsedMs: Date.now() - start,
  });

  return {
    root: rootDir,
    files,
    scannedAt: new Date().toISOString(),
    scanTimeMs: Date.now() - start,
    filesHashed: stats.filesHashed,
    hashCacheHits: stats.hashCacheHits,
  };
}

export function scanManifestPaths(root: string, changedPaths: string[], options: ManifestScanOptions = {}): ManifestPathScanResult {
  const start = Date.now();
  const rootDir = path.resolve(root);
  const maxFileSizeBytes = options.maxFileSizeBytes ?? 5 * 1024 * 1024;
  const previousByPath = new Map((options.previousFiles ?? []).map(file => [file.path, file]));
  const gitHashes = loadGitHashLookup(rootDir);
  const stats = { filesHashed: 0, hashCacheHits: 0 };
  const files: ManifestFile[] = [];
  const deletedPaths: string[] = [];
  const skippedPaths: string[] = [];
  const seen = new Set<string>();

  for (const rawPath of changedPaths) {
    const relPath = normalizeChangedPath(rootDir, rawPath);
    if (!relPath || seen.has(relPath)) continue;
    seen.add(relPath);
    const absPath = path.join(rootDir, relPath);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(absPath);
    } catch {
      deletedPaths.push(relPath);
      continue;
    }
    if (!stat.isFile()) {
      if (previousByPath.has(relPath)) deletedPaths.push(relPath);
      else skippedPaths.push(relPath);
      continue;
    }
    const file = manifestFileForPath(rootDir, absPath, relPath, stat, maxFileSizeBytes, previousByPath, gitHashes, stats);
    if (file) files.push(file);
    else if (previousByPath.has(relPath)) deletedPaths.push(relPath);
    else skippedPaths.push(relPath);
  }

  return {
    root: rootDir,
    files,
    deletedPaths,
    skippedPaths,
    scannedAt: new Date().toISOString(),
    scanTimeMs: Date.now() - start,
    filesHashed: stats.filesHashed,
    hashCacheHits: stats.hashCacheHits,
  };
}

function walk(
  root: string,
  dir: string,
  files: ManifestFile[],
  maxFileSizeBytes: number,
  previousByPath: Map<string, ManifestPreviousFile>,
  gitHashes: GitHashLookup | undefined,
  stats: { filesHashed: number; hashCacheHits: number; lastProgressAt: number },
  start: number,
  progress?: (event: ManifestScanProgressEvent) => void,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    const relPath = path.relative(root, absPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (DEFAULT_SKIP_DIRS.has(entry.name)) continue;
      walk(root, absPath, files, maxFileSizeBytes, previousByPath, gitHashes, stats, start, progress);
      continue;
    }

    if (!entry.isFile()) continue;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      continue;
    }
    const file = manifestFileForPath(root, absPath, relPath, stat, maxFileSizeBytes, previousByPath, gitHashes, stats);
    if (!file) continue;
    files.push(file);

    const now = Date.now();
    if (progress && (files.length % 500 === 0 || now - stats.lastProgressAt >= 5_000)) {
      stats.lastProgressAt = now;
      progress({
        phase: 'manifest',
        status: 'progress',
        currentPath: relPath,
        filesFound: files.length,
        filesHashed: stats.filesHashed,
        hashCacheHits: stats.hashCacheHits,
        elapsedMs: now - start,
      });
    }
  }
}

function manifestFileForPath(
  root: string,
  absPath: string,
  relPath: string,
  stat: fs.Stats,
  maxFileSizeBytes: number,
  previousByPath: Map<string, ManifestPreviousFile>,
  gitHashes: GitHashLookup | undefined,
  stats: { filesHashed: number; hashCacheHits: number },
): ManifestFile | undefined {
  if (!isInsideRoot(root, absPath)) return undefined;
  const classification = classifyFile(relPath);
  if (!classification.indexable) return undefined;
  if (stat.size > maxFileSizeBytes) return undefined;

  const previous = previousByPath.get(relPath);
  const blobHash = blobHashForFile(relPath, absPath, stat, previous, gitHashes, stats);
  return {
    absPath,
    relPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    blobHash,
    language: classification.language,
    role: classification.role,
    parseable: classification.parseable,
  };
}

function normalizeChangedPath(root: string, rawPath: string): string | undefined {
  if (!rawPath.trim()) return undefined;
  const absolute = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(root, rawPath);
  if (!isInsideRoot(root, absolute)) return undefined;
  return path.relative(root, absolute).replace(/\\/g, '/');
}

function isInsideRoot(root: string, absPath: string): boolean {
  const relative = path.relative(root, absPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function blobHashForFile(
  relPath: string,
  absPath: string,
  stat: fs.Stats,
  previous: ManifestPreviousFile | undefined,
  gitHashes: GitHashLookup | undefined,
  stats: { filesHashed: number; hashCacheHits: number },
): string {
  const gitPath = gitPathForRelPath(gitHashes, relPath);
  const gitEntry = gitPath ? gitHashes?.entriesByPath.get(gitPath) : undefined;
  if (gitEntry && gitIndexEntryMatchesStat(gitEntry, stat)) {
    stats.hashCacheHits++;
    return `git:${gitEntry.blobHash}`;
  }

  if (previous
    && previous.mtimeMs === stat.mtimeMs
    && previous.size === stat.size) {
    stats.hashCacheHits++;
    return previous.blobHash;
  }

  stats.filesHashed++;
  return sha256File(absPath);
}

function loadGitHashLookup(root: string): GitHashLookup | undefined {
  const topLevel = git(root, ['rev-parse', '--show-toplevel'])?.trim();
  if (!topLevel) return undefined;
  const gitRoot = path.resolve(topLevel);
  const rootPrefix = toPosixPath(path.relative(gitRoot, root));
  if (rootPrefix.startsWith('..')) return undefined;

  const lsFiles = git(gitRoot, ['ls-files', '-s', '--debug', '--', pathspec(rootPrefix)], 60_000);
  if (!lsFiles) return undefined;

  return {
    root: gitRoot,
    rootPrefix,
    entriesByPath: parseGitIndexEntries(lsFiles),
  };
}

function parseGitIndexEntries(output: string): Map<string, GitIndexEntry> {
  const entries = new Map<string, GitIndexEntry>();
  let current: Partial<GitIndexEntry> & { path?: string } | undefined;

  const flushCurrent = () => {
    if (!current?.path
      || !current.blobHash
      || current.mtimeSec === undefined
      || current.mtimeNanos === undefined
      || current.size === undefined) {
      return;
    }
    entries.set(current.path, {
      blobHash: current.blobHash,
      mtimeSec: current.mtimeSec,
      mtimeNanos: current.mtimeNanos,
      size: current.size,
    });
  };

  for (const line of output.split(/\r?\n/)) {
    const header = /^(\d+)\s+([0-9a-fA-F]+)\s+\d+\t(.+)$/.exec(line);
    if (header) {
      flushCurrent();
      current = { blobHash: header[2]!.toLowerCase(), path: header[3]! };
      continue;
    }
    if (!current) continue;

    const mtime = /^\s+mtime:\s+(\d+):(\d+)/.exec(line);
    if (mtime) {
      current.mtimeSec = Number(mtime[1]);
      current.mtimeNanos = Number(mtime[2]);
      continue;
    }

    const size = /^\s+size:\s+(\d+)/.exec(line);
    if (size) current.size = Number(size[1]);
  }
  flushCurrent();
  return entries;
}

function gitIndexEntryMatchesStat(entry: GitIndexEntry, stat: fs.Stats): boolean {
  if (entry.size !== stat.size) return false;
  const statMtimeSec = Math.floor(stat.mtimeMs / 1000);
  if (entry.mtimeSec !== statMtimeSec) return false;
  const statMtimeNanos = Math.round((stat.mtimeMs - statMtimeSec * 1000) * 1_000_000);
  return Math.abs(entry.mtimeNanos - statMtimeNanos) < 1_000_000;
}

function gitPathForRelPath(gitHashes: GitHashLookup | undefined, relPath: string): string | undefined {
  if (!gitHashes) return undefined;
  return gitHashes.rootPrefix ? `${gitHashes.rootPrefix}/${relPath}` : relPath;
}

function git(cwd: string, args: string[], timeout: number = 10_000): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

function pathspec(rootPrefix: string): string {
  return rootPrefix || '.';
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}
