import { z } from 'zod';
import type { FileIndexer } from '../index/file-indexer.js';
import { computeIndexConfidence, roundConfidence } from '../utils/confidence.js';

export const GetIndexStatsSchema = z.object({
  topN: z.number().min(1).max(50).default(10).describe('Number of top items to include in rankings.'),
});

export type GetIndexStatsInput = z.infer<typeof GetIndexStatsSchema>;

export async function getIndexStats(input: GetIndexStatsInput, indexer: FileIndexer) {
  await indexer.ensureIndexed();

  const state = indexer.getState();
  const graph = indexer.getDependencyGraph();
  const callGraph = indexer.getCallGraph();
  const symbolIndex = indexer.getSymbolIndex();
  const { confidence, confidenceNotes } = computeIndexConfidence(indexer);

  // Top hub modules (most dependents = most depended upon)
  const allNodes = graph.getAllNodes();
  const byInDegree = allNodes
    .map(n => ({ module: n.path, layer: n.layer, inDegree: graph.getInDegree(n.id), outDegree: graph.getOutDegree(n.id) }))
    .sort((a, b) => b.inDegree - a.inDegree);

  const topDependedOn = byInDegree.slice(0, input.topN);

  // Top complex modules (most dependencies = depends on the most)
  const topDependencies = [...byInDegree]
    .sort((a, b) => b.outDegree - a.outDegree)
    .slice(0, input.topN);

  // Layer distribution
  const layerCounts = new Map<string, number>();
  for (const node of allNodes) {
    layerCounts.set(node.layer, (layerCounts.get(node.layer) ?? 0) + 1);
  }

  // Symbol kind distribution
  const allSymbols = symbolIndex.getAllSymbols();
  const kindCounts = new Map<string, number>();
  for (const sym of allSymbols) {
    kindCounts.set(sym.kind, (kindCounts.get(sym.kind) ?? 0) + 1);
  }

  // Framework role distribution
  const roleCounts = new Map<string, number>();
  for (const sym of allSymbols) {
    if (sym.frameworkRole) {
      roleCounts.set(sym.frameworkRole, (roleCounts.get(sym.frameworkRole) ?? 0) + 1);
    }
  }

  return {
    index: {
      filesIndexed: state.filesIndexed,
      symbolCount: state.symbolCount,
      importCount: state.importCount,
      indexTimeMs: state.indexTimeMs,
      parseErrorCount: state.parseErrorCount,
      importResolutionRate: Math.round(state.importResolutionRate * 100) + '%',
    },
    graph: {
      nodeCount: graph.nodeCount,
      edgeCount: graph.edgeCount,
      callGraphNodes: callGraph.nodeCount,
    },
    topDependedOn,
    topDependencies,
    layerDistribution: Object.fromEntries([...layerCounts.entries()].sort((a, b) => b[1] - a[1])),
    symbolKindDistribution: Object.fromEntries([...kindCounts.entries()].sort((a, b) => b[1] - a[1])),
    frameworkRoleDistribution: Object.fromEntries([...roleCounts.entries()].sort((a, b) => b[1] - a[1])),
    confidence: roundConfidence(confidence),
    confidenceNotes,
  };
}
