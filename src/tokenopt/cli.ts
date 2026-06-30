#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { runBenchmarkCommand } from "./benchmark.js";
import { runCodexBenchmarkCommand } from "./codex-benchmark.js";
import { setupCopilotProject, type CopilotGatewayLevel, type CopilotSetupScope } from "./copilot-setup.js";
import { runSuiteBenchmarkCommand } from "./suite-benchmark.js";
import { runWorkflowAbBenchmarkCommand } from "./workflow-ab-benchmark.js";
import { loadConfig, makeDefaultRepoConfig, ensureConfigDir } from "./config.js";
import { handleCodexHook } from "./codex-adapter.js";
import { handleCopilotHook } from "./copilot-adapter.js";
import { runCodexHooksDoctor, runCopilotDoctor, runDoctor } from "./doctor.js";
import { runWrappedCommand } from "./exec.js";
import { installCodexHooks } from "./install.js";
import {
  auditInstructions,
  emitTokenOptInstructions,
  formatInstructionGraphPlan,
  formatNativePromptPackPlan,
  installInstructionGraph,
  installNativePromptPack,
  installTokenOptInstructions,
  type InstructionTarget
} from "./instruction-audit.js";
import { runMcpServer } from "./mcp.js";
import { appendEvent } from "./observability.js";
import { buildReport } from "./report.js";
import type { TokenOptHookEventName } from "./types.js";

