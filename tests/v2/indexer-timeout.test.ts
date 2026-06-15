import { describe, expect, it } from 'vitest';
import type { CodeGraphDb } from '../../src/v2/storage/database.js';
import { V2Indexer } from '../../src/v2/index/indexer.js';

describe('V2Indexer unchanged snapshot copy', () => {
  it('copies unchanged snapshot facts without session timeout setup', async () => {
    const statements: string[] = [];
    const db = {
      prepare(sql: string) {
        statements.push(sql);
        return {
          run: async () => ({ changes: 0 }),
          all: async () => [],
          get: async () => undefined,
        };
      },
    };
    const indexer = new V2Indexer(db as unknown as CodeGraphDb) as unknown as {
      copyUnchangedRows(fromSnapshotId: string, toSnapshotId: string): Promise<void>;
    };

    await indexer.copyUnchangedRows('old-snapshot', 'new-snapshot');

    const normalized = statements.map(sql => sql.replace(/\s+/g, ' ').trim());
    expect(normalized.some(sql => sql.startsWith('SET LOCAL'))).toBe(false);
    expect(normalized[0]?.startsWith('INSERT INTO symbols')).toBe(true);
    expect(normalized.filter(sql => sql.startsWith('INSERT INTO '))).toHaveLength(9);
    expect(normalized.some(sql => sql.startsWith('INSERT INTO call_edges'))).toBe(true);
  });
});
