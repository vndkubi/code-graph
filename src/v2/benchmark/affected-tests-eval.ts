/**
 * Affected-tests eval. Measures the test-impact selector two ways, both from the
 * graph itself (no test runner needed):
 *
 *   - correctness: every test that DIRECTLY imports a changed file must be in the
 *     selection (recall of distance-1 ground truth, expected ~1.0).
 *   - value: how much smaller the targeted set is than running the whole suite
 *     (avg reduction%) — the actual CI payoff.
 *
 * Ground truth is the reverse-import graph's distance-1 edges, so this is a
 * graph-consistency + selectivity gate, not a dynamic-coverage measurement.
 */
import { buildImportGraph, selectAffectedTests, TEST_ROLES } from '../query/affected-tests.js';
import { V2Indexer } from '../index/indexer.js';
import type { CodeGraphDb } from '../storage/database.js';

export interface AffectedTestsEvalOptions {
  sample?: number;
  maxDepth?: number;
}

export interface AffectedTestsEvalResult {
  root: string;
  totalTests: number;
  sampledChanges: number;
  avgDirectRecall: number;
  avgTestsSelected: number;
  avgReductionPct: number;
  worstRecall: number;
  examples: Array<{ changed: string; expectedDirect: number; selected: number; recall: number; reductionPct: number }>;
}

export async function runAffectedTestsEval(
  db: CodeGraphDb,
  root: string,
  options: AffectedTestsEvalOptions = {},
): Promise<AffectedTestsEvalResult> {
  const sample = Math.max(1, options.sample ?? 25);
  const index = await new V2Indexer(db).indexWorkspace({ root });
  const graph = await buildImportGraph(db, index.snapshotId);

  // Changeable source files that have at least one direct test importer — the
  // population with verifiable ground truth. Deterministic order (no RNG).
  const seeds: Array<{ file: string; directTests: string[] }> = [];
  for (const [target, importerSet] of graph.importers) {
    if (TEST_ROLES.has(graph.roleByPath.get(target) ?? 'main_source')) continue;
    const directTests = [...importerSet].filter(f => TEST_ROLES.has(graph.roleByPath.get(f) ?? 'main_source'));
    if (directTests.length > 0) seeds.push({ file: target, directTests });
  }
  seeds.sort((a, b) => a.file.localeCompare(b.file));
  const sampled = seeds.slice(0, sample);

  const examples: AffectedTestsEvalResult['examples'] = [];
  let recallSum = 0;
  let selectedSum = 0;
  let reductionSum = 0;
  let worstRecall = 1;
  for (const seed of sampled) {
    const result = selectAffectedTests(graph, [seed.file], { maxDepth: options.maxDepth });
    const selectedFiles = new Set(result.tests.map(t => t.file));
    const covered = seed.directTests.filter(t => selectedFiles.has(t)).length;
    const recall = Number((covered / seed.directTests.length).toFixed(3));
    recallSum += recall;
    selectedSum += result.testCount;
    reductionSum += result.reductionPct;
    worstRecall = Math.min(worstRecall, recall);
    if (examples.length < 8) {
      examples.push({
        changed: seed.file,
        expectedDirect: seed.directTests.length,
        selected: result.testCount,
        recall,
        reductionPct: result.reductionPct,
      });
    }
  }

  const n = sampled.length || 1;
  return {
    root,
    totalTests: graph.totalTests,
    sampledChanges: sampled.length,
    avgDirectRecall: Number((recallSum / n).toFixed(3)),
    avgTestsSelected: Number((selectedSum / n).toFixed(1)),
    avgReductionPct: Number((reductionSum / n).toFixed(3)),
    worstRecall,
    examples,
  };
}
