import { describe, expect, it } from 'vitest';
import { selectAffectedTests, type ImportGraph } from '../../src/v2/query/affected-tests.js';

// Synthetic reverse-import graph:
//   test/a.test.ts -> src/a.ts            (direct)
//   src/b.ts       -> src/a.ts            (b depends on a)
//   test/b.test.ts -> src/b.ts            (transitive to a via b)
//   test/iso.test.ts -> src/iso.ts        (unrelated)
function graph(): ImportGraph {
  const roleByPath = new Map<string, string>([
    ['src/a.ts', 'main_source'],
    ['src/b.ts', 'main_source'],
    ['src/iso.ts', 'main_source'],
    ['test/a.test.ts', 'test_source'],
    ['test/b.test.ts', 'test_source'],
    ['test/iso.test.ts', 'test_source'],
  ]);
  const importers = new Map<string, Set<string>>([
    ['src/a.ts', new Set(['test/a.test.ts', 'src/b.ts'])],
    ['src/b.ts', new Set(['test/b.test.ts'])],
    ['src/iso.ts', new Set(['test/iso.test.ts'])],
  ]);
  return { importers, roleByPath, allPaths: new Set(roleByPath.keys()), totalTests: 3 };
}

describe('selectAffectedTests (test-impact via reverse imports)', () => {
  it('selects the directly-importing test at distance 1', () => {
    const r = selectAffectedTests(graph(), ['src/a.ts']);
    const direct = r.tests.find(t => t.file === 'test/a.test.ts');
    expect(direct).toBeDefined();
    expect(direct?.distance).toBe(1);
  });

  it('reaches transitive tests through intermediate source files', () => {
    const r = selectAffectedTests(graph(), ['src/a.ts']);
    // test/b.test.ts imports src/b.ts which imports src/a.ts -> distance 2
    const transitive = r.tests.find(t => t.file === 'test/b.test.ts');
    expect(transitive?.distance).toBe(2);
  });

  it('does not select unrelated tests and reports a real reduction', () => {
    const r = selectAffectedTests(graph(), ['src/a.ts']);
    expect(r.tests.some(t => t.file === 'test/iso.test.ts')).toBe(false);
    expect(r.testCount).toBe(2);
    expect(r.totalTests).toBe(3);
    expect(r.reductionPct).toBeCloseTo(1 - 2 / 3, 2);
  });

  it('respects maxDepth (depth 1 keeps only direct importers)', () => {
    const r = selectAffectedTests(graph(), ['src/a.ts'], { maxDepth: 1 });
    expect(r.tests.map(t => t.file)).toEqual(['test/a.test.ts']);
  });

  it('reports unresolved changed paths instead of throwing', () => {
    const r = selectAffectedTests(graph(), ['src/does-not-exist.ts']);
    expect(r.unresolvedChanged).toEqual(['src/does-not-exist.ts']);
    expect(r.testCount).toBe(0);
  });
});
