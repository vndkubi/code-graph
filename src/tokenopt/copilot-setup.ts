import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installNativePromptPack, installTokenOptInstructions } from "./instruction-audit.js";

export type CopilotSetupScope = "user" | "repo" | "both";
export type CopilotGatewayLevel = "routing" | "policy";

export const TOKENOPT_COPILOT_LITE_MCP_TOOLS = [
  "contextgate_get_context",
  "tokenopt_compile_evidence",
  "tokenopt_search",
  "tokenopt_read_file"
] as const;

export const TOKENOPT_COPILOT_MCP_TOOLS = [
  ...TOKENOPT_COPILOT_LITE_MCP_TOOLS,
  "tokenopt_run_command",
  "tokenopt_project_facts"
] as const;

export const CODEGRAPH_COPILOT_MCP_TOOLS = [
  "codegraph_context",
  "codegraph_slice",
  "codegraph_status"
] as const;

export interface CopilotSetupOptions {
  repoRoot: string;
  scope?: CopilotSetupScope;
  installAgents?: boolean;
  tokenoptCliPath?: string;
  copilotConfigPath?: string;
  vscodeMcpConfigPath?: string;
  includeRunCommand?: boolean;
  installPrompts?: boolean;
  includeCodeGraph?: boolean;
  codeGraphCliPath?: string;
  codeGraphRoot?: string;
  gatewayLevel?: CopilotGatewayLevel;
}

export interface CopilotSetupResult {
  repoRoot: string;
  files: string[];
  warnings: string[];
  nextSteps: string[];
  mcpConfigPath?: string;
  vscodeMcpConfigPath?: string;
  copilotInstructionsPath: string;
  copilotPathInstructionsPath: string;
  agentsPath?: string;
  copilotAgentPath?: string;
  promptFiles: string[];
  hookConfigPath?: string;
  codeGraphConfigured: boolean;
  codeGraphCliPath?: string;
}

export function setupCopilotProject(options: CopilotSetupOptions): CopilotSetupResult {
  const repoRoot = path.resolve(options.repoRoot);
  const scope = options.scope ?? "both";
  const installAgents = options.installAgents ?? true;
  const installPrompts = options.installPrompts ?? true;
  const includeRunCommand = options.includeRunCommand ?? false;
  const gatewayLevel = options.gatewayLevel ?? "routing";
  const files: string[] = [];
  const warnings: string[] = [];
  const nextSteps: string[] = [];

  const copilotInstructionsPath = installTokenOptInstructions(repoRoot, "copilot");
  files.push(copilotInstructionsPath);
  const copilotPathInstructionsPath = installTokenOptInstructions(repoRoot, "copilot-path");
  files.push(copilotPathInstructionsPath);

  let agentsPath: string | undefined;
  let copilotAgentPath: string | undefined;
  if (installAgents) {
    agentsPath = installTokenOptInstructions(repoRoot, "agents");
    files.push(agentsPath);
    copilotAgentPath = installTokenOptInstructions(repoRoot, "copilot-agent");
    files.push(copilotAgentPath);
  }

  const promptFiles = installPrompts ? installNativePromptPack(repoRoot) : [];
  files.push(...promptFiles);

  let hookConfigPath: string | undefined;
  if (gatewayLevel === "policy") {
    hookConfigPath = installCopilotGatewayHooks({
      repoRoot,
      tokenoptCliPath: options.tokenoptCliPath
    });
    files.push(hookConfigPath);
    nextSteps.push("For VS Code Copilot Agent, verify hooks from the GitHub Copilot Chat Hooks output channel or Chat: Configure Hooks.");
  }

  let mcpConfigPath: string | undefined;
  if (scope === "user" || scope === "both") {
    mcpConfigPath = installCopilotUserMcpConfig({
      configPath: options.copilotConfigPath,
      tokenoptCliPath: options.tokenoptCliPath,
      includeRunCommand,
      repoRoot,
      includeCodeGraph: options.includeCodeGraph,
      codeGraphCliPath: options.codeGraphCliPath,
      codeGraphRoot: options.codeGraphRoot
    });
    files.push(mcpConfigPath);
    nextSteps.push("Open Copilot CLI in the target repo and run /mcp show tokenopt.");
    nextSteps.push("If CodeGraph was configured, also run /mcp show codegraph.");
  }

  if (scope === "repo") {
    nextSteps.push("For local Copilot CLI, make sure tokenopt is already installed in user MCP config by running tokenopt setup copilot --scope user once.");
  }

  if (scope === "repo" || scope === "both") {
    const vscodeMcpConfigPath = installVsCodeWorkspaceMcpConfig({
      repoRoot,
      configPath: options.vscodeMcpConfigPath,
      tokenoptCliPath: options.tokenoptCliPath,
      includeRunCommand,
      includeCodeGraph: options.includeCodeGraph,
      codeGraphCliPath: options.codeGraphCliPath,
      codeGraphRoot: options.codeGraphRoot
    });
    files.push(vscodeMcpConfigPath);
    nextSteps.push("For VS Code Copilot Agent, run MCP: List Servers, start tokenopt/codegraph, and enable their tools in the chat tool picker.");
    nextSteps.push("For GitHub.com cloud agent/code review, paste a cloud-compatible MCP JSON into Repository -> Settings -> Copilot -> MCP servers.");
  }

  if (!installAgents) {
    warnings.push("AGENTS.md and the TokenOpt custom agent were skipped; Copilot can still use .github/copilot-instructions.md and .github/instructions/tokenopt.instructions.md, but agent surfaces may miss stronger TokenOpt guidance.");
  }
  if (!installPrompts) {
    warnings.push("Copilot prompt files were skipped; users can still rely on always-on instructions, but slash prompts such as /pbi-plan and /review-code will not be installed.");
  }
  if (!includeRunCommand) {
    warnings.push("TokenOpt MCP was installed in lite mode; command execution and project_facts tools are not exposed unless you rerun setup with --include-run-command.");
  }
  const codeGraphResolution = resolveCodeGraphCli({
    repoRoot,
    codeGraphCliPath: options.codeGraphCliPath,
    codeGraphRoot: options.codeGraphRoot
  });
  const writesLocalMcpConfig = scope === "user" || scope === "repo" || scope === "both";
  const codeGraphConfigured = writesLocalMcpConfig && options.includeCodeGraph !== false && Boolean(codeGraphResolution?.cliPath);
  if (writesLocalMcpConfig && options.includeCodeGraph === true && !codeGraphResolution?.cliPath) {
    warnings.push("CodeGraph MCP was requested but no CLI was found. Set TOKENOPT_CODEGRAPH_ROOT, TOKENOPT_CODEGRAPH_CLI, --codegraph-root, or --codegraph-cli.");
  } else if (writesLocalMcpConfig && !codeGraphConfigured) {
    warnings.push("CodeGraph MCP was not configured. Natural prompts can still use TokenOpt, but graph/source evidence requires --include-codegraph plus a CodeGraph CLI/root.");
  }
  if (gatewayLevel === "routing") {
    warnings.push("Copilot setup used routing gateway mode; instructions and MCP guide tool choice, but hooks do not enforce acquisition order. Rerun with --gateway-level policy to install VS Code/Copilot hooks.");
  } else {
    warnings.push("Copilot policy gateway hooks were installed in shadow mode by default. Set policy.gateway.mode or TOKENOPT_GATEWAY_POLICY=hard after validating hook behavior.");
  }

  return {
    repoRoot,
    files,
    warnings,
    nextSteps,
    mcpConfigPath,
    vscodeMcpConfigPath: scope === "repo" || scope === "both"
      ? path.resolve(options.vscodeMcpConfigPath ?? path.join(repoRoot, ".vscode", "mcp.json"))
      : undefined,
    copilotInstructionsPath,
    copilotPathInstructionsPath,
    agentsPath,
    copilotAgentPath,
    promptFiles,
    hookConfigPath,
    codeGraphConfigured,
    codeGraphCliPath: codeGraphResolution?.cliPath
  };
}

