import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openCodeGraphDb, type CodeGraphDb } from '../storage/database.js';
import { V2Indexer, type IndexProgressEvent } from '../index/indexer.js';
import { resolveCurrentGraphSnapshot } from '../graph/export.js';
import { estimateTextTokens } from '../token-estimator.js';

export type CodexBenchmarkMode = 'baseline' | 'terse-no-mcp' | 'natural-tool-use' | 'mcp-first' | 'mcp-only' | 'mcp-scope' | 'mcp-phase-resume' | 'compiled-packet' | 'compiled-packet+gate' | 'oracle-packet';

export interface CodexE2eTask {
  id: string;
  title?: string;
  type?: string;
  prompt: string;
  expectedFiles?: string[];
  expectedMethods?: string[];
  expectedTerms?: string[];
  requiredAnswerFields?: string[];
  requireJson?: boolean;
}

export interface CodexE2eRootProfile {
  name?: string;
  requiredFiles?: string[];
  requiredMethods?: string[];
}

export interface CodexE2eSuite {
  name?: string;
  repoRoot?: string;
  workspaceKey?: string;
  rootProfile?: CodexE2eRootProfile;
  tasks: CodexE2eTask[];
}

export interface CodexE2eBenchmarkOptions {
  suitePath?: string;
  root?: string;
  workspaceKey?: string;
  runDir?: string;
  models?: string[];
  modes?: CodexBenchmarkMode[];
  taskIds?: string[];
  parseWorkers?: number;
  codexCommand?: string;
  codexCommandArgs?: string[];
  useUserConfig?: boolean;
  mcpServerName?: string;
  mcpCommand?: string;
  mcpCommandArgs?: string[];
  timeoutSeconds?: number;
  skipIndex?: boolean;
  skipPreflight?: boolean;
  dryRun?: boolean;
}

export interface CodexSpawnInvocation {
  command: string;
  args: string[];
}

export interface CodexJsonMetrics {
  eventCount: number;
  mcpCalls: number;
  shellCalls: number;
  toolCalls: number;
  toolCallBreakdown: Record<string, number>;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  tokenSource: 'actual' | 'estimated-chars' | 'missing';
  finalOutput: string;
  tokenLedger: CodexTokenLedger;
}

export interface CodexRunResult extends CodexJsonMetrics {
  taskId: string;
  mode: CodexBenchmarkMode;
  model: string;
  exitStatus: number | null;
  wallMs: number;
  prompt: string;
  outputPath: string;
  errorPath: string;
  quality: QualityScore;
}

export interface QualityScore {
  score: number;
  hits: string[];
  misses: string[];
}

export interface CodexTokenLedger {
  modelInputTokens: number;
  modelCachedInputTokens: number;
  modelFreshInputTokens: number;
  modelOutputTokens: number;
  modelReasoningTokens: number;
  modelRawTotalTokens: number;
  modelFreshTotalTokens: number;
  fullPacketTokens: number;
  compactPacketTokens: number;
  exactFollowupTokens: number;
  fallbackShellTokens: number;
  shellAfterExactFollowupTokens: number;
  shellAfterExactFollowupCalls: number;
  grossSavedTokens: number;
  netSavedTokens: number;
  budgetedMcpCalls: number;
  unbudgetedMcpCalls: number;
  firstBudgetedMcpTool?: string;
  source: 'budget-fields' | 'missing-budget';
}

export interface CodexE2ePreflightIssue {
  code: 'root_missing' | 'workspace_not_indexed' | 'missing_required_file' | 'missing_required_method' | 'missing_compatibility_contract' | 'preflight_skipped';
  severity: 'error' | 'warning';
  message: string;
  taskId?: string;
  expected?: string;
  matched?: string[];
  suggestions?: string[];
}

export interface CodexE2ePreflightReport {
  status: 'passed' | 'failed';
  canRun: boolean;
  checkedAt: string;
  root: string;
  workspaceKey: string;
  suiteRootProfile?: string;
  snapshot?: {
    workspaceId: string;
    snapshotId: string;
    files: number;
  };
  requiredFiles: Array<{
    expected: string;
    matched: string[];
  }>;
  requiredMethods: Array<{
    expected: string;
    matched: string[];
  }>;
  missingRequiredFiles: string[];
  missingRequiredMethods: string[];
  issues: CodexE2ePreflightIssue[];
  plannedRuns: number;
  skippedRuns: number;
}

export interface CodexE2eBenchmarkReport {
  suite: string;
  root: string;
  workspaceKey: string;
  runDir: string;
  dryRun: boolean;
  preflight: CodexE2ePreflightReport;
  index?: {
    result: Awaited<ReturnType<V2Indexer['indexWorkspace']>>;
    wallMs: number;
    phases: IndexProgressEvent[];
  };
  runs: CodexRunResult[];
  aggregate: {
    runs: number;
    totalWallMs: number;
    totalMcpCalls: number;
    totalShellCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    averageQuality: number;
    tokenLedger: {
      modelRawTotalTokens: number;
      modelFreshTotalTokens: number;
      fullPacketTokens: number;
      compactPacketTokens: number;
      exactFollowupTokens: number;
      fallbackShellTokens: number;
      shellAfterExactFollowupTokens: number;
      shellAfterExactFollowupCalls: number;
      grossSavedTokens: number;
      netSavedTokens: number;
      budgetedMcpCalls: number;
      unbudgetedMcpCalls: number;
    };
  };
}

const DEFAULT_CODEGRAPH_TOOLS = new Set([
  'codegraph_status',
  'codegraph_context',
  'codegraph_slice',
  'codegraph_checkpoint',
  'search_symbol',
  'search_files',
  'find_references',
  'get_file_summary',
  'get_file_slice',
  'get_dependencies',
  'get_dependents',
  'get_callers',
  'get_callees',
  'find_endpoints',
  'get_impact_radius',
  'trace_dependencies',
  'explain_endpoint',
  'impact_of_symbol',
  'simulate_patch_impact',
  'review_patch',
  'find_tests_for',
  'get_flow_pack',
  'get_research_pack',
  'get_context_packet',
  'get_change_pack',
  'compile_evidence',
  'search_code',
  'get_index_stats',
]);

const EXACT_SOURCE_FOLLOWUP_TOOLS = new Set([
  'codegraph_slice',
  'get_file_slice',
]);

const SHELL_TOOL_PATTERNS = [
  /shell/i,
  /command_execution/i,
  /powershell/i,
  /exec_command/i,
  /terminal/i,
  /read_file/i,
  /list_files/i,
  /grep/i,
  /^rg$/i,
];

type NormalizedMethodSpec = {
  raw: string;
  normalized: string;
};

type MethodMatchResult = {
  matches: string[];
  suggestions: string[];
};

