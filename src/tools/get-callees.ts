import { z } from 'zod';
import type { FileIndexer } from '../index/file-indexer.js';
import { computeIndexConfidence, roundConfidence } from '../utils/confidence.js';

export const GetCalleesSchema = z.object({
  symbol: z.string().describe('"ClassName.methodName" or "functionName" — what does this call?'),
  maxDepth: z.number().min(1).max(10).default(1).describe('1 = direct callees only, >1 = transitive callees.'),
  limit: z.number().min(1).max(200).default(50).describe('Max results.'),
});

export type GetCalleesInput = z.infer<typeof GetCalleesSchema>;

export async function getCallees(input: GetCalleesInput, indexer: FileIndexer) {
  await indexer.ensureIndexed();

  const callGraph = indexer.getCallGraph();
  const resolved = callGraph.resolveAllMatchesWithConfidence(input.symbol);
  if (resolved.length === 0) {
    return { found: false, callees: [], message: `Symbol "${input.symbol}" not found in call graph.` };
  }

  const { confidence: indexConfidence, confidenceNotes } = computeIndexConfidence(indexer);
  const resolutionConfidence = resolved[0].confidence;
  if (resolved[0].matchType !== 'exact') {
    confidenceNotes.push(`"${input.symbol}" resolved via ${resolved[0].matchType} match to "${resolved[0].symbol}"`);
  }

  const results: Array<{ symbol: string; file: string; line: number; callSiteLine: number; depth: number }> = [];
  const visited = new Set<string>();

  const queue: Array<{ symbol: string; depth: number }> = resolved.map(r => ({ symbol: r.symbol, depth: 0 }));
  for (const r of resolved) visited.add(r.symbol);
  let head = 0;

  while (head < queue.length && results.length < input.limit) {
    const current = queue[head++]!;
    if (current.depth >= input.maxDepth) continue;

    const callees = callGraph.getCallees(current.symbol);
    for (const edge of callees) {
      const resolvedCallee = callGraph.resolveSymbol(edge.to) ?? edge.to;
      if (visited.has(resolvedCallee)) continue;
      visited.add(resolvedCallee);

      const node = callGraph.getNode(resolvedCallee);
      results.push({
        symbol: resolvedCallee,
        file: node?.file ?? '',
        line: node?.line ?? 0,
        callSiteLine: edge.line,
        depth: current.depth + 1,
      });

      if (input.maxDepth > 1) {
        queue.push({ symbol: resolvedCallee, depth: current.depth + 1 });
      }
    }
  }

  const truncated = results.length > input.limit;
  const returnedCallees = results.slice(0, input.limit);

  return {
    found: true,
    target: resolved[0].symbol,
    callees: returnedCallees,
    totalCount: returnedCallees.length,
    truncated,
    confidence: roundConfidence(resolutionConfidence * indexConfidence),
    confidenceNotes,
  };
}
