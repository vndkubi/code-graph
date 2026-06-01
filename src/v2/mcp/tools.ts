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
  snippetTokenBudget: z.number().min(100).max(30000).optional(),
};

const PackProfileOption = {
  profile: z.enum(['micro', 'compact', 'full']).optional(),
};

const CallSignalOption = {
  includeLowSignal: z.boolean().optional(),
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
    kind: z.enum(['call', 'import', 'definition', 'field_usage', 'all']).default('all'),
    fieldAccess: z.enum(['all', 'read', 'write', 'read_write', 'init', 'unknown']).default('all'),
    limit: z.number().min(1).max(500).default(100),
    cursor: z.string().optional(),
    groupBy: z.enum(['none', 'file', 'kind', 'caller', 'method', 'class']).default('none'),
    includeSynthetic: z.boolean().optional(),
    includeTests: z.boolean().optional(),
    includeGenerated: z.boolean().optional(),
    includeFixtures: z.boolean().optional(),
    ...CallSignalOption,
    ...FreshnessOptions,
  }),
  get_file_summary: z.object({
    file: z.string(),
    limit: z.number().min(10).max(500).default(80),
    ...SnippetOptions,
    ...FreshnessOptions,
  }),
  get_file_slice: z.object({
    file: z.string().optional(),
    lines: z.string().optional(),
    symbol: z.string().optional(),
    slices: z.array(z.object({
      file: z.string().optional(),
      lines: z.string().optional(),
      symbol: z.string().optional(),
      maxChars: z.number().min(200).max(30000).optional(),
    })).max(20).optional(),
    maxChars: z.number().min(200).max(30000).default(3000),
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
    ...CallSignalOption,
    ...FreshnessOptions,
  }),
  get_callees: z.object({
    symbol: z.string(),
    limit: z.number().min(1).max(200).default(100),
    ...CallSignalOption,
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
    tokenBudget: z.number().min(1000).max(30000).default(8000),
    ...CallSignalOption,
    ...PackProfileOption,
    ...SnippetOptions,
    ...FreshnessOptions,
  }),
  get_research_pack: z.object({
    target: z.string(),
    taskType: z.string().default('research'),
    tokenBudget: z.number().min(1000).max(30000).default(8000),
    ...CallSignalOption,
    ...PackProfileOption,
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
    ...CallSignalOption,
    ...PackProfileOption,
    ...SnippetOptions,
    ...FreshnessOptions,
  }),
  get_change_pack: z.object({
    task: z.string(),
    target: z.string().optional(),
    changeType: z.enum(['implement', 'debug', 'refactor', 'test', 'review', 'investigate']).default('implement'),
    files: z.array(z.string()).optional(),
    symbols: z.array(z.string()).optional(),
    diff: z.string().optional(),
    tokenBudget: z.number().min(1000).max(30000).default(8000),
    maxFiles: z.number().min(1).max(20).default(8),
    maxSymbols: z.number().min(1).max(50).default(12),
    includeTests: z.boolean().default(true),
    ...PackProfileOption,
    ...SnippetOptions,
    ...FreshnessOptions,
  }),
  search_code: z.object({
    query: z.string(),
    limit: z.number().min(1).max(50).default(10),
    outputMode: z.enum(['compact', 'full']).default('compact'),
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
    ...CallSignalOption,
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
      return 'PRIMARY endpoint/API/investigation/request-flow tool. Returns ordered steps, ranked files/symbols, endpoint handlers, call evidence, tests, and capped slices. Call once and answer directly when routing.answerDirectly is true. For implementation/debug/refactor/spec planning, use get_change_pack instead.';
    case 'get_research_pack':
      return 'PRIMARY broad architecture/research tool when no concrete endpoint/API path is named. Returns ranked definitions, flow steps, related edges, top files, and bounded evidence. Do not use for edit/debug/spec tasks; use get_change_pack.';
    case 'get_context_packet':
      return 'Compact implementation/debug router. Returns ranked files/symbols, slice/tool hints, likely tests, validation, and next action. For edits, prefer get_change_pack first.';
    case 'get_change_pack':
      return 'PRIMARY spec/implementation-plan/edit/debug/refactor tool, including read-only planning. Returns scoped files/symbols, exact edit ranges, invariants, likely tests, validation commands, and optional patch impact before editing. Call once before using search_symbol/search_code.';
    case 'search_symbol':
      return 'Targeted fallback symbol lookup after a pack names a missing symbol. Do not use as the first tool for endpoint/API/spec/implementation/review prompts. Supports intent-aware ranking, pagination, facets, and optional rank explanations.';
    case 'search_files':
      return 'Find relevant files by path, symbols, endpoints, imports, dependency signal, and file role. Returns top symbols/endpoints per file, facets, pagination, and optional rank explanations.';
    case 'find_references':
      return 'Find definitions, imports, call references, and Java field usages for a symbol with filters, pagination, and optional grouping by file, kind, caller, method, or class.';
    case 'get_file_summary':
      return 'Summarize a file using persistent symbols, imports, dependencies, and dependents.';
    case 'get_file_slice':
      return 'Return bounded source slices with exact line numbers and truncation metadata. Supports one slice via file+lines or symbol, and batch mode via slices:[{file,lines|symbol,maxChars}] for multiple explicit ranges in ONE call. Use batch mode instead of looping when a prompt asks for several files/ranges.';
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
      return 'Targeted fallback mixed retrieval for a specific missing fact after get_flow_pack/get_research_pack/get_change_pack. Returns file, symbol, endpoint, reference, and dependency sections; avoid using it as a first step for architecture, spec, implementation, or review prompts.';
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
