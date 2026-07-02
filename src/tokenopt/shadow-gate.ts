import { appendEvent } from "./observability.js";
import { taskClassFromTaskType } from "./router.js";
import { tokenizeCommand } from "./shell.js";
import { estimateTokens } from "./token-estimator.js";
import type { EvidenceTaskState, ShadowGateLog, TokenOptConfig } from "./types.js";

const TOOL_CALL_OVERHEAD_TOKENS = 600;

export interface ShadowGateInput {
  state: EvidenceTaskState;
  toolName: string;
  toolInput?: unknown;
  reason?: string;
  forceWouldDeny?: boolean;
}

export function evaluateShadowGate(input: ShadowGateInput): ShadowGateLog {
  const packet = input.state.packet;
  const broad = isBroadExploratoryTool(input.toolName, input.toolInput);
  const wouldDeny = input.forceWouldDeny ?? (packet.answerable && broad);
  const missingDimensions = Object.entries(packet.coverage)
    .filter(([, status]) => status !== "covered")
    .map(([name]) => name)
    .slice(0, 12);
  return {
    taskId: packet.packet_id,
    taskClass: packet.route?.taskClass ?? packet.coverage_certificate?.task_class ?? taskClassFromTaskType(packet.task_type),
    toolName: input.toolName,
    wouldDeny,
    reason: input.reason ?? (wouldDeny ? "answerable_packet_would_block_redundant_exploration" : undefined),
    answerable: packet.answerable,
    estimatedTokensAvoided: wouldDeny ? estimateToolTokens(input.toolInput) : 0,
    timestamp: Date.now(),
    missingDimensions,
    allowedExactTools: packet.allowed_followups.map((followup) => followup.tool)
  };
}

export function logShadowGateDecision(config: TokenOptConfig, repoRoot: string, log: ShadowGateLog): void {
  if (!config.policy.answerabilityGate.logShadowDecisions) {
    return;
  }
  appendEvent(config, {
    timestamp: new Date(log.timestamp).toISOString(),
    source: "cli",
    eventName: "shadow-gate",
    repoRoot,
    action: "shadow",
    toolName: log.toolName,
    estimatedTokensSaved: log.estimatedTokensAvoided,
    reason: log.reason,
    metadata: {
      shadowGate: log,
      fallback_after_answerable: log.answerable && log.wouldDeny ? 1 : 0,
      redundant_call: log.wouldDeny ? 1 : 0
    }
  });
}

export function isBroadExploratoryTool(toolName: string, toolInput?: unknown): boolean {
  if (/search|list|find/i.test(toolName) && !/read_file|get_file_slice/i.test(toolName)) {
    return true;
  }

  if (toolName !== "Bash") {
    return false;
  }
  const command = extractCommand(toolInput);
  if (!command) {
    return false;
  }
  const normalized = command.trim();
  const tokens = tokenizeCommand(normalized);
  const executable = tokens[0]?.toLowerCase() ?? "";
  if (["rg", "grep", "findstr", "ag", "ack"].includes(executable)) {
    return true;
  }
  if (executable === "git" && tokens[1]?.toLowerCase() === "grep") {
    return true;
  }
  return /^rg\s+--files\b/i.test(normalized) ||
    /^grep\s+-R\b/i.test(normalized) ||
    /(?:^|[|;&]\s*)(?:rg|grep|findstr|ag|ack|Select-String|sls)\b/i.test(normalized) ||
    /(?:^|[|;&]\s*)git\s+grep\b/i.test(normalized);
}

function extractCommand(toolInput: unknown): string | undefined {
  if (typeof toolInput !== "object" || toolInput === null) {
    return undefined;
  }
  const command = (toolInput as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}

function estimateToolTokens(toolInput: unknown): number {
  const text = typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput ?? {});
  return estimateTokens(text) + TOOL_CALL_OVERHEAD_TOKENS;
}
