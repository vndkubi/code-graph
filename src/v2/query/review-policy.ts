/** Pure review response policy. No database, filesystem, or query-service state. */

export type ReviewOutputMode = 'compact' | 'balanced' | 'full';

export interface ReviewBudget {
  outputMode: ReviewOutputMode;
  maxFindings: number;
  maxLineFocus: number;
  maxReviewTargets: number;
  maxRiskFlags: number;
  maxTests: number;
  maxEvidencePerFinding: number;
  maxRequiredToolCalls: number;
}

export interface ReviewCoverage {
  complete: boolean;
  diffFileCount: number;
  graphResolvedFileCount: number;
  omittedGraphFileCount: number;
  omittedGraphFiles: string[];
  omittedGraphFilesTruncated: boolean;
  diffHunkCount: number;
  reportedHunkCount: number;
  omittedHunkCount: number;
  batchingRequired: boolean;
}

export function normalizeReviewOutputMode(value: string): ReviewOutputMode {
  if (value === 'balanced' || value === 'full') return value;
  return 'compact';
}

export function reviewBudgetFor(outputMode: ReviewOutputMode, args: Record<string, unknown>, limit: number): ReviewBudget {
  const defaults = outputMode === 'full'
    ? { maxFindings: limit, maxLineFocus: limit, maxReviewTargets: Math.min(limit, 20), maxRiskFlags: limit, maxTests: Math.min(limit, 50), maxEvidencePerFinding: 12, maxRequiredToolCalls: 8 }
    : outputMode === 'balanced'
      ? { maxFindings: 10, maxLineFocus: 20, maxReviewTargets: 10, maxRiskFlags: 12, maxTests: 8, maxEvidencePerFinding: 5, maxRequiredToolCalls: 4 }
      : { maxFindings: 6, maxLineFocus: 10, maxReviewTargets: 6, maxRiskFlags: 8, maxTests: 5, maxEvidencePerFinding: 3, maxRequiredToolCalls: 3 };
  return {
    outputMode,
    maxFindings: clampInt(Number(args.maxFindings ?? defaults.maxFindings), 1, limit),
    maxLineFocus: clampInt(Number(args.maxLineFocus ?? defaults.maxLineFocus), 1, limit),
    maxReviewTargets: clampInt(defaults.maxReviewTargets, 1, limit),
    maxRiskFlags: clampInt(defaults.maxRiskFlags, 1, limit),
    maxTests: clampInt(defaults.maxTests, 0, limit),
    maxEvidencePerFinding: clampInt(Number(args.maxEvidencePerFinding ?? defaults.maxEvidencePerFinding), 1, 20),
    maxRequiredToolCalls: clampInt(Number(args.maxRequiredToolCalls ?? defaults.maxRequiredToolCalls), 1, 20),
  };
}

export function buildReviewCoverage(input: {
  changedFiles: string[];
  diffFileCount: number;
  diffHunkCount: number;
  reportedHunkCount: number;
  omittedGraphFiles: string[];
}): ReviewCoverage {
  const omittedGraphFiles = [...new Set(input.omittedGraphFiles)];
  return {
    complete: input.changedFiles.length > 0
      && omittedGraphFiles.length === 0
      && input.reportedHunkCount === input.diffHunkCount,
    diffFileCount: input.diffFileCount,
    graphResolvedFileCount: input.changedFiles.length,
    omittedGraphFileCount: omittedGraphFiles.length,
    omittedGraphFiles: omittedGraphFiles.slice(0, 20),
    omittedGraphFilesTruncated: omittedGraphFiles.length > 20,
    diffHunkCount: input.diffHunkCount,
    reportedHunkCount: input.reportedHunkCount,
    omittedHunkCount: Math.max(0, input.diffHunkCount - input.reportedHunkCount),
    batchingRequired: omittedGraphFiles.length > 0 || input.reportedHunkCount < input.diffHunkCount,
  };
}

export function reviewAnswerable(changedFiles: string[], coverage: Pick<ReviewCoverage, 'complete'>): boolean {
  return changedFiles.length > 0 && coverage.complete;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
