import { describe, expect, it } from 'vitest';
import { buildV2ToolDefinitions, mcpToolNamesForProfile, parseToolArgs, V2_TOOL_DEFINITIONS, V2_TOOL_PROFILES } from '../../src/v2/mcp/tools.js';
import { inferCodeGraphContextMode, routeCodeGraphContext } from '../../src/v2/mcp/proxy.js';

function estimatedSchemaTokens(tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>): number {
  return Math.ceil(JSON.stringify(tools).length / 4);
}

describe('MCP full tool mode', () => {
  it('exposes one full MCP tool surface while keeping client facade tools available', () => {
    expect(mcpToolNamesForProfile(undefined)).toBeUndefined();
    expect(mcpToolNamesForProfile('full')).toBeUndefined();
    expect(mcpToolNamesForProfile('client')).toBeUndefined();
    expect(mcpToolNamesForProfile('minimal')).toBeUndefined();
    expect(V2_TOOL_PROFILES.full).toEqual(V2_TOOL_DEFINITIONS.map(tool => tool.name));
    expect(V2_TOOL_DEFINITIONS.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'codegraph_status',
      'codegraph_context',
      'codegraph_slice',
      'get_research_pack',
      'get_change_pack',
      'review_patch',
      'search_symbol',
    ]));
  });

  it('routes the client context facade to bounded internal tools', () => {
    expect(routeCodeGraphContext({
      task: 'Review this diff for missing tests',
      diff: 'diff --git a/src/a.ts b/src/a.ts',
    })).toMatchObject({
      toolName: 'review_patch',
    });

    expect(routeCodeGraphContext({
      task: 'Trace GET /api/orders request flow',
    })).toMatchObject({
      toolName: 'get_flow_pack',
      args: { target: 'Trace GET /api/orders request flow' },
    });

    expect(routeCodeGraphContext({
      task: 'Implement order validation',
    })).toMatchObject({
      toolName: 'get_change_pack',
      args: { task: 'Implement order validation' },
    });

    expect(routeCodeGraphContext({
      task: 'Explain the repository architecture',
    })).toMatchObject({
      toolName: 'get_research_pack',
    });
  });

  it('infers context mode from task shape', () => {
    expect(inferCodeGraphContextMode('Review this patch', {})).toBe('review');
    expect(inferCodeGraphContextMode('Trace POST /checkout flow', {})).toBe('flow');
    expect(inferCodeGraphContextMode('Debug duplicate refund timeout', {})).toBe('change');
    expect(inferCodeGraphContextMode('Collect evidence with rubric coverage', {})).toBe('evidence');
    expect(inferCodeGraphContextMode('Understand the architecture', {})).toBe('research');
  });

  it('keeps legacy profile names as aliases for the single full mode', () => {
    expect(mcpToolNamesForProfile('research')).toBeUndefined();
    expect(mcpToolNamesForProfile('change')).toBeUndefined();
    expect(mcpToolNamesForProfile('review')).toBeUndefined();
    expect(() => mcpToolNamesForProfile('unknown')).toThrow(/full MCP toolset/);
  });

  it('parses facade tool arguments with client-safe defaults', () => {
    expect(parseToolArgs('codegraph_context', { task: 'Trace GET /orders' })).toMatchObject({
      task: 'Trace GET /orders',
      mode: 'auto',
      budgetTokens: 6000,
      profile: 'compact',
    });
    expect(parseToolArgs('codegraph_status', {})).toMatchObject({
      includeDiagnostics: false,
    });
  });

  it('compact descriptions preserve schema but reduce always-on text', () => {
    const normal = buildV2ToolDefinitions({ compactDescriptions: false });
    const compact = buildV2ToolDefinitions({ compactDescriptions: true });

    expect(compact.map(tool => tool.name)).toEqual(normal.map(tool => tool.name));
    expect(compact.map(tool => tool.inputSchema)).toEqual(normal.map(tool => tool.inputSchema));
    expect(estimatedSchemaTokens(compact)).toBeLessThan(estimatedSchemaTokens(normal));
  });
});
