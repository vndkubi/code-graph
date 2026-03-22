import { z } from 'zod';
import type { FileIndexer } from '../index/file-indexer.js';
import { computeIndexConfidence, roundConfidence } from '../utils/confidence.js';

export const GetTypeUsageSchema = z.object({
  typeName: z.string().describe('Class/interface name to find usages of (e.g. "UserDTO", "OrderService").'),
  context: z.enum(['field', 'parameter', 'return', 'all']).default('all')
    .describe('Filter by usage context: field declaration, method parameter, or return type.'),
  limit: z.number().min(1).max(200).default(50).describe('Max results.'),
});

export type GetTypeUsageInput = z.infer<typeof GetTypeUsageSchema>;

export async function getTypeUsage(input: GetTypeUsageInput, indexer: FileIndexer) {
  await indexer.ensureIndexed();

  const symbolIndex = indexer.getSymbolIndex();
  const { confidence: indexConfidence, confidenceNotes } = computeIndexConfidence(indexer);

  const allSymbols = symbolIndex.getAllSymbols();

  const usages: Array<{
    file: string;
    line: number;
    symbol: string;
    context: 'field' | 'parameter' | 'return';
    signature: string;
    parent?: string;
  }> = [];
  const typeName = input.typeName;

  for (const sym of allSymbols) {
    if (usages.length >= input.limit) break;

    // Check field type
    if ((input.context === 'all' || input.context === 'field') && sym.kind === 'field') {
      if (sym.returnType === typeName) {
        usages.push({
          file: sym.file,
          line: sym.line,
          symbol: sym.parent ? `${sym.parent}.${sym.name}` : sym.name,
          context: 'field',
          signature: sym.signature,
          parent: sym.parent,
        });
        continue;
      }
    }

    // Check return type
    if ((input.context === 'all' || input.context === 'return') &&
        (sym.kind === 'method' || sym.kind === 'function')) {
      if (sym.returnType === typeName) {
        usages.push({
          file: sym.file,
          line: sym.line,
          symbol: sym.parent ? `${sym.parent}.${sym.name}` : sym.name,
          context: 'return',
          signature: sym.signature,
          parent: sym.parent,
        });
        continue;
      }
    }

    // Check parameter types
    if ((input.context === 'all' || input.context === 'parameter') &&
        (sym.kind === 'method' || sym.kind === 'function')) {
      if (sym.parameterTypes?.includes(typeName)) {
        usages.push({
          file: sym.file,
          line: sym.line,
          symbol: sym.parent ? `${sym.parent}.${sym.name}` : sym.name,
          context: 'parameter',
          signature: sym.signature,
          parent: sym.parent,
        });
      }
    }
  }

  // Group by context
  const byContext = { field: 0, parameter: 0, return: 0 };
  for (const u of usages) byContext[u.context]++;

  return {
    typeName,
    usages: usages.slice(0, input.limit),
    totalCount: usages.length,
    truncated: usages.length >= input.limit,
    byContext,
    confidence: roundConfidence(indexConfidence),
    confidenceNotes,
  };
}
