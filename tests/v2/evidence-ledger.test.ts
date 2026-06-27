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

type Pack = {
  evidenceSlices?: Array<Record<string, unknown>>;
  completeness?: { reusedEvidenceCount?: number };
};

describe('session evidence ledger (duplicate-token dedup)', () => {
  it('omits source text on a repeated pack call and restores it with freshEvidence', async () => {
    const repo = tempDir('codegraph-ledger-');
    writeFile(repo, 'src/payment/PaymentService.java', `package com.example.payment;

public class PaymentService {
  public boolean refund(String id, long amount) {
    if (amount <= 0) {
      return false;
    }
    return true;
  }
}
`);

    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });
    // One service instance => one session, like the long-lived MCP process.
    const queries = new V2QueryService(db);
    const args = {
      target: 'PaymentService',
      taskType: 'research',
      tokenBudget: 16000,
      responseMode: 'agent',
      profile: 'full',
      sessionId: 'conv-123',
    };

    const call1 = await queries.query({ workspaceId: indexed.workspaceId, toolName: 'get_research_pack', args }) as Pack;
    const slices1 = call1.evidenceSlices ?? [];
    expect(slices1.length).toBeGreaterThan(0);
    expect(slices1.some(s => typeof s.text === 'string' && (s.text as string).length > 0)).toBe(true);
    expect(call1.completeness?.reusedEvidenceCount ?? 0).toBe(0);

    const call2 = await queries.query({ workspaceId: indexed.workspaceId, toolName: 'get_research_pack', args }) as Pack;
    const slices2 = call2.evidenceSlices ?? [];
    // Same slices come back, but flagged as reused with the body stripped.
    expect(call2.completeness?.reusedEvidenceCount ?? 0).toBeGreaterThan(0);
    expect(slices2.some(s => s.reusedFromEarlierCall === true)).toBe(true);
    expect(slices2.every(s => s.reusedFromEarlierCall !== true || s.text === undefined)).toBe(true);
    // The handle (file/lines) is preserved so the agent can still locate / re-fetch it.
    expect(slices2.every(s => typeof s.file === 'string' && (s.file as string).length > 0)).toBe(true);

    // Escape hatch: freshEvidence forces full bodies again.
    const call3 = await queries.query({
      workspaceId: indexed.workspaceId,
      toolName: 'get_research_pack',
      args: { ...args, freshEvidence: true },
    }) as Pack;
    const slices3 = call3.evidenceSlices ?? [];
    expect(call3.completeness?.reusedEvidenceCount ?? 0).toBe(0);
    expect(slices3.some(s => typeof s.text === 'string' && (s.text as string).length > 0)).toBe(true);
  });

  it('does not dedupe without a sessionId (packets stay self-contained by default)', async () => {
    const repo = tempDir('codegraph-ledger-default-');
    writeFile(repo, 'src/payment/PaymentService.java', `package com.example.payment;

public class PaymentService {
  public boolean refund(String id, long amount) {
    return amount > 0;
  }
}
`);
    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);
    const args = { target: 'PaymentService', taskType: 'research', tokenBudget: 16000, responseMode: 'agent', profile: 'full' };

    const call1 = await queries.query({ workspaceId: indexed.workspaceId, toolName: 'get_research_pack', args }) as Pack;
    const call2 = await queries.query({ workspaceId: indexed.workspaceId, toolName: 'get_research_pack', args }) as Pack;
    // No sessionId => both calls return full, self-contained source bodies.
    expect(call1.completeness?.reusedEvidenceCount ?? 0).toBe(0);
    expect(call2.completeness?.reusedEvidenceCount ?? 0).toBe(0);
    expect((call2.evidenceSlices ?? []).some(s => typeof s.text === 'string' && (s.text as string).length > 0)).toBe(true);
    expect((call2.evidenceSlices ?? []).every(s => s.reusedFromEarlierCall !== true)).toBe(true);
  });
});

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
