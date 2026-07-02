import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodeGraphDb } from '../../src/v2/storage/database.js';
import { openCodeGraphDb } from '../../src/v2/storage/database.js';
import { V2Indexer } from '../../src/v2/index/indexer.js';
import {
  formatCiSelection,
  selectTestsForCi,
  type CiSelectionResult,
} from '../../src/v2/query/ci-test-selection.js';

const tempDirs: string[] = [];
const dbs: CodeGraphDb[] = [];

afterEach(async () => {
  for (const db of dbs.splice(0)) {
    await db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, relPath: string, content: string): void {
  const absPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runGit(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function openDb(home: string): Promise<CodeGraphDb> {
  const { db } = await openCodeGraphDb(home);
  dbs.push(db);
  return db;
}

/** Two-commit TS repo: base commit, then per-test mutations committed on top. */
async function setupRepo(): Promise<{ repo: string; db: CodeGraphDb }> {
  const repo = tempDir('codegraph-ci-select-');
  runGit(repo, 'init');
  runGit(repo, 'config', 'user.email', 'codegraph@example.test');
  runGit(repo, 'config', 'user.name', 'CodeGraph Test');
  writeFile(repo, 'src/lib.ts', 'export function libValue(): number { return 1; }\n');
  writeFile(repo, 'src/feature.ts', 'export function featureValue(): number { return 2; }\n');
  writeFile(repo, 'src/lib.test.ts', "import { libValue } from './lib.js';\nexport const checked = libValue();\n");
  writeFile(repo, 'src/feature.test.ts', "import { featureValue } from './feature.js';\nexport const checked = featureValue();\n");
  writeFile(repo, 'README.md', '# demo\n');
  writeFile(repo, 'package.json', '{ "name": "demo", "private": true }\n');
  runGit(repo, 'add', '.');
  runGit(repo, 'commit', '-m', 'base');
  const db = await openDb(tempDir('codegraph-home-'));
  return { repo, db };
}

async function select(db: CodeGraphDb, repo: string): Promise<CiSelectionResult> {
  const index = await new V2Indexer(db).indexWorkspace({ root: repo });
  return selectTestsForCi(db, repo, index.snapshotId, { baseRef: 'HEAD~1' });
}

describe('CI test selection', () => {
  it('selects only the tests that reach a changed source file', async () => {
    if (!hasGit()) return;
    const { repo, db } = await setupRepo();
    writeFile(repo, 'src/lib.ts', 'export function libValue(): number { return 42; }\n');
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'change lib');

    const result = await select(db, repo);
    expect(result.runAll).toBe(false);
    expect(result.tests.map(t => t.file)).toEqual(['src/lib.test.ts']);
    expect(result.totalTests).toBeGreaterThanOrEqual(2);
  });

  it('selects zero tests for documentation-only changes without falling back to run-all', async () => {
    if (!hasGit()) return;
    const { repo, db } = await setupRepo();
    writeFile(repo, 'README.md', '# demo\nupdated\n');
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'docs');

    const result = await select(db, repo);
    expect(result.runAll).toBe(false);
    expect(result.tests).toEqual([]);
    expect(result.ignoredChanged).toEqual(['README.md']);
  });

  it('falls back to run-all when build configuration changes', async () => {
    if (!hasGit()) return;
    const { repo, db } = await setupRepo();
    writeFile(repo, 'package.json', '{ "name": "demo", "private": true, "version": "0.0.1" }\n');
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'bump');

    const result = await select(db, repo);
    expect(result.runAll).toBe(true);
    expect(result.runAllReasons.some(r => r.includes('package.json'))).toBe(true);
  });

  it('falls back to run-all when a source file is deleted', async () => {
    if (!hasGit()) return;
    const { repo, db } = await setupRepo();
    fs.rmSync(path.join(repo, 'src/feature.ts'));
    writeFile(repo, 'src/feature.test.ts', 'export const checked = 2;\n');
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'delete feature');

    const result = await select(db, repo);
    expect(result.runAll).toBe(true);
    expect(result.runAllReasons.some(r => r.includes('src/feature.ts') && r.includes('deleted'))).toBe(true);
  });

  it('runs a changed test file itself even when nothing imports it', async () => {
    if (!hasGit()) return;
    const { repo, db } = await setupRepo();
    writeFile(repo, 'src/lib.test.ts', "import { libValue } from './lib.js';\nexport const checked = libValue() + 1;\n");
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'change test');

    const result = await select(db, repo);
    expect(result.runAll).toBe(false);
    expect(result.tests.map(t => t.file)).toContain('src/lib.test.ts');
  });
});

describe('formatCiSelection', () => {
  const base = (tests: string[], runAll = false): CiSelectionResult => ({
    changed: [],
    unresolvedChanged: [],
    tests: tests.map(file => ({ file, distance: 1, via: 'x' })),
    testCount: tests.length,
    totalTests: 10,
    reductionPct: 0.5,
    depthReached: 1,
    baseRef: 'origin/main',
    headRef: 'HEAD',
    changedInput: [],
    ignoredChanged: [],
    runAll,
    runAllReasons: runAll ? ['reason'] : [],
  });

  it('returns the ALL sentinel for run-all in runner formats', () => {
    expect(formatCiSelection(base([], true), 'maven')).toBe('ALL');
    expect(formatCiSelection(base([], true), 'gradle')).toBe('ALL');
    expect(formatCiSelection(base([], true), 'list')).toBe('ALL');
  });

  it('splits maven selection into surefire and failsafe buckets', () => {
    const result = base([
      'src/test/java/com/shop/service/PricingServiceTest.java',
      'src/test/java/com/shop/web/rest/CheckoutResourceIT.java',
    ]);
    expect(formatCiSelection(result, 'maven')).toBe(
      '-Dtest=com.shop.service.PricingServiceTest -Dit.test=com.shop.web.rest.CheckoutResourceIT ' +
      '-Dsurefire.failIfNoSpecifiedTests=false -Dfailsafe.failIfNoSpecifiedTests=false',
    );
  });

  it('uses a match-nothing placeholder for empty maven buckets', () => {
    const unitOnly = base(['src/test/java/com/shop/service/PricingServiceTest.java']);
    expect(formatCiSelection(unitOnly, 'maven')).toContain('-Dit.test=CodegraphNoneSelected');
    const emptySelection = base([]);
    expect(formatCiSelection(emptySelection, 'maven')).toContain('-Dtest=CodegraphNoneSelected');
  });

  it('renders gradle --tests filters and list paths', () => {
    const result = base(['src/test/java/com/shop/service/PricingServiceTest.java']);
    expect(formatCiSelection(result, 'gradle')).toBe('--tests com.shop.service.PricingServiceTest');
    expect(formatCiSelection(result, 'list')).toBe('src/test/java/com/shop/service/PricingServiceTest.java');
  });
});
