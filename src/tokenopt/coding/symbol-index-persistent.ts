import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getRepoFingerprint, sameRepoFingerprint } from "../repo-fingerprint.js";
import { repoKey } from "../observability.js";
import type { CodingSymbol, RepoFingerprint } from "../types.js";

export interface SymbolIndexedFile {
  path: string;
  size: number;
  mtimeMs: number;
  language: CodingSymbol["language"];
  symbolCount: number;
}

export interface SymbolIndexSnapshot {
  version: 1;
  repoFingerprint: RepoFingerprint;
  createdAt: string;
  files: SymbolIndexedFile[];
  symbols: CodingSymbol[];
}

export interface SymbolIndexLoadResult {
  snapshot: SymbolIndexSnapshot;
  cacheHit: boolean;
  cachePath: string;
}

export interface LoadSymbolIndexOptions {
  forceRebuild?: boolean;
}

export function loadOrBuildSymbolIndex(
  repoRoot: string,
  build: (repoFingerprint: RepoFingerprint) => Omit<SymbolIndexSnapshot, "version" | "repoFingerprint" | "createdAt">,
  options: LoadSymbolIndexOptions = {}
): SymbolIndexLoadResult {
  const cachePath = getSymbolIndexCachePath(repoRoot);
  const fingerprint = getRepoFingerprint(repoRoot);
  if (!options.forceRebuild) {
    const cached = readSnapshot(cachePath);
    if (cached && sameRepoFingerprint(cached.repoFingerprint, fingerprint)) {
      return { snapshot: cached, cacheHit: true, cachePath };
    }
  }

  const built = build(fingerprint);
  const snapshot: SymbolIndexSnapshot = {
    version: 1,
    repoFingerprint: fingerprint,
    createdAt: new Date().toISOString(),
    files: built.files,
    symbols: built.symbols
  };
  writeSnapshot(cachePath, snapshot);
  return { snapshot, cacheHit: false, cachePath };
}

export function getSymbolIndexCachePath(repoRoot: string): string {
  return path.join(defaultCacheRoot(), "repos", repoKey(repoRoot), "symbol-index-v1.json");
}

function readSnapshot(cachePath: string): SymbolIndexSnapshot | undefined {
  if (!fs.existsSync(cachePath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as SymbolIndexSnapshot;
    if (parsed.version !== 1 || !Array.isArray(parsed.files) || !Array.isArray(parsed.symbols)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function writeSnapshot(cachePath: string, snapshot: SymbolIndexSnapshot): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

function defaultCacheRoot(): string {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "TokenOpt");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "tokenopt");
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "tokenopt");
}
