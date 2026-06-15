import path from 'node:path';
import type { ContextProofTask } from './context-proof.js';
import { localCodeGraphContext, type LocalContextFallbackResult } from '../mcp/local-fallback.js';

export interface LocalFallbackBenchmarkTaskResult {
  id: string;
  task: string;
  correct: boolean;
  source: string;
  missingExpected: string[];
  missingExpectedFiles: string[];
  wallMs: number;
  estimatedResponseTokens: number;
  topFiles: string[];
  filesConsidered: number;
  filesRead: number;
  filesMatched: number;
}

export interface LocalFallbackBenchmarkReport {
  root: string;
  totals: {
    tasks: number;
    correct: number;
    qualityScore: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
    estimatedResponseTokens: number;
    averageEstimatedResponseTokens: number;
    filesConsidered: number;
    filesRead: number;
    filesMatched: number;
  };
  tasks: LocalFallbackBenchmarkTaskResult[];
}

export async function runLocalFallbackBenchmark(
  root: string,
  tasks: ContextProofTask[],
): Promise<LocalFallbackBenchmarkReport> {
  const rootDir = path.resolve(root);
  const results: LocalFallbackBenchmarkTaskResult[] = [];
  for (const task of tasks) {
    const started = Date.now();
    const result = await localCodeGraphContext(rootDir, {
      task: task.task,
      target: task.domain,
      budgetTokens: task.tokenBudget ?? 4000,
      profile: 'compact',
    }, {
      error: {
        code: 'benchmark_forced_local_fallback',
        message: 'Benchmarking DB-free MCP fallback directly.',
      },
    });
    results.push(scoreLocalFallbackTask(task, result, Date.now() - started));
  }

  const latencies = results.map(result => result.wallMs);
  const estimatedResponseTokens = results.reduce((sum, result) => sum + result.estimatedResponseTokens, 0);
  return {
    root: rootDir,
    totals: {
      tasks: results.length,
      correct: results.filter(result => result.correct).length,
      qualityScore: results.length === 0 ? 0 : Number((results.filter(result => result.correct).length / results.length).toFixed(3)),
      p50Ms: percentile(latencies, 0.50),
      p95Ms: percentile(latencies, 0.95),
      maxMs: latencies.length > 0 ? Math.max(...latencies) : 0,
      estimatedResponseTokens,
      averageEstimatedResponseTokens: results.length === 0 ? 0 : Math.round(estimatedResponseTokens / results.length),
      filesConsidered: maxMetric(results, 'filesConsidered'),
      filesRead: maxMetric(results, 'filesRead'),
      filesMatched: maxMetric(results, 'filesMatched'),
    },
    tasks: results,
  };
}

function scoreLocalFallbackTask(
  task: ContextProofTask,
  result: LocalContextFallbackResult,
  wallMs: number,
): LocalFallbackBenchmarkTaskResult {
  const evidence = JSON.stringify(result).toLowerCase();
  const topFiles = result.topFiles ?? [];
  const missingExpected = (task.expectedContains ?? [])
    .filter(expected => !evidence.includes(expected.toLowerCase()));
  const missingExpectedFiles = (task.expectedFiles ?? [])
    .filter(expectedFile => !topFiles.some(file => pathMatchesExpected(file, expectedFile))
      && !evidence.includes(expectedFile.replace(/\\/g, '/').toLowerCase()));
  return {
    id: task.id,
    task: task.task,
    correct: missingExpected.length === 0 && missingExpectedFiles.length === 0,
    source: result.source,
    missingExpected,
    missingExpectedFiles,
    wallMs,
    estimatedResponseTokens: result.budget.estimatedResponseTokens,
    topFiles,
    filesConsidered: result.scan?.filesConsidered ?? 0,
    filesRead: result.scan?.filesRead ?? 0,
    filesMatched: result.scan?.filesMatched ?? 0,
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function maxMetric(results: LocalFallbackBenchmarkTaskResult[], key: 'filesConsidered' | 'filesRead' | 'filesMatched'): number {
  return results.length === 0 ? 0 : Math.max(...results.map(result => result[key]));
}

function pathMatchesExpected(actual: string, expected: string): boolean {
  const normalizedActual = actual.replace(/\\/g, '/').toLowerCase();
  const normalizedExpected = expected.replace(/\\/g, '/').toLowerCase();
  return normalizedActual === normalizedExpected || normalizedActual.endsWith(normalizedExpected);
}
