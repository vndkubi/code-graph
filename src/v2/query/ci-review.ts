/**
 * CI review: run the deterministic review_patch engine over a git ref range
 * and render the findings for CI surfaces — SARIF for GitHub code scanning,
 * markdown for a sticky PR comment, plain text for job logs. No LLM anywhere:
 * every finding is a graph/diff fact with a stable rule id, so the same diff
 * always produces the same report.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { isIgnorableChangedPath } from './ci-test-selection.js';
import { GitClient } from '../infrastructure/git-client.js';
import type { V2QueryService } from './service.js';
import {
  applyReviewManifestBatch,
  addReviewManifestBlocks,
  createReviewManifest,
  reviewManifestCoverage,
  type ReviewFileStatus,
  type ReviewManifest,
  type ReviewManifestBlock,
} from './review-manifest.js';

export type CiReviewFormat = 'json' | 'sarif' | 'markdown' | 'text';
export type CiReviewPriority = 'P0' | 'P1' | 'P2';
export type CiReviewFailOn = CiReviewPriority | 'none';

export interface CiReviewOptions {
  baseRef: string;
  headRef?: string;
  focus?: string;
  /** Maximum files sent to one review_patch call. Default: min(limit, 50). */
  batchSize?: number;
  /** Maximum hunks targeted per review_patch call. Default: 200. */
  maxHunksPerBatch?: number;
  limit?: number;
  /** Drop findings below this priority (P0 strictest). Default: keep all. */
  minPriority?: CiReviewPriority;
  /** Stable caller-provided identity for persisted/replayed review state. */
  reviewId?: string;
  /** Receive immutable manifest snapshots after initialization and each batch. */
  onManifestUpdate?: (manifest: ReviewManifest) => void | Promise<void>;
}

export interface CiReviewBatchCoverage {
  batch: number;
  fileCount: number;
  hunkCount: number;
  graphResolvedFileCount: number;
  reviewedHunkCount: number;
  omittedFiles: string[];
  omittedHunks: number;
  complete: boolean;
}

export interface CiReviewCoverage {
  complete: boolean;
  batchCount: number;
  reviewableFileCount: number;
  unparsedFileCount: number;
  graphEligibleFileCount: number;
  graphResolvedFileCount: number;
  reviewableHunkCount: number;
  reviewedHunkCount: number;
  omittedFiles: string[];
  omittedHunks: number;
  batches: CiReviewBatchCoverage[];
}

export interface CiReviewBatchFailure {
  batch: number;
  message: string;
}

export interface CiReviewFinding {
  /** Instance id from the engine (may embed file/symbol). */
  id: string;
  /** Stable rule id (instance suffixes stripped) — SARIF rules group on this. */
  ruleId: string;
  priority: CiReviewPriority;
  category?: string;
  file?: string;
  line?: number;
  title: string;
  why: string;
  suggestedCheck?: string;
  suggestedFix?: string;
  confidence: number;
  evidence?: unknown;
}

export interface CiReviewResult {
  baseRef: string;
  headRef: string;
  changedFiles: string[];
  /** Changed paths excluded from review (docs, licenses, index artifacts…). */
  ignoredFiles: string[];
  reviewStatus?: string;
  diffStats?: Record<string, unknown>;
  coverage?: CiReviewCoverage;
  /** First-class file/hunk state; no source text is stored here. */
  manifest?: ReviewManifest;
  /** Review-engine failures are reported separately from code findings. */
  batchFailures?: CiReviewBatchFailure[];
  findings: CiReviewFinding[];
  priorityCounts: Record<CiReviewPriority, number>;
  droppedBelowMinPriority: number;
}

const GIT_DIFF_TIMEOUT_MS = 30_000;
const gitClient = new GitClient(GIT_DIFF_TIMEOUT_MS, 64 * 1024 * 1024);

/**
 * Unified diff for merge-base(base, head)..head — `base...head`, the same
 * range a GitHub PR shows. Throws when git cannot answer: a review built from
 * an unknown diff would be a guess.
 */
