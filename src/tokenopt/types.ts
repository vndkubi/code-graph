export type TokenOptHookEventName =
  | "user-prompt-submit"
  | "pre-tool-use"
  | "post-tool-use"
  | "pre-compact"
  | "agent-stop";

export type TokenOptSource = "codex" | "copilot" | "mcp";

export type PolicyAction = "allow" | "deny" | "rewrite" | "context" | "compress";

export type BroadSearchMode = "deny" | "warn";
export type ExpensiveTestMode = "allow" | "warn" | "rewrite";
export type AnswerabilityGateMode = "hard" | "shadow" | "off";
export type GatewayPolicyMode = "off" | "shadow" | "hard";
export type GatewayRequirementKind = "pbi_code" | "requirement_code" | "review_business_coverage" | "broad_research";
export type TaskClass =
  | "broad_flow"
  | "review_diff"
  | "security_audit"
  | "debug_runtime"
  | "refactor_scope"
  | "coding_coverage"
  | "exact_symbol"
  | "small_repo_bypass"
  | "needs_input_bypass";
export type ToolProfile = "explore" | "review" | "security" | "debug" | "refactor" | "coding" | "exact" | "bypass";
export type EvidenceTaskType =
  | "api_flow"
  | "field_impact"
  | "review_diff"
  | "startup_flow"
  | "investigate"
  | "research_business"
  | "implement"
  | "write_unittest"
  | "build_handoff"
  | "unknown";
export type EvidenceCoverageStatus = "covered" | "partial" | "missing";
export type EvidenceNextAction = "answer_now" | "expand_exact" | "targeted_shell" | "ask_user";
export type RouteAction = "compile" | "bypass" | "exact_route";
export type OutputPreferredFormat = "unified_diff" | "compact_edit_plan" | "standard_answer";
export type AcquisitionMode =
  | "ask_or_bypass"
  | "direct_narrow"
  | "coding_coverage"
  | "failure_packet"
  | "review_bounded"
  | "security_audit"
  | "compile_evidence";
export type EvidenceContractName =
  | "artifact_sufficiency"
  | "trace_proof"
  | "coding_coverage"
  | "failure_contract"
  | "review_coverage"
  | "security_coverage"
  | "overview_contract";

export interface BudgetPolicy {
  maxMcpCalls: number;
  maxShellCalls: number;
  maxFileReads: number;
  maxFollowups: number;
  maxTotalActions: number;
  tokenBudgetHint?: number;
}

export interface TokenOptConfig {
  version: 1;
  policy: {
    enabled: boolean;
    maxFileReadBytes: number;
    maxCommandOutputChars: number;
    denyGeneratedReads: boolean;
    denyLockfileReads: boolean;
    broadSearch: {
      mode: BroadSearchMode;
      maxResults: number;
    };
    expensiveTests: {
      mode: ExpensiveTestMode;
      patterns: string[];
      targetedHint: string;
    };
    answerabilityGate: {
      mode: AnswerabilityGateMode;
      logShadowDecisions: boolean;
    };
    gateway: {
      mode: GatewayPolicyMode;
      requireContextGateFor: GatewayRequirementKind[];
    };
  };
  context: {
    enableSecretBlock: boolean;
    userPromptGuidance: string;
  };
  paths: {
    artifactDir?: string;
  };
  codex: {
    installScope: "user" | "repo";
  };
  codegraph: {
    enabled: boolean;
    mcpServer?: string;
    cliPath?: string;
  };
}

export interface LoadedConfig {
  config: TokenOptConfig;
  repoRoot: string;
  userConfigPath: string;
  repoConfigPath: string;
  loadedPaths: string[];
}

export interface TokenOptEvent {
  source: TokenOptSource;
  eventName: TokenOptHookEventName;
  cwd: string;
  sessionId?: string;
  turnId?: string;
  permissionMode?: string;
  transcriptPath?: string | null;
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  prompt?: string;
  trigger?: string;
  raw: unknown;
}

