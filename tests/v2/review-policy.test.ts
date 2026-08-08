import { describe, expect, it } from 'vitest';
import {
  buildReviewCoverage,
  normalizeReviewOutputMode,
  reviewAnswerable,
  reviewBudgetFor,
} from '../../src/v2/query/review-policy.js';

describe('review policy', () => {
  it('normalizes unknown output modes to compact', () => {
    expect(normalizeReviewOutputMode('balanced')).toBe('balanced');
    expect(normalizeReviewOutputMode('full')).toBe('full');
    expect(normalizeReviewOutputMode('unbounded')).toBe('compact');
  });

  it('keeps response budgets bounded while honoring safe overrides', () => {
    const budget = reviewBudgetFor('compact', { maxFindings: 999, maxEvidencePerFinding: 0 }, 10);
    expect(budget.maxFindings).toBe(10);
    expect(budget.maxEvidencePerFinding).toBe(1);
    expect(budget.maxRequiredToolCalls).toBeLessThanOrEqual(20);
  });

  it('fails closed for empty or incomplete coverage', () => {
    const empty = buildReviewCoverage({ changedFiles: [], diffFileCount: 0, diffHunkCount: 0, reportedHunkCount: 0, omittedGraphFiles: [] });
    expect(empty.complete).toBe(false);
    expect(reviewAnswerable([], empty)).toBe(false);

    const incomplete = buildReviewCoverage({
      changedFiles: ['src/a.ts'],
      diffFileCount: 2,
      diffHunkCount: 2,
      reportedHunkCount: 1,
      omittedGraphFiles: ['src/b.ts'],
    });
    expect(incomplete.complete).toBe(false);
    expect(reviewAnswerable(['src/a.ts'], incomplete)).toBe(false);
  });

  it('returns answerable only when files and all hunks are covered', () => {
    const coverage = buildReviewCoverage({
      changedFiles: ['src/a.ts'],
      diffFileCount: 1,
      diffHunkCount: 2,
      reportedHunkCount: 2,
      omittedGraphFiles: [],
    });
    expect(coverage.complete).toBe(true);
    expect(reviewAnswerable(['src/a.ts'], coverage)).toBe(true);
  });
});
