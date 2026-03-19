import { z } from 'zod';
import type { FileIndexer } from '../index/file-indexer.js';
import { CycleDetector } from '../graph/cycle-detector.js';

export const FindCyclesSchema = z.object({
  scope: z.enum(['modules', 'files', 'all']).default('modules').describe('Cycle detection scope.'),
  minCycleLength: z.number().min(2).default(2).describe('Ignore cycles shorter than N.'),
});

export type FindCyclesInput = z.infer<typeof FindCyclesSchema>;

export async function findCircularDependencies(input: FindCyclesInput, indexer: FileIndexer) {
  await indexer.ensureIndexed();

  const graph = indexer.getDependencyGraph();
  const detector = new CycleDetector();
  const cycles = detector.detectCycles(graph, input.scope, input.minCycleLength);

  return {
    cycles,
    totalCycles: cycles.length,
    clean: cycles.length === 0,
  };
}
