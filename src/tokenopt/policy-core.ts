import fs from "node:fs";
import path from "node:path";
import { readActiveEvidenceTaskState, readEvidenceTaskState } from "./evidence-state.js";
import {
  classifyGatewayPrompt,
  isCodeGraphTool,
  isContextGateTool,
  isRawSourceAcquisitionTool,
  isRequirementTool,
  readGatewayPolicyState,
  updateGatewayPolicyState
} from "./gateway-state.js";
import { evaluateHardGate } from "./hard-gate.js";
import { compressText, extractTextFromToolResponse, shouldCompressOutput } from "./log-compressor.js";
import { routeTask } from "./router.js";
import { commandLooksWrapped, tokenizeCommand } from "./shell.js";
import type { EvidenceFollowup, GatewayRequirementKind, PolicyDecision, PolicyRuntime, TokenOptConfig, TokenOptEvent } from "./types.js";

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "Pipfile.lock",
  "poetry.lock"
]);

const GENERATED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "generated",
  "__generated__"
]);

export function evaluatePolicy(event: TokenOptEvent, config: TokenOptConfig, runtime: PolicyRuntime): PolicyDecision {
  if (!config.policy.enabled) {
    return { action: "allow" };
  }

  switch (event.eventName) {
    case "user-prompt-submit":
      return evaluatePrompt(event, config, runtime);
    case "pre-tool-use":
      return evaluatePreToolUse(event, config, runtime);
    case "post-tool-use":
      return evaluatePostToolUse(event, config, runtime);
    case "pre-compact":
      return {
        action: "allow",
        reason: "PreCompact metadata recorded without reading unstable transcript contents."
      };
    case "agent-stop":
      return evaluateAgentStop(event, config, runtime);
  }
}

function evaluatePrompt(event: TokenOptEvent, config: TokenOptConfig, runtime: PolicyRuntime): PolicyDecision {
  const prompt = event.prompt ?? "";
  if (config.context.enableSecretBlock && containsLikelySecret(prompt)) {
    return {
      action: "deny",
      reason: "Prompt appears to contain a secret or API key. Remove the secret before sending it to the model."
    };
  }

  if (containsInjectedTokenOptInstructionPaste(prompt)) {
    return {
      action: "deny",
      reason:
        "Prompt appears to include ContextGate/TokenOpt injected benchmark/setup instruction text. Do not paste lines like " +
        "\"Project instruction injected by TokenOpt setup\" or \"When the TokenOpt MCP server is available\" into the user prompt. " +
        "Send only the actual task, for example: \"Study <business/module> business flow, concepts, and glossary. Keep exploration bounded and cite evidence.\""
    };
  }

  const route = routeTask({ task: prompt });
  const outputGuidance =
    route.taskClass === "review_diff" || route.taskClass === "security_audit" || route.taskClass === "refactor_scope"
      ? " For code changes, prefer unified diffs or compact edit plans; avoid full-file rewrites unless creating a new file."
      : "";
  const context = config.codegraph.enabled
    ? `${config.context.userPromptGuidance} CodeGraph is configured as an optional repository context provider; prefer bounded CodeGraph packs before broad raw file reads.`
    : config.context.userPromptGuidance;
  const gateway = classifyGatewayPrompt(prompt, config, route.taskClass);
  if (gateway.requiresContextGate) {
    updateGatewayPolicyState(config, runtime.repoRoot, event, {
      requiresContextGate: true,
      requirementAcquired: false,
      contextGateAcquired: false,
      answerablePacketId: undefined,
      reason: gateway.reason,
      requirementKind: gateway.requirementKind
    });
  }

  return {
    action: "context",
    additionalContext: [
      `${context}${outputGuidance}`,
      gateway.requiresContextGate ? gatewayRequiredContext(gateway.reason, gateway.requirementKind) : undefined
    ].filter(Boolean).join(" "),
    metadata: {
      routeDecision: route,
      gateway
    }
  };
}

