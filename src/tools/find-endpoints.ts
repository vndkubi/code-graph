import { z } from 'zod';
import type { FileIndexer } from '../index/file-indexer.js';

export const FindEndpointsSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'all']).default('all')
    .describe('Filter by HTTP method.'),
  pathPattern: z.string().optional().describe('Regex to filter endpoint paths, e.g. "/api/users.*"'),
  limit: z.number().min(1).max(500).default(100).describe('Max results.'),
});

export type FindEndpointsInput = z.infer<typeof FindEndpointsSchema>;

export async function findEndpoints(input: FindEndpointsInput, indexer: FileIndexer) {
  await indexer.ensureIndexed();

  const symbolIndex = indexer.getSymbolIndex();

  // Find all symbols with endpoint-related framework roles
  const endpointRoles = ['spring:endpoint', 'jaxrs:endpoint', 'mvc:controller', 'spring:rest-controller'];
  const allEndpoints = endpointRoles.flatMap(role => symbolIndex.findByFrameworkRole(role, 1000));

  // Deduplicate by file+line
  const seen = new Set<string>();
  const unique = allEndpoints.filter(sym => {
    const key = `${sym.file}:${sym.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Filter by HTTP method
  let filtered = unique;
  if (input.method.toUpperCase() !== 'ALL') {
    const method = input.method.toUpperCase();
    filtered = filtered.filter(sym => {
      const httpMethod = sym.frameworkMeta?.httpMethod?.toUpperCase();
      return httpMethod === method || httpMethod === 'REQUEST';  // @RequestMapping matches all
    });
  }

  // Filter by path pattern
  if (input.pathPattern) {
    let regex: RegExp;
    try { regex = new RegExp(input.pathPattern, 'i'); } catch {
      regex = new RegExp(input.pathPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    filtered = filtered.filter(sym => {
      const path = sym.frameworkMeta?.path ?? '';
      return regex.test(path);
    });
  }

  const results = filtered.slice(0, input.limit);

  return {
    endpoints: results.map(sym => ({
      method: sym.frameworkMeta?.httpMethod ?? 'UNKNOWN',
      path: sym.frameworkMeta?.path ?? '',
      handler: sym.parent ? `${sym.parent}.${sym.name}` : sym.name,
      file: sym.file,
      line: sym.line,
      signature: sym.signature,
      controller: sym.parent,
      annotations: sym.annotations,
      frameworkRole: sym.frameworkRole,
    })),
    totalCount: results.length,
    truncated: results.length >= input.limit,
  };
}
