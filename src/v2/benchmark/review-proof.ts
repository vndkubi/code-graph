import fs from 'node:fs';
import path from 'node:path';
import type { CodeGraphDb } from '../storage/database.js';
import { classifyFile } from '../index/file-role.js';
import { scanManifest } from '../index/manifest.js';
import { V2Indexer } from '../index/indexer.js';
import { V2QueryService } from '../query/service.js';

export interface ReviewProofTask {
  id: string;
  title: string;
  files?: string[];
  symbols?: string[];
  diff?: string;
  focus?: 'general' | 'bug-risk' | 'api-contract' | 'tests' | 'security';
  baselineSearchTerms?: string[];
  expectedContains?: string[];
  expectedFiles?: string[];
  limit?: number;
}

export interface ReviewProofResult {
  root: string;
  workspaceId: string;
  snapshotId: string;
  tokenModel: {
    estimator: string;
    inputDefinition: string;
    outputDefinition: string;
    actualModelUsage: boolean;
  };
  totals: {
    tasks: number;
    baselineCorrect: number;
    mcpCorrect: number;
    qualityMaintained: boolean;
    baselineEstimatedInputTokens: number;
    mcpEstimatedInputTokens: number;
    inputTokenSavingPct: number;
    baselineEstimatedOutputTokens: number;
    mcpEstimatedOutputTokens: number;
    outputTokenSavingPct: number;
    baselineFilesOpened: number;
    mcpToolCalls: number;
    fileOpenReductionPct: number;
    reviewPatchP95Ms: number;
  };
  tasks: ReviewProofTaskResult[];
}

export interface ReviewProofTaskResult {
  id: string;
  title: string;
  correct: boolean;
  qualityMaintained: boolean;
  missingExpected: string[];
  missingExpectedFiles: string[];
  inputTokenSavingPct: number;
  outputTokenSavingPct: number;
  fileOpenReductionPct: number;
  baseline: BaselineReviewProofResult;
  mcp: McpReviewProofResult;
}

interface BaselineReviewProofResult {
  searchTerms: string[];
  filesOpened: number;
  matchedFiles: string[];
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  correct: boolean;
}

interface McpReviewProofResult {
  toolName: 'review_patch';
  durationMs: number;
  responseChars: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  toolCalls: number;
  reviewStatus?: string;
  changedFiles: string[];
  findingCount: number;
  correct: boolean;
}

interface BaselineManifestFile {
  absPath: string;
  relPath: string;
  parseable: boolean;
}

interface BaselineManifest {
  root: string;
  files: BaselineManifestFile[];
}

const BASELINE_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const BASELINE_SKIP_DIRS = new Set([
  '.git',
  '.idea',
  '.vscode',
  'node_modules',
  'target',
  'build',
  'dist',
  'bin',
  'obj',
  '.gradle',
  '__pycache__',
]);

