import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adaptDecisionToCodex, normalizeCodexEvent } from "../../dist/tokenopt/codex-adapter.js";
import { buildCopilotCloudMcpConfig, setupCopilotProject } from "../../dist/tokenopt/copilot-setup.js";
import { buildNativePromptPack, emitTokenOptInstructions, installNativePromptPack, installTokenOptInstructions } from "../../dist/tokenopt/instruction-audit.js";
import { compressText } from "../../dist/tokenopt/log-compressor.js";
import { buildCodexHooksConfig, installCodexHooks } from "../../dist/tokenopt/install.js";
import { repoKey } from "../../dist/tokenopt/observability.js";

test("codex adapter emits deny shape for PreToolUse", () => {
  const output = adaptDecisionToCodex("pre-tool-use", {
    action: "deny",
    reason: "blocked"
  });
  assert.deepEqual(output, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "blocked"
    }
  });
});

test("codex raw hook normalizes supported event", () => {
  const event = normalizeCodexEvent({
    hook_event_name: "UserPromptSubmit",
    cwd: "/tmp/repo",
    prompt: "hello"
  });
  assert.equal(event.eventName, "user-prompt-submit");
  assert.equal(event.prompt, "hello");
});

test("compressor extracts failure signal", () => {
  const result = compressText("FAIL src/example.test.ts\nAssertionError: expected 1 to be 2\n".repeat(50), 2000);
  assert.equal(result.kind, "vitest");
  assert.match(result.text, /AssertionError/);
  assert.ok(result.estimatedTokensSaved > 0);
});

test("compressor recognizes pytest output", () => {
  const result = compressText("FAILED tests/test_api.py::test_create_user - AssertionError\nTraceback (most recent call last):\n".repeat(20), 2000);
  assert.equal(result.kind, "pytest");
  assert.match(result.text, /test_create_user/);
});

test("compressor recognizes TypeScript output", () => {
  const result = compressText("src/index.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n".repeat(20), 2000);
  assert.equal(result.kind, "tsc");
  assert.match(result.text, /TS2322/);
});

test("compressor recognizes ESLint output", () => {
  const result = compressText("src/index.ts:4:10: error  'x' is defined but never used  no-unused-vars\n".repeat(20), 2000);
  assert.equal(result.kind, "eslint");
  assert.match(result.text, /no-unused-vars/);
});

test("compressor falls back to generic output", () => {
  const result = compressText("plain log line\n".repeat(20), 2000);
  assert.equal(result.kind, "generic");
  assert.match(result.text, /plain log line/);
});

test("Codex hook config uses absolute node command style", () => {
  const hooks = buildCodexHooksConfig(path.resolve("dist/tokenopt/cli.js"));
  const command = hooks.hooks.PreToolUse[0].hooks[0].command;
  const commandWindows = hooks.hooks.PreToolUse[0].hooks[0].commandWindows;
  assert.match(command, /node(?:\.exe)?["']/i);
  assert.match(command, /hook/);
  assert.equal(commandWindows, command);
  assert.doesNotMatch(command, /\bnpm\b/);
});

test("install keeps non-TokenOpt hooks and replaces TokenOpt hooks", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-install-"));
  const codexDir = path.join(repo, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const hooksPath = path.join(codexDir, "hooks.json");
  fs.writeFileSync(
    hooksPath,
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo keep", statusMessage: "Keep" }]
          }
        ]
      }
    })
  );
  installCodexHooks("repo", repo);
  const written = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  assert.equal(written.hooks.PreToolUse.length, 2);
  assert.equal(written.hooks.PreToolUse[0].hooks[0].command, "echo keep");
});

test("repo keys differ for unrelated roots", () => {
  assert.notEqual(repoKey(path.join(os.tmpdir(), "repo-a")), repoKey(path.join(os.tmpdir(), "repo-b")));
});

