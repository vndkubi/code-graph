import { z } from 'zod';
import type { FileIndexer } from '../index/file-indexer.js';
import { computeIndexConfidence, roundConfidence } from '../utils/confidence.js';

export const GetCallChainSchema = z.object({
  from: z.string().describe('"ClassName.methodName" or "functionName"'),
  to: z.string().describe('Target symbol (same format as from)'),
  maxDepth: z.number().min(1).max(15).default(5).describe('Max chain length.'),
  allPaths: z.boolean().default(false).describe('Return all paths, not just shortest.'),
});

export type GetCallChainInput = z.infer<typeof GetCallChainSchema>;

export async function getCallChain(input: GetCallChainInput, indexer: FileIndexer) {
  await indexer.ensureIndexed();

  const callGraph = indexer.getCallGraph();
  const chains = callGraph.findCallChain(input.from, input.to, input.maxDepth, input.allPaths);

  const { confidence: indexConfidence, confidenceNotes } = computeIndexConfidence(indexer);

  // Aggregate chain-level confidence (min across all chains, fallback to index confidence)
  const chainConfidence = chains.length > 0
    ? Math.min(...chains.map(c => c.confidence))
    : indexConfidence;
  const confidence = roundConfidence(chainConfidence * indexConfidence);

  // Collect unique resolution notes from chains
  const chainNotes = [...new Set(chains.flatMap(c => c.resolutionNotes))];
  const allNotes = [...confidenceNotes, ...chainNotes];

  return {
    found: chains.length > 0,
    chains: chains.map(c => ({
      path: c.path.map(node => ({
        symbol: node.symbol,
        file: node.file,
        line: node.line,
      })),
      depth: c.depth,
      isShortest: c.isShortest,
      confidence: roundConfidence(c.confidence),
    })),
    searchedNodes: callGraph.nodeCount,
    confidence,
    confidenceNotes: allNotes,
    message: chains.length === 0
      ? `No path found from "${input.from}" to "${input.to}" within depth ${input.maxDepth}`
      : undefined,
  };
}
