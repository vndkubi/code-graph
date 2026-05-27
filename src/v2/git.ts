import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { sha256Text } from './hash.js';

const GIT_COMMAND_TIMEOUT_MS = 5000;

export interface GitInfo {
  root: string;
  gitCommonDir?: string;
  remoteUrl?: string;
  branch?: string;
  headCommit?: string;
  treeHash?: string;
  dirtyHash: string;
  available: boolean;
}

export function getGitInfo(root: string): GitInfo {
  const base: GitInfo = {
    root,
    dirtyHash: 'no-git',
    available: false,
  };

  const topLevel = git(root, ['rev-parse', '--show-toplevel']);
  if (!topLevel) return base;

  const gitCommonDirRaw = git(root, ['rev-parse', '--git-common-dir']);
  const gitCommonDir = gitCommonDirRaw
    ? path.resolve(root, gitCommonDirRaw)
    : undefined;
  const remoteUrl = git(root, ['config', '--get', 'remote.origin.url']);
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const headCommit = git(root, ['rev-parse', 'HEAD']);
  const treeHash = git(root, ['rev-parse', `${headCommit ?? 'HEAD'}^{tree}`]);
  const dirty = git(root, ['status', '--porcelain=v1', '--untracked-files=normal']) ?? '';

  return {
    root: path.resolve(topLevel),
    gitCommonDir,
    remoteUrl,
    branch,
    headCommit,
    treeHash,
    dirtyHash: sha256Text(dirty),
    available: true,
  };
}

export function getChangedFiles(root: string, fromRef: string, toRef: string): Array<{ status: string; path: string }> {
  const output = git(root, ['diff', '--name-status', `${fromRef}..${toRef}`]);
  if (!output) return [];

  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split(/\s+/);
      return { status: parts[0] ?? '', path: parts[parts.length - 1] ?? '' };
    })
    .filter(change => change.path.length > 0);
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_COMMAND_TIMEOUT_MS,
    }).trim();
  } catch {
    return undefined;
  }
}
