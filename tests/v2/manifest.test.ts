import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { scanManifest } from '../../src/v2/index/manifest.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('manifest scan', () => {
  it('uses git blob ids for clean tracked files', () => {
    const repo = tempGitRepo();
    writeFile(repo, 'src/main/java/example/App.java', 'class App {}\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'initial']);

    const manifest = scanManifest(repo);
    const file = manifest.files.find(item => item.relPath === 'src/main/java/example/App.java');

    expect(file?.blobHash).toMatch(/^git:[0-9a-f]{40}$/);
    expect(manifest.filesHashed).toBe(0);
    expect(manifest.hashCacheHits).toBe(1);
  });

  it('hashes dirty tracked files instead of reusing git blob ids', () => {
    const repo = tempGitRepo();
    writeFile(repo, 'src/main/java/example/App.java', 'class App {}\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'initial']);
    writeFile(repo, 'src/main/java/example/App.java', 'class App { void changed() {} }\n');

    const manifest = scanManifest(repo);
    const file = manifest.files.find(item => item.relPath === 'src/main/java/example/App.java');

    expect(file?.blobHash).not.toMatch(/^git:/);
    expect(manifest.filesHashed).toBe(1);
    expect(manifest.hashCacheHits).toBe(0);
  });
});

function tempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-manifest-'));
  tempDirs.push(dir);
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'codegraph@example.test']);
  git(dir, ['config', 'user.name', 'CodeGraph Test']);
  return dir;
}

function writeFile(root: string, relPath: string, contents: string): void {
  const filePath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}
