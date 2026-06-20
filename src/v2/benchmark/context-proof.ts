import fs from 'node:fs';
import path from 'node:path';
import type { CodeGraphDb } from '../storage/database.js';
import { classifyFile } from '../index/file-role.js';
import { scanManifest } from '../index/manifest.js';
import { V2Indexer } from '../index/indexer.js';
import { V2QueryService } from '../query/service.js';
import { TEXT_TOKEN_ESTIMATOR, estimateTextTokens } from '../token-estimator.js';

export interface ContextProofTask {
  id: string;
  task: string;
  domain?: string;
  baselineSearchTerms?: string[];
  expectedContains?: string[];
  expectedFiles?: string[];
  maxFiles?: number;
  maxSymbols?: number;
  tokenBudget?: number;
  sliceCount?: number;
  includeSnippets?: boolean;
}

export interface ContextProofResult {
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
    baselineEstimatedTokens: number;
    mcpEstimatedTokens: number;
    tokenSavingPct: number;
    baselineEstimatedInputTokens: number;
    mcpEstimatedInputTokens: number;
    inputTokenSavingPct: number;
    baselineEstimatedOutputTokens: number;
    mcpEstimatedOutputTokens: number;
    outputTokenSavingPct: number;
    baselineFilesOpened: number;
    mcpSlicesOpened: number;
    fileOpenReductionPct: number;
    contextPacketP95Ms: number;
    mcpWorkflowP95Ms: number;
  };
  tasks: ContextProofTaskResult[];
}

export interface ContextProofTaskResult {
  id: string;
  task: string;
  domain?: string;
  correct: boolean;
  qualityMaintained: boolean;
  missingExpected: string[];
  missingExpectedFiles: string[];
  tokenSavingPct: number;
  inputTokenSavingPct: number;
  outputTokenSavingPct: number;
  fileOpenReductionPct: number;
  baseline: BaselineProofResult;
  mcp: McpProofResult;
}

interface BaselineProofResult {
  searchTerms: string[];
  filesOpened: number;
  matchedFiles: string[];
  responseChars: number;
  estimatedTokens: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  correct: boolean;
}

interface McpProofResult {
  packetChars: number;
  sliceChars: number;
  responseChars: number;
  estimatedTokens: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  contextPacketMs: number;
  workflowMs: number;
  slicesOpened: number;
  slicedFiles: string[];
  topFiles: string[];
  confidence?: number;
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
  scanTimeMs: number;
}

const BASELINE_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const BASELINE_SKIP_DIRS = new Set([
  '.git',
  '.codegraph',
  '.tmp',
  '.idea',
  '.vscode',
  'node_modules',
  'target',
  'build',
  'dist',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'bin',
  'obj',
  '.gradle',
  '__pycache__',
]);

