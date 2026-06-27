import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodeGraphDb } from '../../src/v2/storage/database.js';
import { openCodeGraphDb } from '../../src/v2/storage/database.js';
import { V2Indexer } from '../../src/v2/index/indexer.js';
import { V2QueryService } from '../../src/v2/query/service.js';

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

describe('call-edge lookup', () => {
  it('prioritizes exact caller matches before fuzzy substring edges', async () => {
    const repo = tempDir('codegraph-call-edge-exact-');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
}
`);

    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });
    await injectCallEdges(db, indexed.snapshotId, [
      ['ExactCaller.submit', 'PaymentGateway.processPayment', 'src/main/java/com/example/PaymentService.java', 10, 0.8],
      ['NoisyCaller.submit', 'OtherPaymentGateway.processPaymentExtra', 'src/main/java/com/example/PaymentService.java', 20, 0.99],
      ['ExactCaller.submitExtra', 'NoisyCallee.run', 'src/main/java/com/example/PaymentService.java', 30, 0.99],
    ]);

    const callers = await new V2QueryService(db).query({
      workspaceId: indexed.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'PaymentGateway.processPayment', limit: 10 },
    }) as {
      callers: Array<{ caller: string; callee: string }>;
      lookup?: { strategy?: string; exactCount?: number; fuzzyCount?: number };
    };

    expect(callers.lookup).toMatchObject({
      strategy: 'exact-first',
      exactCount: 1,
      fuzzyCount: 1,
    });
    expect(callers.callers[0]).toMatchObject({
      caller: 'ExactCaller.submit',
      callee: 'PaymentGateway.processPayment',
    });
    expect(callers.callers[1]).toMatchObject({
      caller: 'NoisyCaller.submit',
      callee: 'OtherPaymentGateway.processPaymentExtra',
    });

    const callees = await new V2QueryService(db).query({
      workspaceId: indexed.workspaceId,
      toolName: 'get_callees',
      args: { symbol: 'ExactCaller.submit', limit: 10 },
    }) as {
      callees: Array<{ caller: string; callee: string }>;
      lookup?: { strategy?: string; exactCount?: number; fuzzyCount?: number };
    };

    expect(callees.lookup).toMatchObject({
      strategy: 'exact-first',
      exactCount: 1,
      fuzzyCount: 1,
    });
    expect(callees.callees[0]).toMatchObject({
      caller: 'ExactCaller.submit',
      callee: 'PaymentGateway.processPayment',
    });
    expect(callees.callees[1]).toMatchObject({
      caller: 'ExactCaller.submitExtra',
      callee: 'NoisyCallee.run',
    });
  });
});

async function injectCallEdges(
  db: CodeGraphDb,
  snapshotId: string,
  rows: Array<[caller: string, callee: string, file: string, line: number, confidence: number]>,
): Promise<void> {
  await db.copyFromRows('call_edges', [
    'snapshot_id',
    'caller',
    'callee',
    'file',
    'line',
    'confidence',
    'resolution_kind',
    'file_role',
    'signal_tier',
    'signal_reasons_json',
  ], rows.map(([caller, callee, file, line, confidence]) => [
    snapshotId,
    caller,
    callee,
    file,
    line,
    confidence,
    'test-fixture',
    'main_source',
    'primary',
    '[]',
  ]));
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
