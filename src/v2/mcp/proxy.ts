import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DaemonClient } from '../daemon/client.js';
import { V2_TOOL_DEFINITIONS, parseToolArgs } from './tools.js';

export interface RunMcpProxyOptions {
  root: string;
  homeDir?: string;
  prewarm?: boolean;
  workspaceKey?: string;
  autoRefresh?: boolean;
}

export async function runMcpProxy(options: RunMcpProxyOptions): Promise<void> {
  const daemon = await DaemonClient.ensure(options.homeDir);
  let workspace = await daemon.registerWorkspace(options.root, options.workspaceKey);
  if (options.prewarm !== false && !workspace.currentSnapshotId) {
    await daemon.refreshWorkspace(workspace.root, options.workspaceKey);
    workspace = await daemon.registerWorkspace(workspace.root, options.workspaceKey);
  }

  const server = new Server(
    { name: 'codegraph', version: '2.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: V2_TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const args = parseToolArgs(request.params.name, request.params.arguments);
      if (options.autoRefresh && args.autoRefresh === undefined) args.autoRefresh = true;
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
