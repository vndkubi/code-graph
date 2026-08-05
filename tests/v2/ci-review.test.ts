import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodeGraphDb } from '../../src/v2/storage/database.js';
import { openCodeGraphDb } from '../../src/v2/storage/database.js';
import { V2Indexer } from '../../src/v2/index/indexer.js';
import { V2QueryService } from '../../src/v2/query/service.js';
import {
  CI_REVIEW_COMMENT_MARKER,
  ciReviewExitCode,
  filterIgnorableDiff,
  formatCiReview,
  reviewForCi,
  ruleIdForFinding,
  type CiReviewResult,
} from '../../src/v2/query/ci-review.js';

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

function sampleResult(overrides: Partial<CiReviewResult> = {}): CiReviewResult {
  return {
    baseRef: 'origin/main',
    headRef: 'HEAD',
    changedFiles: ['src/app.ts'],
    ignoredFiles: [],
    reviewStatus: 'needs-attention',
    findings: [
      {
        id: 'review-stale-caller-com.example.Foo#bar',
        ruleId: 'review-stale-caller',
        priority: 'P1',
        category: 'impact',
        file: 'src/app.ts',
        line: 12,
        title: '2 call site(s) outside this diff | may need updating',
        why: 'callers were written against the old behavior',
        suggestedCheck: 'check each caller',
        confidence: 0.74,
      },
      {
        id: 'review-fanout',
        ruleId: 'review-fanout',
        priority: 'P2',
        title: 'Shared code has non-trivial fanout',
        why: 'several dependents',
        confidence: 0.75,
      },
    ],
    priorityCounts: { P0: 0, P1: 1, P2: 1 },
    droppedBelowMinPriority: 0,
    ...overrides,
  };
}

describe('ruleIdForFinding', () => {
  it('strips instance suffixes down to the stable rule id', () => {
    expect(ruleIdForFinding('review-stale-caller-com.example.Foo#bar')).toBe('review-stale-caller');
    expect(ruleIdForFinding('review-long-method-com.example.Foo#big')).toBe('review-long-method');
    expect(ruleIdForFinding('review-secret-src/config.ts')).toBe('review-secret');
  });

  it('prefers the longer duplicated-code-existing prefix over duplicated-code', () => {
    expect(ruleIdForFinding('review-duplicated-code-existing-src/a.ts-10-src/b.ts')).toBe('review-duplicated-code-existing');
    expect(ruleIdForFinding('review-duplicated-code-src/a.ts-10-src/b.ts-20')).toBe('review-duplicated-code');
  });

  it('keeps unknown ids verbatim', () => {
    expect(ruleIdForFinding('review-endpoint-contract')).toBe('review-endpoint-contract');
    expect(ruleIdForFinding('no-resolved-patch-input')).toBe('no-resolved-patch-input');
  });
});

describe('ciReviewExitCode', () => {
  it('never fails when failOn is none', () => {
    expect(ciReviewExitCode(sampleResult(), 'none')).toBe(0);
  });

  it('fails when a finding is at or above the threshold', () => {
    expect(ciReviewExitCode(sampleResult(), 'P1')).toBe(1);
    expect(ciReviewExitCode(sampleResult(), 'P2')).toBe(1);
  });

  it('passes when all findings are below the threshold', () => {
    expect(ciReviewExitCode(sampleResult(), 'P0')).toBe(0);
    const onlyP2 = sampleResult();
    onlyP2.findings = onlyP2.findings.filter(f => f.priority === 'P2');
    expect(ciReviewExitCode(onlyP2, 'P1')).toBe(0);
  });

  it('fails closed with code 2 when review coverage is incomplete', () => {
    const incomplete = sampleResult({
      findings: [],
      reviewStatus: 'incomplete-coverage',
      coverage: { complete: false } as CiReviewResult['coverage'],
    });

    expect(ciReviewExitCode(incomplete, 'none')).toBe(2);
    expect(ciReviewExitCode(incomplete, 'P2')).toBe(2);
  });

  it('allows an explicit API caller to opt out of the incomplete-coverage gate', () => {
    const incomplete = sampleResult({
      findings: [],
      reviewStatus: 'incomplete-coverage',
      coverage: { complete: false } as CiReviewResult['coverage'],
    });

    expect(ciReviewExitCode(incomplete, 'none', false)).toBe(0);
  });
});