test("instruction emitter and installer produce idempotent MCP guidance", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-instructions-"));
  const snippet = emitTokenOptInstructions("agents");
  assert.match(snippet, /contextgate_get_context/);
  assert.match(snippet, /answerable=true/);
  assert.match(snippet, /Daily prompt bridge/);
  assert.match(snippet, /codegraph_context/);

  const agentsPath = installTokenOptInstructions(repo, "agents");
  installTokenOptInstructions(repo, "agents");
  const agentsText = fs.readFileSync(agentsPath, "utf8");
  assert.equal((agentsText.match(/tokenopt:mcp-instructions:start/g) ?? []).length, 1);
  assert.match(agentsText, /Do not bypass TokenOpt with shell fallback/);
  assert.match(agentsText, /MCP\+shell double-spend/);

  const copilotPath = installTokenOptInstructions(repo, "copilot");
  assert.equal(copilotPath, path.join(repo, ".github", "copilot-instructions.md"));
  assert.match(fs.readFileSync(copilotPath, "utf8"), /ContextGate MCP Usage/);

  const copilotPathInstructionsPath = installTokenOptInstructions(repo, "copilot-path");
  assert.equal(copilotPathInstructionsPath, path.join(repo, ".github", "instructions", "tokenopt.instructions.md"));
  assert.match(fs.readFileSync(copilotPathInstructionsPath, "utf8"), /applyTo: "\*\*"/);

  const copilotAgentPath = installTokenOptInstructions(repo, "copilot-agent");
  assert.equal(copilotAgentPath, path.join(repo, ".github", "agents", "tokenopt-cost-gate.agent.md"));
  assert.match(fs.readFileSync(copilotAgentPath, "utf8"), /name: contextgate-cost-gate/);
  assert.match(fs.readFileSync(copilotAgentPath, "utf8"), /tokenopt\/contextgate_get_context/);
  assert.match(fs.readFileSync(copilotAgentPath, "utf8"), /codegraph\/codegraph_context/);
});

test("native prompt pack installs reusable Copilot prompt files", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-native-prompts-"));
  const plan = buildNativePromptPack(repo);
  assert.equal(plan.files.length, 27);
  assert.equal(plan.files.some((file) => file.path.endsWith(path.join(".github", "prompts", "investigate-flow.prompt.md"))), true);
  assert.equal(plan.files.some((file) => file.path.endsWith(path.join(".github", "prompts", "e2e-trace-flow.prompt.md"))), true);
  assert.equal(plan.files.some((file) => file.path.endsWith(path.join(".github", "prompts", "investigate-pbi.prompt.md"))), true);
  assert.equal(plan.files.some((file) => file.path.endsWith(path.join(".github", "prompts", "write-unittest.prompt.md"))), true);
  assert.equal(plan.files.some((file) => file.path.endsWith(path.join(".github", "prompts", "write-unittest-class.prompt.md"))), true);
  assert.equal(plan.files.some((file) => file.path.endsWith(path.join(".github", "prompts", "bug-trace.prompt.md"))), true);
  assert.equal(plan.files.some((file) => file.path.endsWith(path.join(".github", "prompts", "refactor-code.prompt.md"))), true);
  assert.equal(plan.files.some((file) => file.path.endsWith(path.join(".github", "prompts", "trace-bug.prompt.md"))), true);
  assert.equal(plan.files.some((file) => file.path.endsWith(path.join(".github", "prompts", "spec-feature-plan.prompt.md"))), true);

  const files = installNativePromptPack(repo);
  assert.equal(files.length, 27);
  const investigateFlow = fs.readFileSync(path.join(repo, ".github", "prompts", "investigate-flow.prompt.md"), "utf8");
  assert.match(investigateFlow, /name: investigate-flow/);
  assert.match(investigateFlow, /TokenOpt\+CodeGraph mode/);

  const writeUnittest = fs.readFileSync(path.join(repo, ".github", "prompts", "write-unittest.prompt.md"), "utf8");
  assert.match(writeUnittest, /name: write-unittest/);
  assert.match(writeUnittest, /Natural evidence routing/);
  assert.match(writeUnittest, /business behavior and acceptance criteria/);

  const writeUnittestClass = fs.readFileSync(path.join(repo, ".github", "prompts", "write-unittest-class.prompt.md"), "utf8");
  assert.match(writeUnittestClass, /name: write-unittest-class/);
  assert.match(writeUnittestClass, /exact source\/test evidence/);

  const traceBug = fs.readFileSync(path.join(repo, ".github", "prompts", "trace-bug.prompt.md"), "utf8");
  assert.match(traceBug, /name: trace-bug/);
  assert.match(traceBug, /native narrow search\/read directly/);
  assert.match(traceBug, /tokenopt_failure_packet/);

  const bugTrace = fs.readFileSync(path.join(repo, ".github", "prompts", "bug-trace.prompt.md"), "utf8");
  assert.match(bugTrace, /name: bug-trace/);
  assert.match(bugTrace, /failure artifact/);

  const refactorCode = fs.readFileSync(path.join(repo, ".github", "prompts", "refactor-code.prompt.md"), "utf8");
  assert.match(refactorCode, /name: refactor-code/);
  assert.match(refactorCode, /behavior invariants first/);

  const securityAudit = fs.readFileSync(path.join(repo, ".github", "prompts", "security-audit.prompt.md"), "utf8");
  assert.match(securityAudit, /name: security-audit/);
  assert.match(securityAudit, /Use security_audit route/);
  assert.match(securityAudit, /never use broad shell review fallback/i);

  const reviewCode = fs.readFileSync(path.join(repo, ".github", "prompts", "review-code.prompt.md"), "utf8");
  assert.match(reviewCode, /two phases/i);
  assert.match(reviewCode, /cheapest review-shaped evidence path/);
  assert.match(reviewCode, /review broker is available/);
  assert.match(reviewCode, /branch pair/);
  assert.match(reviewCode, /Jira tickets or Confluence pages/);
  assert.match(reviewCode, /relevant attachments/);
  assert.match(reviewCode, /Do not ask the user to paste the full ticket\/page content/);
  assert.match(reviewCode, /requirement evidence/);
  assert.match(reviewCode, /PR merge\/head worktree/);
  assert.match(reviewCode, /attachment_evidence/);
  assert.match(reviewCode, /ISTQB-style/);
  assert.match(reviewCode, /user_checklist/);
  assert.match(reviewCode, /pass, fail, gap, or not_applicable/);
  assert.match(reviewCode, /Do not downgrade a proven regression/);
});

