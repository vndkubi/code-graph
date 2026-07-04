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
  profile: z.enum(['micro', 'compact', 'full']).default('compact'),
};

const ResponseBudgetOptions = {
  outputMode: z.enum(['compact', 'full']).optional(),
  maxResponseTokens: z.number().min(500).max(30000).optional(),
};

const CallSignalOption = {
  includeLowSignal: z.boolean().optional(),
};

const DebugTimingOption = {
  debugTiming: z.boolean().optional(),
};

// Session evidence ledger. Pass a stable `sessionId` on every call in a
// conversation to let CodeGraph omit source bodies it already delivered (avoids
// duplicate token spend). Without sessionId every packet stays self-contained.
// `freshEvidence: true` forces full bodies even within a session.
const EvidenceLedgerOption = {
  sessionId: z.string().optional(),
  freshEvidence: z.boolean().optional(),
};

export const V2ToolSchemas = {
  codegraph_status: z.object({
    includeDiagnostics: z.boolean().default(false),
  }),
  codegraph_context: z.object({
    task: z.string(),
    mode: z.enum(['auto', 'research', 'flow', 'change', 'review', 'evidence']).default('auto'),
    responseMode: z.enum(['agent', 'answer']).optional(),
    target: z.string().optional(),
    diff: z.string().optional(),
    files: z.array(z.string()).optional(),
    symbols: z.array(z.string()).optional(),
    budgetTokens: z.number().min(1000).max(30000).default(6000),
    riskMode: z.enum(['auto', 'calculation_sensitive']).optional(),
    ...PackProfileOption,
    ...SnippetOptions,
    ...FreshnessOptions,
    ...DebugTimingOption,
    ...EvidenceLedgerOption,
  }),
  codegraph_slice: z.object({
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
    ...ResponseBudgetOptions,
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
    ...ResponseBudgetOptions,
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
    outputMode: z.enum(['compact', 'full']).default('compact'),
    maxResponseTokens: z.number().min(500).max(30000).optional(),
    skipLikelyTests: z.boolean().optional(),
    callSeedLimit: z.number().min(0).max(30).optional(),
    riskMode: z.enum(['auto', 'calculation_sensitive']).optional(),
    ...DebugTimingOption,
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
    responseMode: z.enum(['answer', 'agent', 'full']).default('agent'),
    ...CallSignalOption,
    ...PackProfileOption,
    ...SnippetOptions,
    ...FreshnessOptions,
    ...EvidenceLedgerOption,
  }),
  get_research_pack: z.object({
    target: z.string(),
    taskType: z.string().default('research'),
    tokenBudget: z.number().min(1000).max(30000).default(8000),
    responseMode: z.enum(['answer', 'agent', 'full']).default('agent'),
    ...CallSignalOption,
    ...PackProfileOption,
    ...SnippetOptions,
    ...FreshnessOptions,
    ...EvidenceLedgerOption,
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
    ...EvidenceLedgerOption,
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
    riskMode: z.enum(['auto', 'calculation_sensitive']).optional(),
    ...PackProfileOption,
    ...SnippetOptions,
    ...DebugTimingOption,
    ...FreshnessOptions,
    ...EvidenceLedgerOption,
  }),
  compile_evidence: z.object({
    task: z.string(),
    taskType: z.enum(['api_flow', 'field_impact', 'review_diff', 'startup_flow', 'implement', 'investigate', 'test', 'unknown']).default('unknown'),
    task_type: z.enum(['api_flow', 'field_impact', 'review_diff', 'startup_flow', 'implement', 'investigate', 'test', 'unknown']).optional(),
    target: z.string().optional(),
    diff: z.string().optional(),
    files: z.array(z.string()).optional(),
    symbols: z.array(z.string()).optional(),
    budgetTokens: z.number().min(1000).max(30000).default(5000),
    budget_tokens: z.number().min(1000).max(30000).optional(),
    qualityRubric: z.array(z.string()).max(20).optional(),
    quality_rubric: z.array(z.string()).max(20).optional(),
    maxEvidenceItems: z.number().min(1).max(20).default(8),
    max_evidence_items: z.number().min(1).max(20).optional(),
    allowTargetedShell: z.boolean().default(true),
    allow_targeted_shell: z.boolean().optional(),
    ...PackProfileOption,
    ...SnippetOptions,
    ...FreshnessOptions,
  }),
  generate_repo_atlas: z.object({
    format: z.enum(['json', 'markdown']).default('json'),
    profile: z.enum(['micro', 'compact', 'full']).default('compact'),
    maxModules: z.number().min(1).max(80).default(12),
    maxEntrypoints: z.number().min(1).max(200).default(30),
    maxHotspots: z.number().min(1).max(200).default(25),
    includeTests: z.boolean().default(true),
    includeGenerated: z.boolean().optional(),
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
    maxResponseTokens: z.number().min(500).max(30000).optional(),
    ...CallSignalOption,
    ...SnippetOptions,
    ...FreshnessOptions,
  }),
  get_index_stats: z.object({
    ...FreshnessOptions,
  }),
};

