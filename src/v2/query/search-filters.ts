/**
 * Search/reference filters and facet builders. Extracted from service.ts; pure
 * functions that turn query args into SQL filter clauses and shape facets.
 */
import { parseJson, truncateOptional, escapeLike, rankFiles } from './util.js';
import { isSyntheticSymbol } from './ranking.js';
import type { SymbolRow, FileRow, EndpointRow, DependencyTraceEdge } from './types.js';

function referenceGroupKey(reference: Record<string, unknown>, groupBy: string): string {
  switch (groupBy) {
    case 'file':
      return String(reference.file ?? 'unknown');
    case 'kind':
      return String(reference.kind ?? 'unknown');
    case 'caller':
      return String(reference.caller ?? reference.file ?? 'unknown');
    case 'method':
      return String(reference.enclosingSymbol ?? reference.caller ?? reference.file ?? 'unknown');
    case 'class':
      return String(reference.enclosingClass ?? reference.ownerClass ?? reference.file ?? 'unknown');
    default:
      return 'all';
  }
}

export function searchFiltersFor(args: Record<string, unknown>, query: string): {
  sql: string[];
  params: unknown[];
  effective: Record<string, unknown>;
} {
  const includeTests = typeof args.includeTests === 'boolean' ? args.includeTests : hasTestIntent(query);
  const includeGenerated = typeof args.includeGenerated === 'boolean' ? args.includeGenerated : hasGeneratedIntent(query);
  const includeFixtures = typeof args.includeFixtures === 'boolean' ? args.includeFixtures : includeTests || hasFixtureIntent(query);
  const includeSynthetic = typeof args.includeSynthetic === 'boolean' ? args.includeSynthetic : hasSyntheticIntent(query);
  const sql: string[] = [];
  const params: unknown[] = [];

  if (!includeTests) sql.push("file_role != 'test_source'");
  if (!includeGenerated) sql.push("file_role != 'generated'");
  if (!includeFixtures) sql.push("file_role != 'mock_source'");
  if (!includeSynthetic) sql.push("COALESCE(framework_meta_json, '') NOT LIKE '%\"synthetic\":\"true\"%'");

  const fileRole = args.fileRole ? String(args.fileRole) : '';
  if (fileRole) {
    sql.push('file_role = ?');
    params.push(fileRole);
  }
  const language = args.language ? String(args.language) : '';
  if (language) {
    const extensionFilter = symbolFileLanguageFilter(language);
    if (extensionFilter) sql.push(extensionFilter);
  }
  const frameworkRole = args.frameworkRole ? String(args.frameworkRole) : '';
  if (frameworkRole) {
    sql.push("COALESCE(framework_role, '') = ?");
    params.push(frameworkRole);
  }
  const annotation = args.annotation ? String(args.annotation) : '';
  if (annotation) {
    sql.push("COALESCE(annotations_json, '') LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(annotation)}%`);
  }

  return {
    sql,
    params,
    effective: {
      includeSynthetic,
      includeTests,
      includeGenerated,
      includeFixtures,
      fileRole: fileRole || undefined,
      language: language || undefined,
      frameworkRole: frameworkRole || undefined,
      annotation: annotation || undefined,
    },
  };
}

export function fileFiltersFor(args: Record<string, unknown>, query: string): {
  sql: string[];
  params: unknown[];
  effective: Record<string, unknown>;
} {
  const includeTests = typeof args.includeTests === 'boolean' ? args.includeTests : hasTestIntent(query);
  const includeGenerated = typeof args.includeGenerated === 'boolean' ? args.includeGenerated : hasGeneratedIntent(query);
  const includeFixtures = typeof args.includeFixtures === 'boolean' ? args.includeFixtures : includeTests || hasFixtureIntent(query);
  const sql: string[] = [];
  const params: unknown[] = [];

  if (!includeTests) sql.push("file_role != 'test_source'");
  if (!includeGenerated) sql.push("file_role != 'generated'");
  if (!includeFixtures) sql.push("file_role != 'mock_source'");

  const fileRole = args.fileRole ? String(args.fileRole) : '';
  if (fileRole) {
    sql.push('file_role = ?');
    params.push(fileRole);
  }
  const language = args.language ? String(args.language) : '';
  if (language) {
    sql.push('language = ?');
    params.push(language);
  }

  return {
    sql,
    params,
    effective: {
      includeTests,
      includeGenerated,
      includeFixtures,
      fileRole: fileRole || undefined,
      language: language || undefined,
    },
  };
}

export function symbolFileLanguageFilter(language: string): string | undefined {
  switch (language) {
    case 'java':
      return "file LIKE '%.java'";
    case 'typescript':
      return "(file LIKE '%.ts' OR file LIKE '%.tsx')";
    case 'javascript':
      return "(file LIKE '%.js' OR file LIKE '%.jsx' OR file LIKE '%.mjs' OR file LIKE '%.cjs')";
    case 'python':
      return "file LIKE '%.py'";
    default:
      return undefined;
  }
}

export function referenceFiltersFor(args: Record<string, unknown>, query: string): {
  symbolSql: string[];
  symbolParams: unknown[];
  importSql: string[];
  importParams: unknown[];
  callSql: string[];
  callParams: unknown[];
  fieldSql: string[];
  fieldParams: unknown[];
  effective: Record<string, unknown>;
} {
  const fileFilters = fileFiltersFor(args, query);
  const includeSynthetic = typeof args.includeSynthetic === 'boolean' ? args.includeSynthetic : hasSyntheticIntent(query);
  const symbolSql = [...fileFilters.sql];
  const symbolParams = [...fileFilters.params];
  const includeLowSignal = args.includeLowSignal === true;
  const callSql = [...fileFilters.sql];
  const fieldSql = [...fileFilters.sql];
  if (!includeLowSignal) callSql.push("signal_tier IN ('primary', 'provider')");
  if (!includeLowSignal) fieldSql.push('confidence >= 0.5');
  if (!includeSynthetic) symbolSql.push("COALESCE(framework_meta_json, '') NOT LIKE '%\"synthetic\":\"true\"%'");
  return {
    symbolSql,
    symbolParams,
    importSql: [...fileFilters.sql],
    importParams: [...fileFilters.params],
    callSql,
    callParams: [...fileFilters.params],
    fieldSql,
    fieldParams: [...fileFilters.params],
    effective: {
      ...fileFilters.effective,
      includeSynthetic,
      includeLowSignal,
      fieldAccess: typeof args.fieldAccess === 'string' ? args.fieldAccess : 'all',
    },
  };
}

export function hasTestIntent(query: string): boolean {
  const expanded = query
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return /\b(test|tests|testable|spec|behavior|behaviour|should|fixture|fixtures|mock|mocks)\b/i.test(expanded);
}

export function hasGeneratedIntent(query: string): boolean {
  return /\b(generated|gen|synthetic)\b/i.test(query);
}

export function hasFixtureIntent(query: string): boolean {
  return /\b(fixture|fixtures|mock|mocks|stub|stubs|testdata)\b/i.test(query);
}

export function hasSyntheticIntent(query: string): boolean {
  return /\b(lombok|synthetic|generated getter|generated setter)\b/i.test(query);
}


export function buildFacets(rows: SymbolRow[]): Record<string, Record<string, number>> {
  const facets = {
    fileRole: {} as Record<string, number>,
    kind: {} as Record<string, number>,
    frameworkRole: {} as Record<string, number>,
    synthetic: {} as Record<string, number>,
  };
  for (const row of rows) {
    incrementFacet(facets.fileRole, row.file_role);
    incrementFacet(facets.kind, row.kind);
    incrementFacet(facets.frameworkRole, row.framework_role ?? 'none');
    incrementFacet(facets.synthetic, isSyntheticSymbol(row) ? 'true' : 'false');
  }
  return facets;
}

export function buildFileFacets(rows: FileRow[]): Record<string, Record<string, number>> {
  const facets = {
    fileRole: {} as Record<string, number>,
    language: {} as Record<string, number>,
    parseStatus: {} as Record<string, number>,
  };
  for (const row of rows) {
    incrementFacet(facets.fileRole, row.file_role);
    incrementFacet(facets.language, row.language ?? 'unknown');
    incrementFacet(facets.parseStatus, row.parse_status);
  }
  return facets;
}

export function buildEndpointFacets(rows: EndpointRow[]): Record<string, Record<string, number>> {
  const facets = {
    method: {} as Record<string, number>,
    framework: {} as Record<string, number>,
    fileRole: {} as Record<string, number>,
    pathResolution: {} as Record<string, number>,
  };
  for (const row of rows) {
    incrementFacet(facets.method, row.method);
    incrementFacet(facets.framework, row.framework);
    incrementFacet(facets.fileRole, row.file_role);
    incrementFacet(facets.pathResolution, row.path_resolution);
  }
  return facets;
}

export function incrementFacet(facet: Record<string, number>, key: string): void {
  facet[key] = (facet[key] ?? 0) + 1;
}

export function groupReferences(references: Array<Record<string, unknown>>, groupBy: string): Array<Record<string, unknown>> {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const reference of references) {
    const key = referenceGroupKey(reference, groupBy);
    const bucket = groups.get(key) ?? [];
    bucket.push(reference);
    groups.set(key, bucket);
  }
  return [...groups.entries()]
    .map(([key, rows]) => ({
      key,
      count: rows.length,
      kinds: [...new Set(rows.map(row => String(row.kind ?? 'unknown')))],
      references: rows.slice(0, 10),
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function slimReferenceForBudget(reference: Record<string, unknown>): Record<string, unknown> {
  return copyDefined({
    file: reference.file,
    line: reference.line,
    column: reference.column,
    kind: reference.kind,
    symbolName: reference.symbolName,
    source: reference.source,
    caller: reference.caller,
    callee: reference.callee,
    confidence: reference.confidence,
    resolutionKind: reference.resolutionKind,
    signalTier: reference.signalTier,
    fieldAccess: reference.fieldAccess,
    enclosingClass: reference.enclosingClass,
    enclosingSymbol: reference.enclosingSymbol,
    ownerClass: reference.ownerClass,
    receiverText: reference.receiverText,
    fileRole: reference.fileRole,
    context: truncateOptional(reference.context, 160),
  });
}

export function slimDependencyTraceEdge(edge: DependencyTraceEdge): Record<string, unknown> {
  return {
    fromFile: edge.fromFile,
    toFile: edge.toFile,
    kind: edge.kind,
    confidence: edge.confidence,
    resolutionKind: edge.resolutionKind,
    depth: edge.depth,
  };
}

export function dependencyTraceGroups(edges: DependencyTraceEdge[]): Array<Record<string, unknown>> {
  const groups = new Map<string, DependencyTraceEdge[]>();
  for (const edge of edges) {
    const key = `${edge.kind}:${edge.depth}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(edge);
    groups.set(key, bucket);
  }
  return [...groups.entries()]
    .map(([key, rows]) => ({
      key,
      kind: key.split(':')[0],
      depth: Number(key.split(':')[1] ?? 0),
      count: rows.length,
      files: rankFiles(rows.flatMap(row => [row.fromFile, row.toFile])).slice(0, 8),
      representativeEdges: rows.slice(0, 3).map(slimDependencyTraceEdge),
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function copyDefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}
