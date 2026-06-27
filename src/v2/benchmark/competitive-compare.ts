import fs from 'node:fs';
import path from 'node:path';
import type { CodexE2eBenchmarkReport, CodexRunResult } from './codex-e2e.js';

export interface CompetitiveCompareOptions {
  oursPath: string;
  theirsPath: string;
  oursLabel?: string;
  theirsLabel?: string;
}

export interface CompetitiveArmMetrics {
  runs: number;
  averageQuality: number;
  totalFreshTokens: number;
  totalToolCalls: number;
  totalMcpCalls: number;
  totalShellCalls: number;
  totalWallMs: number;
  stopViolationCalls: number;
  exitFailures: number;
}

export interface CompetitiveTaskComparison {
  taskId: string;
  winner: 'ours' | 'theirs' | 'tie' | 'inconclusive';
  reasons: string[];
  ours: CompetitiveArmMetrics;
  theirs: CompetitiveArmMetrics;
}

export interface CompetitiveComparisonReport {
  comparedAt: string;
  oursLabel: string;
  theirsLabel: string;
  oursPath: string;
  theirsPath: string;
  commonTaskCount: number;
  missingFromOurs: string[];
  missingFromTheirs: string[];
  tasks: CompetitiveTaskComparison[];
  aggregate: {
    winner: 'ours' | 'theirs' | 'tie' | 'inconclusive';
    oursWins: number;
    theirsWins: number;
    ties: number;
    inconclusive: number;
    ours: CompetitiveArmMetrics;
    theirs: CompetitiveArmMetrics;
    freshTokenDeltaPercent: number;
    toolCallDeltaPercent: number;
    shellCallDeltaPercent: number;
    wallTimeDeltaPercent: number;
  };
}

export function compareCodexE2eReports(options: CompetitiveCompareOptions): CompetitiveComparisonReport {
  const ours = readReport(options.oursPath);
  const theirs = readReport(options.theirsPath);
  const oursByTask = groupRunsByTask(ours.runs ?? []);
  const theirsByTask = groupRunsByTask(theirs.runs ?? []);
  const oursTasks = new Set(oursByTask.keys());
  const theirsTasks = new Set(theirsByTask.keys());
  const commonTasks = [...oursTasks].filter(task => theirsTasks.has(task)).sort();
  const tasks = commonTasks.map(taskId => compareTask(
    taskId,
    summarizeRuns(oursByTask.get(taskId) ?? []),
    summarizeRuns(theirsByTask.get(taskId) ?? []),
  ));
  const oursAggregate = summarizeRuns(ours.runs ?? []);
  const theirsAggregate = summarizeRuns(theirs.runs ?? []);
  const oursWins = tasks.filter(task => task.winner === 'ours').length;
  const theirsWins = tasks.filter(task => task.winner === 'theirs').length;
  const ties = tasks.filter(task => task.winner === 'tie').length;
  const inconclusive = tasks.filter(task => task.winner === 'inconclusive').length;
  return {
    comparedAt: new Date().toISOString(),
    oursLabel: options.oursLabel ?? ours.suite ?? 'ours',
    theirsLabel: options.theirsLabel ?? theirs.suite ?? 'theirs',
    oursPath: path.resolve(options.oursPath),
    theirsPath: path.resolve(options.theirsPath),
    commonTaskCount: commonTasks.length,
    missingFromOurs: [...theirsTasks].filter(task => !oursTasks.has(task)).sort(),
    missingFromTheirs: [...oursTasks].filter(task => !theirsTasks.has(task)).sort(),
    tasks,
    aggregate: {
      winner: aggregateWinner(oursWins, theirsWins, ties, inconclusive),
      oursWins,
      theirsWins,
      ties,
      inconclusive,
      ours: oursAggregate,
      theirs: theirsAggregate,
      freshTokenDeltaPercent: percentDelta(oursAggregate.totalFreshTokens, theirsAggregate.totalFreshTokens),
      toolCallDeltaPercent: percentDelta(oursAggregate.totalToolCalls, theirsAggregate.totalToolCalls),
      shellCallDeltaPercent: percentDelta(oursAggregate.totalShellCalls, theirsAggregate.totalShellCalls),
      wallTimeDeltaPercent: percentDelta(oursAggregate.totalWallMs, theirsAggregate.totalWallMs),
    },
  };
}

