import fs from 'node:fs';
import path from 'node:path';
import { GitClient } from './git-client.js';

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Owns detached worktree creation and head-state safety for review inputs. */
export class ReviewWorkspaceProvider {
  constructor(private readonly git = new GitClient()) {}

  async assertAtHead(root: string, headRef: string): Promise<string> {
    const expected = await this.git.commit(root, headRef);
    const actual = await this.git.commit(root, 'HEAD');
    if (actual !== expected) {
      throw new Error(`Review workspace HEAD ${actual} does not match requested head ${expected}. Check out the head commit or use --pr for an isolated worktree.`);
    }
    const trackedChanges = await this.git.run(root, ['status', '--porcelain=v1', '--untracked-files=no']);
    if (trackedChanges !== '') {
      throw new Error('Review workspace has tracked modifications. Commit/stash them or use --pr so graph facts and the git diff describe the same head state.');
    }
    return actual;
  }

  async prepare(sourceRoot: string, worktreeRoot: string, headSha: string): Promise<string> {
    const resolvedSource = path.resolve(sourceRoot);
    const resolvedWorktree = path.resolve(worktreeRoot);
    const registered = (await this.registeredWorktreePaths(resolvedSource)).has(normalizedPath(resolvedWorktree));
    if (registered) {
      if (!fs.existsSync(resolvedWorktree)) {
        throw new Error(`Managed review worktree is registered but missing on disk: ${resolvedWorktree}`);
      }
      const trackedChanges = await this.git.run(resolvedWorktree, ['status', '--porcelain=v1', '--untracked-files=no']);
      if (trackedChanges !== '') {
        throw new Error(`Managed review worktree contains tracked modifications and was not reset: ${resolvedWorktree}`);
      }
      await this.git.run(resolvedWorktree, ['checkout', '--detach', headSha]);
    } else {
      if (fs.existsSync(resolvedWorktree) && fs.readdirSync(resolvedWorktree).length > 0) {
        throw new Error(`Refusing to replace an unregistered non-empty review directory: ${resolvedWorktree}`);
      }
      fs.mkdirSync(path.dirname(resolvedWorktree), { recursive: true });
      await this.git.run(resolvedSource, ['worktree', 'add', '--detach', resolvedWorktree, headSha]);
    }
    await this.assertAtHead(resolvedWorktree, headSha);
    return resolvedWorktree;
  }

  private async registeredWorktreePaths(root: string): Promise<Set<string>> {
    const paths = new Set<string>();
    for (const line of (await this.git.run(root, ['worktree', 'list', '--porcelain'])).split(/\r?\n/)) {
      if (line.startsWith('worktree ')) paths.add(normalizedPath(line.slice('worktree '.length)));
    }
    return paths;
  }
}