export async function gitUnifiedDiff(root: string, baseRef: string, headRef = 'HEAD'): Promise<string> {
  return gitClient.runRaw(root, ['diff', '--no-renames', '--unified=3', `${baseRef}...${headRef}`])
    .then(result => result.stdout);
}

async function gitCommit(root: string, ref: string): Promise<string> {
  return gitClient.commit(root, ref);
}

/**
 * Spool git's diff to a short-lived local file while consuming stdout in
 * chunks. Review batches read that file line-by-line, so a very large diff is
 * never duplicated as one giant in-memory string.
 */
async function streamGitDiffToTempFile(root: string, baseRef: string, headRef: string): Promise<{ directory: string; file: string }> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codegraph-review-diff-'));
  const file = path.join(directory, 'diff.patch');
  const output = fs.createWriteStream(file, { encoding: 'utf8' });
  const writeChunk = (chunk: string): Promise<void> => new Promise((resolve, reject) => {
    const onError = (error: Error): void => { output.off('error', onError); reject(error); };
    output.once('error', onError);
    if (output.write(chunk, 'utf8', () => {
      output.off('error', onError);
      resolve();
    })) return;
    output.once('drain', () => {
      output.off('error', onError);
      resolve();
    });
  });
  try {
    await gitClient.runRaw(root, ['diff', '--no-renames', '--unified=3', `${baseRef}...${headRef}`], {
      captureStdout: false,
      onStdoutChunk: writeChunk,
    });
    await new Promise<void>((resolve, reject) => {
      output.once('error', reject);
      output.end(resolve);
    });
    return { directory, file };
  } catch (error) {
    output.destroy();
    await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function forEachDiffBlock(file: string, onBlock: (block: ReviewDiffBlock) => Promise<void>): Promise<void> {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let current: string[] = [];
  try {
    for await (const line of lines) {
      if (line.startsWith('diff --git ') && current.length > 0) {
        await onBlock(parseReviewDiffBlock(current.join('\n') + '\n'));
        current = [];
      }
      current.push(line);
    }
    if (current.length > 0) await onBlock(parseReviewDiffBlock(current.join('\n') + '\n'));
  } finally {
    lines.close();
    input.destroy();
  }
}

function parseReviewDiffBlock(block: string): ReviewDiffBlock {
  return {
    text: block,
    file: /^diff --git a\/(.+?) b\/(.+)$/m.exec(block)?.[2]?.trim(),
    hunkCount: (block.match(/^@@ /gm) ?? []).length,
    deleted: /^\+\+\+ \/dev\/null$/m.test(block),
    added: /^--- \/dev\/null$/m.test(block),
  };
}

function addDiffStats(stats: ReviewDiffStatsAccumulator, block: ReviewDiffBlock): void {
  stats.diffChars += block.text.length;
  stats.hunkCount += block.hunkCount;
  stats.files.add(block.file);
  let inHunk = false;
  for (const line of block.text.split(/\r?\n/)) {
    if (line.startsWith('@@ ')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) stats.addedLineCount += 1;
    if (line.startsWith('-')) stats.removedLineCount += 1;
  }
}

function finishDiffStats(stats: ReviewDiffStatsAccumulator): Record<string, unknown> {
  const changedLineCount = stats.addedLineCount + stats.removedLineCount;
  return {
    fileCount: [...stats.files].filter(Boolean).length,
    hunkCount: stats.hunkCount,
    addedLineCount: stats.addedLineCount,
    removedLineCount: stats.removedLineCount,
    changedLineCount,
    diffChars: stats.diffChars,
    scale: changedLineCount >= 100_000 ? 'huge'
      : changedLineCount >= 20_000 ? 'very-large'
        : changedLineCount >= 2_000 ? 'large'
          : changedLineCount >= 500 ? 'medium'
            : 'small',
  };
}

// Longest-prefix-first so 'review-duplicated-code-existing' wins over
// 'review-duplicated-code'. Anything unknown keeps its full id as the rule.
const RULE_ID_PREFIXES = [
  'review-duplicated-code-existing',
  'review-duplicated-code',
  'review-stale-caller',
  'review-large-class',
  'review-long-method',
  'review-long-param-list',
  'review-dead-code',
  'review-feature-envy',
  'review-secret',
  'review-command-exec',
  'review-broad-catch',
  'review-debug-output',
  'review-removed-assertion',
  'review-sql-concat',
];

export function ruleIdForFinding(id: string): string {
  for (const prefix of RULE_ID_PREFIXES) {
    if (id === prefix || id.startsWith(`${prefix}-`)) return prefix;
  }
  return id;
}

const PRIORITY_RANK: Record<CiReviewPriority, number> = { P0: 0, P1: 1, P2: 2 };

function normalizePriority(value: unknown): CiReviewPriority {
  return value === 'P0' || value === 'P1' || value === 'P2' ? value : 'P2';
}

function emptyResult(
  baseRef: string,
  headRef: string,
  reviewStatus: string,
  ignoredFiles: string[] = [],
  manifest?: ReviewManifest,
): CiReviewResult {
  return {
    baseRef,
    headRef,
    changedFiles: [],
    ignoredFiles,
    reviewStatus,
    ...(manifest ? { manifest } : {}),
    findings: [],
    priorityCounts: { P0: 0, P1: 0, P2: 0 },
    droppedBelowMinPriority: 0,
  };
}

/**
 * Strip per-file diff blocks whose path can never affect reviewable code
 * (docs, licenses, CodeGraph's own artifacts). Without this, a README-only PR
 * earns a P1 "unresolved inputs" finding because markdown is not indexed.
 * A block whose header cannot be parsed is KEPT — over-reviewing is safe,
 * silently skipping code is not.
 */
export function filterIgnorableDiff(diff: string): { diff: string; ignoredFiles: string[] } {
  const blocks = diff.split(/^(?=diff --git )/m);
  const kept: string[] = [];
  const ignoredFiles: string[] = [];
  for (const block of blocks) {
    if (block.trim() === '') continue;
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(block);
    const file = (header?.[2] ?? '').trim();
    if (file !== '' && isIgnorableChangedPath(file)) {
      ignoredFiles.push(file);
      continue;
    }
    kept.push(block);
  }
  return { diff: kept.join(''), ignoredFiles };
}

interface ReviewDiffBlock {
  text: string;
  file?: string;
  hunkCount: number;
  deleted: boolean;
  added: boolean;
}

interface ReviewDiffBatch {
  diff: string;
  blocks: ReviewDiffBlock[];
  hunkCount: number;
}

interface ReviewDiffStatsAccumulator {
  diffChars: number;
  addedLineCount: number;
  removedLineCount: number;
  hunkCount: number;
  files: Set<string | undefined>;
}

function manifestBlocks(blocks: ReviewDiffBlock[]): ReviewManifestBlock[] {
  return blocks.map(block => ({
    path: block.file,
    status: block.deleted ? 'deleted' as ReviewFileStatus : block.added ? 'added' as ReviewFileStatus : 'modified' as ReviewFileStatus,
    hunkCount: block.hunkCount,
  }));
}

function clampBatchSize(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value!)));
}