function evaluatePreToolUse(event: TokenOptEvent, config: TokenOptConfig, runtime: PolicyRuntime): PolicyDecision {
  const toolName = event.toolName ?? "";

  const gatewayDecision = evaluateGatewayPreToolUse(event, config, runtime);
  if (gatewayDecision) {
    return gatewayDecision;
  }

  const codeGraphDecision = evaluateCodeGraphPreToolUse(toolName, config, runtime);
  if (codeGraphDecision) {
    return codeGraphDecision;
  }

  if (toolName === "Bash") {
    const command = extractCommand(event.toolInput);
    if (!command) {
      return { action: "allow" };
    }

    if (detectShellSearch(command)) {
      const activeEvidence = readActiveEvidenceTaskState(config, runtime.repoRoot);
      if (activeEvidence) {
        return evaluateHardGate({
          config,
          repoRoot: runtime.repoRoot,
          state: activeEvidence,
          toolName,
          toolInput: event.toolInput,
          reason: "answerable_packet_would_block_shell_search",
          hardReason:
            `TokenOpt answerability gate blocked shell search after answerable packet ${activeEvidence.packet.packet_id} ` +
            `(${activeEvidence.packet.task_type}). Answer from the packet, or call tokenopt_compile_evidence for a changed task.`,
          shadowContext:
            "TokenOpt shadow gate: this search looks redundant because the current evidence packet is answerable. " +
            "Answer from the packet unless the user changed the task.",
          forceWouldDeny: true
        });
      }

      const recentEvidence = readEvidenceTaskState(config, runtime.repoRoot);
      if (recentEvidence && Date.parse(recentEvidence.packet.expires_at) > Date.now() && hasTokenOptFollowups(recentEvidence.packet.allowed_followups)) {
        return evaluateHardGate({
          config,
          repoRoot: runtime.repoRoot,
          state: recentEvidence,
          toolName,
          toolInput: event.toolInput,
          reason: "packet_followups_would_block_raw_shell_search",
          hardReason:
            `TokenOpt blocked shell search after packet ${recentEvidence.packet.packet_id} (${recentEvidence.packet.task_type}). ` +
            "Use the packet's allowed_followups with tokenopt_search/tokenopt_read_file instead.",
          shadowContext: "Use the packet's allowed_followups with tokenopt_search/tokenopt_read_file when possible.",
          forceWouldDeny: true
        });
      }
    }

    const broadSearch = detectBroadSearch(command);
    if (broadSearch) {
      return {
        action: config.policy.broadSearch.mode === "warn" ? "context" : "deny",
        reason: broadSearch,
        additionalContext: `${broadSearch} Prefer a targeted query with a concrete pattern and cap results near ${config.policy.broadSearch.maxResults}.`
      };
    }

    const readTarget = extractReadTarget(command);
    if (readTarget) {
      const decision = evaluateReadTarget(readTarget, config, runtime.repoRoot);
      if (decision) {
        return decision;
      }
    }

    const expensiveTest = detectExpensiveTest(command, config);
    if (expensiveTest && !commandLooksWrapped(command)) {
      if (config.policy.expensiveTests.mode === "rewrite" && runtime.tokenoptCommand) {
        return {
          action: "rewrite",
          reason: `${expensiveTest} Rewriting through tokenopt exec so raw output is preserved but model-visible output is compact.`,
          updatedInput: { command: `${runtime.tokenoptCommand} exec -- ${command}` }
        };
      }
      if (config.policy.expensiveTests.mode === "warn") {
        return {
          action: "context",
          reason: expensiveTest,
          additionalContext: config.policy.expensiveTests.targetedHint
        };
      }
    }

    return { action: "allow" };
  }

  if (toolName === "apply_patch") {
    return { action: "allow" };
  }

  if (toolName.startsWith("mcp__")) {
    const target = extractMcpReadTarget(event.toolInput);
    if (target && /read|get|file|resource/i.test(toolName)) {
      const decision = evaluateReadTarget(target, config, runtime.repoRoot);
      if (decision) {
        return decision;
      }
    }
  }

  return { action: "allow" };
}

