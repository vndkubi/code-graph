import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodeGraphDb } from '../../src/v2/storage/database.js';
import { openCodeGraphDb } from '../../src/v2/storage/database.js';
import { V2Indexer } from '../../src/v2/index/indexer.js';
import { V2QueryService } from '../../src/v2/query/service.js';

const tempDirs: string[] = [];
const dbs: CodeGraphDb[] = [];

afterEach(async () => {
  for (const db of dbs.splice(0)) await db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('review_patch: graph-only findings', () => {
  it('flags stale callers, long methods, too many params, and dead private code without a stale missing-tests flag', async () => {
    const repo = tempDir('codegraph-review-smells-');

    // 85 body statements push the method well past the long-method threshold
    // (80 lines) regardless of the exact end_line the analyzer reports.
    const longBody = Array.from({ length: 85 }, (_, i) => `        total += ${i + 1};`).join('\n');
    const stringUtilsLines = [
      /* 1  */ 'package com.example.util;',
      /* 2  */ '',
      /* 3  */ 'public class StringUtils {',
      /* 4  */ '',
      /* 5  */ '    private String buildLabel(String name, String prefix, String suffix, String separator, String fallback, boolean upperCase) {',
      /* 6  */ '        return name;',
      /* 7  */ '    }',
      /* 8  */ '',
      /* 9  */ '    @PostConstruct',
      /* 10 */ '    private void legacyUnusedCleanup() {',
      /* 11 */ '        System.out.println("noop");',
      /* 12 */ '    }',
      /* 13 */ '',
      /* 14 */ '    public String publicHelper() {',
      /* 15 */ '        return "unused-but-public";',
      /* 16 */ '    }',
      /* 17 */ '',
      /* 18 */ '    public int longRunningMethod() {',
      /* 19 */ '        int total = 0;',
      longBody,
      '        return total;',
      '    }',
      '}',
      '',
    ].join('\n');
    writeFile(repo, 'src/main/java/com/example/util/StringUtils.java', stringUtilsLines);

    writeFile(repo, 'src/main/java/com/example/util/StringUtilsCaller.java', `package com.example.util;
import com.example.util.StringUtils;

public class StringUtilsCaller {
    private final StringUtils utils = new StringUtils();

    public int invoke() {
        return utils.longRunningMethod();
    }
}
`);

    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const diff = [
      'diff --git a/src/main/java/com/example/util/StringUtils.java b/src/main/java/com/example/util/StringUtils.java',
      '--- a/src/main/java/com/example/util/StringUtils.java',
      '+++ b/src/main/java/com/example/util/StringUtils.java',
      '@@ -6,1 +6,1 @@',
      '-        return name;',
      '+        return name; // formatted',
      '@@ -11,1 +11,1 @@',
      '-        System.out.println("noop");',
      '+        System.out.println("noop cleanup");',
      '@@ -15,1 +15,1 @@',
      '-        return "unused-but-public";',
      '+        return "unused-but-public"; // no behavior change',
      '@@ -19,1 +19,1 @@',
      '-        int total = 0;',
      '+        int total = 1;',
    ].join('\n');

    const review = await queries.query({
      workspaceId: indexed.workspaceId,
      toolName: 'review_patch',
      args: {
        files: ['src/main/java/com/example/util/StringUtils.java'],
        diff,
        limit: 50,
        outputMode: 'full', // this fixture trips more findings than the compact-mode cap keeps
      },
    }) as {
      reviewFindings: Array<{ id: string; priority: string; evidence?: unknown }>;
      testsLikelyRelevant: Array<{ file: string }>;
    };

    const findingIds = review.reviewFindings.map(finding => finding.id);

    // Too many params (buildLabel has 6, via parameter_types_json for Java).
    expect(findingIds.some(id => id.startsWith('review-long-param-list-') && id.includes('buildLabel'))).toBe(true);

    // Dead code: buildLabel is private, unannotated, and never called.
    expect(findingIds.some(id => id.startsWith('review-dead-code-') && id.includes('buildLabel'))).toBe(true);

    // Dead code exclusions: annotated private method and public method must
    // not be flagged even though neither has a static caller.
    expect(findingIds.some(id => id.startsWith('review-dead-code-') && id.includes('legacyUnusedCleanup'))).toBe(false);
    expect(findingIds.some(id => id.startsWith('review-dead-code-') && id.includes('publicHelper'))).toBe(false);

    // Long method: longRunningMethod spans well over 80 lines.
    expect(findingIds.some(id => id.startsWith('review-long-method-') && id.includes('longRunningMethod'))).toBe(true);

    // Stale caller: StringUtilsCaller.invoke() calls longRunningMethod but
    // its file is not part of this diff.
    const staleCallerFinding = review.reviewFindings.find(finding => finding.id.startsWith('review-stale-caller-') && finding.id.includes('longRunningMethod'));
    expect(staleCallerFinding).toBeDefined();
    expect(JSON.stringify(staleCallerFinding?.evidence)).toContain('StringUtilsCaller.java');
  });

  it('drops the stale no-tests-found flag once a graph-reachable test is known', async () => {
    const repo = tempDir('codegraph-review-tests-fix-');
    writeFile(repo, 'src/orderService.ts', `export function createOrder(id: string): string {
  return id;
}
`);
    writeFile(repo, 'src/orderService.test.ts', `import { createOrder } from './orderService';

test('creates order', () => {
  createOrder('1');
});
`);
    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const diff = [
      'diff --git a/src/orderService.ts b/src/orderService.ts',
      '--- a/src/orderService.ts',
      '+++ b/src/orderService.ts',
      '@@ -1,3 +1,3 @@',
      '-export function createOrder(id: string): string {',
      '+export function createOrder(id: string): string {',
      '   return id;',
      ' }',
    ].join('\n');

    const review = await queries.query({
      workspaceId: indexed.workspaceId,
      toolName: 'review_patch',
      args: { files: ['src/orderService.ts'], diff, limit: 50 },
    }) as {
      reviewFindings: Array<{ id: string }>;
      testsLikelyRelevant: Array<{ file: string }>;
    };

    expect(review.testsLikelyRelevant.some(test => test.file.endsWith('orderService.test.ts'))).toBe(true);
    expect(review.reviewFindings.some(finding => finding.id === 'review-missing-tests')).toBe(false);
  });

  it('counts TS/JS parameters from the signature when parameter_types_json is empty', async () => {
    const repo = tempDir('codegraph-review-ts-params-');
    writeFile(repo, 'src/widget.ts', `export function buildWidgetConfig(name: string, width: number, height: number, color: string, border: boolean, padding: number): Record<string, unknown> {
  return { name, width, height, color, border, padding };
}
`);
    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const diff = [
      'diff --git a/src/widget.ts b/src/widget.ts',
      '--- a/src/widget.ts',
      '+++ b/src/widget.ts',
      '@@ -1,3 +1,3 @@',
      '-export function buildWidgetConfig(name: string, width: number, height: number, color: string, border: boolean, padding: number): Record<string, unknown> {',
      '+export function buildWidgetConfig(name: string, width: number, height: number, color: string, border: boolean, padding: number): Record<string, unknown> {',
      '   return { name, width, height, color, border, padding };',
      ' }',
    ].join('\n');

    const review = await queries.query({
      workspaceId: indexed.workspaceId,
      toolName: 'review_patch',
      args: { files: ['src/widget.ts'], diff, limit: 50 },
    }) as { reviewFindings: Array<{ id: string; title: string }> };

    const finding = review.reviewFindings.find(f => f.id.startsWith('review-long-param-list-') && f.id.includes('buildWidgetConfig'));
    expect(finding).toBeDefined();
    expect(finding?.title).toContain('6 params');
  });
});

async function openDb(root: string): Promise<{ db: CodeGraphDb }> {
  const opened = await openCodeGraphDb(root);
  dbs.push(opened.db);
  return opened;
}

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
