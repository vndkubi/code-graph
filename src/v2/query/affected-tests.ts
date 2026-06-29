/**
 * Affected-tests selection (test-impact analysis). Given a set of changed files
 * (a diff), walk the REVERSE local-import graph to find the test files that
 * transitively depend on them, so CI can run a targeted subset instead of the
 * whole suite. Graph-native and precise in a way name/embedding proximity is
 * not: a test is "affected" only if there is an actual import path from it to a
 * changed file.
 *
 * Edges come from two sources, unioned:
 *  - the `imports` table (local, is_external = 0, relative specifiers resolved
 *    against the file set) — covers JS/TS where imports are relative paths;
 *  - the `dependency_edges` table (resolved file->file edges) — covers languages
 *    whose imports are NOT relative paths, above all Java/Kotlin where imports are
 *    package-qualified and flagged is_external (so the imports table alone yields
 *    an EMPTY graph and affected-tests returned 0 for every Java change).
 * Correct role classification is a prerequisite — see DERIVATION_LOGIC_VERSION in
 * the indexer, which forces a re-derive when that logic changes so this never
 * walks stale roles.
 */
import type { CodeGraphDb } from '../storage/database.js';
import path from 'node:path';

export interface AffectedTest {
  file: string;
  distance: number;
  via: string;
}

export interface AffectedTestsResult {
  changed: string[];
  unresolvedChanged: string[];
  tests: AffectedTest[];
  testCount: number;
  totalTests: number;
  reductionPct: number;
  depthReached: number;
}

export interface AffectedTestsOptions {
  maxDepth?: number;
  limit?: number;
}

export const TEST_ROLES = new Set(['test_source', 'mock_source']);

export interface ImportGraph {
  /** imported target path -> set of files that import it (reverse adjacency) */
  importers: Map<string, Set<string>>;
  roleByPath: Map<string, string>;
  allPaths: Set<string>;
  totalTests: number;
}

function resolveSpecifier(fromFile: string, spec: string, allPaths: Set<string>): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const baseDir = path.posix.dirname(fromFile.replace(/\\/g, '/'));
  const joined = path.posix.normalize(path.posix.join(baseDir, spec));
  const stripped = joined.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
  for (const cand of [
    joined, `${stripped}.ts`, `${stripped}.tsx`, `${stripped}.js`, `${stripped}.jsx`,
    `${stripped}/index.ts`, `${stripped}/index.tsx`, `${stripped}/index.js`,
  ]) {
    if (allPaths.has(cand)) return cand;
  }
  return undefined;
}

/** Build the reverse local-import graph once; shared by selection and eval. */
export async function buildImportGraph(db: CodeGraphDb, snapshotId: string): Promise<ImportGraph> {
  const fileRows = await db.prepare(
    'SELECT path, file_role FROM files WHERE snapshot_id = ?',
  ).all(snapshotId) as Array<{ path: string; file_role: string }>;
  const allPaths = new Set(fileRows.map(r => r.path));
  const roleByPath = new Map(fileRows.map(r => [r.path, r.file_role]));
  const totalTests = fileRows.filter(r => TEST_ROLES.has(r.file_role)).length;

  const importRows = await db.prepare(
    'SELECT file, source FROM imports WHERE snapshot_id = ? AND is_external = 0',
  ).all(snapshotId) as Array<{ file: string; source: string }>;
  const importers = new Map<string, Set<string>>();
  const addEdge = (target: string, importer: string): void => {
    if (!target || !importer || target === importer) return;
    if (!importers.has(target)) importers.set(target, new Set());
    importers.get(target)!.add(importer);
  };
  for (const row of importRows) {
    const target = resolveSpecifier(row.file, row.source, allPaths);
    if (target) addEdge(target, row.file);
  }

  // Resolved file->file edges (Java/Kotlin and any non-relative-import language).
  // from_file depends on to_file, so to_file's importer set gains from_file.
  const depRows = await db.prepare(
    'SELECT from_file, to_file FROM dependency_edges WHERE snapshot_id = ?',
  ).all(snapshotId) as Array<{ from_file: string; to_file: string }>;
  for (const row of depRows) {
    if (allPaths.has(row.from_file) && allPaths.has(row.to_file)) addEdge(row.to_file, row.from_file);
  }

  return { importers, roleByPath, allPaths, totalTests };
}

export async function findAffectedTests(
  db: CodeGraphDb,
  snapshotId: string,
  changedFiles: string[],
  options: AffectedTestsOptions = {},
): Promise<AffectedTestsResult> {
  const graph = await buildImportGraph(db, snapshotId);
  return selectAffectedTests(graph, changedFiles, options);
}

/** Pure selection over a prebuilt graph — lets callers reuse one graph build. */
export function selectAffectedTests(
  graph: ImportGraph,
  changedFiles: string[],
  options: AffectedTestsOptions = {},
): AffectedTestsResult {
  const maxDepth = Math.max(1, options.maxDepth ?? 4);
  const limit = Math.max(1, options.limit ?? 200);
  const { importers, roleByPath, allPaths, totalTests } = graph;

  const changed = changedFiles.map(f => f.replace(/\\/g, '/'));
  const resolvedChanged = changed.filter(f => allPaths.has(f));
  const unresolvedChanged = changed.filter(f => !allPaths.has(f));

  const affected = new Map<string, AffectedTest>();
  const visited = new Set<string>(resolvedChanged);
  let frontier = resolvedChanged;
  let depthReached = 0;
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const target of frontier) {
      for (const importer of importers.get(target) ?? []) {
        const role = roleByPath.get(importer) ?? 'main_source';
        if (TEST_ROLES.has(role)) {
          if (!affected.has(importer)) {
            affected.set(importer, { file: importer, distance: depth, via: target });
          }
        }
        if (!visited.has(importer)) {
          visited.add(importer);
          next.push(importer);
        }
      }
    }
    if (next.length > 0 || affected.size > 0) depthReached = depth;
    frontier = next;
  }

  const tests = [...affected.values()]
    .sort((a, b) => a.distance - b.distance || a.file.localeCompare(b.file))
    .slice(0, limit);

  return {
    changed: resolvedChanged,
    unresolvedChanged,
    tests,
    testCount: tests.length,
    totalTests,
    reductionPct: totalTests > 0 ? Number((1 - tests.length / totalTests).toFixed(3)) : 0,
    depthReached,
  };
}
