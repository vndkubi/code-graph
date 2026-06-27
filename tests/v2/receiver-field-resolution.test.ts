import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodeGraphDb } from '../../src/v2/storage/database.js';
import { openCodeGraphDb } from '../../src/v2/storage/database.js';
import { V2Indexer } from '../../src/v2/index/indexer.js';

const tempDirs: string[] = [];
const dbs: CodeGraphDb[] = [];

afterEach(async () => {
  for (const db of dbs.splice(0)) await db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('TS receiver-field call resolution', () => {
  it('captures a constructor parameter-property type and resolves this.field.method()', async () => {
    const repo = tempDir('codegraph-recv-');
    writeFile(repo, 'src/gateway.ts', `export class PaymentGateway {
  charge(amount: number): boolean { return amount > 0; }
}
`);
    writeFile(repo, 'src/service.ts', `import { PaymentGateway } from './gateway';
export class PaymentService {
  constructor(private readonly gateway: PaymentGateway) {}
  run(): void {
    this.gateway.charge(10);
  }
}
`);

    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });

    // The constructor param property `gateway` is recorded as a typed field.
    const field = await db.get(`
      SELECT return_type FROM symbols
      WHERE snapshot_id = ? AND kind = 'field' AND simple_name = 'gateway' AND parent = 'PaymentService'
    `, indexed.snapshotId) as { return_type?: string } | undefined;
    expect(field?.return_type).toBe('PaymentGateway');

    // this.gateway.charge() resolves to PaymentGateway.charge via the field type.
    const edge = await db.all(`
      SELECT callee, resolution_kind FROM call_edges
      WHERE snapshot_id = ? AND callee LIKE '%charge%'
    `, indexed.snapshotId) as Array<{ callee: string; resolution_kind: string }>;
    expect(edge.some(e => e.callee === 'PaymentGateway.charge' && e.resolution_kind === 'receiver-field')).toBe(true);
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
