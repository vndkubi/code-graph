import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openCodeGraphDb } from '../storage/database.js';
import { V2Indexer, type IndexProgressEvent } from '../index/indexer.js';

export type CodexBenchmarkMode = 'baseline' | 'mcp-first' | 'mcp-only';

export interface CodexE2eTask {
  id: string;
  title?: string;
  type?: string;
  prompt: string;
  expectedFiles?: string[];
  expectedMethods?: string[];
  expectedTerms?: string[];
  requiredAnswerFields?: string[];
}

export interface CodexE2eSuite {
  name?: string;
  repoRoot?: string;
  workspaceKey?: string;
  tasks: CodexE2eTask[];
}

export interface CodexE2eBenchmarkOptions {
  suitePath?: string;
  root?: string;
  homeDir?: string;
  workspaceKey?: string;
  databaseUrl?: string;
  runDir?: string;
  models?: string[];
  modes?: CodexBenchmarkMode[];
  taskIds?: string[];
  parseWorkers?: number;
  codexCommand?: string;
  codexCommandArgs?: string[];
  timeoutSeconds?: number;
  skipIndex?: boolean;
  dryRun?: boolean;
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

export interface CodexE2eBenchmarkReport {
  suite: string;
  root: string;
  workspaceKey: string;
  runDir: string;
  dryRun: boolean;
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
  };
}

const DEFAULT_CODEGRAPH_TOOLS = new Set([
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
  'search_code',
  'get_index_stats',
]);

const SHELL_TOOL_PATTERNS = [
  /shell/i,
  /powershell/i,
  /exec_command/i,
  /terminal/i,
  /read_file/i,
  /list_files/i,
  /grep/i,
  /^rg$/i,
];

