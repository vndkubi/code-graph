#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openCodeGraphDb } from './v2/storage/database.js';
import { V2Indexer, type IndexProgressEvent } from './v2/index/indexer.js';
import { V2QueryService } from './v2/query/service.js';
import { inspectCodeGraphRoute, runMcpProxy } from './v2/mcp/proxy.js';
import { getWorkspacePaths } from './v2/paths.js';
import { generateSyntheticJavaRepo } from './v2/benchmark/synthetic-java.js';
import { runIndexBenchmark } from './v2/benchmark/run.js';
import { loadGoldenEvalTasks, runGoldenEval } from './v2/benchmark/golden-eval.js';
import { deriveContextProofTasks, loadContextProofTasks, runContextProofEval } from './v2/benchmark/context-proof.js';
import { runLocalFallbackBenchmark } from './v2/benchmark/local-fallback.js';
import { deriveReviewProofTasks, loadReviewProofTasks, runReviewProofEval } from './v2/benchmark/review-proof.js';
import { runCodexE2eBenchmark, type CodexBenchmarkMode } from './v2/benchmark/codex-e2e.js';
import { compareCodexE2eReports, formatCompetitiveComparisonMarkdown } from './v2/benchmark/competitive-compare.js';
import { runRouteGateBenchmark } from './v2/benchmark/route-gate.js';
import { buildGraphExport, renderGraphHtml, resolveCurrentGraphSnapshot } from './v2/graph/export.js';
import { buildLocalArtifactIndex } from './v2/mcp/local-artifact.js';
import { inspectWorkspaceReadiness } from './v2/workspace-health.js';

interface ParsedArgs {
  command: string[];
  flags: Map<string, string | boolean>;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const [command, subcommand] = parsed.command;

