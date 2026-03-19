import { z } from 'zod';
import type { FileIndexer } from '../index/file-indexer.js';

export const GetDependentsSchema = z.object({
  module: z.string().describe('Module ID, file path, or module name.'),
  recursive: z.boolean().default(false).describe('Include transitive dependents.'),
  maxDepth: z.number().min(1).max(10).default(3).describe('Transitive depth limit.'),
});

export type GetDependentsInput = z.infer<typeof GetDependentsSchema>;

export async function getDependents(input: GetDependentsInput, indexer: FileIndexer) {
  await indexer.ensureIndexed();

  const graph = indexer.getDependencyGraph();
  const node = graph.findNode(input.module);
  const nodeId = node?.id ?? input.module;

  const directEdges = graph.getDependents(nodeId);

  const direct = directEdges.map(edge => {
    const dependentNode = graph.getNode(edge.from);
    return {
      moduleId: edge.from,
      modulePath: dependentNode?.path ?? edge.from,
      importStatement: '', // Would need to correlate with import index
      usageCount: edge.weight,
      riskLevel: getRiskLevel(graph.getDependents(edge.from).length),
    };
  });

  let transitive: Array<{ moduleId: string; via: string[]; depth: number }> = [];
  if (input.recursive) {
    transitive = graph.getTransitiveDependents(nodeId, input.maxDepth).map(t => ({
      moduleId: t.nodeId,
      via: t.via,
      depth: t.depth,
    }));
  }

  const state = indexer.getState();
  const notes: string[] = [];
  let confidence = 1.0;

  if (state.filesIndexed > 0 && state.parseErrorCount > 0) {
    const rate = state.parseErrorCount / state.filesIndexed;
    confidence -= rate * 0.3;
    notes.push(`${state.parseErrorCount} file(s) had parse errors — dependent list may be incomplete`);
  }
  const unresolved = 1 - state.importResolutionRate;
  if (unresolved > 0.05) {
    confidence -= unresolved * 0.2;
    notes.push(`${(unresolved * 100).toFixed(0)}% of imports unresolved — some dependents may be missing`);
  }
  if (!node) notes.push(`Module "${input.module}" not found exactly — results may be incomplete`);

  return {
    module: nodeId,
    direct,
    transitive,
    directCount: direct.length,
    transitiveCount: transitive.length,
    confidence: Math.round(Math.max(0.1, Math.min(1.0, confidence)) * 100) / 100,
    confidenceNotes: notes,
  };
}

function getRiskLevel(dependentCount: number): 'high' | 'medium' | 'low' {
  if (dependentCount > 5) return 'high';
  if (dependentCount >= 2) return 'medium';
  return 'low';
}