function evaluatePostToolUse(event: TokenOptEvent, config: TokenOptConfig, runtime: PolicyRuntime): PolicyDecision {
  const gatewayDecision = evaluateGatewayPostToolUse(event, config, runtime);
  if (gatewayDecision) {
    return gatewayDecision;
  }

  const text = extractTextFromToolResponse(event.toolResponse);
  if (!text || !shouldCompressOutput(text, config.policy.maxCommandOutputChars)) {
    return { action: "allow" };
  }

  const compressed = compressText(text, config.policy.maxCommandOutputChars);
  return {
    action: "compress",
    reason: "Tool output is noisy or failure-heavy; TokenOpt compressed it and will preserve the raw artifact.",
    replacementText: compressed.text,
    estimatedTokensSaved: compressed.estimatedTokensSaved,
    shouldPersistRaw: true,
    metadata: {
      kind: compressed.kind,
      originalChars: compressed.originalChars,
      compressedChars: compressed.compressedChars,
      compressionBudgetChars: compressed.budget?.maxChars,
      compressionBudgetReason: compressed.budget?.reason
    }
  };
}

function evaluateAgentStop(event: TokenOptEvent, config: TokenOptConfig, runtime: PolicyRuntime): PolicyDecision {
  if (config.policy.gateway.mode === "off" || stopHookAlreadyActive(event)) {
    return { action: "allow" };
  }
  const state = readGatewayPolicyState(config, runtime.repoRoot, event);
  if (!state?.requiresContextGate || state.contextGateAcquired) {
    return { action: "allow" };
  }
  if (!state.requirementAcquired) {
    return { action: "allow" };
  }
  const reason = "ContextGate policy blocked final answer: this PBI/requirement + code task has requirement evidence, but no ContextGate source-evidence packet yet. Call contextgate_get_context with external_artifacts before finishing.";
  if (config.policy.gateway.mode === "shadow") {
    return {
      action: "context",
      reason: `ContextGate shadow policy would block stop: ${reason}`,
      additionalContext: reason,
      metadata: { gatewayPolicyMode: "shadow", gatewayState: state }
    };
  }
  return {
    action: "deny",
    reason,
    metadata: { gatewayPolicyMode: "hard", gatewayState: state }
  };
}

function evaluateGatewayPreToolUse(event: TokenOptEvent, config: TokenOptConfig, runtime: PolicyRuntime): PolicyDecision | undefined {
  const toolName = event.toolName ?? "";
  if (toolName === "Bash") {
    const readTarget = extractReadTarget(extractCommand(event.toolInput) ?? "");
    if (readTarget) {
      const readDecision = evaluateReadTarget(readTarget, config, runtime.repoRoot);
      if (readDecision?.action === "deny") {
        return readDecision;
      }
    }
  } else if (toolName.startsWith("mcp__")) {
    const readTarget = extractMcpReadTarget(event.toolInput);
    if (readTarget && /read|get|file|resource/i.test(toolName)) {
      const readDecision = evaluateReadTarget(readTarget, config, runtime.repoRoot);
      if (readDecision?.action === "deny") {
        return readDecision;
      }
    }
  }

  const activeEvidence = readActiveEvidenceTaskState(config, runtime.repoRoot);
  if (activeEvidence && isRawSourceAcquisitionTool(toolName)) {
    return gatewayModeDecision(
      config,
      "ContextGate answerability policy: an answerable packet already exists. Answer from that packet and do not repeat broad source acquisition.",
      { reason: "answerable_packet_blocks_source_acquisition", packetId: activeEvidence.packet.packet_id }
    );
  }

  const state = readGatewayPolicyState(config, runtime.repoRoot, event);
  if (!state?.requiresContextGate || state.contextGateAcquired || isRequirementTool(toolName) || isContextGateTool(toolName)) {
    return undefined;
  }
  if (toolName === "Bash") {
    const command = extractCommand(event.toolInput) ?? "";
    if (!detectShellSearch(command) && !detectBroadSearch(command) && !extractReadTarget(command)) {
      return undefined;
    }
  }
  if (isRawSourceAcquisitionTool(toolName) || toolName === "Bash") {
    const broad = state.requirementKind === "broad_research";
    const message = broad
      ? "ContextGate policy: this is a broad repository investigation. Call contextgate_get_context first with the task to get a bounded evidence packet before broad raw search/read/codegraph acquisition. Narrow direct reads of a specific named file are still fine."
      : "ContextGate policy: this PBI/requirement + code task is incomplete without a ContextGate source-evidence packet. Read Jira/Confluence/GitHub requirements if needed, then call contextgate_get_context with external_artifacts before raw repo search/read/codegraph acquisition.";
    return gatewayModeDecision(
      config,
      message,
      { reason: broad ? "contextgate_required_before_broad_research" : "contextgate_required_before_source_acquisition", gatewayState: state }
    );
  }
  return undefined;
}