describe('formatCiReview sarif', () => {
  it('emits valid SARIF 2.1.0 with one rule per ruleId and priority-mapped levels', () => {
    const sarif = JSON.parse(formatCiReview(sampleResult(), 'sarif', '9.9.9')) as Record<string, any>;
    expect(sarif.version).toBe('2.1.0');
    const run = sarif.runs[0];
    expect(run.tool.driver.name).toBe('codegraph-review');
    expect(run.tool.driver.version).toBe('9.9.9');
    expect(run.tool.driver.rules.map((r: any) => r.id)).toEqual(['review-stale-caller', 'review-fanout']);
    expect(run.results).toHaveLength(2);
    expect(run.results[0].level).toBe('warning');
    expect(run.results[1].level).toBe('note');
    expect(run.results[0].locations[0].physicalLocation.region.startLine).toBe(12);
    expect(run.results[0].partialFingerprints.codegraphFindingId).toBe('review-stale-caller-com.example.Foo#bar');
  });

  it('does not anchor file-less findings to an unrelated changed file', () => {
    const sarif = JSON.parse(formatCiReview(sampleResult(), 'sarif')) as Record<string, any>;
    const fanout = sarif.runs[0].results[1];
    expect(fanout.locations).toEqual([]);
  });
});

describe('formatCiReview markdown', () => {
  it('renders a sticky-comment table with the marker and escaped pipes', () => {
    const markdown = formatCiReview(sampleResult(), 'markdown');
    expect(markdown).toContain(CI_REVIEW_COMMENT_MARKER);
    expect(markdown).toContain('| P1 | `review-stale-caller` | src/app.ts:12 |');
    expect(markdown).toContain('outside this diff \\| may need updating');
  });

  it('reports the hidden-findings count when a min-priority filter dropped some', () => {
    const markdown = formatCiReview(sampleResult({ droppedBelowMinPriority: 3 }), 'markdown');
    expect(markdown).toContain('3 lower-priority finding(s) hidden');
  });
});

describe('filterIgnorableDiff', () => {
  const codeBlock = 'diff --git a/src/app.ts b/src/app.ts\nindex 111..222 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n';
  const docsBlock = 'diff --git a/README.md b/README.md\nindex 333..444 100644\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n';

  it('drops docs blocks and keeps code blocks', () => {
    const { diff, ignoredFiles } = filterIgnorableDiff(docsBlock + codeBlock);
    expect(ignoredFiles).toEqual(['README.md']);
    expect(diff).toContain('a/src/app.ts');
    expect(diff).not.toContain('README.md');
  });

  it('returns an empty diff for docs-only changes', () => {
    const { diff, ignoredFiles } = filterIgnorableDiff(docsBlock);
    expect(diff.trim()).toBe('');
    expect(ignoredFiles).toEqual(['README.md']);
  });

  it('keeps malformed diff blocks so they cannot be silently omitted', () => {
    const malformed = 'diff --git malformed-header\n@@ -1 +1 @@\n-old\n+new\n';
    const result = filterIgnorableDiff(malformed);
    expect(result.ignoredFiles).toEqual([]);
    expect(result.diff).toContain('malformed-header');
  });
});