function findingsFromReviewResponse(response: Record<string, unknown>): CiReviewFinding[] {
  const rawFindings = Array.isArray(response.reviewFindings) ? response.reviewFindings : [];
  return rawFindings
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
    .map(f => {
      const id = String(f.id ?? 'review-finding');
      return {
        id,
        ruleId: ruleIdForFinding(id),
        priority: normalizePriority(f.priority),
        category: typeof f.category === 'string' ? f.category : undefined,
        file: typeof f.file === 'string' ? f.file : undefined,
        line: typeof f.line === 'number' && Number.isFinite(f.line) ? f.line : undefined,
        title: String(f.title ?? id),
        why: String(f.why ?? ''),
        suggestedCheck: typeof f.suggestedCheck === 'string' ? f.suggestedCheck : undefined,
        suggestedFix: typeof f.suggestedFix === 'string' ? f.suggestedFix : undefined,
        confidence: typeof f.confidence === 'number' ? f.confidence : 0.5,
        evidence: f.evidence,
      };
    });
}

function uniqueFindings(findings: CiReviewFinding[]): CiReviewFinding[] {
  const byId = new Map<string, CiReviewFinding>();
  for (const finding of findings) {
    const current = byId.get(finding.id);
    if (!current
      || PRIORITY_RANK[finding.priority] < PRIORITY_RANK[current.priority]
      || (finding.priority === current.priority && finding.confidence > current.confidence)) {
      byId.set(finding.id, finding);
    }
  }
  return [...byId.values()]
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.confidence - a.confidence || a.id.localeCompare(b.id));
}

