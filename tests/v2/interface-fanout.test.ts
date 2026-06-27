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

describe('interface-implementation edge fan-out', () => {
  it('demotes ambiguous multi-implementation expansions to the low-signal tier', async () => {
    const repo = tempDir('codegraph-fanout-');
    writeFile(repo, 'src/Gateway.java', `package x;
public interface Gateway { void send(String m); }
`);
    writeFile(repo, 'src/AGateway.java', `package x;
public class AGateway implements Gateway { public void send(String m) {} }
`);
    writeFile(repo, 'src/BGateway.java', `package x;
public class BGateway implements Gateway { public void send(String m) {} }
`);
    writeFile(repo, 'src/Caller.java', `package x;
public class Caller {
  private Gateway gateway;
  public void run() { gateway.send("hi"); }
}
`);

    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });
    const edges = await db.all(`
      SELECT callee, signal_tier, confidence
      FROM call_edges
      WHERE snapshot_id = ? AND resolution_kind = 'interface-implementation'
    `, indexed.snapshotId) as Array<{ callee: string; signal_tier: string; confidence: number }>;

    // Both AGateway.send and BGateway.send are candidate expansions of the
    // single Gateway.send call -> fan-out 2 -> low-signal, not primary.
    const expanded = edges.filter(e => /Gateway\.send$/.test(e.callee));
    expect(expanded.length).toBeGreaterThanOrEqual(2);
    expect(expanded.every(e => e.signal_tier === 'low_signal')).toBe(true);
    expect(expanded.every(e => e.confidence < 0.65)).toBe(true);
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
