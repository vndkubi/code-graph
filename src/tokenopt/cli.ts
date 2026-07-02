#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, makeDefaultRepoConfig, ensureConfigDir } from "./config.js";
import { runDoctor } from "./doctor.js";
import { runWrappedCommand } from "./exec.js";
import { runMcpServer } from "./mcp.js";
import { appendEvent } from "./observability.js";
import { buildReport } from "./report.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, subcommand, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(helpText());
    return 0;
  }

  if (command === "init") {
    const loaded = loadConfig();
    ensureConfigDir(loaded.repoConfigPath);
    if (fs.existsSync(loaded.repoConfigPath)) {
      process.stdout.write(`TokenOpt config already exists: ${loaded.repoConfigPath}\n`);
      return 0;
    }
    fs.writeFileSync(loaded.repoConfigPath, `${JSON.stringify(makeDefaultRepoConfig(), null, 2)}\n`, "utf8");
    process.stdout.write(`Created ${loaded.repoConfigPath}\n`);
    return 0;
  }

  if (command === "exec") {
    const separatorIndex = argv.indexOf("--");
    const commandArgs = separatorIndex >= 0 ? argv.slice(separatorIndex + 1) : argv.slice(1);
    const loaded = loadConfig();
    return runWrappedCommand(commandArgs, loaded.config, loaded.repoRoot);
  }

  if (command === "mcp") {
    const mode = parseMcpMode([subcommand, ...rest].filter((value): value is string => Boolean(value)));
    if (mode) {
      process.env.TOKENOPT_MCP_MODE = mode;
    }
    await runMcpServer();
    return 0;
  }

  if (command === "report") {
    const loaded = loadConfig();
    process.stdout.write(`${buildReport(loaded.config, loaded.repoRoot)}\n`);
    return 0;
  }

  if (command === "doctor") {
    const loaded = loadConfig();
    const output = runDoctor(loaded);
    appendEvent(loaded.config, {
      timestamp: new Date().toISOString(),
      source: "cli",
      eventName: "doctor",
      repoRoot: loaded.repoRoot,
      action: "doctor"
    });
    process.stdout.write(`${output}\n`);
    return 0;
  }

  process.stderr.write(`Unknown command: ${argv.join(" ")}\n\n${helpText()}`);
  return 2;
}

function parseMcpMode(args: string[]): "lite" | "full" | "broker" | undefined {
  if (args.length === 0) {
    return undefined;
  }
  const modeIndex = args.indexOf("--mode");
  if (modeIndex < 0) {
    throw new Error("Usage: tokenopt mcp [--mode lite|full|broker]");
  }
  const mode = args[modeIndex + 1];
  if (mode !== "lite" && mode !== "full" && mode !== "broker") {
    throw new Error("--mode must be lite, full, or broker");
  }
  return mode;
}

function helpText(): string {
  return `TokenOpt gate CLI (also available as \`codegraph gate <command>\`)

Commands:
  tokenopt init
  tokenopt exec -- <command...>
  tokenopt mcp [--mode lite|full]
  tokenopt report
  tokenopt doctor

The fused CodeGraph MCP server (\`codegraph mcp\`) already exposes the gate
tools in-process; \`tokenopt mcp\` runs the standalone gate-only server.
`;
}

if (isDirectInvocation()) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

function isDirectInvocation(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
