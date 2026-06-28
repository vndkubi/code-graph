/**
 * Recall benchmark — broad, multi-file tasks where the answer is a UNION of
 * files across modules. The self-repo proof suites use single-file answers and
 * are blind to the regime that scales worst on large repos: a task that needs
 * 3+ files, any one of which can be mis-ranked or trimmed away. This harness
 * measures, with right-sizing ON (the shipped config) vs the no-trim baseline:
 *
 *   - allFound    : fraction of tasks where EVERY expected file is delivered
 *   - avgRecall   : mean per-task recall of the expected file set
 *   - recall@N    : how many expected files the raw ranker surfaces in top-N
 *                   (ranking ceiling, independent of trimming)
 *
 * Point `--root` at any repo and `--tasks` at a JSON suite to measure an
 * external corpus; with no `--tasks` it runs the bundled self-repo suite.
 */
import { runContextProofEval, type ContextProofTask } from './context-proof.js';
import { V2QueryService } from '../query/service.js';
import { V2Indexer } from '../index/indexer.js';
import type { CodeGraphDb } from '../storage/database.js';
import { readFileSync } from 'node:fs';

export interface RecallBenchTask {
  id: string;
  task: string;
  expectedFiles: string[];
}

export interface RecallBenchOptions {
  tasksFile?: string;
  maxFiles?: number;
  keepRatio?: number;
  recallDepths?: number[];
}

export interface RecallBenchTaskRow {
  id: string;
  need: number;
  baselineRecall: number;
  rightsizedRecall: number;
  rightsizedAllFound: boolean;
  missing: string[];
  rankingCurve: Record<string, number>;
  rightsizedInputTokens: number;
}

export interface RecallBenchResult {
  root: string;
  maxFiles: number;
  keepRatio: number | null;
  tasks: number;
  baselineAllFound: string;
  rightsizedAllFound: string;
  baselineAvgRecall: number;
  rightsizedAvgRecall: number;
  baselineInputTokens: number;
  rightsizedInputTokens: number;
  perTask: RecallBenchTaskRow[];
}

// Bundled self-repo suite. Kept generic enough to stay meaningful as the repo
// evolves; override with --tasks for other corpora.
const DEFAULT_TASKS: RecallBenchTask[] = [
  {
    id: 'indexing-pipeline',
    task: 'Trace the full indexing pipeline from manifest file scan to the final SQLite snapshot.',
    expectedFiles: ['index/indexer.ts', 'index/manifest.ts', 'storage/sqlite-backend.ts'],
  },
  {
    id: 'query-ranking',
    task: 'How does query ranking work: file scoring, the query tokenizer, and relevance right-sizing?',
    expectedFiles: ['query/ranking.ts', 'query/text-util.ts'],
  },
  {
    id: 'mcp-routing',
    task: 'How does the MCP layer route and handle tool calls?',
    expectedFiles: ['mcp/proxy.ts', 'mcp/tools.ts'],
  },
];

function loadRecallTasks(tasksFile?: string): RecallBenchTask[] {
  if (!tasksFile) return DEFAULT_TASKS;
  const parsed = JSON.parse(readFileSync(tasksFile, 'utf8')) as unknown;
  const list = Array.isArray(parsed) ? parsed : (parsed as { tasks?: unknown }).tasks;
  if (!Array.isArray(list)) throw new Error(`Recall suite ${tasksFile} must be a JSON array (or { tasks: [...] }).`);
  return list.map((entry, index) => {
    const task = entry as Partial<RecallBenchTask>;
    if (!task.task || !Array.isArray(task.expectedFiles)) {
      throw new Error(`Recall suite entry ${index} needs "task" and "expectedFiles".`);
    }
    return { id: task.id ?? `task-${index + 1}`, task: task.task, expectedFiles: task.expectedFiles };
  });
}

const matchesExpected = (filePath: string, expected: string): boolean =>
  filePath.replace(/\\/g, '/').includes(expected);

export async function runRecallBench(
  db: CodeGraphDb,
  root: string,
  options: RecallBenchOptions = {},
): Promise<RecallBenchResult> {
  const tasks = loadRecallTasks(options.tasksFile);
  const maxFiles = options.maxFiles ?? 6;
  const keepRatio = options.keepRatio ?? null;
  const recallDepths = options.recallDepths ?? [maxFiles, 10, 15];

  const indexer = new V2Indexer(db);
  const index = await indexer.indexWorkspace({ root });
  const queryService = new V2QueryService(db);

  const tag = (rightSize: boolean): ContextProofTask[] =>
    tasks.map(t => ({
      id: t.id,
      task: t.task,
      expectedFiles: t.expectedFiles,
      maxFiles,
      includeSnippets: false,
      rightSize,
      ...(keepRatio != null ? { keepRatio } : {}),
    }));

  const baseline = await runContextProofEval(db, root, tag(false), { skipIndex: true });
  const rightsized = await runContextProofEval(db, root, tag(true), { skipIndex: true });

  const recall = (result: typeof baseline, id: string, need: number): number => {
    const row = result.tasks.find(r => r.id === id);
    const missing = row?.missingExpectedFiles ?? [];
    return need === 0 ? 1 : Number(((need - missing.length) / need).toFixed(2));
  };

  const perTask: RecallBenchTaskRow[] = [];
  for (const t of tasks) {
    const rsRow = rightsized.tasks.find(r => r.id === t.id);
    const rankingCurve: Record<string, number> = {};
    for (const depth of recallDepths) {
      const search = await queryService.query({
        workspaceId: index.workspaceId,
        toolName: 'search_files',
        args: { query: t.task, maxResults: depth },
      }) as { files?: Array<Record<string, unknown>> };
      const files = (search.files ?? []).map(f => String(f.filePath ?? f.path ?? ''));
      const hit = t.expectedFiles.filter(e => files.some(f => matchesExpected(f, e))).length;
      rankingCurve[`r@${depth}`] = Number((hit / t.expectedFiles.length).toFixed(2));
    }
    perTask.push({
      id: t.id,
      need: t.expectedFiles.length,
      baselineRecall: recall(baseline, t.id, t.expectedFiles.length),
      rightsizedRecall: recall(rightsized, t.id, t.expectedFiles.length),
      rightsizedAllFound: Boolean(rsRow?.correct),
      missing: rsRow?.missingExpectedFiles ?? [],
      rankingCurve,
      rightsizedInputTokens: rsRow?.mcp.estimatedInputTokens ?? 0,
    });
  }

  const avg = (nums: number[]): number => Number((nums.reduce((s, n) => s + n, 0) / (nums.length || 1)).toFixed(2));
  const baselineAllFound = baseline.tasks.filter(r => r.correct).length;
  const rightsizedAllFound = rightsized.tasks.filter(r => r.correct).length;

  return {
    root,
    maxFiles,
    keepRatio,
    tasks: tasks.length,
    baselineAllFound: `${baselineAllFound}/${tasks.length}`,
    rightsizedAllFound: `${rightsizedAllFound}/${tasks.length}`,
    baselineAvgRecall: avg(perTask.map(r => r.baselineRecall)),
    rightsizedAvgRecall: avg(perTask.map(r => r.rightsizedRecall)),
    baselineInputTokens: baseline.totals.mcpEstimatedInputTokens,
    rightsizedInputTokens: rightsized.totals.mcpEstimatedInputTokens,
    perTask,
  };
}
