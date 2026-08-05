/**
 * CI test selection: turn a git ref range into a safe, runner-ready subset of
 * tests via the affected-tests reverse-import walk. The selection is only
 * worth shipping if it can never silently skip a test that would have failed,
 * so every input the graph cannot fully reason about downgrades to "run the
 * whole suite" with an explicit reason:
 *
 *   - a changed build/config/resource file (pom.xml, lockfiles, application.yml,
 *     Liquibase changelogs, CI workflows...) can affect ANY test;
 *   - a deleted source file's dependents cannot be traced in the head snapshot
 *     (the file is gone from the graph);
 *   - a changed file the index does not know and cannot classify as harmless;
 *   - a selection that hit the result cap (possibly truncated).
 *
 * Documentation-only changes are the deliberate exception: they select zero
 * tests WITHOUT triggering run-all — skipping the suite for a README edit is
 * exactly the payoff CI selection exists for.
 */
import type { CodeGraphDb } from '../storage/database.js';
import { runCheckedProcess } from '../infrastructure/process-runner.js';
import {
  findAffectedTests,
  type AffectedTestsOptions,
  type AffectedTestsResult,
} from './affected-tests.js';

export type CiSelectionFormat = 'json' | 'list' | 'maven' | 'gradle';

export interface CiSelectionOptions extends AffectedTestsOptions {
  baseRef: string;
  headRef?: string;
}

export interface ChangedFileStatus {
  status: string;
  path: string;
}

export interface CiSelectionResult extends AffectedTestsResult {
  baseRef: string;
  headRef: string;
  changedInput: ChangedFileStatus[];
  ignoredChanged: string[];
  runAll: boolean;
  runAllReasons: string[];
}

const GIT_DIFF_TIMEOUT_MS = 30_000;

/**
 * Changed files between merge-base(base, head) and head — `base...head`, the
 * same range a GitHub PR shows. Throws when git cannot answer: a selection
 * built from an unknown diff would be a guess, and CI must fall back to the
 * full suite via its own error handling, not silently run zero tests.
 */
export async function gitChangedFiles(root: string, baseRef: string, headRef = 'HEAD'): Promise<ChangedFileStatus[]> {
  const result = await runCheckedProcess('git', ['diff', '--name-status', '--no-renames', `${baseRef}...${headRef}`], {
    cwd: root,
    timeoutMs: GIT_DIFF_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  return result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [status, ...rest] = line.split(/\t/);
      return { status: (status ?? '').trim(), path: (rest[rest.length - 1] ?? '').trim().replace(/\\/g, '/') };
    })
    .filter(change => change.path.length > 0);
}

// Files whose change can invalidate ANY test: build definitions, dependency
// locks, runtime/CI configuration, container recipes, DB migrations. Matched
// against the repo-relative posix path.
const RUN_ALL_PATH_PATTERNS: RegExp[] = [
  /(^|\/)pom\.xml$/,
  /(^|\/)build\.gradle(\.kts)?$/,
  /(^|\/)settings\.gradle(\.kts)?$/,
  /(^|\/)gradle\.properties$/,
  /(^|\/)gradle\//,
  /(^|\/)mvnw(\.cmd)?$/,
  /(^|\/)\.mvn\//,
  /(^|\/)package(-lock)?\.json$/,
  /(^|\/)(yarn|pnpm-lock)\.(lock|yaml)$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)(vitest|jest|karma)\.config\.[^/]+$/,
  /^\.github\//,
  /(^|\/)Dockerfile[^/]*$/,
  /(^|\/)(docker-)?compose[^/]*\.ya?ml$/,
  /(^|\/)src\/main\/resources\//,
  /\.(sql|properties)$/,
];

// Changes that cannot affect test outcomes; they neither select tests nor
// force run-all. Deliberately narrow — anything not provably inert is treated
// as unknown, and unknown means run everything.
const IGNORABLE_PATH_PATTERNS: RegExp[] = [
  // CodeGraph's own index artifacts — indexing the workspace inside CI creates
  // these, and they can never affect the code under test.
  /(^|\/)\.codegraph(-[^/]*)?\//,
  /\.(md|markdown|adoc|txt)$/i,
  /^docs\//,
  /(^|\/)LICENSE[^/]*$/,
  /(^|\/)\.gitignore$/,
  /(^|\/)\.gitattributes$/,
  /(^|\/)\.editorconfig$/,
  /(^|\/)\.prettierrc[^/]*$/,
  /(^|\/)\.husky\//,
];

const matchesAny = (file: string, patterns: RegExp[]): boolean => patterns.some(p => p.test(file));

/** True when a changed path can never affect code under review or test. */
export function isIgnorableChangedPath(file: string): boolean {
  return matchesAny(file, IGNORABLE_PATH_PATTERNS);
}

/**
 * Select tests for a CI run over a git ref range. Indexing must already have
 * produced `snapshotId` for the HEAD state of `root`.
 */
export async function selectTestsForCi(
  db: CodeGraphDb,
  root: string,
  snapshotId: string,
  options: CiSelectionOptions,
): Promise<CiSelectionResult> {
  const headRef = options.headRef ?? 'HEAD';
  const changedInput = await gitChangedFiles(root, options.baseRef, headRef);
  return classifyAndSelect(db, snapshotId, changedInput, options, headRef);
}

