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

interface GitVisibleFilesLookup {
  files: Set<string>;
}

interface GitIndexEntry {
  blobHash: string;
  mtimeSec: number;
  mtimeNanos: number;
  size: number;
}

const DEFAULT_SKIP_DIRS = new Set([
  '.git',
  '.codegraph',
  'benchmark-results',
  '.tmp',
  '.idea',
  '.vscode',
  'node_modules',
  'target',
  'build',
  'dist',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'bin',
  'obj',
  '.gradle',
  '__pycache__',
]);

const EMBEDDED_REPO_SEARCH_DEPTH = 4;
const EMBEDDED_REPO_SEARCH_ENTRIES = 2000;

export function scanManifest(root: string, options: ManifestScanOptions = {}): ManifestScanResult {
  const start = Date.now();
  const rootDir = path.resolve(root);
  const maxFileSizeBytes = options.maxFileSizeBytes ?? 5 * 1024 * 1024;
  const files: ManifestFile[] = [];
  const previousByPath = new Map((options.previousFiles ?? []).map(file => [file.path, file]));
  const gitHashes = loadGitHashLookup(rootDir);
  const gitVisibleFiles = loadGitVisibleFiles(rootDir);
  const stats = { filesHashed: 0, hashCacheHits: 0, lastProgressAt: start };

  options.progress?.({
    phase: 'manifest',
    status: 'start',
    filesFound: 0,
    filesHashed: 0,
    hashCacheHits: 0,
    elapsedMs: 0,
  });

  if (gitVisibleFiles) {
    collectManifestFilesFromGit(rootDir, [...gitVisibleFiles.files].sort(), files, maxFileSizeBytes, previousByPath, gitHashes, stats, start, options.progress);
  } else {
    walk(rootDir, rootDir, files, maxFileSizeBytes, previousByPath, gitHashes, stats, start, options.progress);
  }

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
  const gitVisibleFiles = loadGitVisibleFiles(rootDir);
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
    if (gitVisibleFiles && !gitVisibleFiles.files.has(relPath)) {
      if (previousByPath.has(relPath)) deletedPaths.push(relPath);
      else skippedPaths.push(relPath);
      continue;
    }
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
      if (DEFAULT_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.tmp')) continue;
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

function collectManifestFilesFromGit(
  root: string,
  relPaths: string[],
  files: ManifestFile[],
  maxFileSizeBytes: number,
  previousByPath: Map<string, ManifestPreviousFile>,
  gitHashes: GitHashLookup | undefined,
  stats: { filesHashed: number; hashCacheHits: number; lastProgressAt: number },
  start: number,
  progress?: (event: ManifestScanProgressEvent) => void,
): void {
  for (const relPath of relPaths) {
    if (shouldSkipPathByDefault(relPath)) continue;
    const absPath = path.join(root, relPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
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

function loadGitVisibleFiles(root: string): GitVisibleFilesLookup | undefined {
  const topLevel = git(root, ['rev-parse', '--show-toplevel'])?.trim();
  if (!topLevel) return undefined;
  const gitRoot = path.resolve(topLevel);
  if (gitRoot !== root && isGitIgnoredByParent(root)) return undefined;

  const files = new Set<string>();
  collectGitVisibleFiles(root, '', files);
  return { files };
}

function collectGitVisibleFiles(repoDir: string, prefix: string, files: Set<string>): void {
  const tracked = git(repoDir, ['ls-files', '-z', '-c'], 60_000) ?? '';
  for (const rel of tracked.split('\0')) {
    if (!rel) continue;
    const normalized = normalizePath(prefix + rel);
    if (shouldSkipPathByDefault(normalized)) continue;
    files.add(normalized);
  }

  const untracked = git(repoDir, ['ls-files', '-z', '-o', '--exclude-standard'], 60_000) ?? '';
  for (const rel of untracked.split('\0')) {
    if (!rel) continue;
    if (rel.endsWith('/')) {
      const childDir = path.join(repoDir, rel);
      const gitDirKind = classifyGitDir(childDir);
      if (gitDirKind === 'embedded' && !shouldSkipDirByDefault(rel.split('/').filter(Boolean).at(-1) ?? '')) {
        collectGitVisibleFiles(childDir, prefix + rel, files);
      }
      continue;
    }
    const normalized = normalizePath(prefix + rel);
    if (shouldSkipPathByDefault(normalized)) continue;
    files.add(normalized);
  }

  for (const rel of findIgnoredEmbeddedRepos(repoDir)) {
    collectGitVisibleFiles(path.join(repoDir, rel), prefix + rel, files);
  }
}

function listIgnoredDirs(repoDir: string): string[] {
  const output = git(repoDir, ['ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory'], 60_000) ?? '';
  return output.split('\0').filter(entry => entry.endsWith('/'));
}

function findIgnoredEmbeddedRepos(repoDir: string): string[] {
  const repos: string[] = [];
  for (const dir of listIgnoredDirs(repoDir)) {
    const tail = dir.split('/').filter(Boolean).at(-1) ?? '';
    if (shouldSkipDirByDefault(tail)) continue;
    repos.push(...findNestedGitRepos(path.join(repoDir, dir), dir));
  }
  return repos;
}

function findNestedGitRepos(absDir: string, relPrefix: string): string[] {
  const found: string[] = [];
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: absDir, rel: relPrefix, depth: 0 }];
  let examined = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (++examined > EMBEDDED_REPO_SEARCH_ENTRIES) break;
    const kind = classifyGitDir(current.abs);
    if (kind === 'worktree') continue;
    if (kind === 'embedded') {
      found.push(current.rel);
      continue;
    }
    if (current.depth >= EMBEDDED_REPO_SEARCH_DEPTH) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || shouldSkipDirByDefault(entry.name)) continue;
      queue.push({
        abs: path.join(current.abs, entry.name),
        rel: normalizeRepoDir(current.rel + entry.name + '/'),
        depth: current.depth + 1,
      });
    }
  }
  return found;
}

function classifyGitDir(absDir: string): 'embedded' | 'worktree' | 'none' {
  const gitPath = path.join(absDir, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(gitPath);
  } catch {
    return 'none';
  }
  if (stat.isDirectory()) return 'embedded';
  if (!stat.isFile()) return 'none';
  try {
    const gitdir = fs.readFileSync(gitPath, 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (gitdir && /(^|[\\/])\.git[\\/]worktrees[\\/]/.test(gitdir)) return 'worktree';
  } catch {
    // Keep prior behavior on unreadable pointers.
  }
  return 'embedded';
}

function isGitIgnoredByParent(root: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', path.resolve(root)], {
      cwd: root,
      stdio: 'ignore',
      timeout: 5_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function shouldSkipDirByDefault(name: string): boolean {
  return DEFAULT_SKIP_DIRS.has(name) || name.startsWith('.tmp');
}

function shouldSkipPathByDefault(relPath: string): boolean {
  return normalizePath(relPath).split('/').some(part => shouldSkipDirByDefault(part));
}

function normalizeRepoDir(value: string): string {
  return normalizePath(value).replace(/\/?$/, '/');
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

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}