function evaluateGatewayPostToolUse(event: TokenOptEvent, config: TokenOptConfig, runtime: PolicyRuntime): PolicyDecision | undefined {
  if (config.policy.gateway.mode === "off") {
    return undefined;
  }
  const toolName = event.toolName ?? "";
  const repoRoot = runtime.repoRoot;
  const state = readGatewayPolicyState(config, repoRoot, event);
  if (!state?.requiresContextGate) {
    return undefined;
  }

  if (isRequirementTool(toolName)) {
    const updated = updateGatewayPolicyState(config, repoRoot, event, {
      requirementAcquired: true,
      requirementToolName: toolName
    });
    return {
      action: "context",
      reason: "Requirement artifact acquired; ContextGate source-evidence is now required before final answer or raw repo exploration.",
      additionalContext:
        "Requirement artifact acquired. Before final answer or raw repository search/read/codegraph acquisition, call contextgate_get_context and pass the fetched requirement as external_artifacts so ContextGate can bind it to impacted files, symbols, tests, risks, and validation.",
      metadata: { gatewayState: updated }
    };
  }

  if (isContextGateTool(toolName)) {
    const packetId = extractPacketId(event.toolResponse);
    const answerable = toolResponseLooksAnswerable(event.toolResponse);
    const updated = updateGatewayPolicyState(config, repoRoot, event, {
      contextGateAcquired: true,
      contextGateToolName: toolName,
      answerablePacketId: answerable ? packetId : state.answerablePacketId
    });
    return {
      action: "context",
      reason: answerable ? "ContextGate packet is answerable; answer from it and stop redundant exploration." : "ContextGate packet acquired; use its missing slots and allowed followups.",
      additionalContext: answerable
        ? "ContextGate marked this task answerable. Answer from the packet and do not run redundant shell/search/read/codegraph acquisition."
        : "ContextGate evidence acquired. If anything remains missing, use only the packet's named bounded followups; do not fall back to broad raw exploration.",
      metadata: { gatewayState: updated }
    };
  }

  return undefined;
}

function gatewayModeDecision(config: TokenOptConfig, reason: string, metadata: Record<string, unknown>): PolicyDecision | undefined {
  if (config.policy.gateway.mode === "off") {
    return undefined;
  }
  if (config.policy.gateway.mode === "shadow") {
    return {
      action: "context",
      reason: `ContextGate shadow policy would deny: ${reason}`,
      additionalContext: reason,
      metadata: { ...metadata, gatewayPolicyMode: "shadow" }
    };
  }
  return {
    action: "deny",
    reason,
    metadata: { ...metadata, gatewayPolicyMode: "hard" }
  };
}

function gatewayRequiredContext(reason: string, requirementKind?: GatewayRequirementKind): string {
  if (requirementKind === "broad_research") {
    return `ContextGate policy: ${reason} Broad repository investigation should start with a ContextGate evidence packet. Call contextgate_get_context first with the task before broad raw repo search/read/codegraph exploration; narrow direct reads of a specific named file are still fine.`;
  }
  return `ContextGate policy: ${reason} PBI/requirement + code tasks are incomplete until ContextGate produces repository source evidence. Use Jira/Confluence/GitHub for the external artifact, then call contextgate_get_context with external_artifacts before final answer or raw repo exploration.`;
}

function stopHookAlreadyActive(event: TokenOptEvent): boolean {
  return Boolean(event.raw && typeof event.raw === "object" && "stop_hook_active" in event.raw && (event.raw as Record<string, unknown>).stop_hook_active === true);
}

