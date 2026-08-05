import path from 'node:path';
import { GitClient } from '../infrastructure/git-client.js';
import { ReviewWorkspaceProvider } from '../infrastructure/review-workspace-provider.js';
import {
  githubRepositoryFromRemote,
  GitHubPullRequestClient,
  type GitHubPullRequestMetadata,
} from '../infrastructure/github-pull-request-client.js';

export {
  githubRepositoryFromRemote,
  parseGitHubPullRequestUrl,
  resolveGitHubPullRequest,
} from '../infrastructure/github-pull-request-client.js';
export type {
  GitHubPullRequestLocator,
  GitHubPullRequestMetadata,
} from '../infrastructure/github-pull-request-client.js';

const gitClient = new GitClient();
const workspaceProvider = new ReviewWorkspaceProvider(gitClient);

export interface PreparedPullRequestWorkspace extends GitHubPullRequestMetadata {
  root: string;
  sourceRoot: string;
  remote: string;
  workspaceKey: string;
}

async function git(root: string, args: string[]): Promise<string> {
  return gitClient.run(root, args);
}

async function gitCommit(root: string, ref: string): Promise<string> {
  return gitClient.commit(root, ref);
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

export async function assertReviewWorkspaceAtHead(root: string, headRef: string): Promise<string> {
  return workspaceProvider.assertAtHead(root, headRef);
}

/**
 * Create or refresh a CodeGraph-owned worktree without touching the caller's
 * checkout. Existing managed worktrees are reused only when tracked files are
 * clean; unexpected user edits fail closed instead of being reset.
 */
export async function prepareManagedReviewWorktree(sourceRoot: string, worktreeRoot: string, headSha: string): Promise<string> {
  return workspaceProvider.prepare(sourceRoot, worktreeRoot, headSha);
}

export async function preparePullRequestReviewWorkspace(
  sourceRoot: string,
  prUrl: string,
  options: { fetchImpl?: typeof fetch; token?: string } = {},
): Promise<PreparedPullRequestWorkspace> {
  const resolvedSource = path.resolve(sourceRoot);
  const metadata = await new GitHubPullRequestClient(options).resolve(prUrl);
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