export type V2ToolName = keyof typeof V2ToolSchemas;
export type V2ToolProfile = 'client' | 'minimal' | 'research' | 'change' | 'review' | 'full';

export const V2_TOOL_PROFILES: Record<V2ToolProfile, readonly V2ToolName[]> = {
  client: ['codegraph_context', 'codegraph_slice', 'codegraph_status'],
  minimal: ['codegraph_context', 'codegraph_slice', 'codegraph_status'],
  research: ['codegraph_context', 'codegraph_slice', 'codegraph_status'],
  change: ['codegraph_context', 'codegraph_slice', 'codegraph_status'],
  review: ['codegraph_context', 'codegraph_slice', 'codegraph_status'],
  full: Object.keys(V2ToolSchemas) as V2ToolName[],
};

export interface V2ToolDefinitionOptions {
  compactDescriptions?: boolean;
  /**
   * Advertise a trimmed codegraph_context schema (client profiles): 5 params
   * instead of 17. Fewer knobs = fewer tokens in every tools/list and less
   * decision friction for the model. The server keeps parsing the full zod
   * schema, so power params still work if a client sends them anyway.
   */
  slimClientSchemas?: boolean;
}

/**
 * Hand-written advertised schema for the client-profile gate. Property
 * descriptions double as usage guidance — this is the only place many models
 * read per-parameter semantics.
 */
const SLIM_CODEGRAPH_CONTEXT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    task: { type: 'string', description: "The user's task, verbatim. Full sentences route better than keywords." },
    mode: { type: 'string', enum: ['auto', 'research', 'flow', 'change', 'review', 'evidence'], description: 'Optional override; auto infers from the task.' },
    target: { type: 'string', description: 'Optional focus: a symbol, endpoint path, or file.' },
    diff: { type: 'string', description: 'Unified diff for review tasks.' },
    sessionId: { type: 'string', description: 'Any constant string per conversation. Enables evidence reuse so repeated calls skip source you already received.' },
  },
  required: ['task'],
};

export const V2_TOOL_DEFINITIONS = buildV2ToolDefinitions({
  compactDescriptions: envFlag(process.env.CODEGRAPH_MCP_COMPACT_TOOL_DESCRIPTIONS, true),
});

export function buildV2ToolDefinitions(options: V2ToolDefinitionOptions = {}): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return Object.entries(V2ToolSchemas).map(([name, schema]) => ({
    name,
    description: descriptionFor(name as V2ToolName, options),
    inputSchema: options.slimClientSchemas && name === 'codegraph_context'
      ? SLIM_CODEGRAPH_CONTEXT_SCHEMA
      : zodToJsonSchema(schema),
  }));
}

/**
 * The tool list a given MCP profile advertises: profile-filtered, compact
 * descriptions per env default, slim gate schema on every profile except full.
 * Ordered as the profile declares (gate first) — list position is one more
 * signal clients use when picking a tool.
 */
