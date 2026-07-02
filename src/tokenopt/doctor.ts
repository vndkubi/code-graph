import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { getCliEntryPath } from "./codex-adapter.js";
import {
  CODEGRAPH_COPILOT_MCP_TOOLS,
  getCopilotMcpConfigPath,
  getDefaultTokenOptCliPath,
  TOKENOPT_COPILOT_LITE_MCP_TOOLS,
  TOKENOPT_COPILOT_MCP_TOOLS
} from "./copilot-setup.js";
import { getCodexHooksPath } from "./install.js";
import type { LoadedConfig } from "./types.js";

export function runDoctor(loaded: LoadedConfig): string {
  const checks = [
    check("node", process.version, true),
    check("tokenopt cli", getCliEntryPath(), fs.existsSync(getCliEntryPath())),
    checkCommand("npm", process.platform === "win32" ? "npm.cmd" : "npm", ["--version"]),
    checkCommand("codex", "codex", ["--version"]),
    check("user config", loaded.userConfigPath, fs.existsSync(loaded.userConfigPath)),
    check("repo config", loaded.repoConfigPath, fs.existsSync(loaded.repoConfigPath)),
    check("user Codex hooks", getCodexHooksPath("user"), fs.existsSync(getCodexHooksPath("user"))),
    check("repo Codex hooks", getCodexHooksPath("repo", loaded.repoRoot), fs.existsSync(getCodexHooksPath("repo", loaded.repoRoot)))
  ];

  const lines = [
    "TokenOpt doctor",
    "",
    ...checks.map((item) => `${item.ok ? "[ok]" : "[warn]"} ${item.name}: ${item.detail}`),
    "",
    "After installing Codex hooks, run `/hooks` in Codex to review and trust changed hook definitions."
  ];
  return lines.join("\n");
}

export function runCopilotDoctor(loaded: LoadedConfig): string {
  const copilotInstructionsPath = path.join(loaded.repoRoot, ".github", "copilot-instructions.md");
  const copilotPathInstructionsPath = path.join(loaded.repoRoot, ".github", "instructions", "tokenopt.instructions.md");
  const copilotAgentPath = path.join(loaded.repoRoot, ".github", "agents", "tokenopt-cost-gate.agent.md");
  const agentsPath = path.join(loaded.repoRoot, "AGENTS.md");
  const hooksPath = path.join(loaded.repoRoot, ".github", "hooks", "tokenopt-gateway.json");
  const mcpConfigPath = getCopilotMcpConfigPath();
  const vscodeMcpConfigPath = path.join(loaded.repoRoot, ".vscode", "mcp.json");
  const checks = [
    check("node", process.version, true),
    check("tokenopt cli", getDefaultTokenOptCliPath(), fs.existsSync(getDefaultTokenOptCliPath())),
    check("repo Copilot instructions", copilotInstructionsPath, fs.existsSync(copilotInstructionsPath)),
    check("repo Copilot path instructions", copilotPathInstructionsPath, fs.existsSync(copilotPathInstructionsPath)),
    check("repo Copilot custom agent", copilotAgentPath, fs.existsSync(copilotAgentPath)),
    check("repo Copilot policy hooks", hooksPath, fs.existsSync(hooksPath)),
    check("repo AGENTS.md", agentsPath, fs.existsSync(agentsPath)),
    check("user Copilot MCP config", mcpConfigPath, fs.existsSync(mcpConfigPath)),
    check("VS Code workspace MCP config", vscodeMcpConfigPath, fs.existsSync(vscodeMcpConfigPath)),
    ...inspectCopilotMcpConfig(mcpConfigPath),
    ...inspectCopilotCodeGraphMcpConfig(mcpConfigPath),
    ...inspectVsCodeTokenOptMcpConfig(vscodeMcpConfigPath),
    ...inspectVsCodeCodeGraphMcpConfig(vscodeMcpConfigPath)
  ];

  return [
    "TokenOpt Copilot doctor",
    "",
    ...checks.map((item) => `${item.ok ? "[ok]" : "[warn]"} ${item.name}: ${item.detail}`),
    "",
    "Copilot CLI verification: open the target repo and run `/mcp show tokenopt`.",
    "CodeGraph verification: if graph evidence is expected, run `/mcp show codegraph` too.",
    "VS Code Copilot Agent verification: run MCP: List Servers, start tokenopt/codegraph, and enable their tools in the chat Configure Tools picker.",
    "GitHub.com cloud agent/code review: configure MCP JSON in Repository -> Settings -> Copilot -> MCP servers; local Windows paths do not work there.",
    "Policy gateway verification: if .github/hooks/tokenopt-gateway.json exists, check the GitHub Copilot Chat Hooks output channel and use TOKENOPT_GATEWAY_POLICY=hard only after shadow behavior is correct."
  ].join("\n");
}

