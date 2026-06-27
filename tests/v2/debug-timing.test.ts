import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CodeGraphDb } from '../../src/v2/storage/database.js';
import { openCodeGraphDb } from '../../src/v2/storage/database.js';
import { V2Indexer } from '../../src/v2/index/indexer.js';
import { V2QueryService } from '../../src/v2/query/service.js';
import { parseToolArgs } from '../../src/v2/mcp/tools.js';
import { routeCodeGraphContext } from '../../src/v2/mcp/proxy.js';
import { buildLocalArtifactIndex } from '../../src/v2/mcp/local-artifact.js';

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

describe('composite debug timing', () => {
  it('keeps timing opt-in through the context facade change route', () => {
    expect(parseToolArgs('codegraph_context', {
      task: 'Implement PaymentService submit behavior',
      files: ['src/main/java/com/example/PaymentService.java'],
      debugTiming: true,
    })).toMatchObject({ debugTiming: true });

    expect(routeCodeGraphContext({
      task: 'Implement PaymentService submit behavior',
      files: ['src/main/java/com/example/PaymentService.java'],
      debugTiming: true,
    })).toMatchObject({
      toolName: 'get_change_pack',
      args: { debugTiming: true },
    });
  });

  it('is opt-in for patch impact and change packs', async () => {
    const repo = tempDir('codegraph-debug-timing-');
    writeFile(repo, 'src/main/java/com/example/PaymentGateway.java', `package com.example;

public class PaymentGateway {
  public void processPayment() {
  }
}
`);
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  private final PaymentGateway gateway = new PaymentGateway();

  public void submit() {
    gateway.processPayment();
  }
}
`);

    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    expect(parseToolArgs('simulate_patch_impact', {
      files: ['src/main/java/com/example/PaymentService.java'],
      debugTiming: true,
    })).toMatchObject({ debugTiming: true });
    expect(parseToolArgs('get_change_pack', {
      task: 'Change PaymentService submit behavior',
      files: ['src/main/java/com/example/PaymentService.java'],
      debugTiming: true,
    })).toMatchObject({ debugTiming: true });

    const defaultImpact = await queries.query({
      workspaceId: indexed.workspaceId,
      toolName: 'simulate_patch_impact',
      args: { files: ['src/main/java/com/example/PaymentService.java'] },
    }) as { debugTiming?: unknown };
    expect(defaultImpact.debugTiming).toBeUndefined();

    const timedImpact = await queries.query({
      workspaceId: indexed.workspaceId,
      toolName: 'simulate_patch_impact',
      args: {
        files: ['src/main/java/com/example/PaymentService.java'],
        debugTiming: true,
      },
    }) as { debugTiming?: DebugTiming };
    expect(timedImpact.debugTiming?.enabled).toBe(true);
    expect(timedImpact.debugTiming?.phases.map(phase => phase.name)).toEqual(expect.arrayContaining([
      'resolve_inputs',
      'symbols_for_files',
      'call_expansion',
      'field_impact',
      'response_budget',
    ]));
    expect(timedImpact.debugTiming?.totalMs).toBeGreaterThanOrEqual(0);

    const timedChangePack = await queries.query({
      workspaceId: indexed.workspaceId,
      toolName: 'get_change_pack',
      args: {
        task: 'Change PaymentService submit behavior',
        files: ['src/main/java/com/example/PaymentService.java'],
        debugTiming: true,
      },
    }) as { debugTiming?: DebugTiming };
    expect(timedChangePack.debugTiming?.enabled).toBe(true);
    expect(timedChangePack.debugTiming?.phases.map(phase => phase.name)).toEqual(expect.arrayContaining([
      'context_packet',
      'patch_impact',
      'architecture_context',
      'response_budget',
    ]));
  });

  it('prefers SQLite context over embedded artifact when both are ready', async () => {
    const repo = tempDir('codegraph-debug-timing-mcp-');
    writeFile(repo, 'src/main/java/com/example/PaymentGateway.java', `package com.example;

public class PaymentGateway {
  public void processPayment() {
  }
}
`);
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  private final PaymentGateway gateway = new PaymentGateway();

  public void submit() {
    gateway.processPayment();
  }
}
`);

    const opened = await openCodeGraphDb(repo);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();
    await buildLocalArtifactIndex(repo);

    const client = new Client({ name: 'codegraph-debug-timing-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
        'src/cli.ts',
        'mcp',
        '--root',
        repo,
        '--mcp-profile',
        'client',
        '--no-prewarm',
      ],
    });

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'codegraph_context',
        arguments: {
          task: 'Implement PaymentService submit behavior',
          files: ['src/main/java/com/example/PaymentService.java'],
          debugTiming: true,
        },
      });
      const parsed = JSON.parse(firstMcpText(result)) as {
        degraded?: boolean;
        source?: string;
        debugTiming?: DebugTiming;
      };

      expect(parsed.degraded).not.toBe(true);
      expect(parsed.source).not.toBe('local_artifact_index');
      expect(parsed.debugTiming?.enabled).toBe(true);
      expect(parsed.debugTiming?.phases.map(phase => phase.name)).toEqual(expect.arrayContaining([
        'context_packet',
        'response_budget',
      ]));
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

interface DebugTiming {
  enabled: boolean;
  totalMs: number;
  phases: Array<{ name: string; durationMs: number }>;
}

function firstMcpText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.find(part => part.type === 'text')?.text ?? '';
}

async function openDb(root: string): Promise<{ db: CodeGraphDb }> {
  const opened = await openCodeGraphDb(root);
  dbs.push(opened.db);
  return opened;
}

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, relPath: string, content: string): void {
  const absPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}
