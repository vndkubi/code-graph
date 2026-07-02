import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ObservabilityEvent, TokenOptConfig } from "./types.js";

export function repoKey(repoRoot: string): string {
  const normalized = process.platform === "win32" ? path.resolve(repoRoot).toLowerCase() : path.resolve(repoRoot);
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function getUserCacheRoot(config: TokenOptConfig): string {
  if (config.paths.artifactDir) {
    return path.resolve(config.paths.artifactDir);
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "TokenOpt");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "tokenopt");
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "tokenopt");
}

export function getRepoCacheDir(config: TokenOptConfig, repoRoot: string): string {
  return path.join(getUserCacheRoot(config), "repos", repoKey(repoRoot));
}

export function writeArtifact(config: TokenOptConfig, repoRoot: string, name: string, content: string): string {
  const dir = path.join(getRepoCacheDir(config, repoRoot), "artifacts");
  fs.mkdirSync(dir, { recursive: true });
  const safeName = name.replace(/[^a-z0-9_.-]/gi, "-").slice(0, 80) || "artifact";
  const filePath = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName}`);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

export function appendEvent(config: TokenOptConfig, event: ObservabilityEvent): string {
  const dir = getRepoCacheDir(config, event.repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "tokenopt.jsonl");
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
  return filePath;
}

export function readRepoEvents(config: TokenOptConfig, repoRoot: string): ObservabilityEvent[] {
  const filePath = path.join(getRepoCacheDir(config, repoRoot), "tokenopt.jsonl");
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ObservabilityEvent);
}
