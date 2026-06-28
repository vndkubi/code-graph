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
 * - Also compare rightSize=ON vs rightSize=OFF at the same maxFiles to measure
 *   the relevance-cliff trimming effect independently.
 *
 * Drive Waste% down to cut input tokens; drive Gap% to zero to raise quality.
 */
export interface EvidenceAuditTask {
  id: string;
  minFiles: number | null; // null => never correct within cap (Gap)
  gap: boolean;
  gapReason?: string;     // present only when --list-gaps is on
}

export interface EvidenceAuditResult {
  tasks: number;
  defaultMaxFiles: number;
  maxFilesCap: number;
  keepRatio: number;
  perTask: EvidenceAuditTask[];
  gapTasks: number;
  gapPct: number;
  /** Tokens with rightSize=OFF, maxFiles=defaultMaxFiles */
  defaultInputTokens: number;
  /** Tokens with rightSize=ON, maxFiles=defaultMaxFiles */
  rightsizedInputTokens: number;
  tokenWastePct: number;
  defaultFilesDelivered: number;
  rightsizedFilesDelivered: number;
  fileWastePct: number;
  /** Tokens with minimum files per task (oracle lower-bound, rightSize=OFF) */
  minFilesInputTokens: number;
  /** How much more the right-sizer could save vs oracle lower-bound */
  rightsizeVsOraclePct: number;
}

export interface EvidenceAuditOptions {
  tasksFile?: string;
  defaultMaxFiles?: number;
  maxFilesCap?: number;
  keepRatio?: number;
  listGaps?: boolean;
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
  const keepRatio = options.keepRatio ?? 0.5;
  const listGaps = options.listGaps ?? false;
  const base = options.tasksFile
    ? loadContextProofTasks(options.tasksFile)
    : deriveContextProofTasks(root);

  const sizes: number[] = [];
  for (let n = 1; n <= cap; n += 1) sizes.push(n);

  // Per-task minimum maxFiles for correctness (other tasks pinned at cap so
  // each task is isolated). Uses rightSize=OFF so we measure the true minimum
  // ignoring trimming — this is the gap/waste oracle.
  const perTask: EvidenceAuditTask[] = [];
  for (const task of base) {
    let min: number | null = null;
    for (const size of sizes) {
      const tasks = base.map(t => ({
        ...t,
        maxFiles: t.id === task.id ? size : cap,
        rightSize: false,
      }));
      const result = await runContextProofEval(db, root, tasks, { skipIndex: true });
      const row = result.tasks.find(r => r.id === task.id);
      if (row?.correct) { min = size; break; }
    }
    const gapEntry: EvidenceAuditTask = { id: task.id, minFiles: min, gap: min === null };
    if (listGaps && min === null) {
      gapEntry.gapReason = `Task "${task.task}" (id: ${task.id}) never correct up to cap=${cap}. `
        + `Expected: [${(task.expectedContains ?? []).join(', ')}]; files: [${(task.expectedFiles ?? []).join(', ')}].`;
    }
    perTask.push(gapEntry);
  }

  // Default-size run (rightSize=OFF, maxFiles=defaultMaxFiles).
  const defaultRun = await runContextProofEval(db, root, base.map(t => ({
    ...t,
    maxFiles: defaultMaxFiles,
    rightSize: false,
  })), { skipIndex: true });

  // Right-sized run (rightSize=ON, same maxFiles — trimming does the cutting).
  const rightsizedRun = await runContextProofEval(db, root, base.map(t => ({
    ...t,
    maxFiles: defaultMaxFiles,
    rightSize: true,
    keepRatio,
  })), { skipIndex: true });

  // Oracle lower-bound: each task gets its theoretical minimum (gap tasks: cap).
  const oracleRun = await runContextProofEval(db, root, base.map(t => {
    const audit = perTask.find(p => p.id === t.id);
    return { ...t, maxFiles: audit?.minFiles ?? cap, rightSize: false };
  }), { skipIndex: true });

  const defaultInputTokens = Number(defaultRun.totals.mcpEstimatedInputTokens ?? 0);
  const rightsizedInputTokens = Number(rightsizedRun.totals.mcpEstimatedInputTokens ?? 0);
  const minFilesInputTokens = Number(oracleRun.totals.mcpEstimatedInputTokens ?? 0);
  const gapTasks = perTask.filter(p => p.gap).length;

  // File counts: default vs right-sized. For right-sizing, we don't have per-task
  // file counts directly, so estimate from token ratio (monotonic with file count).
  // For default/oracle we compute from maxFiles settings.
  const defaultFilesDelivered = base.length * defaultMaxFiles;
  const rightsizedFilesDelivered = defaultInputTokens > 0
    ? Math.round(defaultFilesDelivered * (rightsizedInputTokens / defaultInputTokens))
    : defaultFilesDelivered;

  return {
    tasks: base.length,
    defaultMaxFiles,
    maxFilesCap: cap,
    keepRatio,
    perTask,
    gapTasks,
    gapPct: base.length > 0 ? round(gapTasks / base.length) : 0,
    defaultInputTokens,
    rightsizedInputTokens,
    tokenWastePct: defaultInputTokens > 0 ? round(1 - rightsizedInputTokens / defaultInputTokens) : 0,
    defaultFilesDelivered,
    rightsizedFilesDelivered,
    fileWastePct: defaultFilesDelivered > 0 ? round(1 - rightsizedFilesDelivered / defaultFilesDelivered) : 0,
    minFilesInputTokens,
    rightsizeVsOraclePct: minFilesInputTokens > 0 && rightsizedInputTokens > 0
      ? round(1 - minFilesInputTokens / rightsizedInputTokens)
      : 0,
  };
}