const CODEX_HOOK_EVENTS = new Set<TokenOptHookEventName>(["user-prompt-submit", "pre-tool-use", "post-tool-use", "pre-compact"]);
const COPILOT_HOOK_EVENTS = new Set<TokenOptHookEventName>(["user-prompt-submit", "pre-tool-use", "post-tool-use", "pre-compact", "agent-stop"]);

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

  if (command === "install" && subcommand === "codex") {
    const scope = parseScope(rest);
    const loaded = loadConfig();
    const hooksPath = installCodexHooks(scope, scope === "repo" ? loaded.repoRoot : process.cwd());
    appendEvent(loaded.config, {
      timestamp: new Date().toISOString(),
      source: "cli",
      eventName: "install-codex",
      repoRoot: loaded.repoRoot,
      action: "install",
      metadata: { scope, hooksPath }
    });
    process.stdout.write(`Installed TokenOpt Codex hooks: ${hooksPath}\nRun /hooks in Codex to review and trust them.\n`);
    return 0;
  }

  if ((command === "setup" && subcommand === "copilot") || (command === "install" && subcommand === "copilot")) {
    const loaded = loadConfig();
    const options = parseCopilotSetupOptions(rest);
    const result = setupCopilotProject({
      repoRoot: loaded.repoRoot,
      ...options
    });
    appendEvent(loaded.config, {
      timestamp: new Date().toISOString(),
      source: "cli",
      eventName: "install-copilot",
      repoRoot: loaded.repoRoot,
      action: "install",
      metadata: {
        scope: options.scope,
        files: result.files,
        mcpConfigPath: result.mcpConfigPath,
        vscodeMcpConfigPath: result.vscodeMcpConfigPath,
        installAgents: options.installAgents,
        installPrompts: options.installPrompts,
        includeRunCommand: options.includeRunCommand,
        includeCodeGraph: options.includeCodeGraph,
        gatewayLevel: options.gatewayLevel,
        codeGraphConfigured: result.codeGraphConfigured,
        codeGraphCliPath: result.codeGraphCliPath,
        hookConfigPath: result.hookConfigPath
      }
    });
    process.stdout.write(formatCopilotSetupResult(result));
    return 0;
  }

  if (command === "hook" && subcommand === "codex") {
    const eventName = rest[0] as TokenOptHookEventName | undefined;
    if (!eventName || !CODEX_HOOK_EVENTS.has(eventName)) {
      process.stderr.write("Usage: tokenopt hook codex user-prompt-submit|pre-tool-use|post-tool-use|pre-compact\n");
      return 2;
    }
    await handleCodexHook(eventName);
    return 0;
  }

  if (command === "hook" && subcommand === "copilot") {
    const eventName = rest[0] as TokenOptHookEventName | undefined;
    if (!eventName || !COPILOT_HOOK_EVENTS.has(eventName)) {
      process.stderr.write("Usage: tokenopt hook copilot user-prompt-submit|pre-tool-use|post-tool-use|pre-compact|agent-stop\n");
      return 2;
    }
    await handleCopilotHook(eventName);
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

  if (command === "benchmark") {
    if (subcommand === "workflow-ab") {
      return runWorkflowAbBenchmarkCommand(rest);
    }
    if (subcommand === "suite") {
      return runSuiteBenchmarkCommand(rest);
    }
    if (subcommand === "codex-daily") {
      return runCodexBenchmarkCommand(rest);
    }
    return runBenchmarkCommand([subcommand, ...rest].filter((value): value is string => Boolean(value)));
  }

  if (command === "instructions" && subcommand === "audit") {
    const loaded = loadConfig();
    const report = auditInstructions(loaded.repoRoot);
    appendEvent(loaded.config, {
      timestamp: new Date().toISOString(),
      source: "cli",
      eventName: "instructions-audit",
      repoRoot: loaded.repoRoot,
      action: "audit"
    });
    process.stdout.write(`${report}\n`);
    return 0;
  }

  if (command === "instructions" && subcommand === "emit") {
    const target = parseInstructionTarget(rest, "generic");
    process.stdout.write(`${emitTokenOptInstructions(target)}\n`);
    return 0;
  }

  if (command === "instructions" && subcommand === "graph") {
    const loaded = loadConfig();
    process.stdout.write(`${formatInstructionGraphPlan(loaded.repoRoot)}\n`);
    return 0;
  }

  if (command === "instructions" && subcommand === "prompts") {
    const loaded = loadConfig();
    process.stdout.write(`${formatNativePromptPackPlan(loaded.repoRoot)}\n`);
    return 0;
  }

  if (command === "instructions" && subcommand === "install-graph") {
    const loaded = loadConfig();
    const files = installInstructionGraph(loaded.repoRoot);
    appendEvent(loaded.config, {
      timestamp: new Date().toISOString(),
      source: "cli",
      eventName: "instructions-install-graph",
      repoRoot: loaded.repoRoot,
      action: "install",
      metadata: { files }
    });
    process.stdout.write(`Installed TokenOpt instruction graph:\n${files.map((filePath) => `- ${filePath}`).join("\n")}\n`);
    return 0;
  }

  if (command === "instructions" && subcommand === "install-prompts") {
    const loaded = loadConfig();
    const files = installNativePromptPack(loaded.repoRoot);
    appendEvent(loaded.config, {
      timestamp: new Date().toISOString(),
      source: "cli",
      eventName: "instructions-install-prompts",
      repoRoot: loaded.repoRoot,
      action: "install",
      metadata: { files }
    });
    process.stdout.write(`Installed TokenOpt native prompt files:\n${files.map((filePath) => `- ${filePath}`).join("\n")}\n`);
    return 0;
  }

  if (command === "instructions" && subcommand === "install") {
    const target = parseInstructionTarget(rest, "agents");
    if (target === "generic") {
      process.stderr.write("Usage: tokenopt instructions install --target agents|codex|copilot|copilot-path|copilot-agent\n");
      return 2;
    }
    const loaded = loadConfig();
    const filePath = installTokenOptInstructions(loaded.repoRoot, target);
    appendEvent(loaded.config, {
      timestamp: new Date().toISOString(),
      source: "cli",
      eventName: "instructions-install",
      repoRoot: loaded.repoRoot,
      action: "install",
      metadata: { target, filePath }
    });
    process.stdout.write(`Installed TokenOpt MCP instructions: ${filePath}\n`);
    return 0;
  }

  if (command === "report") {
    const loaded = loadConfig();
    process.stdout.write(`${buildReport(loaded.config, loaded.repoRoot)}\n`);
    return 0;
  }

  if (command === "doctor" && subcommand === "codex-hooks") {
    const loaded = loadConfig();
    const output = runCodexHooksDoctor(loaded);
    appendEvent(loaded.config, {
      timestamp: new Date().toISOString(),
      source: "cli",
      eventName: "doctor-codex-hooks",
      repoRoot: loaded.repoRoot,
      action: "doctor"
    });
    process.stdout.write(`${output}\n`);
    return output.includes("[ok] hook canary") ? 0 : 1;
  }

  if (command === "doctor" && subcommand === "copilot") {
    const loaded = loadConfig();
    const output = runCopilotDoctor(loaded);
    appendEvent(loaded.config, {
      timestamp: new Date().toISOString(),
      source: "cli",
      eventName: "doctor-copilot",
      repoRoot: loaded.repoRoot,
      action: "doctor"
    });
    process.stdout.write(`${output}\n`);
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

function parseScope(args: string[]): "user" | "repo" {
  const scopeIndex = args.indexOf("--scope");
  if (scopeIndex >= 0) {
    const value = args[scopeIndex + 1];
    if (value === "user" || value === "repo") {
      return value;
    }
    throw new Error("--scope must be user or repo");
  }
  return "repo";
}

function parseCopilotSetupOptions(args: string[]): {
  scope: CopilotSetupScope;
  installAgents: boolean;
  installPrompts: boolean;
  tokenoptCliPath?: string;
  vscodeMcpConfigPath?: string;
  includeRunCommand: boolean;
  includeCodeGraph?: boolean;
  codeGraphCliPath?: string;
  codeGraphRoot?: string;
  gatewayLevel?: CopilotGatewayLevel;
} {
  let scope: CopilotSetupScope = "both";
  let installAgents = true;
  let installPrompts = true;
  let includeRunCommand = false;
  let includeCodeGraph: boolean | undefined;
  let tokenoptCliPath: string | undefined;
  let vscodeMcpConfigPath: string | undefined;
  let codeGraphCliPath: string | undefined;
  let codeGraphRoot: string | undefined;
  let gatewayLevel: CopilotGatewayLevel | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--scope") {
      const value = args[index + 1];
      if (value !== "user" && value !== "repo" && value !== "both") {
        throw new Error("--scope must be user, repo, or both");
      }
      scope = value;
      index += 1;
      continue;
    }
    if (arg === "--with-agents") {
      installAgents = true;
      continue;
    }
    if (arg === "--no-agents") {
      installAgents = false;
      continue;
    }
    if (arg === "--with-prompts") {
      installPrompts = true;
      continue;
    }
    if (arg === "--no-prompts") {
      installPrompts = false;
      continue;
    }
    if (arg === "--tokenopt-path") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--tokenopt-path requires a path");
      }
      tokenoptCliPath = value;
      index += 1;
      continue;
    }
    if (arg === "--vscode-mcp-config") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--vscode-mcp-config requires a path");
      }
      vscodeMcpConfigPath = value;
      index += 1;
      continue;
    }
    if (arg === "--no-run-command") {
      includeRunCommand = false;
      continue;
    }
    if (arg === "--include-run-command") {
      includeRunCommand = true;
      continue;
    }
    if (arg === "--include-codegraph") {
      includeCodeGraph = true;
      continue;
    }
    if (arg === "--gateway-level") {
      const value = args[index + 1];
      if (value !== "routing" && value !== "policy") {
        throw new Error("--gateway-level must be routing or policy");
      }
      gatewayLevel = value;
      index += 1;
      continue;
    }
    if (arg === "--no-codegraph") {
      includeCodeGraph = false;
      continue;
    }
    if (arg === "--codegraph-cli") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--codegraph-cli requires a path");
      }
      codeGraphCliPath = value;
      includeCodeGraph = true;
      index += 1;
      continue;
    }
    if (arg === "--codegraph-root") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--codegraph-root requires a path");
      }
      codeGraphRoot = value;
      includeCodeGraph = true;
      index += 1;
      continue;
    }
    throw new Error(`Unknown Copilot setup option: ${arg}`);
  }

  return { scope, installAgents, installPrompts, tokenoptCliPath, vscodeMcpConfigPath, includeRunCommand, includeCodeGraph, codeGraphCliPath, codeGraphRoot, gatewayLevel };
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