export async function runCodexE2eBenchmark(options: CodexE2eBenchmarkOptions): Promise<CodexE2eBenchmarkReport> {
  const suite = loadCodexE2eSuite(options.suitePath);
  const root = path.resolve(options.root ?? suite.repoRoot ?? process.cwd());
  const workspaceKey = options.workspaceKey ?? suite.workspaceKey ?? stableWorkspaceKey(root);
  const runDir = path.resolve(options.runDir ?? path.join('.tmp', 'codex-e2e', timestampForPath()));
  const models = options.models?.length ? options.models : ['gpt-5.4-mini'];
  const modes: CodexBenchmarkMode[] = options.modes?.length ? options.modes : ['baseline', 'mcp-first'];
  const tasks = filterTasks(suite.tasks, options.taskIds);
  const plannedRuns = models.length * modes.length * tasks.length;

  fs.mkdirSync(runDir, { recursive: true });
  writeJson(path.join(runDir, 'suite.resolved.json'), { ...suite, repoRoot: root, workspaceKey, tasks });

  const index = options.skipIndex
    ? undefined
    : await runColdIndex(root, workspaceKey, options.parseWorkers);
  const preflight = options.skipPreflight
    ? skippedCodexE2ePreflight({ suite, root, workspaceKey, tasks, plannedRuns })
    : await runCodexE2ePreflight({
      suite,
      root,
      workspaceKey,
      tasks,
      plannedRuns,
    });
  const mcpConfig = writeCodexMcpConfig({
    runDir,
    root,
    workspaceKey,
    serverName: options.mcpServerName,
    command: options.mcpCommand,
    args: options.mcpCommandArgs,
  });
    const plan = {
      root,
      workspaceKey,
      models,
      modes,
      tasks: tasks.map(task => task.id),
      mcpServerName: mcpConfig.serverName,
      mcpConfigPath: mcpConfig.path,
      mcpCommand: mcpConfig.command,
      mcpCommandArgs: mcpConfig.args,
      skipIndex: Boolean(options.skipIndex),
      dryRun: Boolean(options.dryRun),
      preflight,
    };
    writeJson(path.join(runDir, 'plan.json'), plan);
    if (options.dryRun || !preflight.canRun) {
      const report = aggregateReport({
        suite: suite.name ?? path.basename(options.suitePath ?? 'inline-suite'),
        root,
        workspaceKey,
        runDir,
        dryRun: Boolean(options.dryRun),
        preflight,
        index,
        runs: [],
      });
      writeJson(path.join(runDir, 'report.json'), report);
      return report;
    }

    const runs: CodexRunResult[] = [];
    for (const model of models) {
      for (const mode of modes) {
        for (const task of tasks) {
          runs.push(runCodexTask({
            task,
            root,
            runDir,
            mode,
            model,
            mcpConfigPath: mcpConfig.path,
            mcpConfigOverrides: mcpConfig.overrides,
            codexCommand: options.codexCommand ?? 'codex',
            codexCommandArgs: options.codexCommandArgs ?? [],
            useUserConfig: options.useUserConfig ?? false,
            timeoutSeconds: options.timeoutSeconds ?? 900,
          }));
        }
      }
    }

    const report = aggregateReport({
      suite: suite.name ?? path.basename(options.suitePath ?? 'inline-suite'),
      root,
      workspaceKey,
      runDir,
      dryRun: false,
      preflight,
      index,
      runs,
    });
    writeJson(path.join(runDir, 'report.json'), report);
  return report;
}

export function loadCodexE2eSuite(suitePath?: string): CodexE2eSuite {
  if (!suitePath) return defaultHadoopSuite();
  const resolved = path.resolve(suitePath);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf-8')) as CodexE2eSuite;
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error(`Codex benchmark suite has no tasks: ${resolved}`);
  }
  return parsed;
}

function skippedCodexE2ePreflight(input: {
  suite: CodexE2eSuite;
  root: string;
  workspaceKey: string;
  tasks: CodexE2eTask[];
  plannedRuns: number;
}): CodexE2ePreflightReport {
  const requiredFiles = requiredFilesForPreflight(input.suite, input.tasks).map(expected => ({ expected, matched: [] }));
  const requiredMethods = requiredMethodsForPreflight(input.suite, input.tasks).map(spec => ({ expected: spec.raw, matched: [] }));
  return {
    status: 'passed',
    canRun: true,
    checkedAt: new Date().toISOString(),
    root: input.root,
    workspaceKey: input.workspaceKey,
    suiteRootProfile: input.suite.rootProfile?.name,
    requiredFiles,
    requiredMethods,
    missingRequiredFiles: [],
    missingRequiredMethods: [],
    issues: [{
      code: 'preflight_skipped',
      severity: 'warning',
      message: 'Codex E2E preflight was skipped because this run uses an external MCP server or an external index.',
    }],
    plannedRuns: input.plannedRuns,
    skippedRuns: 0,
  };
}

export async function runCodexE2ePreflight(options: {
  suite: CodexE2eSuite;
  root: string;
  workspaceKey: string;
  tasks: CodexE2eTask[];
  plannedRuns: number;
}): Promise<CodexE2ePreflightReport> {
  const issues: CodexE2ePreflightIssue[] = [];
  const root = path.resolve(options.root);
  const requiredFileSpecs = requiredFilesForPreflight(options.suite, options.tasks);
  const requiredMethodSpecs = requiredMethodsForPreflight(options.suite, options.tasks);
  const requiredFiles: CodexE2ePreflightReport['requiredFiles'] = requiredFileSpecs.map(expected => ({
    expected,
    matched: [],
  }));
  const requiredMethods: CodexE2ePreflightReport['requiredMethods'] = requiredMethodSpecs.map(expected => ({
    expected: expected.raw,
    matched: [],
  }));

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    issues.push({
      code: 'root_missing',
      severity: 'error',
      message: `Codex E2E root does not exist or is not a directory: ${root}`,
    });
    return finalizePreflight({
      root,
      workspaceKey: options.workspaceKey,
      suiteRootProfile: options.suite.rootProfile?.name,
      requiredFiles,
      requiredMethods,
      issues,
      plannedRuns: options.plannedRuns,
    });
  }

  if (!options.suite.rootProfile?.requiredFiles?.length &&
    !options.suite.rootProfile?.requiredMethods?.length &&
    requiredFileSpecs.length === 0 &&
    requiredMethodSpecs.length === 0) {
    issues.push({
      code: 'missing_compatibility_contract',
      severity: 'warning',
      message: 'Codex E2E suite has no rootProfile.requiredFiles/requiredMethods or task expectedFiles/expectedMethods, so root compatibility cannot be proven before a paid run.',
    });
  }

  const { db } = await openCodeGraphDb(root);
  try {
    const snapshot = await resolveCurrentGraphSnapshot(db, root, options.workspaceKey);
    if (!snapshot) {
      issues.push({
        code: 'workspace_not_indexed',
        severity: 'error',
        message: `Workspace key ${options.workspaceKey} has no current indexed snapshot for root ${root}. Run index/setup or omit --no-index.`,
      });
      return finalizePreflight({
        root,
        workspaceKey: options.workspaceKey,
        suiteRootProfile: options.suite.rootProfile?.name,
        requiredFiles,
        requiredMethods,
        issues,
        plannedRuns: options.plannedRuns,
      });
    }

    for (const entry of requiredFiles) {
      entry.matched = await matchIndexedFiles(db, snapshot.snapshotId, entry.expected);
      if (entry.matched.length === 0) {
        issues.push({
          code: 'missing_required_file',
          severity: 'error',
          message: `Required suite/task file was not found in the indexed snapshot: ${entry.expected}`,
          expected: entry.expected,
          matched: [],
        });
      }
    }
    for (const entry of requiredMethods) {
      const normalized = requiredMethodSpecs.find(spec => spec.raw === entry.expected)?.normalized ?? entry.expected;
      const methodMatch = await matchIndexedMethods(db, snapshot.snapshotId, normalized);
      entry.matched = methodMatch.matches;
      if (entry.matched.length === 0) {
        issues.push({
          code: 'missing_required_method',
          severity: 'error',
          message: `Required suite/task method was not found in the indexed snapshot: ${entry.expected}`,
          expected: entry.expected,
          matched: [],
          suggestions: methodMatch.suggestions,
        });
      }
    }

    const files = await db.scalar('SELECT COUNT(*) FROM files WHERE snapshot_id = ?', snapshot.snapshotId);
    return finalizePreflight({
      root,
      workspaceKey: options.workspaceKey,
      suiteRootProfile: options.suite.rootProfile?.name,
      snapshot: {
        workspaceId: snapshot.workspaceId,
        snapshotId: snapshot.snapshotId,
        files,
      },
      requiredFiles,
      requiredMethods,
      issues,
      plannedRuns: options.plannedRuns,
    });
  } finally {
    await db.close();
  }
}