/**
 * Run the review engine over `baseRef...headRef`. The workspace must already
 * be indexed at the head state (`workspaceId` from V2Indexer.indexWorkspace).
 */
export async function reviewForCi(
  service: Pick<V2QueryService, 'query'>,
  workspaceId: string,
  root: string,
  options: CiReviewOptions,
): Promise<CiReviewResult> {
  const headRef = options.headRef ?? 'HEAD';
  const baseSha = await gitCommit(root, options.baseRef);
  const headSha = await gitCommit(root, headRef);
  const requestedLimit = clampBatchSize(options.limit, 50, 200);
  const batchSize = clampBatchSize(options.batchSize, Math.min(requestedLimit, 50), 50);
  const maxHunksPerBatch = clampBatchSize(options.maxHunksPerBatch, 200, 200);
  let manifest = createReviewManifest(baseSha, headSha, [], options.reviewId);
  await options.onManifestUpdate?.(manifest);
  const blocks: ReviewDiffBlock[] = [];
  const ignoredFiles: string[] = [];
  const stats: ReviewDiffStatsAccumulator = {
    diffChars: 0,
    addedLineCount: 0,
    removedLineCount: 0,
    hunkCount: 0,
    files: new Set(),
  };
  const allFindings: CiReviewFinding[] = [];
  const batchCoverage: CiReviewBatchCoverage[] = [];
  const batchReviewStatuses: string[] = [];
  const batchFailures: CiReviewBatchFailure[] = [];
  let pendingBlocks: ReviewDiffBlock[] = [];
  let pendingHunks = 0;

  const processBatch = async (batch: ReviewDiffBatch): Promise<void> => {
    const index = batchCoverage.length;
    manifest = addReviewManifestBlocks(manifest, manifestBlocks(batch.blocks));
    await options.onManifestUpdate?.(manifest);
    const batchLimit = Math.min(200, Math.max(requestedLimit, batch.blocks.length, batch.hunkCount));
    const expectedGraphFiles = batch.blocks
      .filter(block => !block.deleted)
      .map(block => block.file)
      .filter((file): file is string => Boolean(file));
    const unparsedFiles = batch.blocks
      .map((block, blockIndex) => block.file ? undefined : `<unparsed-diff-block:${index + 1}.${blockIndex + 1}>`)
      .filter((file): file is string => Boolean(file));

    try {
      const response = await service.query({
        workspaceId,
        toolName: 'review_patch',
        args: {
          diff: batch.diff,
          focus: options.focus ?? 'general',
          limit: batchLimit,
          outputMode: 'full',
        },
      }) as Record<string, unknown>;
      allFindings.push(...findingsFromReviewResponse(response));
      if (typeof response.reviewStatus === 'string') batchReviewStatuses.push(response.reviewStatus);

      const responseChangedFiles = Array.isArray(response.changedFiles) ? response.changedFiles.map(String) : [];
      const metrics = typeof response.metrics === 'object' && response.metrics !== null
        ? response.metrics as Record<string, unknown>
        : {};
      const omittedHunks = Math.max(0, Number(metrics.omittedHunks ?? Math.max(0, batch.hunkCount - (Array.isArray(response.lineFocus) ? response.lineFocus.length : 0))));
      const responseFileSet = new Set(responseChangedFiles);
      const omittedFiles = [
        ...expectedGraphFiles.filter(file => !responseFileSet.has(file)),
        ...unparsedFiles,
      ];
      const omittedGraphFiles = omittedFiles.filter(file => !file.startsWith('<unparsed-'));
      batchCoverage.push({
        batch: index + 1,
        fileCount: batch.blocks.length,
        hunkCount: batch.hunkCount,
        graphResolvedFileCount: Math.max(0, expectedGraphFiles.length - omittedGraphFiles.length),
        reviewedHunkCount: Math.max(0, batch.hunkCount - omittedHunks),
        omittedFiles,
        omittedHunks,
        complete: omittedFiles.length === 0 && omittedHunks === 0,
      });
      manifest = applyReviewManifestBatch(manifest, {
        blocks: manifestBlocks(batch.blocks),
        resolvedFiles: responseChangedFiles,
        complete: omittedFiles.length === 0 && omittedHunks === 0,
      });
      await options.onManifestUpdate?.(manifest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      batchFailures.push({ batch: index + 1, message: message.slice(0, 500) });
      batchCoverage.push({
        batch: index + 1,
        fileCount: batch.blocks.length,
        hunkCount: batch.hunkCount,
        graphResolvedFileCount: 0,
        reviewedHunkCount: 0,
        omittedFiles: [...expectedGraphFiles, ...unparsedFiles],
        omittedHunks: batch.hunkCount,
        complete: false,
      });
      manifest = applyReviewManifestBatch(manifest, {
        blocks: manifestBlocks(batch.blocks),
        complete: false,
        failed: true,
      });
      await options.onManifestUpdate?.(manifest);
    }
  };

  const flushBatch = async (): Promise<void> => {
    if (pendingBlocks.length === 0) return;
    const batch: ReviewDiffBatch = {
      diff: pendingBlocks.map(block => block.text).join(''),
      blocks: pendingBlocks,
      hunkCount: pendingHunks,
    };
    pendingBlocks = [];
    pendingHunks = 0;
    await processBatch(batch);
  };

  const streamed = await streamGitDiffToTempFile(root, options.baseRef, headRef);
  try {
    await forEachDiffBlock(streamed.file, async block => {
      if (block.file && isIgnorableChangedPath(block.file)) {
        ignoredFiles.push(block.file);
        return;
      }
      addDiffStats(stats, block);
      blocks.push(block);
      if (pendingBlocks.length > 0 && (pendingBlocks.length >= batchSize || pendingHunks + block.hunkCount > maxHunksPerBatch)) {
        await flushBatch();
      }
      pendingBlocks.push(block);
      pendingHunks += block.hunkCount;
    });
    await flushBatch();
  } finally {
    await fs.promises.rm(streamed.directory, { recursive: true, force: true }).catch(() => undefined);
  }

  if (blocks.length === 0) {
    return emptyResult(
      options.baseRef,
      headRef,
      ignoredFiles.length > 0 ? 'no-reviewable-changes' : 'no-changes',
      [...new Set(ignoredFiles)],
      manifest,
    );
  }

  const all = uniqueFindings(allFindings);

  const maxRank = PRIORITY_RANK[options.minPriority ?? 'P2'];
  const findings = all.filter(f => PRIORITY_RANK[f.priority] <= maxRank);
  const priorityCounts: Record<CiReviewPriority, number> = { P0: 0, P1: 0, P2: 0 };
  for (const finding of findings) priorityCounts[finding.priority] += 1;
  const changedFiles = [...new Set(blocks.map(block => block.file).filter((file): file is string => Boolean(file)))];
  const unparsedFileCount = blocks.filter(block => !block.file).length;
  const manifestCoverage = reviewManifestCoverage(manifest);
  const omittedFiles = [...new Set(manifestCoverage.omittedFiles)];
  const omittedHunks = manifestCoverage.omittedHunks;
  const coverage: CiReviewCoverage = {
    complete: manifestCoverage.complete,
    batchCount: batchCoverage.length,
    reviewableFileCount: blocks.length,
    unparsedFileCount,
    graphEligibleFileCount: manifestCoverage.graphEligibleFileCount,
    graphResolvedFileCount: manifestCoverage.graphResolvedFileCount,
    reviewableHunkCount: manifestCoverage.reviewableHunkCount,
    reviewedHunkCount: manifestCoverage.reviewedHunkCount,
    omittedFiles,
    omittedHunks,
    batches: batchCoverage,
  };
  const reviewStatus = !coverage.complete
    ? 'incomplete-coverage'
    : batchReviewStatuses.includes('blocked') || all.some(finding => finding.priority === 'P0')
      ? 'blocked'
      : all.some(finding => finding.priority === 'P1')
        ? 'needs-attention'
        : 'ready-for-review';

  return {
    baseRef: options.baseRef,
    headRef,
    changedFiles,
    ignoredFiles,
    reviewStatus,
    diffStats: finishDiffStats(stats),
    coverage,
    manifest,
    ...(batchFailures.length > 0 ? { batchFailures } : {}),
    findings,
    priorityCounts,
    droppedBelowMinPriority: all.length - findings.length,
  };
}

/**
 * Exit code for a CI gate.
 *
 * Coverage is a correctness precondition, not a finding threshold. A review
 * that did not inspect every reviewable hunk must never pass as a clean review
 * merely because it produced no findings (or because `failOn` is `none`).
 * Code 2 is reserved for this incomplete-evidence state; callers that have a
 * separate policy can explicitly opt out via the third argument.
 */
export function ciReviewExitCode(
  result: CiReviewResult,
  failOn: CiReviewFailOn,
  failOnIncompleteCoverage = true,
): number {
  if (failOnIncompleteCoverage && result.coverage?.complete === false) return 2;
  if (failOn === 'none') return 0;
  const threshold = PRIORITY_RANK[failOn];
  return result.findings.some(f => PRIORITY_RANK[f.priority] <= threshold) ? 1 : 0;
}

const SARIF_LEVEL: Record<CiReviewPriority, string> = { P0: 'error', P1: 'warning', P2: 'note' };

export function formatCiReview(result: CiReviewResult, format: CiReviewFormat, toolVersion = '0.0.0'): string {
  switch (format) {
    case 'json':
      return JSON.stringify(result, null, 2);
    case 'sarif':
      return JSON.stringify(toSarif(result, toolVersion), null, 2);
    case 'markdown':
      return toMarkdown(result);
    case 'text':
      return toText(result);
  }
}

function toSarif(result: CiReviewResult, toolVersion: string): Record<string, unknown> {
  const rules = new Map<string, Record<string, unknown>>();
  for (const finding of result.findings) {
    if (rules.has(finding.ruleId)) continue;
    rules.set(finding.ruleId, {
      id: finding.ruleId,
      name: finding.ruleId,
      shortDescription: { text: finding.title },
      helpUri: 'https://github.com/vndkubi/code-graph#codegraph-review',
      defaultConfiguration: { level: SARIF_LEVEL[finding.priority] },
      properties: finding.category ? { category: finding.category } : {},
    });
  }
  const results = result.findings.map(finding => {
    const file = finding.file;
    const message = [
      finding.title,
      finding.why,
      finding.suggestedCheck ? `Check: ${finding.suggestedCheck}` : undefined,
      finding.suggestedFix ? `Fix: ${finding.suggestedFix}` : undefined,
    ].filter(Boolean).join(' — ');
    return {
      ruleId: finding.ruleId,
      level: SARIF_LEVEL[finding.priority],
      message: { text: message },
      // Do not attach a finding with no source location to an unrelated
      // changed file. SARIF permits a result without locations, and the
      // fingerprint/message still make the finding actionable without a
      // misleading code-navigation target.
      locations: file
        ? [{
          physicalLocation: {
            artifactLocation: { uri: file.replace(/\\/g, '/') },
            region: { startLine: finding.line && finding.line > 0 ? finding.line : 1 },
          },
        }]
        : [],
      partialFingerprints: { codegraphFindingId: finding.id },
      properties: { priority: finding.priority, confidence: finding.confidence },
    };
  });
  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'codegraph-review',
          informationUri: 'https://github.com/vndkubi/code-graph',
          version: toolVersion,
          rules: [...rules.values()],
        },
      },
      results,
    }],
  };
}