function check(name: string, detail: string, ok: boolean): { name: string; detail: string; ok: boolean } {
  return { name, detail, ok };
}

function inspectCopilotMcpConfig(filePath: string): Array<{ name: string; detail: string; ok: boolean }> {
  if (!fs.existsSync(filePath)) {
    return [
      check("tokenopt MCP server", "missing; run tokenopt setup copilot --scope user", false)
    ];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return [
      check("tokenopt MCP server", `invalid JSON: ${error instanceof Error ? error.message : String(error)}`, false)
    ];
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    return [
      check("tokenopt MCP server", "mcpServers object missing", false)
    ];
  }
  const server = parsed.mcpServers.tokenopt;
  if (!isRecord(server)) {
    return [
      check("tokenopt MCP server", "tokenopt entry missing", false)
    ];
  }
  const args = Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === "string") : [];
  const tools = Array.isArray(server.tools) ? server.tools.filter((tool): tool is string => typeof tool === "string") : [];
  const mode = inferCopilotMcpMode(server, args);
  const expectedTools = mode === "full" ? TOKENOPT_COPILOT_MCP_TOOLS : TOKENOPT_COPILOT_LITE_MCP_TOOLS;
  const missingTools = expectedTools.filter((tool) => !tools.includes(tool));
  const expectedToolSet = new Set<string>(expectedTools);
  const extraTools = tools.filter((tool) => !expectedToolSet.has(tool));
  return [
    check("tokenopt MCP command", String(server.command ?? "missing"), server.command === "node"),
    check("tokenopt MCP args", args.join(" "), args.some((arg) => /cli\.js$/i.test(arg)) && args.includes("mcp")),
    check("tokenopt MCP mode", mode, true),
    check(
      "tokenopt MCP tools",
      missingTools.length === 0 && extraTools.length === 0 ? tools.join(",") : `missing ${missingTools.join(",") || "none"}; extra ${extraTools.join(",") || "none"}`,
      missingTools.length === 0 && extraTools.length === 0
    )
  ];
}

function inspectCopilotCodeGraphMcpConfig(filePath: string): Array<{ name: string; detail: string; ok: boolean }> {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    return [];
  }
  const server = parsed.mcpServers.codegraph;
  if (!isRecord(server)) {
    return [
      check("codegraph MCP server", "missing; rerun setup with --include-codegraph and --codegraph-root/--codegraph-cli when graph evidence is expected", false)
    ];
  }
  const args = Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === "string") : [];
  const tools = Array.isArray(server.tools) ? server.tools.filter((tool): tool is string => typeof tool === "string") : [];
  const missingTools = CODEGRAPH_COPILOT_MCP_TOOLS.filter((tool) => !tools.includes(tool));
  return [
    check("codegraph MCP command", String(server.command ?? "missing"), server.command === "node"),
    check("codegraph MCP args", args.join(" "), args.some((arg) => /cli\.js$/i.test(arg)) && args.includes("mcp")),
    check(
      "codegraph MCP tools",
      missingTools.length === 0 ? tools.join(",") : `missing ${missingTools.join(",")}`,
      missingTools.length === 0
    )
  ];
}

