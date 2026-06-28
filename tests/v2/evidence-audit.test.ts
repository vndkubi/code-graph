import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodeGraphDb } from '../../src/v2/storage/database.js';
import { openCodeGraphDb } from '../../src/v2/storage/database.js';
import { V2Indexer } from '../../src/v2/index/indexer.js';
import { runEvidenceAudit } from '../../src/v2/benchmark/evidence-audit.js';

const tempDirs: string[] = [];
const dbs: CodeGraphDb[] = [];

afterEach(async () => {
  for (const db of dbs.splice(0)) await db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('evidence right-sizing audit', () => {
  it('reports waste/gap with bounded ratios and a min-files verdict per task', async () => {
    const repo = tempDir('codegraph-audit-');
    writeFile(repo, 'src/payment/PaymentService.java', `package com.example.payment;
public class PaymentService {
  public boolean refund(String id, long amount) { return amount > 0; }
}
`);
    writeFile(repo, 'src/order/OrderService.java', `package com.example.order;
public class OrderService {
  public String create(String item) { return item; }
}
`);

    const { db } = await openDb(repo);
    await new V2Indexer(db).indexWorkspace({ root: repo });
    const result = await runEvidenceAudit(db, repo, { defaultMaxFiles: 6 });

    expect(result.tasks).toBeGreaterThan(0);
    expect(result.perTask).toHaveLength(result.tasks);
    // Ratios are well-formed.
    for (const ratio of [result.tokenWastePct, result.fileWastePct, result.gapPct]) {
      expect(ratio).toBeGreaterThanOrEqual(0);
      expect(ratio).toBeLessThanOrEqual(1);
    }
    // Right-sized delivery never exceeds default.
    expect(result.rightsizedFilesDelivered).toBeLessThanOrEqual(result.defaultFilesDelivered);
    expect(result.rightsizedInputTokens).toBeLessThanOrEqual(result.defaultInputTokens);
    // Every non-gap task has a concrete minimum within the cap.
    for (const t of result.perTask) {
      if (!t.gap) {
        expect(t.minFiles).toBeGreaterThanOrEqual(1);
        expect(t.minFiles).toBeLessThanOrEqual(result.maxFilesCap);
      }
    }
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
