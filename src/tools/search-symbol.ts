import { z } from 'zod';
import type { FileIndexer } from '../index/file-indexer.js';
import type { SymbolKind } from '../analyzers/base-analyzer.js';

export const SearchSymbolSchema = z.object({
  query: z.string().describe('Exact name or regex pattern. Use "*" to match all.'),
  kind: z.enum(['class', 'function', 'method', 'interface', 'variable', 'field', 'all']).default('all').describe('Symbol type filter.'),
  module: z.string().optional().describe('Restrict to specific module.'),
  annotation: z.string().optional().describe(
    'Filter by annotation name, e.g. "Service", "Transactional", "Test", "Entity".',
  ),
  frameworkRole: z.string().optional().describe(
    'Filter by framework role prefix, e.g. "spring:service", "jakarta:entity", "test:test", "lombok:builder".',
  ),
  limit: z.number().min(1).max(200).default(20).describe('Max results.'),
});

export type SearchSymbolInput = z.infer<typeof SearchSymbolSchema>;

export async function searchSymbol(input: SearchSymbolInput, indexer: FileIndexer) {
  await indexer.ensureIndexed();

  const symbolIndex = indexer.getSymbolIndex();
  const kindFilter: SymbolKind | undefined = input.kind === 'all' ? undefined : input.kind as SymbolKind;

  let results = input.annotation
    ? symbolIndex.findByAnnotation(input.annotation, input.limit * 4)  // over-fetch for downstream filters
    : input.frameworkRole
      ? symbolIndex.findByFrameworkRole(input.frameworkRole, input.limit * 4)
      : symbolIndex.findByPattern(input.query === '*' ? '.' : input.query, kindFilter, input.limit * 4);

  // Cross-filter: if annotation was primary filter, still apply query + kind
  if (input.annotation || input.frameworkRole) {
    if (input.query && input.query !== '*') {
      let regex: RegExp;
      try { regex = new RegExp(input.query, 'i'); } catch { regex = new RegExp(input.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
      results = results.filter(s => regex.test(s.name));
    }
    if (kindFilter) results = results.filter(s => s.kind === kindFilter);
  }

  // Filter by annotation when frameworkRole was primary (or vice versa)
  if (input.annotation && input.frameworkRole) {
    const roleLower = input.frameworkRole.toLowerCase();
    results = results.filter(s => s.frameworkRole?.toLowerCase().startsWith(roleLower));
  }

  // Filter by module
  if (input.module) {
    const mod = input.module;
    results = results.filter(s => s.module === mod || s.file.startsWith(mod));
  }

  results = results.slice(0, input.limit);
  const truncated = results.length >= input.limit;

  return {
    symbols: results.map(s => ({
      name: s.name,
      kind: s.kind,
      file: s.file,
      line: s.line,
      signature: s.signature,
      module: s.module,
      visibility: s.visibility,
      // Java-specific fields
      parent: s.parent,
      packageName: s.packageName,
      extends: s.extends,
      implements: s.implements,
      annotations: s.annotations,
      isStatic: s.isStatic,
      returnType: s.returnType,
      parameterTypes: s.parameterTypes,
      frameworkRole: s.frameworkRole,
      frameworkMeta: s.frameworkMeta,
    })),
    totalFound: results.length,
    truncated,
  };
}
