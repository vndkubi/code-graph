import type { CodeGraphDb } from '../storage/database.js';
import { deriveContextProofTasks, loadContextProofTasks, runContextProofEval } from './context-proof.js';

/**
 * Evidence right-sizing audit (Waste% / Gap%). The core retrieval objective is
 * to give the agent EXACTLY the evidence it needs — no more (wasted input
 * tokens) and no less (a gap the agent must grep to fill). This audit measures
 * both on the deterministic context-proof suite, with no live agent:
 *
 * - For each task, find the SMALLEST maxFiles that still yields correct=true.
 *   The gap between that minimum and the default packet size is over-delivery
 *   (Waste). A task that never passes at any size is a coverage Gap (ranking
 *   can't surface the needed evidence — more files won't help).
 * - Compare total input tokens at the default size vs the right-sized packets.
 *
 * Drive Waste% down to cut input tokens; drive Gap% to zero to raise quality.
 */
export interface EvidenceAuditTask {
  id: string;
  minFiles: number | null; // null => never correct within cap (Gap)
  gap: boolean;
}

export interface EvidenceAuditResult {
  tasks: number;
  defaultMaxFiles: number;
  maxFilesCap: number;
  perTask: EvidenceAuditTask[];
  gapTasks: number;
  gapPct: number;
  defaultInputTokens: number;
  rightsizedInputTokens: number;
  tokenWastePct: number;
  defaultFilesDelivered: number;
  rightsizedFilesDelivered: number;
  fileWastePct: number;
}

export interface EvidenceAuditOptions {
  tasksFile?: string;
  defaultMaxFiles?: number;
  maxFilesCap?: number;
}

function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export async function runEvidenceAudit(
  db: CodeGraphDb,
  root: string,
  options: EvidenceAuditOptions = {},
): Promise<EvidenceAuditResult> {
  const defaultMaxFiles = options.defaultMaxFiles ?? 6;
  const cap = options.maxFilesCap ?? defaultMaxFiles;
  const base = options.tasksFile
    ? loadContextProofTasks(options.tasksFile)
    : deriveContextProofTasks(root);

  const sizes: number[] = [];
  for (let n = 1; n <= cap; n += 1) sizes.push(n);

  // Per-task minimum maxFiles for correctness (other tasks pinned at cap so each
  // task is isolated).
  const perTask: EvidenceAuditTask[] = [];
  for (const task of base) {
    let min: number | null = null;
    for (const size of sizes) {
      const tasks = base.map(t => ({ ...t, maxFiles: t.id === task.id ? size : cap }));
      const result = await runContextProofEval(db, root, tasks, { skipIndex: true });
      const row = result.tasks.find(r => r.id === task.id);
      if (row?.correct) { min = size; break; }
    }
    perTask.push({ id: task.id, minFiles: min, gap: min === null });
  }

  // Default-size run vs right-sized run (gap tasks pinned at cap).
  const defaultRun = await runContextProofEval(db, root, base.map(t => ({ ...t, maxFiles: defaultMaxFiles })), { skipIndex: true });
  const rightsizedRun = await runContextProofEval(db, root, base.map(t => {
    const audit = perTask.find(p => p.id === t.id);
    return { ...t, maxFiles: audit?.minFiles ?? cap };
  }), { skipIndex: true });

  const defaultInputTokens = Number(defaultRun.totals.mcpEstimatedInputTokens ?? 0);
  const rightsizedInputTokens = Number(rightsizedRun.totals.mcpEstimatedInputTokens ?? 0);
  const gapTasks = perTask.filter(p => p.gap).length;
  const defaultFilesDelivered = base.length * defaultMaxFiles;
  const rightsizedFilesDelivered = perTask.reduce((sum, p) => sum + (p.minFiles ?? cap), 0);

  return {
    tasks: base.length,
    defaultMaxFiles,
    maxFilesCap: cap,
    perTask,
    gapTasks,
    gapPct: base.length > 0 ? round(gapTasks / base.length) : 0,
    defaultInputTokens,
    rightsizedInputTokens,
    tokenWastePct: defaultInputTokens > 0 ? round(1 - rightsizedInputTokens / defaultInputTokens) : 0,
    defaultFilesDelivered,
    rightsizedFilesDelivered,
    fileWastePct: defaultFilesDelivered > 0 ? round(1 - rightsizedFilesDelivered / defaultFilesDelivered) : 0,
  };
}
