import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..', '..');

describe('Copilot workspace integration and benchmark accounting', () => {
  it('ships a VS Code workspace MCP config on the client facade', () => {
    const configPath = path.join(root, '.vscode', 'mcp.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      servers: Record<string, { type: string; command: string; args: string[] }>;
    };
    const codegraph = config.servers.codegraph;

    expect(codegraph.type).toBe('stdio');
    expect(codegraph.command).toBe('node');
    expect(codegraph.args).toEqual(expect.arrayContaining([
      '${workspaceFolder}/dist/cli.js',
      'mcp',
      '--root',
      '${workspaceFolder}',
      '--mcp-profile',
      'client',
    ]));
    expect(codegraph.args).not.toContain('full');
  });

  it('counts reasoning tokens in Copilot gross and fresh usage', () => {
    const harness = fs.readFileSync(path.join(root, 'examples', 'copilot-e2e-quality-bench.ps1'), 'utf-8');
    const analyzer = fs.readFileSync(path.join(root, 'examples', 'copilot-e2e-quality-analyze.ps1'), 'utf-8');

    expect(harness).toContain('$freshTokens = $inputTokens - $cachedInputTokens + $outputTokens + $reasoningTokens');
    expect(harness).toContain('totalTokens = $inputTokens + $outputTokens + $reasoningTokens');
    expect(harness).toContain('nonCachedTokens = if ($usage.found) { $usage.freshTokens } else { $null }');
    expect(analyzer).toContain('$nonCachedTokens = $inputTokens - $cachedInputTokens + $outputTokens + $reasoningTokens');
  });

  it('marks missing Copilot model usage as unavailable instead of a zero-token success', () => {
    const harness = fs.readFileSync(path.join(root, 'examples', 'copilot-e2e-quality-bench.ps1'), 'utf-8');

    expect(harness).toContain("reason = 'missing-model-usage'");
    expect(harness).toContain('freshTokens = $freshTokens');
  });
});
