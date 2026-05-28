import { z } from 'zod';

const FreshnessOptions = {
  autoRefresh: z.boolean().optional(),
  warnStale: z.boolean().optional(),
};

const SnippetOptions = {
  includeSnippets: z.boolean().optional(),
  // LLM clients sometimes over-ask for source context. Query services clamp this
  // value per tool, so keep the MCP schema permissive enough to avoid a hard
  // parse failure before the service can apply its own budget.
  snippetLines: z.number().min(1).max(240).optional(),
  snippetTokenBudget: z.number().min(100).max(12000).optional(),
};

export const V2ToolSchemas = {
  search_symbol: z.object({
    query: z.string().default('*'),
    kind: z.string().default('all'),
    limit: z.number().min(1).max(200).default(20),
    cursor: z.string().optional(),
    includeSynthetic: z.boolean().optional(),
    includeTests: z.boolean().optional(),
    includeGenerated: z.boolean().optional(),
    includeFixtures: z.boolean().optional(),
    explainRank: z.boolean().default(false),
    annotation: z.string().optional(),
    frameworkRole: z.string().optional(),
    ...SnippetOptions,
    ...FreshnessOptions,
  }),
  search_files: z.object({
    query: z.string().default('*'),
    limit: z.number().min(1).max(200).default(20),
    cursor: z.string().optional(),
    includeTests: z.boolean().optional(),
    includeGenerated: z.boolean().optional(),
    includeFixtures: z.boolean().optional(),
    explainRank: z.boolean().default(false),
    fileRole: z.string().optional(),
    language: z.string().optional(),
    ...SnippetOptions,
    ...FreshnessOptions,
  }),
  find_references: z.object({
    symbol: z.string(),
    kind: z.enum(['call', 'import', 'definition', 'all']).default('all'),
    limit: z.number().min(1).max(500).default(100),
    cursor: z.string().optional(),
    groupBy: z.enum(['none', 'file', 'kind', 'caller']).default('none'),
    includeSynthetic: z.boolean().optional(),
    includeTests: z.boolean().optional(),
    includeGenerated: z.boolean().optional(),
    includeFixtures: z.boolean().optional(),
    ...FreshnessOptions,
  }),
  get_file_summary: z.object({
    file: z.string(),
    ...SnippetOptions,
    ...FreshnessOptions,
  }),
  get_file_slice: z.object({
    file: z.string().optional(),
    lines: z.string().optional(),
    symbol: z.string().optional(),
    maxChars: z.number().min(200).max(30000).default(8000),
    ...FreshnessOptions,
  }),
  get_dependencies: z.object({
    module: z.string(),
    ...FreshnessOptions,
  }),
  get_dependents: z.object({
    module: z.string(),
    ...FreshnessOptions,
  }),
  get_callers: z.object({
    symbol: z.string(),
    limit: z.number().min(1).max(200).default(100),
    ...FreshnessOptions,
  }),
  get_callees: z.object({
    symbol: z.string(),
    limit: z.number().min(1).max(200).default(100),
    ...FreshnessOptions,
  }),
  find_endpoints: z.object({
    method: z.string().default('all'),
    path: z.string().optional(),
    limit: z.number().min(1).max(500).default(200),
    cursor: z.string().optional(),
    explainRank: z.boolean().default(false),
    ...SnippetOptions,
    ...FreshnessOptions,
  }),
  get_impact_radius: z.object({
    target: z.string(),
    ...FreshnessOptions,
  }),
  trace_dependencies: z.object({
    target: z.string(),
    direction: z.enum(['dependencies', 'dependents', 'both']).default('both'),
    depth: z.number().min(1).max(5).default(2),
    limit: z.number().min(1).max(1000).default(200),
    includeTests: z.boolean().optional(),
    includeGenerated: z.boolean().optional(),
    includeFixtures: z.boolean().optional(),
    fileRole: z.string().optional(),
    language: z.string().optional(),
    ...FreshnessOptions,
  }),
  explain_endpoint: z.object({
    path: z.string(),
    method: z.string().default('all'),
    depth: z.number().min(1).max(5).default(3),
    ...SnippetOptions,
    ...FreshnessOptions,
  }),
  impact_of_symbol: z.object({
    symbol: z.string(),
    limit: z.number().min(1).max(50).default(10),
    ...SnippetOptions,
    ...FreshnessOptions,
  }),
  simulate_patch_impact: z.object({
    files: z.array(z.string()).optional(),
    symbols: z.array(z.string()).optional(),
    diff: z.string().optional(),
    limit: z.number().min(1).max(200).default(50),
    skipLikelyTests: z.boolean().optional(),
    callSeedLimit: z.number().min(0).max(30).optional(),
    ...FreshnessOptions,
  }),
  review_patch: z.object({
    files: z.array(z.string()).optional(),
    symbols: z.array(z.string()).optional(),
    diff: z.string().optional(),
    focus: z.enum(['general', 'bug-risk', 'api-contract', 'tests', 'security']).default('general'),
    outputMode: z.enum(['compact', 'balanced', 'full']).default('compact'),
    includeLikelyTests: z.boolean().optional(),
    maxFindings: z.number().min(1).max(50).optional(),
    maxLineFocus: z.number().min(1).max(100).optional(),
    maxEvidencePerFinding: z.number().min(1).max(20).optional(),
    maxRequiredToolCalls: z.number().min(1).max(20).optional(),
    limit: z.number().min(1).max(200).default(50),
    ...FreshnessOptions,
  }),
  find_tests_for: z.object({
    symbol: z.string(),
    limit: z.number().min(1).max(200).default(50),
    ...FreshnessOptions,
  }),
  get_flow_pack: z.object({
    target: z.string(),
    taskType: z.string().default('architecture'),
    tokenBudget: z.number().min(1000).max(12000).default(8000),
    ...SnippetOptions,
    ...FreshnessOptions,
  }),
  get_research_pack: z.object({
    target: z.string(),
    taskType: z.string().default('research'),
    tokenBudget: z.number().min(1000).max(12000).default(8000),
    ...SnippetOptions,
    ...FreshnessOptions,
  }),
  get_context_packet: z.object({
    task: z.string(),
    domain: z.string().optional(),
    tokenBudget: z.number().min(1000).max(30000).default(8000),
    maxFiles: z.number().min(1).max(20).default(8),
    maxSymbols: z.number().min(1).max(50).default(12),
    includeTests: z.boolean().default(true),
    ...SnippetOptions,
    ...FreshnessOptions,
  }),
  search_code: z.object({
    query: z.string(),
    limit: z.number().min(1).max(50).default(10),
    includeReferences: z.boolean().default(true),
    includeDependencies: z.boolean().default(true),
    includeSynthetic: z.boolean().optional(),
    includeTests: z.boolean().optional(),
    includeGenerated: z.boolean().optional(),
    includeFixtures: z.boolean().optional(),
    explainRank: z.boolean().default(false),
    groupBy: z.enum(['none', 'file', 'kind', 'caller']).default('file'),
    depth: z.number().min(1).max(5).default(1),
    method: z.string().default('all'),
    ...SnippetOptions,
    ...FreshnessOptions,
  }),
  get_index_stats: z.object({
    ...FreshnessOptions,
  }),
};

