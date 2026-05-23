import fs from 'node:fs';
import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import { scanManifest } from '../index/manifest.js';
import { V2Indexer } from '../index/indexer.js';
import { V2QueryService } from '../query/service.js';

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
  totals: {
    tasks: number;
    baselineCorrect: number;
    mcpCorrect: number;
    qualityMaintained: boolean;
    baselineEstimatedTokens: number;
    mcpEstimatedTokens: number;
    tokenSavingPct: number;
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
  correct: boolean;
}

interface McpProofResult {
  packetChars: number;
  sliceChars: number;
  responseChars: number;
  estimatedTokens: number;
  contextPacketMs: number;
  workflowMs: number;
  slicesOpened: number;
  slicedFiles: string[];
  topFiles: string[];
  confidence?: number;
  correct: boolean;
}

export function loadContextProofTasks(tasksFile?: string): ContextProofTask[] {
  if (!tasksFile) return defaultContextProofTasks();
  const parsed = JSON.parse(fs.readFileSync(tasksFile, 'utf-8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`Context proof task file must contain a JSON array: ${tasksFile}`);
  return parsed.map((task, index) => normalizeContextProofTask(task, index));
}

export function runContextProofEval(
  db: DatabaseType,
  root: string,
  tasks: ContextProofTask[],
): ContextProofResult {
  const indexer = new V2Indexer(db);
  const index = indexer.indexWorkspace({ root });
  const queryService = new V2QueryService(db);
  const normalizedRoot = path.resolve(root);
  const results: ContextProofTaskResult[] = [];

  for (const task of tasks) {
    const baseline = runBaselineProof(normalizedRoot, task);
    const mcp = runMcpProof(queryService, index.workspaceId, task);
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
      tokenSavingPct: savingPct(baseline.estimatedTokens, mcp.estimatedTokens),
      fileOpenReductionPct: savingPct(baseline.filesOpened, mcp.slicesOpened),
      baseline,
      mcp: {
        packetChars: mcp.packetChars,
        sliceChars: mcp.sliceChars,
        responseChars: mcp.responseChars,
        estimatedTokens: mcp.estimatedTokens,
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
  const baselineFilesOpened = results.reduce((sum, result) => sum + result.baseline.filesOpened, 0);
  const mcpSlicesOpened = results.reduce((sum, result) => sum + result.mcp.slicesOpened, 0);
  const baselineCorrect = results.filter(result => result.baseline.correct).length;
  const mcpCorrect = results.filter(result => result.correct).length;

  return {
    root: normalizedRoot,
    workspaceId: index.workspaceId,
    snapshotId: index.snapshotId,
    totals: {
      tasks: results.length,
      baselineCorrect,
      mcpCorrect,
      qualityMaintained: mcpCorrect >= baselineCorrect,
      baselineEstimatedTokens,
      mcpEstimatedTokens,
      tokenSavingPct: savingPct(baselineEstimatedTokens, mcpEstimatedTokens),
      baselineFilesOpened,
      mcpSlicesOpened,
      fileOpenReductionPct: savingPct(baselineFilesOpened, mcpSlicesOpened),
      contextPacketP95Ms: percentile(results.map(result => result.mcp.contextPacketMs), 0.95),
      mcpWorkflowP95Ms: percentile(results.map(result => result.mcp.workflowMs), 0.95),
    },
    tasks: results,
  };
}

function runBaselineProof(root: string, task: ContextProofTask): BaselineProofResult {
  const terms = task.baselineSearchTerms?.length
    ? task.baselineSearchTerms
    : tokenizeBaselineTerms(task.task);
  const manifest = scanManifest(root);
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

  return {
    searchTerms: terms,
    filesOpened: matchedFiles.length,
    matchedFiles,
    responseChars,
    estimatedTokens: estimateTokens(responseChars),
    correct: expectedPresent(evidence, task.expectedContains, task.expectedFiles, matchedFiles),
  };
}

function runMcpProof(
  queryService: V2QueryService,
  workspaceId: string,
  task: ContextProofTask,
): McpProofResult & { evidence: string } {
  const workflowStart = Date.now();
  const packetStart = Date.now();
  const packet = queryService.query({
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
    const slice = queryService.query({
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
  return {
    packetChars: packetJson.length,
    sliceChars,
    responseChars,
    estimatedTokens: estimateTokens(responseChars),
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
    const lines = stringValue(candidate.lines);
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

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item));
}

function stringValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}
