import { describe, expect, it } from 'vitest';
import { extractPullRequestUrl, hasExplicitReviewPayload, resolveReviewInput } from '../../src/v2/query/review-input.js';

describe('MCP review input resolution', () => {
  it('extracts a GitHub PR URL from the task', () => {
    expect(resolveReviewInput(
      'Review this PR https://github.com/acme/orders/pull/123/files',
      {},
    )).toEqual({
      kind: 'pull_request',
      prUrl: 'https://github.com/acme/orders/pull/123/files',
    });
  });

  it('resolves a branch range from natural language', () => {
    expect(resolveReviewInput('Review changes from branch origin/main to branch feature/refunds', {})).toEqual({
      kind: 'range',
      baseRef: 'origin/main',
      headRef: 'feature/refunds',
    });
  });

  it('prefers explicit structured refs and defaults head to HEAD', () => {
    expect(resolveReviewInput('Review this pull request', { baseRef: 'origin/main' })).toEqual({
      kind: 'range',
      baseRef: 'origin/main',
      headRef: 'HEAD',
    });
  });

  it('rejects unsafe refs instead of interpolating them into git commands', () => {
    expect(() => resolveReviewInput('Review changes', { baseRef: '--upload-pack=x' })).toThrow(/Invalid review git ref/);
    expect(() => resolveReviewInput('Review changes from main..bad to feature/x', {})).toThrow(/Invalid review git ref/);
  });

  it('distinguishes a supplied diff payload from a locator-only review task', () => {
    expect(hasExplicitReviewPayload({ diff: 'diff --git a/a.ts b/a.ts' })).toBe(true);
    expect(hasExplicitReviewPayload({ files: ['a.ts'] })).toBe(true);
    expect(hasExplicitReviewPayload({ task: 'Review PR https://github.com/acme/orders/pull/1' })).toBe(false);
  });

  it('extracts URLs without trailing markdown punctuation', () => {
    expect(extractPullRequestUrl('(https://github.com/acme/orders/pull/1).')).toBe('https://github.com/acme/orders/pull/1');
  });
});
