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
  for (const db of dbs.splice(0)) await db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('symbol-search call-graph centrality', () => {
  it('boosts a frequently-called symbol with a centrality factor', async () => {
    const repo = tempDir('codegraph-centrality-');
    writeFile(repo, 'src/util.ts', `export function widelyUsedHelper(x: number): number { return x + 1; }
`);
    // Many call sites in one file (each binds to the imported helper).
    const calls = Array.from({ length: 8 }, (_, i) => `  widelyUsedHelper(${i});`).join('\n');
    writeFile(repo, 'src/main.ts', `import { widelyUsedHelper } from './util';
export function run(): void {
${calls}
}
`);

    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });
    const result = await new V2QueryService(db).query({
      workspaceId: indexed.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'widelyUsedHelper', limit: 5, explainRank: true },
    }) as { symbols: Array<{ name: string; fqName?: string; rankExplanation?: string[] }> };

    const hit = result.symbols.find(s => (s.fqName ?? s.name).includes('widelyUsedHelper'));
    expect(hit).toBeTruthy();
    expect((hit?.rankExplanation ?? []).some(f => /centrality/.test(f))).toBe(true);
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