function inspectVsCodeTokenOptMcpConfig(filePath: string): Array<{ name: string; detail: string; ok: boolean }> {
  if (!fs.existsSync(filePath)) {
    return [
      check("VS Code tokenopt MCP server", "missing; run tokenopt setup copilot --scope repo or --scope both", false)
    ];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return [
      check("VS Code tokenopt MCP server", `invalid JSON: ${error instanceof Error ? error.message : String(error)}`, false)
    ];
  }
  if (!isRecord(parsed) || !isRecord(parsed.servers)) {
    return [
      check("VS Code tokenopt MCP server", "servers object missing", false)
    ];
  }
  const server = parsed.servers.tokenopt;
  if (!isRecord(server)) {
    return [
      check("VS Code tokenopt MCP server", "tokenopt entry missing", false)
    ];
  }
  const args = Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === "string") : [];
  const mode = inferCopilotMcpMode(server, args);
  return [
    check("VS Code tokenopt MCP command", String(server.command ?? "missing"), server.command === "node"),
    check("VS Code tokenopt MCP args", args.join(" "), args.some((arg) => /cli\.js$/i.test(arg)) && args.includes("mcp")),
    check("VS Code tokenopt MCP mode", mode, true)
  ];
}

function inspectVsCodeCodeGraphMcpConfig(filePath: string): Array<{ name: string; detail: string; ok: boolean }> {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.servers)) {
    return [];
  }
  const server = parsed.servers.codegraph;
  if (!isRecord(server)) {
    return [
      check("VS Code codegraph MCP server", "missing; rerun setup with --include-codegraph and --codegraph-root/--codegraph-cli when graph evidence is expected", false)
    ];
  }
  const args = Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === "string") : [];
  return [
    check("VS Code codegraph MCP command", String(server.command ?? "missing"), server.command === "node"),
    check("VS Code codegraph MCP args", args.join(" "), args.some((arg) => /cli\.js$/i.test(arg)) && args.includes("mcp"))
  ];
}

