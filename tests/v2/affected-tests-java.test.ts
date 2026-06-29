import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodeGraphDb } from '../../src/v2/storage/database.js';
import { openCodeGraphDb } from '../../src/v2/storage/database.js';
import { V2Indexer } from '../../src/v2/index/indexer.js';
import { findAffectedTests } from '../../src/v2/query/affected-tests.js';

const tempDirs: string[] = [];
const dbs: CodeGraphDb[] = [];

afterEach(async () => {
  for (const db of dbs.splice(0)) await db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('affected-tests for Java (reverse dependency graph)', () => {
  it('finds the test that depends on a changed Java class via dependency edges', async () => {
    // Java imports are package-qualified and flagged is_external, so the imports
    // table alone yields an empty graph; the dependency_edges union must carry
    // Java reachability. Regression: this returned 0 affected tests for Java.
    const repo = tempDir('codegraph-affected-java-');
    writeFile(repo, 'src/main/java/com/x/Calculator.java', `package com.x;
public class Calculator {
  public int addOne(int n) { return n + 1; }
}
`);
    writeFile(repo, 'src/test/java/com/x/CalculatorTest.java', `package com.x;
import com.x.Calculator;
public class CalculatorTest {
  public void testAddOne() {
    Calculator c = new Calculator();
    int r = c.addOne(1);
  }
}
`);
    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });
    const result = await findAffectedTests(
      db,
      indexed.snapshotId,
      ['src/main/java/com/x/Calculator.java'],
      { maxDepth: 4 },
    );
    expect(result.tests.some(t => t.file.endsWith('CalculatorTest.java'))).toBe(true);
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