export type V2ToolName = keyof typeof V2ToolSchemas;

export const V2_TOOL_DEFINITIONS = Object.entries(V2ToolSchemas).map(([name, schema]) => ({
  name,
  description: descriptionFor(name as V2ToolName),
  inputSchema: zodToJsonSchema(schema),
}));

export function parseToolArgs(name: string, args: unknown): Record<string, unknown> {
  const schema = V2ToolSchemas[name as V2ToolName];
  if (!schema) throw new Error(`Unknown v2 tool: ${name}`);
  return schema.parse(args ?? {}) as Record<string, unknown>;
}

function descriptionFor(name: V2ToolName): string {
  switch (name) {
    case 'get_flow_pack':
      return 'PRIMARY/FALLBACK-STOP TOOL for architecture and "how does X work" questions. Returns an answer-ready flow pack in one call: ordered steps, ranked symbols/files, call/dependency evidence, and capped source slices with line numbers. Answer directly from this pack; use granular search/slice tools only if missingFacts says evidence is insufficient.';
    case 'get_research_pack':
      return 'PRIMARY TOOL for research/architecture questions. Returns an answer-ready pack with flow steps, ranked definitions, related edges, top files, and capped source evidence in ONE call. Usually enough to answer without search_code/search_symbol/get_file_slice; call those only when missingFacts lists a specific gap.';
    case 'get_context_packet':
      return 'Route an implementation/debugging task to a compact context packet with domain guess, candidate files/symbols, small snippets, likely tests, validation hints, confidence, omissions, and a next action. For architecture/how-does-X-work questions prefer get_research_pack/get_flow_pack first.';
    case 'search_symbol':
      return 'Search indexed symbols with intent-aware ranking, pagination, facets, and optional rank explanations. Hides Lombok synthetic symbols, tests, generated files, and fixtures by default unless requested or implied by the query.';
    case 'search_files':
      return 'Find relevant files by path, symbols, endpoints, imports, dependency signal, and file role. Returns top symbols/endpoints per file, facets, pagination, and optional rank explanations.';
    case 'find_references':
      return 'Find definitions, imports, and call references for a symbol with filters, pagination, and optional grouping by file, kind, or caller.';
    case 'get_file_summary':
      return 'Summarize a file using persistent symbols, imports, dependencies, and dependents.';
    case 'get_file_slice':
      return 'Return one bounded source slice by file and line range, or by indexed symbol, with exact line numbers and truncation metadata. Use for editing or for one explicit missing range; do not loop this after get_research_pack/get_flow_pack when evidenceSlices already contain the needed source.';
    case 'get_dependencies':
      return 'Return direct dependency edges for a file or module.';
    case 'get_dependents':
      return 'Return direct dependent edges for a file or module.';
    case 'get_callers':
      return 'Return call sites that call a symbol.';
    case 'get_callees':
      return 'Return symbols called by a caller symbol.';
    case 'find_endpoints':
      return 'Find Java/Jakarta/Spring endpoint handlers with composed class+method paths and path resolution metadata.';
    case 'get_impact_radius':
      return 'Estimate change impact using dependents, callers, and endpoint candidates.';
    case 'trace_dependencies':
      return 'Trace direct or transitive file/module dependencies, dependents, or both, with seed files, graph edges, impacted endpoints, and cycle hints.';
    case 'explain_endpoint':
      return 'Return an agent-ready endpoint slice: controller, call chain, service/repository/entity/DTO candidates, top files, and likely tests.';
    case 'impact_of_symbol':
      return 'Return an agent-ready impact slice for a symbol: definitions, callers, callees, affected endpoints, likely tests, and top files.';
    case 'simulate_patch_impact':
      return 'Simulate patch impact from changed files, symbols, or a unified diff. Returns touched symbols, dependency/call impact, endpoints, likely tests, validation commands, and risk flags before editing.';
    case 'review_patch':
      return 'Build a budgeted code review packet from changed files, symbols, or a unified diff: verdict, top findings, risky hunks, capped evidence, validation gaps, and next tool calls. Use outputMode=full only when the agent explicitly needs expanded evidence.';
    case 'find_tests_for':
      return 'Find tests likely relevant to a symbol using test file names, test symbols, and indexed call edges.';
    case 'search_code':
      return 'Fallback mixed retrieval search for when get_research_pack/get_flow_pack reports low confidence or missing facts. Returns file, symbol, endpoint, reference, and dependency sections; avoid using it as a first step for architecture questions.';
    case 'get_index_stats':
      return 'Return persistent index and graph statistics plus health diagnostics such as parse failures, stale files, unresolved calls/imports, and framework warnings.';
  }
}

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) required.push(key);
    }
    return { type: 'object', properties, required };
  }
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: schema.options };
  if (schema instanceof z.ZodArray) return { type: 'array', items: zodToJsonSchema(schema.element) };
  if (schema instanceof z.ZodDefault) return zodToJsonSchema(schema._def.innerType);
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap());
  return { type: 'string' };
}
