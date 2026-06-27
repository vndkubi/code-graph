import fs from 'node:fs';
import path from 'node:path';
import type { CodeGraphDb } from '../storage/database.js';
import { loadGoldenEvalTasks, runGoldenEval } from './golden-eval.js';
import { deriveContextProofTasks, runContextProofEval } from './context-proof.js';
import { deriveReviewProofTasks, runReviewProofEval } from './review-proof.js';
import { runRouteGateBenchmark } from './route-gate.js';

/**
 * Continuous retrieval-quality telemetry (P10). Runs the deterministic
 * self-repo proofs and emits one normalized row so ranking/resolver
 * regressions surface as a trend over time instead of going unnoticed between
 * ad-hoc benchmark runs.
 */
export interface QualityTrendRow {
  timestamp: string;
  golden: { correct: number; tasks: number; tokenSavingPct: number };
  context: { correct: number; tasks: number; qualityMaintained: boolean; inputTokenSavingPct: number };
  review: { correct: number; tasks: number; qualityMaintained: boolean; inputTokenSavingPct: number };
  routeGate: { passed: number; tasks: number };
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function runQualityTrend(
  db: CodeGraphDb,
  root: string,
  timestamp: string,
): Promise<QualityTrendRow> {
  const golden = await runGoldenEval(db, root, loadGoldenEvalTasks()) as { totals?: Record<string, unknown> };
  const context = await runContextProofEval(db, root, deriveContextProofTasks(root), { skipIndex: true }) as { totals?: Record<string, unknown> };
  const review = await runReviewProofEval(db, root, deriveReviewProofTasks(root), { skipIndex: true }) as { totals?: Record<string, unknown> };
  const routeGate = runRouteGateBenchmark();

  const g = golden.totals ?? {};
  const c = context.totals ?? {};
  const r = review.totals ?? {};
  const rg = routeGate.totals;
  return {
    timestamp,
    golden: {
      correct: num(g.correct),
      tasks: num(g.tasks),
      tokenSavingPct: num(g.tokenSavingPct),
    },
    context: {
      correct: num(c.mcpCorrect),
      tasks: num(c.tasks),
      qualityMaintained: Boolean(c.qualityMaintained),
      inputTokenSavingPct: num(c.inputTokenSavingPct),
    },
    review: {
      correct: num(r.mcpCorrect),
      tasks: num(r.tasks),
      qualityMaintained: Boolean(r.qualityMaintained),
      inputTokenSavingPct: num(r.inputTokenSavingPct),
    },
    routeGate: {
      passed: num(rg.passed),
      tasks: num(rg.tasks),
    },
  };
}

const TREND_HEADER = [
  '| Timestamp | Golden | Ctx | Ctx quality | Ctx save | Review | Review save | Route-gate |',
  '| --- | --- | --- | --- | ---: | --- | ---: | --- |',
];

function formatPct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

export function formatQualityTrendRow(row: QualityTrendRow): string {
  const cells = [
    row.timestamp,
    `${row.golden.correct}/${row.golden.tasks}`,
    `${row.context.correct}/${row.context.tasks}`,
    row.context.qualityMaintained ? 'ok' : 'DROP',
    formatPct(row.context.inputTokenSavingPct),
    `${row.review.correct}/${row.review.tasks}`,
    formatPct(row.review.inputTokenSavingPct),
    `${row.routeGate.passed}/${row.routeGate.tasks}`,
  ];
  return `| ${cells.join(' | ')} |`;
}

/** Append a trend row to a markdown report, creating it with a header if new. */
export function appendQualityTrend(reportPath: string, row: QualityTrendRow): void {
  const absolute = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const line = formatQualityTrendRow(row);
  if (!fs.existsSync(absolute)) {
    const preamble = [
      '# CodeGraph retrieval-quality trend',
      '',
      'Appended by `codegraph benchmark quality-trend`. Each row is one run of the',
      'deterministic self-repo proofs. Watch for `DROP` in Ctx quality or falling',
      'correct counts — those flag a ranking/resolver regression.',
      '',
      ...TREND_HEADER,
      line,
      '',
    ].join('\n');
    fs.writeFileSync(absolute, preamble);
    return;
  }
  fs.appendFileSync(absolute, `${line}\n`);
}