function inferCopilotMcpMode(server: Record<string, unknown>, args: string[]): "lite" | "full" {
  const modeIndex = args.indexOf("--mode");
  const argMode = modeIndex >= 0 ? args[modeIndex + 1] : undefined;
  if (argMode === "full" || argMode === "lite") {
    return argMode;
  }
  const env = isRecord(server.env) ? server.env : {};
  return env.TOKENOPT_MCP_MODE === "full" ? "full" : "lite";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkCommand(name: string, command: string, args: string[]): { name: string; detail: string; ok: boolean } {
  const result = spawnSync(command, args, { encoding: "utf8", shell: process.platform === "win32" });
  if (result.status === 0) {
    return check(name, (result.stdout || result.stderr).trim(), true);
  }
  return check(name, result.error?.message || result.stderr.trim() || "not available", false);
}

export function runCodexHooksDoctor(loaded: LoadedConfig): string {
  const hooksPath = getCodexHooksPath("user");
  const backupPath = `${hooksPath}.tokenopt-backup-${Date.now()}`;
  const hadHooks = fs.existsSync(hooksPath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-codex-hooks-"));
  const canaryLogPath = path.join(tempDir, "canary.log");
  const canaryScriptPath = path.join(tempDir, "canary-hook.mjs");
  const codexOutputPath = path.join(tempDir, "codex-output.txt");
  const canaryToken = `TOKENOPT_CANARY_${crypto.randomUUID().replace(/-/g, "")}`;
  const prompt =
    "Run Get-Location once. If hidden TokenOpt canary context provides an exact token, reply with that exact token. If no such hidden token is present, reply exactly TOKENOPT_CANARY_MISSING. Do not guess a token.";

  fs.writeFileSync(
    canaryScriptPath,
    [
      "import fs from 'node:fs';",
      "const eventName = process.argv[2] || 'unknown';",
      "const logPath = process.argv[3];",
      "let input = '';",
      "for await (const chunk of process.stdin) input += chunk;",
      "fs.appendFileSync(logPath, `${eventName}\\n${input}\\n---\\n`, 'utf8');",
      `const canaryToken = ${JSON.stringify(canaryToken)};`,
      "if (eventName === 'UserPromptSubmit') {",
      "  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `TokenOpt canary token: ${canaryToken}` } }));",
      "} else if (eventName === 'PreToolUse') {",
      "  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'TOKENOPT_CANARY_PRETOOL' } }));",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );

  try {
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    if (hadHooks) {
      fs.copyFileSync(hooksPath, backupPath);
    }
    const canaryHooks = buildCanaryHooks(canaryScriptPath, canaryLogPath);
    fs.writeFileSync(hooksPath, `${JSON.stringify(canaryHooks, null, 2)}\n`, "utf8");

    const command = buildCodexCanaryCommand(loaded.repoRoot, prompt);
    const result = spawnSync(command, {
      cwd: loaded.repoRoot,
      encoding: "utf8",
      shell: true,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 180_000
    });
    fs.writeFileSync(codexOutputPath, `${result.stdout ?? ""}\n${result.stderr ?? ""}`, "utf8");

    const canaryLog = fs.existsSync(canaryLogPath) ? fs.readFileSync(canaryLogPath, "utf8") : "";
    const output = fs.readFileSync(codexOutputPath, "utf8");
    const sawUserPrompt = /UserPromptSubmit/.test(canaryLog);
    const sawPreToolUse = /PreToolUse/.test(canaryLog);
    const sawContext = output.includes(canaryToken);
    const ok = result.status === 0 && sawUserPrompt && sawContext;

    return [
      "TokenOpt Codex hooks doctor",
      "",
      `${ok ? "[ok]" : "[fail]"} hook canary: ${ok ? "Codex loaded and ran user hooks" : "Codex did not prove hook execution"}`,
      `[${result.status === 0 ? "ok" : "warn"}] codex exec exit: ${result.status ?? "signal/timeout"}`,
      `[${sawUserPrompt ? "ok" : "warn"}] UserPromptSubmit fired: ${sawUserPrompt}`,
      `[${sawPreToolUse ? "ok" : "warn"}] PreToolUse fired: ${sawPreToolUse}`,
      `[${sawContext ? "ok" : "warn"}] hidden canary token reached run output: ${sawContext}`,
      "",
      `canaryLog: ${canaryLogPath}`,
      `codexOutput: ${codexOutputPath}`,
      "",
      "This command temporarily replaces user hooks and restores the previous hooks file before exiting."
    ].join("\n");
  } finally {
    if (hadHooks) {
      fs.copyFileSync(backupPath, hooksPath);
      fs.rmSync(backupPath, { force: true });
    } else {
      fs.rmSync(hooksPath, { force: true });
    }
  }
}

function buildCanaryHooks(scriptPath: string, logPath: string): unknown {
  const command = (eventName: string) =>
    [quoteCommandArg(process.execPath), quoteCommandArg(scriptPath), quoteCommandArg(eventName), quoteCommandArg(logPath)].join(" ");
  const handler = (eventName: string) => ({
    type: "command",
    command: command(eventName),
    commandWindows: command(eventName),
    timeout: 30,
    statusMessage: `TokenOpt canary ${eventName}`
  });
  return {
    hooks: {
      UserPromptSubmit: [{ hooks: [handler("UserPromptSubmit")] }],
      PreToolUse: [{ matcher: "*", hooks: [handler("PreToolUse")] }],
      PostToolUse: [{ matcher: "*", hooks: [handler("PostToolUse")] }]
    }
  };
}

function buildCodexCanaryCommand(repoRoot: string, prompt: string): string {
  const codexCommand = process.env.TOKENOPT_CODEX_COMMAND || "npx -y @openai/codex";
  return [
    codexCommand,
    "--enable hooks",
    "-a never",
    "--dangerously-bypass-hook-trust",
    "exec",
    "--skip-git-repo-check",
    "--sandbox read-only",
    "--ephemeral",
    "--json",
    "-C",
    quoteCommandArg(repoRoot),
    quoteCommandArg(prompt)
  ].join(" ");
}

function quoteCommandArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
