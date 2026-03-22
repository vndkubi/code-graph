import { z } from 'zod';
import type { FileIndexer } from '../index/file-indexer.js';
import { computeIndexConfidence, roundConfidence } from '../utils/confidence.js';
import { isEntryPoint } from './review-support.js';

export const FindDeadCodeSchema = z.object({
  scope: z.string().optional().describe('Restrict to file/module path prefix. Omit for entire codebase.'),
  kind: z.enum(['method', 'function', 'class', 'all']).default('all').describe('Symbol kind to check.'),
  includeTests: z.boolean().default(false).describe('Include test files in analysis.'),
  limit: z.number().min(1).max(500).default(100).describe('Max results.'),
});

export type FindDeadCodeInput = z.infer<typeof FindDeadCodeSchema>;

export async function findDeadCode(input: FindDeadCodeInput, indexer: FileIndexer) {
  await indexer.ensureIndexed();

  const symbolIndex = indexer.getSymbolIndex();
  const callGraph = indexer.getCallGraph();
  const { confidence: indexConfidence, confidenceNotes } = computeIndexConfidence(indexer);

  const allSymbols = symbolIndex.getAllSymbols();

  // Filter by scope and kind
  let candidates = allSymbols.filter(sym => {
    if (input.kind !== 'all' && sym.kind !== input.kind) return false;
    if (!['method', 'function', 'class'].includes(sym.kind)) return false;
    if (input.scope && !sym.file.includes(input.scope)) return false;
    if (!input.includeTests) {
      const lower = sym.file.toLowerCase();
      if (lower.includes('test') || lower.includes('spec') || lower.includes('__tests__')) return false;
    }
    return true;
  });

  // Find symbols with no callers
  const deadCode: Array<{
    name: string;
    kind: string;
    file: string;
    line: number;
    signature: string;
    parent?: string;
    reason: string;
  }> = [];

  for (const sym of candidates) {
    if (deadCode.length >= input.limit) break;

    // Skip entry points
    if (isEntryPoint(sym)) continue;

    // Skip private methods (they may be called internally via patterns we can't trace)
    // Actually, private methods are GOOD candidates for dead code — keep them

    // Check if anyone calls this symbol
    const symbolName = sym.parent ? `${sym.parent}.${sym.name}` : sym.name;
    const callers = callGraph.getCallers(symbolName);

    // Also try resolving variations
    const resolved = callGraph.resolveAllMatches(symbolName);
    let hasCallers = callers.length > 0;

    if (!hasCallers && resolved.length > 0) {
      for (const r of resolved) {
        if (callGraph.getCallers(r).length > 0) {
          hasCallers = true;
          break;
        }
      }
    }

    // For classes, check if anyone depends on the file
    if (!hasCallers && sym.kind === 'class') {
      const depGraph = indexer.getDependencyGraph();
      const dependents = depGraph.getDependents(sym.file);
      if (dependents.length > 0) hasCallers = true;
    }

    if (!hasCallers) {
      deadCode.push({
        name: symbolName,
        kind: sym.kind,
        file: sym.file,
        line: sym.line,
        signature: sym.signature,
        parent: sym.parent,
        reason: sym.kind === 'class'
          ? 'No file imports or depends on this class'
          : 'No callers found in call graph',
      });
    }
  }

  return {
    deadCode,
    totalFound: deadCode.length,
    truncated: deadCode.length >= input.limit,
    confidence: roundConfidence(indexConfidence * 0.7),  // Lower confidence — call graph is best-effort
    confidenceNotes: [
      ...confidenceNotes,
      'Dead code detection is heuristic — entry points, reflection, and dynamic calls may cause false positives',
    ],
  };
}