/** Marker used to find and update the sticky PR comment in place. */
export const CI_REVIEW_COMMENT_MARKER = '<!-- codegraph-review -->';

function toMarkdown(result: CiReviewResult): string {
  const lines: string[] = [];
  const total = result.findings.length;
  lines.push(`### CodeGraph review — ${total === 0 ? 'no findings' : `${total} finding(s)`}`);
  lines.push('');
  lines.push(`\`${result.baseRef}...${result.headRef}\` · ${result.changedFiles.length} changed file(s) · deterministic graph facts, no LLM`);
  if (result.coverage) {
    lines.push(`Coverage: ${result.coverage.reviewedHunkCount}/${result.coverage.reviewableHunkCount} hunks, ${result.coverage.graphResolvedFileCount}/${result.coverage.graphEligibleFileCount} graph-resolved files, ${result.coverage.batchCount} batch(es).`);
    if (!result.coverage.complete) {
      lines.push('> ⚠️ Review coverage is incomplete; do not treat this report as full-PR evidence.');
    }
  }
  if (result.batchFailures && result.batchFailures.length > 0) {
    lines.push(`Batch failures: ${result.batchFailures.map(failure => `#${failure.batch} ${escapeMarkdownCell(failure.message)}`).join('; ')}`);
  }
  if (total > 0) {
    lines.push('');
    lines.push('| Priority | Rule | Location | Finding |');
    lines.push('|---|---|---|---|');
    for (const finding of result.findings) {
      const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}` : '—';
      const detail = `**${escapeMarkdownCell(finding.title)}** — ${escapeMarkdownCell(finding.why)}`;
      lines.push(`| ${finding.priority} | \`${finding.ruleId}\` | ${escapeMarkdownCell(location)} | ${detail} |`);
    }
  }
  if (result.droppedBelowMinPriority > 0) {
    lines.push('');
    lines.push(`<sub>${result.droppedBelowMinPriority} lower-priority finding(s) hidden by the min-priority filter.</sub>`);
  }
  lines.push('');
  lines.push(CI_REVIEW_COMMENT_MARKER);
  return lines.join('\n');
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function toText(result: CiReviewResult): string {
  const lines: string[] = [];
  lines.push(`codegraph review ${result.baseRef}...${result.headRef}: ${result.findings.length} finding(s) across ${result.changedFiles.length} changed file(s)`);
  if (result.coverage) {
    lines.push(`coverage: ${result.coverage.reviewedHunkCount}/${result.coverage.reviewableHunkCount} hunks, ${result.coverage.graphResolvedFileCount}/${result.coverage.graphEligibleFileCount} graph-resolved files, ${result.coverage.batchCount} batch(es), complete=${result.coverage.complete}`);
  }
  if (result.batchFailures && result.batchFailures.length > 0) {
    lines.push(`batch failures: ${result.batchFailures.map(failure => `#${failure.batch} ${failure.message}`).join('; ')}`);
  }
  for (const finding of result.findings) {
    const location = finding.file ? ` [${finding.file}${finding.line ? `:${finding.line}` : ''}]` : '';
    lines.push(`${finding.priority} ${finding.ruleId}${location}: ${finding.title}`);
    lines.push(`   ${finding.why}`);
    if (finding.suggestedCheck) lines.push(`   check: ${finding.suggestedCheck}`);
  }
  return lines.join('\n');
}