export function formatCompetitiveComparisonMarkdown(report: CompetitiveComparisonReport): string {
  const lines = [
    `# Competitive CodeGraph Comparison`,
    '',
    `Compared at: ${report.comparedAt}`,
    '',
    `| Arm | Label | Report |`,
    `| --- | --- | --- |`,
    `| Ours | ${escapeMarkdown(report.oursLabel)} | \`${report.oursPath}\` |`,
    `| Theirs | ${escapeMarkdown(report.theirsLabel)} | \`${report.theirsPath}\` |`,
    '',
    `## Aggregate`,
    '',
    `Winner: **${report.aggregate.winner}**`,
    '',
    `| Metric | Ours | Theirs | Delta vs Theirs |`,
    `| --- | ---: | ---: | ---: |`,
    `| Wins | ${report.aggregate.oursWins} | ${report.aggregate.theirsWins} |  |`,
    `| Ties | ${report.aggregate.ties} |  |  |`,
    `| Inconclusive | ${report.aggregate.inconclusive} |  |  |`,
    `| Runs | ${report.aggregate.ours.runs} | ${report.aggregate.theirs.runs} |  |`,
    `| Avg quality | ${report.aggregate.ours.averageQuality} | ${report.aggregate.theirs.averageQuality} | ${round(report.aggregate.ours.averageQuality - report.aggregate.theirs.averageQuality)} |`,
    `| Fresh tokens | ${report.aggregate.ours.totalFreshTokens} | ${report.aggregate.theirs.totalFreshTokens} | ${report.aggregate.freshTokenDeltaPercent}% |`,
    `| Tool calls | ${report.aggregate.ours.totalToolCalls} | ${report.aggregate.theirs.totalToolCalls} | ${report.aggregate.toolCallDeltaPercent}% |`,
    `| Shell calls | ${report.aggregate.ours.totalShellCalls} | ${report.aggregate.theirs.totalShellCalls} | ${report.aggregate.shellCallDeltaPercent}% |`,
    `| Wall ms | ${report.aggregate.ours.totalWallMs} | ${report.aggregate.theirs.totalWallMs} | ${report.aggregate.wallTimeDeltaPercent}% |`,
    `| Stop violations | ${report.aggregate.ours.stopViolationCalls} | ${report.aggregate.theirs.stopViolationCalls} |  |`,
    '',
    `## Prompt-Class Results`,
    '',
    `| Task | Winner | Quality ours/theirs | Fresh tokens ours/theirs | Tool calls ours/theirs | Stop violations ours/theirs | Reasons |`,
    `| --- | --- | ---: | ---: | ---: | ---: | --- |`,
    ...report.tasks.map(task => `| ${escapeMarkdown(task.taskId)} | ${task.winner} | ${task.ours.averageQuality}/${task.theirs.averageQuality} | ${task.ours.totalFreshTokens}/${task.theirs.totalFreshTokens} | ${task.ours.totalToolCalls}/${task.theirs.totalToolCalls} | ${task.ours.stopViolationCalls}/${task.theirs.stopViolationCalls} | ${escapeMarkdown(task.reasons.join('; '))} |`),
  ];

  if (report.missingFromOurs.length > 0 || report.missingFromTheirs.length > 0) {
    lines.push(
      '',
      `## Missing Tasks`,
      '',
      `Missing from ours: ${report.missingFromOurs.length ? report.missingFromOurs.map(item => `\`${item}\``).join(', ') : 'none'}`,
      '',
      `Missing from theirs: ${report.missingFromTheirs.length ? report.missingFromTheirs.map(item => `\`${item}\``).join(', ') : 'none'}`,
    );
  }

  return `${lines.join('\n')}\n`;
}

function readReport(filePath: string): CodexE2eBenchmarkReport {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf-8')) as CodexE2eBenchmarkReport;
}

function groupRunsByTask(runs: CodexRunResult[]): Map<string, CodexRunResult[]> {
  const grouped = new Map<string, CodexRunResult[]>();
  for (const run of runs) {
    const entries = grouped.get(run.taskId) ?? [];
    entries.push(run);
    grouped.set(run.taskId, entries);
  }
  return grouped;
}

function summarizeRuns(runs: CodexRunResult[]): CompetitiveArmMetrics {
  const totalFreshTokens = runs.reduce((sum, run) => sum + runFreshTokens(run), 0);
  const totalQuality = runs.reduce((sum, run) => sum + Number(run.quality?.score ?? 0), 0);
  return {
    runs: runs.length,
    averageQuality: runs.length === 0 ? 0 : round(totalQuality / runs.length),
    totalFreshTokens,
    totalToolCalls: runs.reduce((sum, run) => sum + Number(run.toolCalls ?? 0), 0),
    totalMcpCalls: runs.reduce((sum, run) => sum + Number(run.mcpCalls ?? 0), 0),
    totalShellCalls: runs.reduce((sum, run) => sum + Number(run.shellCalls ?? 0), 0),
    totalWallMs: runs.reduce((sum, run) => sum + Number(run.wallMs ?? 0), 0),
    stopViolationCalls: runs.reduce((sum, run) => sum + Number(run.tokenLedger?.shellAfterExactFollowupCalls ?? 0), 0),
    exitFailures: runs.filter(run => run.exitStatus !== 0).length,
  };
}

function runFreshTokens(run: CodexRunResult): number {
  const ledgerTotal = Number(run.tokenLedger?.modelFreshTotalTokens ?? 0);
  if (ledgerTotal > 0) return ledgerTotal;
  return Number(run.inputTokens ?? 0) + Number(run.outputTokens ?? 0);
}

function compareTask(taskId: string, ours: CompetitiveArmMetrics, theirs: CompetitiveArmMetrics): CompetitiveTaskComparison {
  const reasons: string[] = [];
  if (ours.runs === 0 || theirs.runs === 0) {
    return { taskId, winner: 'inconclusive', reasons: ['missing runs for one arm'], ours, theirs };
  }
  if (ours.exitFailures > 0 || theirs.exitFailures > 0) reasons.push('one or more runs exited non-zero');
  const qualityDelta = ours.averageQuality - theirs.averageQuality;
  if (qualityDelta > 0.001) reasons.push(`higher quality by ${round(qualityDelta)}`);
  if (qualityDelta < -0.001) reasons.push(`lower quality by ${round(Math.abs(qualityDelta))}`);
  if (ours.stopViolationCalls < theirs.stopViolationCalls) reasons.push('fewer stop-rule violations');
  if (ours.stopViolationCalls > theirs.stopViolationCalls) reasons.push('more stop-rule violations');
  if (ours.totalFreshTokens < theirs.totalFreshTokens) reasons.push(`${Math.abs(percentDelta(ours.totalFreshTokens, theirs.totalFreshTokens))}% fewer fresh tokens`);
  if (ours.totalFreshTokens > theirs.totalFreshTokens) reasons.push(`${percentDelta(ours.totalFreshTokens, theirs.totalFreshTokens)}% more fresh tokens`);
  if (ours.totalToolCalls < theirs.totalToolCalls) reasons.push(`${Math.abs(percentDelta(ours.totalToolCalls, theirs.totalToolCalls))}% fewer tool calls`);
  if (ours.totalToolCalls > theirs.totalToolCalls) reasons.push(`${percentDelta(ours.totalToolCalls, theirs.totalToolCalls)}% more tool calls`);

  const winner = taskWinner(ours, theirs);
  if (reasons.length === 0) reasons.push('metrics are equal within thresholds');
  return { taskId, winner, reasons, ours, theirs };
}

function taskWinner(ours: CompetitiveArmMetrics, theirs: CompetitiveArmMetrics): CompetitiveTaskComparison['winner'] {
  if (ours.exitFailures > 0 && theirs.exitFailures === 0) return 'theirs';
  if (theirs.exitFailures > 0 && ours.exitFailures === 0) return 'ours';
  const qualityDelta = ours.averageQuality - theirs.averageQuality;
  if (qualityDelta > 0.05) return 'ours';
  if (qualityDelta < -0.05) return 'theirs';
  if (ours.stopViolationCalls < theirs.stopViolationCalls) return 'ours';
  if (ours.stopViolationCalls > theirs.stopViolationCalls) return 'theirs';
  const tokenDelta = percentDelta(ours.totalFreshTokens, theirs.totalFreshTokens);
  const toolDelta = percentDelta(ours.totalToolCalls, theirs.totalToolCalls);
  if (tokenDelta <= -5 || toolDelta <= -10) return 'ours';
  if (tokenDelta >= 5 || toolDelta >= 10) return 'theirs';
  return 'tie';
}

function aggregateWinner(
  oursWins: number,
  theirsWins: number,
  ties: number,
  inconclusive: number,
): CompetitiveComparisonReport['aggregate']['winner'] {
  if (inconclusive > 0 && oursWins === 0 && theirsWins === 0 && ties === 0) return 'inconclusive';
  if (oursWins > theirsWins) return 'ours';
  if (theirsWins > oursWins) return 'theirs';
  if (ties > 0) return 'tie';
  return 'inconclusive';
}

function percentDelta(value: number, baseline: number): number {
  if (baseline === 0) return value === 0 ? 0 : 100;
  return round(((value - baseline) / baseline) * 100);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
