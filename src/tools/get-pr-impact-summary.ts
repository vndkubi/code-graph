import { z } from 'zod';
import type { FileIndexer } from '../index/file-indexer.js';
import { buildReviewChangedFiles, resolveChangedFiles } from './review-support.js';

export const GetPrImpactSummarySchema = z.object({
  files: z.array(z.string()).optional().describe('Specific changed files to summarize. If omitted, detect from git diff/worktree.'),
  baseRef: z.string().optional().describe('Git ref used as the baseline, e.g. "HEAD" or "origin/main".'),
  headRef: z.string().optional().describe('Optional git ref to compare against baseRef.'),
  includeUntracked: z.boolean().default(true).describe('Include untracked files when auto-detecting changes.'),
  maxDepth: z.number().min(1).max(8).default(4).describe('How far to walk transitive dependents when computing impact.'),
  topN: z.number().min(1).max(50).default(10).describe('How many top review targets to surface.'),
  customRules: z.array(z.object({
    from: z.string().describe('Source layer (e.g. "repository")'),
    forbiddenDeps: z.array(z.string()).describe('Layers that "from" should NOT depend on'),
  })).optional().describe('Custom layer rules. If omitted, uses standard layered architecture rules.'),
});

export type GetPrImpactSummaryInput = z.infer<typeof GetPrImpactSummarySchema>;

export async function getPrImpactSummary(input: GetPrImpactSummaryInput, indexer: FileIndexer) {
  const selection = resolveChangedFiles(indexer.getRootDir(), {
    files: input.files,
    baseRef: input.baseRef,
    headRef: input.headRef,
    includeUntracked: input.includeUntracked,
  });

  const review = await buildReviewChangedFiles(indexer, selection, input.maxDepth, input.customRules);
  const topReviewTargets = review.reviewOrder.slice(0, input.topN);
  const highPriorityFiles = review.reviewOrder.filter(item => item.priority === 'high');

  const checklist: string[] = [];
  if (review.impactedEndpoints.length > 0) {
    checklist.push(`Re-test ${review.impactedEndpoints.length} impacted endpoint(s) before merging`);
  }
  if (review.architecturalDelta.likelyNewViolations.length > 0) {
    checklist.push(`Inspect ${review.architecturalDelta.likelyNewViolations.length} likely new architectural violation(s)`);
  }
  if (highPriorityFiles.length > 0) {
    checklist.push(`Start review with ${Math.min(input.topN, highPriorityFiles.length)} high-priority file(s)`);
  }
  if (review.deletedFileImpacts.length > 0) {
    const orphanedCount = review.deletedFileImpacts.reduce((sum, d) => sum + d.affectedFiles.length, 0);
    checklist.push(`Verify ${review.deletedFileImpacts.length} deleted file(s) — ${orphanedCount} file(s) still reference them`);
  }

  return {
    changedFiles: review.changedFiles,
    detectionMode: review.detectionMode,
    deletedFiles: review.deletedFiles,
    skippedNonSourceFiles: review.skippedNonSourceFiles,
    totals: {
      changedFiles: review.changedFiles.length,
      deletedFiles: review.deletedFiles.length,
      highPriorityFiles: highPriorityFiles.length,
      impactedEndpoints: review.impactedEndpoints.length,
      currentLayerViolations: review.architecturalDelta.currentViolations.length,
      likelyNewLayerViolations: review.architecturalDelta.likelyNewViolations.length,
    },
    topReviewTargets,
    deletedFileImpacts: review.deletedFileImpacts,
    impactedEndpoints: review.impactedEndpoints.slice(0, input.topN),
    architecturalDelta: {
      currentViolations: review.architecturalDelta.currentViolations.slice(0, input.topN),
      likelyNewViolations: review.architecturalDelta.likelyNewViolations.slice(0, input.topN),
      addedDependencyRisks: review.architecturalDelta.addedDependencyRisks.slice(0, input.topN),
    },
    checklist,
    confidence: review.confidence,
    confidenceNotes: review.confidenceNotes,
  };
}