export function buildV2ToolDefinitionsForProfile(profile: string | undefined): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const normalized = normalizeMcpToolProfile(profile) ?? 'client';
  const order = V2_TOOL_PROFILES[normalized];
  const definitions = buildV2ToolDefinitions({
    compactDescriptions: envFlag(process.env.CODEGRAPH_MCP_COMPACT_TOOL_DESCRIPTIONS, true),
    slimClientSchemas: normalized !== 'full',
  });
  const byName = new Map(definitions.map(tool => [tool.name, tool]));
  return order.map(name => byName.get(name)).filter((tool): tool is NonNullable<typeof tool> => tool !== undefined);
}

export function parseToolArgs(name: string, args: unknown): Record<string, unknown> {
  const schema = V2ToolSchemas[name as V2ToolName];
  if (!schema) throw new Error(`Unknown v2 tool: ${name}`);
  return schema.parse(args ?? {}) as Record<string, unknown>;
}

export function mcpToolNamesForProfile(profile: string | undefined): Set<string> | undefined {
  const normalized = normalizeMcpToolProfile(profile);
  if (!normalized) return new Set(V2_TOOL_PROFILES.client);
  return new Set(V2_TOOL_PROFILES[normalized]);
}

export function normalizeMcpToolProfile(profile: string | undefined): V2ToolProfile | undefined {
  const value = profile?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === 'client' || value === 'minimal' || value === 'research' || value === 'change' || value === 'review' || value === 'full') {
    return value;
  }
  throw new Error(`Unknown MCP tool profile: ${profile}. Expected client, minimal, research, change, review, or full.`);
}

