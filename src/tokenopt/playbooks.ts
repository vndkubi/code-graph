import type { AcquisitionMode, BudgetPolicy, EvidenceContractName, EvidenceFollowup, TaskClass } from "./types.js";

export type PlaybookId =
  | "coding_coverage"
  | "tracebug_direct"
  | "failure_packet"
  | "missing_artifact"
  | "review_bounded"
  | "security_audit"
  | "broad_compile";

export interface ContextGatePlaybook {
  id: PlaybookId;
  taskSignals: string[];
  acquisitionMode: AcquisitionMode;
  evidenceContract: EvidenceContractName;
  budgetPolicy: BudgetPolicy;
  answerabilityRule: string;
  allowedFollowups: EvidenceFollowup[];
}

const PLAYBOOKS: Record<PlaybookId, ContextGatePlaybook> = {
  coding_coverage: {
    id: "coding_coverage",
    taskSignals: ["implement", "write_unittest", "fix_bug", "exact_symbol"],
    acquisitionMode: "coding_coverage",
    evidenceContract: "coding_coverage",
    budgetPolicy: { maxMcpCalls: 2, maxShellCalls: 0, maxFileReads: 1, maxFollowups: 1, maxTotalActions: 2, tokenBudgetHint: 1600 },
    answerabilityRule: "Require target symbol, implementation/signature, dependencies/usages, nearby tests, style, and build/test command.",
    allowedFollowups: [
      { tool: "tokenopt_symbol_packet", reason: "Build one compact symbol packet for the exact target.", max_output_tokens: 1200 }
    ]
  },
  tracebug_direct: {
    id: "tracebug_direct",
    taskSignals: ["tracebug", "bug_trace", "line_level_proof", "failing_test", "stack_frame"],
    acquisitionMode: "direct_narrow",
    evidenceContract: "trace_proof",
    budgetPolicy: { maxMcpCalls: 1, maxShellCalls: 0, maxFileReads: 1, maxFollowups: 1, maxTotalActions: 2, tokenBudgetHint: 1000 },
    answerabilityRule: "Require exact file/line proof, executable symbol/context, and one corroborating caller/callee/test/config cue.",
    allowedFollowups: [
      { tool: "tokenopt_tracebug_packet", reason: "Assemble one tracebug packet around the concrete bug artifact.", max_output_tokens: 1400 },
      { tool: "tokenopt_read_file", reason: "Read one exact slice named by the tracebug artifact or packet.", max_output_tokens: 900 }
    ]
  },
  failure_packet: {
    id: "failure_packet",
    taskSignals: ["stack_trace", "compiler_error", "build_failure", "runtime_exception", "test_failure"],
    acquisitionMode: "failure_packet",
    evidenceContract: "failure_contract",
    budgetPolicy: { maxMcpCalls: 1, maxShellCalls: 1, maxFileReads: 1, maxFollowups: 1, maxTotalActions: 3, tokenBudgetHint: 1200 },
    answerabilityRule: "Require normalized failure output, implicated file/symbol, and nearest fix surface before diagnosis.",
    allowedFollowups: [
      { tool: "tokenopt_failure_packet", reason: "Normalize failure output into exact slices.", max_output_tokens: 900 },
      { tool: "tokenopt_read_file", reason: "Read the top suggested failure slice.", max_output_tokens: 900 }
    ]
  },
  missing_artifact: {
    id: "missing_artifact",
    taskSignals: ["missing_pbi", "missing_requirement", "missing_diff", "missing_tracebug_artifact"],
    acquisitionMode: "ask_or_bypass",
    evidenceContract: "artifact_sufficiency",
    budgetPolicy: { maxMcpCalls: 0, maxShellCalls: 0, maxFileReads: 0, maxFollowups: 0, maxTotalActions: 0, tokenBudgetHint: 400 },
    answerabilityRule: "If a required artifact is absent, ask for it and skip repository acquisition.",
    allowedFollowups: []
  },
  review_bounded: {
    id: "review_bounded",
    taskSignals: ["review_diff", "changed_files", "pr_review", "business_review", "istqb_coverage", "user_checklist"],
    acquisitionMode: "review_bounded",
    evidenceContract: "review_coverage",
    budgetPolicy: { maxMcpCalls: 1, maxShellCalls: 0, maxFileReads: 3, maxFollowups: 3, maxTotalActions: 4, tokenBudgetHint: 2200 },
    answerabilityRule: "Require concrete net diff or PR merge/head scope, changed files/symbols/calls, invariant/config/compatibility impact, test coverage evidence, and item-by-item user checklist coverage when a checklist is provided. Run technical findings first, then business/edge-case/ISTQB coverage gaps; do not downgrade proven regressions into coverage gaps.",
    allowedFollowups: [
      { tool: "tokenopt_search", reason: "Search only changed-scope symbols, direct dependencies, invariants, config setters, compatibility guards, existing tests, or exact user-checklist targets.", max_output_tokens: 800 },
      { tool: "tokenopt_read_file", reason: "Read bounded slices around changed behavior, effective policy/config rules, async/resource lifecycle, nearby tests, and checklist-specific evidence.", max_output_tokens: 1200 }
    ]
  },
  security_audit: {
    id: "security_audit",
    taskSignals: ["security", "authz", "input_boundary", "secret", "deserialization"],
    acquisitionMode: "security_audit",
    evidenceContract: "security_coverage",
    budgetPolicy: { maxMcpCalls: 1, maxShellCalls: 0, maxFileReads: 2, maxFollowups: 2, maxTotalActions: 3, tokenBudgetHint: 1800 },
    answerabilityRule: "Require target/scope, input boundary, auth/authz, validation/deserialization, secrets/config/dependency, and test/guardrail evidence.",
    allowedFollowups: [
      { tool: "tokenopt_search", reason: "Search exact security-relevant target or guardrail only.", max_output_tokens: 700 },
      { tool: "tokenopt_read_file", reason: "Read bounded security boundary or guardrail slices.", max_output_tokens: 1000 }
    ]
  },
  broad_compile: {
    id: "broad_compile",
    taskSignals: ["broad_flow", "business_research", "build_handoff", "repo_overview"],
    acquisitionMode: "compile_evidence",
    evidenceContract: "overview_contract",
    budgetPolicy: { maxMcpCalls: 1, maxShellCalls: 0, maxFileReads: 2, maxFollowups: 2, maxTotalActions: 3, tokenBudgetHint: 1600 },
    answerabilityRule: "Require grounded repo overview or artifact summary plus scoped supporting evidence.",
    allowedFollowups: [
      { tool: "tokenopt_search", reason: "Search only exact terms missing from the evidence packet.", max_output_tokens: 600 },
      { tool: "tokenopt_read_file", reason: "Read bounded slices around exact matches.", max_output_tokens: 900 }
    ]
  }
};

export function getPlaybook(id: PlaybookId): ContextGatePlaybook {
  return PLAYBOOKS[id];
}

export function listPlaybooks(): ContextGatePlaybook[] {
  return Object.values(PLAYBOOKS);
}

export function playbookForTaskClass(taskClass: TaskClass): ContextGatePlaybook {
  switch (taskClass) {
    case "needs_input_bypass":
      return PLAYBOOKS.missing_artifact;
    case "small_repo_bypass":
    case "exact_symbol":
      return PLAYBOOKS.tracebug_direct;
    case "coding_coverage":
    case "refactor_scope":
      return PLAYBOOKS.coding_coverage;
    case "debug_runtime":
      return PLAYBOOKS.failure_packet;
    case "review_diff":
      return PLAYBOOKS.review_bounded;
    case "security_audit":
      return PLAYBOOKS.security_audit;
    case "broad_flow":
    default:
      return PLAYBOOKS.broad_compile;
  }
}
