import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openCodeGraphDb } from '../storage/database.js';
import { V2Indexer } from '../index/indexer.js';
import {
  loadCodexE2eSuite,
  promptForMode,
  runCodexE2ePreflight,
  scoreCodexOutput,
  type CodexBenchmarkMode,
  type CodexE2ePreflightReport,
  type CodexE2eTask,
  type QualityScore,
} from './codex-e2e.js';

export interface ClaudeE2eBenchmarkOptions {
  suitePath?: string;
  root?: string;
  workspaceKey?: string;
  runDir?: string;
  models?: string[];
  modes?: CodexBenchmarkMode[];
  taskIds?: string[];
  parseWorkers?: number;
  claudeCommand?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  mcpLoadMode?: ClaudeMcpLoadMode;
  startupProfile?: ClaudeStartupProfile;
  mcpServerName?: string;
  mcpCommand?: string;
  mcpCommandArgs?: string[];
  timeoutSeconds?: number;
  skipIndex?: boolean;
  skipPreflight?: boolean;
  dryRun?: boolean;
}

export type ClaudeMcpLoadMode = 'eager' | 'lazy';
export type ClaudeStartupProfile = 'standard' | 'lean';

export interface ClaudeStreamMetrics {
  eventCount: number;
  mcpCalls: number;
  shellCalls: number;
  toolCalls: number;
  toolCallBreakdown: Record<string, number>;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  freshInputTokens: number;
  outputTokens: number;
  rawTotalTokens: number;
  freshTotalTokens: number;
  tokenSource: 'actual' | 'missing';
  finalOutput: string;
}

