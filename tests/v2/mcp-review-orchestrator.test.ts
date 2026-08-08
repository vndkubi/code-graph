import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeMcpReviewIfRequested } from '../../src/v2/mcp/proxy.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
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

function writeFile(root: string, relPath: string, content: string): void {
  const file = path.join(root, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('MCP review orchestrator', () => {
  it('does not return a zero-success packet when the review source is missing', async () => {
    const packet = await executeMcpReviewIfRequested(
      { root: tempDir('codegraph-mcp-review-missing-'), mcpProfile: 'client' },
      { task: 'Review this pull request', mode: 'auto' },
      {},
    );

    expect(packet).toMatchObject({
      answerable: false,
      sufficientForAnswer: false,
      reviewStatus: 'input-unresolved',
      coverage: { complete: false },
      allowedFollowups: [{ tool: 'codegraph_context' }],
    });
    expect(packet?.nextAction).toMatch(/prUrl|baseRef\/headRef/i);
  });

  it('resolves a branch range in an isolated worktree and returns non-zero review coverage', async () => {
    const repo = tempDir('codegraph-mcp-review-range-');
    git(repo, 'init');
    git(repo, 'config', 'user.email', 'codegraph@example.test');
    git(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, '.gitignore', '.codegraph/\n');
    writeFile(repo, 'src/lib.ts', 'export function libValue(): number { return 1; }\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'base');
    git(repo, 'branch', '-M', 'main');
    git(repo, 'checkout', '-b', 'feature/change');
    writeFile(repo, 'src/lib.ts', 'export function libValue(): number { return 42; }\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'change');

    const packet = await executeMcpReviewIfRequested(
      { root: repo, mcpProfile: 'client' },
      { task: 'Review changes from branch main to branch feature/change', mode: 'auto' },
      {},
    );

    expect(packet).toMatchObject({
      answerable: true,
      reviewStatus: expect.any(String),
      reviewInput: { kind: 'range', baseRef: 'main', headRef: 'feature/change' },
      coverage: { complete: true },
      allowedFollowups: [],
    });
    expect(packet?.changedFiles).toEqual(expect.arrayContaining(['src/lib.ts']));
    expect((packet?.reviewMetrics as Record<string, unknown>).changedFileCount).toBeGreaterThan(0);
  });

  it('resolves a PR URL through immutable metadata and the managed worktree path', async () => {
    const repo = tempDir('codegraph-mcp-review-pr-');
    const bare = tempDir('codegraph-mcp-review-remote-');
    git(bare, 'init', '--bare');
    git(repo, 'init');
    git(repo, 'config', 'user.email', 'codegraph@example.test');
    git(repo, 'config', 'user.name', 'CodeGraph Test');
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/orders.git');
    git(repo, 'config', 'url.' + bare + '.insteadOf', 'https://github.com/acme/orders.git');
    writeFile(repo, '.gitignore', '.codegraph/\n');
    writeFile(repo, 'src/lib.ts', 'export function libValue(): number { return 1; }\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'base');
    git(repo, 'branch', '-M', 'main');
    const baseSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-b', 'feature/pr');
    writeFile(repo, 'src/lib.ts', 'export function libValue(): number { return 2; }\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'pr change');
    const headSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'push', 'origin', 'main');
    git(repo, 'push', 'origin', 'feature/pr:refs/pull/1/head');

    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({
      number: 1,
      html_url: 'https://github.com/acme/orders/pull/1',
      base: { ref: 'main', sha: baseSha, repo: { full_name: 'acme/orders' } },
      head: { ref: 'feature/pr', sha: headSha },
    }), { status: 200 })) as typeof fetch);

    const packet = await executeMcpReviewIfRequested(
      { root: repo, mcpProfile: 'client' },
      { task: 'Review PR https://github.com/acme/orders/pull/1' },
      {},
    );

    expect(packet).toMatchObject({
      answerable: true,
      reviewInput: { kind: 'pull_request', prUrl: 'https://github.com/acme/orders/pull/1' },
      coverage: { complete: true },
      allowedFollowups: [],
    });
    expect(packet?.changedFiles).toEqual(expect.arrayContaining(['src/lib.ts']));
  });
});
