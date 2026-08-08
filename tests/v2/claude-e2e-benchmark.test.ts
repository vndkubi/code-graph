import { describe, expect, it } from 'vitest';
import {
  buildClaudeMcpServerEntry,
  buildClaudeProcessEnv,
  buildClaudePrintArgs,
  parseClaudeStreamEvents,
} from '../../src/v2/benchmark/claude-e2e.js';

describe('Claude E2E benchmark accounting and invocation', () => {
  it('counts cache creation as fresh input and excludes cache reads from fresh usage', () => {
    const stream = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'tool-1',
            name: 'mcp__codegraph_bench__codegraph_context',
            input: { task: 'Explain routing' },
          }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tool-2', name: 'Grep', input: { pattern: 'route' } }],
        },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: '{"answer":"done"}',
        usage: {
          input_tokens: 20,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 700,
          output_tokens: 40,
        },
      }),
    ].join('\n');

    expect(parseClaudeStreamEvents(stream)).toMatchObject({
      eventCount: 3,
      mcpCalls: 1,
      shellCalls: 1,
      toolCalls: 2,
      toolCallBreakdown: {
        codegraph_context: 1,
        Grep: 1,
      },
      inputTokens: 1020,
      cachedInputTokens: 700,
      cacheCreationInputTokens: 300,
      freshInputTokens: 320,
      outputTokens: 40,
      rawTotalTokens: 1060,
      freshTotalTokens: 360,
      tokenSource: 'actual',
      finalOutput: '{"answer":"done"}',
    });
  });

  it('builds a non-interactive read-only Claude invocation with an isolated MCP config', () => {
    const args = buildClaudePrintArgs({
      model: 'claude-sonnet-5',
      mcpConfigPath: 'C:\\tmp\\claude-mcp.json',
      prompt: 'Explain routing',
    });

    expect(args).toEqual(expect.arrayContaining([
      '--print',
      '--model',
      'claude-sonnet-5',
      '--output-format',
      'stream-json',
      '--strict-mcp-config',
      '--mcp-config',
      'C:\\tmp\\claude-mcp.json',
      '--permission-mode',
      'dontAsk',
      '--disallowedTools',
      'Edit,Write,NotebookEdit',
      'Explain routing',
    ]));
  });

  it('can remove unrelated Claude startup surfaces for a lean benchmark process', () => {
    const args = buildClaudePrintArgs({
      model: 'claude-sonnet-5',
      mcpConfigPath: 'C:\\tmp\\claude-mcp.json',
      prompt: 'Explain routing',
      startupProfile: 'lean',
    });

    expect(args).toEqual(expect.arrayContaining([
      '--tools',
      'Read,Grep,Glob,Bash',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--prompt-suggestions',
      'false',
      '--exclude-dynamic-system-prompt-sections',
    ]));

    expect(buildClaudeProcessEnv('lean', { KEEP_ME: 'yes' })).toMatchObject({
      KEEP_ME: 'yes',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    });
  });

  it('always loads the small client MCP surface to avoid a ToolSearch round trip', () => {
    expect(buildClaudeMcpServerEntry('node', ['dist/cli.js', 'mcp'])).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['dist/cli.js', 'mcp'],
      alwaysLoad: true,
    });
  });

  it('can defer the MCP schema to ToolSearch for cold-start comparison', () => {
    expect(buildClaudeMcpServerEntry('node', ['dist/cli.js', 'mcp'], 'lazy')).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['dist/cli.js', 'mcp'],
    });
  });
});
