import fs from 'node:fs';
import path from 'node:path';
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

export function scanManifest(root: string, options: { maxFileSizeBytes?: number } = {}): ManifestScanResult {
  const start = Date.now();
  const rootDir = path.resolve(root);
  const maxFileSizeBytes = options.maxFileSizeBytes ?? 5 * 1024 * 1024;
  const files: ManifestFile[] = [];

  walk(rootDir, rootDir, files, maxFileSizeBytes);

  return {
    root: rootDir,
    files,
    scannedAt: new Date().toISOString(),
    scanTimeMs: Date.now() - start,
  };
}

function walk(root: string, dir: string, files: ManifestFile[], maxFileSizeBytes: number): void {
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
      walk(root, absPath, files, maxFileSizeBytes);
      continue;
    }

    if (!entry.isFile()) continue;

    const classification = classifyFile(relPath);
    if (!classification.indexable) continue;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      continue;
    }
    if (stat.size > maxFileSizeBytes) continue;

    files.push({
      absPath,
      relPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      blobHash: sha256File(absPath),
      language: classification.language,
      role: classification.role,
      parseable: classification.parseable,
    });
  }
}
