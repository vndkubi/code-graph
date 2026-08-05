import fs from 'node:fs';
import path from 'node:path';

export type ReleaseArm = 'A' | 'B' | 'C' | 'D';

export interface ReleaseArmMetrics {
  /** Fresh model-input tokens, excluding cached context. */
  freshModelInputTokens: number;
  wallTimeMs: number;
  expectedFileRecall: number;
  expectedMethodRecall: number;
  criticalMisses: number;
  falseAnswerableCount: number;
}

export interface ReleaseGateInput {
  arms: Record<ReleaseArm, ReleaseArmMetrics>;
  staleDetectionRate: number;
  advertisedSchemaTokenIncrease: number;
  indexRegressionPercent: number;
  queryRegressionPercent: number;
}

export interface ReleaseGateCheck {
  id: string;
  passed: boolean;
  actual: number | string;
  expected: string;
  reason: string;
}

export interface ReleaseGateResult {
  passed: boolean;
  recommendation: 'shadow' | 'enforce';
  checks: ReleaseGateCheck[];
}

/** Read a benchmark matrix without silently accepting a partial report. */
export function loadReleaseGateInput(reportPath: string): ReleaseGateInput {
  const resolved = path.resolve(reportPath);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as Partial<ReleaseGateInput>;
  if (!parsed || typeof parsed !== 'object' || !parsed.arms) {
    throw new Error(`Release gate report has no arms matrix: ${resolved}`);
  }
  for (const arm of ['A', 'B', 'C', 'D'] as const) {
    const metrics = parsed.arms[arm];
    if (!metrics || typeof metrics !== 'object') throw new Error(`Release gate report is missing arm ${arm}: ${resolved}`);
  }
  return parsed as ReleaseGateInput;
}

/**
 * Evaluate the published A–D rollout contract. Missing/invalid metrics fail
 * closed and recommend shadow mode; this function never enables enforcement by
 * mutating environment or process state.
 */
export function evaluateReleaseGate(input: ReleaseGateInput): ReleaseGateResult {
  const checks: ReleaseGateCheck[] = [];
  const arm = (key: ReleaseArm): ReleaseArmMetrics => input.arms[key];
  const allArms = (key: keyof ReleaseArmMetrics, expected: string, predicate: (value: number) => boolean, reason: string): void => {
    for (const keyArm of ['A', 'B', 'C', 'D'] as const) {
      const value = arm(keyArm)[key];
      checks.push(numericCheck(`no-${String(key)}-${keyArm}`, value, expected, predicate, reason));
    }
  };

  allArms('falseAnswerableCount', '= 0', value => value === 0, 'Adversarial or unknown prompts must never be reported answerable without sufficient evidence.');
  for (const keyArm of ['C', 'D'] as const) {
    const metrics = arm(keyArm);
    const fileBaseline = Math.max(arm('A').expectedFileRecall, arm('B').expectedFileRecall);
    const methodBaseline = Math.max(arm('A').expectedMethodRecall, arm('B').expectedMethodRecall);
    checks.push(numericCheck(`recall-file-${keyArm}`, metrics.expectedFileRecall, `>= ${fileBaseline}`, value => value >= fileBaseline, 'Host-driven arms must not lose expected-file recall versus either baseline.'));
    checks.push(numericCheck(`recall-method-${keyArm}`, metrics.expectedMethodRecall, `>= ${methodBaseline}`, value => value >= methodBaseline, 'Host-driven arms must not lose expected-method recall versus either baseline.'));
    checks.push(numericCheck(`critical-miss-${keyArm}`, metrics.criticalMisses, '= 0', value => value === 0, 'A critical expected-file or method miss blocks release.'));
  }

  const dVsB = percentReduction(arm('B').freshModelInputTokens, arm('D').freshModelInputTokens);
  const dVsA = percentReduction(arm('A').freshModelInputTokens, arm('D').freshModelInputTokens);
  const cVsB = percentIncrease(arm('B').freshModelInputTokens, arm('C').freshModelInputTokens);
  const dWallVsB = percentIncrease(arm('B').wallTimeMs, arm('D').wallTimeMs);
  checks.push(numericCheck('tokens-D-vs-B', dVsB, '>= 20%', value => value >= 20, 'Resume arm D must reduce fresh model-input tokens by at least 20% versus legacy MCP B.'));
  checks.push(numericCheck('tokens-D-vs-A', dVsA, '>= 30%', value => value >= 30, 'Resume arm D must reduce fresh model-input tokens by at least 30% versus no-MCP A.'));
  checks.push(numericCheck('tokens-C-vs-B', cVsB, '<= 10%', value => value <= 10, 'Single-phase host scope C must not add more than 10% tokens versus B.'));
  checks.push(numericCheck('wall-D-vs-B', dWallVsB, '<= 30%', value => value <= 30, 'Resume arm D must stay within B plus 30% wall time.'));
  checks.push(numericCheck('stale-detection', input.staleDetectionRate, '= 100%', value => value === 100, 'Forced repository changes must invalidate all stale evidence.'));
  checks.push(numericCheck('advertised-schema', input.advertisedSchemaTokenIncrease, '<= 600', value => value <= 600, 'Advertised MCP schema growth must remain within the 600-token budget.'));
  checks.push(numericCheck('index-regression', input.indexRegressionPercent, '<= 5%', value => value <= 5, 'Index benchmark regression must be at most 5%.'));
  checks.push(numericCheck('query-regression', input.queryRegressionPercent, '<= 5%', value => value <= 5, 'Query benchmark regression must be at most 5%.'));

  const passed = checks.every(check => check.passed);
  return { passed, recommendation: passed ? 'enforce' : 'shadow', checks };
}

export function formatReleaseGateMarkdown(result: ReleaseGateResult): string {
  const lines = [
    '# CodeGraph release gate',
    '',
    `Result: **${result.passed ? 'PASS' : 'FAIL'}**`,
    `Recommendation: \`${result.recommendation}\``,
    '',
    '| Check | Status | Actual | Expected |',
    '| --- | --- | ---: | --- |',
    ...result.checks.map(check => `| ${check.id} | ${check.passed ? 'pass' : 'fail'} | ${formatValue(check.actual)} | ${check.expected} |`),
    '',
    ...result.checks.filter(check => !check.passed).map(check => `- **${check.id}:** ${check.reason}`),
  ];
  return `${lines.join('\n')}\n`;
}

function numericCheck(
  id: string,
  actual: unknown,
  expected: string,
  predicate: (value: number) => boolean,
  reason: string,
): ReleaseGateCheck {
  const value = typeof actual === 'number' && Number.isFinite(actual) ? actual : undefined;
  return {
    id,
    passed: value !== undefined && predicate(value),
    actual: value ?? 'missing',
    expected,
    reason,
  };
}

function percentReduction(baseline: number, candidate: number): number {
  if (!Number.isFinite(baseline) || !Number.isFinite(candidate) || baseline <= 0) return Number.NaN;
  return ((baseline - candidate) / baseline) * 100;
}

function percentIncrease(baseline: number, candidate: number): number {
  if (!Number.isFinite(baseline) || !Number.isFinite(candidate) || baseline <= 0) return Number.NaN;
  return ((candidate - baseline) / baseline) * 100;
}

function formatValue(value: number | string): string {
  return typeof value === 'number' ? Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : 'missing' : value;
}