test("Copilot setup writes repo guidance and merges user MCP config", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-copilot-"));
  const copilotConfigPath = path.join(repo, "mcp-config.json");
  const tokenoptCliPath = path.resolve("dist/tokenopt/cli.js");
  fs.writeFileSync(
    copilotConfigPath,
    JSON.stringify({
      mcpServers: {
        keep: {
          type: "http",
          url: "https://example.test/mcp",
          tools: ["*"]
        }
      }
    }, null, 2)
  );

  const result = setupCopilotProject({
    repoRoot: repo,
    scope: "both",
    copilotConfigPath,
    tokenoptCliPath
  });
  setupCopilotProject({
    repoRoot: repo,
    scope: "both",
    copilotConfigPath,
    tokenoptCliPath
  });

  const copilotInstructions = fs.readFileSync(path.join(repo, ".github", "copilot-instructions.md"), "utf8");
  const copilotPathInstructions = fs.readFileSync(path.join(repo, ".github", "instructions", "tokenopt.instructions.md"), "utf8");
  const copilotAgent = fs.readFileSync(path.join(repo, ".github", "agents", "tokenopt-cost-gate.agent.md"), "utf8");
  const writeUnittestPrompt = fs.readFileSync(path.join(repo, ".github", "prompts", "write-unittest.prompt.md"), "utf8");
  const traceBugPrompt = fs.readFileSync(path.join(repo, ".github", "prompts", "trace-bug.prompt.md"), "utf8");
  const agentsInstructions = fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8");
  const config = JSON.parse(fs.readFileSync(copilotConfigPath, "utf8"));
  const vscodeConfigPath = path.join(repo, ".vscode", "mcp.json");
  const vscodeConfig = JSON.parse(fs.readFileSync(vscodeConfigPath, "utf8"));

  assert.equal((copilotInstructions.match(/tokenopt:mcp-instructions:start/g) ?? []).length, 1);
  assert.match(copilotPathInstructions, /applyTo: "\*\*"/);
  assert.match(copilotPathInstructions, /ContextGate MCP Usage/);
  assert.match(copilotAgent, /name: contextgate-cost-gate/);
  assert.match(copilotAgent, /tokenopt\/contextgate_get_context/);
  assert.match(copilotAgent, /codegraph\/codegraph_context/);
  assert.match(writeUnittestPrompt, /name: write-unittest/);
  assert.match(traceBugPrompt, /name: trace-bug/);
  assert.equal(result.promptFiles.length, 27);
  assert.equal((agentsInstructions.match(/tokenopt:mcp-instructions:start/g) ?? []).length, 1);
  assert.deepEqual(config.mcpServers.keep.tools, ["*"]);
  assert.equal(config.mcpServers.tokenopt.command, "node");
  assert.deepEqual(config.mcpServers.tokenopt.args, [tokenoptCliPath.replace(/\\/g, "/"), "mcp", "--mode", "lite"]);
  assert.ok(config.mcpServers.tokenopt.tools.includes("contextgate_get_context"));
  assert.ok(config.mcpServers.tokenopt.tools.includes("tokenopt_compile_evidence"));
  assert.ok(!config.mcpServers.tokenopt.tools.includes("tokenopt_run_command"));
  assert.ok(!config.mcpServers.tokenopt.tools.includes("tokenopt_project_facts"));
  assert.doesNotMatch(JSON.stringify(config.mcpServers.tokenopt), /\bnpm(?:\.cmd|\.ps1)?\b/i);
  assert.equal(result.vscodeMcpConfigPath, vscodeConfigPath);
  assert.ok(result.files.includes(vscodeConfigPath));
  assert.equal(vscodeConfig.servers.tokenopt.type, "stdio");
  assert.equal(vscodeConfig.servers.tokenopt.command, "node");
  assert.deepEqual(vscodeConfig.servers.tokenopt.args, [tokenoptCliPath.replace(/\\/g, "/"), "mcp", "--mode", "lite"]);
  assert.doesNotMatch(JSON.stringify(vscodeConfig.servers.tokenopt), /\bnpm(?:\.cmd|\.ps1)?\b/i);
  assert.ok(result.warnings.some((warning) => /lite mode/i.test(warning)));
  assert.ok(result.warnings.some((warning) => /routing gateway mode/i.test(warning)));
  assert.equal(result.hookConfigPath, undefined);
});