  switch (command) {
    case 'mcp':
      await runMcpProxy({
        root: getFlag(parsed, 'root') ?? process.cwd(),
        prewarm: parsed.flags.get('no-prewarm') === true
          ? false
          : parsed.flags.get('prewarm') === true || envFlag('CODEGRAPH_MCP_PREWARM') || undefined,
        refreshOnStart: parsed.flags.get('refresh-on-start') === true || envFlag('CODEGRAPH_REFRESH_ON_START'),
        workspaceKey: getFlag(parsed, 'workspace-key') ?? process.env.CODEGRAPH_WORKSPACE_KEY,
        autoRefresh: parsed.flags.get('auto-refresh') === true || envFlag('CODEGRAPH_AUTO_REFRESH'),
        watch: parsed.flags.get('watch') === true || envFlag('CODEGRAPH_WATCH'),
        warnStale: parsed.flags.get('warn-stale') === true || envFlag('CODEGRAPH_WARN_STALE'),
        indexProviders: indexProvidersFlag(parsed),
        scipIndexPath: scipIndexFlag(parsed),
        mcpProfile: getFlag(parsed, 'mcp-profile') ?? process.env.CODEGRAPH_MCP_PROFILE,
      });
      return;
    case 'setup':
      await runSetupCommand(parsed);
      return;
    case 'index':
      await runIndexCommand(parsed);
      return;
    case 'atlas':
      await runAtlasCommand(parsed);
      return;
    case 'graph':
      await runGraphCommand(parsed);
      return;
    case 'doctor':
      await runDoctorCommand(parsed);
      return;
    case 'status':
      await runStatusCommand(parsed);
      return;
    case 'upgrade-audit':
      await runUpgradeAuditCommand(parsed);
      return;
    case 'logs':
      await runLogsCommand(parsed);
      return;
    case 'route-inspect':
      runRouteInspectCommand(parsed);
      return;
    case 'benchmark':
      await runBenchmarkCommand(subcommand, parsed);
      return;
    case 'help':
    case undefined:
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function runBenchmarkCommand(subcommand: string | undefined, parsed: ParsedArgs): Promise<void> {
  switch (subcommand) {
    case 'generate': {
      const root = getFlag(parsed, 'root') ?? './synthetic-java';
      const files = getNumberFlag(parsed, 'files') ?? 10_000;
      const modules = getNumberFlag(parsed, 'modules');
      console.log(JSON.stringify(generateSyntheticJavaRepo({ root, files, modules }), null, 2));
      return;
    }
    case 'index': {
      const root = getFlag(parsed, 'root') ?? process.cwd();
      console.log(JSON.stringify(await runIndexBenchmark(root, {
        indexProviders: indexProvidersFlag(parsed),
        scipIndexPath: scipIndexFlag(parsed),
      }), null, 2));
      return;
    }
    case 'eval': {
      const root = getFlag(parsed, 'root') ?? process.cwd();
      const { db } = await openCodeGraphDb(root);
      try {
        const tasks = loadGoldenEvalTasks(getFlag(parsed, 'tasks'));
        console.log(JSON.stringify(await runGoldenEval(db, root, tasks), null, 2));
      } finally {
        await db.close();
      }
      return;
    }
    case 'proof': {
      const root = getFlag(parsed, 'root') ?? process.cwd();
      const { db } = await openCodeGraphDb(root);
      try {
        const tasks = shouldUseAutoTasks(parsed)
          ? deriveContextProofTasks(root, { limit: getNumberFlag(parsed, 'task-count') })
          : loadContextProofTasks(getFlag(parsed, 'tasks'));
        console.log(JSON.stringify(await runContextProofEval(db, root, tasks, {
          skipIndex: parsed.flags.get('no-index') === true,
        }), null, 2));
      } finally {
        await db.close();
      }
      return;
    }
    case 'review': {
      const root = getFlag(parsed, 'root') ?? process.cwd();
      const { db } = await openCodeGraphDb(root);
      try {
        const tasks = shouldUseAutoTasks(parsed)
          ? deriveReviewProofTasks(root, { limit: getNumberFlag(parsed, 'task-count') })
          : loadReviewProofTasks(getFlag(parsed, 'tasks'));
        console.log(JSON.stringify(await runReviewProofEval(db, root, tasks, {
          skipIndex: parsed.flags.get('no-index') === true,
        }), null, 2));
      } finally {
        await db.close();
      }
      return;
    }
    case 'fallback': {
      const root = getFlag(parsed, 'root') ?? process.cwd();
      const tasks = shouldUseAutoTasks(parsed)
        ? deriveContextProofTasks(root, { limit: getNumberFlag(parsed, 'task-count') })
        : loadContextProofTasks(getFlag(parsed, 'tasks'));
      console.log(JSON.stringify(await runLocalFallbackBenchmark(root, tasks), null, 2));
      return;
    }
    case 'route-gate':
      console.log(JSON.stringify(runRouteGateBenchmark(getFlag(parsed, 'suite') ?? getFlag(parsed, 'tasks')), null, 2));
      return;
    case 'copilot-e2e':
      runCopilotE2eBenchmark(parsed);
      return;
    case 'codex-e2e':
      console.log(JSON.stringify(await runCodexE2eBenchmark({
        suitePath: getFlag(parsed, 'suite') ?? getFlag(parsed, 'tasks'),
        root: getFlag(parsed, 'root'),
        workspaceKey: getFlag(parsed, 'workspace-key') ?? process.env.CODEGRAPH_WORKSPACE_KEY,
        runDir: getFlag(parsed, 'run-dir'),
        models: splitCsv(getFlag(parsed, 'models')),
        modes: splitCodexModes(getFlag(parsed, 'modes')),
        taskIds: splitCsv(getFlag(parsed, 'task-ids') ?? getFlag(parsed, 'task')),
        parseWorkers: getNumberFlag(parsed, 'parse-workers'),
        codexCommand: getFlag(parsed, 'codex-command'),
        codexCommandArgs: splitCsv(getFlag(parsed, 'codex-command-args')),
        useUserConfig: parsed.flags.get('use-user-config') === true,
        mcpServerName: getFlag(parsed, 'mcp-server-name'),
        mcpCommand: getFlag(parsed, 'mcp-command'),
        mcpCommandArgs: splitCsv(getFlag(parsed, 'mcp-command-args')),
        timeoutSeconds: getNumberFlag(parsed, 'codex-timeout-seconds'),
        skipIndex: parsed.flags.get('no-index') === true,
        skipPreflight: parsed.flags.get('skip-preflight') === true,
        dryRun: parsed.flags.get('dry-run') === true,
      }), null, 2));
      return;
    case 'competitive-compare':
      const comparison = compareCodexE2eReports({
        oursPath: requiredFlag(parsed, 'ours'),
        theirsPath: requiredFlag(parsed, 'theirs'),
        oursLabel: getFlag(parsed, 'ours-label'),
        theirsLabel: getFlag(parsed, 'theirs-label'),
      });
      if (getFlag(parsed, 'format') === 'markdown') {
        console.log(formatCompetitiveComparisonMarkdown(comparison));
      } else {
        console.log(JSON.stringify(comparison, null, 2));
      }
      return;
    default:
      throw new Error('Usage: codegraph benchmark generate|index|eval|proof|review|fallback|route-gate|copilot-e2e|codex-e2e|competitive-compare');
  }
}

function runCopilotE2eBenchmark(parsed: ParsedArgs): void {
  const scriptPath = path.resolve(getFlag(parsed, 'script') ?? path.join(projectRootForCli(), 'examples', 'copilot-e2e-quality-bench.ps1'));
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Copilot E2E benchmark script not found: ${scriptPath}`);
  }

  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
  ];
  appendPowerShellFlag(args, '-SuitePath', getFlag(parsed, 'suite') ?? getFlag(parsed, 'tasks'));
  appendPowerShellFlag(args, '-RunDir', getFlag(parsed, 'run-dir'));
  appendPowerShellFlag(args, '-CodeGraphRoot', getFlag(parsed, 'codegraph-root') ?? projectRootForCli());
  appendPowerShellFlag(args, '-Models', getFlag(parsed, 'models'));
  appendPowerShellFlag(args, '-TaskIds', getFlag(parsed, 'task-ids') ?? getFlag(parsed, 'task'));
  appendPowerShellFlag(args, '-Modes', getFlag(parsed, 'modes'));
  appendPowerShellFlag(args, '-ParseWorkers', getFlag(parsed, 'parse-workers'));
  appendPowerShellFlag(args, '-CopilotTimeoutSeconds', getFlag(parsed, 'copilot-timeout-seconds'));
  appendPowerShellSwitch(args, '-SkipIndex', parsed.flags.get('no-index') === true);
  appendPowerShellSwitch(args, '-DryRun', parsed.flags.get('dry-run') === true);
  appendPowerShellSwitch(args, '-KeepWorktrees', parsed.flags.get('keep-worktrees') === true);

  const result = spawnSync(powerShellExecutable(), args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function appendPowerShellFlag(args: string[], name: string, value: string | undefined): void {
  if (!value) return;
  args.push(name, value);
}

function appendPowerShellSwitch(args: string[], name: string, enabled: boolean): void {
  if (enabled) args.push(name);
}

function powerShellExecutable(): string {
  return process.platform === 'win32' ? 'powershell' : 'pwsh';
}

function projectRootForCli(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

async function runSetupCommand(parsed: ParsedArgs): Promise<void> {
  const root = getFlag(parsed, 'root') ?? process.cwd();
  const { db, dbPath, paths } = await openCodeGraphDb(root);
  const indexer = new V2Indexer(db);
  const progress = parsed.flags.get('quiet') === true ? undefined : createIndexProgressReporter(dbPath);
  try {
    const index = await indexer.indexWorkspace({
      root,
      workspaceKey: getFlag(parsed, 'workspace-key') ?? process.env.CODEGRAPH_WORKSPACE_KEY,
      parseWorkers: getNumberFlag(parsed, 'parse-workers'),
      indexProviders: indexProvidersFlag(parsed),
      scipIndexPath: scipIndexFlag(parsed),
      progress,
    });
    const artifact = await buildLocalArtifactIndex(root, {
      maxFiles: getNumberFlag(parsed, 'max-files'),
      maxFileBytes: getNumberFlag(parsed, 'max-file-bytes'),
      maxContentBytes: getNumberFlag(parsed, 'max-content-bytes'),
    });
    const state = {
      backend: 'sqlite',
      root: path.resolve(root),
      dbPath,
      graphDir: paths.graphDir,
      setupAt: new Date().toISOString(),
      index,
      artifact,
    };
    fs.writeFileSync(paths.setupStatePath, JSON.stringify(state, null, 2), 'utf-8');
    console.log(JSON.stringify({
      ...index,
      backend: 'sqlite',
      dbPath,
      graphDir: paths.graphDir,
      setupStatePath: paths.setupStatePath,
      artifactPath: artifact.artifactPath,
      next: 'Point your MCP client at `codegraph mcp --root <workspace>`.',
    }, null, 2));
  } finally {
    await db.close();
  }
}

async function runIndexCommand(parsed: ParsedArgs): Promise<void> {
  const root = getFlag(parsed, 'root') ?? process.cwd();
  const { db, dbPath } = await openCodeGraphDb(root);
  const indexer = new V2Indexer(db);
  const progress = parsed.flags.get('quiet') === true
    ? undefined
    : createIndexProgressReporter(dbPath);
  try {
    const result = await indexer.indexWorkspace({
      root,
      workspaceKey: getFlag(parsed, 'workspace-key') ?? process.env.CODEGRAPH_WORKSPACE_KEY,
      parseWorkers: getNumberFlag(parsed, 'parse-workers'),
      incremental: parsed.flags.get('no-incremental') === true ? false : undefined,
      incrementalFileLimit: getNumberFlag(parsed, 'incremental-file-limit'),
      indexProviders: indexProvidersFlag(parsed),
      scipIndexPath: scipIndexFlag(parsed),
      progress,
    });
    console.log(JSON.stringify({ ...result, backend: 'sqlite', dbPath }, null, 2));
  } finally {
    await db.close();
  }
}

async function runAtlasCommand(parsed: ParsedArgs): Promise<void> {
  const root = getFlag(parsed, 'root') ?? process.cwd();
  const out = getFlag(parsed, 'out');
  const format = getFlag(parsed, 'format') === 'markdown' ? 'markdown' : 'json';
  const profile = getFlag(parsed, 'profile') ?? 'compact';
  const workspaceKey = getFlag(parsed, 'workspace-key') ?? process.env.CODEGRAPH_WORKSPACE_KEY;
  const { db, dbPath } = await openCodeGraphDb(root);
  const indexer = new V2Indexer(db);
  const progress = parsed.flags.get('quiet') === true
    ? undefined
    : createIndexProgressReporter(dbPath);
  try {
    const snapshot = parsed.flags.get('no-index') === true
      ? await resolveCurrentGraphSnapshot(db, root, workspaceKey)
      : await indexer.indexWorkspace({
        root,
        workspaceKey,
        parseWorkers: getNumberFlag(parsed, 'parse-workers'),
        indexProviders: indexProvidersFlag(parsed),
        scipIndexPath: scipIndexFlag(parsed),
        progress,
      });
    if (!snapshot) {
      throw new Error('No current CodeGraph snapshot found for this workspace. Run codegraph index --root <workspace>, or omit --no-index.');
    }

    const queries = new V2QueryService(db);
    const report = await queries.query({
      workspaceId: snapshot.workspaceId,
      toolName: 'generate_repo_atlas',
      args: {
        format,
        profile,
        maxModules: getNumberFlag(parsed, 'max-modules'),
        maxEntrypoints: getNumberFlag(parsed, 'max-entrypoints'),
        maxHotspots: getNumberFlag(parsed, 'max-hotspots'),
        includeTests: parsed.flags.get('no-tests') !== true,
        includeGenerated: parsed.flags.get('include-generated') === true,
        warnStale: parsed.flags.get('warn-stale') === true,
      },
    });
    const content = format === 'markdown' && isCliRecord(report) && typeof report.markdown === 'string'
      ? report.markdown
      : JSON.stringify(report, null, 2);
    if (!out) {
      console.log(content);
      return;
    }
    const outputPath = path.resolve(out);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, content, 'utf-8');
    const budget = isCliRecord(report) && isCliRecord(report.budget) ? report.budget : {};
    console.log(JSON.stringify({
      out: outputPath,
      format,
      profile,
      workspaceId: snapshot.workspaceId,
      snapshotId: snapshot.snapshotId,
      estimatedResponseTokens: budget.estimatedResponseTokens,
      queryTimeMs: budget.queryTimeMs,
      backend: 'sqlite',
      dbPath,
    }, null, 2));
  } finally {
    await db.close();
  }
}

async function runGraphCommand(parsed: ParsedArgs): Promise<void> {
  const root = getFlag(parsed, 'root') ?? process.cwd();
  const out = getFlag(parsed, 'out');
  if (!out) throw new Error('Usage: codegraph graph --root <workspace> --out <graph.html>');

  const { db, dbPath } = await openCodeGraphDb(root);
  const indexer = new V2Indexer(db);
  const workspaceKey = getFlag(parsed, 'workspace-key') ?? process.env.CODEGRAPH_WORKSPACE_KEY;
  const progress = parsed.flags.get('quiet') === true
    ? undefined
    : createIndexProgressReporter(dbPath);
  try {
    const snapshot = parsed.flags.get('no-index') === true
      ? await resolveCurrentGraphSnapshot(db, root, workspaceKey)
      : await indexer.indexWorkspace({
        root,
        workspaceKey,
        parseWorkers: getNumberFlag(parsed, 'parse-workers'),
        indexProviders: indexProvidersFlag(parsed),
        scipIndexPath: scipIndexFlag(parsed),
        skipSnapshotStats: true,
        progress,
      });
    if (!snapshot) {
      throw new Error('No current CodeGraph snapshot found for this workspace. Run codegraph index --root <workspace>, or omit --no-index.');
    }

    const graph = await buildGraphExport(db, {
      workspaceId: snapshot.workspaceId,
      snapshotId: snapshot.snapshotId,
      root,
      maxNodes: getNumberFlag(parsed, 'max-nodes'),
      maxEdges: getNumberFlag(parsed, 'max-edges'),
      includeTests: parsed.flags.get('include-tests') === true,
      includeGenerated: parsed.flags.get('include-generated') === true,
    });
    const outputPath = path.resolve(out);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, renderGraphHtml(graph), 'utf-8');
    console.log(JSON.stringify({
      out: outputPath,
      workspaceId: graph.metadata.workspaceId,
      snapshotId: graph.metadata.snapshotId,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      groups: graph.groups.length,
      truncated: graph.metadata.truncated,
      hiddenNodes: graph.stats.hiddenNodes,
      hiddenEdges: graph.stats.hiddenEdges,
      backend: 'sqlite',
      dbPath,
    }, null, 2));
  } finally {
    await db.close();
  }
}

async function runDoctorCommand(parsed: ParsedArgs): Promise<void> {
  await runStatusCommand({
    ...parsed,
    command: [],
    flags: new Map(parsed.flags).set('json', true),
  }, { commandName: 'doctor' });
}

async function runStatusCommand(parsed: ParsedArgs, options: { commandName?: string } = {}): Promise<void> {
  const root = getFlag(parsed, 'root') ?? process.cwd();
  const readiness = await inspectWorkspaceWithHealth(root);
  const commandName = options.commandName ?? 'status';
  const json = parsed.flags.get('json') === true || getFlag(parsed, 'format') === 'json';
  const requireReady = parsed.flags.get('require-ready') === true;
  const requireFresh = parsed.flags.get('require-fresh') === true;
  const freshnessAvailable = readiness.freshness?.available === true;
  const isFresh = freshnessAvailable && readiness.freshness?.isStale !== true;
  const gateState: {
    required: boolean;
    passed: boolean;
    expected: string;
    actual: string;
    reason?: string;
  } = {
    required: true,
    passed: true,
    expected: requireFresh ? 'ready and fresh' : 'ready',
    actual: readiness.state,
    reason: undefined as string | undefined,
  };
  if (requireFresh) {
    if (readiness.state !== 'ready') {
      gateState.passed = false;
      gateState.expected = 'ready and fresh';
      gateState.reason = 'Workspace is not fully indexed. Run codegraph index --root <workspace> or codegraph setup --root <workspace> first.';
    } else if (!freshnessAvailable) {
      gateState.passed = false;
      gateState.expected = 'ready and fresh';
      gateState.actual = 'ready with unknown freshness';
      gateState.reason = 'Cannot verify freshness: git metadata is unavailable. Run command in a git checkout or skip --require-fresh.';
    } else if (readiness.freshness?.isStale) {
      gateState.passed = false;
      gateState.expected = 'ready and fresh';
      gateState.actual = 'ready but stale';
      gateState.reason = 'Index is stale. Run codegraph index --root <workspace> first, or enable MCP auto-refresh.';
    } else {
      gateState.passed = true;
      gateState.actual = 'ready and fresh';
    }
  } else if (requireReady) {
    gateState.passed = readiness.state === 'ready';
    gateState.expected = 'ready';
    gateState.actual = readiness.state;
    gateState.reason = gateState.passed
      ? undefined
      : 'Workspace is not fully indexed. Run codegraph index --root <workspace> or codegraph setup --root <workspace> first.';
  } else if (isFresh) {
    gateState.passed = true;
    gateState.actual = 'ready and fresh';
  } else if (readiness.state === 'ready' && freshnessAvailable && readiness.freshness?.isStale) {
    gateState.passed = true;
    gateState.expected = 'ready';
    gateState.actual = 'ready but stale';
  }
  if (json || commandName === 'doctor') {
    const output = {
      ...readiness,
      gate: commandName === 'status' ? gateState : undefined,
    };
    console.log(JSON.stringify(output, null, 2));
    if ((requireReady || requireFresh) && !gateState.passed) {
      process.exitCode = 1;
    }
    return;
  }

  const statusText = formatWorkspaceStatus(readiness, commandName === 'doctor' ? undefined : gateState);
  console.log(statusText);
  if ((requireReady || requireFresh) && !gateState.passed) process.exitCode = 1;
}

interface WorkspaceHealthReport {
  ok: boolean;
  state: string;
  root: string;
  backend: 'sqlite';
  artifact: { ok: boolean; state: string; artifactPath: string };
  database: {
    ok: boolean;
    state: 'ready' | 'unindexed' | 'missing';
    dbPath: string;
    workspaceId?: string;
    snapshotId?: string;
    healthy?: boolean;
  };
  capabilities: { graphQueries: boolean; freshGraph: boolean; embeddedArtifact: boolean; facadeContext: boolean };
  freshness?: {
    available: boolean;
    isStale: boolean;
    warning?: string;
    snapshotCreatedAt?: string;
    currentHeadCommit?: string;
    snapshotHeadCommit?: string;
    snapshotDirtyHash?: string;
    currentDirtyHash?: string;
  };
  nextActions: Array<{ label: string; command: string; reason: string; }>;
  paths: {
    graphDir: string;
    dbPath: string;
    artifactPath: string;
    setupStatePath: string;
    queryLogPath: string;
  };
  setupStatePath: string;
  queryLogPath: string;
}

async function inspectWorkspaceWithHealth(root: string): Promise<WorkspaceHealthReport> {
  const readiness = inspectWorkspaceReadiness(root);
  const dbExists = fs.existsSync(readiness.paths.dbPath);
  let database: {
    ok: boolean;
    state: 'ready' | 'unindexed' | 'missing';
    dbPath: string;
    workspaceId?: string;
    snapshotId?: string;
    healthy?: boolean;
  } = readiness.database;
  if (dbExists) {
    const { graph } = await openCodeGraphDb(root);
    try {
      database = {
        ...database,
        healthy: graph.isHealthy(),
      };
    } finally {
      await graph.close();
    }
  }
  return {
    ok: readiness.ok,
    state: readiness.state,
    root: readiness.root,
    backend: 'sqlite' as const,
    artifact: readiness.artifact,
    database,
    capabilities: readiness.capabilities,
    freshness: readiness.freshness,
    nextActions: readiness.nextActions,
    paths: readiness.paths,
    setupStatePath: readiness.paths.setupStatePath,
    queryLogPath: readiness.paths.queryLogPath,
  };
}

function formatWorkspaceStatus(readiness: {
  ok: boolean;
  state: string;
  root: string;
  backend: 'sqlite';
  artifact: { ok: boolean; state: string; artifactPath: string };
  database: {
    ok: boolean;
    state: 'ready' | 'unindexed' | 'missing';
    dbPath: string;
    workspaceId?: string;
    snapshotId?: string;
    healthy?: boolean;
  };
  capabilities: { graphQueries: boolean; freshGraph: boolean; embeddedArtifact: boolean; facadeContext: boolean };
  freshness?: {
    available: boolean;
    isStale: boolean;
    warning?: string;
    snapshotCreatedAt?: string;
    currentHeadCommit?: string;
    snapshotHeadCommit?: string;
    snapshotDirtyHash?: string;
    currentDirtyHash?: string;
  };
  nextActions: Array<{ label: string; command: string; reason: string; }>;
}, gate?: {
  required: boolean;
  passed: boolean;
  expected: string;
  actual: string;
  reason?: string;
}): string {
  const lines: string[] = [];
  lines.push(`CodeGraph Status`);
  lines.push(`Root: ${readiness.root}`);
  lines.push(`Backend: ${readiness.backend}`);
  lines.push(`State: ${readiness.state}`);
  lines.push(`Ready: ${readiness.ok ? 'yes' : 'no'}`);
  lines.push(`Graph DB: ${readiness.database.state}${readiness.database.healthy === undefined ? '' : readiness.database.healthy ? ' (healthy)' : ' (unhealthy)'}`);
  lines.push(`Artifact: ${readiness.artifact.state}`);
  lines.push(`Capabilities: graphQueries=${readiness.capabilities.graphQueries}, facadeContext=${readiness.capabilities.facadeContext}, freshGraph=${readiness.capabilities.freshGraph}`);
  if (readiness.freshness?.available) {
    if (readiness.freshness.warning) {
      lines.push(`Freshness: stale (snapshot=${readiness.freshness.snapshotHeadCommit?.slice(0, 8) ?? 'unknown'})`);
      lines.push(`         ${readiness.freshness.warning}`);
    } else {
      lines.push(`Freshness: up-to-date`);
    }
  } else {
    lines.push(`Freshness: git unavailable`);
  }
  if (readiness.nextActions.length > 0) {
    lines.push('');
    lines.push('Next actions:');
    for (const action of readiness.nextActions) {
      lines.push(`  - ${action.command}`);
      if (action.reason) lines.push(`    ${action.reason}`);
    }
  }
  if (gate) {
    lines.push('');
    lines.push(`Gate: ${gate.required ? 'required' : 'disabled'} (expected ${gate.expected}, actual ${gate.actual})`);
  }
  return lines.join('\n');
}

async function runUpgradeAuditCommand(parsed: ParsedArgs): Promise<void> {
  const root = getFlag(parsed, 'root') ?? process.cwd();
  const readiness = await inspectWorkspaceWithHealth(root);
  const paths = getWorkspacePaths(root);
  const requireReady = parsed.flags.get('require-ready') === true;
  const requireFresh = parsed.flags.get('require-fresh') === true;
  const policy = loadUpgradeAuditPolicy({
    root,
    flagPath: getFlag(parsed, 'policy'),
    envPath: process.env.CODEGRAPH_UPGRADE_AUDIT_POLICY,
  });
  const maxSlowMs = getNumberFlagFromSourcesStrict({
    rawFlag: getFlag(parsed, 'max-slow-ms'),
    rawEnv: process.env.CODEGRAPH_UPGRADE_AUDIT_MAX_SLOW_MS,
    rawPolicy: policy.maxSlowMs,
    name: '--max-slow-ms',
    envName: 'CODEGRAPH_UPGRADE_AUDIT_MAX_SLOW_MS',
    policyName: policy.path ? `policy ${policy.path}:max-slow-ms` : undefined,
    minValue: 1,
  });
  const maxSlowMsP95 = getNumberFlagFromSourcesStrict({
    rawFlag: getFlag(parsed, 'max-slow-ms-p95'),
    rawEnv: process.env.CODEGRAPH_UPGRADE_AUDIT_MAX_SLOW_MS_P95,
    rawPolicy: policy.maxSlowMsP95,
    name: '--max-slow-ms-p95',
    envName: 'CODEGRAPH_UPGRADE_AUDIT_MAX_SLOW_MS_P95',
    policyName: policy.path ? `policy ${policy.path}:max-slow-ms-p95` : undefined,
    minValue: 1,
  });
  const maxInvalidLines = getIntegerFlagFromSourcesStrict({
    rawFlag: getFlag(parsed, 'max-invalid-lines'),
    rawEnv: process.env.CODEGRAPH_UPGRADE_AUDIT_MAX_INVALID_LINES,
    rawPolicy: policy.maxInvalidLines,
    name: '--max-invalid-lines',
    envName: 'CODEGRAPH_UPGRADE_AUDIT_MAX_INVALID_LINES',
    policyName: policy.path ? `policy ${policy.path}:max-invalid-lines` : undefined,
    minValue: 0,
  });
  const maxStaleQueries = getIntegerFlagFromSourcesStrict({
    rawFlag: getFlag(parsed, 'max-stale-queries'),
    rawEnv: process.env.CODEGRAPH_UPGRADE_AUDIT_MAX_STALE_QUERIES,
    rawPolicy: policy.maxStaleQueries,
    name: '--max-stale-queries',
    envName: 'CODEGRAPH_UPGRADE_AUDIT_MAX_STALE_QUERIES',
    policyName: policy.path ? `policy ${policy.path}:max-stale-queries` : undefined,
    minValue: 0,
  });
  const maxDegradedQueries = getIntegerFlagFromSourcesStrict({
    rawFlag: getFlag(parsed, 'max-degraded-queries'),
    rawEnv: process.env.CODEGRAPH_UPGRADE_AUDIT_MAX_DEGRADED_QUERIES,
    rawPolicy: policy.maxDegradedQueries,
    name: '--max-degraded-queries',
    envName: 'CODEGRAPH_UPGRADE_AUDIT_MAX_DEGRADED_QUERIES',
    policyName: policy.path ? `policy ${policy.path}:max-degraded-queries` : undefined,
    minValue: 0,
  });
  const maxStaleRatio = getNumberFlagFromSourcesStrict({
    rawFlag: getFlag(parsed, 'max-stale-ratio'),
    rawEnv: process.env.CODEGRAPH_UPGRADE_AUDIT_MAX_STALE_RATIO,
    rawPolicy: policy.maxStaleRatio,
    name: '--max-stale-ratio',
    envName: 'CODEGRAPH_UPGRADE_AUDIT_MAX_STALE_RATIO',
    policyName: policy.path ? `policy ${policy.path}:max-stale-ratio` : undefined,
    minValue: 0,
    maxValue: 100,
  });
  const maxDegradedRatio = getNumberFlagFromSourcesStrict({
    rawFlag: getFlag(parsed, 'max-degraded-ratio'),
    rawEnv: process.env.CODEGRAPH_UPGRADE_AUDIT_MAX_DEGRADED_RATIO,
    rawPolicy: policy.maxDegradedRatio,
    name: '--max-degraded-ratio',
    envName: 'CODEGRAPH_UPGRADE_AUDIT_MAX_DEGRADED_RATIO',
    policyName: policy.path ? `policy ${policy.path}:max-degraded-ratio` : undefined,
    minValue: 0,
    maxValue: 100,
  });
  const minScore = getNumberFlagFromSources({
    rawFlag: getFlag(parsed, 'min-score'),
    rawEnv: process.env.CODEGRAPH_UPGRADE_AUDIT_MIN_SCORE,
    rawPolicy: policy.minScore,
    name: '--min-score',
    envName: 'CODEGRAPH_UPGRADE_AUDIT_MIN_SCORE',
    policyName: policy.path ? `policy ${policy.path}:min-score` : undefined,
  });
  const minGradeValue = getStringFromSources({
    rawFlag: getFlag(parsed, 'min-grade'),
    rawEnv: process.env.CODEGRAPH_UPGRADE_AUDIT_MIN_GRADE,
    rawPolicy: valueAsString(policy.minGrade),
    name: '--min-grade',
    envName: 'CODEGRAPH_UPGRADE_AUDIT_MIN_GRADE',
    policyName: policy.path ? `policy ${policy.path}:min-grade` : undefined,
  });
  const minGrade = parseUpgradeAuditGrade({
    value: minGradeValue.value,
    source: minGradeValue.source ?? '--min-grade',
  });
  const tail = Math.max(1, Math.min(getNumberFlag(parsed, 'tail') ?? 500, 5000));
  const all = parsed.flags.get('all') === true;
  const includeInvalid = parsed.flags.get('invalid') === true;
  const sinceMs = parseLogSince(getFlag(parsed, 'since'));
  const untilMs = parseLogUntil(getFlag(parsed, 'until'));
  const toolFilter = getFlag(parsed, 'tool');
  const eventFilter = parseLogEvent(getFlag(parsed, 'event'));
  if (sinceMs !== undefined && untilMs !== undefined && untilMs < sinceMs) {
    throw new Error(`Invalid --until value: ${getFlag(parsed, 'until')}. It must be equal to or after --since: ${getFlag(parsed, 'since')}`);
  }

  const queryLogSummary = loadQueryLogSummaryFromLogPath({
    logPath: paths.queryLogPath,
    all,
    includeInvalid,
    tail,
    sinceMs,
    untilMs,
    toolFilter,
    eventFilter,
  });
  const audit = buildUpgradeAuditReport({
    readiness,
    queryLogSummary,
    requireReady,
    requireFresh,
    minScore,
    maxSlowMs,
    maxSlowMsP95,
    maxInvalidLines,
    maxStaleQueries,
    maxDegradedQueries,
    maxStaleRatio,
    maxDegradedRatio,
    minGrade,
  });
  const json = parsed.flags.get('json') === true || getFlag(parsed, 'format') === 'json';
  if (json) {
    console.log(JSON.stringify(audit, null, 2));
    if (audit.gate.required && !audit.gate.passed) {
      process.exitCode = 1;
    }
    return;
  }

  console.log(formatUpgradeAuditText(audit));
  if (audit.gate.required && !audit.gate.passed) process.exitCode = 1;
}

function formatUpgradeAuditText(audit: ReturnType<typeof buildUpgradeAuditReport>): string {
  const lines: string[] = [];
  lines.push('CodeGraph Super VIP Audit');
  lines.push(`Root: ${audit.root}`);
  lines.push(`Grade: ${audit.grade}`);
  lines.push(`Readiness score: ${audit.score.readiness}/100`);
  lines.push(`Query log score: ${audit.score.log}/100`);
  lines.push(`Overall score: ${audit.score.overall}/100`);
  lines.push(`Readiness state: ${audit.readiness.state}`);
  lines.push(`Critical issues: ${audit.issues.filter(issue => issue.severity === 'critical').length}`);
  lines.push(`Warnings: ${audit.issues.filter(issue => issue.severity === 'warning').length}`);
  lines.push(`Infos: ${audit.issues.filter(issue => issue.severity === 'info').length}`);
  lines.push(`Gate: ${audit.gate.required ? 'required' : 'disabled'} (expected ${audit.gate.expected}, actual ${audit.gate.actual})`);
  if (audit.issues.length > 0) {
    lines.push('');
    lines.push('Top issues:');
    for (const issue of audit.issues) {
      const suffix = issue.remediation ? ` -> ${issue.remediation}` : '';
      lines.push(`- [${issue.severity}] ${issue.id}: ${issue.message}${suffix}`);
    }
  }
  return lines.join('\n');
}

function buildUpgradeAuditReport(args: {
  readiness: WorkspaceHealthReport;
  queryLogSummary: QueryLogSummary;
  requireReady: boolean;
  requireFresh: boolean;
  minScore?: number;
  minGrade?: UpgradeAuditGrade;
  maxSlowMs?: number;
  maxSlowMsP95?: number;
  maxInvalidLines?: number;
  maxStaleQueries?: number;
  maxDegradedQueries?: number;
  maxStaleRatio?: number;
  maxDegradedRatio?: number;
}) {
  const { readiness, queryLogSummary, requireReady, requireFresh, minScore } = args;
  const issues: Array<{ id: string; severity: 'critical' | 'warning' | 'info'; message: string; remediation?: string }> = [];
  const readinessScore = readinessScoreFromState(readiness, issues);
  const logScore = logScoreFromSummary(queryLogSummary, issues);
  const overall = clamp(Math.round(readinessScore * 0.72 + logScore * 0.28), 0, 100);
  const grade = upgradeAuditGrade(overall);
  const gate = buildAuditGate({
    requireReady,
    requireFresh,
    minScore,
    minGrade: args.minGrade,
    maxSlowMs: args.maxSlowMs,
    maxSlowMsP95: args.maxSlowMsP95,
    maxInvalidLines: args.maxInvalidLines,
    maxStaleQueries: args.maxStaleQueries,
    maxDegradedQueries: args.maxDegradedQueries,
    maxStaleRatio: args.maxStaleRatio,
    maxDegradedRatio: args.maxDegradedRatio,
    readiness,
    overall,
    grade,
    queryLogSummary,
  });
  return {
    root: readiness.root,
    readiness: {
      state: readiness.state,
      ok: readiness.ok,
      freshGraph: readiness.capabilities.freshGraph,
      facadeContext: readiness.capabilities.facadeContext,
      databaseHealthy: readiness.database.healthy,
      nextActions: readiness.nextActions,
    },
    score: {
      readiness: readinessScore,
      log: logScore,
      overall,
    },
    grade,
    queryLogSummary,
    issues,
    gate,
  };
}

type UpgradeAuditGrade = 'A+' | 'A' | 'B+' | 'B' | 'C' | 'D' | 'F';
const UPGRADE_AUDIT_GRADES = ['A+', 'A', 'B+', 'B', 'C', 'D', 'F'] as const;

interface LoadedUpgradeAuditPolicy {
  path?: string;
  minScore?: number;
  minGrade?: string;
  maxSlowMs?: number;
  maxSlowMsP95?: number;
  maxInvalidLines?: number;
  maxStaleQueries?: number;
  maxDegradedQueries?: number;
  maxStaleRatio?: number;
  maxDegradedRatio?: number;
}

function loadUpgradeAuditPolicy(params: { root: string; flagPath?: string; envPath?: string }): LoadedUpgradeAuditPolicy {
  const requestedPath = params.flagPath ?? params.envPath;
  const candidatePath = resolvePolicyPath(params.root, requestedPath);
  if (!candidatePath) {
    if (!requestedPath) return {};
    const pathSource = path.isAbsolute(requestedPath) ? requestedPath : path.resolve(params.root, requestedPath);
    throw new Error(`Upgrade audit policy file not found: ${pathSource}`);
  }
  const raw = fs.readFileSync(candidatePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid upgrade-audit policy file: ${candidatePath}. ${error instanceof Error ? error.message : 'Invalid JSON.'}`);
  }
  if (!isCliRecord(parsed)) {
    throw new Error(`Invalid upgrade-audit policy file: ${candidatePath}. Expected JSON object.`);
  }
  return validateAndNormalizeUpgradeAuditPolicy(parsed, candidatePath);
}