export function parseCodexJsonEvents(jsonl: string, prompt = ''): CodexJsonMetrics {
  const toolCallIds = new Set<string>();
  const ledgeredToolResultIds = new Set<string>();
  const breakdown = new Map<string, number>();
  const ledger = createTokenLedgerAccumulator();
  let mcpCalls = 0;
  let shellCalls = 0;
  let eventCount = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let hasUsage = false;
  const finalChunks: string[] = [];

  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    eventCount++;

    const usage = findUsage(event);
    if (usage) {
      hasUsage = true;
      inputTokens = Math.max(inputTokens, usage.inputTokens);
      cachedInputTokens = Math.max(cachedInputTokens, usage.cachedInputTokens);
      outputTokens = Math.max(outputTokens, usage.outputTokens);
      reasoningTokens = Math.max(reasoningTokens, usage.reasoningTokens);
    }

    const text = extractAssistantText(event);
    if (text) finalChunks.push(text);

    const toolName = inferToolName(event);
    if (!toolName || !isToolEvent(event, toolName)) continue;
    const callId = inferToolCallId(event) ?? `${eventCount}:${toolName}`;
    const isMcpCall = DEFAULT_CODEGRAPH_TOOLS.has(toolName) || toolName.startsWith('codegraph.');
    const isShellCall = SHELL_TOOL_PATTERNS.some(pattern => pattern.test(toolName));
    if (!toolCallIds.has(callId)) {
      toolCallIds.add(callId);
      breakdown.set(toolName, (breakdown.get(toolName) ?? 0) + 1);
      if (isMcpCall) {
        mcpCalls++;
      } else if (isShellCall) {
        shellCalls++;
      }
    }

    const resultText = extractToolResultText(event);
    if (resultText && !ledgeredToolResultIds.has(callId)) {
      ledgeredToolResultIds.add(callId);
      if (isMcpCall) {
        recordMcpToolResult(ledger, toolName, resultText);
      } else if (isShellCall) {
        recordShellToolResult(ledger, resultText);
      }
    }
  }

  const finalOutput = finalChunks.join('\n').trim();
  if (!hasUsage && (prompt || finalOutput)) {
    return {
      eventCount,
      mcpCalls,
      shellCalls,
      toolCalls: toolCallIds.size,
      toolCallBreakdown: Object.fromEntries([...breakdown.entries()].sort()),
      inputTokens: estimateTokens(prompt),
      cachedInputTokens: 0,
      outputTokens: estimateTokens(finalOutput),
      reasoningTokens: 0,
      tokenSource: 'estimated-chars',
      finalOutput,
      tokenLedger: finalizeTokenLedger(ledger, {
        inputTokens: estimateTokens(prompt),
        cachedInputTokens: 0,
        outputTokens: estimateTokens(finalOutput),
        reasoningTokens: 0,
      }),
    };
  }

  return {
    eventCount,
    mcpCalls,
    shellCalls,
    toolCalls: toolCallIds.size,
    toolCallBreakdown: Object.fromEntries([...breakdown.entries()].sort()),
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    tokenSource: hasUsage ? 'actual' : 'missing',
    finalOutput,
    tokenLedger: finalizeTokenLedger(ledger, {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningTokens,
    }),
  };
}

export function scoreCodexOutput(task: CodexE2eTask, output: string): QualityScore {
  const haystack = output.toLowerCase();
  const parsedJson = task.requireJson ? extractJsonObject(output) : undefined;
  const expected = [
    ...(task.expectedFiles ?? []),
    ...(task.expectedMethods ?? []),
    ...(task.expectedTerms ?? []),
    ...(task.requireJson ? ['valid_json'] : []),
    ...(task.requiredAnswerFields ?? []),
  ];
  const hits: string[] = [];
  const misses: string[] = [];
  for (const item of expected) {
    if (item === 'valid_json') {
      if (parsedJson) hits.push(item);
      else misses.push(item);
      continue;
    }
    if (task.requireJson && task.requiredAnswerFields?.includes(item)) {
      if (parsedJson && Object.prototype.hasOwnProperty.call(parsedJson, item)) hits.push(item);
      else misses.push(item);
      continue;
    }
    const normalized = item.toLowerCase();
    if (haystack.includes(normalized) || haystack.includes(path.basename(normalized))) {
      hits.push(item);
    } else {
      misses.push(item);
    }
  }
  return {
    score: expected.length === 0 ? 1 : hits.length / expected.length,
    hits,
    misses,
  };
}

function finalizePreflight(input: {
  root: string;
  workspaceKey: string;
  suiteRootProfile?: string;
  snapshot?: CodexE2ePreflightReport['snapshot'];
  requiredFiles: CodexE2ePreflightReport['requiredFiles'];
  requiredMethods: CodexE2ePreflightReport['requiredMethods'];
  issues: CodexE2ePreflightIssue[];
  plannedRuns: number;
}): CodexE2ePreflightReport {
  const hasErrors = input.issues.some(issue => issue.severity === 'error');
  const missingRequiredFiles = input.requiredFiles
    .filter(entry => entry.matched.length === 0)
    .map(entry => entry.expected);
  const missingRequiredMethods = input.requiredMethods
    .filter(entry => entry.matched.length === 0)
    .map(entry => entry.expected);
  return {
    status: hasErrors ? 'failed' : 'passed',
    canRun: !hasErrors,
    checkedAt: new Date().toISOString(),
    root: input.root,
    workspaceKey: input.workspaceKey,
    suiteRootProfile: input.suiteRootProfile,
    snapshot: input.snapshot,
    requiredFiles: input.requiredFiles,
    requiredMethods: input.requiredMethods,
    missingRequiredFiles,
    missingRequiredMethods,
    issues: input.issues,
    plannedRuns: input.plannedRuns,
    skippedRuns: hasErrors ? input.plannedRuns : 0,
  };
}

