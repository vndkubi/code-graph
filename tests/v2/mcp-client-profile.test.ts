import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildV2ToolDefinitions, buildV2ToolDefinitionsForProfile, mcpToolNamesForProfile, parseToolArgs, V2_TOOL_DEFINITIONS, V2_TOOL_PROFILES } from '../../src/v2/mcp/tools.js';
import { FULL_PROFILE_INSTRUCTIONS_SUFFIX, MCP_SERVER_INSTRUCTIONS, inferCodeGraphContextMode, inspectCodeGraphRoute, routeCodeGraphContext } from '../../src/v2/mcp/proxy.js';
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

  it('publishes compact single-gate instructions that survive client truncation', () => {
    // Observed client cutoff ≈1,900 chars (Claude Code): the base text must
    // stay well under it, with the sessionId reuse rule in the first 5 lines
    // rather than a truncated tail.
    expect(MCP_SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(1500);
    const lines = MCP_SERVER_INSTRUCTIONS.split('\n');
    expect(lines.findIndex(line => line.includes('sessionId'))).toBeLessThan(5);
    expect(MCP_SERVER_INSTRUCTIONS).toContain('codegraph_context');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('codegraph_slice');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('answerable=true');
    // No ghost tools: the client profile exposes exactly three tools, so the
    // base instructions must not tell the model to call anything else.
    for (const ghost of ['search_symbol', 'get_flow_pack', 'get_research_pack', 'get_change_pack', 'search_code', 'get_file_slice', 'contextgate_get_context', 'tokenopt_search', 'compile_evidence']) {
      expect(MCP_SERVER_INSTRUCTIONS).not.toContain(ghost);
    }
    // The full-profile addendum names the wider surface but keeps one gate,
    // and the combined text still fits under the observed truncation budget.
    expect(FULL_PROFILE_INSTRUCTIONS_SUFFIX).toContain('get_research_pack');
    expect(FULL_PROFILE_INSTRUCTIONS_SUFFIX).toContain('codegraph_context remains the first call');
    expect(MCP_SERVER_INSTRUCTIONS.length + 2 + FULL_PROFILE_INSTRUCTIONS_SUFFIX.length).toBeLessThanOrEqual(1900);
  });

  it('keeps named MCP profiles on the facade surface to avoid duplicate low-level choices', () => {
    const facadeTools = ['codegraph_context', 'codegraph_slice', 'codegraph_checkpoint', 'codegraph_status'];
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
      args: {
        target: 'Trace GET /api/orders request flow',
        responseMode: 'answer',
      },
    });

    expect(routeCodeGraphContext({
      task: 'trace api "/a" please',
    })).toMatchObject({
      toolName: 'get_flow_pack',
      args: {
        target: 'trace api "/a" please',
        responseMode: 'answer',
      },
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

    expect(inferCodeGraphContextMode('Assess where to add a persistent phase checkpoint while preserving exact evidence.', {})).toBe('change');
    expect(inferCodeGraphContextMode('Collect evidence with rubric coverage', {})).toBe('evidence');

    expect(routeCodeGraphContext({
      task: 'Explain the repository architecture',
    })).toMatchObject({
      toolName: 'get_research_pack',
      args: { responseMode: 'answer' },
    });

    expect(routeCodeGraphContext({
      task: 'Explain the repository architecture',
      responseMode: 'agent',
    })).toMatchObject({
      toolName: 'get_research_pack',
      args: { responseMode: 'agent' },
    });
  });

  it('infers context mode from task shape', () => {
    expect(inferCodeGraphContextMode('Review this patch', {})).toBe('review');
    expect(inferCodeGraphContextMode('Review my changes for correctness', {})).toBe('review');
    expect(inferCodeGraphContextMode('Review the pull request', {})).toBe('review');
    expect(inferCodeGraphContextMode('Trace POST /checkout flow', {})).toBe('flow');
    expect(inferCodeGraphContextMode('Trace PATCH /checkout flow', {})).toBe('flow');
    expect(inferCodeGraphContextMode('Investigate this bug: GET /api/refunds returns duplicate refunds after timeout. Trace the request flow and propose the safest fix.', {})).toBe('change');
    expect(inferCodeGraphContextMode('Debug duplicate refund timeout', {})).toBe('change');
    expect(inferCodeGraphContextMode(
      'Investigate the impact of changing the Java field Note.deletedAt or its soft-delete semantics.',
      {},
    )).toBe('change');
    expect(inferCodeGraphContextMode('Collect evidence with rubric coverage', {})).toBe('evidence');
    expect(inferCodeGraphContextMode('Analyze PBI acceptance criteria against code', {})).toBe('evidence');
    expect(inferCodeGraphContextMode('Understand the architecture', {})).toBe('research');
    // Domain nouns that merely contain "review"/"risk"/"finding" must not be hijacked into
    // diff-anchored review mode (regression: these returned a blocked no-resolved-patch-input
    // packet because there was no diff to resolve).
    expect(inferCodeGraphContextMode('Where is the spaced repetition review scheduling that decides which notes are due for review?', {})).toBe('research');
    expect(inferCodeGraphContextMode('Explain how the risk scoring is calculated', {})).toBe('research');
    expect(inferCodeGraphContextMode('Where are the audit findings surfaced to the user?', {})).toBe('research');
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
    expect(parseToolArgs('codegraph_context', {
      task: 'Review this PR',
      prUrl: 'https://github.com/acme/orders/pull/123',
      baseRef: 'origin/main',
      headRef: 'feature/orders',
    })).toMatchObject({
      prUrl: 'https://github.com/acme/orders/pull/123',
      baseRef: 'origin/main',
      headRef: 'feature/orders',
    });
    expect(parseToolArgs('codegraph_checkpoint', { action: 'list' })).toMatchObject({
      action: 'list',
      limit: 20,
      apply: false,
    });
  });

  it('compact descriptions preserve schema but reduce always-on text', () => {
    const normal = buildV2ToolDefinitions({ compactDescriptions: false });
    const compact = buildV2ToolDefinitions({ compactDescriptions: true });

    expect(compact.map(tool => tool.name)).toEqual(normal.map(tool => tool.name));
    expect(compact.map(tool => tool.inputSchema)).toEqual(normal.map(tool => tool.inputSchema));
    expect(estimatedSchemaTokens(compact)).toBeLessThan(estimatedSchemaTokens(normal));
  });

  it('gate description states capability, trigger, and payoff (not just an imperative)', () => {
    for (const compactDescriptions of [true, false]) {
      const description = buildV2ToolDefinitions({ compactDescriptions })
        .find(tool => tool.name === 'codegraph_context')?.description ?? '';
      expect(description).toContain('Call this FIRST');
      expect(description).toMatch(/ranked files/);
      expect(description).toMatch(/fewer tokens/);
      expect(description).toContain('sessionId');
      expect(description).toContain('answerable=true');
    }
  });

  it('keeps exactly one first-call claim across advertised descriptions', () => {
    // Three tools shouting "call FIRST" was the measured ambiguity that made
    // the model arbitrate between our own tools; only the gate may claim it.
    for (const compactDescriptions of [true, false]) {
      const claimants = buildV2ToolDefinitions({ compactDescriptions })
        .filter(tool => /call (this )?first/i.test(tool.description))
        .map(tool => tool.name);
      expect(claimants).toEqual(['codegraph_context']);
    }
  });

  it('tells the agent to verify a flagged verifyBudget fact via trustPosture, only on the two tools that emit it (compact descriptions only, per the measured MCP_SERVER_INSTRUCTIONS truncation-budget tradeoff)', () => {
    const tools = buildV2ToolDefinitions({ compactDescriptions: true });
    const flowPack = tools.find(tool => tool.name === 'get_flow_pack')?.description ?? '';
    const researchPack = tools.find(tool => tool.name === 'get_research_pack')?.description ?? '';
    expect(flowPack).toContain('spot_check_recommended');
    expect(flowPack).toContain('verifyBudget');
    expect(flowPack).toContain('verify.tool');
    expect(researchPack).toContain('spot_check_recommended');
    expect(researchPack).toContain('verifyBudget');
    expect(researchPack).toContain('verify.tool');
    // Only get_flow_pack/get_research_pack emit verifyBudget/trustPosture
    // (both route to getResearchPack); other tools shouldn't reference it.
    const mentions = tools
      .filter(tool => tool.name !== 'get_flow_pack' && tool.name !== 'get_research_pack')
      .filter(tool => /verifyBudget|trustPosture/.test(tool.description));
    expect(mentions).toEqual([]);
  });

  it('does not let the trustPosture hint push get_flow_pack/get_research_pack compact descriptions anywhere near the MCP_SERVER_INSTRUCTIONS truncation ceiling', () => {
    // Server instructions (a separate wire field) sit near a ~1,900-char
    // client truncation ceiling; tool descriptions are a different field with
    // no observed ceiling, but keep the compact ones reasonably short anyway.
    const compact = buildV2ToolDefinitions({ compactDescriptions: true });
    for (const name of ['get_flow_pack', 'get_research_pack']) {
      const description = compact.find(tool => tool.name === name)?.description ?? '';
      expect(description.length).toBeLessThan(400);
    }
  });

  it('advertises a slim gate schema on client profiles and the full schema on full', () => {
    const client = buildV2ToolDefinitionsForProfile('client');
    expect(client.map(tool => tool.name)).toEqual(['codegraph_context', 'codegraph_slice', 'codegraph_checkpoint', 'codegraph_status']);
    const gate = client.find(tool => tool.name === 'codegraph_context')!;
    const gateProperties = (gate.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(gateProperties)).toEqual(['task', 'target', 'diff', 'prUrl', 'baseRef', 'headRef', 'sessionId', 'scopePlan', 'resumeTaskId']);
    expect(gateProperties).not.toHaveProperty('mode');
    expect((gate.inputSchema as { required: string[] }).required).toEqual(['task']);

    const full = buildV2ToolDefinitionsForProfile('full');
    const fullGate = full.find(tool => tool.name === 'codegraph_context')!;
    expect(Object.keys((fullGate.inputSchema as { properties: Record<string, unknown> }).properties).length).toBeGreaterThan(10);

    // Advertised subset ⊂ accepted set: power params still parse when sent.
    expect(parseToolArgs('codegraph_context', { task: 'x', budgetTokens: 8000, includeSnippets: true })).toMatchObject({
      budgetTokens: 8000,
      includeSnippets: true,
    });

    // Checkpoint decisions schema is advertised as an object array, not string array.
    const checkpointDef = client.find(tool => tool.name === 'codegraph_checkpoint')!;
    const stateProps = ((checkpointDef.inputSchema as Record<string, unknown>).properties as Record<string, unknown>).state as Record<string, unknown>;
    const decisionsSchema = (stateProps.properties as Record<string, unknown>).decisions as Record<string, unknown>;
    expect(decisionsSchema.type).toBe('array');
    expect((decisionsSchema.items as Record<string, unknown>).type).toBe('object');

    // codegraph_slice requires file, symbol, or slices.
    expect(() => parseToolArgs('codegraph_slice', {})).toThrow(/requires either file, symbol, or a non-empty slices array/);

    // scopePlan requires unique requirement IDs.
    expect(() => parseToolArgs('codegraph_context', {
      task: 'Check unique requirements',
      scopePlan: {
        intent: 'research',
        target: 'targetSymbol',
        requirements: [
          { id: 'dup-id', description: 'desc 1', kinds: ['source'] },
          { id: 'dup-id', description: 'desc 2', kinds: ['definition'] },
        ],
      },
    })).toThrow(/Requirement IDs must be unique/);
  });

  it('routes natural-language Java field changes through the change pack', () => {
    expect(routeCodeGraphContext({
      task: 'Investigate the impact of changing the Java field Note.deletedAt or its soft-delete semantics.',
      target: 'Note.deletedAt',
    })).toMatchObject({
      toolName: 'get_change_pack',
      args: {
        target: 'Note.deletedAt',
        changeType: 'investigate',
        symbols: ['Note.deletedAt'],
      },
    });

    expect(routeCodeGraphContext({
      task: 'Investigate the impact of changing the Java field Note.deletedAt or its soft-delete semantics.',
    })).toMatchObject({
      toolName: 'get_change_pack',
      args: {
        changeType: 'investigate',
        symbols: ['Note.deletedAt'],
      },
    });
  });

  it('tells agents to leave routing on auto unless the user explicitly overrides it', () => {
    const clientGate = buildV2ToolDefinitionsForProfile('client')
      .find(tool => tool.name === 'codegraph_context')!;
    const clientProperties = (clientGate.inputSchema as {
      properties: Record<string, { description?: string }>;
    }).properties;
    expect(clientProperties).not.toHaveProperty('mode');

    const fullGate = buildV2ToolDefinitionsForProfile('full')
      .find(tool => tool.name === 'codegraph_context')!;
    const fullProperties = (fullGate.inputSchema as {
      properties: Record<string, { description?: string }>;
    }).properties;
    expect(fullProperties.mode.description).toMatch(/omit.*unless the user explicitly/i);

    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/omit mode.*unless the user explicitly/i);
  });
});
