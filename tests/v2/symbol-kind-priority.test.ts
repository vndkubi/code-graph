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

describe('symbol-search kind priority', () => {
  it('ranks a type definition above same-named fields for a bare type-name query', async () => {
    // Regression: a bare type name ("Note") tied a class definition with every
    // field literally named `note`. Because such fields are numerous, they
    // flooded the result and buried the one class, so "investigate the Note
    // entity" returned scattered fields instead of Note.java.
    const repo = tempDir('codegraph-kind-priority-');
    writeFile(repo, 'src/Note.ts', `export class Note {
  title: string = '';
}
`);
    // Several unrelated files each holding a field named `note`.
    for (const owner of ['Tracker', 'Embedding', 'Image', 'Question']) {
      writeFile(repo, `src/${owner}.ts`, `import { Note } from './Note';
export class ${owner} {
  note: Note | null = null;
}
`);
    }

    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });
    const result = await new V2QueryService(db).query({
      workspaceId: indexed.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'Note', limit: 5 },
    }) as { symbols: Array<{ name: string; kind?: string; file?: string }> };

    const top = result.symbols[0];
    expect(top?.name).toBe('Note');
    expect(top?.kind).toBe('class');
    expect(top?.file ?? '').toContain('Note.ts');
  });

  it('still resolves a field query to the field when no type shares the name', async () => {
    const repo = tempDir('codegraph-kind-field-');
    writeFile(repo, 'src/Tracker.ts', `export class Tracker {
  nextRecallAt: number = 0;
}
`);
    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });
    const result = await new V2QueryService(db).query({
      workspaceId: indexed.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'nextRecallAt', limit: 3 },
    }) as { symbols: Array<{ name: string; kind?: string }> };

    expect(result.symbols[0]?.name).toBe('nextRecallAt');
    expect(result.symbols[0]?.kind).toBe('field');
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