function extractPacketId(toolResponse: unknown): string | undefined {
  const text = extractTextFromToolResponse(toolResponse);
  return text?.match(/packet_id:\s*([a-f0-9-]+)/i)?.[1] ?? text?.match(/"packet_id"\s*:\s*"([^"]+)"/i)?.[1];
}

function toolResponseLooksAnswerable(toolResponse: unknown): boolean {
  const text = extractTextFromToolResponse(toolResponse) ?? "";
  return /answerable:\s*true/i.test(text) || /"answerable"\s*:\s*true/i.test(text) || /recommended_next_action:\s*answer_now/i.test(text);
}

function evaluateReadTarget(target: string, config: TokenOptConfig, repoRoot: string): PolicyDecision | undefined {
  const normalized = normalizeRelativePath(target);
  if (!normalized) {
    return undefined;
  }

  if (config.policy.denyLockfileReads && isLockfile(normalized)) {
    return {
      action: "deny",
      reason: `Reading ${path.basename(normalized)} is blocked by TokenOpt because lockfiles are usually high-token and low-signal. Use targeted dependency queries or explain why the lockfile is needed.`
    };
  }

  if (config.policy.denyGeneratedReads && isGeneratedPath(normalized)) {
    return {
      action: "deny",
      reason: `Reading generated or build output is blocked by TokenOpt: ${normalized}. Inspect source files or bounded slices instead.`
    };
  }

  const absolute = path.isAbsolute(normalized) ? normalized : path.join(repoRoot, normalized);
  if (fs.existsSync(absolute)) {
    const stat = fs.statSync(absolute);
    if (stat.isFile() && stat.size > config.policy.maxFileReadBytes) {
      return {
        action: "deny",
        reason: `Full-file read is blocked because ${normalized} is ${stat.size} bytes. Request a bounded slice or targeted search instead.`
      };
    }
  }

  return undefined;
}

function extractCommand(toolInput: unknown): string | undefined {
  if (typeof toolInput === "object" && toolInput !== null) {
    const command = (toolInput as Record<string, unknown>).command;
    return typeof command === "string" ? command : undefined;
  }
  return undefined;
}

function extractReadTarget(command: string): string | undefined {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) {
    return undefined;
  }
  const executable = path.basename(tokens[0] ?? "").toLowerCase();
  if (!["cat", "type", "get-content", "gc"].includes(executable)) {
    return undefined;
  }
  for (const token of tokens.slice(1)) {
    if (token.startsWith("-") || token === "|" || token === ">") {
      continue;
    }
    return token;
  }
  return undefined;
}

function extractMcpReadTarget(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filepath", "uri", "name"]) {
    const value = record[key];
    if (typeof value === "string") {
      return value.startsWith("file://") ? new URL(value).pathname : value;
    }
  }
  return undefined;
}

function detectBroadSearch(command: string): string | undefined {
  const normalized = command.trim();
  if (/^rg\s+["']?\.["']?\s*$/.test(normalized) || /^rg\s+["']{2}\s*$/.test(normalized)) {
    return "Unbounded ripgrep search is blocked.";
  }
  if (/^rg\s+--files\b/.test(normalized)) {
    return "Repo-wide ripgrep file listing is blocked.";
  }
  if (/^grep\s+-R\b.*\s+\.\s*$/.test(normalized)) {
    return "Recursive grep over the whole repo is blocked.";
  }
  if (/^(?:find|Get-ChildItem)\s+\.\b.*(?:-type\s+f|-Recurse)/i.test(normalized)) {
    return "Unbounded recursive file listing is blocked.";
  }
  if (/^ls\s+-R\b/.test(normalized)) {
    return "Recursive ls is blocked.";
  }
  return undefined;
}

function detectShellSearch(command: string): boolean {
  const normalized = command.trim();
  const tokens = tokenizeCommand(normalized);
  const executable = path.basename(tokens[0] ?? "").toLowerCase();
  if (["rg", "grep", "findstr", "ag", "ack"].includes(executable)) {
    return true;
  }
  if (executable === "git" && (tokens[1] ?? "").toLowerCase() === "grep") {
    return true;
  }
  if (executable === "select-string" || executable === "sls") {
    return true;
  }
  return /(?:^|[|;&]\s*)(?:rg|grep|findstr|ag|ack|Select-String|sls)\b/i.test(normalized) ||
    /(?:^|[|;&]\s*)git\s+grep\b/i.test(normalized);
}

