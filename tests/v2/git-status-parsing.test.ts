import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getGitDirtyFiles } from '../../src/v2/git.js';

// `git status --porcelain=v1` uses fixed columns `XY<space>path`, and X is a
// BLANK for worktree-only changes (` M file`). Trimming the whole command
// output — rather than each line — ate that leading blank on the FIRST line
// only, shifting its path left by one character. The corrupted path then
// reached the agent in the stale-index banner and broke every consumer that
// matches dirty paths against indexed paths.
const roots: string[] = [];

function repoWithFirstEntryWorktreeModified(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cg-git-status-'));
  roots.push(root);
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] });
  };
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');

  mkdirSync(path.join(root, 'backend'), { recursive: true });
  writeFileSync(path.join(root, 'backend', 'Tracked.java'), 'class Tracked {}\n');
  git('add', '.');
  git('commit', '-m', 'seed');

  // Worktree-only edit => status line is " M backend/Tracked.java" (blank X).
  writeFileSync(path.join(root, 'backend', 'Tracked.java'), 'class Tracked { int x; }\n');
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('getGitDirtyFiles porcelain parsing', () => {
  it('keeps the first character of a worktree-modified path', () => {
    const dirty = getGitDirtyFiles(repoWithFirstEntryWorktreeModified());

    expect(dirty.available).toBe(true);
    // Before the fix this was "ackend/Tracked.java".
    expect(dirty.modified).toContain('backend/Tracked.java');
  });

  it('keeps paths intact when a worktree-modified entry is followed by others', () => {
    const root = repoWithFirstEntryWorktreeModified();
    writeFileSync(path.join(root, 'backend', 'Added.java'), 'class Added {}\n');

    const dirty = getGitDirtyFiles(root);

    expect(dirty.modified).toContain('backend/Tracked.java');
    expect(dirty.added).toContain('backend/Added.java');
    for (const file of [...dirty.modified, ...dirty.added, ...dirty.deleted]) {
      expect(file.startsWith('backend/')).toBe(true);
    }
  });
});