function requiredFilesForPreflight(suite: CodexE2eSuite, tasks: CodexE2eTask[]): string[] {
  return uniqueStrings([
    ...(suite.rootProfile?.requiredFiles ?? []),
    ...tasks.flatMap(task => task.expectedFiles ?? []),
  ].map(normalizeFileSpec).filter(Boolean));
}

function requiredMethodsForPreflight(suite: CodexE2eSuite, tasks: CodexE2eTask[]): NormalizedMethodSpec[] {
  const seen = new Set<string>();
  const specs: NormalizedMethodSpec[] = [];
  for (const raw of [
    ...(suite.rootProfile?.requiredMethods ?? []),
    ...tasks.flatMap(task => task.expectedMethods ?? []),
  ]) {
    const normalized = normalizeMethodSpec(raw);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    specs.push({ raw, normalized });
  }
  return specs;
}

async function matchIndexedMethods(db: CodeGraphDb, snapshotId: string, expected: string): Promise<MethodMatchResult> {
  const method = normalizeMethodSpec(expected);
  if (!method) return { matches: [], suggestions: [] };
  const hasQualifier = method.includes('.') || method.includes('::');
  const simpleName = method.split(/[.#]/).at(-1) ?? method;
  const allMatches = new Map<string, string>();
  const addMatches = (rows: Array<{ file: string; kind: string }>) => {
    for (const row of rows) {
      allMatches.set(`${row.kind}:${row.file}`, `${row.kind}: ${row.file}`);
    }
  };

  if (hasQualifier) {
    const rowsByFqName = await db.prepare(`
      SELECT file, kind
      FROM symbols
      WHERE snapshot_id = ?
        AND lower(fq_name) = ?
      LIMIT 20
    `).all(snapshotId, method.toLowerCase()) as Array<{ file: string; kind: string }>;
    addMatches(rowsByFqName);
  }

  const rowsBySimpleName = await db.prepare(`
    SELECT file, kind
    FROM symbols
    WHERE snapshot_id = ?
      AND lower(simple_name) = ?
    LIMIT 20
  `).all(snapshotId, simpleName.toLowerCase()) as Array<{ file: string; kind: string }>;
  addMatches(rowsBySimpleName);

  const matches = [...allMatches.values()];
  if (matches.length > 0) {
    return { matches, suggestions: [] };
  }

  const suggestions = await findSimilarMethodCandidates(db, snapshotId, simpleName.toLowerCase());
  return { matches, suggestions };
}

function normalizeMethodSpec(value: string): string {
  const collapsed = value.trim().replace(/^["'`]|["'`]$/g, '').replace(/[;,]$/, '');
  const withoutSignature = collapsed.replace(/\([^)]*\)$/g, '');
  return withoutSignature.replace(/::/g, '.');
}

async function findSimilarMethodCandidates(db: CodeGraphDb, snapshotId: string, expected: string): Promise<string[]> {
  const trimmed = expected.trim().toLowerCase();
  if (trimmed.length < 3) return [];
  const seed = escapeLikePattern(trimmed.slice(0, 3));
  const rows = await db.prepare(`
    SELECT simple_name, fq_name, kind
    FROM symbols
    WHERE snapshot_id = ?
  `).all(snapshotId) as Array<{
    simple_name: string;
    fq_name: string;
    kind: string;
  }>;
  const scoreByLabel = new Map<string, number>();
  const seedLengthBudget = Math.max(3, Math.ceil(trimmed.length * 0.45));

  for (const row of rows) {
    const names = uniqueStrings([row.simple_name ?? '', row.fq_name ?? '']).filter(Boolean);
    for (const candidateName of names) {
      const candidate = candidateName.toLowerCase();
      if (!candidate.includes(seed)) continue;
      const distance = levenshteinDistance(trimmed, candidate);
      const maxDistance = Math.max(seedLengthBudget, Math.ceil(Math.max(trimmed.length, candidate.length) * 0.35));
      if (distance > maxDistance) continue;

      const label = `${row.kind}: ${row.fq_name || row.simple_name}`;
      const existing = scoreByLabel.get(label);
      if (existing === undefined || distance < existing) {
        scoreByLabel.set(label, distance);
      }
    }
  }

  return [...scoreByLabel.entries()]
    .sort((a, b) => (a[1] - b[1]) || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([label]) => label);
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const dp = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + cost,
      );
      prev = temp;
    }
  }
  return dp[b.length];
}

async function matchIndexedFiles(db: CodeGraphDb, snapshotId: string, expected: string): Promise<string[]> {
  const normalized = normalizeFileSpec(expected);
  if (!normalized) return [];
  const basename = path.posix.basename(normalized);
  const hasPath = normalized.includes('/');
  const rows = hasPath
    ? await db.prepare(`
      SELECT path
      FROM files
      WHERE snapshot_id = ?
        AND (path = ? OR path LIKE ? ESCAPE '\\')
      ORDER BY path
      LIMIT 5
    `).all(snapshotId, normalized, `%/${escapeLikePattern(normalized)}`) as Array<{ path: string }>
    : await db.prepare(`
      SELECT path
      FROM files
      WHERE snapshot_id = ?
        AND (path = ? OR path LIKE ? ESCAPE '\\')
      ORDER BY path
      LIMIT 5
    `).all(snapshotId, basename, `%/${escapeLikePattern(basename)}`) as Array<{ path: string }>;
  return rows.map(row => row.path);
}