export function loadReviewProofTasks(tasksFile?: string): ReviewProofTask[] {
  if (!tasksFile) return defaultReviewProofTasks();
  const parsed = JSON.parse(fs.readFileSync(tasksFile, 'utf-8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`Review proof task file must contain a JSON array: ${tasksFile}`);
  return parsed.map((task, index) => normalizeReviewProofTask(task, index));
}

export function deriveReviewProofTasks(root: string, options: { limit?: number } = {}): ReviewProofTask[] {
  const limit = Math.max(1, Math.min(options.limit ?? 5, 25));
  const manifest = scanManifest(root);
  const candidates = manifest.files
    .filter(file => file.parseable && file.language && file.role !== 'test_source' && file.role !== 'mock_source')
    .map(file => ({
      file,
      score: reviewTaskFileScore(file.relPath, file.language, file.role),
    }))
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.file.relPath.localeCompare(b.file.relPath));

  const tasks: ReviewProofTask[] = [];
  for (const candidate of candidates) {
    if (tasks.length >= limit) break;
    const basename = path.basename(candidate.file.relPath, path.extname(candidate.file.relPath));
    const displayName = displayNameForFileBasename(basename);
    tasks.push({
      id: `auto-review-${tasks.length + 1}-${slugify(displayName)}`,
      title: `Review a proposed patch touching ${displayName}.`,
      files: [candidate.file.relPath],
      symbols: [displayName],
      diff: syntheticReviewDiff(candidate.file.relPath, displayName),
      focus: 'general',
      baselineSearchTerms: baselineTermsForFile(displayName, basename),
      expectedContains: [displayName],
      expectedFiles: [candidate.file.relPath],
      limit: 50,
    });
  }

  return tasks.length > 0 ? tasks : defaultReviewProofTasks();
}

export async function runReviewProofEval(
  db: CodeGraphDb,
  root: string,
  tasks: ReviewProofTask[],
  options: { skipIndex?: boolean } = {},
): Promise<ReviewProofResult> {
  const indexer = new V2Indexer(db);
  const workspace = options.skipIndex ? await indexer.registerWorkspace(root) : undefined;
  const index = options.skipIndex && workspace?.currentSnapshotId
    ? {
      workspaceId: workspace.workspaceId,
      snapshotId: workspace.currentSnapshotId,
    }
    : await indexer.indexWorkspace({ root });
  const queryService = new V2QueryService(db);
  const normalizedRoot = path.resolve(root);
  const manifest = scanBaselineManifest(normalizedRoot);
  const results: ReviewProofTaskResult[] = [];

  for (const task of tasks) {
    const baseline = runBaselineReviewProof(manifest, task);
    const mcp = await runMcpReviewProof(queryService, index.workspaceId, task);
    const missingExpected = (task.expectedContains ?? [])
      .filter(expected => !mcp.evidence.toLowerCase().includes(expected.toLowerCase()));
    const missingExpectedFiles = (task.expectedFiles ?? [])
      .filter(expectedFile => !mcp.changedFiles.some(file => pathMatchesExpected(file, expectedFile))
        && !mcp.evidence.toLowerCase().includes(expectedFile.replace(/\\/g, '/').toLowerCase()));
    const mcpCorrect = missingExpected.length === 0 && missingExpectedFiles.length === 0;

    results.push({
      id: task.id,
      title: task.title,
      correct: mcpCorrect,
      qualityMaintained: !baseline.correct || mcpCorrect,
      missingExpected,
      missingExpectedFiles,
      inputTokenSavingPct: savingPct(baseline.estimatedInputTokens, mcp.estimatedInputTokens),
      outputTokenSavingPct: savingPct(baseline.estimatedOutputTokens, mcp.estimatedOutputTokens),
      fileOpenReductionPct: savingPct(baseline.filesOpened, mcp.toolCalls),
      baseline,
      mcp: {
        toolName: 'review_patch',
        durationMs: mcp.durationMs,
        responseChars: mcp.responseChars,
        estimatedInputTokens: mcp.estimatedInputTokens,
        estimatedOutputTokens: mcp.estimatedOutputTokens,
        toolCalls: mcp.toolCalls,
        reviewStatus: mcp.reviewStatus,
        changedFiles: mcp.changedFiles,
        findingCount: mcp.findingCount,
        correct: mcpCorrect,
      },
    });
  }

  const baselineEstimatedInputTokens = results.reduce((sum, result) => sum + result.baseline.estimatedInputTokens, 0);
  const mcpEstimatedInputTokens = results.reduce((sum, result) => sum + result.mcp.estimatedInputTokens, 0);
  const baselineEstimatedOutputTokens = results.reduce((sum, result) => sum + result.baseline.estimatedOutputTokens, 0);
  const mcpEstimatedOutputTokens = results.reduce((sum, result) => sum + result.mcp.estimatedOutputTokens, 0);
  const baselineFilesOpened = results.reduce((sum, result) => sum + result.baseline.filesOpened, 0);
  const mcpToolCalls = results.reduce((sum, result) => sum + result.mcp.toolCalls, 0);
  const baselineCorrect = results.filter(result => result.baseline.correct).length;
  const mcpCorrect = results.filter(result => result.correct).length;

  return {
    root: normalizedRoot,
    workspaceId: index.workspaceId,
    snapshotId: index.snapshotId,
    tokenModel: {
      estimator: 'ceil(character_count / 4)',
      inputDefinition: 'Review request plus diff and retrieved evidence that would be added to an agent/model context.',
      outputDefinition: 'Deterministic benchmark summary size, not real LLM completion usage.',
      actualModelUsage: false,
    },
    totals: {
      tasks: results.length,
      baselineCorrect,
      mcpCorrect,
      qualityMaintained: mcpCorrect >= baselineCorrect,
      baselineEstimatedInputTokens,
      mcpEstimatedInputTokens,
      inputTokenSavingPct: savingPct(baselineEstimatedInputTokens, mcpEstimatedInputTokens),
      baselineEstimatedOutputTokens,
      mcpEstimatedOutputTokens,
      outputTokenSavingPct: savingPct(baselineEstimatedOutputTokens, mcpEstimatedOutputTokens),
      baselineFilesOpened,
      mcpToolCalls,
      fileOpenReductionPct: savingPct(baselineFilesOpened, mcpToolCalls),
      reviewPatchP95Ms: percentile(results.map(result => result.mcp.durationMs), 0.95),
    },
    tasks: results,
  };
}

function runBaselineReviewProof(manifest: BaselineManifest, task: ReviewProofTask): BaselineReviewProofResult {
  const terms = task.baselineSearchTerms?.length ? task.baselineSearchTerms : baselineTermsForTask(task);
  const explicitFiles = new Set((task.files ?? []).map(file => file.replace(/\\/g, '/').toLowerCase()));
  const matchedFiles: string[] = [];
  let evidence = task.diff ? `DIFF\n${task.diff}\n` : '';

  for (const file of manifest.files) {
    if (!file.parseable || matchedFiles.length >= 60) continue;
    const relLower = file.relPath.toLowerCase();
    let content = '';
    try {
      content = fs.readFileSync(file.absPath, 'utf-8');
    } catch {
      continue;
    }
    const contentLower = content.toLowerCase();
    const explicitMatch = explicitFiles.has(relLower) || [...explicitFiles].some(explicit => relLower.endsWith(explicit));
    const termMatch = terms.some(term => contentLower.includes(term.toLowerCase()) || relLower.includes(term.toLowerCase()));
    if (!explicitMatch && !termMatch) continue;
    matchedFiles.push(file.relPath);
    evidence += `\nFILE ${file.relPath}\n${content.slice(0, 16_000)}`;
  }

  const correct = expectedPresent(evidence, task.expectedContains, task.expectedFiles, matchedFiles);
  const estimatedInputTokens = estimateTokens(`${task.title}\n${terms.join('\n')}\n${evidence}`.length);
  const estimatedOutputTokens = estimateTokens(JSON.stringify({
    id: task.id,
    matchedFiles: matchedFiles.slice(0, 10),
    correct,
  }).length);

  return {
    searchTerms: terms,
    filesOpened: matchedFiles.length,
    matchedFiles,
    estimatedInputTokens,
    estimatedOutputTokens,
    correct,
  };
}

function scanBaselineManifest(root: string): BaselineManifest {
  const rootDir = path.resolve(root);
  const files: BaselineManifestFile[] = [];
  walkBaselineManifest(rootDir, rootDir, files);
  return { root: rootDir, files };
}

function walkBaselineManifest(root: string, dir: string, files: BaselineManifestFile[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    const relPath = path.relative(root, absPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (BASELINE_SKIP_DIRS.has(entry.name)) continue;
      walkBaselineManifest(root, absPath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const classification = classifyFile(relPath);
    if (!classification.indexable) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      continue;
    }
    if (stat.size > BASELINE_MAX_FILE_SIZE_BYTES) continue;
    files.push({ absPath, relPath, parseable: classification.parseable });
  }
}

async function runMcpReviewProof(
  queryService: V2QueryService,
  workspaceId: string,
  task: ReviewProofTask,
): Promise<McpReviewProofResult & { evidence: string }> {
  const args = {
    files: task.files,
    symbols: task.symbols,
    diff: task.diff,
    focus: task.focus ?? 'general',
    limit: task.limit ?? 50,
  };
  const start = Date.now();
  const response = await queryService.query({
    workspaceId,
    toolName: 'review_patch',
    args,
  }) as Record<string, unknown>;
  const durationMs = Date.now() - start;
  const responseJson = JSON.stringify(response);
  const changedFiles = stringArray(response.changedFiles);
  const findings = Array.isArray(response.reviewFindings) ? response.reviewFindings : [];
  return {
    toolName: 'review_patch',
    durationMs,
    responseChars: responseJson.length,
    estimatedInputTokens: estimateTokens(`${task.title}\n${JSON.stringify(args)}\n${responseJson}`.length),
    estimatedOutputTokens: estimateTokens(JSON.stringify({
      id: task.id,
      reviewStatus: stringValue(response.reviewStatus),
      changedFiles: changedFiles.slice(0, 10),
      findingCount: findings.length,
    }).length),
    toolCalls: 1,
    reviewStatus: stringValue(response.reviewStatus),
    changedFiles,
    findingCount: findings.length,
    correct: false,
    evidence: responseJson,
  };
}

function defaultReviewProofTasks(): ReviewProofTask[] {
  return [
    {
      id: 'payment-service-review',
      title: 'Review a proposed payment refund service patch.',
      files: ['src/main/java/com/example/payment/PaymentService.java'],
      symbols: ['PaymentService.refund'],
      diff: syntheticReviewDiff('src/main/java/com/example/payment/PaymentService.java', 'PaymentService'),
      focus: 'bug-risk',
      baselineSearchTerms: ['PaymentService', 'refund', 'payment'],
      expectedContains: ['PaymentService'],
      expectedFiles: ['PaymentService.java'],
      limit: 50,
    },
  ];
}

function normalizeReviewProofTask(value: unknown, index: number): ReviewProofTask {
  const task = value as Partial<ReviewProofTask> & { task?: string; question?: string };
  return {
    id: task.id ?? `review-task-${index + 1}`,
    title: task.title ?? task.task ?? task.question ?? task.id ?? `Review task ${index + 1}`,
    files: task.files,
    symbols: task.symbols,
    diff: task.diff,
    focus: task.focus,
    baselineSearchTerms: task.baselineSearchTerms,
    expectedContains: task.expectedContains,
    expectedFiles: task.expectedFiles,
    limit: task.limit,
  };
}

function expectedPresent(
  evidence: string,
  expectedContains: string[] | undefined,
  expectedFiles: string[] | undefined,
  files: string[],
): boolean {
  const evidenceLower = evidence.toLowerCase();
  const contentOk = (expectedContains ?? []).every(expected => evidenceLower.includes(expected.toLowerCase()));
  const filesOk = (expectedFiles ?? []).every(expectedFile => files.some(file => pathMatchesExpected(file, expectedFile)));
  return contentOk && filesOk;
}

function pathMatchesExpected(actual: string, expected: string): boolean {
  const normalizedActual = actual.replace(/\\/g, '/').toLowerCase();
  const normalizedExpected = expected.replace(/\\/g, '/').toLowerCase();
  return normalizedActual === normalizedExpected || normalizedActual.endsWith(normalizedExpected);
}

function baselineTermsForTask(task: ReviewProofTask): string[] {
  const terms = [
    ...tokenizeBaselineTerms(task.title),
    ...(task.files ?? []).map(file => path.basename(file, path.extname(file))),
    ...(task.symbols ?? []),
  ];
  return [...new Set(terms.filter(term => term.length >= 3))].slice(0, 8);
}

function tokenizeBaselineTerms(value: string): string[] {
  return value
    .split(/[^a-zA-Z0-9_.]+/g)
    .map(term => term.trim())
    .filter(term => term.length >= 4)
    .slice(0, 8);
}

function savingPct(baseline: number, optimized: number): number {
  if (baseline <= 0) return optimized <= 0 ? 0 : -1;
  return Number((1 - (optimized / baseline)).toFixed(3));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function reviewTaskFileScore(relPath: string, language: string | undefined, role: string): number {
  const normalized = relPath.replace(/\\/g, '/');
  const basename = path.basename(normalized, path.extname(normalized));
  const lower = normalized.toLowerCase();
  if (lower.includes('/generated/') || lower.includes('/build/') || lower.includes('/dist/')) return 0;
  let score = role === 'main_source' ? 20 : role === 'resource_config' ? 8 : 3;
  if (language === 'java') score += 12;
  if (language === 'typescript' || language === 'javascript' || language === 'python') score += 8;
  if (/(Controller|Resource|Endpoint|Action)$/.test(basename)) score += 42;
  if (/(Service|Manager|Client|Server|Provider|Handler|Repository|Store|Engine|Application)$/.test(basename)) score += 36;
  if (/(Node|NameNode|DataNode|ResourceManager|NodeManager|ClusterService|TransportService|FileSystem)$/.test(basename)) score += 30;
  if (/(Test|Tests|IT|ITCase|Spec)$/.test(basename)) score -= 100;
  if (lower.includes('/src/main/')) score += 10;
  score += Math.max(0, 20 - normalized.split('/').length);
  return score;
}

function displayNameForFileBasename(basename: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(basename)) return basename;
  return basename
    .split(/[^A-Za-z0-9]+/g)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function baselineTermsForFile(displayName: string, basename: string): string[] {
  const spaced = displayName.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return [...new Set([displayName, basename, spaced].filter(term => term.length >= 3))].slice(0, 4);
}

function syntheticReviewDiff(file: string, symbol: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1,1 +1,2 @@',
    `+// review proof touch ${symbol}`,
  ].join('\n');
}

function slugify(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item));
}

function stringValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}
