import { z } from 'zod';
import type { FileIndexer } from '../index/file-indexer.js';
import { computeIndexConfidence, roundConfidence } from '../utils/confidence.js';

export const GetCallersSchema = z.object({
  symbol: z.string().describe('"ClassName.methodName" or "functionName" — who calls this?'),
  maxDepth: z.number().min(1).max(10).default(1).describe('1 = direct callers only, >1 = transitive callers.'),
  limit: z.number().min(1).max(200).default(50).describe('Max results.'),
});

export type GetCallersInput = z.infer<typeof GetCallersSchema>;

export async function getCallers(input: GetCallersInput, indexer: FileIndexer) {
  await indexer.ensureIndexed();

  const callGraph = indexer.getCallGraph();
  const resolved = callGraph.resolveAllMatchesWithConfidence(input.symbol);
  if (resolved.length === 0) {
    return { found: false, callers: [], message: `Symbol "${input.symbol}" not found in call graph.` };
  }

  const { confidence: indexConfidence, confidenceNotes } = computeIndexConfidence(indexer);
  const resolutionConfidence = resolved[0].confidence;
  if (resolved[0].matchType !== 'exact') {
    confidenceNotes.push(`"${input.symbol}" resolved via ${resolved[0].matchType} match to "${resolved[0].symbol}"`);
  }

  const results: Array<{ symbol: string; file: string; line: number; depth: number }> = [];
  const visited = new Set<string>();

  // BFS for transitive callers
  const queue: Array<{ symbol: string; depth: number }> = resolved.map(r => ({ symbol: r.symbol, depth: 0 }));
  for (const r of resolved) visited.add(r.symbol);
  let head = 0;

  while (head < queue.length && results.length < input.limit) {
    const current = queue[head++]!;
    if (current.depth >= input.maxDepth) continue;

    const callers = callGraph.getCallers(current.symbol);
    for (const edge of callers) {
      const resolvedCaller = callGraph.resolveSymbol(edge.from) ?? edge.from;
      if (visited.has(resolvedCaller)) continue;
      visited.add(resolvedCaller);

      const node = callGraph.getNode(resolvedCaller);
      results.push({
        symbol: resolvedCaller,
        file: node?.file ?? edge.file,
        line: node?.line ?? edge.line,
        depth: current.depth + 1,
      });

      if (input.maxDepth > 1) {
        queue.push({ symbol: resolvedCaller, depth: current.depth + 1 });
      }
    }
  }

  const truncated = results.length > input.limit;
  const returnedCallers = results.slice(0, input.limit);

  return {
    found: true,
    target: resolved[0].symbol,
    callers: returnedCallers,
    totalCount: returnedCallers.length,
    truncated,
    confidence: roundConfidence(resolutionConfidence * indexConfidence),
    confidenceNotes,
  };
}
