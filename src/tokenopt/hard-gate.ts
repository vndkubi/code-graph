import { evaluateShadowGate, logShadowGateDecision } from "./shadow-gate.js";
import type { EvidenceTaskState, PolicyDecision, TokenOptConfig } from "./types.js";

export interface HardGateInput {
  config: TokenOptConfig;
  repoRoot: string;
  state: EvidenceTaskState;
  toolName: string;
  toolInput?: unknown;
  reason: string;
  hardReason: string;
  shadowContext: string;
  forceWouldDeny?: boolean;
}

export function evaluateHardGate(input: HardGateInput): PolicyDecision {
  const shadow = evaluateShadowGate({
    state: input.state,
    toolName: input.toolName,
    toolInput: input.toolInput,
    reason: input.reason,
    forceWouldDeny: input.forceWouldDeny
  });
  logShadowGateDecision(input.config, input.repoRoot, shadow);

  if (input.config.policy.answerabilityGate.mode === "off") {
    return {
      action: "allow",
      metadata: { shadowGate: shadow, hardGateMode: "off" }
    };
  }

  if (input.config.policy.answerabilityGate.mode === "shadow") {
    return {
      action: "context",
      reason: `TokenOpt shadow gate would deny: ${input.hardReason}`,
      additionalContext: input.shadowContext,
      estimatedTokensSaved: shadow.estimatedTokensAvoided,
      metadata: { shadowGate: shadow, hardGateMode: "shadow" }
    };
  }

  return {
    action: "deny",
    reason: input.hardReason,
    estimatedTokensSaved: shadow.estimatedTokensAvoided,
    metadata: { shadowGate: shadow, hardGateMode: "hard" }
  };
}
