import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertReviewWorkspaceAtHead,
  githubRepositoryFromRemote,
  parseGitHubPullRequestUrl,
  prepareManagedReviewWorktree,
  resolveGitHubPullRequest,
} from '../../src/v2/query/pr-review.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function createRepo(): { root: string; baseSha: string; headSha: string } {
  const root = tempDir('codegraph-pr-review-');
  git(root, 'init');
  git(root, 'config', 'user.email', 'codegraph@example.test');
  git(root, 'config', 'user.name', 'CodeGraph Test');
  fs.writeFileSync(path.join(root, '.gitignore'), '.codegraph/\n');
  fs.writeFileSync(path.join(root, 'app.ts'), 'export const value = 1;\n');
  git(root, 'add', '.gitignore', 'app.ts');
  git(root, 'commit', '-m', 'base');
  const baseSha = git(root, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'app.ts'), 'export const value = 2;\n');
  git(root, 'add', 'app.ts');
  git(root, 'commit', '-m', 'head');
  const headSha = git(root, 'rev-parse', 'HEAD');
  return { root, baseSha, headSha };
}

describe('GitHub PR input', () => {
  it('parses and canonicalizes GitHub pull request URLs', () => {
    expect(parseGitHubPullRequestUrl('https://github.com/vndkubi/code-graph/pull/42/files')).toEqual({
      provider: 'github',
      owner: 'vndkubi',
      repo: 'code-graph',
      number: 42,
      url: 'https://github.com/vndkubi/code-graph/pull/42',
    });
    expect(() => parseGitHubPullRequestUrl('https://gitlab.com/acme/app/merge_requests/1')).toThrow(/Only https:\/\/github\.com/);
    expect(() => parseGitHubPullRequestUrl('https://github.com/acme/app/issues/1')).toThrow(/Expected a GitHub pull request URL/);
  });

  it('normalizes HTTPS and SSH GitHub remotes', () => {
    expect(githubRepositoryFromRemote('https://github.com/VndKubi/code-graph.git')).toBe('vndkubi/code-graph');
    expect(githubRepositoryFromRemote('git@github.com:VndKubi/code-graph.git')).toBe('vndkubi/code-graph');
    expect(githubRepositoryFromRemote('ssh://git@github.com/VndKubi/code-graph.git')).toBe('vndkubi/code-graph');
    expect(githubRepositoryFromRemote('https://gitlab.com/vndkubi/code-graph.git')).toBeUndefined();
  });

  it('resolves immutable base/head SHAs without exposing the auth token', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      number: 42,
      html_url: 'https://github.com/vndkubi/code-graph/pull/42',
      base: {
        ref: 'main',
        sha: '1'.repeat(40),
        repo: { full_name: 'vndkubi/code-graph' },
      },
      head: { ref: 'feature/review', sha: '2'.repeat(40) },
    }), { status: 200 })) as typeof fetch;
    await expect(resolveGitHubPullRequest(
      'https://github.com/vndkubi/code-graph/pull/42',
      { fetchImpl, token: 'must-not-appear' },
    )).resolves.toMatchObject({
      baseRef: 'main',
      baseSha: '1'.repeat(40),
      headRef: 'feature/review',
      headSha: '2'.repeat(40),
    });
  });
});

describe('review head-state safety', () => {
  it('creates an isolated detached worktree at the requested immutable head', () => {
    const { root, baseSha, headSha } = createRepo();
    git(root, 'checkout', '--detach', baseSha);
    const worktreeRoot = path.join(root, '.codegraph', 'pr-worktrees', 'review');
    expect(prepareManagedReviewWorktree(root, worktreeRoot, headSha)).toBe(path.resolve(worktreeRoot));
    expect(git(worktreeRoot, 'rev-parse', 'HEAD')).toBe(headSha);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(baseSha);
    expect(assertReviewWorkspaceAtHead(worktreeRoot, headSha)).toBe(headSha);
  });

  it('fails closed on a mismatched head or tracked worktree edits', () => {
    const { root, baseSha, headSha } = createRepo();
    expect(() => assertReviewWorkspaceAtHead(root, baseSha)).toThrow(/does not match requested head/);
    expect(assertReviewWorkspaceAtHead(root, headSha)).toBe(headSha);
    fs.writeFileSync(path.join(root, 'app.ts'), 'export const value = 3;\n');
    expect(() => assertReviewWorkspaceAtHead(root, headSha)).toThrow(/tracked modifications/);
  });
});
