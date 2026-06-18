import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openCodeGraphDb } from '../../src/v2/storage/database.js';
import { getWorkspacePaths } from '../../src/v2/paths.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('SQLite graph backend', () => {
  it('stores graph state inside the workspace .codegraph directory', async () => {
    const root = tempDir('codegraph-sqlite-root-');
    const opened = await openCodeGraphDb(root);
    try {
      const paths = getWorkspacePaths(root);
      expect(opened.backend).toBe('sqlite');
      expect(opened.dbPath).toBe(paths.dbPath);
      expect(fs.existsSync(paths.dbPath)).toBe(true);
      expect(fs.existsSync(paths.sourceCacheDir)).toBe(true);
      expect(fs.existsSync(paths.logDir)).toBe(true);
      expect(opened.graph.isHealthy()).toBe(true);
    } finally {
      await opened.db.close();
    }
  });

  it('supports transaction and bulk insert APIs used by the indexer', async () => {
    const root = tempDir('codegraph-sqlite-bulk-');
    const { db } = await openCodeGraphDb(root);
    try {
      const tx = db.transaction(async () => {
        await db.copyFromRows('workspaces', [
          'id',
          'root',
          'workspace_key',
          'git_remote',
          'git_common_dir',
          'created_at',
          'last_seen_at',
        ], [
          ['workspace-a', root, null, null, null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
        ]);
      });
      await tx();
      expect(await db.scalar('SELECT COUNT(*) FROM workspaces')).toBe(1);
    } finally {
      await db.close();
    }
  });

  it('creates search FTS table and case-insensitive symbol indexes idempotently', async () => {
    const root = tempDir('codegraph-sqlite-search-schema-');
    const first = await openCodeGraphDb(root);
    try {
      const objects = await first.db.prepare(`
        SELECT name, type
        FROM sqlite_master
        WHERE name IN ('codegraph_search_fts', 'idx_symbols_name_nocase', 'idx_symbols_fq_nocase')
        ORDER BY name
      `).all() as Array<{ name: string; type: string }>;
      expect(objects).toContainEqual({ name: 'codegraph_search_fts', type: 'table' });
      expect(objects).toContainEqual({ name: 'idx_symbols_fq_nocase', type: 'index' });
      expect(objects).toContainEqual({ name: 'idx_symbols_name_nocase', type: 'index' });
    } finally {
      await first.db.close();
    }

    const reopened = await openCodeGraphDb(root);
    try {
      expect(await reopened.db.scalar(`
        SELECT COUNT(*)
        FROM sqlite_master
        WHERE name IN ('codegraph_search_fts', 'idx_symbols_name_nocase', 'idx_symbols_fq_nocase')
      `)).toBe(3);
    } finally {
      await reopened.db.close();
    }
  });

  it('copies large parse_cache text shards in bounded chunks', async () => {
    const root = tempDir('codegraph-sqlite-copy-shard-');
    const { db } = await openCodeGraphDb(root);
    const shardPath = path.join(root, 'parse-cache.copy');
    try {
      const now = '2026-01-01T00:00:00.000Z';
      const largeParseJson = JSON.stringify({
        symbols: [],
        calls: [],
        payload: 'x'.repeat(200_000),
      });
      const rows = Array.from({ length: 30 }, (_, index) => [
        'tree-sitter',
        'tree-sitter-analyzer-test',
        `blob-${index}`,
        'java',
        largeParseJson,
        0,
        0.95,
        now,
      ]);
      fs.writeFileSync(shardPath, rows.map(row => `${row.map(copyTextValue).join('\t')}\n`).join(''));

      await db.copyFromTextFiles('parse_cache', [
        'provider_id',
        'provider_version',
        'blob_hash',
        'language',
        'parse_json',
        'has_parse_errors',
        'parse_confidence',
        'created_at',
      ], [shardPath]);

      expect(await db.scalar('SELECT COUNT(*) FROM parse_cache WHERE provider_version = ?', 'tree-sitter-analyzer-test')).toBe(30);
      const sample = await db.get<{ parse_json: string }>(
        'SELECT parse_json FROM parse_cache WHERE blob_hash = ?',
        'blob-29',
      );
      expect(sample?.parse_json).toBe(largeParseJson);
    } finally {
      await db.close();
    }
  });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function copyTextValue(value: unknown): string {
  if (value === null || value === undefined) return '\\N';
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}