function parseInstructionTarget(args: string[], fallback: InstructionTarget): InstructionTarget {
  const targetIndex = args.indexOf("--target");
  const value = targetIndex >= 0 ? args[targetIndex + 1] : fallback;
  if (value === "agents" || value === "codex" || value === "copilot" || value === "copilot-path" || value === "copilot-agent" || value === "generic") {
    return value;
  }
  throw new Error("--target must be agents, codex, copilot, copilot-path, copilot-agent, or generic");
}

function formatCopilotSetupResult(result: {
  repoRoot: string;
  files: string[];
  warnings: string[];
  nextSteps: string[];
  mcpConfigPath?: string;
  vscodeMcpConfigPath?: string;
  hookConfigPath?: string;
  codeGraphConfigured?: boolean;
  codeGraphCliPath?: string;
}): string {
  const lines = [
    "TokenOpt Copilot setup",
    "",
    `repo: ${result.repoRoot}`,
    `codegraph: ${result.codeGraphConfigured ? `configured (${result.codeGraphCliPath ?? "detected"})` : "not configured"}`,
    `copilot cli mcp: ${result.mcpConfigPath ?? "not written"}`,
    `vs code mcp: ${result.vscodeMcpConfigPath ?? "not written"}`,
    `copilot hooks: ${result.hookConfigPath ?? "not written"}`,
    "",
    "files:",
    ...result.files.map((filePath) => `- ${filePath}`),
    "",
    "next steps:",
    ...result.nextSteps.map((step) => `- ${step}`)
  ];
  if (result.warnings.length > 0) {
    lines.push("", "warnings:", ...result.warnings.map((warning) => `- ${warning}`));
  }
  return `${lines.join("\n")}\n`;
}

