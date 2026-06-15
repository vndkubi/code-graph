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
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