export interface PolicyRuntime {
  repoRoot: string;
  tokenoptCommand?: string;
}

export interface PolicyDecision {
  action: PolicyAction;
  reason?: string;
  systemMessage?: string;
  additionalContext?: string;
  updatedInput?: unknown;
  replacementText?: string;
  estimatedTokensSaved?: number;
  shouldPersistRaw?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CompressionResult {
  kind:
    | "vitest"
    | "jest"
    | "pytest"
    | "tsc"
    | "eslint"
    | "java-trace"
    | "build-log"
    | "json-result"
    | "review-findings"
    | "error-summary"
    | "generic";
  text: string;
  originalChars: number;
  compressedChars: number;
  estimatedTokensSaved: number;
  budget?: {
    maxChars: number;
    reason: string;
    ceilingChars: number;
    floorChars: number;
  };
}

export interface RouteDecision {
  taskClass: TaskClass;
  taskType: EvidenceTaskType;
  toolProfile: ToolProfile;
  action: RouteAction;
  acquisitionMode: AcquisitionMode;
  evidenceContract: EvidenceContractName;
  budgetPolicy: BudgetPolicy;
  fallbackReason?: string;
  reason: string;
  confidence: number;
  promptSignals: string[];
  negativeControl: boolean;
}

export interface CodingSymbol {
  id: string;
  name: string;
  kind: "class" | "interface" | "function" | "method" | "const" | "type" | "unknown";
  language: "typescript" | "javascript" | "java" | "python" | "unknown";
  file: string;
  line: number;
  signature: string;
  confidence: number;
}

export interface SymbolPacket {
  symbol: CodingSymbol;
  definition_slice: {
    file: string;
    startLine: number;
    endLine: number;
    text: string;
  };
  imports: string[];
  dependencies: string[];
  callers: Array<{ file: string; line: number; text: string }>;
  callees: string[];
  nearby_tests: string[];
  coverage: Record<string, EvidenceCoverageStatus>;
}

export interface TestNeighborPacket {
  target: string;
  source_files: string[];
  test_files: string[];
  naming_patterns: string[];
  framework_hints: string[];
  mocking_hints: string[];
  coverage: Record<string, EvidenceCoverageStatus>;
}

export interface FailurePacket {
  failure_kind: "typescript" | "javascript" | "python" | "java" | "test" | "unknown";
  errors: Array<{
    file?: string;
    line?: number;
    column?: number;
    symbol?: string;
    message: string;
  }>;
  suggested_slices: Array<{ file: string; startLine: number; maxLines: number; reason: string }>;
  raw_lines_kept: number;
}

export interface CodingCoverageContract {
  task_kind: "implement" | "write_unittest" | "fix_bug" | "debug_runtime" | "exact_symbol";
  answerable: boolean;
  confidence: number;
  coverage: Record<string, EvidenceCoverageStatus>;
  missing: string[];
  allowed_followups: EvidenceFollowup[];
  metadata?: Record<string, unknown>;
}

export interface CoverageCertificate {
  packet_id?: string;
  task_class: TaskClass;
  acquisition_mode: AcquisitionMode;
  evidence_contract: EvidenceContractName;
  evidence_contract_pass: boolean;
  fallback_reason?: string;
  answerable: boolean;
  confidence: number;
  dimensions: Record<string, EvidenceCoverageStatus>;
  missing: string[];
  followup_exact_tools_allowed: string[];
  deny_broad_exploration: boolean;
}

export interface OutputPolicy {
  preferred_format: OutputPreferredFormat;
  avoid_full_file_rewrite: boolean;
  include_explanation_max_tokens: number;
  applies_to: string[];
}

export interface ShadowGateLog {
  taskId: string;
  taskClass: TaskClass;
  toolName: string;
  wouldDeny: boolean;
  reason?: string;
  answerable: boolean;
  estimatedTokensAvoided: number;
  timestamp: number;
  missingDimensions: string[];
  allowedExactTools: string[];
}

export interface EvidenceItem {
  id: string;
  claim: string;
  files?: string[];
  facts?: string[];
  snippet?: string;
  tokens_est?: number;
}

export type EvidenceToolCategory =
  | "code_graph"       // call-chain tracing, symbol lookup, impact analysis
  | "code_ownership"   // which file/class/module owns a concept
  | "file_read"        // exact file content read by known path
  | "search"           // broad symbol or text search across repo
  | "external_source"; // fetch from Jira, GitHub, issue tracker, etc.

export interface EvidenceFollowup {
  tool: string;
  reason: string;
  args?: Record<string, unknown>;
  max_output_tokens?: number;
  // Generic slot descriptor so any tool matching tool_categories works.
  // Agent should use whatever available tool fits tool_categories,
  // not necessarily the named `tool` above.
  evidence_slot?: string;
  tool_categories?: EvidenceToolCategory[];
}

export interface EvidenceAnswerContract {
  required_sections: string[];
  evidence_rules: string[];
  quality_checks: string[];
  failure_conditions: string[];
  user_rubric: string[];
}

export interface EvidencePacket {
  packet_id: string;
  task: string;
  task_type: EvidenceTaskType;
  route?: RouteDecision;
  repo_root: string;
  acquisition_mode: AcquisitionMode;
  evidence_contract: EvidenceContractName;
  evidence_contract_pass: boolean;
  fallback_reason?: string;
  answerable: boolean;
  confidence: number;
  coverage: Record<string, EvidenceCoverageStatus>;
  coverage_certificate?: CoverageCertificate;
  output_policy?: OutputPolicy;
  evidence: EvidenceItem[];
  missing: string[];
  answer_contract: EvidenceAnswerContract;
  allowed_followups: EvidenceFollowup[];
  disallowed_followups: string[];
  recommended_next_action: EvidenceNextAction;
  max_additional_calls: number;
  token_budget: {
    budget_tokens: number;
    evidence_tokens_est: number;
    response_tokens_est: number;
  };
  metadata?: Record<string, unknown>;
  created_at: string;
  expires_at: string;
}

export interface TracebugEvidenceLine {
  path: string;
  lineStart: number;
  lineEnd: number;
  symbol?: string;
  role: "top_frame" | "failing_assert" | "candidate_definition" | "caller" | "callee" | "nearby_test" | "config" | "build_script";
  confidence: number;
  why: string;
  snippet: string;
}

export interface TracebugPacket {
  status: "grounded" | "needs_read" | "needs_repro" | "needs_artifact";
  traceClass: "runtime_exception" | "failing_test" | "compile_error" | "behavior_regression" | "unknown";
  anchors: string[];
  evidence: TracebugEvidenceLine[];
  failurePacket?: FailurePacket;
  recommendedNextAction: "answer_now" | "read_exact_slice" | "run_one_test" | "run_one_build" | "ask_for_artifact";
  suggestedRead?: { path: string; lineStart: number; lineEnd: number };
  suggestedCommand?: string;
  answerability: {
    directEvidence: boolean;
    corroboration: boolean;
    exactLineProof: boolean;
    canAnswer: boolean;
    reason: string;
  };
}

export interface EvidenceTaskState {
  packet: EvidencePacket;
  stored_at: string;
  repo_fingerprint?: RepoFingerprint;
}

export interface RepoFingerprint {
  strategy: "git-head-and-status-v1" | "file-metadata-v1";
  repoRoot: string;
  head?: string;
  statusHash?: string;
  fileHash?: string;
  createdAt: string;
}

export interface ObservabilityEvent {
  timestamp: string;
  source: TokenOptSource | "cli";
  eventName: string;
  repoRoot: string;
  action: PolicyAction | "exec" | "audit" | "install" | "doctor" | "evidence" | "shadow";
  reason?: string;
  toolName?: string;
  command?: string;
  artifactPath?: string;
  estimatedTokensSaved?: number;
  metadata?: Record<string, unknown>;
}