test("Copilot setup policy gateway writes VS Code hook config", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-copilot-policy-"));
  const copilotConfigPath = path.join(repo, "mcp-config.json");
  const tokenoptCliPath = path.resolve("dist/tokenopt/cli.js");

  const result = setupCopilotProject({
    repoRoot: repo,
    scope: "repo",
    copilotConfigPath,
    tokenoptCliPath,
    gatewayLevel: "policy",
    includeCodeGraph: false,
    installPrompts: false
  });

  const hookPath = path.join(repo, ".github", "hooks", "tokenopt-gateway.json");
  const hooks = JSON.parse(fs.readFileSync(hookPath, "utf8"));
  assert.equal(result.hookConfigPath, hookPath);
  assert.ok(result.files.includes(hookPath));
  assert.match(hooks.hooks.UserPromptSubmit[0].command, /hook copilot user-prompt-submit/);
  assert.match(hooks.hooks.PreToolUse[0].command, /hook copilot pre-tool-use/);
  assert.match(hooks.hooks.PostToolUse[0].command, /hook copilot post-tool-use/);
  assert.match(hooks.hooks.Stop[0].command, /hook copilot agent-stop/);
  assert.ok(result.warnings.some((warning) => /policy gateway hooks were installed/i.test(warning)));
});

test("Copilot setup configures CodeGraph MCP when a CodeGraph root is provided", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-copilot-codegraph-"));
  const codeGraphRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-codegraph-root-"));
  const copilotConfigPath = path.join(repo, "mcp-config.json");
  const tokenoptCliPath = path.resolve("dist/tokenopt/cli.js");
  const codeGraphCli = path.join(codeGraphRoot, "dist", "cli.js");
  fs.mkdirSync(path.dirname(codeGraphCli), { recursive: true });
  fs.writeFileSync(codeGraphCli, "", "utf8");

  const result = setupCopilotProject({
    repoRoot: repo,
    scope: "both",
    installAgents: false,
    installPrompts: false,
    copilotConfigPath,
    tokenoptCliPath,
    includeCodeGraph: true,
    codeGraphRoot
  });

  const config = JSON.parse(fs.readFileSync(copilotConfigPath, "utf8"));
  const vscodeConfig = JSON.parse(fs.readFileSync(path.join(repo, ".vscode", "mcp.json"), "utf8"));
  assert.equal(result.codeGraphConfigured, true);
  assert.equal(config.mcpServers.codegraph.command, "node");
  assert.deepEqual(config.mcpServers.codegraph.args, [
    codeGraphCli.replace(/\\/g, "/"),
    "mcp",
    "--root",
    repo.replace(/\\/g, "/"),
    "--workspace-key",
    repo.replace(/\\/g, "/"),
    "--mcp-profile",
    "client"
  ]);
  assert.deepEqual(config.mcpServers.codegraph.tools, [
    "codegraph_context",
    "codegraph_slice",
    "codegraph_status"
  ]);
  assert.equal(vscodeConfig.servers.codegraph.type, "stdio");
  assert.equal(vscodeConfig.servers.codegraph.command, "node");
  assert.deepEqual(vscodeConfig.servers.codegraph.args, [
    codeGraphCli.replace(/\\/g, "/"),
    "mcp",
    "--root",
    repo.replace(/\\/g, "/"),
    "--workspace-key",
    repo.replace(/\\/g, "/"),
    "--mcp-profile",
    "client"
  ]);
});

test("Copilot cloud MCP example excludes command execution by default", () => {
  const config = JSON.parse(buildCopilotCloudMcpConfig());
  assert.equal(config.mcpServers.tokenopt.command, "npx");
  assert.deepEqual(config.mcpServers.tokenopt.args, ["-y", "@tokenopt/cli", "mcp", "--mode", "lite"]);
  assert.ok(config.mcpServers.tokenopt.tools.includes("contextgate_get_context"));
  assert.ok(config.mcpServers.tokenopt.tools.includes("tokenopt_compile_evidence"));
  assert.ok(!config.mcpServers.tokenopt.tools.includes("tokenopt_run_command"));
});
