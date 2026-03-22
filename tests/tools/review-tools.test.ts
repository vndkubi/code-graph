import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { FileIndexer } from '../../src/index/file-indexer.js';
import { reviewChangedFiles } from '../../src/tools/review-changed-files.js';
import { getPrImpactSummary } from '../../src/tools/get-pr-impact-summary.js';
import { checkArchitecturalDelta } from '../../src/tools/check-architectural-delta.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TS_FIXTURE = path.resolve(__dirname, '../fixtures/ts-project');
const tempDirs: string[] = [];

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function createTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-code-graph-review-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });

  fs.writeFileSync(
    path.join(dir, 'src/order-controller.ts'),
    "export class OrderController {\n  handle() { return 'ok'; }\n}\n",
  );
  fs.writeFileSync(
    path.join(dir, 'src/order-service.ts'),
    "export class OrderService {\n  process() { return 'ok'; }\n}\n",
  );

  runGit(dir, ['init']);
  runGit(dir, ['config', 'user.email', 'codex@example.com']);
  runGit(dir, ['config', 'user.name', 'Codex']);
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'base']);

  fs.writeFileSync(
    path.join(dir, 'src/order-service.ts'),
    "import { OrderController } from './order-controller';\nexport class OrderService {\n  process() {\n    const controller = new OrderController();\n    return controller.handle();\n  }\n}\n",
  );

  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Review Tools', () => {
  let tsIndexer: FileIndexer;

  beforeAll(async () => {
    tsIndexer = new FileIndexer({ rootDir: TS_FIXTURE, cacheTtlMs: 60_000 });
    await tsIndexer.ensureIndexed();
  });

  it('should review explicit changed files', async () => {
    const result = await reviewChangedFiles({
      files: ['src/order-service.ts'],
      maxDepth: 4,
      includeUntracked: true,
    }, tsIndexer);

    expect(result.changedFiles).toContain('src/order-service.ts');
    expect(result.reviewOrder.length).toBeGreaterThan(0);
    expect(result.fileReviews[0]?.file).toBe('src/order-service.ts');
  });

  it('should summarize PR impact for explicit files', async () => {
    const result = await getPrImpactSummary({
      files: ['src/order-service.ts'],
      topN: 5,
      maxDepth: 4,
      includeUntracked: true,
    }, tsIndexer);

    expect(result.totals.changedFiles).toBe(1);
    expect(result.topReviewTargets.length).toBeGreaterThan(0);
  });

  it('should detect likely new layer violations against HEAD', async () => {
    const repoDir = createTempRepo();
    const indexer = new FileIndexer({ rootDir: repoDir, cacheTtlMs: 60_000 });
    await indexer.ensureIndexed();

    const delta = await checkArchitecturalDelta({
      baseRef: 'HEAD',
      includeUntracked: false,
      files: ['src/order-service.ts'],
    }, indexer);
    expect(delta.currentViolations.length).toBeGreaterThan(0);
    expect(delta.likelyNewViolations.length).toBeGreaterThan(0);

    const summary = await getPrImpactSummary({
      baseRef: 'HEAD',
      includeUntracked: false,
      topN: 5,
    }, indexer);
    expect(summary.changedFiles).toContain('src/order-service.ts');
    expect(summary.totals.likelyNewLayerViolations).toBeGreaterThan(0);
  });
});
