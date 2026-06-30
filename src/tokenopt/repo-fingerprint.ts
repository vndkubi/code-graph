import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { RepoFingerprint } from "./types.js";

const MAX_FALLBACK_FILES = 5_000;
const MAX_FALLBACK_DEPTH = 30;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  ".next",
  ".nuxt",
  ".cache",
  ".venv",
  "venv",
  "__pycache__"
]);

export function getRepoFingerprint(repoRoot: string, now = new Date()): RepoFingerprint {
  const root = path.resolve(repoRoot);
  const git = getGitFingerprint(root, now);
  if (git) {
    return git;
  }
  return getFileMetadataFingerprint(root, now);
}

export function sameRepoFingerprint(a: RepoFingerprint | undefined, b: RepoFingerprint | undefined): boolean {
  if (!a || !b) {
    return false;
  }
  return a.strategy === b.strategy &&
    path.resolve(a.repoRoot) === path.resolve(b.repoRoot) &&
    a.head === b.head &&
    a.statusHash === b.statusHash &&
    a.fileHash === b.fileHash;
}

function getGitFingerprint(repoRoot: string, now: Date): RepoFingerprint | undefined {
  const inside = runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return undefined;
  }

  const head = runGit(repoRoot, ["rev-parse", "HEAD"]);
  const status = runGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (head.status !== 0 || status.status !== 0) {
    return undefined;
  }

  return {
    strategy: "git-head-and-status-v1",
    repoRoot,
    head: head.stdout.trim(),
    statusHash: hashText(status.stdout.replace(/\r\n/g, "\n")),
    createdAt: now.toISOString()
  };
}

function getFileMetadataFingerprint(repoRoot: string, now: Date): RepoFingerprint {
  const entries: string[] = [];
  const stack: Array<{ absolute: string; relative: string; depth: number }> = [{ absolute: repoRoot, relative: "", depth: 0 }];

  while (stack.length > 0 && entries.length < MAX_FALLBACK_FILES) {
    const current = stack.pop()!;
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }

    children.sort((a, b) => b.name.localeCompare(a.name));
    for (const child of children) {
      const relative = current.relative ? path.join(current.relative, child.name) : child.name;
      const normalized = relative.replace(/\\/g, "/");
      const absolute = path.join(current.absolute, child.name);
      if (child.isDirectory()) {
        if (current.depth >= MAX_FALLBACK_DEPTH || SKIP_DIRS.has(child.name.toLowerCase())) {
          continue;
        }
        stack.push({ absolute, relative, depth: current.depth + 1 });
        continue;
      }
      if (!child.isFile()) {
        continue;
      }
      try {
        const stat = fs.statSync(absolute);
        entries.push(`${normalized}\t${stat.size}\t${Math.trunc(stat.mtimeMs)}`);
      } catch {
        continue;
      }
      if (entries.length >= MAX_FALLBACK_FILES) {
        break;
      }
    }
  }

  return {
    strategy: "file-metadata-v1",
    repoRoot,
    fileHash: hashText(entries.sort().join("\n")),
    createdAt: now.toISOString()
  };
}

function runGit(cwd: string, args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : ""
  };
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}
