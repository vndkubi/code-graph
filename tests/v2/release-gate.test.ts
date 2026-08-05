import { describe, expect, it } from 'vitest';
import {
  evaluateReleaseGate,
  formatReleaseGateMarkdown,
  type ReleaseGateInput,
} from '../../src/v2/benchmark/release-gate.js';

function report(overrides: Partial<ReleaseGateInput> = {}): ReleaseGateInput {
  const arm = {
    freshModelInputTokens: 1000,
    wallTimeMs: 1000,
    expectedFileRecall: 0.9,
    expectedMethodRecall: 0.8,
    criticalMisses: 0,
    falseAnswerableCount: 0,
  };
  return {
    arms: {
      A: { ...arm },
      B: { ...arm, freshModelInputTokens: 900 },
      C: { ...arm, freshModelInputTokens: 950 },
      D: { ...arm, freshModelInputTokens: 600, wallTimeMs: 1200 },
    },
    staleDetectionRate: 100,
    advertisedSchemaTokenIncrease: 400,
    indexRegressionPercent: 2,
    queryRegressionPercent: 3,
    ...overrides,
  };
}

describe('release benchmark gate', () => {
  it('recommends enforce only when every A-D gate passes', () => {
    const result = evaluateReleaseGate(report());
    expect(result.passed).toBe(true);
    expect(result.recommendation).toBe('enforce');
    expect(formatReleaseGateMarkdown(result)).toContain('Result: **PASS**');
  });

  it('fails closed on false-answerable, stale, recall, and budget regressions', () => {
    const input = report({
      staleDetectionRate: 99,
      advertisedSchemaTokenIncrease: 601,
      arms: {
        ...report().arms,
        C: { ...report().arms.C, expectedFileRecall: 0.89 },
        D: { ...report().arms.D, falseAnswerableCount: 1, criticalMisses: 1, freshModelInputTokens: 800, wallTimeMs: 1400 },
      },
    });
    const result = evaluateReleaseGate(input);
    expect(result.passed).toBe(false);
    expect(result.recommendation).toBe('shadow');
    expect(result.checks.filter(check => !check.passed).map(check => check.id)).toEqual(expect.arrayContaining([
      'no-falseAnswerableCount-D',
      'recall-file-C',
      'critical-miss-D',
      'tokens-D-vs-B',
      'stale-detection',
      'advertised-schema',
    ]));
  });

  it('treats missing metrics as a failed gate rather than zero-cost success', () => {
    const input = report({ arms: { ...report().arms, D: { ...report().arms.D, freshModelInputTokens: Number.NaN } } });
    const result = evaluateReleaseGate(input);
    expect(result.passed).toBe(false);
    expect(result.checks.find(check => check.id === 'tokens-D-vs-B')).toMatchObject({ passed: false, actual: 'missing' });
  });
});