function helpText(): string {
  return `TokenOpt CLI

Commands:
  tokenopt init
  tokenopt install codex --scope user|repo
  tokenopt setup copilot --scope user|repo|both [--gateway-level routing|policy] [--no-agents] [--no-prompts] [--include-run-command] [--vscode-mcp-config <path>] [--include-codegraph --codegraph-root <path>|--codegraph-cli <path>]
  tokenopt install copilot --scope user|repo|both [--gateway-level routing|policy] [--no-agents] [--no-prompts] [--include-run-command] [--vscode-mcp-config <path>] [--include-codegraph --codegraph-root <path>|--codegraph-cli <path>]
  tokenopt hook codex user-prompt-submit|pre-tool-use|post-tool-use|pre-compact
  tokenopt hook copilot user-prompt-submit|pre-tool-use|post-tool-use|pre-compact|agent-stop
  tokenopt exec -- <command...>
  tokenopt mcp [--mode lite|full]
  tokenopt benchmark daily --repo <path> [--mode all]
  tokenopt benchmark codex-daily --repo <path> [--mode all]
  tokenopt benchmark suite --suite <json> --repo <path> [--mode baseline|codegraph|codegraph-only|tokenopt-only|tokenopt-codegraph|tokenopt-codegraph-natural|tokenopt-codegraph-adaptive|tokenopt-codegraph-hybrid|natural|contextgate|contextgate-natural|mcp-first|mcp-only|compiled-hard-gate|router-strict|router-best|all]
  tokenopt benchmark workflow-ab --repo <path> --feature-file <json|txt> [--workflow baseline,tokenopt,speckit,speckit-only,speckit-tokenopt,speckit-gate-first,speckit-compact,tokenopt-prompt-chain]
  tokenopt instructions audit
  tokenopt instructions emit --target agents|codex|copilot|copilot-path|copilot-agent
  tokenopt instructions graph
  tokenopt instructions prompts
  tokenopt instructions install-graph
  tokenopt instructions install-prompts
  tokenopt instructions install --target agents|codex|copilot|copilot-path|copilot-agent
  tokenopt report
  tokenopt doctor
  tokenopt doctor codex-hooks
  tokenopt doctor copilot
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