function descriptionFor(name: V2ToolName, options: V2ToolDefinitionOptions = {}): string {
  if (options.compactDescriptions) return compactDescriptionFor(name);
  switch (name) {
    case 'codegraph_status':
      return 'Diagnostic only. Returns workspace SQLite readiness, artifact readiness, and optional DB diagnostics. Do not use for normal code investigation.';
    case 'codegraph_context':
      return 'Call this FIRST for almost any repository question or before an edit: investigate code, understand how X works, explore architecture, trace endpoint/request flows, debug bugs, plan changes, assess impact, or review risk. One call on the pre-indexed code graph returns ranked files, call/dependency edges, and line-numbered source evidence for the whole task — replacing a grep/read/grep exploration loop (benchmarked: ~20% fewer tokens, ~5x fewer tool round-trips than raw file reads). Pass the user\'s task verbatim and reuse one sessionId per conversation. If the response says answerable=true, answer from it and stop searching.';
    case 'codegraph_slice':
      return 'Follow-up source reader: when codegraph_context names an exact file, line range, or symbol still missing, fetch just that bounded slice (batch several via slices[]). Not a first tool for broad repo questions — the packet usually already contains the source as evidenceSlices.';
    case 'get_flow_pack':
      return 'Flow pack for explicit route, endpoint, API, request-flow, startup-flow, or handler-flow tracing. Default responseMode=agent returns ordered steps, ranked files/symbols, call evidence, capped source slices, taskOracle, evidenceHandles, answerable, allowedFollowups, disallowedFollowups, and a stopRule. If answerable=true, answer from the packet and do not use rg/shell search. For implementation, debug, refactor, bug, or spec planning prompts, use get_change_pack instead. codegraph_context routes here automatically.';
    case 'get_research_pack':
      return 'Research pack for onboarding, surveying an area, "where/what is X", or "how does X work" when no concrete endpoint/API path or edit is named. Returns ranked definitions, flow steps, related edges, top files, bounded evidence, budget metrics, and evidenceHandles. For edit/debug/spec tasks, use get_change_pack. codegraph_context routes here automatically.';
    case 'get_context_packet':
      return 'Compact implementation/debug router for internal or legacy clients. Returns ranked files/symbols, slice/tool hints, likely tests, validation, and next action. For new edit planning, prefer codegraph_context or get_change_pack first.';
    case 'get_change_pack':
      return 'Change pack for implementing, debugging, refactoring, testing, modifying files, or answering "what should I change". Default profile=compact returns scoped files/symbols, exact edit ranges, evidenceHandles, invariants, likely tests, validation commands, and optional patch impact before search_symbol/search_code. codegraph_context routes here automatically.';
    case 'compile_evidence':
      return 'TokenOpt-style cost gate and evidence compiler for compact evidence on a repo task, PBI, investigation, review, or plan with minimal turns. Given a full task, taskType, budget, and optional rubric/diff, returns an answerability certificate, compact evidence, missing coverage, allowed exact follow-ups, disallowed broad follow-ups, and budget metadata. codegraph_context routes here automatically.';
    case 'search_symbol':
      return 'FOLLOW-UP ONLY symbol lookup after codegraph_context or a pack names a missing symbol. Do not use as the first tool for endpoint/API/spec/implementation/review prompts. Supports intent-aware ranking, pagination, facets, and optional rank explanations.';
    case 'search_files':
      return 'FOLLOW-UP ONLY file lookup after a pack identifies a missing path, feature area, endpoint, import, dependency signal, or file role. Returns top symbols/endpoints per file, facets, pagination, and optional rank explanations; avoid as the first broad exploration tool.';
    case 'find_references':
      return 'FOLLOW-UP ONLY exact-reference lookup for a known symbol. Finds definitions, imports, call references, and Java field usages with filters, pagination, and optional grouping by file, kind, caller, method, or class.';
    case 'get_file_summary':
      return 'Summarize a file using persistent symbols, imports, dependencies, and dependents.';
    case 'get_file_slice':
      return 'FOLLOW-UP ONLY exact source reader after a pack names file/line/symbol evidence. Returns bounded source slices with line numbers and truncation metadata. Supports batch mode via slices:[{file,lines|symbol,maxChars}] for multiple explicit ranges in ONE call; do not use for broad repo discovery.';
    case 'get_dependencies':
      return 'Return direct dependency edges for a file or module.';
    case 'get_dependents':
      return 'Return direct dependent edges for a file or module.';
    case 'get_callers':
      return 'FOLLOW-UP ONLY for a known symbol. Return call sites that call the symbol.';
    case 'get_callees':
      return 'FOLLOW-UP ONLY for a known symbol. Return symbols called by the caller symbol.';
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
      return 'Simulate patch impact from changed files, symbols, or a unified diff. Default outputMode=compact/maxResponseTokens caps broad graph rows while preserving touched symbols, dependency/call counts, endpoints, likely tests, validation commands, and risk flags; use outputMode=full only when expanded evidence is needed.';
    case 'review_patch':
      return 'Review packet for code review prompts with changed files, symbols, or a unified diff: verdict, top findings, risky hunks, capped evidence, validation gaps, and next tool calls. Use outputMode=full only when the agent explicitly needs expanded evidence. codegraph_context routes here automatically for review tasks.';
    case 'find_tests_for':
      return 'Find tests likely relevant to a symbol using test file names, test symbols, and indexed call edges.';
    case 'search_code':
      return 'FOLLOW-UP ONLY capped mixed retrieval for a specific missing fact after codegraph_context, get_flow_pack, get_research_pack, or get_change_pack. Returns ranked file, symbol, endpoint, reference, and dependency sections when they fit maxResponseTokens; avoid as a first step for architecture, spec, implementation, or review prompts.';
    case 'generate_repo_atlas':
      return 'Generate a deterministic whole-repo architecture atlas from indexed facts only: system summary, modules, entrypoints, feature flows, risk hotspots, validation hints, and next tool calls. Use after indexing instead of asking the model to scan source files.';
    case 'get_index_stats':
      return 'Return persistent index and graph statistics plus health diagnostics such as parse failures, stale files, unresolved calls/imports, and framework warnings.';
  }
}

