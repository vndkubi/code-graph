import path from 'node:path';
import { V2Indexer, type IndexWorkspaceResult } from '../index/indexer.js';
import {
  reviewForCi,
  type CiReviewOptions,
  type CiReviewResult,
} from '../query/ci-review.js';
import type { ReviewManifest } from '../query/review-manifest.js';
import {
  assertReviewWorkspaceAtHead,
  prepareManagedReviewWorktree,
  preparePullRequestReviewWorkspace,
  type PreparedPullRequestWorkspace,
} from '../query/pr-review.js';
import type { ReviewInput } from '../query/review-input.js';
import { V2QueryService } from '../query/service.js';
import { openCodeGraphDb } from '../storage/database.js';
import { sha256Text } from '../hash.js';

export interface ReviewPullRequestRequest {
  sourceRoot: string;
  input: ReviewInput;
  workspaceKey?: string;
  /** Keep the caller's clean checkout for CLI range reviews when false. */
  isolateRangeWorkspace?: boolean;
  /** Validate the caller's current HEAD before a non-isolated range review. */
  requireCurrentHead?: boolean;
  indexProviders?: string[] | string;
  scipIndexPath?: string;
  focus?: string;
  batchSize?: number;
  maxHunksPerBatch?: number;
  limit?: number;
  minPriority?: CiReviewOptions['minPriority'];
  onManifestUpdate?: (manifest: ReviewManifest) => void | Promise<void>;
}

export interface ReviewPullRequestExecution {
  review: CiReviewResult;
  reviewInput: ReviewInput;
  sourceRoot: string;
  reviewRoot: string;
  workspaceKey?: string;
  preparedPullRequest?: PreparedPullRequestWorkspace;
  indexed: IndexWorkspaceResult;
}

/**
 * Shared application pipeline for CLI and MCP review requests.
 *
 * Adapters resolve their transport-specific input and render the result, but
 * immutable source preparation, head validation, indexing and batched review
 * all happen here so the two surfaces cannot drift independently.
 */
export class ReviewPullRequestUseCase {
  async execute(request: ReviewPullRequestRequest): Promise<ReviewPullRequestExecution> {
    const sourceRoot = path.resolve(request.sourceRoot);
    const preparedPullRequest = request.input.kind === 'pull_request'
      ? await preparePullRequestReviewWorkspace(sourceRoot, request.input.prUrl)
      : undefined;
    const reviewRoot = preparedPullRequest?.root ?? await this.prepareRangeWorkspace(sourceRoot, request);
    const baseRef = preparedPullRequest?.baseSha
      ?? (request.input.kind === 'range' ? request.input.baseRef : undefined);
    const headRef = preparedPullRequest?.headSha
      ?? (request.input.kind === 'range' ? request.input.headRef : undefined);
    if (!baseRef || !headRef) throw new Error('Review source did not resolve to immutable base/head refs.');
    const workspaceKey = preparedPullRequest?.workspaceKey
      ?? request.workspaceKey
      ?? (request.isolateRangeWorkspace ? this.rangeWorkspaceKey(sourceRoot, request.input) : undefined);

    const opened = await openCodeGraphDb(reviewRoot);
    try {
      const indexed = await new V2Indexer(opened.db).indexWorkspace({
        root: reviewRoot,
        workspaceKey,
        indexProviders: request.indexProviders,
        scipIndexPath: request.scipIndexPath,
      });
      const review = await reviewForCi(
        new V2QueryService(opened.db),
        indexed.workspaceId,
        reviewRoot,
        {
          baseRef,
          headRef,
          focus: request.focus,
          batchSize: request.batchSize,
          maxHunksPerBatch: request.maxHunksPerBatch,
          limit: request.limit,
          minPriority: request.minPriority,
          onManifestUpdate: request.onManifestUpdate,
        },
      );
      return {
        review,
        reviewInput: request.input,
        sourceRoot,
        reviewRoot,
        workspaceKey,
        preparedPullRequest,
        indexed,
      };
    } finally {
      await opened.db.close();
    }
  }

  private async prepareRangeWorkspace(sourceRoot: string, request: ReviewPullRequestRequest): Promise<string> {
    if (request.input.kind !== 'range') throw new Error('Range workspace preparation requires range review input.');
    const input = request.input;
    if (request.isolateRangeWorkspace !== true) {
      if (request.requireCurrentHead !== false) await assertReviewWorkspaceAtHead(sourceRoot, input.headRef);
      return sourceRoot;
    }
    const worktreeId = `range-${sha256Text(`${input.baseRef}...${input.headRef}`).slice(0, 16)}`;
    return prepareManagedReviewWorktree(
      sourceRoot,
      path.join(sourceRoot, '.codegraph', 'review-worktrees', worktreeId),
      input.headRef,
    );
  }

  private rangeWorkspaceKey(sourceRoot: string, input: ReviewInput): string | undefined {
    if (input.kind !== 'range') return undefined;
    return `review:${sha256Text(`${sourceRoot}:${input.baseRef}...${input.headRef}`).slice(0, 24)}`;
  }
}