function normalizeFileSpec(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function escapeLikePattern(value: string): string {
  return value.replace(/[%_]/g, char => `\\${char}`);
}

interface TokenLedgerAccumulator {
  fullPacketTokens: number;
  compactPacketTokens: number;
  exactFollowupTokens: number;
  fallbackShellTokens: number;
  shellAfterExactFollowupTokens: number;
  shellAfterExactFollowupCalls: number;
  grossSavedTokens: number;
  budgetedMcpCalls: number;
  unbudgetedMcpCalls: number;
  firstBudgetedMcpTool?: string;
  sawExactSourceFollowup: boolean;
}

interface ResponseBudgetObservation {
  responseTokens: number;
  fullResponseTokens: number;
}

function createTokenLedgerAccumulator(): TokenLedgerAccumulator {
  return {
    fullPacketTokens: 0,
    compactPacketTokens: 0,
    exactFollowupTokens: 0,
    fallbackShellTokens: 0,
    shellAfterExactFollowupTokens: 0,
    shellAfterExactFollowupCalls: 0,
    grossSavedTokens: 0,
    budgetedMcpCalls: 0,
    unbudgetedMcpCalls: 0,
    sawExactSourceFollowup: false,
  };
}

function recordMcpToolResult(ledger: TokenLedgerAccumulator, toolName: string, resultText: string): void {
  const isExactSourceFollowup = EXACT_SOURCE_FOLLOWUP_TOOLS.has(toolName);
  const budgets = extractResponseBudgetObservations(resultText);
  if (budgets.length === 0) {
    ledger.unbudgetedMcpCalls++;
    if (ledger.firstBudgetedMcpTool) ledger.exactFollowupTokens += estimateTokens(resultText);
    if (isExactSourceFollowup) ledger.sawExactSourceFollowup = true;
    return;
  }

  ledger.budgetedMcpCalls++;
  const responseTokens = budgets.reduce((sum, budget) => sum + budget.responseTokens, 0);
  const fullTokens = budgets.reduce((sum, budget) => sum + budget.fullResponseTokens, 0);
  ledger.grossSavedTokens += Math.max(0, fullTokens - responseTokens);

  if (!ledger.firstBudgetedMcpTool) {
    ledger.firstBudgetedMcpTool = toolName;
    ledger.fullPacketTokens += fullTokens;
    ledger.compactPacketTokens += responseTokens;
    return;
  }

  ledger.exactFollowupTokens += responseTokens;
  if (isExactSourceFollowup) ledger.sawExactSourceFollowup = true;
}

function recordShellToolResult(ledger: TokenLedgerAccumulator, resultText: string): void {
  const tokens = estimateTokens(resultText);
  ledger.fallbackShellTokens += tokens;
  if (ledger.sawExactSourceFollowup) {
    ledger.shellAfterExactFollowupTokens += tokens;
    ledger.shellAfterExactFollowupCalls++;
  }
}

function finalizeTokenLedger(
  ledger: TokenLedgerAccumulator,
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  },
): CodexTokenLedger {
  const modelFreshInputTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const netSavedTokens = ledger.fullPacketTokens
    - ledger.compactPacketTokens
    - ledger.exactFollowupTokens
    - ledger.fallbackShellTokens;
  return {
    modelInputTokens: usage.inputTokens,
    modelCachedInputTokens: usage.cachedInputTokens,
    modelFreshInputTokens,
    modelOutputTokens: usage.outputTokens,
    modelReasoningTokens: usage.reasoningTokens,
    modelRawTotalTokens: usage.inputTokens + usage.outputTokens + usage.reasoningTokens,
    modelFreshTotalTokens: modelFreshInputTokens + usage.outputTokens + usage.reasoningTokens,
    fullPacketTokens: ledger.fullPacketTokens,
    compactPacketTokens: ledger.compactPacketTokens,
    exactFollowupTokens: ledger.exactFollowupTokens,
    fallbackShellTokens: ledger.fallbackShellTokens,
    shellAfterExactFollowupTokens: ledger.shellAfterExactFollowupTokens,
    shellAfterExactFollowupCalls: ledger.shellAfterExactFollowupCalls,
    grossSavedTokens: ledger.grossSavedTokens,
    netSavedTokens,
    budgetedMcpCalls: ledger.budgetedMcpCalls,
    unbudgetedMcpCalls: ledger.unbudgetedMcpCalls,
    firstBudgetedMcpTool: ledger.firstBudgetedMcpTool,
    source: ledger.firstBudgetedMcpTool ? 'budget-fields' : 'missing-budget',
  };
}

function extractResponseBudgetObservations(text: string): ResponseBudgetObservation[] {
  const parsed = parseJsonText(text);
  if (!parsed) return [];
  const observations: ResponseBudgetObservation[] = [];
  collectResponseBudgetObservations(parsed, observations);
  return observations;
}

