import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewPullRequestUseCase } from '../../src/v2/application/review-use-case.js';

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

function createRepo(): string {
  const root = tempDir('codegraph-review-use-case-');
  git(root, 'init');
  git(root, 'config', 'user.email', 'codegraph@example.test');
  git(root, 'config', 'user.name', 'CodeGraph Test');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'lib.ts'), 'export function libValue(): number { return 1; }\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  git(root, 'branch', '-M', 'main');
  git(root, 'checkout', '-b', 'feature/change');
  fs.writeFileSync(path.join(root, 'src', 'lib.ts'), 'export function libValue(): number { return 42; }\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'change');
  return root;
}

describe('ReviewPullRequestUseCase', () => {
  it('keeps CLI range reviews on the validated caller checkout', async () => {
    const root = createRepo();
    const execution = await new ReviewPullRequestUseCase().execute({
      sourceRoot: root,
      input: { kind: 'range', baseRef: 'main', headRef: 'HEAD' },
      isolateRangeWorkspace: false,
      requireCurrentHead: true,
    });

    expect(execution.reviewRoot).toBe(path.resolve(root));
    expect(execution.reviewInput).toEqual({ kind: 'range', baseRef: 'main', headRef: 'HEAD' });
    expect(execution.review.changedFiles).toContain('src/lib.ts');
    expect(execution.review.coverage?.complete).toBe(true);
  });

  it('uses a detached managed worktree for isolated MCP range reviews', async () => {
    const root = createRepo();
    const execution = await new ReviewPullRequestUseCase().execute({
      sourceRoot: root,
      input: { kind: 'range', baseRef: 'main', headRef: 'feature/change' },
      isolateRangeWorkspace: true,
    });

    expect(execution.reviewRoot).not.toBe(path.resolve(root));
    expect(path.resolve(git(execution.reviewRoot, 'rev-parse', '--show-toplevel'))).toBe(path.resolve(execution.reviewRoot));
    expect(git(execution.reviewRoot, 'rev-parse', 'HEAD')).toBe(git(root, 'rev-parse', 'feature/change'));
    expect(execution.workspaceKey).toMatch(/^review:/);
    expect(execution.review.coverage?.complete).toBe(true);
  });
});