function hasTokenOptFollowups(followups: EvidenceFollowup[]): boolean {
  return followups.some((followup) => /^(?:tokenopt_search|tokenopt_read_file|tokenopt_project_facts)$/i.test(followup.tool));
}

function detectExpensiveTest(command: string, config: TokenOptConfig): string | undefined {
  const normalized = command.trim();
  for (const pattern of config.policy.expensiveTests.patterns) {
    if (new RegExp(pattern, "i").test(normalized)) {
      return `Potentially expensive test command detected: ${normalized}.`;
    }
  }
  return undefined;
}

function evaluateCodeGraphPreToolUse(
  toolName: string,
  config: TokenOptConfig,
  runtime: PolicyRuntime
): PolicyDecision | undefined {
  if (!isCodeGraphTool(toolName)) {
    return undefined;
  }

  // When internal bridge is active, the model should not call CodeGraph directly at all —
  // TokenOpt handles it transparently inside contextgate_get_context.
  if (config.codegraph.enabled) {
    return {
      action: "context",
      reason: "CodeGraph internal bridge is active — do not call codegraph_context directly",
      additionalContext:
        "TokenOpt is configured with CodeGraph internal bridge (codegraph.enabled=true). Do not call codegraph_context or codegraph_slice directly — contextgate_get_context already calls CodeGraph internally and folds the results into the evidence packet."
    };
  }

  const recentEvidence = readEvidenceTaskState(config, runtime.repoRoot);
  if (!recentEvidence || Date.parse(recentEvidence.packet.expires_at) <= Date.now()) {
    return {
      action: "context",
      reason: "codegraph called before contextgate_get_context",
      additionalContext:
        "Call contextgate_get_context first to get a bounded evidence packet. CodeGraph should only be called when the packet has a code_graph evidence gap — calling it before any packet exists wastes tokens without adding quality."
    };
  }

  const hasCodeGraphGap = recentEvidence.packet.allowed_followups.some(
    (f) => f.tool_categories?.includes("code_graph")
  );
  if (!hasCodeGraphGap) {
    return {
      action: "context",
      reason: "contextgate packet has no code_graph gap — CodeGraph not needed",
      additionalContext:
        "The current contextgate evidence packet has no code_graph evidence gap. Do not call codegraph_context; answer from the packet instead to avoid token waste."
    };
  }

  return undefined;
}

function containsLikelySecret(text: string): boolean {
  const patterns = [
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\b(?:api[_-]?key|secret|token)\s*[:=]\s*['"]?[A-Za-z0-9_\-.]{24,}/i
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function containsInjectedTokenOptInstructionPaste(text: string): boolean {
  return [
    /Project instruction injected by TokenOpt setup:/i,
    /The user may ask naturally and does not need to name MCP tools[\s\S]*When TokenOpt MCP tools are available/i,
    /When the TokenOpt MCP server is available[\s\S]*contextgate_get_context/i,
    /ContextGate is active as an evidence broker/i,
    /benchmark oracle classifies the task_type/i,
    /actualPromptSentToCodex:/i
  ].some((pattern) => pattern.test(text));
}

function normalizeRelativePath(target: string): string | undefined {
  const withoutQuery = target.split(/[?#]/, 1)[0];
  const cleaned = withoutQuery.replace(/^['"]|['"]$/g, "");
  if (!cleaned || cleaned === "-") {
    return undefined;
  }
  return cleaned;
}

function isLockfile(filePath: string): boolean {
  return LOCKFILE_NAMES.has(path.basename(filePath));
}

function isGeneratedPath(filePath: string): boolean {
  const parts = filePath.split(/[\\/]+/);
  if (parts.some((part) => GENERATED_SEGMENTS.has(part))) {
    return true;
  }
  return /\.(?:min\.js|map|d\.ts)$/.test(filePath);
}
