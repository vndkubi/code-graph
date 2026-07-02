import fs from "node:fs";
import path from "node:path";
import { getRepoCacheDir } from "./observability.js";
import type { GatewayRequirementKind, TaskClass, TokenOptConfig, TokenOptEvent } from "./types.js";

export interface GatewayPolicyState {
  sessionId?: string;
  turnId?: string;
  requiresContextGate: boolean;
  requirementAcquired: boolean;
  contextGateAcquired: boolean;
  answerablePacketId?: string;
  reason: string;
  requirementKind?: GatewayRequirementKind;
  requirementToolName?: string;
  contextGateToolName?: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface GatewayPromptClassification {
  requiresContextGate: boolean;
  reason: string;
  requirementKind?: GatewayRequirementKind;
}

const STATE_TTL_MS = 30 * 60 * 1000;

export function classifyGatewayPrompt(prompt: string, config: TokenOptConfig, taskClass?: TaskClass): GatewayPromptClassification {
  if (config.policy.gateway.mode === "off") {
    return { requiresContextGate: false, reason: "gateway_policy_off" };
  }

  const text = prompt.trim();
  const requirement = hasRequirementSignal(text);
  const codeIntent = hasCodeIntentSignal(text);
  const reviewIntent = hasReviewBusinessCoverageSignal(text);
  if (requirement && codeIntent && config.policy.gateway.requireContextGateFor.includes("pbi_code")) {
    return {
      requiresContextGate: true,
      requirementKind: "pbi_code",
      reason: "Prompt combines PBI/requirement evidence with code, implementation, test, impact, debug, or investigation intent."
    };
  }
  if (requirement && codeIntent && config.policy.gateway.requireContextGateFor.includes("requirement_code")) {
    return {
      requiresContextGate: true,
      requirementKind: "requirement_code",
      reason: "Prompt combines external requirement evidence with repository source-evidence intent."
    };
  }
  if (requirement && reviewIntent && config.policy.gateway.requireContextGateFor.includes("review_business_coverage")) {
    return {
      requiresContextGate: true,
      requirementKind: "review_business_coverage",
      reason: "Prompt asks for review/business coverage against external requirement evidence."
    };
  }
  // Broad repository investigation with no external requirement still slips past the three
  // requirement-bound branches above. Such a task should acquire a ContextGate packet before
  // raw source exploration — otherwise an agent that skips MCP entirely never creates a packet
  // and no answerability gate ever fires. Exclude pure external/requirement-only summaries
  // (requirement signal but no code intent, e.g. "Summarize Jira ABC-123"): those need no repo
  // source evidence.
  if (
    taskClass === "broad_flow" &&
    !(requirement && !codeIntent) &&
    config.policy.gateway.requireContextGateFor.includes("broad_research")
  ) {
    return {
      requiresContextGate: true,
      requirementKind: "broad_research",
      reason: "Prompt is a broad repository investigation that should acquire a ContextGate evidence packet before raw source exploration."
    };
  }

  return { requiresContextGate: false, reason: requirement ? "requirement_only_without_code_intent" : "no_requirement_signal" };
}

export function readGatewayPolicyState(config: TokenOptConfig, repoRoot: string, event: Pick<TokenOptEvent, "sessionId" | "turnId">): GatewayPolicyState | undefined {
  const filePath = getGatewayStatePath(config, repoRoot, event);
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  try {
    const state = JSON.parse(fs.readFileSync(filePath, "utf8")) as GatewayPolicyState;
    if (Date.parse(state.expires_at) <= Date.now()) {
      return undefined;
    }
    return state;
  } catch {
    return undefined;
  }
}

export function writeGatewayPolicyState(config: TokenOptConfig, repoRoot: string, event: Pick<TokenOptEvent, "sessionId" | "turnId">, state: GatewayPolicyState): string {
  const filePath = getGatewayStatePath(config, repoRoot, event);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return filePath;
}

export function updateGatewayPolicyState(
  config: TokenOptConfig,
  repoRoot: string,
  event: Pick<TokenOptEvent, "sessionId" | "turnId">,
  update: Partial<Omit<GatewayPolicyState, "created_at" | "updated_at" | "expires_at">>
): GatewayPolicyState {
  const now = new Date();
  const existing = readGatewayPolicyState(config, repoRoot, event);
  const state: GatewayPolicyState = {
    sessionId: event.sessionId,
    turnId: event.turnId,
    requiresContextGate: false,
    requirementAcquired: false,
    contextGateAcquired: false,
    reason: "not_required",
    created_at: existing?.created_at ?? now.toISOString(),
    updated_at: now.toISOString(),
    expires_at: new Date(now.getTime() + STATE_TTL_MS).toISOString(),
    ...existing,
    ...update
  };
  state.updated_at = now.toISOString();
  state.expires_at = new Date(now.getTime() + STATE_TTL_MS).toISOString();
  writeGatewayPolicyState(config, repoRoot, event, state);
  return state;
}

export function isRequirementTool(toolName: string | undefined): boolean {
  return Boolean(toolName && /(?:jira|confluence|github|issue|pull_request|attachment)/i.test(toolName));
}

export function isContextGateTool(toolName: string | undefined): boolean {
  return Boolean(toolName && /(?:contextgate_get_context|tokenopt_compile_evidence)/i.test(toolName));
}

export function isCodeGraphTool(toolName: string | undefined): boolean {
  return Boolean(toolName && /(?:codegraph_context|codegraph_slice)/i.test(toolName));
}

export function isRawSourceAcquisitionTool(toolName: string | undefined): boolean {
  if (!toolName || isRequirementTool(toolName) || isContextGateTool(toolName)) {
    return false;
  }
  return /(?:grep|search|read|read_file|file_search|textSearch|codegraph|codegraph_context|codegraph_slice)/i.test(toolName);
}

function getGatewayStatePath(config: TokenOptConfig, repoRoot: string, event: Pick<TokenOptEvent, "sessionId" | "turnId">): string {
  const key = `${event.sessionId ?? "session"}-${event.turnId ?? "turn"}`.replace(/[^a-z0-9_.-]/gi, "-").slice(0, 100);
  return path.join(getRepoCacheDir(config, repoRoot), `gateway-policy-state-${key}.json`);
}

function hasRequirementSignal(text: string): boolean {
  return /\b(?:PBI|Jira|ticket|issue|story|requirement|acceptance criteria|Confluence|spec|AC|bug\s+\d+|[A-Z][A-Z0-9]+-\d+)\b/i.test(text);
}

function hasCodeIntentSignal(text: string): boolean {
  return /\b(?:code|repo|repository|source|implement|implementation|plan|impact|test|unit[- ]?test|debug|fix|trace|investigate|flow|endpoint|class|method|symbol|files?|current behavior|validation)\b/i.test(text);
}

function hasReviewBusinessCoverageSignal(text: string): boolean {
  return /\b(?:review|PR|pull request|diff|branch)\b/i.test(text) && /\b(?:business|edge case|test coverage|requirement|PBI|Jira|Confluence)\b/i.test(text);
}
