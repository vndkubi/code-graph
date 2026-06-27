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

describe('research-pack file ranking', () => {
  it('ranks a PascalCase class file above a generic same-word file that only mentions the term', async () => {
    const repo = tempDir('codegraph-rank-pascal-');
    // A generic file literally named `service` that merely MENTIONS payments in
    // comments/strings. Before the camelCase + compound fix this won the
    // exact-basename boost ("service") and buried the real class file.
    writeFile(repo, 'src/core/service.ts', `// generic service registry
// handles payment, refund, and order routing strings used across the app
export function registerService(name: string): void {
  // mentions payment service refund repeatedly in text only
  void name;
}
`);
    // The real implementation: a class whose PascalCase name IS the query.
    writeFile(repo, 'src/payment/PaymentService.java', `package com.example.payment;

public class PaymentService {
  public boolean refund(String id, long amount) {
    return amount > 0;
  }
}
`);

    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });
    const packet = await new V2QueryService(db).query({
      workspaceId: indexed.workspaceId,
      toolName: 'get_context_packet',
      args: {
        task: 'Find the payment service implementation and refund behavior.',
        tokenBudget: 4000,
        maxFiles: 6,
        maxSymbols: 10,
      },
    }) as { topFiles: string[] };

    const top = packet.topFiles.map(f => f.replace(/\\/g, '/'));
    const paymentIdx = top.findIndex(f => f.endsWith('PaymentService.java'));
    const genericIdx = top.findIndex(f => f.endsWith('core/service.ts'));

    expect(paymentIdx).toBeGreaterThanOrEqual(0);
    // The specific class file must outrank the generic `service.ts` (or the
    // generic file must not even make the cut).
    expect(genericIdx === -1 || paymentIdx < genericIdx).toBe(true);
  });

  it('falls back to fixture/mock sources when the concept lives only there', async () => {
    const repo = tempDir('codegraph-rank-fallback-');
    // Main source has NOTHING about payments — only unrelated generic code.
    writeFile(repo, 'src/core/logger.ts', `export function log(line: string): void {
  void line;
}
`);
    // The only payment code is under a /fixtures/ path -> classified mock_source
    // and excluded from the primary research search. The fallback tier must
    // still surface it instead of returning unrelated main-source noise.
    writeFile(repo, 'tests/fixtures/payment/PaymentService.java', `package com.example.payment;

public class PaymentService {
  public boolean refund(String id, long amount) {
    return amount > 0;
  }
}
`);

    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });
    const packet = await new V2QueryService(db).query({
      workspaceId: indexed.workspaceId,
      toolName: 'get_context_packet',
      args: {
        task: 'Find the payment service implementation and refund behavior.',
        tokenBudget: 4000,
        maxFiles: 6,
        maxSymbols: 10,
      },
    }) as { topFiles: string[]; relevantSymbols?: Array<{ file?: string }> };

    const top = packet.topFiles.map(f => f.replace(/\\/g, '/'));
    expect(top.some(f => f.endsWith('PaymentService.java'))).toBe(true);
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
