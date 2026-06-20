import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openCodeGraphDb, type CodeGraphDb } from '../../src/v2/storage/database.js';
import { V2Indexer } from '../../src/v2/index/indexer.js';
import {
  compileBenchmarkTaskType,
  parseCodexJsonEvents,
  runCodexE2eBenchmark,
  runCodexE2ePreflight,
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
