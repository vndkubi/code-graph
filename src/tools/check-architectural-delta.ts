import { z } from 'zod';
import type { FileIndexer } from '../index/file-indexer.js';
import { buildArchitecturalDelta, resolveChangedFiles } from './review-support.js';

export const CheckArchitecturalDeltaSchema = z.object({
  files: z.array(z.string()).optional().describe('Specific changed files to review. If omitted, detect from git diff/worktree.'),
  baseRef: z.string().optional().describe('Git ref used as the baseline, e.g. "HEAD" or "origin/main".'),
  headRef: z.string().optional().describe('Optional git ref to compare against baseRef.'),
  includeUntracked: z.boolean().default(true).describe('Include untracked files when auto-detecting changes.'),
  customRules: z.array(z.object({
    from: z.string().describe('Source layer (e.g. "repository")'),
    forbiddenDeps: z.array(z.string()).describe('Layers that "from" should NOT depend on'),
  })).optional().describe('Custom layer rules. If omitted, uses standard layered architecture rules.'),
});

export type CheckArchitecturalDeltaInput = z.infer<typeof CheckArchitecturalDeltaSchema>;

export async function checkArchitecturalDelta(input: CheckArchitecturalDeltaInput, indexer: FileIndexer) {
  const selection = resolveChangedFiles(indexer.getRootDir(), {
    files: input.files,
    baseRef: input.baseRef,
    headRef: input.headRef,
    includeUntracked: input.includeUntracked,
  });

  return buildArchitecturalDelta(indexer, selection, input.customRules);
}