const UPGRADE_AUDIT_POLICY_KEY_TO_CANONICAL = new Map<string, keyof LoadedUpgradeAuditPolicy>([
  ['min-score', 'minScore'],
  ['minScore', 'minScore'],
  ['min-grade', 'minGrade'],
  ['minGrade', 'minGrade'],
  ['max-slow-ms', 'maxSlowMs'],
  ['maxSlowMs', 'maxSlowMs'],
  ['max-slow-ms-p95', 'maxSlowMsP95'],
  ['maxSlowMsP95', 'maxSlowMsP95'],
  ['max-invalid-lines', 'maxInvalidLines'],
  ['maxInvalidLines', 'maxInvalidLines'],
  ['max-stale-queries', 'maxStaleQueries'],
  ['maxStaleQueries', 'maxStaleQueries'],
  ['max-degraded-queries', 'maxDegradedQueries'],
  ['maxDegradedQueries', 'maxDegradedQueries'],
  ['max-stale-ratio', 'maxStaleRatio'],
  ['maxStaleRatio', 'maxStaleRatio'],
  ['max-degraded-ratio', 'maxDegradedRatio'],
  ['maxDegradedRatio', 'maxDegradedRatio'],
]);

function validateAndNormalizeUpgradeAuditPolicy(policy: Record<string, unknown>, policyPath: string): LoadedUpgradeAuditPolicy {
  const normalized: LoadedUpgradeAuditPolicy = { path: policyPath };
  for (const [rawKey, rawValue] of Object.entries(policy)) {
    const canonical = UPGRADE_AUDIT_POLICY_KEY_TO_CANONICAL.get(rawKey);
    if (!canonical) {
      throw new Error(`Invalid upgrade-audit policy file: ${policyPath}. Unknown key: ${rawKey}.`);
    }

    switch (canonical) {
      case 'minScore':
        normalized.minScore = parsePolicyNumber(rawValue, {
          min: 0,
          max: 100,
          field: rawKey,
          policyPath,
          allowFloat: true,
        });
        break;
      case 'minGrade':
        normalized.minGrade = parsePolicyGrade(rawValue, rawKey, policyPath);
        break;
      case 'maxSlowMs':
        normalized.maxSlowMs = parsePolicyNumber(rawValue, {
          min: 1,
          max: Number.POSITIVE_INFINITY,
          field: rawKey,
          policyPath,
          allowFloat: false,
        });
        break;
      case 'maxSlowMsP95':
        normalized.maxSlowMsP95 = parsePolicyNumber(rawValue, {
          min: 1,
          max: Number.POSITIVE_INFINITY,
          field: rawKey,
          policyPath,
          allowFloat: false,
        });
        break;
      case 'maxInvalidLines':
        normalized.maxInvalidLines = parsePolicyNumber(rawValue, {
          min: 0,
          max: Number.POSITIVE_INFINITY,
          field: rawKey,
          policyPath,
          allowFloat: false,
        });
        break;
      case 'maxStaleQueries':
        normalized.maxStaleQueries = parsePolicyNumber(rawValue, {
          min: 0,
          max: Number.POSITIVE_INFINITY,
          field: rawKey,
          policyPath,
          allowFloat: false,
        });
        break;
      case 'maxDegradedQueries':
        normalized.maxDegradedQueries = parsePolicyNumber(rawValue, {
          min: 0,
          max: Number.POSITIVE_INFINITY,
          field: rawKey,
          policyPath,
          allowFloat: false,
        });
        break;
      case 'maxStaleRatio':
        normalized.maxStaleRatio = parsePolicyNumber(rawValue, {
          min: 0,
          max: 100,
          field: rawKey,
          policyPath,
          allowFloat: true,
        });
        break;
      case 'maxDegradedRatio':
        normalized.maxDegradedRatio = parsePolicyNumber(rawValue, {
          min: 0,
          max: 100,
          field: rawKey,
          policyPath,
          allowFloat: true,
        });
        break;
      default:
        throw new Error(`Invalid upgrade-audit policy file: ${policyPath}. Unknown key: ${rawKey}.`);
    }
  }

  if (normalized.minScore !== undefined && normalized.minGrade !== undefined) {
    throw new Error(`Invalid upgrade-audit policy file: ${policyPath}. Cannot specify both min-score and min-grade.`);
  }

  return normalized;
}

