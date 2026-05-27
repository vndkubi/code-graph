import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DaemonClient } from '../daemon/client.js';
import { V2_TOOL_DEFINITIONS, parseToolArgs } from './tools.js';

export interface RunMcpProxyOptions {
  root: string;
  homeDir?: string;
  prewarm?: boolean;
  refreshOnStart?: boolean;
  workspaceKey?: string;
  autoRefresh?: boolean;
  toolAllowlist?: string;
}

export async function runMcpProxy(options: RunMcpProxyOptions): Promise<void> {
  const daemon = await DaemonClient.ensure(options.homeDir);
  let workspace = await daemon.registerWorkspace(options.root, options.workspaceKey);
  if (options.prewarm !== false && !workspace.currentSnapshotId) {
    await daemon.refreshWorkspace(workspace.root, options.workspaceKey);
    workspace = await daemon.registerWorkspace(workspace.root, options.workspaceKey);
  } else if (options.refreshOnStart) {
    await daemon.refreshWorkspace(workspace.root, options.workspaceKey, { background: true });
  }

  const allowedTools = parseToolAllowlist(options.toolAllowlist ?? process.env.CODEGRAPH_MCP_TOOLS);
  const exposedTools = allowedTools
    ? V2_TOOL_DEFINITIONS.filter(tool => allowedTools.has(tool.name))
    : V2_TOOL_DEFINITIONS;

  const server = new Server(
    { name: 'codegraph', version: '2.0.0' },
    {
      capabilities: { tools: {} },
      instructions: MCP_SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: exposedTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (allowedTools && !allowedTools.has(request.params.name)) {
        throw new Error(`Tool ${request.params.name} is disabled by CODEGRAPH_MCP_TOOLS/--mcp-tools.`);
      }
      const args = parseToolArgs(request.params.name, request.params.arguments);
      if (isAnswerPackTool(request.params.name) && options.autoRefresh !== true) {
        args.autoRefresh = false;
        args.warnStale = false;
      } else if (options.autoRefresh && args.autoRefresh === undefined) {
        args.autoRefresh = true;
      }
      const result = await daemon.query(workspace.workspaceId, request.params.name, args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const MCP_SERVER_INSTRUCTIONS = `# CodeGraph usage

CodeGraph is a pre-indexed local code graph. For architecture, "how does X work",
request-flow, or codebase-research questions, use CodeGraph directly and answer
from its returned evidence instead of starting a grep/read exploration loop.

Primary flow:
- Call get_research_pack or get_flow_pack first.
- Do not set autoRefresh=true for these pack tools unless the user explicitly
  asks for a fresh index; they are optimized for a prewarmed index.
- Do not set warnStale=true for these pack tools during exploration benchmarks;
  stale checks can be more expensive than answering from the existing pack.
- Treat evidenceSlices in that response as already-read source. They contain
  file paths, line ranges, and capped source text.
- Answer directly when sufficientForAnswer is true.
- Use search_code/search_symbol/get_file_slice only for a specific missing fact
  named in missingFacts, not as a broad follow-up search.

Anti-patterns:
- Do not call many small slice/search tools after an answer-ready pack.
- Do not use shell grep/read to rediscover files already listed in evidenceSlices.
- Prefer one large, bounded context pack over dozens of tiny retrieval calls.`;

function parseToolAllowlist(raw: string | undefined): Set<string> | undefined {
  const names = (raw ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);
  return names.length > 0 ? new Set(names) : undefined;
}

function isAnswerPackTool(name: string): boolean {
  return name === 'get_flow_pack' || name === 'get_research_pack';
}