export function installCopilotUserMcpConfig(options: {
  configPath?: string;
  tokenoptCliPath?: string;
  includeRunCommand?: boolean;
  repoRoot?: string;
  includeCodeGraph?: boolean;
  codeGraphCliPath?: string;
  codeGraphRoot?: string;
} = {}): string {
  const configPath = options.configPath ?? getCopilotMcpConfigPath();
  const tokenoptCliPath = normalizeJsonPath(path.resolve(options.tokenoptCliPath ?? getDefaultTokenOptCliPath()));
  const includeRunCommand = options.includeRunCommand ?? false;
  const mode = includeRunCommand ? "full" : "lite";
  const tools = includeRunCommand ? [...TOKENOPT_COPILOT_MCP_TOOLS] : [...TOKENOPT_COPILOT_LITE_MCP_TOOLS];

  const config = readJsonObject(configPath);
  const mcpServers = isRecord(config.mcpServers) ? { ...config.mcpServers } : {};
  mcpServers.tokenopt = {
    type: "local",
    command: "node",
    args: [tokenoptCliPath, "mcp", "--mode", mode],
    env: {},
    tools
  };

  if (options.includeCodeGraph !== false) {
    const codeGraph = resolveCodeGraphCli({
      repoRoot: options.repoRoot ?? process.cwd(),
      codeGraphCliPath: options.codeGraphCliPath,
      codeGraphRoot: options.codeGraphRoot
    });
    if (codeGraph?.cliPath) {
      const repoRoot = normalizeJsonPath(path.resolve(options.repoRoot ?? process.cwd()));
      mcpServers.codegraph = {
        type: "local",
        command: "node",
        args: [
          normalizeJsonPath(codeGraph.cliPath),
          "mcp",
          "--root",
          repoRoot,
          "--workspace-key",
          repoRoot,
          "--mcp-profile",
          "client"
        ],
        env: {},
        tools: [...CODEGRAPH_COPILOT_MCP_TOOLS]
      };
    }
  }

  const next = {
    ...config,
    mcpServers
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return configPath;
}

export function installVsCodeWorkspaceMcpConfig(options: {
  repoRoot: string;
  configPath?: string;
  tokenoptCliPath?: string;
  includeRunCommand?: boolean;
  includeCodeGraph?: boolean;
  codeGraphCliPath?: string;
  codeGraphRoot?: string;
}): string {
  const repoRoot = path.resolve(options.repoRoot);
  const configPath = path.resolve(options.configPath ?? path.join(repoRoot, ".vscode", "mcp.json"));
  const tokenoptCliPath = normalizeJsonPath(path.resolve(options.tokenoptCliPath ?? getDefaultTokenOptCliPath()));
  const includeRunCommand = options.includeRunCommand ?? false;
  const mode = includeRunCommand ? "full" : "lite";
  const config = readJsonObject(configPath);
  const servers = isRecord(config.servers) ? { ...config.servers } : {};

  servers.tokenopt = {
    type: "stdio",
    command: "node",
    args: [tokenoptCliPath, "mcp", "--mode", mode]
  };

  if (options.includeCodeGraph !== false) {
    const codeGraph = resolveCodeGraphCli({
      repoRoot,
      codeGraphCliPath: options.codeGraphCliPath,
      codeGraphRoot: options.codeGraphRoot
    });
    if (codeGraph?.cliPath) {
      const normalizedRepoRoot = normalizeJsonPath(repoRoot);
      servers.codegraph = {
        type: "stdio",
        command: "node",
        args: [
          normalizeJsonPath(codeGraph.cliPath),
          "mcp",
          "--root",
          normalizedRepoRoot,
          "--workspace-key",
          normalizedRepoRoot,
          "--mcp-profile",
          "client"
        ]
      };
    }
  }

  const next = {
    ...config,
    servers
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return configPath;
}

export function installCopilotGatewayHooks(options: {
  repoRoot: string;
  tokenoptCliPath?: string;
}): string {
  const repoRoot = path.resolve(options.repoRoot);
  const configPath = path.join(repoRoot, ".github", "hooks", "tokenopt-gateway.json");
  const tokenoptCliPath = normalizeJsonPath(path.resolve(options.tokenoptCliPath ?? getDefaultTokenOptCliPath()));
  const command = (event: string) => `node "${tokenoptCliPath}" hook copilot ${event}`;
  const hook = (event: string, timeout = 10) => ({
    type: "command",
    command: command(event),
    windows: command(event),
    timeout
  });
  const config = {
    hooks: {
      UserPromptSubmit: [hook("user-prompt-submit", 8)],
      PreToolUse: [hook("pre-tool-use", 10)],
      PostToolUse: [hook("post-tool-use", 10)],
      Stop: [hook("agent-stop", 8)]
    }
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

export function getCopilotMcpConfigPath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".copilot", "mcp-config.json");
}

export function getDefaultTokenOptCliPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
}

export function resolveCodeGraphCli(options: {
  repoRoot: string;
  codeGraphCliPath?: string;
  codeGraphRoot?: string;
  env?: NodeJS.ProcessEnv;
}): { cliPath: string; source: "option-cli" | "option-root" | "env-cli" | "env-root" | "sibling" } | undefined {
  const env = options.env ?? process.env;
  const explicitCli = options.codeGraphCliPath ?? env.TOKENOPT_CODEGRAPH_CLI;
  if (explicitCli) {
    const cliPath = path.resolve(explicitCli);
    return fs.existsSync(cliPath) ? { cliPath, source: options.codeGraphCliPath ? "option-cli" : "env-cli" } : undefined;
  }

  const explicitRoot = options.codeGraphRoot ?? env.TOKENOPT_CODEGRAPH_ROOT;
  if (explicitRoot) {
    const cliPath = path.resolve(explicitRoot, "dist", "cli.js");
    return fs.existsSync(cliPath) ? { cliPath, source: options.codeGraphRoot ? "option-root" : "env-root" } : undefined;
  }

  const repoRoot = path.resolve(options.repoRoot);
  const candidates = [
    path.resolve(repoRoot, "..", "code-graph", "dist", "cli.js"),
    path.resolve(repoRoot, "..", "codegraph", "dist", "cli.js")
  ];
  const cliPath = candidates.find((candidate) => fs.existsSync(candidate));
  return cliPath ? { cliPath, source: "sibling" } : undefined;
}

export function buildCopilotCloudMcpConfig(includeRunCommand = false): string {
  const mode = includeRunCommand ? "full" : "lite";
  const tools = includeRunCommand ? [...TOKENOPT_COPILOT_MCP_TOOLS] : [...TOKENOPT_COPILOT_LITE_MCP_TOOLS];
  return `${JSON.stringify({
    mcpServers: {
      tokenopt: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@tokenopt/cli", "mcp", "--mode", mode],
        tools
      }
    }
  }, null, 2)}\n`;
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (text.length === 0) {
    return {};
  }
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Copilot MCP config must be a JSON object: ${filePath}`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeJsonPath(value: string): string {
  return value.replace(/\\/g, "/");
}