export async function runCodexE2eBenchmark(options: CodexE2eBenchmarkOptions): Promise<CodexE2eBenchmarkReport> {
  const suite = loadCodexE2eSuite(options.suitePath);
  const root = path.resolve(options.root ?? suite.repoRoot ?? process.cwd());
  const workspaceKey = options.workspaceKey ?? suite.workspaceKey ?? stableWorkspaceKey(root);
  const runDir = path.resolve(options.runDir ?? path.join('.tmp', 'codex-e2e', timestampForPath()));
  const models = options.models?.length ? options.models : ['gpt-5.4-mini'];
  const modes: CodexBenchmarkMode[] = options.modes?.length ? options.modes : ['baseline', 'mcp-first'];
  const tasks = filterTasks(suite.tasks, options.taskIds);

  fs.mkdirSync(runDir, { recursive: true });
  writeJson(path.join(runDir, 'suite.resolved.json'), { ...suite, repoRoot: root, workspaceKey, tasks });

  const envBefore = process.env.CODEGRAPH_DATABASE_URL;
  if (options.databaseUrl) process.env.CODEGRAPH_DATABASE_URL = options.databaseUrl;
  try {
    const index = options.skipIndex
      ? undefined
      : await runColdIndex(root, workspaceKey, options.homeDir, options.parseWorkers);
    const mcpConfig = writeCodexMcpConfig({
      runDir,
      root,
      workspaceKey,
      homeDir: options.homeDir,
      databaseUrl: options.databaseUrl,
    });
    const plan = {
      root,
      workspaceKey,
      models,
      modes,
      tasks: tasks.map(task => task.id),
      mcpConfigPath: mcpConfig.path,
      skipIndex: Boolean(options.skipIndex),
      dryRun: Boolean(options.dryRun),
    };
    writeJson(path.join(runDir, 'plan.json'), plan);
    if (options.dryRun) {
      const report = aggregateReport({
        suite: suite.name ?? path.basename(options.suitePath ?? 'inline-suite'),
        root,
        workspaceKey,
        runDir,
        dryRun: true,
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
      index,
      runs,
    });
    writeJson(path.join(runDir, 'report.json'), report);
    return report;
  } finally {
    if (envBefore === undefined) {
      delete process.env.CODEGRAPH_DATABASE_URL;
    } else {
      process.env.CODEGRAPH_DATABASE_URL = envBefore;
    }
  }
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

export function parseCodexJsonEvents(jsonl: string, prompt = ''): CodexJsonMetrics {
  const toolCallIds = new Set<string>();
  const breakdown = new Map<string, number>();
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
    if (toolCallIds.has(callId)) continue;
    toolCallIds.add(callId);
    breakdown.set(toolName, (breakdown.get(toolName) ?? 0) + 1);
    if (DEFAULT_CODEGRAPH_TOOLS.has(toolName) || toolName.startsWith('codegraph.')) {
      mcpCalls++;
    } else if (SHELL_TOOL_PATTERNS.some(pattern => pattern.test(toolName))) {
      shellCalls++;
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
  };
}

export function scoreCodexOutput(task: CodexE2eTask, output: string): QualityScore {
  const haystack = output.toLowerCase();
  const expected = [
    ...(task.expectedFiles ?? []),
    ...(task.expectedMethods ?? []),
    ...(task.expectedTerms ?? []),
    ...(task.requiredAnswerFields ?? []),
  ];
  const hits: string[] = [];
  const misses: string[] = [];
  for (const item of expected) {
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
  timeoutSeconds: number;
}): CodexRunResult {
  const prompt = promptForMode(options.task.prompt, options.mode);
  const taskDir = path.join(options.runDir, `${safePathPart(options.task.id)}-${options.mode}-${safePathPart(options.model)}`);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'prompt.txt'), prompt, 'utf-8');

  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--dangerously-bypass-approvals-and-sandbox',
    '--model',
    options.model,
    '-',
  ];
  const env = { ...process.env };
  if (options.mode !== 'baseline') {
    args.splice(args.indexOf('--model'), 0, ...options.mcpConfigOverrides);
  }

  const started = Date.now();
  const result = spawnSync(options.codexCommand, [...options.codexCommandArgs, ...args], {
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

async function runColdIndex(
  root: string,
  workspaceKey: string,
  homeDir: string | undefined,
  parseWorkers: number | undefined,
): Promise<NonNullable<CodexE2eBenchmarkReport['index']>> {
  const { db } = await openCodeGraphDb(homeDir);
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
  homeDir?: string;
  databaseUrl?: string;
}): { path: string; overrides: string[] } {
  const codexHome = path.join(options.runDir, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  const cli = resolveCliEntrypoint();
  const args = [
    ...cli.args,
    'mcp',
    '--root',
    options.root,
    '--workspace-key',
    options.workspaceKey,
    '--no-prewarm',
  ];
  if (envFlag('CODEGRAPH_CODEX_BENCH_AUTO_REFRESH')) args.push('--auto-refresh');
  if (options.homeDir) args.push('--home', path.resolve(options.homeDir));
  const envObject = options.databaseUrl
    ? { CODEGRAPH_DATABASE_URL: options.databaseUrl, CODEGRAPH_QUERY_FRESHNESS_CACHE_MS: '30000' }
    : undefined;
  const envEntries = envObject
    ? `\nenv = ${tomlInlineObject(envObject)}\n`
    : '\n';
  const config = `[mcp_servers.codegraph_bench]
command = ${tomlString(cli.command)}
args = [
${args.map(arg => `  ${tomlString(arg)},`).join('\n')}
]
${envEntries}`;
  const configPath = path.join(codexHome, 'config.toml');
  fs.writeFileSync(configPath, config, 'utf-8');
  const overrides = [
    '--config',
    `mcp_servers.codegraph_bench.command=${tomlString(cli.command)}`,
    '--config',
    `mcp_servers.codegraph_bench.args=${tomlArray(args)}`,
  ];
  if (envObject) {
    overrides.push(
      '--config',
      `mcp_servers.codegraph_bench.env=${tomlInlineObject(envObject)}`,
    );
  }
  return { path: configPath, overrides };
}

function promptForMode(prompt: string, mode: CodexBenchmarkMode): string {
  switch (mode) {
    case 'baseline':
      return [
        'Do not use CodeGraph MCP. Use shell/search/read commands only if needed. Do not modify files.',
        prompt,
      ].join('\n\n');
    case 'mcp-only':
      return [
        'Use CodeGraph MCP server codegraph_bench only. Do not use shell/search/read fallback. Do not modify files.',
        prompt,
      ].join('\n\n');
    case 'mcp-first':
      return [
        'Use CodeGraph MCP server codegraph_bench first. Use shell/search/read only if CodeGraph evidence is missing. Do not modify files.',
        prompt,
      ].join('\n\n');
  }
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
  if (!direct) return undefined;
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
  return Math.ceil(text.length / 4);
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

function tomlInlineObject(values: Record<string, string>): string {
  return `{ ${Object.entries(values).map(([key, value]) => `${key} = ${tomlString(value)}`).join(', ')} }`;
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