function parsePolicyNumber(
  rawValue: unknown,
  params: {
    min: number;
    max: number;
    field: string;
    policyPath: string;
    allowFloat: boolean;
  },
): number {
  if (typeof rawValue === 'number') {
    if (!Number.isFinite(rawValue)) {
      throw new Error(`Invalid upgrade-audit policy file: ${params.policyPath}. ${params.field} must be ${params.allowFloat ? 'a number' : 'an integer'} from ${params.min} to ${params.max}.`);
    }
    if (!params.allowFloat && !Number.isInteger(rawValue)) {
      throw new Error(`Invalid upgrade-audit policy file: ${params.policyPath}. ${params.field} must be an integer from ${params.min} to ${params.max}.`);
    }
    if (rawValue < params.min || rawValue > params.max) {
      throw new Error(`Invalid upgrade-audit policy file: ${params.policyPath}. ${params.field} must be ${params.allowFloat ? 'a number' : 'an integer'} from ${params.min} to ${params.max}.`);
    }
    return rawValue;
  }
  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (trimmed.length === 0) {
      throw new Error(`Invalid upgrade-audit policy file: ${params.policyPath}. ${params.field} must be ${params.allowFloat ? 'a number' : 'an integer'} from ${params.min} to ${params.max}.`);
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid upgrade-audit policy file: ${params.policyPath}. ${params.field} must be ${params.allowFloat ? 'a number' : 'an integer'} from ${params.min} to ${params.max}.`);
    }
    if (!params.allowFloat && !Number.isInteger(parsed)) {
      throw new Error(`Invalid upgrade-audit policy file: ${params.policyPath}. ${params.field} must be an integer from ${params.min} to ${params.max}.`);
    }
    if (parsed < params.min || parsed > params.max) {
      throw new Error(`Invalid upgrade-audit policy file: ${params.policyPath}. ${params.field} must be ${params.allowFloat ? 'a number' : 'an integer'} from ${params.min} to ${params.max}.`);
    }
    return parsed;
  }
  throw new Error(`Invalid upgrade-audit policy file: ${params.policyPath}. ${params.field} must be ${params.allowFloat ? 'a number' : 'an integer'} from ${params.min} to ${params.max}, got ${String(rawValue)}.`);
}

function parsePolicyGrade(
  rawValue: unknown,
  field: string,
  policyPath: string,
): string {
  if (typeof rawValue === 'string' && rawValue.trim()) {
    const value = rawValue.trim();
    if (!UPGRADE_AUDIT_GRADES.includes(value as UpgradeAuditGrade)) {
      throw new Error(`Invalid upgrade-audit policy file: ${policyPath}. ${field} must be one of A+, A, B+, B, C, D, F.`);
    }
    return value;
  }
  throw new Error(`Invalid upgrade-audit policy file: ${policyPath}. ${field} must be one of A+, A, B+, B, C, D, F.`);
}

function resolvePolicyPath(root: string, policyPath: string | undefined): string | undefined {
  const defaultPolicyPath = path.resolve(root, '.codegraph', 'upgrade-audit.json');
  if (!policyPath) {
    return fs.existsSync(defaultPolicyPath) ? defaultPolicyPath : undefined;
  }
  const resolved = path.isAbsolute(policyPath) ? policyPath : path.resolve(root, policyPath);
  return fs.existsSync(resolved) ? resolved : undefined;
}

function valueAsString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : String(value);
}

function parseUpgradeAuditGrade(params: { value?: string; source: string }): UpgradeAuditGrade | undefined {
  const { value, source } = params;
  if (!value) return undefined;
  if (!UPGRADE_AUDIT_GRADES.includes(value as UpgradeAuditGrade)) {
    throw new Error(`Invalid ${source} value: ${value}. Use A+, A, B+, B, C, D, F.`);
  }
  return value as UpgradeAuditGrade;
}

function getNumberFlagFromSources(params: {
  rawFlag?: string;
  rawEnv?: string;
  rawPolicy?: string | number;
  name: string;
  envName: string;
  policyName?: string;
}): number | undefined {
  const source = chooseUpgradeAuditValueSource({
    rawFlag: params.rawFlag,
    rawEnv: params.rawEnv,
    rawPolicy: params.rawPolicy,
    name: params.name,
    envName: params.envName,
    policyName: params.policyName,
  });
  const value = source.raw;
  if (value === undefined) return undefined;
  const parsed = Number(source.raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`Invalid ${source.label} value: ${value}. Use a number from 0 to 100.`);
  }
  return parsed;
}

function getNumberFlagFromSourcesStrict(params: {
  rawFlag?: string;
  rawEnv?: string;
  rawPolicy?: string | number;
  name: string;
  envName: string;
  policyName?: string;
  minValue?: number;
  maxValue?: number;
}): number | undefined {
  const source = chooseUpgradeAuditValueSource({
    rawFlag: params.rawFlag,
    rawEnv: params.rawEnv,
    rawPolicy: params.rawPolicy,
    name: params.name,
    envName: params.envName,
    policyName: params.policyName,
  });
  const value = source.raw;
  if (value === undefined) return undefined;
  const parsed = Number(value);
  const minValue = params.minValue ?? 0;
  const maxValue = params.maxValue ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(parsed) || parsed < minValue || parsed > maxValue) {
    const range = maxValue === Number.POSITIVE_INFINITY
      ? `a number >= ${minValue}`
      : `a number from ${minValue} to ${maxValue}`;
    throw new Error(`Invalid ${source.label} value: ${value}. Use ${range}.`);
  }
  return parsed;
}

function getIntegerFlagFromSourcesStrict(params: {
  rawFlag?: string;
  rawEnv?: string;
  rawPolicy?: string | number;
  name: string;
  envName: string;
  policyName?: string;
  minValue?: number;
}): number | undefined {
  const source = chooseUpgradeAuditValueSource({
    rawFlag: params.rawFlag,
    rawEnv: params.rawEnv,
    rawPolicy: params.rawPolicy,
    name: params.name,
    envName: params.envName,
    policyName: params.policyName,
  });
  const value = source.raw;
  if (value === undefined) return undefined;
  const parsed = Number(value);
  const minValue = params.minValue ?? 0;
  if (!Number.isFinite(parsed) || parsed < minValue || !Number.isInteger(parsed)) {
    throw new Error(`Invalid ${source.label} value: ${value}. Use an integer >= ${minValue}.`);
  }
  return parsed;
}

function getStringFromSources(params: {
  rawFlag?: string;
  rawEnv?: string;
  rawPolicy?: string;
  name: string;
  envName: string;
  policyName?: string;
}): { value?: string; source?: string } {
  const source = chooseUpgradeAuditValueSource({
    rawFlag: params.rawFlag,
    rawEnv: params.rawEnv,
    rawPolicy: params.rawPolicy,
    name: params.name,
    envName: params.envName,
    policyName: params.policyName,
  });
  if (typeof source.raw !== 'string') return { value: undefined, source: source.label };
  return { value: source.raw, source: source.label };
}

function chooseUpgradeAuditValueSource(params: {
  rawFlag?: string;
  rawEnv?: string;
  rawPolicy?: string | number;
  name: string;
  envName: string;
  policyName?: string;
}): { raw: string | number | undefined; label: string } {
  if (params.rawFlag !== undefined) return { raw: params.rawFlag, label: params.name };
  if (params.rawEnv !== undefined) return { raw: params.rawEnv, label: params.envName };
  if (params.rawPolicy !== undefined) {
    const label = params.policyName ?? 'policy file';
    return { raw: params.rawPolicy, label };
  }
  return { raw: undefined, label: params.name };
}

function upgradeAuditMinimumScoreForGrade(grade: UpgradeAuditGrade): number {
  if (grade === 'A+') return 96;
  if (grade === 'A') return 92;
  if (grade === 'B+') return 84;
  if (grade === 'B') return 76;
  if (grade === 'C') return 64;
  if (grade === 'D') return 50;
  return 0;
}

function upgradeAuditGrade(score: number): UpgradeAuditGrade {
  if (score >= 96) return 'A+';
  if (score >= 92) return 'A';
  if (score >= 84) return 'B+';
  if (score >= 76) return 'B';
  if (score >= 64) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

function readinessScoreFromState(
  readiness: WorkspaceHealthReport,
  issues: Array<{ id: string; severity: 'critical' | 'warning' | 'info'; message: string; remediation?: string }>,
): number {
  let score = 100;
  if (readiness.state === 'missing') {
    score -= 80;
    issues.push({
      id: 'readiness-state-missing',
      severity: 'critical',
      message: 'Workspace graph artifacts are missing.',
      remediation: 'Run codegraph setup --root <workspace>.',
    });
  } else if (readiness.state === 'invalid') {
    score -= 65;
    issues.push({
      id: 'readiness-state-invalid-artifact',
      severity: 'critical',
      message: 'Embedded artifact is invalid and blocks facade behavior.',
      remediation: 'Run codegraph setup --root <workspace>.',
    });
  } else if (readiness.state === 'unindexed') {
    score -= 50;
    issues.push({
      id: 'readiness-state-unindexed',
      severity: 'warning',
      message: 'Workspace has DB schema but no usable snapshot.',
      remediation: 'Run codegraph index --root <workspace>.',
    });
  } else if (readiness.state === 'artifact_only') {
    score -= 35;
    issues.push({
      id: 'readiness-state-artifact-only',
      severity: 'warning',
      message: 'Only fallback artifact is available.',
      remediation: 'Run codegraph index --root <workspace>.',
    });
  } else if (readiness.state === 'ready') {
    issues.push({
      id: 'readiness-ready',
      severity: 'info',
      message: 'Workspace is ready for graph-backed operations.',
    });
  }

  if (readiness.state === 'ready' && readiness.freshness?.isStale) {
    score -= 15;
    issues.push({
      id: 'readiness-stale',
      severity: 'warning',
      message: 'Snapshot is stale compared to current workspace state.',
      remediation: 'Run codegraph index --root <workspace>.',
    });
  }
  if (readiness.state === 'ready' && !readiness.freshness?.available) {
    score -= 10;
    issues.push({
      id: 'readiness-freshness-unknown',
      severity: 'info',
      message: 'Freshness could not be verified (git unavailable in this workspace).',
      remediation: 'Run from a git checkout for stricter freshness guarantees.',
    });
  }
  if (readiness.database.healthy === false) {
    score -= 20;
    issues.push({
      id: 'database-unhealthy',
      severity: 'critical',
      message: 'Graph database reported unhealthy state.',
      remediation: 'Re-run setup/index and check sqlite health.',
    });
  }
  return clamp(score, 0, 100);
}

function logScoreFromSummary(
  summary: QueryLogSummary,
  issues: Array<{ id: string; severity: 'critical' | 'warning' | 'info'; message: string; remediation?: string }>,
): number {
  if (!summary.totalEvents) {
    return 90;
  }
  let score = 100;
  if (summary.invalidLines > 0) {
    const penalty = clamp(summary.invalidLines, 0, 25);
    score -= penalty;
    issues.push({
      id: 'log-invalid-lines',
      severity: summary.invalidLines > 5 ? 'warning' : 'info',
      message: `Found ${summary.invalidLines} invalid log lines in the selected window.`,
      remediation: 'Inspect the log path and clean log writers that emit malformed JSON.',
    });
  }
  if (summary.staleQueries > 0) {
    const penalty = clamp(summary.staleQueries * 4, 0, 20);
    score -= penalty;
    issues.push({
      id: 'log-stale-queries',
      severity: summary.staleQueries > 3 ? 'warning' : 'info',
      message: `${summary.staleQueries} stale query result(s) in recent logs.`,
      remediation: 'Refresh index state or enable auto-refresh for active workspaces.',
    });
  }
  if (summary.degradedQueries > 0) {
    const penalty = clamp(summary.degradedQueries * 3, 0, 18);
    score -= penalty;
    issues.push({
      id: 'log-degraded-queries',
      severity: summary.degradedQueries > 3 ? 'warning' : 'info',
      message: `${summary.degradedQueries} degraded query(ies) used fallback paths recently.`,
      remediation: 'Inspect degraded sources in the logged tool results.',
    });
  }
  if (summary.fallbackQueries > 0) {
    const penalty = clamp(Math.floor(summary.fallbackQueries / 2) * 2, 0, 10);
    score -= penalty;
  }
  const maxMs = summary.durationMs.max;
  if (maxMs >= 5000) {
    const penalty = Math.min(12, Math.floor((maxMs - 5000) / 500));
    score -= penalty;
    issues.push({
      id: 'log-slow-query',
      severity: maxMs > 20_000 ? 'warning' : 'info',
      message: `Detected slow query latency: max ${maxMs} ms in recent logs.`,
      remediation: 'Review the slowest tool outputs and tune query filters.',
    });
  }
  return clamp(score, 0, 100);
}

function buildAuditGate(args: {
  requireReady: boolean;
  requireFresh: boolean;
  maxSlowMs?: number;
  maxSlowMsP95?: number;
  maxInvalidLines?: number;
  maxStaleQueries?: number;
  maxDegradedQueries?: number;
  maxStaleRatio?: number;
  maxDegradedRatio?: number;
  minScore?: number;
  minGrade?: UpgradeAuditGrade;
  readiness: WorkspaceHealthReport;
  overall: number;
  grade: UpgradeAuditGrade;
  queryLogSummary: QueryLogSummary;
}): { required: boolean; passed: boolean; expected: string; actual: string; reasons?: string[] } {
  const reasons: string[] = [];
  if (args.requireReady && args.readiness.state !== 'ready') {
    reasons.push('Workspace is not fully indexed. Run codegraph setup/index first.');
  }
  if (args.requireFresh) {
    if (args.readiness.state !== 'ready') {
      reasons.push('Workspace is not ready, so freshness cannot be guaranteed.');
    } else if (!args.readiness.freshness?.available) {
      reasons.push('Freshness cannot be verified because git metadata is unavailable.');
    } else if (args.readiness.freshness.isStale) {
      reasons.push('Workspace snapshot is stale.');
    }
  }
  if (typeof args.minScore === 'number' && args.overall < args.minScore) {
    reasons.push(`Health score ${args.overall} below minimum ${args.minScore}.`);
  }
  if (args.minGrade !== undefined) {
    const minGradeScore = upgradeAuditMinimumScoreForGrade(args.minGrade);
    if (args.overall < minGradeScore) {
      reasons.push(`Health grade ${args.grade} below minimum ${args.minGrade}.`);
    }
  }
  if (typeof args.maxSlowMs === 'number') {
    if (args.queryLogSummary.durationMs.max > args.maxSlowMs) {
      reasons.push(`Query latency ${args.queryLogSummary.durationMs.max} ms exceeds max-slow-ms ${args.maxSlowMs} ms.`);
    }
  }
  if (typeof args.maxSlowMsP95 === 'number') {
    if ((args.queryLogSummary.durationMs.p95 ?? 0) > args.maxSlowMsP95) {
      reasons.push(`Query p95 latency ${args.queryLogSummary.durationMs.p95 ?? 0} ms exceeds max-slow-ms-p95 ${args.maxSlowMsP95} ms.`);
    }
  }
  if (typeof args.maxInvalidLines === 'number' && args.queryLogSummary.invalidLines > args.maxInvalidLines) {
    reasons.push(`Invalid log lines ${args.queryLogSummary.invalidLines} exceed max-invalid-lines ${args.maxInvalidLines}.`);
  }
  if (typeof args.maxStaleQueries === 'number' && args.queryLogSummary.staleQueries > args.maxStaleQueries) {
    reasons.push(`Stale queries ${args.queryLogSummary.staleQueries} exceed max-stale-queries ${args.maxStaleQueries}.`);
  }
  if (typeof args.maxDegradedQueries === 'number' && args.queryLogSummary.degradedQueries > args.maxDegradedQueries) {
    reasons.push(`Degraded queries ${args.queryLogSummary.degradedQueries} exceed max-degraded-queries ${args.maxDegradedQueries}.`);
  }
  const staleRatio = ratioPercent(args.queryLogSummary.staleQueries, args.queryLogSummary.queryEvents);
  const degradedRatio = ratioPercent(args.queryLogSummary.degradedQueries, args.queryLogSummary.queryEvents);
  if (typeof args.maxStaleRatio === 'number' && staleRatio > args.maxStaleRatio) {
    reasons.push(`Stale query ratio ${formatPercent(staleRatio)} exceeds max-stale-ratio ${formatPercent(args.maxStaleRatio)}.`);
  }
  if (typeof args.maxDegradedRatio === 'number' && degradedRatio > args.maxDegradedRatio) {
    reasons.push(`Degraded query ratio ${formatPercent(degradedRatio)} exceeds max-degraded-ratio ${formatPercent(args.maxDegradedRatio)}.`);
  }
  const passed = reasons.length === 0;
  const expectedParts: string[] = [];
  if (args.requireReady) expectedParts.push('ready');
  if (args.requireFresh) expectedParts.push('fresh');
  if (typeof args.minScore === 'number') expectedParts.push(`score >= ${args.minScore}`);
  if (args.minGrade !== undefined) expectedParts.push(`grade >= ${args.minGrade}`);
  if (typeof args.maxSlowMs === 'number') expectedParts.push(`max query duration <= ${args.maxSlowMs} ms`);
  if (typeof args.maxSlowMsP95 === 'number') expectedParts.push(`p95 query duration <= ${args.maxSlowMsP95} ms`);
  if (typeof args.maxInvalidLines === 'number') expectedParts.push(`invalid lines <= ${args.maxInvalidLines}`);
  if (typeof args.maxStaleQueries === 'number') expectedParts.push(`stale queries <= ${args.maxStaleQueries}`);
  if (typeof args.maxDegradedQueries === 'number') expectedParts.push(`degraded queries <= ${args.maxDegradedQueries}`);
  if (typeof args.maxStaleRatio === 'number') expectedParts.push(`stale ratio <= ${formatPercent(args.maxStaleRatio)}`);
  if (typeof args.maxDegradedRatio === 'number') expectedParts.push(`degraded ratio <= ${formatPercent(args.maxDegradedRatio)}`);
  const scoreExpected = expectedParts.length > 0 ? expectedParts.join(' AND ') : 'all requested gate checks';
  return {
    required: args.requireReady
      || args.requireFresh
      || typeof args.minScore === 'number'
      || args.minGrade !== undefined
      || typeof args.maxSlowMs === 'number'
      || typeof args.maxSlowMsP95 === 'number'
      || typeof args.maxInvalidLines === 'number'
      || typeof args.maxStaleQueries === 'number'
      || typeof args.maxDegradedQueries === 'number'
      || typeof args.maxStaleRatio === 'number'
      || typeof args.maxDegradedRatio === 'number',
    passed,
    expected: scoreExpected,
    actual: `score=${args.overall}, grade=${args.grade}, state=${args.readiness.state}, maxQueryMs=${args.queryLogSummary.durationMs.max}, p95QueryMs=${args.queryLogSummary.durationMs.p95 ?? 0}, invalidLines=${args.queryLogSummary.invalidLines}, staleQueries=${args.queryLogSummary.staleQueries}, staleRatio=${formatPercent(staleRatio)}, degradedQueries=${args.queryLogSummary.degradedQueries}, degradedRatio=${formatPercent(degradedRatio)}`,
    reasons: reasons.length ? reasons : undefined,
  };
}

function ratioPercent(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }
  return (numerator / denominator) * 100;
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function loadQueryLogSummaryFromLogPath(params: {
  logPath: string;
  all: boolean;
  includeInvalid: boolean;
  tail: number;
  sinceMs?: number;
  untilMs?: number;
  toolFilter?: string;
  eventFilter?: string;
}): QueryLogSummary {
  if (!fs.existsSync(params.logPath)) {
    return summarizeQueryLogLines([], {
      includeInvalid: params.includeInvalid,
    });
  }
  const lines = fs.readFileSync(params.logPath, 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean);
  const tailLines = params.all ? lines : lines.slice(-params.tail);
  const lineOffset = lines.length - tailLines.length;
  return summarizeQueryLogLines(tailLines, {
    sinceMs: params.sinceMs,
    untilMs: params.untilMs,
    tool: params.toolFilter,
    event: params.eventFilter,
    includeInvalid: params.includeInvalid,
    lineOffset,
  });
}

interface QueryLogSummary {
  totalEvents: number;
  queryEvents: number;
  invalidLines: number;
  staleQueries: number;
  degradedQueries: number;
  debugTimedQueries: number;
  fallbackQueries: number;
  totalResponseChars: number;
  durationMs: {
    avg: number;
    max: number;
    p95: number;
  };
  tools: Record<string, {
    count: number;
    stale: number;
    degraded: number;
    debugTimed: number;
    fallback: number;
    avgMs: number;
    maxMs: number;
  }>;
  slowest: Array<{
    ts?: string;
    toolName?: string;
    routedToolName?: string;
    durationMs: number;
    responseChars: number;
    stale: boolean;
    degraded: boolean;
    debugTimed: boolean;
    topPhase?: string;
    fallbackCode?: string;
  }>;
  filters: {
    since?: string;
    until?: string;
    tool?: string;
    event?: string;
  };
  invalidSamples?: Array<{ rawLine: number; raw: string; reason: string }>;
}

async function runLogsCommand(parsed: ParsedArgs): Promise<void> {
  const root = getFlag(parsed, 'root') ?? process.cwd();
  const paths = getWorkspacePaths(root);
  const tail = Math.max(1, Math.min(getNumberFlag(parsed, 'tail') ?? 50, 1000));
  const allLogs = parsed.flags.get('all') === true;
  const includeInvalid = parsed.flags.get('invalid') === true;
  const sinceMs = parseLogSince(getFlag(parsed, 'since'));
  const untilMs = parseLogUntil(getFlag(parsed, 'until'));
  const toolFilter = getFlag(parsed, 'tool');
  const eventFilter = parseLogEvent(getFlag(parsed, 'event'));
  if (sinceMs !== undefined && untilMs !== undefined && untilMs < sinceMs) {
    throw new Error(`Invalid --until value: ${getFlag(parsed, 'until')}. It must be equal to or after --since: ${getFlag(parsed, 'since')}`);
  }
  if (!fs.existsSync(paths.queryLogPath)) {
    console.log(`No query log found at ${paths.queryLogPath}`);
    return;
  }
  const lines = fs.readFileSync(paths.queryLogPath, 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean);
  const tailLines = allLogs ? lines : lines.slice(-tail);

  const lineOffset = lines.length - tailLines.length;
  type ParsedLogLine = {
    kind: 'parsed';
    entry: Record<string, unknown>;
    rawLine: number;
  } | {
    kind: 'invalid';
    raw: string;
    reason: string;
    rawLine: number;
  };
  const parsedLines: ParsedLogLine[] = tailLines.map((line, index) => {
    try {
      const parsed = JSON.parse(line);
      if (isCliRecord(parsed)) {
        return { kind: 'parsed', entry: parsed, rawLine: index + 1 + lineOffset } as ParsedLogLine;
      }
      return { kind: 'invalid', raw: line, reason: 'Not a JSON object', rawLine: index + 1 + lineOffset };
    } catch {
      return { kind: 'invalid', raw: line, reason: 'Invalid JSON', rawLine: index + 1 + lineOffset };
    }
  });

  const isParsedLine = (line: ParsedLogLine): line is { kind: 'parsed'; entry: Record<string, unknown>; rawLine: number } => line.kind === 'parsed';

  const isWithinTimeWindow = (entry: Record<string, unknown>): boolean => {
    if (sinceMs === undefined && untilMs === undefined) return true;
    const ts = cliString(entry.ts);
    const parsedTs = ts ? Date.parse(ts) : Number.NaN;
    if (!Number.isFinite(parsedTs)) return false;
    return (sinceMs === undefined || parsedTs >= sinceMs) && (untilMs === undefined || parsedTs <= untilMs);
  };

  if (parsed.flags.get('summary') === true) {
    console.log(JSON.stringify(summarizeQueryLogLines(tailLines, {
      sinceMs,
      untilMs,
      tool: toolFilter,
      event: eventFilter,
      includeInvalid: includeInvalid,
      lineOffset,
    }), null, 2));
    return;
  }
  if (eventFilter !== undefined && toolFilter === undefined) {
    const filtered = parsedLines
      .filter(entry => {
        if (!isParsedLine(entry)) {
          return includeInvalid;
        }
        return matchesLogEvent(cliString(entry.entry.event), eventFilter)
          && isWithinTimeWindow(entry.entry);
      })
      .map(entry => {
        if (!isParsedLine(entry)) {
          return JSON.stringify({
            invalidLine: true,
            rawLine: entry.rawLine,
            raw: entry.raw,
            reason: entry.reason,
          });
        }
        return JSON.stringify(entry.entry);
      });
    console.log(filtered.join('\n'));
    return;
  }
  if (toolFilter !== undefined) {
    const filtered = parsedLines
      .filter(entry => {
        if (!isParsedLine(entry)) {
          return includeInvalid;
        }
        const toolName = cliString(entry.entry.toolName);
        const routedToolName = cliString(entry.entry.routedToolName);
        return (eventFilter === undefined || matchesLogEvent(cliString(entry.entry.event), eventFilter))
          && (toolName === toolFilter || routedToolName === toolFilter)
          && isWithinTimeWindow(entry.entry);
      })
      .map(entry => {
        if (!isParsedLine(entry)) {
          return JSON.stringify({
            invalidLine: true,
            rawLine: entry.rawLine,
            raw: entry.raw,
            reason: entry.reason,
          });
        }
        return JSON.stringify(entry.entry);
      });
    console.log(filtered.join('\n'));
    return;
  }

  if (sinceMs !== undefined || untilMs !== undefined) {
    const filtered = parsedLines
      .filter(entry => {
        if (!isParsedLine(entry)) {
          return includeInvalid;
        }
        return isWithinTimeWindow(entry.entry);
      })
      .map(entry => {
        if (!isParsedLine(entry)) {
          return JSON.stringify({
            invalidLine: true,
            rawLine: entry.rawLine,
            raw: entry.raw,
            reason: entry.reason,
          });
        }
        return JSON.stringify(entry.entry);
      });
    console.log(filtered.join('\n'));
    return;
  }

  if (!includeInvalid) {
    console.log(tailLines.join('\n'));
    return;
  }
  const output = parsedLines.map(entry => {
    if (!isParsedLine(entry)) {
      return JSON.stringify({
        invalidLine: true,
        rawLine: entry.rawLine,
        raw: entry.raw,
        reason: entry.reason,
      });
    }
    return JSON.stringify(entry.entry);
  });
  console.log(output.join('\n'));
}

function summarizeQueryLogLines(lines: string[], options?: {
  sinceMs?: number;
  untilMs?: number;
  tool?: string;
  event?: string;
  includeInvalid?: boolean;
  lineOffset?: number;
}): QueryLogSummary {
  const sinceMs = options?.sinceMs;
  const untilMs = options?.untilMs;
  const toolFilter = options?.tool;
  const eventFilter = options?.event;
  const includeInvalid = options?.includeInvalid === true;
  const lineOffset = options?.lineOffset ?? 0;
  const entries: Record<string, unknown>[] = [];
  let invalidLines = 0;
  const invalidSamples: Array<{ rawLine: number; raw: string; reason: string }> = [];
  for (const [index, line] of lines.entries()) {
    const rawLine = index + 1 + lineOffset;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isCliRecord(parsed)) {
        if (!matchesLogEvent(cliString(parsed.event), eventFilter)) {
          continue;
        }
        if (toolFilter !== undefined) {
          const toolName = cliString(parsed.toolName);
          const routedToolName = cliString(parsed.routedToolName);
          if (toolName !== toolFilter && routedToolName !== toolFilter) {
            continue;
          }
        }
        if (sinceMs !== undefined || untilMs !== undefined) {
          const ts = cliString(parsed.ts);
          const parsedTs = ts ? Date.parse(ts) : Number.NaN;
          if (!Number.isFinite(parsedTs)) {
            continue;
          }
          if ((sinceMs !== undefined && parsedTs < sinceMs) || (untilMs !== undefined && parsedTs > untilMs)) {
            continue;
          }
        }
        entries.push(parsed);
      } else {
        invalidLines++;
        if (includeInvalid) {
          invalidSamples.push({ rawLine, raw: line, reason: 'Not a JSON object' });
        }
      }
    } catch {
      invalidLines++;
      if (includeInvalid) {
        invalidSamples.push({ rawLine, raw: line, reason: 'Invalid JSON' });
      }
    }
  }

  const queryEntries = entries.filter(entry => entry.event === 'query');
  const tools = new Map<string, {
    count: number;
    stale: number;
    degraded: number;
    debugTimed: number;
    fallback: number;
    totalDurationMs: number;
    maxDurationMs: number;
  }>();
  let staleQueries = 0;
  let degradedQueries = 0;
  let debugTimedQueries = 0;
  let fallbackQueries = 0;
  let totalDurationMs = 0;
  let maxDurationMs = 0;
  let totalResponseChars = 0;
  const queryDurationsMs: number[] = [];

  for (const entry of queryEntries) {
    const toolName = cliString(entry.toolName) ?? 'unknown';
    const durationMs = cliNumber(entry.durationMs) ?? 0;
    const responseChars = cliNumber(entry.responseChars) ?? 0;
    const result = isCliRecord(entry.result) ? entry.result : {};
    const stale = isStaleLogResult(result);
    const degraded = result.degraded === true;
    const debugTimed = isCliRecord(result.debugTiming);
    const fallback = degraded || isCliRecord(entry.fallbackReason);

    if (stale) staleQueries++;
    if (degraded) degradedQueries++;
    if (debugTimed) debugTimedQueries++;
    if (fallback) fallbackQueries++;
    totalDurationMs += durationMs;
    maxDurationMs = Math.max(maxDurationMs, durationMs);
    queryDurationsMs.push(durationMs);
    totalResponseChars += responseChars;

    const tool = tools.get(toolName) ?? {
      count: 0,
      stale: 0,
      degraded: 0,
      debugTimed: 0,
      fallback: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
    };
    tool.count++;
    if (stale) tool.stale++;
    if (degraded) tool.degraded++;
    if (debugTimed) tool.debugTimed++;
    if (fallback) tool.fallback++;
    tool.totalDurationMs += durationMs;
    tool.maxDurationMs = Math.max(tool.maxDurationMs, durationMs);
    tools.set(toolName, tool);
  }

  return {
    totalEvents: entries.length,
    queryEvents: queryEntries.length,
    ...(includeInvalid ? { invalidSamples } : {}),
    invalidLines,
    staleQueries,
    degradedQueries,
    debugTimedQueries,
    fallbackQueries,
    totalResponseChars,
    durationMs: {
      avg: queryEntries.length ? Math.round(totalDurationMs / queryEntries.length) : 0,
      max: maxDurationMs,
      p95: queryDurationsMs.sort((a, b) => a - b).length
        ? queryDurationsMs[Math.max(0, Math.ceil(queryDurationsMs.length * 0.95) - 1)]
        : 0,
    },
    tools: Object.fromEntries([...tools.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([toolName, stats]) => [toolName, {
        count: stats.count,
        stale: stats.stale,
        degraded: stats.degraded,
        debugTimed: stats.debugTimed,
        fallback: stats.fallback,
        avgMs: Math.round(stats.totalDurationMs / Math.max(1, stats.count)),
        maxMs: stats.maxDurationMs,
      }])),
    slowest: queryEntries
      .slice()
      .sort((a, b) => (cliNumber(b.durationMs) ?? 0) - (cliNumber(a.durationMs) ?? 0))
      .slice(0, 5)
      .map(summarizeSlowLogEntry),
    filters: {
      ...(sinceMs === undefined ? {} : { since: new Date(sinceMs).toISOString() }),
      ...(untilMs === undefined ? {} : { until: new Date(untilMs).toISOString() }),
      ...(toolFilter === undefined ? {} : { tool: toolFilter }),
      ...(eventFilter === undefined ? {} : { event: eventFilter }),
    },
  };
}

function summarizeSlowLogEntry(entry: Record<string, unknown>): QueryLogSummary['slowest'][number] {
  const result = isCliRecord(entry.result) ? entry.result : {};
  const debugTiming = isCliRecord(result.debugTiming) ? result.debugTiming : undefined;
  const topPhase = debugTiming && isCliRecord(debugTiming.topPhase) ? debugTiming.topPhase : undefined;
  const fallbackReason = isCliRecord(entry.fallbackReason) ? entry.fallbackReason : undefined;
  return {
    ts: cliString(entry.ts),
    toolName: cliString(entry.toolName),
    routedToolName: cliString(entry.routedToolName),
    durationMs: cliNumber(entry.durationMs) ?? 0,
    responseChars: cliNumber(entry.responseChars) ?? 0,
    stale: isStaleLogResult(result),
    degraded: result.degraded === true,
    debugTimed: Boolean(debugTiming),
    topPhase: topPhase ? cliString(topPhase.name) : undefined,
    fallbackCode: fallbackReason ? cliString(fallbackReason.code) : undefined,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function isStaleLogResult(result: Record<string, unknown>): boolean {
  const indexFreshness = isCliRecord(result.indexFreshness) ? result.indexFreshness : undefined;
  const freshness = isCliRecord(result.freshness) ? result.freshness : undefined;
  return indexFreshness?.isStale === true || freshness?.isStale === true;
}

function cliNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function cliString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseLogSince(rawSince: string | undefined): number | undefined {
  if (!rawSince) return undefined;
  const parsed = Date.parse(rawSince);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid --since value: ${rawSince}. Use an ISO timestamp, for example 2026-06-22T12:34:56Z`);
  }
  return parsed;
}

