import { describe, expect, it } from 'vitest';
import {
  applyReviewManifestBatch,
  createReviewManifest,
  reviewManifestCoverage,
} from '../../src/v2/query/review-manifest.js';

describe('review manifest state machine', () => {
  it('creates source-free locators with immutable base/head identity', () => {
    const manifest = createReviewManifest('base-sha', 'head-sha', [
      { path: 'src/new.ts', status: 'added', hunkCount: 2 },
      { path: 'src/old.ts', status: 'deleted', hunkCount: 1 },
    ], 'review-fixed');

    expect(manifest).toEqual({
      reviewId: 'review-fixed',
      baseSha: 'base-sha',
      headSha: 'head-sha',
      files: [
        {
          path: 'src/new.ts',
          status: 'added',
          hunkRefs: ['src/new.ts#hunk-1', 'src/new.ts#hunk-2'],
          graphResolution: 'pending',
          reviewState: 'pending',
        },
        {
          path: 'src/old.ts',
          status: 'deleted',
          hunkRefs: ['src/old.ts#hunk-1'],
          graphResolution: 'pending',
          reviewState: 'pending',
        },
      ],
    });
  });

  it('marks resolved, unsupported, and omitted files independently', () => {
    const initial = createReviewManifest('base', 'head', [
      { path: 'src/new.ts', status: 'added', hunkCount: 1 },
      { path: 'src/old.ts', status: 'deleted', hunkCount: 1 },
      { path: 'src/missing.ts', status: 'modified', hunkCount: 1 },
    ]);
    const next = applyReviewManifestBatch(initial, {
      blocks: [
        { path: 'src/new.ts', status: 'added', hunkCount: 1 },
        { path: 'src/old.ts', status: 'deleted', hunkCount: 1 },
        { path: 'src/missing.ts', status: 'modified', hunkCount: 1 },
      ],
      resolvedFiles: ['src/new.ts'],
      complete: false,
    });

    expect(next.files).toMatchObject([
      { path: 'src/new.ts', graphResolution: 'resolved', reviewState: 'omitted' },
      { path: 'src/old.ts', graphResolution: 'unsupported', reviewState: 'omitted' },
      { path: 'src/missing.ts', graphResolution: 'failed', reviewState: 'omitted' },
    ]);
    expect(initial.files.every(file => file.reviewState === 'pending')).toBe(true);
  });

  it('marks every file in a failed batch failed without mutating the prior snapshot', () => {
    const initial = createReviewManifest('base', 'head', [
      { path: 'src/a.ts', status: 'modified', hunkCount: 1 },
    ]);
    const failed = applyReviewManifestBatch(initial, {
      blocks: [{ path: 'src/a.ts', status: 'modified', hunkCount: 1 }],
      complete: false,
      failed: true,
    });

    expect(failed.files[0]).toMatchObject({ graphResolution: 'failed', reviewState: 'failed' });
    expect(initial.files[0]).toMatchObject({ graphResolution: 'pending', reviewState: 'pending' });
  });

  it('derives aggregate completeness and hunk counts from manifest state', () => {
    const initial = createReviewManifest('base', 'head', [
      { path: 'src/a.ts', status: 'modified', hunkCount: 2 },
      { path: 'src/deleted.ts', status: 'deleted', hunkCount: 1 },
    ]);
    const reviewed = applyReviewManifestBatch(initial, {
      blocks: [
        { path: 'src/a.ts', status: 'modified', hunkCount: 2 },
        { path: 'src/deleted.ts', status: 'deleted', hunkCount: 1 },
      ],
      resolvedFiles: ['src/a.ts'],
      complete: true,
    });
    expect(reviewManifestCoverage(reviewed)).toEqual({
      complete: true,
      graphEligibleFileCount: 1,
      graphResolvedFileCount: 1,
      reviewableHunkCount: 3,
      reviewedHunkCount: 3,
      omittedFiles: [],
      omittedHunks: 0,
    });
  });
});