export interface ClaudeRunResult extends ClaudeStreamMetrics {
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

export interface ClaudeE2eBenchmarkReport {
  suite: string;
  root: string;
  workspaceKey: string;
  runDir: string;
  dryRun: boolean;
  preflight: CodexE2ePreflightReport;
  index?: {
    filesSeen: number;
    filesParsed: number;
    wallMs: number;
  };
  runs: ClaudeRunResult[];
  aggregate: {
    runs: number;
    totalWallMs: number;
    totalMcpCalls: number;
    totalShellCalls: number;
    totalRawTokens: number;
    totalFreshTokens: number;
    averageQuality: number;
  };
}

type ClaudeUsage = {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
};

const CLAUDE_SHELL_TOOLS = new Set(['Bash', 'Glob', 'Grep', 'Read', 'PowerShell']);

export async function runClaudeE2eBenchmark(options: ClaudeE2eBenchmarkOptions): Promise<ClaudeE2eBenchmarkReport> {
  const suite = loadCodexE2eSuite(options.suitePath);
  const root = path.resolve(options.root ?? suite.repoRoot ?? process.cwd());
  const workspaceKey = options.workspaceKey ?? suite.workspaceKey ?? stableWorkspaceKey(root);
  const runDir = path.resolve(options.runDir ?? path.join('.tmp', 'claude-e2e', timestampForPath()));
  const models = options.models?.length ? options.models : ['claude-sonnet-5'];
  const modes: CodexBenchmarkMode[] = options.modes?.length ? options.modes : ['baseline', 'mcp-first'];
  const tasks = filterTasks(suite.tasks, options.taskIds);
  const plannedRuns = models.length * modes.length * tasks.length;

  fs.mkdirSync(runDir, { recursive: true });
  writeJson(path.join(runDir, 'suite.resolved.json'), { ...suite, repoRoot: root, workspaceKey, tasks });

  let index: ClaudeE2eBenchmarkReport['index'];
  if (!options.skipIndex) {
    const started = Date.now();
    const { db } = await openCodeGraphDb(root);
    try {
      const result = await new V2Indexer(db).indexWorkspace({
        root,
        workspaceKey,
        parseWorkers: options.parseWorkers,
      });
      index = {
        filesSeen: result.filesTotal,
        filesParsed: result.filesParsed,
        wallMs: Date.now() - started,
      };
    } finally {
      await db.close();
    }
  }

  const preflight = options.skipPreflight
    ? skippedPreflight({ suiteName: suite.rootProfile?.name, root, workspaceKey, plannedRuns })
    : await runCodexE2ePreflight({ suite, root, workspaceKey, tasks, plannedRuns });

  const mcp = writeClaudeMcpConfigs({
    runDir,
    root,
    workspaceKey,
    serverName: options.mcpServerName ?? 'codegraph_bench',
    command: options.mcpCommand,
    args: options.mcpCommandArgs,
    loadMode: options.mcpLoadMode ?? 'eager',
  });
  writeJson(path.join(runDir, 'plan.json'), {
    root,
    workspaceKey,
    models,
    modes,
    tasks: tasks.map(task => task.id),
    mcpServerName: mcp.serverName,
    mcpCommand: mcp.command,
    mcpCommandArgs: mcp.args,
    mcpConfigPath: mcp.enabledPath,
    baselineMcpConfigPath: mcp.emptyPath,
    mcpLoadMode: options.mcpLoadMode ?? 'eager',
    startupProfile: options.startupProfile ?? 'standard',
    skipIndex: Boolean(options.skipIndex),
    dryRun: Boolean(options.dryRun),
    preflight,
  });

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

  const runs: ClaudeRunResult[] = [];
  for (const model of models) {
    for (const mode of modes) {
      for (const task of tasks) {
        runs.push(runClaudeTask({
          task,
          root,
          runDir,
          mode,
          model,
          effort: options.effort ?? 'low',
          startupProfile: options.startupProfile ?? 'standard',
          claudeCommand: options.claudeCommand ?? 'claude',
          mcpConfigPath: modeUsesMcp(mode) ? mcp.enabledPath : mcp.emptyPath,
          mcpServerName: mcp.serverName,
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

export function buildClaudePrintArgs(options: {
  model: string;
  mcpConfigPath: string;
  prompt: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  mcpServerName?: string;
  startupProfile?: ClaudeStartupProfile;
}): string[] {
  const serverName = options.mcpServerName ?? 'codegraph_bench';
  const allowedTools = [
    'Read',
    'Grep',
    'Glob',
    'Bash',
    'PowerShell',
    `mcp__${serverName}__codegraph_context`,
    `mcp__${serverName}__codegraph_slice`,
    `mcp__${serverName}__codegraph_status`,
  ].join(',');
  const args = [
    '--print',
    '--model',
    options.model,
    '--effort',
    options.effort ?? 'low',
    '--output-format',
    'stream-json',
    '--verbose',
  ];
  if (options.startupProfile === 'lean') {
    args.push(
      '--tools',
      'Read,Grep,Glob,Bash',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--prompt-suggestions',
      'false',
      '--exclude-dynamic-system-prompt-sections',
    );
  }
  args.push(
    '--strict-mcp-config',
    '--mcp-config',
    options.mcpConfigPath,
    '--setting-sources',
    'project',
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    allowedTools,
    '--disallowedTools',
    'Edit,Write,NotebookEdit',
    '--',
    options.prompt,
  );
  return args;
}

export function buildClaudeProcessEnv(
  startupProfile: ClaudeStartupProfile,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (startupProfile !== 'lean') return { ...baseEnv };
  return {
    ...baseEnv,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  };
}

export function buildClaudeMcpServerEntry(command: string, args: string[], loadMode: ClaudeMcpLoadMode = 'eager'): {
  type: 'stdio';
  command: string;
  args: string[];
  alwaysLoad?: true;
} {
  const entry: {
    type: 'stdio';
    command: string;
    args: string[];
    alwaysLoad?: true;
  } = {
    type: 'stdio',
    command,
    args,
  };
  if (loadMode === 'eager') entry.alwaysLoad = true;
  return entry;
}

export function parseClaudeStreamEvents(stdout: string): ClaudeStreamMetrics {
  const events = stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      try {
        const parsed = JSON.parse(line);
        return isRecord(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
  const toolIds = new Set<string>();
  const breakdown = new Map<string, number>();
  let mcpCalls = 0;
  let shellCalls = 0;
  let finalOutput = '';
  let usage: ClaudeUsage | undefined;

  for (const event of events) {
    if (event.type === 'assistant' && isRecord(event.message) && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (!isRecord(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') finalOutput = block.text;
        if (block.type !== 'tool_use' || typeof block.name !== 'string') continue;
        const id = typeof block.id === 'string' ? block.id : `${events.indexOf(event)}:${block.name}`;
        if (toolIds.has(id)) continue;
        toolIds.add(id);
        const normalized = normalizeClaudeToolName(block.name);
        breakdown.set(normalized, (breakdown.get(normalized) ?? 0) + 1);
        if (block.name.startsWith('mcp__')) mcpCalls++;
        if (CLAUDE_SHELL_TOOLS.has(block.name)) shellCalls++;
      }
    }
    if (event.type === 'result') {
      if (typeof event.result === 'string') finalOutput = event.result;
      if (isRecord(event.usage)) usage = event.usage as ClaudeUsage;
    }
  }

  const directInput = numberValue(usage?.input_tokens);
  const cacheCreation = numberValue(usage?.cache_creation_input_tokens);
  const cacheRead = numberValue(usage?.cache_read_input_tokens);
  const output = numberValue(usage?.output_tokens);
  const freshInput = directInput + cacheCreation;
  const rawInput = freshInput + cacheRead;
  return {
    eventCount: events.length,
    mcpCalls,
    shellCalls,
    toolCalls: toolIds.size,
    toolCallBreakdown: Object.fromEntries(breakdown.entries()),
    inputTokens: rawInput,
    cachedInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    freshInputTokens: freshInput,
    outputTokens: output,
    rawTotalTokens: rawInput + output,
    freshTotalTokens: freshInput + output,
    tokenSource: usage ? 'actual' : 'missing',
    finalOutput,
  };
}

function runClaudeTask(options: {
  task: CodexE2eTask;
  root: string;
  runDir: string;
  mode: CodexBenchmarkMode;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'max';
  startupProfile: ClaudeStartupProfile;
  claudeCommand: string;
  mcpConfigPath: string;
  mcpServerName: string;
  timeoutSeconds: number;
}): ClaudeRunResult {
  const prompt = promptForMode(options.task, options.mode);
  const taskDir = path.join(options.runDir, `${safePathPart(options.task.id)}-${options.mode}-${safePathPart(options.model)}`);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'prompt.txt'), prompt, 'utf-8');
  const args = buildClaudePrintArgs({
    model: options.model,
    effort: options.effort,
    mcpConfigPath: options.mcpConfigPath,
    mcpServerName: options.mcpServerName,
    startupProfile: options.startupProfile,
    prompt,
  });

  const started = Date.now();
  const result = spawnSync(options.claudeCommand, args, {
    cwd: options.root,
    env: buildClaudeProcessEnv(options.startupProfile),
    encoding: 'utf-8',
    timeout: options.timeoutSeconds * 1000,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  const wallMs = Date.now() - started;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? String(result.error ?? '');
  const outputPath = path.join(taskDir, 'claude.jsonl');
  const errorPath = path.join(taskDir, 'claude.stderr.txt');
  fs.writeFileSync(outputPath, stdout, 'utf-8');
  fs.writeFileSync(errorPath, stderr, 'utf-8');
  const parsed = parseClaudeStreamEvents(stdout);
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

function writeClaudeMcpConfigs(options: {
  runDir: string;
  root: string;
  workspaceKey: string;
  serverName: string;
  command?: string;
  args?: string[];
  loadMode: ClaudeMcpLoadMode;
}): {
  serverName: string;
  command: string;
  args: string[];
  enabledPath: string;
  emptyPath: string;
} {
  const defaultCli = path.join(options.root, 'dist', 'cli.js');
  const command = options.command ?? process.execPath;
  const args = options.command
    ? [...(options.args ?? [])]
    : [
      defaultCli,
      'mcp',
      '--root',
      options.root,
      '--workspace-key',
      options.workspaceKey,
      '--no-prewarm',
      '--mcp-profile',
      'client',
    ];
  const enabledPath = path.join(options.runDir, 'claude-mcp.json');
  const emptyPath = path.join(options.runDir, 'claude-empty-mcp.json');
  writeJson(enabledPath, {
    mcpServers: {
      [options.serverName]: buildClaudeMcpServerEntry(command, args, options.loadMode),
    },
  });
  writeJson(emptyPath, { mcpServers: {} });
  return { serverName: options.serverName, command, args, enabledPath, emptyPath };
}

function aggregateReport(input: Omit<ClaudeE2eBenchmarkReport, 'aggregate'>): ClaudeE2eBenchmarkReport {
  return {
    ...input,
    aggregate: {
      runs: input.runs.length,
      totalWallMs: input.runs.reduce((sum, run) => sum + run.wallMs, 0),
      totalMcpCalls: input.runs.reduce((sum, run) => sum + run.mcpCalls, 0),
      totalShellCalls: input.runs.reduce((sum, run) => sum + run.shellCalls, 0),
      totalRawTokens: input.runs.reduce((sum, run) => sum + run.rawTotalTokens, 0),
      totalFreshTokens: input.runs.reduce((sum, run) => sum + run.freshTotalTokens, 0),
      averageQuality: input.runs.length === 0
        ? 0
        : input.runs.reduce((sum, run) => sum + run.quality.score, 0) / input.runs.length,
    },
  };
}

function skippedPreflight(input: {
  suiteName?: string;
  root: string;
  workspaceKey: string;
  plannedRuns: number;
}): CodexE2ePreflightReport {
  return {
    status: 'passed',
    canRun: true,
    checkedAt: new Date().toISOString(),
    root: input.root,
    workspaceKey: input.workspaceKey,
    suiteRootProfile: input.suiteName,
    requiredFiles: [],
    requiredMethods: [],
    missingRequiredFiles: [],
    missingRequiredMethods: [],
    issues: [{
      code: 'preflight_skipped',
      severity: 'warning',
      message: 'Claude E2E preflight was explicitly skipped.',
    }],
    plannedRuns: input.plannedRuns,
    skippedRuns: 0,
  };
}

function modeUsesMcp(mode: CodexBenchmarkMode): boolean {
  return mode !== 'baseline' && mode !== 'terse-no-mcp';
}

function normalizeClaudeToolName(name: string): string {
  const parts = name.split('__');
  return name.startsWith('mcp__') && parts.length >= 3 ? parts.slice(2).join('__') : name;
}

function filterTasks(tasks: CodexE2eTask[], ids?: string[]): CodexE2eTask[] {
  if (!ids?.length) return tasks;
  const wanted = new Set(ids);
  const filtered = tasks.filter(task => wanted.has(task.id));
  if (filtered.length !== wanted.size) {
    const found = new Set(filtered.map(task => task.id));
    const missing = [...wanted].filter(id => !found.has(id));
    throw new Error(`Unknown Claude benchmark task id(s): ${missing.join(', ')}`);
  }
  return filtered;
}

function stableWorkspaceKey(root: string): string {
  return path.resolve(root).replaceAll('\\', '/');
}

function timestampForPath(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