function parseLogUntil(rawUntil: string | undefined): number | undefined {
  if (!rawUntil) return undefined;
  const parsed = Date.parse(rawUntil);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid --until value: ${rawUntil}. Use an ISO timestamp, for example 2026-06-22T12:34:56Z`);
  }
  return parsed;
}

const ALLOWED_LOG_EVENTS = ['query', 'watch'];

function parseLogEvent(rawEvent: string | undefined): string | undefined {
  if (!rawEvent) return undefined;
  const normalized = rawEvent.trim().toLowerCase();
  if (!normalized) {
    throw new Error(`Invalid --event value: ${rawEvent}. Supported events: ${ALLOWED_LOG_EVENTS.join(', ')}`);
  }
  const rootEvent = normalized.split('.', 1)[0];
  if (ALLOWED_LOG_EVENTS.includes(rootEvent)) return normalized;
  throw new Error(`Invalid --event value: ${rawEvent}. Supported events: ${ALLOWED_LOG_EVENTS.join(', ')}`);
}

function matchesLogEvent(entryEvent: string | undefined, eventFilter: string | undefined): boolean {
  if (eventFilter === undefined) return true;
  if (entryEvent === undefined) return false;
  return entryEvent === eventFilter || entryEvent.startsWith(`${eventFilter}.`);
}

function runRouteInspectCommand(parsed: ParsedArgs): void {
  const task = getFlag(parsed, 'task') ?? getFlag(parsed, 'target');
  if (!task) throw new Error('Usage: codegraph route-inspect --task "<task text>"');
  console.log(JSON.stringify(inspectCodeGraphRoute({
    task,
    target: getFlag(parsed, 'target'),
    mode: getFlag(parsed, 'mode') ?? 'auto',
    diff: getFlag(parsed, 'diff'),
    files: splitCsv(getFlag(parsed, 'files')),
    symbols: splitCsv(getFlag(parsed, 'symbols')),
    budgetTokens: getNumberFlag(parsed, 'budget-tokens'),
    profile: getFlag(parsed, 'profile'),
  }), null, 2));
}

function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      command.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags.set(key, true);
    } else {
      flags.set(key, next);
      i++;
    }
  }

  return { command, flags };
}

function getFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function requiredFlag(args: ParsedArgs, name: string): string {
  const value = getFlag(args, name);
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

function getNumberFlag(args: ParsedArgs, name: string): number | undefined {
  const value = getFlag(args, name);
  return value ? Number(value) : undefined;
}

function isCliRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value.split(',').map(part => part.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

function splitCodexModes(value: string | undefined): CodexBenchmarkMode[] | undefined {
  const parts = splitCsv(value);
  if (!parts) return undefined;
  const allowed = new Set<CodexBenchmarkMode>([
    'baseline',
    'terse-no-mcp',
    'natural-tool-use',
    'mcp-first',
    'mcp-only',
    'compiled-packet',
    'compiled-packet+gate',
    'oracle-packet',
  ]);
  for (const part of parts) {
    if (!allowed.has(part as CodexBenchmarkMode)) {
      throw new Error(`Unknown Codex benchmark mode: ${part}. Use baseline,terse-no-mcp,natural-tool-use,mcp-first,mcp-only,compiled-packet,compiled-packet+gate,oracle-packet.`);
    }
  }
  return parts as CodexBenchmarkMode[];
}

function indexProvidersFlag(args: ParsedArgs): string | undefined {
  return getFlag(args, 'index-providers') ?? process.env.CODEGRAPH_INDEX_PROVIDERS;
}

function scipIndexFlag(args: ParsedArgs): string | undefined {
  return getFlag(args, 'scip-index') ?? process.env.CODEGRAPH_SCIP_INDEX;
}

function shouldUseAutoTasks(args: ParsedArgs): boolean {
  return args.flags.get('auto-tasks') === true || getFlag(args, 'tasks') === 'auto';
}

function envFlag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name] ?? '');
}

function printHelp(): void {
  console.log(`
codegraph

Usage:
  codegraph mcp --root <workspace>       Run MCP stdio proxy
  codegraph setup --root <workspace>     Build .codegraph/graph.sqlite and local artifact index
  codegraph index --root <workspace>     Build or refresh the SQLite graph index
  codegraph atlas --root <workspace>     Generate deterministic repo atlas JSON/Markdown from indexed facts
  codegraph graph --root <workspace> --out <graph.html>
                                             Export a self-contained static HTML graph viewer
  codegraph doctor --root <workspace>    Inspect workspace graph configuration
  codegraph status --root <workspace>    Human-readable status report for workspace readiness
  codegraph upgrade-audit --root <workspace> [--policy <path>] [--min-score <number>] [--min-grade <grade>] [--max-slow-ms <number>] [--max-slow-ms-p95 <number>] [--max-invalid-lines <number>] [--max-stale-queries <number>] [--max-degraded-queries <number>] [--max-stale-ratio <percent>] [--max-degraded-ratio <percent>] [--tail <number>]
                                         Run a readiness + log health audit for super-VIP readiness
  codegraph logs --root <workspace> --tail <number> [--summary|--all]
                                         Print recent workspace query events or an aggregate summary
  codegraph route-inspect --task <text>  Explain codegraph_context routing and stop/follow-up gate policy
  codegraph benchmark generate|index|eval|proof|review|fallback|route-gate|copilot-e2e|codex-e2e|competitive-compare
                                             Generate synthetic repos, measure indexing, run evals, or prove context/review savings

Options:
  --root <path>                          Workspace root
  --tasks <path>                         Golden eval task JSON file
  --tasks auto                           Derive proof/review tasks from indexed-looking source files
  --suite <path>                         Route-gate or E2E suite JSON file
  --task <text|id>                       Route-inspect task text or benchmark task id
  --task-count <number>                  Number of auto-derived proof/review tasks
  --no-index                             Reuse the current proof/review/graph snapshot instead of refreshing first
  --out <path>                           Output path for graph HTML export
  --format <json|markdown>               Atlas output format (default: json)
  --profile <micro|compact|full>         Atlas or pack output profile (default: compact)
  --max-modules <number>                 Maximum modules in atlas
  --max-entrypoints <number>             Maximum endpoints in atlas
  --max-hotspots <number>                Maximum change-risk hotspots in atlas
  --no-tests                             Exclude test/mock files from atlas module and flow summaries
  --max-nodes <number>                   Maximum graph nodes for static export (default: 800)
  --max-edges <number>                   Maximum graph edges for static export (default: 2000)
  --include-tests                        Include test and mock files in graph export
  --include-generated                    Include generated files in graph export
  --parse-workers <number>               Worker threads for cold/cache-miss parsing during index
  --max-files <number>                   Max files for setup artifact indexing
  --max-file-bytes <number>              Max file size for setup artifact indexing
  --max-content-bytes <number>           Max bytes read per file for setup artifact terms/symbols
  --index-providers <a,b>                Index providers: tree-sitter, scip
  --scip-index <path>                    SCIP JSON or .scip index path for the scip provider
  --no-incremental                       Force changed-file index runs through full snapshot rebuild
  --incremental-file-limit <number>      Max changed/deleted files for incremental index path
  --workspace-key <key>                  Stable workspace identity key, useful when Docker always mounts roots at /workspace
  --quiet                                Suppress index progress logs on stderr
  --auto-refresh                         Refresh stale snapshots automatically before MCP tool calls
  --refresh-on-start                     Queue a workspace refresh when MCP starts, without blocking startup
  --watch                                Watch workspace files and queue background refreshes on changes
  --warn-stale                           Include freshness checks in MCP tool responses
  --since <ISO timestamp>                Filter logs to events at/after this timestamp
  --until <ISO timestamp>                Filter logs to events at/before this timestamp
  --all                                  Process full log history instead of only the last --tail entries
  --invalid                              Include unparseable log lines in raw output / invalidSamples in summary
  --tool <name>                          For raw logs: include only matching toolName or routedToolName; for summary: filter scope
  --event <name>                         Include only matching event in logs and summary (query, watch, watch.*)
  --json                                 Print machine-readable status JSON for status/doctor
  --require-ready                        Force non-zero exit code if workspace is not in "ready" state
  --require-fresh                        Force non-zero exit code unless workspace is ready and fresh
  --policy <path>                        Path to upgrade-audit policy JSON (default: .codegraph/upgrade-audit.json in root).
                                         Fallback: CODEGRAPH_UPGRADE_AUDIT_POLICY environment variable.
  --min-score <number>                   Fail unless upgrade audit score is at least this value.
                                         Fallback: CODEGRAPH_UPGRADE_AUDIT_MIN_SCORE environment variable.
  --min-grade <A+|A|B+|B|C|D|F>         Fail unless upgrade-audit grade is at least this value.
                                         Fallback: CODEGRAPH_UPGRADE_AUDIT_MIN_GRADE environment variable.
  --max-slow-ms <number>                 Fail unless max query duration is at most this value.
                                          Fallback: CODEGRAPH_UPGRADE_AUDIT_MAX_SLOW_MS environment variable.
  --max-slow-ms-p95 <number>             Fail unless 95th percentile query duration is at most this value.
                                          Fallback: CODEGRAPH_UPGRADE_AUDIT_MAX_SLOW_MS_P95 environment variable.
  --max-invalid-lines <number>            Fail unless invalid logged JSON lines are at most this value.
                                          Fallback: CODEGRAPH_UPGRADE_AUDIT_MAX_INVALID_LINES environment variable.
  --max-stale-queries <number>           Fail unless stale query count is at most this value.
                                          Fallback: CODEGRAPH_UPGRADE_AUDIT_MAX_STALE_QUERIES environment variable.
  --max-degraded-queries <number>         Fail unless degraded query count is at most this value.
                                          Fallback: CODEGRAPH_UPGRADE_AUDIT_MAX_DEGRADED_QUERIES environment variable.
  --max-stale-ratio <percent>             Fail unless stale query ratio is at most this value.
                                          Fallback: CODEGRAPH_UPGRADE_AUDIT_MAX_STALE_RATIO environment variable.
  --max-degraded-ratio <percent>          Fail unless degraded query ratio is at most this value.
                                          Fallback: CODEGRAPH_UPGRADE_AUDIT_MAX_DEGRADED_RATIO environment variable.
  --prewarm                             Index missing snapshots inside MCP startup/runtime. Off by default; prefer explicit index/setup.
  --mcp-profile <client|minimal|research|change|review|full>
                                             Tool surface for MCP. Default/client exposes facade tools; full exposes every tool.
  --models <a,b,c>                       Copilot E2E model list for benchmark copilot-e2e
  --modes <codegraph,baseline>           Copilot E2E comparison modes
  --modes <baseline,terse-no-mcp,natural-tool-use,mcp-first,mcp-only,compiled-packet,compiled-packet+gate,oracle-packet>
                                             Codex E2E comparison modes
  --task-ids <a,b,c>                     Copilot/Codex E2E task ids
  --run-dir <path>                       Output directory for E2E benchmark artifacts
  --codex-command <path>                 Codex CLI executable for benchmark codex-e2e
  --codex-command-args <a,b>             Args before "exec", e.g. "-y,@openai/codex" for npx.cmd
  --use-user-config                      Keep Codex user config enabled for wrapper/proxy provider tests
  --mcp-server-name <name>               MCP server name exposed to Codex E2E prompts (default codegraph_bench)
  --mcp-command <path>                   MCP server command for benchmark codex-e2e competitor arms
  --mcp-command-args <a,b>               MCP server args for benchmark codex-e2e competitor arms
  --ours <report.json>                   This project report for benchmark competitive-compare
  --theirs <report.json>                 Competitor report for benchmark competitive-compare
  --ours-label <name>                    Label for this project in competitive comparison output
  --theirs-label <name>                  Label for competitor in competitive comparison output
  --format <json|markdown>               Output format for benchmark competitive-compare
  --codex-timeout-seconds <number>       Timeout per Codex task run
  --dry-run                              Print benchmark plan without running Copilot/Codex
  --skip-preflight                       Skip Codex E2E SQLite preflight for external MCP server arms
`);
}

function createIndexProgressReporter(dbPath: string): (event: IndexProgressEvent) => void {
  const startedAt = Date.now();
  let lastLineAt = 0;
  let lastPhase = '';

  return (event: IndexProgressEvent) => {
    const now = Date.now();
    const force = event.phase !== lastPhase
      || event.status === 'start'
      || event.status === 'complete'
      || event.status === 'skipped'
      || event.status === 'fallback';
    if (!force && now - lastLineAt < 5_000) return;

    lastLineAt = now;
    lastPhase = event.phase;

    const elapsed = formatDuration(event.elapsedMs ?? now - startedAt);
    const count = formatProgressCount(event.current, event.total);
    const message = event.message ? ` ${shorten(event.message, 140)}` : '';
    const details = formatProgressDetails(event.details);
    const db = event.phase === 'start' ? ` db=${dbPath}` : '';
    process.stderr.write(`[codegraph:index] ${elapsed} ${event.phase}:${event.status}${count}${message}${details}${db}\n`);
  };
}

function formatProgressCount(current: number | undefined, total: number | undefined): string {
  if (current === undefined) return '';
  if (total === undefined || total <= 0) return ` ${current.toLocaleString()}`;
  const percent = Math.floor((current / total) * 100);
  return ` ${current.toLocaleString()}/${total.toLocaleString()} ${percent}%`;
}

function formatProgressDetails(details: IndexProgressEvent['details']): string {
  if (!details) return '';
  const pairs = Object.entries(details)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`);
  return pairs.length > 0 ? ` ${pairs.join(' ')}` : '';
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds.toString().padStart(2, '0')}s` : `${seconds}s`;
}

function shorten(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
