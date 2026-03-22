#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { FileIndexer } from './index/file-indexer.js';
import { startStdioTransport } from './transport/stdio.js';
import { startHttpTransport } from './transport/http.js';

// Tool imports
import { FindReferencesSchema, findReferences } from './tools/find-references.js';
import { GetDependentsSchema, getDependents } from './tools/get-dependents.js';
import { GetDependenciesSchema, getDependencies } from './tools/get-dependencies.js';
import { GetCallChainSchema, getCallChain } from './tools/get-call-chain.js';
import { GetImpactRadiusSchema, getImpactRadius } from './tools/get-impact-radius.js';
import { FindCyclesSchema, findCircularDependencies } from './tools/find-cycles.js';
import { GetModuleGraphSchema, getModuleGraph } from './tools/get-module-graph.js';
import { SearchSymbolSchema, searchSymbol } from './tools/search-symbol.js';
import { GetCallersSchema, getCallers } from './tools/get-callers.js';
import { GetCalleesSchema, getCallees } from './tools/get-callees.js';
import { FindEndpointsSchema, findEndpoints } from './tools/find-endpoints.js';
import { GetFileSummarySchema, getFileSummary } from './tools/get-file-summary.js';
import { FindDeadCodeSchema, findDeadCode } from './tools/find-dead-code.js';
import { CheckLayerViolationsSchema, checkLayerViolations } from './tools/check-layer-violations.js';
import { GetTypeUsageSchema, getTypeUsage } from './tools/get-type-usage.js';
import { GetIndexStatsSchema, getIndexStats } from './tools/get-index-stats.js';
import { FindSimilarClassesSchema, findSimilarClasses } from './tools/find-similar-classes.js';
import { FindFieldShadowsSchema, findFieldShadows } from './tools/find-field-shadows.js';
import { ReviewChangedFilesSchema, reviewChangedFiles } from './tools/review-changed-files.js';
import { GetPrImpactSummarySchema, getPrImpactSummary } from './tools/get-pr-impact-summary.js';
import { CheckArchitecturalDeltaSchema, checkArchitecturalDelta } from './tools/check-architectural-delta.js';

import { z } from 'zod';

// ─── CLI Argument Parsing ─────────────────────────────────

interface CliOptions {
  root: string;
  transport: 'stdio' | 'http';
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  cacheTtl: number;
  maxFileSize: number;
  exclude: string[];
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    root: process.cwd(),
    transport: 'stdio',
    port: 3000,
    logLevel: 'warn',
    cacheTtl: 300_000,
    maxFileSize: 500,
    exclude: [],
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--root':
        opts.root = argv[++i];
        break;
      case '--transport':
        opts.transport = argv[++i] as 'stdio' | 'http';
        break;
      case '--port':
        opts.port = parseInt(argv[++i], 10);
        break;
      case '--log-level':
        opts.logLevel = argv[++i] as CliOptions['logLevel'];
        break;
      case '--cache-ttl':
        opts.cacheTtl = parseInt(argv[++i], 10);
        break;
      case '--max-file-size':
        opts.maxFileSize = parseInt(argv[++i], 10);
        break;
      case '--exclude':
        opts.exclude.push(argv[++i]);
        break;
      case '--version':
        console.log('mcp-code-graph v1.0.0');
        process.exit(0);
      case '--help':
        printHelp();
        process.exit(0);
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
  }

  return opts;
}

function printHelp(): void {
  console.log(`
mcp-code-graph - MCP server for real-time codebase dependency graph

Usage: mcp-code-graph [options]

Options:
  --root <path>        Repo root to analyze (default: current directory)
  --transport <type>   Transport: stdio (default) | http
  --port <number>      HTTP port (only with --transport http, default: 3000)
  --log-level <level>  debug | info | warn | error (default: warn)
  --cache-ttl <ms>     Cache TTL in milliseconds (default: 300000 = 5 min)
  --max-file-size <kb> Skip files larger than N KB (default: 500)
  --exclude <glob>     Exclude pattern (repeatable)
  --version            Show version
  --help               Show help
`);
}

