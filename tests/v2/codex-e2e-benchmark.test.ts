import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openCodeGraphDb, type CodeGraphDb } from '../../src/v2/storage/database.js';
import { V2Indexer } from '../../src/v2/index/indexer.js';
import {
  compileBenchmarkTaskType,
  buildCodexExecArgs,
  buildCodexSpawnInvocation,
  parseCodexJsonEvents,
  promptForMode,
  runCodexE2eBenchmark,
  runCodexE2ePreflight,
  scoreCodexOutput,
  type CodexE2eSuite,
} from '../../src/v2/benchmark/codex-e2e.js';
import { estimateTextTokens } from '../../src/v2/token-estimator.js';

const tempDirs: string[] = [];
const dbs: CodeGraphDb[] = [];

afterEach(async () => {
  for (const db of dbs.splice(0)) {
    await db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Codex E2E benchmark preflight and token ledger', () => {
  it('prefers explicit benchmark task type over prompt keywords', () => {
    expect(compileBenchmarkTaskType({
      id: 'route-investigation',
      type: 'investigation',
      prompt: 'Explain how the route gate and flow behave.',
    })).toBe('investigate');
  });

  it('extracts budget-backed net savings from Codex JSONL tool results', () => {
    const packet = {
      answerable: true,
      budget: {
        estimatedResponseTokens: 100,
        estimatedFullResponseTokens: 400,
        estimatedTokensSaved: 300,
      },
    };
    const shellOutput = 'short fallback shell output';
    const jsonl = [
      {
        type: 'item.completed',
        item: {
          id: 'mcp-1',
          type: 'mcp_tool_call',
          server: 'codegraph_bench',
          tool: 'compile_evidence',
          result: { content: [{ type: 'text', text: JSON.stringify(packet) }] },
          status: 'completed',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'shell-1',
          type: 'command_execution',
          result: { content: [{ type: 'text', text: shellOutput }] },
          status: 'completed',
        },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 1000,
          cached_input_tokens: 250,
          output_tokens: 80,
          reasoning_output_tokens: 20,
        },
      },
    ].map(event => JSON.stringify(event)).join('\n');

    const metrics = parseCodexJsonEvents(jsonl, 'prompt');

    expect(metrics.mcpCalls).toBe(1);
    expect(metrics.shellCalls).toBe(1);
    expect(metrics.tokenLedger).toMatchObject({
      fullPacketTokens: 400,
      compactPacketTokens: 100,
      grossSavedTokens: 300,
      budgetedMcpCalls: 1,
      firstBudgetedMcpTool: 'compile_evidence',
      source: 'budget-fields',
    });
    expect(metrics.tokenLedger.fallbackShellTokens).toBe(estimateTextTokens(shellOutput));
    expect(metrics.tokenLedger.netSavedTokens).toBe(400 - 100 - metrics.tokenLedger.fallbackShellTokens);
    expect(metrics.tokenLedger.modelFreshTotalTokens).toBe(850);
  });

  it('separates shell token waste after an exact file slice follow-up', () => {
    const packet = {
      answerable: false,
      allowedFollowups: [{ tool: 'get_file_slice', file: 'src/order-service.ts', lines: '8-16' }],
      budget: {
        estimatedResponseTokens: 120,
        estimatedFullResponseTokens: 600,
      },
    };
    const sliceOutput = 'src/order-service.ts:10 await this.paymentService.charge(request.customerId, 100);';
    const shellOutput = 'rg "charge" src/order-service.ts\n10: await this.paymentService.charge(request.customerId, 100);';
    const jsonl = [
      {
        type: 'item.completed',
        item: {
          id: 'mcp-1',
          type: 'mcp_tool_call',
          server: 'codegraph_bench',
          tool: 'compile_evidence',
          result: { content: [{ type: 'text', text: JSON.stringify(packet) }] },
          status: 'completed',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'mcp-2',
          type: 'mcp_tool_call',
          server: 'codegraph_bench',
          tool: 'get_file_slice',
          result: { content: [{ type: 'text', text: sliceOutput }] },
          status: 'completed',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'shell-1',
          type: 'command_execution',
          result: { content: [{ type: 'text', text: shellOutput }] },
          status: 'completed',
        },
      },
    ].map(event => JSON.stringify(event)).join('\n');

    const metrics = parseCodexJsonEvents(jsonl, 'prompt');
    const sliceTokens = estimateTextTokens(sliceOutput);
    const shellTokens = estimateTextTokens(shellOutput);

    expect(metrics.tokenLedger.exactFollowupTokens).toBe(sliceTokens);
    expect(metrics.tokenLedger.fallbackShellTokens).toBe(shellTokens);
    expect(metrics.tokenLedger.shellAfterExactFollowupCalls).toBe(1);
    expect(metrics.tokenLedger.shellAfterExactFollowupTokens).toBe(shellTokens);
    expect(metrics.tokenLedger.netSavedTokens).toBe(600 - 120 - sliceTokens - shellTokens);
  });

  it('warns compiled-packet gate runs to stop after a returned file slice', () => {
    const prompt = promptForMode({
      id: 'slice-stop',
      prompt: 'Explain OrderService.create.',
    }, 'compiled-packet+gate');

    expect(prompt).toContain('After codegraph_slice/get_file_slice returns source');
    expect(prompt).toContain('do not call shell');
    expect(prompt).toContain('do not call rg');
    expect(prompt).toContain('do not call search');
  });

  it('supports natural tool-use prompts without naming CodeGraph or MCP', () => {
    const prompt = promptForMode({
      id: 'natural-trace',
      prompt: 'trace api "POST /orders" please',
    }, 'natural-tool-use');

    expect(prompt).toContain('trace api "POST /orders" please');
    expect(prompt).not.toMatch(/\bMCP\b/i);
    expect(prompt).not.toMatch(/\bCodeGraph\b/i);
    expect(prompt).toContain('available project context');
  });

  it('scores fenced JSON after endpoint path braces in natural answers', () => {
    const quality = scoreCodexOutput({
      id: 'endpoint-json',
      prompt: 'trace api "GET /orders/{id}" please',
      requireJson: true,
      expectedTerms: ['GET', '/orders/{id}'],
      requiredAnswerFields: ['task', 'endpoint', 'flow'],
    }, [
      'I will trace GET /orders/{id} first.',
      '```json',
      '{',
      '  "task": "trace",',
      '  "endpoint": "GET /orders/{id}",',
      '  "flow": ["handler -> service"]',
      '}',
      '```',
    ].join('\n'));

    expect(quality.hits).toContain('valid_json');
    expect(quality.hits).toEqual(expect.arrayContaining(['task', 'endpoint', 'flow']));
    expect(quality.misses).not.toContain('valid_json');
  });

  it('wraps Windows .cmd commands for spawn', () => {
    const invocation = buildCodexSpawnInvocation('npx.cmd', ['-y', '@openai/codex'], 'win32');
    expect(invocation.command).toBe('cmd.exe');
    expect(invocation.args).toEqual(['/c', 'npx.cmd', '-y', '@openai/codex']);
  });

  it('does not wrap non-Windows commands with cmd.exe /c', () => {
    const invocation = buildCodexSpawnInvocation('npx.cmd', ['-y', '@openai/codex'], 'linux');
    expect(invocation.command).toBe('npx.cmd');
    expect(invocation.args).toEqual(['-y', '@openai/codex']);
  });

  it('keeps explicit cmd.exe command unchanged on Windows', () => {
    const invocation = buildCodexSpawnInvocation('cmd.exe', ['/c', 'npx.cmd', '-y', '@openai/codex'], 'win32');
    expect(invocation.command).toBe('cmd.exe');
    expect(invocation.args).toEqual(['/c', 'npx.cmd', '-y', '@openai/codex']);
  });

  it('can keep user config enabled for wrapper-based Codex providers', () => {
    const args = buildCodexExecArgs({
      model: 'gpt-5.3-codex-spark',
      useUserConfig: true,
      mcpConfigOverrides: ['-c', 'mcp_servers.headroom.command="headroom"'],
    });

    expect(args).not.toContain('--ignore-user-config');
    expect(args).toContain('--ignore-rules');
    expect(args).toContain('mcp_servers.headroom.command="headroom"');
  });

  it('uses the shared cl100k text tokenizer for fallback estimates', () => {
    expect(estimateTextTokens('hello')).toBe(1);
    expect(estimateTextTokens('2 + 2 = 4')).toBe(7);
  });

  it('preflights indexed root compatibility before model execution', async () => {
    const repo = tempDir('codegraph-codex-preflight-');
    writeFile(repo, 'src/main.ts', 'export function present() { return true; }\n');
    const { db } = await openCodeGraphDb(repo);
    dbs.push(db);
    const indexer = new V2Indexer(db);
    await indexer.indexWorkspace({ root: repo, workspaceKey: 'preflight-pass' });

    const suite: CodexE2eSuite = {
      name: 'preflight-pass-suite',
      rootProfile: {
        name: 'tiny-ts',
        requiredFiles: ['src/main.ts'],
      },
      tasks: [{
        id: 'present-task',
        prompt: 'Explain present.',
        expectedFiles: ['main.ts'],
      }],
    };

    const report = await runCodexE2ePreflight({
      suite,
      root: repo,
      workspaceKey: 'preflight-pass',
      tasks: suite.tasks,
      plannedRuns: 1,
    });

    expect(report.status).toBe('passed');
    expect(report.canRun).toBe(true);
    expect(report.snapshot?.files).toBeGreaterThan(0);
    expect(report.requiredFiles.find(file => file.expected === 'src/main.ts')?.matched).toEqual(['src/main.ts']);
  });

  it('does not emit missing compatibility warning when a method contract exists', async () => {
    const repo = tempDir('codegraph-codex-method-contract-only-');
    writeFile(repo, 'src/order.ts', 'export function chargeOrder(orderId: string) { return orderId.length; }\n');
    const { db } = await openCodeGraphDb(repo);
    dbs.push(db);
    const indexer = new V2Indexer(db);
    await indexer.indexWorkspace({ root: repo, workspaceKey: 'method-contract-only' });

    const suite: CodexE2eSuite = {
      name: 'method-contract-only-suite',
      rootProfile: {
        name: 'method-contract-only',
        requiredMethods: ['chargeOrder'],
      },
      tasks: [],
    };

    const report = await runCodexE2ePreflight({
      suite,
      root: repo,
      workspaceKey: 'method-contract-only',
      tasks: suite.tasks,
      plannedRuns: 1,
    });

    expect(report.status).toBe('passed');
    expect(report.canRun).toBe(true);
    expect(report.issues.some(issue => issue.code === 'missing_compatibility_contract')).toBe(false);
  });

  it('passes preflight when required methods are present in indexed symbols', async () => {
    const repo = tempDir('codegraph-codex-method-pass-');
    writeFile(repo, 'src/order.ts', 'export function chargeOrder(orderId: string) { return orderId.length; }\n');
    const { db } = await openCodeGraphDb(repo);
    dbs.push(db);
    const indexer = new V2Indexer(db);
    await indexer.indexWorkspace({ root: repo, workspaceKey: 'method-pass' });

    const suite: CodexE2eSuite = {
      name: 'method-pass-suite',
      rootProfile: {
        name: 'method-suite',
        requiredMethods: ['chargeOrder'],
      },
      tasks: [{
        id: 'method-pass-task',
        prompt: 'Find chargeOrder implementation.',
        expectedMethods: ['chargeOrder'],
      }],
    };

    const report = await runCodexE2ePreflight({
      suite,
      root: repo,
      workspaceKey: 'method-pass',
      tasks: suite.tasks,
      plannedRuns: 1,
    });

    expect(report.status).toBe('passed');
    expect(report.requiredMethods.find(method => method.expected === 'chargeOrder')?.matched.length).toBeGreaterThan(0);
    expect(report.missingRequiredMethods).toHaveLength(0);
  });

  it('normalizes expected method signatures before matching', async () => {
    const repo = tempDir('codegraph-codex-method-signature-');
    writeFile(repo, 'src/order.ts', 'export function chargeOrder(orderId: string) { return orderId.length; }\n');
    const { db } = await openCodeGraphDb(repo);
    dbs.push(db);
    const indexer = new V2Indexer(db);
    await indexer.indexWorkspace({ root: repo, workspaceKey: 'method-signature' });

    const suite: CodexE2eSuite = {
      name: 'method-signature-suite',
      rootProfile: {
        name: 'method-suite',
        requiredMethods: ['chargeOrder(orderId: string)'],
      },
      tasks: [{
        id: 'method-signature-task',
        prompt: 'Find chargeOrder implementation.',
        expectedMethods: ['chargeOrder(orderId: string)'],
      }],
    };

    const report = await runCodexE2ePreflight({
      suite,
      root: repo,
      workspaceKey: 'method-signature',
      tasks: suite.tasks,
      plannedRuns: 1,
    });

    expect(report.status).toBe('passed');
    expect(report.requiredMethods.find(method => method.expected === 'chargeOrder(orderId: string)')?.matched.length).toBeGreaterThan(0);
  });

  it('blocks preflight when required methods are absent from indexed snapshot', async () => {
    const repo = tempDir('codegraph-codex-method-missing-');
    writeFile(repo, 'src/order.ts', 'export function chargeOrder(orderId: string) { return orderId.length; }\n');
    const { db } = await openCodeGraphDb(repo);
    const indexer = new V2Indexer(db);
    await indexer.indexWorkspace({ root: repo, workspaceKey: 'method-missing' });
    await db.close();

    const suite: CodexE2eSuite = {
      name: 'method-missing-suite',
      rootProfile: {
        name: 'method-suite',
        requiredMethods: ['refundOrder'],
      },
      tasks: [{
        id: 'method-missing-task',
        prompt: 'Find refundOrder implementation.',
        expectedMethods: ['refundOrder'],
      }],
    };

    const report = await runCodexE2ePreflight({
      suite,
      root: repo,
      workspaceKey: 'method-missing',
      tasks: suite.tasks,
      plannedRuns: 1,
    });

    expect(report.status).toBe('failed');
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'missing_required_method',
      expected: 'refundOrder',
    }));
    expect(report.missingRequiredMethods).toContain('refundOrder');
  });

  it('suggests similar methods when a required method is absent', async () => {
    const repo = tempDir('codegraph-codex-method-suggestions-');
    writeFile(repo, 'src/order.ts', [
      'export function chargeOrder(orderId: string) { return orderId.length; }',
      'export function calculateOrder() { return 0; }',
      'export function listOrders() { return []; }',
    ].join('\n'));
    const { db } = await openCodeGraphDb(repo);
    const indexer = new V2Indexer(db);
    await indexer.indexWorkspace({ root: repo, workspaceKey: 'method-suggestions' });
    await db.close();

    const suite: CodexE2eSuite = {
      name: 'method-suggestions-suite',
      rootProfile: {
        name: 'method-suite',
        requiredMethods: ['chageOrder'],
      },
      tasks: [{
        id: 'method-suggestions-task',
        prompt: 'Find the method.',
        expectedMethods: ['chageOrder'],
      }],
    };

    const report = await runCodexE2ePreflight({
      suite,
      root: repo,
      workspaceKey: 'method-suggestions',
      tasks: suite.tasks,
      plannedRuns: 1,
    });

    const issue = report.issues.find(issue => issue.code === 'missing_required_method' && issue.expected === 'chageOrder');
    expect(issue).toBeDefined();
    expect(issue?.suggestions).toBeDefined();
    expect(issue?.suggestions?.some(item => item.includes('chargeOrder'))).toBe(true);
    expect(issue?.severity).toBe('error');
  });

  it('blocks non-dry-run Codex execution when required suite files are absent', async () => {
    const repo = tempDir('codegraph-codex-blocked-');
    const runDir = tempDir('codegraph-codex-run-');
    writeFile(repo, 'src/only.ts', 'export const only = true;\n');
    const opened = await openCodeGraphDb(repo);
    const indexer = new V2Indexer(opened.db);
    await indexer.indexWorkspace({ root: repo, workspaceKey: 'preflight-block' });
    await opened.db.close();

    const suite: CodexE2eSuite = {
      name: 'preflight-block-suite',
      rootProfile: {
        name: 'hadoop-required',
        requiredFiles: ['RMWebServices.java'],
      },
      tasks: [{
        id: 'missing-task',
        prompt: 'Explain Hadoop RM web services.',
        expectedFiles: ['RMWebServices.java'],
      }],
    };
    const suitePath = path.join(repo, 'suite.json');
    fs.writeFileSync(suitePath, `${JSON.stringify(suite, null, 2)}\n`, 'utf-8');

    const report = await runCodexE2eBenchmark({
      suitePath,
      root: repo,
      workspaceKey: 'preflight-block',
      runDir,
      models: ['fake-model'],
      modes: ['compiled-packet+gate'],
      skipIndex: true,
      codexCommand: 'definitely-not-codex',
    });

    expect(report.preflight.status).toBe('failed');
    expect(report.preflight.issues).toContainEqual(expect.objectContaining({
      code: 'missing_required_file',
      expected: 'RMWebServices.java',
    }));
    expect(report.preflight.skippedRuns).toBe(1);
    expect(report.runs).toEqual([]);
    expect(report.aggregate.runs).toBe(0);
    expect(fs.readFileSync(path.join(runDir, 'report.json'), 'utf-8')).toContain('"skippedRuns": 1');
  });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}