function collectResponseBudgetObservations(value: unknown, observations: ResponseBudgetObservation[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectResponseBudgetObservations(item, observations);
    return;
  }
  if (!isRecord(value)) return;

  const responseTokens = positiveNumber(value.estimatedResponseTokens);
  const fullResponseTokens = positiveNumber(value.estimatedFullResponseTokens);
  if (responseTokens !== undefined && fullResponseTokens !== undefined) {
    observations.push({
      responseTokens,
      fullResponseTokens: Math.max(fullResponseTokens, responseTokens),
    });
  }

  for (const child of Object.values(value)) collectResponseBudgetObservations(child, observations);
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function positiveNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function extractJsonObject(output: string): Record<string, unknown> | undefined {
  for (let start = output.indexOf('{'); start >= 0; start = output.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < output.length; index++) {
      const char = output[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') depth++;
      if (char === '}') depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(output.slice(start, index + 1));
          if (isRecord(parsed)) return parsed;
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

function runCodexTask(options: {
  task: CodexE2eTask;
  root: string;
  runDir: string;
  mode: CodexBenchmarkMode;
  model: string;
  mcpConfigPath: string;
  mcpConfigOverrides: string[];
  codexCommand: string;
  codexCommandArgs: string[];
  useUserConfig: boolean;
  timeoutSeconds: number;
}): CodexRunResult {
  const prompt = promptForMode(options.task, options.mode);
  const taskDir = path.join(options.runDir, `${safePathPart(options.task.id)}-${options.mode}-${safePathPart(options.model)}`);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'prompt.txt'), prompt, 'utf-8');

  const args = buildCodexExecArgs({
    model: options.model,
    useUserConfig: options.useUserConfig,
    mcpConfigOverrides: modeUsesMcp(options.mode) ? options.mcpConfigOverrides : [],
  });
  const env = { ...process.env };

  const started = Date.now();
  const invocation = buildCodexSpawnInvocation(options.codexCommand, [...options.codexCommandArgs, ...args]);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.root,
    env,
    encoding: 'utf-8',
    input: prompt,
    timeout: options.timeoutSeconds * 1000,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  const wallMs = Date.now() - started;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? String(result.error ?? '');
  const outputPath = path.join(taskDir, 'codex.jsonl');
  const errorPath = path.join(taskDir, 'codex.stderr.txt');
  fs.writeFileSync(outputPath, stdout, 'utf-8');
  fs.writeFileSync(errorPath, stderr, 'utf-8');

  const parsed = parseCodexJsonEvents(stdout, prompt);
  return {
    ...parsed,
    taskId: options.task.id,
    mode: options.mode,
    model: options.model,
    exitStatus: result.status,
    wallMs,
    prompt,
    outputPath,
    errorPath,
    quality: scoreCodexOutput(options.task, parsed.finalOutput),
  };
}

export function buildCodexSpawnInvocation(
  command: string,
  args: string[],
  platform: string = process.platform,
): CodexSpawnInvocation {
  const basename = path.basename(command.replace(/^["']|["']$/g, ''));
  const isWindows = platform === 'win32';
  const isCmdOrBat = /\.cmd$/i.test(basename) || /\.bat$/i.test(basename);
  if (!isWindows || !isCmdOrBat || /^cmd\.exe$/i.test(basename)) return { command, args };
  return {
    command: 'cmd.exe',
    args: ['/c', command, ...args],
  };
}

export function buildCodexExecArgs(options: {
  model: string;
  useUserConfig?: boolean;
  mcpConfigOverrides?: string[];
}): string[] {
  const args = [
    'exec',
    '--json',
    '--ephemeral',
  ];
  if (!options.useUserConfig) {
    args.push('--ignore-user-config');
  }
  args.push(
    '--ignore-rules',
    '--dangerously-bypass-approvals-and-sandbox',
    ...(options.mcpConfigOverrides ?? []),
    '--model',
    options.model,
    '-',
  );
  return args;
}

async function runColdIndex(
  root: string,
  workspaceKey: string,
  parseWorkers: number | undefined,
): Promise<NonNullable<CodexE2eBenchmarkReport['index']>> {
  const { db } = await openCodeGraphDb(root);
  const indexer = new V2Indexer(db);
  const phases: IndexProgressEvent[] = [];
  const started = Date.now();
  try {
    const result = await indexer.indexWorkspace({
      root,
      workspaceKey,
      parseWorkers,
      progress: event => phases.push(event),
    });
    return {
      result,
      wallMs: Date.now() - started,
      phases,
    };
  } finally {
    await db.close();
  }
}

function writeCodexMcpConfig(options: {
  runDir: string;
  root: string;
  workspaceKey: string;
  serverName?: string;
  command?: string;
  args?: string[];
}): { path: string; overrides: string[]; serverName: string; command: string; args: string[] } {
  const codexHome = path.join(options.runDir, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  const serverName = options.serverName ?? 'codegraph_bench';
  const cli = options.command
    ? { command: options.command, args: options.args ?? [] }
    : resolveCliEntrypoint();
  const args = options.command
    ? [...(options.args ?? [])]
    : [
      ...cli.args,
      'mcp',
      '--root',
      options.root,
      '--workspace-key',
      options.workspaceKey,
      '--no-prewarm',
    ];
  if (envFlag('CODEGRAPH_CODEX_BENCH_AUTO_REFRESH')) args.push('--auto-refresh');
  if (!options.command) args.push('--mcp-profile', 'full');
  const config = `[mcp_servers.${serverName}]
command = ${tomlString(cli.command)}
args = [
${args.map(arg => `  ${tomlString(arg)},`).join('\n')}
]
`;
  const configPath = path.join(codexHome, 'config.toml');
  fs.writeFileSync(configPath, config, 'utf-8');
  const overrides = [
    '--config',
    `mcp_servers.${serverName}.command=${tomlString(cli.command)}`,
    '--config',
    `mcp_servers.${serverName}.args=${tomlArray(args)}`,
  ];
  return { path: configPath, overrides, serverName, command: cli.command, args };
}

const POST_SLICE_STOP_RULE = 'After codegraph_slice/get_file_slice returns source, treat it as the terminal exact follow-up: do not call shell, do not call rg, do not call search/read tools, and answer from the returned slice plus prior packet.';

export function promptForMode(task: CodexE2eTask, mode: CodexBenchmarkMode): string {
  const prompt = task.prompt;
  switch (mode) {
    case 'baseline':
      return [
        'Do not use CodeGraph MCP. Use shell/search/read commands only if needed. Do not modify files.',
        prompt,
      ].join('\n\n');
    case 'terse-no-mcp':
      return [
        'Do not use CodeGraph MCP. Use shell/search/read commands only if needed. Be terse: answer with compact evidence-first JSON or bullets, avoid narration, and keep file/line/symbol names exact. Do not modify files.',
        prompt,
      ].join('\n\n');
    case 'natural-tool-use':
      return [
        'Answer as a senior engineer. Start from available project context before broad shell/search/read when possible. Use shell/search/read only when the available context is missing evidence. For implementation requests in this benchmark, return the smallest code and unit-test change plan instead of editing files. Keep the final answer compact and evidence-first.',
        prompt,
      ].join('\n\n');
    case 'mcp-only':
      return [
        'Use CodeGraph MCP server codegraph_bench only. Do not use shell/search/read fallback. Do not modify files.',
        POST_SLICE_STOP_RULE,
        prompt,
      ].join('\n\n');
    case 'mcp-first':
      return [
        'Use CodeGraph MCP server codegraph_bench first. Use shell/search/read only if CodeGraph evidence is missing. Do not modify files.',
        POST_SLICE_STOP_RULE,
        prompt,
      ].join('\n\n');
    case 'mcp-scope':
      return [
        'Use CodeGraph MCP server codegraph_bench first. Call codegraph_context with the task verbatim. If it returns answerable=false with recommendedNextAction=refine_scope_with_luna, fill scopePlan with one exact intent, target, candidate files, and requirements, then call codegraph_context once more. Do not broaden beyond the returned candidates or use shell/search/read fallback.',
        POST_SLICE_STOP_RULE,
        prompt,
      ].join('\n\n');
    case 'mcp-phase-resume':
      return [
        'Use CodeGraph MCP server codegraph_bench only. Start with codegraph_context, save a discovery or implementation checkpoint with codegraph_checkpoint, and resume only by the explicit taskId using a fresh codegraph_context call. Validate stale claims before answering; do not assume context from an earlier phase remains available.',
        POST_SLICE_STOP_RULE,
        prompt,
      ].join('\n\n');
    case 'compiled-packet':
      return [
        'Use CodeGraph MCP server codegraph_bench only for context acquisition. Start with compile_evidence using the full task, inferred task_type, budget_tokens=5000, and required answer fields as quality_rubric. If compile_evidence returns answerable=true, answer immediately from its evidence ids. If it is not answerable, use only allowedFollowups from the packet. Do not use shell/search/read fallback unless compile_evidence explicitly returns a shell allowedFollowup.',
        POST_SLICE_STOP_RULE,
        compiledPacketTaskHints(task, false),
        prompt,
      ].join('\n\n');
    case 'compiled-packet+gate':
      return [
        'Use CodeGraph MCP server codegraph_bench only. Hard gate: call compile_evidence first. When answerable=true, make zero additional tool calls and answer from the evidence packet. When answerable=false, make at most one listed allowedFollowup, then answer or report the missing rubric item. Do not use broad shell/search/read fallback.',
        POST_SLICE_STOP_RULE,
        compiledPacketTaskHints(task, false),
        prompt,
      ].join('\n\n');
    case 'oracle-packet':
      return [
        'Use CodeGraph MCP server codegraph_bench only. Call compile_evidence once with the full task, inferred task_type, budget_tokens=5000, and the provided oracle quality_rubric. Then answer only from that packet. Do not call any other tool unless compile_evidence says answerable=false and lists exactly one allowedFollowup.',
        POST_SLICE_STOP_RULE,
        compiledPacketTaskHints(task, true),
        prompt,
      ].join('\n\n');
  }
}

function modeUsesMcp(mode: CodexBenchmarkMode): boolean {
  return mode === 'natural-tool-use'
    || mode === 'mcp-first'
    || mode === 'mcp-only'
    || mode === 'mcp-scope'
    || mode === 'mcp-phase-resume'
    || mode === 'compiled-packet'
    || mode === 'compiled-packet+gate'
    || mode === 'oracle-packet';
}

function compiledPacketTaskHints(task: CodexE2eTask, includeOracleRubric: boolean): string {
  const taskType = compileBenchmarkTaskType(task);
  const rubric = includeOracleRubric
    ? [
      ...(task.expectedFiles ?? []).map(item => `file:${item}`),
      ...(task.expectedMethods ?? []).map(item => `method:${item}`),
      ...(task.expectedTerms ?? []).map(item => `term:${item}`),
      ...(task.requiredAnswerFields ?? []).map(item => `field:${item}`),
    ]
    : [
      ...(task.requiredAnswerFields ?? []).map(item => `field:${item}`),
      task.type ? `task:${task.type}` : undefined,
    ].filter((item): item is string => Boolean(item));
  return [
    `compile_evidence arguments hint: task_type=${taskType}`,
    rubric.length > 0 ? `quality_rubric=${JSON.stringify(rubric)}` : 'quality_rubric=<infer from task>',
  ].join('\n');
}

export function compileBenchmarkTaskType(task: CodexE2eTask): string {
  const type = String(task.type ?? '').toLowerCase();
  const prompt = task.prompt;
  if (type.includes('investigat')) return 'investigate';
  if (type.includes('review')) return 'review_diff';
  if (type.includes('api')) return 'api_flow';
  if (type.includes('field')) return 'field_impact';
  if (type.includes('startup')) return 'startup_flow';
  if (type.includes('test')) return 'test';
  if (type.includes('implement') || type.includes('debug') || type.includes('refactor')) return 'implement';
  if (/\bdiff\b|\bpatch\b|\breview\b/i.test(prompt)) return 'review_diff';
  if (/\b(GET|POST|PUT|PATCH|DELETE)\s+\//.test(prompt) || /\bendpoint|api|route\b/i.test(prompt)) return 'api_flow';
  if (/\bfield\b|\busages?\b|\binitialized\b/i.test(prompt)) return 'field_impact';
  if (/\bstartup|handshake|proxy|watchdog\b/i.test(prompt)) return 'startup_flow';
  if (/\bunit\s+test|testcase|write\s+tests?\b/i.test(prompt)) return 'test';
  if (/\bimplement|fix|debug|refactor\b/i.test(prompt)) return 'implement';
  return 'unknown';
}

function aggregateReport(input: Omit<CodexE2eBenchmarkReport, 'aggregate'>): CodexE2eBenchmarkReport {
  const totalWallMs = input.runs.reduce((sum, run) => sum + run.wallMs, 0);
  const totalMcpCalls = input.runs.reduce((sum, run) => sum + run.mcpCalls, 0);
  const totalShellCalls = input.runs.reduce((sum, run) => sum + run.shellCalls, 0);
  const totalInputTokens = input.runs.reduce((sum, run) => sum + run.inputTokens, 0);
  const totalOutputTokens = input.runs.reduce((sum, run) => sum + run.outputTokens, 0);
  const averageQuality = input.runs.length === 0
    ? 0
    : input.runs.reduce((sum, run) => sum + run.quality.score, 0) / input.runs.length;
  const tokenLedger = {
    modelRawTotalTokens: input.runs.reduce((sum, run) => sum + run.tokenLedger.modelRawTotalTokens, 0),
    modelFreshTotalTokens: input.runs.reduce((sum, run) => sum + run.tokenLedger.modelFreshTotalTokens, 0),
    fullPacketTokens: input.runs.reduce((sum, run) => sum + run.tokenLedger.fullPacketTokens, 0),
    compactPacketTokens: input.runs.reduce((sum, run) => sum + run.tokenLedger.compactPacketTokens, 0),
    exactFollowupTokens: input.runs.reduce((sum, run) => sum + run.tokenLedger.exactFollowupTokens, 0),
    fallbackShellTokens: input.runs.reduce((sum, run) => sum + run.tokenLedger.fallbackShellTokens, 0),
    shellAfterExactFollowupTokens: input.runs.reduce((sum, run) => sum + run.tokenLedger.shellAfterExactFollowupTokens, 0),
    shellAfterExactFollowupCalls: input.runs.reduce((sum, run) => sum + run.tokenLedger.shellAfterExactFollowupCalls, 0),
    grossSavedTokens: input.runs.reduce((sum, run) => sum + run.tokenLedger.grossSavedTokens, 0),
    netSavedTokens: input.runs.reduce((sum, run) => sum + run.tokenLedger.netSavedTokens, 0),
    budgetedMcpCalls: input.runs.reduce((sum, run) => sum + run.tokenLedger.budgetedMcpCalls, 0),
    unbudgetedMcpCalls: input.runs.reduce((sum, run) => sum + run.tokenLedger.unbudgetedMcpCalls, 0),
  };
  return {
    ...input,
    aggregate: {
      runs: input.runs.length,
      totalWallMs,
      totalMcpCalls,
      totalShellCalls,
      totalInputTokens,
      totalOutputTokens,
      averageQuality,
      tokenLedger,
    },
  };
}

function filterTasks(tasks: CodexE2eTask[], ids?: string[]): CodexE2eTask[] {
  if (!ids?.length) return tasks;
  const wanted = new Set(ids);
  const filtered = tasks.filter(task => wanted.has(task.id));
  if (filtered.length === 0) {
    throw new Error(`No Codex benchmark tasks matched: ${ids.join(', ')}`);
  }
  return filtered;
}

function defaultHadoopSuite(): CodexE2eSuite {
  return {
    name: 'hadoop-hard-tasks',
    repoRoot: '<hadoop-project>',
    workspaceKey: 'hadoop-project',
    rootProfile: {
      name: 'apache-hadoop-yarn-hdfs',
      requiredFiles: [
        'hadoop-yarn-project/hadoop-yarn/hadoop-yarn-server/hadoop-yarn-server-resourcemanager/src/main/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/RMWebServices.java',
        'hadoop-hdfs-project/hadoop-hdfs/src/main/java/org/apache/hadoop/hdfs/server/datanode/BlockReceiver.java',
      ],
      requiredMethods: ['getApps', 'withApplicationTags', 'getDataNode'],
    },
    tasks: [
      {
        id: 'api-flow-yarn-apps',
        type: 'api-flow',
        prompt: 'Trace the Hadoop YARN REST API GET /ws/v1/cluster/apps. Include handler, query parameters states/limit/applicationTags, request builder or service filtering, dependencies, and likely tests. Return compact JSON with keys task,keyFiles,methods,flow,dependencies,tests,risks,confidence.',
        expectedFiles: ['RMWebServices.java', 'TestRMWebServices.java'],
        expectedMethods: ['getApps', 'withApplicationTags'],
        expectedTerms: ['applicationTags', '/ws/v1/cluster/apps'],
        requiredAnswerFields: ['task', 'keyFiles', 'methods', 'flow', 'tests'],
      },
      {
        id: 'field-impact-blockreceiver-datanode',
        type: 'investigation',
        prompt: 'Investigate the impact of changing the Java field BlockReceiver.datanode. Where is it initialized, read, or used in methods/classes/flow? Include access kind when known, related calls/dependencies, review risks, and likely tests. Return compact JSON with keys task,field,definitions,usagesByMethod,flow,risks,tests,confidence.',
        expectedFiles: ['BlockReceiver.java', 'DataNode.java'],
        expectedMethods: ['getDataNode'],
        expectedTerms: ['datanode', 'read', 'init'],
        requiredAnswerFields: ['field', 'definitions', 'usagesByMethod', 'risks'],
      },
      {
        id: 'review-application-tags-diff',
        type: 'code-review',
        prompt: `Review this Hadoop patch for correctness and missing tests. Return compact JSON with keys status,topFindings,impactedFlow,tests,confidence. Cite repository-relative files.

diff --git a/hadoop-yarn-project/hadoop-yarn/hadoop-yarn-server/hadoop-yarn-server-resourcemanager/src/main/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/RMWebServices.java b/hadoop-yarn-project/hadoop-yarn/hadoop-yarn-server/hadoop-yarn-server-resourcemanager/src/main/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/RMWebServices.java
--- a/hadoop-yarn-project/hadoop-yarn/hadoop-yarn-server/hadoop-yarn-server-resourcemanager/src/main/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/RMWebServices.java
+++ b/hadoop-yarn-project/hadoop-yarn/hadoop-yarn-server/hadoop-yarn-server-resourcemanager/src/main/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/RMWebServices.java
@@
-                    .withApplicationTags(applicationTags)
+                    .withApplicationTags(java.util.Collections.emptySet())
                     .build();`,
        expectedFiles: ['RMWebServices.java'],
        expectedMethods: ['withApplicationTags', 'getApps'],
        expectedTerms: ['applicationTags', 'GET /ws/v1/cluster/apps', 'missing test'],
        requiredAnswerFields: ['status', 'topFindings', 'impactedFlow', 'tests'],
      },
    ],
  };
}

function findUsage(event: unknown): {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
} | undefined {
  const candidates = [
    pathValue(event, ['usage']),
    pathValue(event, ['data', 'usage']),
    pathValue(event, ['turn', 'usage']),
    pathValue(event, ['payload', 'usage']),
  ];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const inputTokens = numberValue(
      candidate.input_tokens,
      candidate.inputTokens,
      candidate.prompt_tokens,
      candidate.promptTokens,
      candidate.total_input_tokens,
    );
    const outputTokens = numberValue(
      candidate.output_tokens,
      candidate.outputTokens,
      candidate.completion_tokens,
      candidate.completionTokens,
      candidate.total_output_tokens,
    );
    const cachedInputTokens = numberValue(
      candidate.cached_input_tokens,
      candidate.cachedInputTokens,
      candidate.cache_read_input_tokens,
      candidate.cacheReadInputTokens,
    );
    const reasoningTokens = numberValue(
      candidate.reasoning_tokens,
      candidate.reasoningTokens,
      candidate.reasoning_output_tokens,
      candidate.reasoningOutputTokens,
      pathValue(candidate, ['output_tokens_details', 'reasoning_tokens']),
      pathValue(candidate, ['completion_tokens_details', 'reasoning_tokens']),
    );
    if (inputTokens || outputTokens || cachedInputTokens || reasoningTokens) {
      return { inputTokens, cachedInputTokens, outputTokens, reasoningTokens };
    }
  }
  return undefined;
}

function extractAssistantText(event: unknown): string | undefined {
  const type = String(pathValue(event, ['type']) ?? '').toLowerCase();
  const role = String(pathValue(event, ['role']) ?? pathValue(event, ['data', 'role']) ?? pathValue(event, ['message', 'role']) ?? '').toLowerCase();
  const itemType = String(pathValue(event, ['item', 'type']) ?? '').toLowerCase();
  if (type.includes('assistant') || role === 'assistant' || type === 'message' || itemType === 'agent_message') {
    const value = stringValue(
      pathValue(event, ['text']),
      pathValue(event, ['content']),
      pathValue(event, ['data', 'text']),
      pathValue(event, ['data', 'content']),
      pathValue(event, ['message', 'content']),
      pathValue(event, ['item', 'text']),
      pathValue(event, ['item', 'content']),
    );
    if (value) return value;
    const content = pathValue(event, ['data', 'message', 'content']) ?? pathValue(event, ['message', 'content']);
    const joined = contentArrayToText(content);
    if (joined) return joined;
  }
  return undefined;
}

function extractToolResultText(event: unknown): string | undefined {
  const result = pathValue(event, ['item', 'result'])
    ?? pathValue(event, ['data', 'result'])
    ?? pathValue(event, ['result']);
  if (!result) return undefined;
  if (typeof result === 'string') return result;

  const content = pathValue(result, ['content']);
  const contentText = contentArrayToText(content);
  if (contentText) return contentText;

  try {
    return JSON.stringify(result);
  } catch {
    return undefined;
  }
}

function inferToolName(event: unknown): string | undefined {
  const direct = stringValue(
    pathValue(event, ['tool_name']),
    pathValue(event, ['toolName']),
    pathValue(event, ['name']),
    pathValue(event, ['data', 'tool_name']),
    pathValue(event, ['data', 'toolName']),
    pathValue(event, ['data', 'name']),
    pathValue(event, ['item', 'tool_name']),
    pathValue(event, ['item', 'toolName']),
    pathValue(event, ['item', 'tool']),
    pathValue(event, ['item', 'name']),
  );
  if (!direct) {
    const itemType = stringValue(pathValue(event, ['item', 'type']));
    if (itemType === 'command_execution') return itemType;
    return undefined;
  }
  return direct.includes('.') ? direct.split('.').pop() : direct;
}

function inferToolCallId(event: unknown): string | undefined {
  return stringValue(
    pathValue(event, ['call_id']),
    pathValue(event, ['callId']),
    pathValue(event, ['id']),
    pathValue(event, ['data', 'call_id']),
    pathValue(event, ['data', 'callId']),
    pathValue(event, ['data', 'id']),
    pathValue(event, ['item', 'call_id']),
    pathValue(event, ['item', 'callId']),
    pathValue(event, ['item', 'id']),
  );
}

function isToolEvent(event: unknown, toolName: string): boolean {
  const haystack = [
    pathValue(event, ['type']),
    pathValue(event, ['data', 'type']),
    pathValue(event, ['item', 'type']),
    pathValue(event, ['item', 'server']),
    toolName,
  ].map(value => String(value ?? '').toLowerCase()).join(' ');
  return /tool|function|mcp|shell|exec|command/.test(haystack);
}

function contentArrayToText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const chunks = content
    .map(item => {
      if (typeof item === 'string') return item;
      return stringValue(pathValue(item, ['text']), pathValue(item, ['content']));
    })
    .filter((chunk): chunk is string => Boolean(chunk));
  return chunks.length ? chunks.join('\n') : undefined;
}

function pathValue(value: unknown, parts: string[]): unknown {
  let current = value;
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function numberValue(...values: unknown[]): number {
  for (const value of values) {
    const number = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function estimateTokens(text: string): number {
  return estimateTextTokens(text);
}

function envFlag(value: string | undefined): boolean {
  if (!value) return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function stableWorkspaceKey(root: string): string {
  return root.replace(/\\/g, '/');
}

function timestampForPath(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 80) || 'run';
}

function tomlString(value: string): string {
  return JSON.stringify(value.replace(/\\/g, '/'));
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function resolveCliEntrypoint(): { command: string; args: string[] } {
  const cwdDist = path.resolve(process.cwd(), 'dist', 'cli.js');
  if (fs.existsSync(cwdDist)) {
    return { command: 'node', args: [cwdDist] };
  }
  const cwdSource = path.resolve(process.cwd(), 'src', 'cli.ts');
  const cwdTsx = path.resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (fs.existsSync(cwdSource) && fs.existsSync(cwdTsx)) {
    return { command: 'node', args: [cwdTsx, cwdSource] };
  }

  const currentFile = fileURLToPath(import.meta.url);
  const distCli = path.resolve(path.dirname(currentFile), '..', '..', 'cli.js');
  if (fs.existsSync(distCli)) {
    return { command: 'node', args: [distCli] };
  }
  const sourceCli = path.resolve(path.dirname(currentFile), '..', '..', 'cli.ts');
  const sourceTsx = path.resolve(path.dirname(currentFile), '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return { command: 'node', args: [sourceTsx, sourceCli] };
}