// ─── Tool Definitions ─────────────────────────────────────

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // Minimal zod → JSON Schema converter for MCP tool definitions
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
        required.push(key);
      }
    }

    return { type: 'object', properties, required };
  }
  if (schema instanceof z.ZodString) return { type: 'string', description: schema.description };
  if (schema instanceof z.ZodNumber) return { type: 'number', description: schema.description };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean', description: schema.description };
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: schema.options, description: schema.description };
  if (schema instanceof z.ZodArray) return { type: 'array', items: zodToJsonSchema(schema.element), description: schema.description };
  if (schema instanceof z.ZodDefault) return zodToJsonSchema(schema._def.innerType);
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap());
  return { type: 'string' };
}

const TOOL_DEFINITIONS = [
  {
    name: 'find_references',
    description: 'Find all locations in the codebase that reference a given symbol (class, function, variable, interface). Returns file, line, kind, and surrounding context.',
    inputSchema: zodToJsonSchema(FindReferencesSchema),
  },
  {
    name: 'get_dependents',
    description: 'Find all modules that depend ON a given module — who imports or uses it. Supports recursive transitive analysis.',
    inputSchema: zodToJsonSchema(GetDependentsSchema),
  },
  {
    name: 'get_dependencies',
    description: 'Find all modules that a given module depends ON — what does it import. Filter by local/external.',
    inputSchema: zodToJsonSchema(GetDependenciesSchema),
  },
  {
    name: 'get_call_chain',
    description: 'Find the call path from function/method A to function/method B, tracing through the call graph. Returns shortest path by default.',
    inputSchema: zodToJsonSchema(GetCallChainSchema),
  },
  {
    name: 'get_impact_radius',
    description: 'Given a module or class, compute the full blast radius — what would be affected if it changes. Returns direct and transitive impact with risk assessment.',
    inputSchema: zodToJsonSchema(GetImpactRadiusSchema),
  },
  {
    name: 'find_circular_dependencies',
    description: 'Detect all circular import cycles in the codebase. Returns severity-rated cycles with suggestions to break them.',
    inputSchema: zodToJsonSchema(FindCyclesSchema),
  },
  {
    name: 'get_module_graph',
    description: 'Return the full dependency graph for visualization or analysis. Supports JSON, Mermaid, and DOT output formats.',
    inputSchema: zodToJsonSchema(GetModuleGraphSchema),
  },
  {
    name: 'search_symbol',
    description: 'Search for symbols by name pattern, kind, annotation, or framework role. Supports regex. Framework roles include spring:service, spring:endpoint, jakarta:entity, test:test, lombok:builder, etc.',
    inputSchema: zodToJsonSchema(SearchSymbolSchema),
  },
  {
    name: 'get_callers',
    description: 'Find all callers of a function/method — who calls this symbol? Supports transitive callers.',
    inputSchema: zodToJsonSchema(GetCallersSchema),
  },
  {
    name: 'get_callees',
    description: 'Find all functions/methods that a given symbol calls — what does this call? Supports transitive callees.',
    inputSchema: zodToJsonSchema(GetCalleesSchema),
  },
  {
    name: 'find_endpoints',
    description: 'Discover all REST API endpoints in the codebase. Filter by HTTP method or path pattern. Returns handler method, controller, path, and annotations.',
    inputSchema: zodToJsonSchema(FindEndpointsSchema),
  },
  {
    name: 'get_file_summary',
    description: 'Get a consolidated summary of a file: classes, methods, fields, imports, dependencies, and dependents — all in one call.',
    inputSchema: zodToJsonSchema(GetFileSummarySchema),
  },
  {
    name: 'find_dead_code',
    description: 'Find potentially unused functions, methods, or classes that have no callers or dependents. Excludes known entry points (controllers, tests, scheduled tasks).',
    inputSchema: zodToJsonSchema(FindDeadCodeSchema),
  },
  {
    name: 'check_layer_violations',
    description: 'Check for architectural layer violations (e.g. repository importing controller, domain depending on service). Uses standard layered architecture rules by default, or accepts custom rules.',
    inputSchema: zodToJsonSchema(CheckLayerViolationsSchema),
  },
  {
    name: 'get_type_usage',
    description: 'Find where a class/type is used as a field type, method parameter, or return type across the codebase.',
    inputSchema: zodToJsonSchema(GetTypeUsageSchema),
  },
  {
    name: 'get_index_stats',
    description: 'Get codebase statistics: top hub modules, layer distribution, symbol counts, framework roles, and index health metrics.',
    inputSchema: zodToJsonSchema(GetIndexStatsSchema),
  },
  {
    name: 'find_similar_classes',
    description: 'Find classes similar to a given class based on shared interfaces, parent class, annotations, framework role, and method signatures.',
    inputSchema: zodToJsonSchema(FindSimilarClassesSchema),
  },
  {
    name: 'find_field_shadows',
    description: 'Detect field shadowing bugs in class hierarchies — when a child class declares a field with the same name as a parent/abstract class field, which can cause silent data loss in serialization (Jackson, Spring) and polymorphic behavior.',
    inputSchema: zodToJsonSchema(FindFieldShadowsSchema),
  },
  {
    name: 'review_changed_files',
    description: 'Prioritise changed files for review using dependency impact, endpoint reach, type usage, field shadowing, and likely dead-code hints.',
    inputSchema: zodToJsonSchema(ReviewChangedFilesSchema),
  },
  {
    name: 'get_pr_impact_summary',
    description: 'Summarise a PR or working-tree change set: top review targets, impacted endpoints, likely architectural regressions, and a reviewer checklist.',
    inputSchema: zodToJsonSchema(GetPrImpactSummarySchema),
  },
  {
    name: 'check_architectural_delta',
    description: 'Compare changed files against a baseline ref to highlight current and likely newly introduced layer violations.',
    inputSchema: zodToJsonSchema(CheckArchitecturalDeltaSchema),
  },
];

