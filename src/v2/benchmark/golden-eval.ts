import fs from 'node:fs';
import path from 'node:path';
import type { CodeGraphDb } from '../storage/database.js';
import { V2Indexer } from '../index/indexer.js';
import { scanManifest } from '../index/manifest.js';
import { V2QueryService } from '../query/service.js';

export interface GoldenEvalTask {
  id: string;
  question: string;
  codegraphTool: string;
  codegraphArgs: Record<string, unknown>;
  baselineSearchTerms?: string[];
  expectedContains?: string[];
}

export interface GoldenEvalResult {
  root: string;
  workspaceId: string;
  snapshotId: string;
  totals: {
    tasks: number;
    correct: number;
    baselineEstimatedTokens: number;
    codegraphEstimatedTokens: number;
    baselineFilesOpened: number;
    tokenSavingPct: number;
  };
  tasks: Array<{
    id: string;
    question: string;
    correct: boolean;
    missingExpected: string[];
    baseline: BaselineEvalResult;
    codegraph: CodeGraphEvalResult;
  }>;
}

interface BaselineEvalResult {
  searchTerms: string[];
  filesOpened: number;
  matchedFiles: string[];
  responseChars: number;
  estimatedTokens: number;
}

interface CodeGraphEvalResult {
  toolName: string;
  responseChars: number;
  estimatedTokens: number;
  durationMs: number;
}

export function loadGoldenEvalTasks(tasksFile?: string): GoldenEvalTask[] {
  if (!tasksFile) return defaultGoldenEvalTasks();
  const parsed = JSON.parse(fs.readFileSync(tasksFile, 'utf-8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`Golden eval task file must contain a JSON array: ${tasksFile}`);
  return parsed.map((task, index) => normalizeTask(task, index));
}

export function runGoldenEval(
  db: CodeGraphDb,
  root: string,
  tasks: GoldenEvalTask[],
): Promise<GoldenEvalResult> {
  return runGoldenEvalAsync(db, root, tasks);
}

async function runGoldenEvalAsync(
  db: CodeGraphDb,
  root: string,
  tasks: GoldenEvalTask[],
): Promise<GoldenEvalResult> {
  const indexer = new V2Indexer(db);
  const index = await indexer.indexWorkspace({ root });
  const queryService = new V2QueryService(db);
  const normalizedRoot = path.resolve(root);
  const results: GoldenEvalResult['tasks'] = [];

  for (const task of tasks) {
    const baseline = runBaselineRetrieval(normalizedRoot, task);
    const start = Date.now();
    const response = await queryService.query({
      workspaceId: index.workspaceId,
      toolName: task.codegraphTool,
      args: task.codegraphArgs,
    });
    const responseJson = JSON.stringify(response);
    const codegraph: CodeGraphEvalResult = {
      toolName: task.codegraphTool,
      responseChars: responseJson.length,
      estimatedTokens: estimateTokens(responseJson.length),
      durationMs: Date.now() - start,
    };
    const missingExpected = (task.expectedContains ?? [])
      .filter(expected => !responseJson.toLowerCase().includes(expected.toLowerCase()));

    results.push({
      id: task.id,
      question: task.question,
      correct: missingExpected.length === 0,
      missingExpected,
      baseline,
      codegraph,
    });
  }

  const baselineEstimatedTokens = results.reduce((sum, result) => sum + result.baseline.estimatedTokens, 0);
  const codegraphEstimatedTokens = results.reduce((sum, result) => sum + result.codegraph.estimatedTokens, 0);
  const baselineFilesOpened = results.reduce((sum, result) => sum + result.baseline.filesOpened, 0);
  const correct = results.filter(result => result.correct).length;

  return {
    root: normalizedRoot,
    workspaceId: index.workspaceId,
    snapshotId: index.snapshotId,
    totals: {
      tasks: results.length,
      correct,
      baselineEstimatedTokens,
      codegraphEstimatedTokens,
      baselineFilesOpened,
      tokenSavingPct: baselineEstimatedTokens > 0
        ? Number((1 - (codegraphEstimatedTokens / baselineEstimatedTokens)).toFixed(3))
        : 0,
    },
    tasks: results,
  };
}

function runBaselineRetrieval(root: string, task: GoldenEvalTask): BaselineEvalResult {
  const terms = task.baselineSearchTerms?.length
    ? task.baselineSearchTerms
    : tokenizeBaselineTerms(task.question);
  const manifest = scanManifest(root);
  const matchedFiles: string[] = [];
  let responseChars = 0;

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
    responseChars += Math.min(content.length, 16_000);
  }

  return {
    searchTerms: terms,
    filesOpened: matchedFiles.length,
    matchedFiles,
    responseChars,
    estimatedTokens: estimateTokens(responseChars),
  };
}

function defaultGoldenEvalTasks(): GoldenEvalTask[] {
  return [
    {
      id: 'find-service-files',
      question: 'Which files are related to payment service behavior?',
      codegraphTool: 'search_files',
      codegraphArgs: { query: 'Payment Service', limit: 5 },
      baselineSearchTerms: ['PaymentService', 'payment service'],
      expectedContains: ['PaymentService'],
    },
    {
      id: 'callers-of-service',
      question: 'Who calls PaymentService.charge?',
      codegraphTool: 'find_references',
      codegraphArgs: { symbol: 'PaymentService.charge', kind: 'call', groupBy: 'file', limit: 5 },
      baselineSearchTerms: ['PaymentService', 'charge'],
      expectedContains: ['charge'],
    },
    {
      id: 'dependency-impact',
      question: 'What files depend on PaymentService?',
      codegraphTool: 'trace_dependencies',
      codegraphArgs: { target: 'PaymentService', direction: 'dependents', depth: 1, limit: 10 },
      baselineSearchTerms: ['PaymentService'],
      expectedContains: ['PaymentService'],
    },
    {
      id: 'mixed-search',
      question: 'Find code evidence for PaymentService.',
      codegraphTool: 'search_code',
      codegraphArgs: { query: 'PaymentService', limit: 3, includeDependencies: false },
      baselineSearchTerms: ['PaymentService'],
      expectedContains: ['PaymentService'],
    },
  ];
}

function normalizeTask(value: unknown, index: number): GoldenEvalTask {
  const task = value as Partial<GoldenEvalTask>;
  if (!task.codegraphTool) throw new Error(`Golden eval task ${index} is missing codegraphTool`);
  return {
    id: task.id ?? `task-${index + 1}`,
    question: task.question ?? task.id ?? `Task ${index + 1}`,
    codegraphTool: task.codegraphTool,
    codegraphArgs: task.codegraphArgs ?? {},
    baselineSearchTerms: task.baselineSearchTerms,
    expectedContains: task.expectedContains,
  };
}

function tokenizeBaselineTerms(question: string): string[] {
  return [...new Set(question
    .split(/[^a-zA-Z0-9_.]+/g)
    .map(term => term.trim())
    .filter(term => term.length >= 4)
    .slice(0, 8))];
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}
