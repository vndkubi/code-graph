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

describe('unique-name call resolution', () => {
  it('promotes a bare call to a uniquely-named function to name-unique, leaves ambiguous names name-only', async () => {
    const repo = tempDir('codegraph-unique-');
    // Uniquely-named function -> resolvable.
    writeFile(repo, 'src/util.ts', `export function computeGrandTotal(x: number): number { return x + 1; }
`);
    // Same name defined twice -> ambiguous -> must stay name-only.
    writeFile(repo, 'src/a.ts', `export function sharedHelper(): void {}
`);
    writeFile(repo, 'src/b.ts', `export function sharedHelper(): void {}
`);
    writeFile(repo, 'src/main.ts', `import { computeGrandTotal } from './util';
import { sharedHelper } from './a';
export function run(): void {
  computeGrandTotal(41);
  sharedHelper();
}
`);

    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });

    const grand = await db.all(`
      SELECT callee, resolution_kind, confidence FROM call_edges
      WHERE snapshot_id = ? AND callee LIKE '%computeGrandTotal%'
    `, indexed.snapshotId) as Array<{ callee: string; resolution_kind: string; confidence: number }>;
    expect(grand.length).toBeGreaterThan(0);
    expect(grand.some(e => e.resolution_kind === 'name-unique')).toBe(true);

    const shared = await db.all(`
      SELECT resolution_kind FROM call_edges
      WHERE snapshot_id = ? AND callee LIKE '%sharedHelper%'
    `, indexed.snapshotId) as Array<{ resolution_kind: string }>;
    // Ambiguous (two definitions, neither in the caller's file) -> never
    // promoted to name-unique or name-local.
    expect(shared.every(e => e.resolution_kind !== 'name-unique' && e.resolution_kind !== 'name-local')).toBe(true);
  });

  it('resolves a bare call to a same-file helper even when the name is ambiguous project-wide', async () => {
    const repo = tempDir('codegraph-local-');
    // `format` is defined in BOTH files (ambiguous globally) but each call must
    // bind to its own file's definition.
    writeFile(repo, 'src/x.ts', `function format(v: string): string { return v.trim(); }
export function runX(): void { format('x'); }
`);
    writeFile(repo, 'src/y.ts', `function format(v: string): string { return v.toUpperCase(); }
export function runY(): void { format('y'); }
`);
    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });
    const edges = await db.all(`
      SELECT file, callee, resolution_kind FROM call_edges
      WHERE snapshot_id = ? AND callee LIKE '%format%' AND resolution_kind = 'name-local'
    `, indexed.snapshotId) as Array<{ file: string; callee: string; resolution_kind: string }>;
    // Both call sites resolve same-file (name-local), not left name-only.
    expect(edges.length).toBeGreaterThanOrEqual(2);
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