// ─── Main ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  const indexer = new FileIndexer({
    rootDir: opts.root,
    excludePatterns: opts.exclude.length > 0 ? opts.exclude : undefined,
    maxFileSizeKb: opts.maxFileSize,
    cacheTtlMs: opts.cacheTtl,
  });

  const server = new Server(
    { name: 'mcp-code-graph', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // Register tool listing
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  // Register tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: unknown;

      switch (name) {
        case 'find_references':
          result = await findReferences(FindReferencesSchema.parse(args), indexer);
          break;
        case 'get_dependents':
          result = await getDependents(GetDependentsSchema.parse(args), indexer);
          break;
        case 'get_dependencies':
          result = await getDependencies(GetDependenciesSchema.parse(args), indexer);
          break;
        case 'get_call_chain':
          result = await getCallChain(GetCallChainSchema.parse(args), indexer);
          break;
        case 'get_impact_radius':
          result = await getImpactRadius(GetImpactRadiusSchema.parse(args), indexer);
          break;
        case 'find_circular_dependencies':
          result = await findCircularDependencies(FindCyclesSchema.parse(args), indexer);
          break;
        case 'get_module_graph':
          result = await getModuleGraph(GetModuleGraphSchema.parse(args), indexer);
          break;
        case 'search_symbol':
          result = await searchSymbol(SearchSymbolSchema.parse(args), indexer);
          break;
        case 'get_callers':
          result = await getCallers(GetCallersSchema.parse(args), indexer);
          break;
        case 'get_callees':
          result = await getCallees(GetCalleesSchema.parse(args), indexer);
          break;
        case 'find_endpoints':
          result = await findEndpoints(FindEndpointsSchema.parse(args), indexer);
          break;
        case 'get_file_summary':
          result = await getFileSummary(GetFileSummarySchema.parse(args), indexer);
          break;
        case 'find_dead_code':
          result = await findDeadCode(FindDeadCodeSchema.parse(args), indexer);
          break;
        case 'check_layer_violations':
          result = await checkLayerViolations(CheckLayerViolationsSchema.parse(args), indexer);
          break;
        case 'get_type_usage':
          result = await getTypeUsage(GetTypeUsageSchema.parse(args), indexer);
          break;
        case 'get_index_stats':
          result = await getIndexStats(GetIndexStatsSchema.parse(args), indexer);
          break;
        case 'find_similar_classes':
          result = await findSimilarClasses(FindSimilarClassesSchema.parse(args), indexer);
          break;
        case 'find_field_shadows':
          result = await findFieldShadows(FindFieldShadowsSchema.parse(args), indexer);
          break;
        case 'review_changed_files':
          result = await reviewChangedFiles(ReviewChangedFilesSchema.parse(args), indexer);
          break;
        case 'get_pr_impact_summary':
          result = await getPrImpactSummary(GetPrImpactSummarySchema.parse(args), indexer);
          break;
        case 'check_architectural_delta':
          result = await checkArchitecturalDelta(CheckArchitecturalDeltaSchema.parse(args), indexer);
          break;
        default:
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
            isError: true,
          };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  // Start transport
  if (opts.transport === 'http') {
    await startHttpTransport(server, opts.port);
  } else {
    await startStdioTransport(server);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
