import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildV2ToolDefinitions, mcpToolNamesForProfile, parseToolArgs, V2_TOOL_DEFINITIONS, V2_TOOL_PROFILES } from '../../src/v2/mcp/tools.js';
import { MCP_SERVER_INSTRUCTIONS, inferCodeGraphContextMode, inspectCodeGraphRoute, routeCodeGraphContext } from '../../src/v2/mcp/proxy.js';
import { runRouteGateBenchmark } from '../../src/v2/benchmark/route-gate.js';
import { estimateTextTokens } from '../../src/v2/token-estimator.js';

function estimatedSchemaTokens(tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>): number {
  return estimateTextTokens(JSON.stringify(tools));
}

describe('MCP full tool mode', () => {
  it('uses the client facade tool surface by default while keeping full mode opt-in', () => {
    expect([...mcpToolNamesForProfile(undefined)!]).toEqual(V2_TOOL_PROFILES.client);
    expect([...mcpToolNamesForProfile('full')!]).toEqual(V2_TOOL_DEFINITIONS.map(tool => tool.name));
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

  it('publishes a compact first-tool rule map in MCP server instructions', () => {
    expect(MCP_SERVER_INSTRUCTIONS).toContain('single source of truth');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('Default/client profile exposes only');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('codegraph_context, codegraph_slice, and codegraph_status');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('If unsure, call codegraph_context');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('Full profile exposes direct pack tools');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('get_flow_pack only for explicit endpoint/API/request-flow tracing');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('get_change_pack for implement/fix/debug/refactor/test/edit tasks');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('FOLLOW-UP ONLY');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('After codegraph_slice/get_file_slice returns requested source');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('do not call shell');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('do not call rg');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('After get_flow_pack or get_research_pack returns answerable=true');
  });

  it('keeps named MCP profiles on the facade surface to avoid duplicate low-level choices', () => {
    const facadeTools = ['codegraph_context', 'codegraph_slice', 'codegraph_status'];
    expect([...mcpToolNamesForProfile('client')!]).toEqual(facadeTools);
    expect([...mcpToolNamesForProfile('minimal')!]).toEqual(facadeTools);
    expect([...mcpToolNamesForProfile('research')!]).toEqual(facadeTools);
    expect([...mcpToolNamesForProfile('change')!]).toEqual(facadeTools);
    expect([...mcpToolNamesForProfile('review')!]).toEqual(facadeTools);
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
      task: 'Investigate this bug: GET /api/refunds returns duplicate refunds after timeout. Trace the request flow and propose the safest fix.',
    })).toMatchObject({
      toolName: 'get_change_pack',
    });

    expect(routeCodeGraphContext({
      task: 'Implement order validation',
    })).toMatchObject({
      toolName: 'get_change_pack',
      args: { task: 'Implement order validation' },
    });

    expect(routeCodeGraphContext({
      task: 'Analyze PBI 123 acceptance criteria and related code',
    })).toMatchObject({
      toolName: 'compile_evidence',
      args: { task: 'Analyze PBI 123 acceptance criteria and related code' },
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
    expect(inferCodeGraphContextMode('Trace PATCH /checkout flow', {})).toBe('flow');
    expect(inferCodeGraphContextMode('Investigate this bug: GET /api/refunds returns duplicate refunds after timeout. Trace the request flow and propose the safest fix.', {})).toBe('change');
    expect(inferCodeGraphContextMode('Debug duplicate refund timeout', {})).toBe('change');
    expect(inferCodeGraphContextMode('Collect evidence with rubric coverage', {})).toBe('evidence');
    expect(inferCodeGraphContextMode('Analyze PBI acceptance criteria against code', {})).toBe('evidence');
    expect(inferCodeGraphContextMode('Understand the architecture', {})).toBe('research');
  });

  it('explains route gate policy for client facade calls', () => {
    expect(inspectCodeGraphRoute({
      task: 'Analyze PBI acceptance criteria against code',
    })).toMatchObject({
      inferredMode: 'evidence',
      primaryTool: 'codegraph_context',
      routedTool: 'compile_evidence',
      expectedMaxAdditionalCalls: 0,
      packetContract: {
        requiresAnswerable: true,
        denyBroadShellAfterAnswerable: true,
      },
    });
  });

  it('runs deterministic route-gate checks for broad task classes', () => {
    const report = runRouteGateBenchmark();
    expect(report.totals.failed).toBe(0);
    expect(report.tasks.map(task => task.actualTool)).toEqual(expect.arrayContaining([
      'compile_evidence',
      'get_change_pack',
      'get_flow_pack',
      'review_patch',
      'get_research_pack',
    ]));
  });

  it('keeps route-gate expected routing aligned for debug prompts that mention flow', () => {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-route-gate-'));
    try {
      const suitePath = path.join(suiteDir, 'suite.json');
      fs.writeFileSync(suitePath, JSON.stringify({
        name: 'debug-flow-route-gate',
        tasks: [{
          id: 'debug-flow',
          task: 'Investigate this bug: GET /api/refunds returns duplicate refunds after timeout. Trace the request flow and propose the safest fix.',
        }],
      }));
      const report = runRouteGateBenchmark(suitePath);

      expect(report.totals.failed).toBe(0);
      expect(report.tasks[0]).toMatchObject({
        actualMode: 'change',
        actualTool: 'get_change_pack',
        expectedMode: 'change',
        expectedTool: 'get_change_pack',
      });
    } finally {
      fs.rmSync(suiteDir, { recursive: true, force: true });
    }
  });

  it('rejects unknown MCP profile names', () => {
    expect(() => mcpToolNamesForProfile('unknown')).toThrow(/Expected client, minimal, research, change, review, or full/);
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
    expect(compact.find(tool => tool.name === 'codegraph_context')?.description).toContain('PRIMARY TOOL - call FIRST');
    expect(compact.find(tool => tool.name === 'codegraph_slice')?.description).toContain('FOLLOW-UP ONLY');
    expect(compact.find(tool => tool.name === 'compile_evidence')?.description).toContain('TokenOpt-style');
    expect(compact.find(tool => tool.name === 'compile_evidence')?.description).toContain('call FIRST');
    expect(compact.find(tool => tool.name === 'review_patch')?.description).toContain('call FIRST');
    expect(compact.find(tool => tool.name === 'get_flow_pack')?.description).toContain('ONLY for explicit');
    expect(compact.find(tool => tool.name === 'get_flow_pack')?.description).toContain('debug');
    expect(compact.find(tool => tool.name === 'get_flow_pack')?.description).toContain('answerable');
    expect(compact.find(tool => tool.name === 'get_flow_pack')?.description).toContain('rg/shell');
    expect(estimatedSchemaTokens(compact)).toBeLessThan(estimatedSchemaTokens(normal));
  });
});