function compactDescriptionFor(name: V2ToolName): string {
  switch (name) {
    case 'codegraph_status':
      return 'Diagnostic only: runtime/index readiness and optional SQLite diagnostics.';
    case 'codegraph_context':
      return 'Call this FIRST for any repo question or before any edit. One call on the pre-indexed code graph returns ranked files, call/dependency edges, and line-numbered source for the whole task — replaces a grep/read/grep loop (benchmarked: ~20% fewer tokens, ~5x fewer round-trips than raw file reads). Pass the task verbatim; reuse one sessionId per conversation. If the response says answerable=true, answer from it and stop searching.';
    case 'codegraph_slice':
      return 'Follow-up source reader: when codegraph_context names an exact file/line/symbol still missing, fetch just that bounded slice (batch several via slices[]). Not a first tool — the packet usually already contains the source as evidenceSlices.';
    case 'get_flow_pack':
      return 'Flow pack for explicit route/API/request-flow tracing. Returns ordered steps, answerable, stopRule; for edit/debug/spec use get_change_pack. codegraph_context routes here automatically.';
    case 'get_research_pack':
      return 'Research pack for onboarding, surveying an area, where/what is X, or how X works. For edit/debug/spec use get_change_pack. codegraph_context routes here automatically.';
    case 'get_context_packet':
      return 'Compact implementation/debug router: ranked files/symbols, slices, tests, validation, next action.';
    case 'get_change_pack':
      return 'Change pack for implement/debug/refactor/test/edit tasks: scoped files/symbols, edit handles, risks, tests, validation. codegraph_context routes here automatically.';
    case 'compile_evidence':
      return 'TokenOpt-style evidence compiler/cost gate for repo tasks, PBIs, answerability, or rubric coverage. Exact follow-ups, stop rules. codegraph_context routes here automatically.';
    case 'search_symbol':
      return 'FOLLOW-UP ONLY symbol lookup after a pack names a missing symbol. Includes ranking, facets, pagination.';
    case 'search_files':
      return 'FOLLOW-UP ONLY file lookup for a missing path/area/endpoint/import/dependency/file role. Includes facets/pagination.';
    case 'find_references':
      return 'FOLLOW-UP ONLY exact symbol references: definitions, imports, calls, Java field usages. Optional grouping.';
    case 'get_file_summary':
      return 'Summarize one file from indexed symbols, imports, dependencies, dependents.';
    case 'get_file_slice':
      return 'FOLLOW-UP ONLY exact source slice(s) after file/line/symbol evidence is known. Batch explicit ranges via slices[] instead of looping.';
    case 'get_dependencies':
      return 'Direct dependency edges for file/module.';
    case 'get_dependents':
      return 'Direct dependent edges for file/module.';
    case 'get_callers':
      return 'FOLLOW-UP ONLY call sites for a known symbol.';
    case 'get_callees':
      return 'FOLLOW-UP ONLY callees for a known caller symbol.';
    case 'find_endpoints':
      return 'Find Java/Jakarta/Spring endpoint handlers with composed paths and resolution metadata.';
    case 'get_impact_radius':
      return 'Estimate impact using dependents, callers, endpoint candidates.';
    case 'trace_dependencies':
      return 'Trace file/module dependencies/dependents with seeds, edges, endpoints, cycles/diagnostics.';
    case 'explain_endpoint':
      return 'Endpoint slice: controller, call chain, service/repository/entity/DTO candidates, tests.';
    case 'impact_of_symbol':
      return 'Symbol impact slice: definitions, callers, callees, endpoints, tests, top files.';
    case 'simulate_patch_impact':
      return 'Capped patch impact from files/symbols/diff: touched symbols, graph impact counts, endpoints, tests, risks.';
    case 'review_patch':
      return 'Review packet for changed files/symbols/diff: verdict, findings, risky hunks, evidence, validation gaps. codegraph_context routes here automatically for review tasks.';
    case 'find_tests_for':
      return 'Find tests relevant to a symbol using names, test symbols, call edges.';
    case 'search_code':
      return 'FOLLOW-UP ONLY capped mixed retrieval for one missing fact after codegraph_context or pack tools.';
    case 'generate_repo_atlas':
      return 'Deterministic whole-repo atlas from indexed facts: modules, entrypoints, feature flows, hotspots, validation.';
    case 'get_index_stats':
      return 'Index/graph stats and health diagnostics: stale files, parse failures, unresolved calls/imports, warnings.';
  }
}

function envFlag(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
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
