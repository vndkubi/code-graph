import fs from 'node:fs';
import path from 'node:path';
import { runCheckedProcess } from '../infrastructure/process-runner.js';

const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

export interface GitHubPullRequestLocator {
  provider: 'github';
  owner: string;
  repo: string;
  number: number;
  url: string;
}

export interface GitHubPullRequestMetadata extends GitHubPullRequestLocator {
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
}

export interface PreparedPullRequestWorkspace extends GitHubPullRequestMetadata {
  root: string;
  sourceRoot: string;
  remote: string;
  workspaceKey: string;
}

interface GitHubPullResponse {
  number?: unknown;
  html_url?: unknown;
  base?: {
    ref?: unknown;
    sha?: unknown;
    repo?: { full_name?: unknown };
  };
  head?: {
    ref?: unknown;
    sha?: unknown;
  };
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await runCheckedProcess('git', args, {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return result.stdout.trim();
}

async function gitCommit(root: string, ref: string): Promise<string> {
  return (await git(root, ['rev-parse', '--verify', `${ref}^{commit}`])).toLowerCase();
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function validateSha(value: unknown, field: string): string {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`GitHub PR metadata has an invalid ${field}.`);
  return sha;
}

function validateRef(value: unknown, field: string): string {
  const ref = String(value ?? '').trim();
  if (ref === '' || /[\s~^:?*\\\[]/.test(ref) || ref.includes('..') || ref.startsWith('-')) {
    throw new Error(`GitHub PR metadata has an invalid ${field}.`);
  }
  return ref;
}

export function parseGitHubPullRequestUrl(value: string): GitHubPullRequestLocator {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid pull request URL: ${value}`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') {
    throw new Error('Only https://github.com/<owner>/<repo>/pull/<number> URLs are supported by --pr.');
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 4 || parts[2] !== 'pull' || !/^\d+$/.test(parts[3])) {
    throw new Error('Expected a GitHub pull request URL like https://github.com/owner/repo/pull/123.');
  }
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  const number = Number(parts[3]);
  return {
    provider: 'github',
    owner,
    repo,
    number,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
  };
}

export function githubRepositoryFromRemote(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  let pathname: string | undefined;
  const scpMatch = /^(?:[^@]+@)?github\.com:(.+)$/i.exec(trimmed);
  if (scpMatch) {
    pathname = scpMatch[1];
  } else {
    try {
      const parsed = new URL(trimmed);
      if (parsed.hostname.toLowerCase() !== 'github.com') return undefined;
      pathname = parsed.pathname;
    } catch {
      return undefined;
    }
  }
  const parts = pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (parts.length !== 2) return undefined;
  return `${parts[0]}/${parts[1]}`.toLowerCase();
}

export async function resolveGitHubPullRequest(
  value: string,
  options: { fetchImpl?: typeof fetch; token?: string } = {},
): Promise<GitHubPullRequestMetadata> {
  const locator = parseGitHubPullRequestUrl(value);
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = options.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'codegraph-pr-review',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.repo)}/pulls/${locator.number}`,
    { headers, signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 300);
    const authHint = response.status === 401 || response.status === 403 || response.status === 404
      ? ' Set GH_TOKEN or GITHUB_TOKEN when reviewing a private repository.'
      : '';
    throw new Error(`GitHub PR lookup failed (${response.status} ${response.statusText}): ${detail}.${authHint}`);
  }
  const payload = await response.json() as GitHubPullResponse;
  const fullName = String(payload.base?.repo?.full_name ?? '').toLowerCase();
  if (fullName !== `${locator.owner}/${locator.repo}`.toLowerCase()) {
    throw new Error('GitHub PR metadata does not match the repository in the supplied URL.');
  }
  return {
    ...locator,
    baseRef: validateRef(payload.base?.ref, 'base ref'),
    baseSha: validateSha(payload.base?.sha, 'base SHA'),
    headRef: validateRef(payload.head?.ref, 'head ref'),
    headSha: validateSha(payload.head?.sha, 'head SHA'),
  };
}

async function findMatchingGitHubRemote(root: string, metadata: GitHubPullRequestMetadata): Promise<string> {
  const expected = `${metadata.owner}/${metadata.repo}`.toLowerCase();
  const remotes = (await git(root, ['remote'])).split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  for (const remote of remotes) {
    // Read the configured URL before any global `url.*.insteadOf` rewrite.
    // Fetch still uses the rewrite (useful for offline/local test mirrors),
    // while repository matching must compare the declared GitHub identity.
    const remoteUrl = await git(root, ['config', '--get', `remote.${remote}.url`])
      .catch(() => git(root, ['remote', 'get-url', remote]));
    if (githubRepositoryFromRemote(remoteUrl) === expected) return remote;
  }
  throw new Error(`No git remote in ${root} matches GitHub repository ${metadata.owner}/${metadata.repo}.`);
}

async function ensureCommitAvailable(root: string, remote: string, sha: string): Promise<void> {
  try {
    await gitCommit(root, sha);
  } catch {
    await git(root, ['fetch', '--no-tags', remote, sha]);
    await gitCommit(root, sha);
  }
}

async function registeredWorktreePaths(root: string): Promise<Set<string>> {
  const paths = new Set<string>();
  for (const line of (await git(root, ['worktree', 'list', '--porcelain'])).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) paths.add(normalizedPath(line.slice('worktree '.length)));
  }
  return paths;
}

export async function assertReviewWorkspaceAtHead(root: string, headRef: string): Promise<string> {
  const expected = await gitCommit(root, headRef);
  const actual = await gitCommit(root, 'HEAD');
  if (actual !== expected) {
    throw new Error(`Review workspace HEAD ${actual} does not match requested head ${expected}. Check out the head commit or use --pr for an isolated worktree.`);
  }
  const trackedChanges = await git(root, ['status', '--porcelain=v1', '--untracked-files=no']);
  if (trackedChanges !== '') {
    throw new Error('Review workspace has tracked modifications. Commit/stash them or use --pr so graph facts and the git diff describe the same head state.');
  }
  return actual;
}

/**
 * Create or refresh a CodeGraph-owned worktree without touching the caller's
 * checkout. Existing managed worktrees are reused only when tracked files are
 * clean; unexpected user edits fail closed instead of being reset.
 */
export async function prepareManagedReviewWorktree(sourceRoot: string, worktreeRoot: string, headSha: string): Promise<string> {
  const resolvedSource = path.resolve(sourceRoot);
  const resolvedWorktree = path.resolve(worktreeRoot);
  const registered = (await registeredWorktreePaths(resolvedSource)).has(normalizedPath(resolvedWorktree));
  if (registered) {
    if (!fs.existsSync(resolvedWorktree)) {
      throw new Error(`Managed review worktree is registered but missing on disk: ${resolvedWorktree}`);
    }
    const trackedChanges = await git(resolvedWorktree, ['status', '--porcelain=v1', '--untracked-files=no']);
    if (trackedChanges !== '') {
      throw new Error(`Managed review worktree contains tracked modifications and was not reset: ${resolvedWorktree}`);
    }
    await git(resolvedWorktree, ['checkout', '--detach', headSha]);
  } else {
    if (fs.existsSync(resolvedWorktree) && fs.readdirSync(resolvedWorktree).length > 0) {
      throw new Error(`Refusing to replace an unregistered non-empty review directory: ${resolvedWorktree}`);
    }
    fs.mkdirSync(path.dirname(resolvedWorktree), { recursive: true });
    await git(resolvedSource, ['worktree', 'add', '--detach', resolvedWorktree, headSha]);
  }
  await assertReviewWorkspaceAtHead(resolvedWorktree, headSha);
  return resolvedWorktree;
}

export async function preparePullRequestReviewWorkspace(
  sourceRoot: string,
  prUrl: string,
  options: { fetchImpl?: typeof fetch; token?: string } = {},
): Promise<PreparedPullRequestWorkspace> {
  const resolvedSource = path.resolve(sourceRoot);
  const metadata = await resolveGitHubPullRequest(prUrl, options);
  const remote = await findMatchingGitHubRemote(resolvedSource, metadata);
  const namespace = `refs/codegraph/pull/${metadata.number}`;
  await git(resolvedSource, ['fetch', '--no-tags', '--force', remote,
    `+refs/heads/${metadata.baseRef}:${namespace}/base-tip`,
    `+refs/pull/${metadata.number}/head:${namespace}/head-tip`,
  ]);
  await ensureCommitAvailable(resolvedSource, remote, metadata.baseSha);
  await ensureCommitAvailable(resolvedSource, remote, metadata.headSha);
  const fetchedHead = await gitCommit(resolvedSource, `${namespace}/head-tip`);
  if (fetchedHead !== metadata.headSha) {
    throw new Error(`Pull request head changed during preparation (API ${metadata.headSha}, fetched ${fetchedHead}). Retry the review.`);
  }
  await git(resolvedSource, ['update-ref', `${namespace}/base`, metadata.baseSha]);
  await git(resolvedSource, ['update-ref', `${namespace}/head`, metadata.headSha]);

  const worktreeId = `github-${metadata.owner}-${metadata.repo}-pr-${metadata.number}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
  const worktreeRoot = path.join(resolvedSource, '.codegraph', 'pr-worktrees', worktreeId);
  const root = await prepareManagedReviewWorktree(resolvedSource, worktreeRoot, metadata.headSha);
  return {
    ...metadata,
    root,
    sourceRoot: resolvedSource,
    remote,
    workspaceKey: `github:${metadata.owner}/${metadata.repo}:pr:${metadata.number}`.toLowerCase(),
  };
}
