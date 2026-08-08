import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckpointConflictError, CheckpointStateStore } from '../../src/v2/checkpoint.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('repo-local task checkpoints', () => {
  it('advertises and serves checkpoint actions through MCP stdio', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-checkpoint-mcp-'));
    tempDirs.push(root);
    const client = new Client({ name: 'checkpoint-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/cli.ts', 'mcp', '--root', root, '--mcp-profile', 'client', '--no-prewarm'],
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name)).toContain('codegraph_checkpoint');
      const saved = await client.callTool({ name: 'codegraph_checkpoint', arguments: {
        action: 'save',
        task: 'MCP checkpoint smoke test',
        phase: 'discovery',
        state: { constraints: ['stdio'] },
      } });
      const savedPayload = JSON.parse(firstText(saved)) as { taskId: string; version: number };
      expect(savedPayload.version).toBe(1);
      const loaded = await client.callTool({ name: 'codegraph_checkpoint', arguments: {
        action: 'load', taskId: savedPayload.taskId,
      } });
      expect(JSON.parse(firstText(loaded))).toMatchObject({ taskId: savedPayload.taskId, resumeReady: true });
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  });

  it('saves immutable versions, binds claims, detects stale source, and resumes explicitly', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-checkpoint-'));
    tempDirs.push(root);
    const source = path.join(root, 'service.ts');
    fs.writeFileSync(source, 'export function checkout() { return true; }\n', 'utf8');
    const store = new CheckpointStateStore(root);
    try {
      const first = store.save({
        task: 'Implement checkout validation',
        phase: 'discovery',
        state: {
          evidenceClaims: [{ id: 'claim-1', claim: 'checkout is defined here', file: 'service.ts', lines: '1', confidence: 0.9 }],
          remainingWork: ['inspect tests'],
          latestTest: { command: 'npm test', exitCode: 0, outputTail: 'token=secret-value' },
        },
      });
      expect(first.version).toBe(1);
      expect(first.state.latestTest?.outputTail).toContain('token=<redacted>');
      expect(fs.existsSync(path.join(root, '.codegraph', 'task-state.sqlite'))).toBe(true);

      const second = store.save({
        taskId: first.taskId,
        expectedVersion: first.version,
        task: first.task,
        phase: 'implementation',
        state: { evidenceClaims: first.state.evidenceClaims },
      });
      expect(second.version).toBe(2);
      expect(store.load(first.taskId).resumeReady).toBe(true);

      expect(() => store.save({
        taskId: first.taskId,
        expectedVersion: 1,
        task: first.task,
        phase: 'verification',
        state: {},
      })).toThrow(CheckpointConflictError);

      fs.writeFileSync(source, '// moved\nexport function checkout() { return true; }\n', 'utf8');
      const relocated = store.load(first.taskId);
      expect(relocated.claimValidation[0]?.status).toBe('relocated');
      fs.writeFileSync(source, '// moved\nexport function checkout() { return false; }\n', 'utf8');
      const stale = store.load(first.taskId);
      expect(stale.resumeReady).toBe(false);
      expect(stale.claimValidation[0]?.status).toBe('stale');

      const verification = store.save({ taskId: first.taskId, expectedVersion: second.version, task: first.task, phase: 'verification', state: { remainingWork: [] } });
      const completed = store.complete(first.taskId, verification.version, { remainingWork: [] });
      expect(completed.status).toBe('complete');
      expect(store.list()).toEqual(expect.arrayContaining([
        expect.objectContaining({ taskId: first.taskId, status: 'complete', phase: 'complete' }),
      ]));
    } finally {
      store.close();
    }
  });

  it('rejects missing task ids for load and path traversal claims', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-checkpoint-'));
    tempDirs.push(root);
    const store = new CheckpointStateStore(root);
    try {
      expect(() => store.load('00000000-0000-0000-0000-000000000000')).toThrow(/not found/i);
      const saved = store.save({ task: 'safe task', phase: 'discovery', state: {
        evidenceClaims: [{ claim: 'outside', file: '../outside.ts' }],
      } });
      const loaded = store.load(saved.taskId);
      expect(loaded.resumeReady).toBe(false);
      expect(loaded.claimValidation[0]?.status).toBe('missing');
    } finally {
      store.close();
    }
  });
});

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content.find(entry => entry.type === 'text' && typeof entry.text === 'string');
  if (!item?.text) throw new Error('MCP result did not contain text.');
  return item.text;
}