describe('reviewForCi (temp git repo)', () => {
  async function setupRepo(): Promise<{ repo: string; service: V2QueryService; workspaceId: string }> {
    const repo = tempDir('codegraph-ci-review-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/lib.ts', 'export function libValue(): number { return 1; }\n');
    writeFile(
      repo,
      'src/consumer.ts',
      "import { libValue } from './lib.js';\nexport function doubled(): number { return libValue() * 2; }\n",
    );
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'base');
    const { db } = await openCodeGraphDb(tempDir('codegraph-home-'));
    dbs.push(db);
    const index = await new V2Indexer(db).indexWorkspace({ root: repo });
    return { repo, service: new V2QueryService(db), workspaceId: index.workspaceId };
  }

  it('reviews a committed range and returns structured findings', async () => {
    if (!hasGit()) return;
    const { repo, service, workspaceId } = await setupRepo();
    writeFile(repo, 'src/lib.ts', 'export function libValue(): number { return 42; }\n');
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'change lib');

    const result = await reviewForCi(service, workspaceId, repo, { baseRef: 'HEAD~1' });
    expect(result.changedFiles).toContain('src/lib.ts');
    expect(Array.isArray(result.findings)).toBe(true);
    for (const finding of result.findings) {
      expect(finding.ruleId).toBeTruthy();
      expect(['P0', 'P1', 'P2']).toContain(finding.priority);
    }
    // Formats must render without throwing on real engine output.
    expect(() => JSON.parse(formatCiReview(result, 'sarif'))).not.toThrow();
    expect(formatCiReview(result, 'markdown')).toContain(CI_REVIEW_COMMENT_MARKER);
  });

  it('short-circuits to no-changes on an empty range', async () => {
    if (!hasGit()) return;
    const { repo, service, workspaceId } = await setupRepo();
    const result = await reviewForCi(service, workspaceId, repo, { baseRef: 'HEAD' });
    expect(result.reviewStatus).toBe('no-changes');
    expect(result.findings).toHaveLength(0);
  });

  it('reports docs-only ranges as no-reviewable-changes with zero findings', async () => {
    if (!hasGit()) return;
    const { repo, service, workspaceId } = await setupRepo();
    writeFile(repo, 'README.md', '# updated docs\n');
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'docs only');

    const result = await reviewForCi(service, workspaceId, repo, { baseRef: 'HEAD~1' });
    expect(result.reviewStatus).toBe('no-reviewable-changes');
    expect(result.findings).toHaveLength(0);
    expect(result.ignoredFiles).toEqual(['README.md']);
  });

  it('drops findings below the min-priority filter and counts them', async () => {
    if (!hasGit()) return;
    const { repo, service, workspaceId } = await setupRepo();
    writeFile(repo, 'src/lib.ts', 'export function libValue(): number { return 42; }\n');
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'change lib');

    const all = await reviewForCi(service, workspaceId, repo, { baseRef: 'HEAD~1' });
    const strict = await reviewForCi(service, workspaceId, repo, { baseRef: 'HEAD~1', minPriority: 'P0' });
    expect(strict.findings.every(f => f.priority === 'P0')).toBe(true);
    expect(strict.droppedBelowMinPriority).toBe(all.findings.length - strict.findings.length);
  });

  it('batches every changed file and deduplicates cross-batch findings', async () => {
    if (!hasGit()) return;
    const repo = tempDir('codegraph-ci-review-batches-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    for (let index = 0; index < 5; index += 1) writeFile(repo, `src/file-${index}.ts`, `export const value${index} = 1;\n`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'base');
    for (let index = 0; index < 5; index += 1) writeFile(repo, `src/file-${index}.ts`, `export const value${index} = 2;\n`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'change all files');

    const calls: Array<Record<string, unknown>> = [];
    const service = {
      async query(envelope: { args: Record<string, unknown> }): Promise<unknown> {
        calls.push(envelope.args);
        const batchDiff = String(envelope.args.diff ?? '');
        const files = [...batchDiff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map(match => match[2]);
        const hunkCount = (batchDiff.match(/^@@ /gm) ?? []).length;
        return {
          changedFiles: files,
          lineFocus: Array.from({ length: hunkCount }, () => ({})),
          reviewFindings: [{
            id: 'review-missing-tests',
            priority: 'P1',
            title: 'No likely tests were found',
            why: 'The same cross-batch fact should appear once.',
            confidence: 0.72,
          }],
          metrics: { omittedHunks: 0 },
        };
      },
    };
    const result = await reviewForCi(service as Pick<V2QueryService, 'query'>, 'workspace', repo, {
      baseRef: 'HEAD~1',
      batchSize: 2,
      limit: 2,
    });

    expect(calls).toHaveLength(3);
    expect(calls.map(call => [...String(call.diff).matchAll(/^diff --git /gm)].length)).toEqual([2, 2, 1]);
    expect(result.changedFiles).toHaveLength(5);
    expect(result.findings.filter(finding => finding.id === 'review-missing-tests')).toHaveLength(1);
    expect(result.coverage).toMatchObject({
      complete: true,
      batchCount: 3,
      reviewableFileCount: 5,
      unparsedFileCount: 0,
      graphEligibleFileCount: 5,
      graphResolvedFileCount: 5,
      reviewableHunkCount: 5,
      reviewedHunkCount: 5,
      omittedFiles: [],
      omittedHunks: 0,
    });
  });

  it('returns incomplete coverage when a batch fails instead of dropping the rest silently', async () => {
    if (!hasGit()) return;
    const { repo, workspaceId } = await setupRepo();
    writeFile(repo, 'src/lib.ts', 'export function libValue(): number { return 42; }\n');
    writeFile(repo, 'src/consumer.ts', "import { libValue } from './lib.js';\nexport function doubled(): number { return libValue() * 3; }\n");
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'change two files');

    let callCount = 0;
    const service = {
      async query(envelope: { args: Record<string, unknown> }): Promise<unknown> {
        callCount += 1;
        if (callCount === 2) throw new Error('simulated review batch failure');
        const batchDiff = String(envelope.args.diff ?? '');
        const files = [...batchDiff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map(match => match[2]);
        const hunkCount = (batchDiff.match(/^@@ /gm) ?? []).length;
        return {
          changedFiles: files,
          lineFocus: Array.from({ length: hunkCount }, () => ({})),
          reviewFindings: [],
          metrics: { omittedHunks: 0 },
        };
      },
    };

    const result = await reviewForCi(service as Pick<V2QueryService, 'query'>, 'workspace', repo, {
      baseRef: 'HEAD~1',
      batchSize: 1,
    });

    expect(result.coverage?.complete).toBe(false);
    expect(result.reviewStatus).toBe('incomplete-coverage');
    expect(result.batchFailures).toEqual([{ batch: 2, message: 'simulated review batch failure' }]);
    expect(result.coverage?.batches[1]).toMatchObject({ complete: false, omittedHunks: 1 });
    expect(ciReviewExitCode(result, 'none')).toBe(2);
    expect(formatCiReview(result, 'text')).toContain('batch failures: #2 simulated review batch failure');
  });

  it('keeps internal graph coverage independent from the public response cap', async () => {
    if (!hasGit()) return;
    const repo = tempDir('codegraph-ci-review-cap-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    for (let index = 0; index < 12; index += 1) {
      writeFile(repo, `src/service-${index}.ts`, `export function service${index}(): number { return 1; }\n`);
    }
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'base');
    for (let index = 0; index < 12; index += 1) {
      writeFile(repo, `src/service-${index}.ts`, `export function service${index}(): number { return 2; }\n`);
    }
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'change services');

    const { db } = await openCodeGraphDb(tempDir('codegraph-home-'));
    dbs.push(db);
    const index = await new V2Indexer(db).indexWorkspace({ root: repo });
    const diff = execFileSync('git', ['diff', '--no-renames', '--unified=3', 'HEAD~1...HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    });
    const response = await new V2QueryService(db).query({
      workspaceId: index.workspaceId,
      toolName: 'review_patch',
      args: { diff, outputMode: 'full', limit: 12, maxResponseTokens: 500 },
    }) as {
      changedFiles: string[];
      reviewCoverage: { graphResolvedFileCount: number; omittedGraphFileCount: number };
      metrics: { graphResolvedChangedFileCount: number; omittedGraphFiles: number };
    };

    expect(response.changedFiles).toHaveLength(12);
    expect(response.reviewCoverage).toMatchObject({ graphResolvedFileCount: 12, omittedGraphFileCount: 0 });
    expect(response.metrics).toMatchObject({ graphResolvedChangedFileCount: 12, omittedGraphFiles: 0 });
  });
});
