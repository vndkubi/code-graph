import { sha256Text } from '../hash.js';

/** Stable state for a changed file in a batched review. */
export type ReviewFileStatus = 'added' | 'modified' | 'deleted';
export type ReviewGraphResolution = 'pending' | 'resolved' | 'unsupported' | 'failed';
export type ReviewFileState = 'pending' | 'reviewed' | 'omitted' | 'failed';

export interface ReviewManifestFile {
  path: string;
  status: ReviewFileStatus;
  hunkRefs: string[];
  graphResolution: ReviewGraphResolution;
  reviewState: ReviewFileState;
}

export interface ReviewManifest {
  /** Stable identity for this immutable base/head/file set. */
  reviewId: string;
  baseSha: string;
  headSha: string;
  files: ReviewManifestFile[];
}

export interface ReviewManifestBlock {
  path?: string;
  status: ReviewFileStatus;
  hunkCount: number;
}

export interface ReviewManifestBatchUpdate {
  blocks: ReviewManifestBlock[];
  /** Files for which the review engine returned graph/source evidence. */
  resolvedFiles?: Iterable<string>;
  /** True when the batch completed without omitted files or hunks. */
  complete: boolean;
  /** True when the batch call itself failed. */
  failed?: boolean;
}

export interface ReviewManifestCoverage {
  complete: boolean;
  graphEligibleFileCount: number;
  graphResolvedFileCount: number;
  reviewableHunkCount: number;
  reviewedHunkCount: number;
  omittedFiles: string[];
  omittedHunks: number;
}

/**
 * Build the first-class review state machine before any batch is sent to the
 * review engine. The manifest contains locators and state only; it never
 * stores source text or the full diff.
 */
export function createReviewManifest(
  baseSha: string,
  headSha: string,
  blocks: ReviewManifestBlock[],
  reviewId?: string,
): ReviewManifest {
  const files = mergeManifestBlocks(blocks).map(block => ({
    path: block.path,
    status: block.status,
    hunkRefs: Array.from({ length: block.hunkCount }, (_, index) => `${block.path}#hunk-${index + 1}`),
    graphResolution: 'pending' as const,
    reviewState: 'pending' as const,
  }));
  const identity = `${baseSha}:${headSha}:${files.map(file => `${file.status}:${file.path}:${file.hunkRefs.length}`).join('|')}`;
  return {
    reviewId: reviewId ?? `review-${sha256Text(identity).slice(0, 24)}`,
    baseSha,
    headSha,
    files,
  };
}

/**
 * Apply one completed (or failed) batch without mutating the prior snapshot.
 * Callers can persist each returned snapshot or emit it to a progress UI.
 */
export function applyReviewManifestBatch(
  manifest: ReviewManifest,
  update: ReviewManifestBatchUpdate,
): ReviewManifest {
  const resolved = new Set(update.resolvedFiles ?? []);
  const batchPaths = new Set(update.blocks.map(block => block.path ?? ''));
  const blockByPath = new Map(update.blocks.map(block => [block.path ?? '', block]));
  const files = manifest.files.map(file => {
    if (!batchPaths.has(file.path)) return { ...file, hunkRefs: [...file.hunkRefs] };
    const block = blockByPath.get(file.path);
    if (update.failed) {
      return { ...file, graphResolution: file.status === 'deleted' ? 'unsupported' as const : 'failed' as const, reviewState: 'failed' as const, hunkRefs: [...file.hunkRefs] };
    }
    const graphResolution = file.status === 'deleted'
      ? 'unsupported' as const
      : resolved.has(file.path)
        ? 'resolved' as const
        : 'failed' as const;
    const reviewState = update.complete
      ? 'reviewed' as const
      : block && block.hunkCount === 0 && graphResolution !== 'failed'
        ? 'reviewed' as const
        : 'omitted' as const;
    return { ...file, graphResolution, reviewState, hunkRefs: [...file.hunkRefs] };
  });
  return { ...manifest, files };
}

/** Aggregate correctness coverage from the manifest state, not raw response fields. */
export function reviewManifestCoverage(manifest: ReviewManifest): ReviewManifestCoverage {
  const graphEligible = manifest.files.filter(file => file.status !== 'deleted');
  const resolved = graphEligible.filter(file => file.graphResolution === 'resolved');
  const reviewed = manifest.files.filter(file => file.reviewState === 'reviewed');
  const omittedFiles = manifest.files
    .filter(file => file.reviewState !== 'reviewed')
    .map(file => file.path);
  const reviewableHunkCount = manifest.files.reduce((sum, file) => sum + file.hunkRefs.length, 0);
  const reviewedHunkCount = reviewed.reduce((sum, file) => sum + file.hunkRefs.length, 0);
  return {
    complete: manifest.files.every(file => file.reviewState === 'reviewed'),
    graphEligibleFileCount: graphEligible.length,
    graphResolvedFileCount: resolved.length,
    reviewableHunkCount,
    reviewedHunkCount,
    omittedFiles,
    omittedHunks: Math.max(0, reviewableHunkCount - reviewedHunkCount),
  };
}

function mergeManifestBlocks(blocks: ReviewManifestBlock[]): Array<ReviewManifestBlock & { path: string }> {
  const merged = new Map<string, ReviewManifestBlock & { path: string }>();
  for (const block of blocks) {
    const path = block.path ?? '<unparsed-diff-block>';
    const current = merged.get(path);
    if (!current) {
      merged.set(path, { ...block, path, hunkCount: Math.max(0, block.hunkCount) });
      continue;
    }
    // A malformed/renamed diff can mention the same path more than once. Keep
    // one state entry while preserving every hunk locator.
    merged.set(path, {
      ...current,
      hunkCount: current.hunkCount + Math.max(0, block.hunkCount),
    });
  }
  return [...merged.values()];
}
