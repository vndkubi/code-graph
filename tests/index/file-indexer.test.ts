import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileIndexer } from '../../src/index/file-indexer.js';

const tempDirs: string[] = [];

function createTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-code-graph-indexer-'));
  tempDirs.push(dir);

  fs.writeFileSync(path.join(dir, 'b.ts'), 'export function helper() { return 1; }\n');
  fs.writeFileSync(
    path.join(dir, 'a.ts'),
    "import { helper } from './b';\nexport function main() { return helper(); }\n",
  );

  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('FileIndexer', () => {
  it('should rebuild without duplicating graph edges or weights', async () => {
    const rootDir = createTempProject();
    const indexer = new FileIndexer({ rootDir, cacheTtlMs: 60_000 });

    await indexer.buildIndex();
    await indexer.buildIndex();

    const graph = indexer.getDependencyGraph();
    const node = graph.findNode('a.ts');
    expect(node).toBeDefined();

    const deps = graph.getDependencies(node!.id);
    expect(deps).toHaveLength(1);
    expect(deps[0].weight).toBe(1);
    expect(graph.edgeCount).toBe(1);
  });
});