/** Same selection over an explicit changed-file list (no git invocation). */
export async function selectTestsForChangedFiles(
  db: CodeGraphDb,
  snapshotId: string,
  changedInput: ChangedFileStatus[],
  options: AffectedTestsOptions & { baseRef?: string; headRef?: string } = {},
): Promise<CiSelectionResult> {
  return classifyAndSelect(db, snapshotId, changedInput, { baseRef: options.baseRef ?? '(explicit)', ...options }, options.headRef ?? 'HEAD');
}

async function classifyAndSelect(
  db: CodeGraphDb,
  snapshotId: string,
  changedInput: ChangedFileStatus[],
  options: CiSelectionOptions,
  headRef: string,
): Promise<CiSelectionResult> {
  const runAllReasons: string[] = [];
  const ignoredChanged: string[] = [];
  const traceable: string[] = [];

  const roleByPath = new Map<string, string>();
  if (changedInput.length > 0) {
    const placeholders = changedInput.map(() => '?').join(', ');
    const rows = await db.prepare(
      `SELECT path, file_role FROM files WHERE snapshot_id = ? AND path IN (${placeholders})`,
    ).all(snapshotId, ...changedInput.map(c => c.path)) as Array<{ path: string; file_role: string }>;
    for (const row of rows) roleByPath.set(row.path, row.file_role);
  }

  for (const change of changedInput) {
    const file = change.path;
    if (matchesAny(file, IGNORABLE_PATH_PATTERNS)) {
      ignoredChanged.push(file);
      continue;
    }
    if (change.status.startsWith('D')) {
      runAllReasons.push(`${file} was deleted — its dependents cannot be traced in the head snapshot`);
      continue;
    }
    const role = roleByPath.get(file);
    if (role === 'build_config' || role === 'resource_config') {
      runAllReasons.push(`${file} is ${role} — configuration can affect any test`);
      continue;
    }
    if (role === undefined && matchesAny(file, RUN_ALL_PATH_PATTERNS)) {
      runAllReasons.push(`${file} is build/config-like — configuration can affect any test`);
      continue;
    }
    if (role === undefined) {
      runAllReasons.push(`${file} is not in the index and cannot be classified as harmless`);
      continue;
    }
    if (matchesAny(file, RUN_ALL_PATH_PATTERNS)) {
      runAllReasons.push(`${file} is build/config-like — configuration can affect any test`);
      continue;
    }
    traceable.push(file);
  }

  const selection = await findAffectedTests(db, snapshotId, traceable, {
    maxDepth: options.maxDepth,
    limit: options.limit,
  });

  // Changed test files must run themselves even when nothing imports them.
  for (const file of traceable) {
    const role = roleByPath.get(file);
    if ((role === 'test_source' || role === 'mock_source') && !selection.tests.some(t => t.file === file)) {
      selection.tests.push({ file, distance: 0, via: file });
      selection.testCount = selection.tests.length;
    }
  }

  for (const file of selection.unresolvedChanged) {
    runAllReasons.push(`${file} is not in the index and cannot be traced`);
  }
  const limit = Math.max(1, options.limit ?? 200);
  if (selection.testCount >= limit) {
    runAllReasons.push(`selection hit the ${limit}-test cap and may be truncated`);
  }

  return {
    ...selection,
    baseRef: options.baseRef,
    headRef,
    changedInput,
    ignoredChanged,
    runAll: runAllReasons.length > 0,
    runAllReasons,
  };
}

const RUN_ALL_SENTINEL = 'ALL';

/** Placeholder passed to -Dtest/-Dit.test when a bucket is empty: with
 * failIfNoSpecifiedTests=false it matches nothing and runs nothing, which is
 * safer than omitting the property (an absent -Dit.test runs EVERY IT). */
const NONE_PLACEHOLDER = 'CodegraphNoneSelected';

const JAVA_TEST_PATH = /(?:^|\/)src\/test\/java\/(.+)\.java$/;

function javaClassName(testFile: string): string | undefined {
  const match = JAVA_TEST_PATH.exec(testFile.replace(/\\/g, '/'));
  return match ? match[1]!.replace(/\//g, '.') : undefined;
}

/**
 * Render a selection for a runner. Returns the exact string a CI script
 * should append to its test command; `ALL` means run the full suite.
 */
export function formatCiSelection(result: CiSelectionResult, format: CiSelectionFormat): string {
  if (format === 'json') return JSON.stringify(result, null, 2);
  if (result.runAll) return RUN_ALL_SENTINEL;
  if (format === 'list') return result.tests.map(t => t.file).join('\n');

  const classes = result.tests
    .map(t => javaClassName(t.file))
    .filter((name): name is string => name !== undefined);
  if (format === 'gradle') {
    return classes.map(name => `--tests ${name}`).join(' ');
  }
  // maven: split surefire (unit) vs failsafe (*IT) buckets so `verify` runs
  // exactly the selected classes in both plugins.
  const unit = classes.filter(name => !/IT$/.test(name));
  const integration = classes.filter(name => /IT$/.test(name));
  return [
    `-Dtest=${unit.length > 0 ? unit.join(',') : NONE_PLACEHOLDER}`,
    `-Dit.test=${integration.length > 0 ? integration.join(',') : NONE_PLACEHOLDER}`,
    '-Dsurefire.failIfNoSpecifiedTests=false',
    '-Dfailsafe.failIfNoSpecifiedTests=false',
  ].join(' ');
}
