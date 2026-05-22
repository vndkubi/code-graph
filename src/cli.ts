#!/usr/bin/env node

import fs from 'node:fs';
import { openCodeGraphDb } from './v2/storage/database.js';
import { V2Indexer } from './v2/index/indexer.js';
import { runDaemon } from './v2/daemon/server.js';
import { DaemonClient, stopDaemon } from './v2/daemon/client.js';
import { runMcpProxy } from './v2/mcp/proxy.js';
import { getCodeGraphPaths } from './v2/paths.js';
import { generateSyntheticJavaRepo } from './v2/benchmark/synthetic-java.js';
import { runIndexBenchmark } from './v2/benchmark/run.js';
import { loadGoldenEvalTasks, runGoldenEval } from './v2/benchmark/golden-eval.js';

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
        homeDir: getFlag(parsed, 'home'),
        prewarm: parsed.flags.get('no-prewarm') !== true,
        workspaceKey: getFlag(parsed, 'workspace-key') ?? process.env.CODEGRAPH_WORKSPACE_KEY,
        autoRefresh: parsed.flags.get('auto-refresh') === true || envFlag('CODEGRAPH_AUTO_REFRESH'),
      });
      return;
    case 'daemon':
      await runDaemonCommand(subcommand, parsed);
      return;
    case 'index':
      await runIndexCommand(parsed);
      return;
    case 'doctor':
      await runDoctorCommand(parsed);
      return;
    case 'logs':
      await runLogsCommand(parsed);
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
      console.log(JSON.stringify(runIndexBenchmark(root, getFlag(parsed, 'home')), null, 2));
      return;
    }
    case 'eval': {
      const root = getFlag(parsed, 'root') ?? process.cwd();
      const { db } = openCodeGraphDb(getFlag(parsed, 'home'));
      try {
        const tasks = loadGoldenEvalTasks(getFlag(parsed, 'tasks'));
        console.log(JSON.stringify(runGoldenEval(db, root, tasks), null, 2));
      } finally {
        db.close();
      }
      return;
    }
    default:
      throw new Error('Usage: codegraph benchmark generate|index|eval');
  }
}

async function runDaemonCommand(subcommand: string | undefined, parsed: ParsedArgs): Promise<void> {
  switch (subcommand) {
    case 'run':
      await runDaemon({
        homeDir: getFlag(parsed, 'home'),
        port: getNumberFlag(parsed, 'port'),
      });
      return;
    case 'start':
      await DaemonClient.ensure(getFlag(parsed, 'home'));
      console.log('codegraph daemon is running');
      return;
    case 'stop':
      console.log(await stopDaemon(getFlag(parsed, 'home')) ? 'codegraph daemon stopped' : 'codegraph daemon was not running');
      return;
    case 'status': {
      const client = await DaemonClient.ensure(getFlag(parsed, 'home'));
      console.log(JSON.stringify(await client.status(), null, 2));
      return;
    }
    default:
      throw new Error('Usage: codegraph daemon start|stop|status|run');
  }
}

async function runIndexCommand(parsed: ParsedArgs): Promise<void> {
  const root = getFlag(parsed, 'root') ?? process.cwd();
  const { db, paths } = openCodeGraphDb(getFlag(parsed, 'home'));
  const indexer = new V2Indexer(db);
  const result = indexer.indexWorkspace({
    root,
    workspaceKey: getFlag(parsed, 'workspace-key') ?? process.env.CODEGRAPH_WORKSPACE_KEY,
  });
  console.log(JSON.stringify({ ...result, dbPath: paths.dbPath }, null, 2));
}

async function runDoctorCommand(parsed: ParsedArgs): Promise<void> {
  const paths = getCodeGraphPaths(getFlag(parsed, 'home'));
  const daemon = DaemonClient.readInfo(getFlag(parsed, 'home'));
  const client = daemon ? new DaemonClient(daemon) : undefined;
  const daemonAlive = client ? await client.isAlive() : false;
  const daemonStatus = daemonAlive && client ? await client.status().catch(() => undefined) : undefined;
  console.log(JSON.stringify({
    homeDir: paths.homeDir,
    dbPath: paths.dbPath,
    daemonInfoPath: paths.daemonInfoPath,
    daemonLogPath: paths.daemonLogPath,
    daemonKnown: Boolean(daemon),
    daemonAlive,
    daemonStatus,
  }, null, 2));
}

async function runLogsCommand(parsed: ParsedArgs): Promise<void> {
  const paths = getCodeGraphPaths(getFlag(parsed, 'home'));
  const tail = Math.max(1, Math.min(getNumberFlag(parsed, 'tail') ?? 50, 1000));
  if (!fs.existsSync(paths.daemonLogPath)) {
    console.log(`No daemon log found at ${paths.daemonLogPath}`);
    return;
  }
  const lines = fs.readFileSync(paths.daemonLogPath, 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-tail);
  console.log(lines.join('\n'));
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

function getNumberFlag(args: ParsedArgs, name: string): number | undefined {
  const value = getFlag(args, name);
  return value ? Number(value) : undefined;
}

function envFlag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name] ?? '');
}

function printHelp(): void {
  console.log(`
codegraph

Usage:
  codegraph mcp --root <workspace>       Run MCP stdio proxy and auto-start daemon
  codegraph daemon start|stop|status     Manage local daemon
  codegraph index --root <workspace>     Prewarm persistent index
  codegraph doctor                       Inspect local configuration
  codegraph logs --tail <number>         Print recent daemon query/index events
  codegraph benchmark generate|index|eval Generate synthetic repos, measure indexing, or run golden evals

Options:
  --root <path>                          Workspace root
  --home <path>                          Override CODEGRAPH_HOME
  --port <number>                        Daemon port for daemon run
  --tasks <path>                         Golden eval task JSON file
  --workspace-key <key>                  Stable workspace identity key, useful when Docker always mounts roots at /workspace
  --auto-refresh                         Refresh stale snapshots automatically before MCP tool calls
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
