import { z } from 'zod';
import type { FileIndexer } from '../index/file-indexer.js';
import { computeIndexConfidence, roundConfidence } from '../utils/confidence.js';

export const GetDependenciesSchema = z.object({
  module: z.string().describe('Module ID, file path, or module name.'),
  transitive: z.boolean().default(false).describe('Include indirect dependencies.'),
  typeFilter: z.enum(['all', 'local', 'external']).default('all').describe('Filter by dependency type.'),
});

export type GetDependenciesInput = z.infer<typeof GetDependenciesSchema>;

export async function getDependencies(input: GetDependenciesInput, indexer: FileIndexer) {
  await indexer.ensureIndexed();

  const graph = indexer.getDependencyGraph();
  const importIndex = indexer.getImportIndex();
  const node = graph.findNode(input.module);
  const nodeId = node?.id ?? input.module;

  const directEdges = graph.getDependencies(nodeId);

  // Also get imports from the import index for richer info
  const fileImports = importIndex.getImportsOf(nodeId);

  const dependencies = directEdges.map(edge => {
    const depNode = graph.getNode(edge.to);
    const isExternal = fileImports.some(imp => imp.source === edge.to && imp.isExternal)
      || !graph.hasNode(edge.to);
    const type: 'local' | 'external' = isExternal ? 'external' : 'local';

    // Apply filter
    if (input.typeFilter !== 'all' && input.typeFilter !== type) return null;

    return {
      moduleId: edge.to,
      modulePath: depNode?.path ?? edge.to,
      type,
      importCount: edge.weight,
      usageCount: edge.weight,
      scope: edge.type as 'compile' | 'runtime' | 'test' | 'optional',
    };
  }).filter((d): d is NonNullable<typeof d> => d !== null);

  let transitiveDeps: typeof dependencies = [];
  if (input.transitive) {
    const transitive = graph.getTransitiveDependencies(nodeId, 5);
    transitiveDeps = transitive.map(t => {
      const depNode = graph.getNode(t.nodeId);
      return {
        moduleId: t.nodeId,
        modulePath: depNode?.path ?? t.nodeId,
        type: 'local' as const,
        importCount: 1,
        usageCount: 1,
        scope: 'compile' as const,
      };
    });
  }

  const all = [...dependencies, ...transitiveDeps];

  // De-duplicate by moduleId (transitive may overlap with direct at depth 1)
  const seen = new Set<string>();
  const deduplicated = all.filter(d => {
    if (seen.has(d.moduleId)) return false;
    seen.add(d.moduleId);
    return true;
  });

  const { confidence, confidenceNotes } = computeIndexConfidence(indexer);
  const notes = [...confidenceNotes];
  if (!node) notes.push(`Module "${input.module}" not found exactly — results may be incomplete`);

  return {
    module: nodeId,
    dependencies: deduplicated,
    totalCount: deduplicated.length,
    confidence: roundConfidence(confidence),
    confidenceNotes: notes,
  };
}