export function loadContextProofTasks(tasksFile?: string): ContextProofTask[] {
  if (!tasksFile) return defaultContextProofTasks();
  const parsed = JSON.parse(fs.readFileSync(tasksFile, 'utf-8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`Context proof task file must contain a JSON array: ${tasksFile}`);
  return parsed.map((task, index) => normalizeContextProofTask(task, index));
}

export function deriveContextProofTasks(
  root: string,
  options: { limit?: number } = {},
): ContextProofTask[] {
  const limit = Math.max(1, Math.min(options.limit ?? 5, 25));
  const manifest = scanManifest(root);
  const candidates = manifest.files
    .filter(file => file.parseable && file.language && file.role !== 'test_source' && file.role !== 'mock_source')
    .map(file => ({
      file,
      score: autoTaskFileScore(file.relPath, file.language, file.role),
    }))
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.file.relPath.localeCompare(b.file.relPath));

  const tasks: ContextProofTask[] = [];
  const seenDomains = new Set<string>();
  for (const candidate of candidates) {
    if (tasks.length >= limit) break;
    const basename = path.basename(candidate.file.relPath, path.extname(candidate.file.relPath));
    const displayName = displayNameForFileBasename(basename);
    const domain = inferTaskDomainFromPath(candidate.file.relPath);
    const domainKey = `${domain}:${candidate.file.language}`;
    if (seenDomains.has(domainKey) && tasks.length < Math.ceil(limit / 2)) continue;
    seenDomains.add(domainKey);
    tasks.push({
      id: `auto-${tasks.length + 1}-${slugify(displayName)}`,
      task: `Find the implementation context, callers, and likely tests for ${displayName}.`,
      domain,
      baselineSearchTerms: baselineTermsForFile(displayName, basename),
      expectedContains: [displayName],
      expectedFiles: [candidate.file.relPath],
      maxFiles: 6,
      maxSymbols: 10,
      tokenBudget: 4000,
      sliceCount: 2,
      includeSnippets: false,
    });
  }

  if (tasks.length > 0) return tasks;
  return defaultContextProofTasks();
}

export async function runContextProofEval(
  db: CodeGraphDb,
  root: string,
  tasks: ContextProofTask[],
  options: { skipIndex?: boolean } = {},
): Promise<ContextProofResult> {
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
  const baselineManifest = scanBaselineManifest(normalizedRoot);
  const results: ContextProofTaskResult[] = [];

  for (const task of tasks) {
    const baseline = runBaselineProof(baselineManifest, task);
    const mcp = await runMcpProof(queryService, index.workspaceId, task);
    const mcpEvidence = mcp.evidence.toLowerCase();
    const missingExpected = (task.expectedContains ?? [])
      .filter(expected => !mcpEvidence.includes(expected.toLowerCase()));
    const missingExpectedFiles = (task.expectedFiles ?? [])
      .filter(expectedFile => !mcp.topFiles.some(file => pathMatchesExpected(file, expectedFile))
        && !mcp.slicedFiles.some(file => pathMatchesExpected(file, expectedFile)));
    const mcpCorrect = missingExpected.length === 0 && missingExpectedFiles.length === 0;

    results.push({
      id: task.id,
      task: task.task,
      domain: task.domain,
      correct: mcpCorrect,
      qualityMaintained: !baseline.correct || mcpCorrect,
      missingExpected,
      missingExpectedFiles,
      tokenSavingPct: savingPct(baseline.estimatedInputTokens, mcp.estimatedInputTokens),
      inputTokenSavingPct: savingPct(baseline.estimatedInputTokens, mcp.estimatedInputTokens),
      outputTokenSavingPct: savingPct(baseline.estimatedOutputTokens, mcp.estimatedOutputTokens),
      fileOpenReductionPct: savingPct(baseline.filesOpened, mcp.slicesOpened),
      baseline,
      mcp: {
        packetChars: mcp.packetChars,
        sliceChars: mcp.sliceChars,
        responseChars: mcp.responseChars,
        estimatedTokens: mcp.estimatedTokens,
        estimatedInputTokens: mcp.estimatedInputTokens,
        estimatedOutputTokens: mcp.estimatedOutputTokens,
        contextPacketMs: mcp.contextPacketMs,
        workflowMs: mcp.workflowMs,
        slicesOpened: mcp.slicesOpened,
        slicedFiles: mcp.slicedFiles,
        topFiles: mcp.topFiles,
        confidence: mcp.confidence,
        correct: mcpCorrect,
      },
    });
  }

  const baselineEstimatedTokens = results.reduce((sum, result) => sum + result.baseline.estimatedTokens, 0);
  const mcpEstimatedTokens = results.reduce((sum, result) => sum + result.mcp.estimatedTokens, 0);
  const baselineEstimatedInputTokens = results.reduce((sum, result) => sum + result.baseline.estimatedInputTokens, 0);
  const mcpEstimatedInputTokens = results.reduce((sum, result) => sum + result.mcp.estimatedInputTokens, 0);
  const baselineEstimatedOutputTokens = results.reduce((sum, result) => sum + result.baseline.estimatedOutputTokens, 0);
  const mcpEstimatedOutputTokens = results.reduce((sum, result) => sum + result.mcp.estimatedOutputTokens, 0);
  const baselineFilesOpened = results.reduce((sum, result) => sum + result.baseline.filesOpened, 0);
  const mcpSlicesOpened = results.reduce((sum, result) => sum + result.mcp.slicesOpened, 0);
  const baselineCorrect = results.filter(result => result.baseline.correct).length;
  const mcpCorrect = results.filter(result => result.correct).length;

  return {
    root: normalizedRoot,
    workspaceId: index.workspaceId,
    snapshotId: index.snapshotId,
    tokenModel: {
      estimator: TEXT_TOKEN_ESTIMATOR,
      inputDefinition: 'Task text plus retrieved evidence that would be added to an agent/model context.',
      outputDefinition: 'Deterministic benchmark summary size, not real LLM completion usage.',
      actualModelUsage: false,
    },
    totals: {
      tasks: results.length,
      baselineCorrect,
      mcpCorrect,
      qualityMaintained: mcpCorrect >= baselineCorrect,
      baselineEstimatedTokens,
      mcpEstimatedTokens,
      tokenSavingPct: savingPct(baselineEstimatedInputTokens, mcpEstimatedInputTokens),
      baselineEstimatedInputTokens,
      mcpEstimatedInputTokens,
      inputTokenSavingPct: savingPct(baselineEstimatedInputTokens, mcpEstimatedInputTokens),
      baselineEstimatedOutputTokens,
      mcpEstimatedOutputTokens,
      outputTokenSavingPct: savingPct(baselineEstimatedOutputTokens, mcpEstimatedOutputTokens),
      baselineFilesOpened,
      mcpSlicesOpened,
      fileOpenReductionPct: savingPct(baselineFilesOpened, mcpSlicesOpened),
      contextPacketP95Ms: percentile(results.map(result => result.mcp.contextPacketMs), 0.95),
      mcpWorkflowP95Ms: percentile(results.map(result => result.mcp.workflowMs), 0.95),
    },
    tasks: results,
  };
}

function runBaselineProof(manifest: BaselineManifest, task: ContextProofTask): BaselineProofResult {
  const terms = task.baselineSearchTerms?.length
    ? task.baselineSearchTerms
    : tokenizeBaselineTerms(task.task);
  const matchedFiles: string[] = [];
  let responseChars = 0;
  let evidence = '';

  for (const file of manifest.files) {
    if (!file.parseable || matchedFiles.length >= 60) continue;
    let content = '';
    try {
      content = fs.readFileSync(file.absPath, 'utf-8');
    } catch {
      continue;
    }
    const lower = content.toLowerCase();
    const pathLower = file.relPath.toLowerCase();
    if (!terms.some(term => lower.includes(term.toLowerCase()) || pathLower.includes(term.toLowerCase()))) continue;
    matchedFiles.push(file.relPath);
    const clipped = content.slice(0, 16_000);
    responseChars += clipped.length;
    evidence += `\nFILE ${file.relPath}\n${clipped}`;
  }
  const correct = expectedPresent(evidence, task.expectedContains, task.expectedFiles, matchedFiles);
  const estimatedInputTokens = estimateTextTokens(`${task.task}\n${terms.join('\n')}\n${evidence}`);
  const estimatedOutputTokens = estimateTextTokens(JSON.stringify({
    id: task.id,
    matchedFiles: matchedFiles.slice(0, 10),
    correct,
  }));

  return {
    searchTerms: terms,
    filesOpened: matchedFiles.length,
    matchedFiles,
    responseChars,
    estimatedTokens: estimateTextTokens(evidence),
    estimatedInputTokens,
    estimatedOutputTokens,
    correct,
  };
}

function scanBaselineManifest(root: string): BaselineManifest {
  const start = Date.now();
  const rootDir = path.resolve(root);
  const files: BaselineManifestFile[] = [];
  walkBaselineManifest(rootDir, rootDir, files);
  return {
    root: rootDir,
    files,
    scanTimeMs: Date.now() - start,
  };
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
      if (BASELINE_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.tmp')) continue;
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

    files.push({
      absPath,
      relPath,
      parseable: classification.parseable,
    });
  }
}

async function runMcpProof(
  queryService: V2QueryService,
  workspaceId: string,
  task: ContextProofTask,
): Promise<McpProofResult & { evidence: string }> {
  const workflowStart = Date.now();
  const packetStart = Date.now();
  const packet = await queryService.query({
    workspaceId,
    toolName: 'get_context_packet',
    args: {
      task: task.task,
      domain: task.domain,
      tokenBudget: task.tokenBudget ?? 4000,
      maxFiles: task.maxFiles ?? 6,
      maxSymbols: task.maxSymbols ?? 10,
      includeTests: true,
      includeSnippets: task.includeSnippets ?? false,
      snippetLines: 8,
    },
  }) as Record<string, unknown>;
  const contextPacketMs = Date.now() - packetStart;
  const packetJson = JSON.stringify(packet);
  const sliceRequests = chooseSliceRequests(packet, task.sliceCount ?? 2);
  const slices: Array<Record<string, unknown>> = [];
  const slicedFiles = new Set<string>();
  let sliceChars = 0;

  for (const request of sliceRequests) {
    const slice = await queryService.query({
      workspaceId,
      toolName: 'get_file_slice',
      args: {
        ...request,
        maxChars: 4000,
      },
    }) as Record<string, unknown>;
    slices.push(slice);
    sliceChars += JSON.stringify(slice).length;
    if (slice.file) slicedFiles.add(String(slice.file));
  }

  const responseChars = packetJson.length + sliceChars;
  const estimatedInputTokens = estimateTextTokens(`${task.task}\n${packetJson}\n${JSON.stringify(slices)}`);
  const estimatedOutputTokens = estimateTextTokens(JSON.stringify({
    id: task.id,
    topFiles: stringArray(packet.topFiles).slice(0, 10),
    slicedFiles: [...slicedFiles],
    confidence: typeof packet.confidence === 'number' ? packet.confidence : undefined,
  }));
  return {
    packetChars: packetJson.length,
    sliceChars,
    responseChars,
    estimatedTokens: estimateTextTokens(`${packetJson}\n${JSON.stringify(slices)}`),
    estimatedInputTokens,
    estimatedOutputTokens,
    contextPacketMs,
    workflowMs: Date.now() - workflowStart,
    slicesOpened: slicedFiles.size,
    slicedFiles: [...slicedFiles],
    topFiles: stringArray(packet.topFiles),
    confidence: typeof packet.confidence === 'number' ? packet.confidence : undefined,
    evidence: `${packetJson}\n${JSON.stringify(slices)}`,
    correct: false,
  };
}

function chooseSliceRequests(packet: Record<string, unknown>, limit: number): Array<Record<string, unknown>> {
  const requests: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const add = (request: Record<string, unknown>) => {
    const key = JSON.stringify(request);
    if (seen.has(key)) return;
    seen.add(key);
    requests.push(request);
  };

  const candidateFiles = Array.isArray(packet.candidateFiles)
    ? packet.candidateFiles as Array<Record<string, unknown>>
    : [];
  for (const candidate of candidateFiles) {
    if (requests.length >= limit) break;
    const file = stringValue(candidate.file);
    const lines = stringValue(candidate.lines) ?? firstTopSymbolLines(candidate);
    if (file && lines) add({ file, lines });
  }

  const relevantSymbols = Array.isArray(packet.relevantSymbols)
    ? packet.relevantSymbols as Array<Record<string, unknown>>
    : [];
  for (const symbol of relevantSymbols) {
    if (requests.length >= limit) break;
    const name = stringValue(symbol.symbol);
    if (name) add({ symbol: name });
  }

  return requests.slice(0, limit);
}

function firstTopSymbolLines(candidate: Record<string, unknown>): string | undefined {
  const topSymbols = Array.isArray(candidate.topSymbols)
    ? candidate.topSymbols as Array<Record<string, unknown>>
    : [];
  for (const symbol of topSymbols) {
    const lines = stringValue(symbol.lines);
    if (lines) return lines;
  }
  return undefined;
}

function defaultContextProofTasks(): ContextProofTask[] {
  return [
    {
      id: 'payment-service-context',
      task: 'Find the payment service implementation and tests for refund behavior.',
      domain: 'payment',
      baselineSearchTerms: ['PaymentService', 'refund', 'payment'],
      expectedContains: ['PaymentService'],
      expectedFiles: ['PaymentService.java'],
    },
    {
      id: 'order-create-context',
      task: 'Find the order creation controller and service flow.',
      domain: 'order',
      baselineSearchTerms: ['OrderController', 'createOrder', 'OrderService'],
      expectedContains: ['OrderService'],
      expectedFiles: ['OrderService.java'],
    },
    {
      id: 'gateway-call-context',
      task: 'Find code related to PaymentGateway.processPayment callers.',
      domain: 'payment',
      baselineSearchTerms: ['PaymentGateway', 'processPayment'],
      expectedContains: ['processPayment'],
      expectedFiles: ['PaymentGateway.java'],
    },
  ];
}

function normalizeContextProofTask(value: unknown, index: number): ContextProofTask {
  const task = value as Partial<ContextProofTask> & {
    question?: string;
    codegraphArgs?: Record<string, unknown>;
  };
  const codegraphArgs = task.codegraphArgs ?? {};
  const normalizedTask = task.task
    ?? task.question
    ?? String(codegraphArgs.task ?? codegraphArgs.query ?? codegraphArgs.target ?? task.id ?? `Task ${index + 1}`);
  return {
    id: task.id ?? `task-${index + 1}`,
    task: normalizedTask,
    domain: task.domain ?? (codegraphArgs.domain ? String(codegraphArgs.domain) : undefined),
    baselineSearchTerms: task.baselineSearchTerms,
    expectedContains: task.expectedContains,
    expectedFiles: task.expectedFiles,
    maxFiles: task.maxFiles,
    maxSymbols: task.maxSymbols,
    tokenBudget: task.tokenBudget,
    sliceCount: task.sliceCount,
    includeSnippets: task.includeSnippets,
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

function tokenizeBaselineTerms(question: string): string[] {
  return [...new Set(question
    .split(/[^a-zA-Z0-9_.]+/g)
    .map(term => term.trim())
    .filter(term => term.length >= 4)
    .slice(0, 8))];
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


function autoTaskFileScore(relPath: string, language: string | undefined, role: string): number {
  const normalized = relPath.replace(/\\/g, '/');
  const basename = path.basename(normalized, path.extname(normalized));
  const lower = normalized.toLowerCase();
  if (lower.includes('/generated/') || lower.includes('/build/') || lower.includes('/dist/')) return 0;
  let score = role === 'main_source' ? 20 : role === 'resource_config' ? 10 : 4;
  if (language === 'java') score += 12;
  if (language === 'typescript' || language === 'javascript' || language === 'python') score += 8;
  if (/(Controller|Resource|Endpoint|Action)$/.test(basename)) score += 45;
  if (/(Service|Manager|Client|Server|Provider|Handler|Repository|Store|Engine|Application)$/.test(basename)) score += 38;
  if (/(Node|NameNode|DataNode|ResourceManager|NodeManager|ClusterService|TransportService|FileSystem)$/.test(basename)) score += 34;
  if (/(Test|Tests|IT|ITCase|Spec)$/.test(basename)) score -= 100;
  if (lower.includes('/src/main/')) score += 12;
  if (lower.includes('/server/') || lower.includes('/backend/') || lower.includes('/modules/') || lower.includes('/hadoop-')) score += 8;
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

function inferTaskDomainFromPath(relPath: string): string {
  const parts = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
  const srcIndex = parts.indexOf('src');
  if (srcIndex > 1) return parts[srcIndex - 1] ?? parts[0] ?? 'root';
  if (srcIndex >= 0 && srcIndex + 2 < parts.length) return parts[srcIndex + 2] ?? parts[srcIndex + 1] ?? 'src';
  return parts[0] ?? 'root';
}

function baselineTermsForFile(displayName: string, basename: string): string[] {
  const spaced = displayName.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return [...new Set([displayName, basename, spaced].filter(term => term.length >= 3))].slice(0, 4);
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
