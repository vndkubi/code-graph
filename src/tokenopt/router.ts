import { getPlaybook, playbookForTaskClass, type PlaybookId } from "./playbooks.js";
import type { EvidenceTaskType, RouteDecision, TaskClass, ToolProfile } from "./types.js";

export interface RouteTaskInput {
  task: string;
  repoFileCount?: number;
  requestedTaskType?: EvidenceTaskType;
}

const SMALL_REPO_FILE_LIMIT = 250;
const GENERIC_SYMBOL_SIGNALS = new Set([
  "Benchmark",
  "JSON",
  "Project",
  "Repository",
  "Router",
  "TokenOpt"
]);

export function routeTask(input: RouteTaskInput): RouteDecision {
  const task = input.task.trim();
  const signals = collectPromptSignals(task);
  const prompt = task.toLowerCase();
  const hasExactFileTarget = signals.some((signal) => signal.startsWith("file:"));
  const hasExactSymbolTarget = signals.some((signal) => signal.startsWith("symbol:"));
  const hasExactTarget = hasExactFileTarget || hasExactSymbolTarget;
  const requestedTaskType = input.requestedTaskType && input.requestedTaskType !== "unknown" ? input.requestedTaskType : undefined;
  const missingArtifactReason = getMissingArtifactReason(task, prompt, signals);
  const tracebugClassification = classifyTracebugPrompt(task, prompt, signals);

  if (isSecurityAuditPrompt(prompt)) {
    return decision("security_audit", "review_diff", "security", "compile", [
      missingArtifactReason ?? "Prompt is security-audit oriented; require explicit security coverage before answerability.",
      ...(missingArtifactReason ? ["artifact:missing"] : []),
      ...signals
    ], "security_audit", missingArtifactReason ? "missing_security_scope" : undefined);
  }

  if (tracebugClassification === "missing_artifact") {
    return decision("needs_input_bypass", requestedTaskType ?? "investigate", "bypass", "bypass", [
      "Prompt asks for tracebug/bug investigation but no concrete failing test, stack trace, error output, repro path, file, symbol, line, or exact behavior was provided.",
      "artifact:missing",
      ...signals
    ], "missing_artifact", "missing_tracebug_artifact");
  }

  if (tracebugClassification === "failure_packet") {
    return decision("debug_runtime", requestedTaskType ?? "investigate", "debug", "compile", [
      "Prompt includes failure output; normalize it as a failure packet before any broad repository acquisition.",
      ...signals
    ], "failure_packet");
  }

  if (tracebugClassification === "direct_narrow") {
    return decision("exact_symbol", requestedTaskType ?? "investigate", "exact", "exact_route", [
      "Prompt is an exact tracebug/code-flow proof task; use native narrow search/read or one tracebug packet instead of broad ContextGate first.",
      ...signals
    ], "tracebug_direct");
  }

  if (missingArtifactReason) {
    return decision("needs_input_bypass", missingArtifactTaskType(task, prompt, requestedTaskType), "bypass", "bypass", [
      missingArtifactReason,
      "artifact:missing",
      ...signals
    ], "missing_artifact", "missing_required_artifact");
  }

  if ((input.repoFileCount ?? Number.MAX_SAFE_INTEGER) < SMALL_REPO_FILE_LIMIT && hasExactFileTarget && !isReviewPrompt(prompt)) {
    return decision("small_repo_bypass", requestedTaskType ?? "field_impact", "bypass", "bypass", [
      "Small repository with an exact file or symbol target; generic evidence compilation is likely overhead.",
      ...signals
    ], "tracebug_direct");
  }

  if (isTaskTaxonomyResearchPrompt(prompt)) {
    return decision("broad_flow", requestedTaskType ?? "research_business", "explore", "compile", [
      "Prompt asks for a taxonomy of supported developer workflows; gather broad repository context instead of treating listed task classes as active task artifacts.",
      ...signals
    ], "broad_compile");
  }

  if (isReviewPrompt(prompt)) {
    return decision("review_diff", "review_diff", "review", "compile", [
      "Prompt is review/diff oriented; use review-shaped evidence and avoid repo-wide exploration.",
      ...signals
    ], "review_bounded");
  }

  if (isCodingCoveragePrompt(task, requestedTaskType)) {
    return decision("coding_coverage", requestedTaskType ?? inferCodingTaskType(task), "coding", "compile", [
      "Prompt is a coding task; require symbol/test/failure coverage before answerability.",
      ...signals
    ], "coding_coverage");
  }

  if (/\b(stack trace|exception|failing test|build failure|runtime|root cause|diagnose|debug|caused by)\b/i.test(task)) {
    return decision("debug_runtime", requestedTaskType ?? "investigate", "debug", "compile", [
      "Prompt is runtime/debug oriented; preserve failure slices and allow exact fallback for missing frames.",
      ...signals
    ], "failure_packet");
  }

  if (/\b(refactor|rename|move|extract|split|migrate)\b/i.test(task)) {
    return decision("refactor_scope", requestedTaskType ?? "implement", "refactor", "compile", [
      "Prompt is refactor/change-scope oriented; gather impact evidence and prefer diff output.",
      ...signals
    ], "coding_coverage");
  }

  if (/\b(find usages|where defined|who calls|callers|references|definition|impact of)\b/i.test(task) || hasExactTarget) {
    return decision("exact_symbol", requestedTaskType ?? "field_impact", "exact", "exact_route", [
      "Prompt asks for exact symbol or file impact; use targeted search/read instead of generic MCP-first.",
      ...signals
    ], "tracebug_direct");
  }

  const taskType = requestedTaskType ?? inferBroadTaskType(task);
  return decision("broad_flow", taskType, "explore", "compile", [
    "Prompt needs broad repository context; compile a compact evidence packet before further exploration.",
    ...signals
  ], "broad_compile");
}

export function taskClassFromTaskType(taskType: EvidenceTaskType): TaskClass {
  switch (taskType) {
    case "review_diff":
      return "review_diff";
    case "api_flow":
    case "startup_flow":
    case "research_business":
    case "build_handoff":
      return "broad_flow";
    case "field_impact":
      return "exact_symbol";
    case "implement":
    case "write_unittest":
      return "coding_coverage";
    case "investigate":
      return "debug_runtime";
    default:
      return "broad_flow";
  }
}

function decision(
  taskClass: TaskClass,
  taskType: EvidenceTaskType,
  toolProfile: ToolProfile,
  action: RouteDecision["action"],
  reasons: string[],
  playbookId?: PlaybookId,
  fallbackReason?: string
): RouteDecision {
  const playbook = playbookId ? getPlaybook(playbookId) : playbookForTaskClass(taskClass);
  const confidence = taskClass === "broad_flow"
    ? 0.72
    : taskClass === "small_repo_bypass" || taskClass === "needs_input_bypass"
      ? 0.88
      : taskClass === "coding_coverage"
        ? 0.84
        : 0.82;
  return {
    taskClass,
    taskType,
    toolProfile,
    action,
    acquisitionMode: playbook.acquisitionMode,
    evidenceContract: playbook.evidenceContract,
    budgetPolicy: playbook.budgetPolicy,
    fallbackReason,
    reason: reasons[0] ?? "Route selected by prompt heuristics.",
    confidence,
    promptSignals: reasons.slice(1, 12),
    negativeControl: taskClass === "small_repo_bypass" || taskClass === "exact_symbol" || taskClass === "needs_input_bypass"
  };
}

type TracebugClassification = "missing_artifact" | "direct_narrow" | "failure_packet" | undefined;

function classifyTracebugPrompt(task: string, prompt: string, signals: string[]): TracebugClassification {
  if (!isTracebugPrompt(task, prompt)) {
    return undefined;
  }
  if (!hasTracebugArtifact(task, prompt, signals)) {
    return "missing_artifact";
  }
  if (hasLongFailureArtifact(task)) {
    return "failure_packet";
  }
  return "direct_narrow";
}

function isTracebugPrompt(task: string, prompt: string): boolean {
  if (isReviewPrompt(prompt) || isSecurityAuditPrompt(prompt) || isUnitTestPlanningPrompt(prompt)) {
    return false;
  }
  return /\b(tracebug|trace bug|bug trace|trace this bug|trace the bug|line-level proof|line level proof|root cause|debug|diagnose|failing test|stack trace|traceback|caused by|runtime exception|build failure|compile error|compilation error|why does|why is)\b/i.test(task);
}

function hasTracebugArtifact(task: string, prompt: string, signals: string[]): boolean {
  if (signals.some((signal) => signal.startsWith("file:") || signal.startsWith("symbol:") || signal === "diff:inline")) {
    return true;
  }
  return /\b(?:stack trace|traceback|caused by|build failure|compilation error|compile error|repro|reproduction|guard|condition|check|logic)\b/i.test(task) ||
    /\bfailing test\s+[`"']?[A-Za-z0-9_.#:-]+/i.test(task) ||
    /\b[A-Z][A-Za-z0-9_]*(?:Exception|Error)\b/.test(task) ||
    /\b(?:expected|actual|endpoint|route|api|behavior|failure)\s*[:=]\s*\S.{8,}/i.test(task) ||
    /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[A-Za-z0-9_./{}:-]+/i.test(task) ||
    /\bline\s+\d+\b/i.test(task) ||
    /\b[A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|java|py):\d+\b/i.test(task) ||
    /```[\s\S]{20,}```/.test(task) ||
    /[`"'][^`"']{12,}[`"']/.test(task) ||
    /\b(?:behavior|bug|issue|failure)\s*:\s*\S.{12,}/i.test(prompt);
}

function hasLongFailureArtifact(task: string): boolean {
  const lines = task.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.length >= 3 &&
    /\b(?:stack trace|traceback|caused by|BUILD FAILURE|COMPILATION ERROR|Tests run:|FAIL|FAILED|AssertionError|TS\d{4}|Exception|Error)\b/i.test(task);
}

function getMissingArtifactReason(task: string, prompt: string, signals: string[]): string | undefined {
  if (isReviewPrompt(prompt)) {
    if (hasCodeReviewArtifact(task, signals)) {
      return undefined;
    }
    const hasRequirementReference = signals.includes("business:jira") || signals.includes("business:confluence");
    return hasRequirementReference
      ? "Prompt asks for code review and includes Jira/Confluence requirement evidence, but no concrete code review artifact was provided. Read the requirement via MCP when available, but ask for a diff, PR, branch pair, changed file list, file path, symbol, or risky surface before reviewing code."
      : "Prompt asks for review but no concrete diff, changed file list, PR, branch pair, symbol, or risky surface was provided.";
  }
  if (isPromoteReviewMemoryPrompt(prompt)) {
    return "Prompt asks to promote review memory but no completed-task summary, transcript, diff, or review evidence was provided.";
  }
  if (hasConcreteArtifact(task, signals)) {
    return undefined;
  }
  if (isTaskTaxonomyResearchPrompt(prompt)) {
    return undefined;
  }
  if (isUnitTestPlanningPrompt(prompt)) {
    return "Prompt asks for a unit-test plan but no target class, module, file, behavior, or failing case was provided.";
  }
  if (isPbiOrRequirementPlanPrompt(prompt)) {
    return "Prompt asks for a PBI/requirement implementation plan but no concrete PBI, requirement body, issue, or acceptance criteria was provided.";
  }
  if (isRequirementAnalysisPrompt(prompt)) {
    return "Prompt asks to analyze a requirement but no requirement text, ticket, or acceptance criteria was provided.";
  }
  return undefined;
}

function hasCodeReviewArtifact(task: string, signals: string[]): boolean {
  if (signals.some((signal) => signal.startsWith("file:") || signal.startsWith("symbol:") || signal === "diff:inline" || signal === "review:branch-pair")) {
    return true;
  }
  return /https?:\/\/\S*(?:\/pull\/\d+|\/merge_requests\/\d+|\/compare\/|\/commit\/)/i.test(task) ||
    /\b(?:PR|pull request|merge request|MR)\s*#?\d+\b/i.test(task) ||
    /\b(?:changed files?|diff|risky surface)\s*:\s*\S.{20,}/is.test(task) ||
    /\b(?:base|target|develop|main|master|release|branch)\s+[-A-Za-z0-9_./]+\s+(?:to|into|<-|<--|from|vs|against)\s+(?:head|source|feature|branch)?\s*[-A-Za-z0-9_./]+/i.test(task) ||
    /\b(?:feature|head|source|branch)\s+[-A-Za-z0-9_./]+\s+(?:to|into|->|-->|against)\s+(?:develop|main|master|release|target|base|branch)\s+[-A-Za-z0-9_./]+/i.test(task);
}

function isTaskTaxonomyResearchPrompt(prompt: string): boolean {
  return /\b(?:research|analyze|explain|summarize)\b[\s\S]{0,120}\b(?:developer tasks|task classes|workflow classes|workflows this repo|tasks this repo)\b/i.test(prompt) ||
    /\bwhat developer tasks\b/i.test(prompt);
}

function hasConcreteArtifact(task: string, signals: string[]): boolean {
  if (signals.some((signal) => signal.startsWith("file:") || signal.startsWith("symbol:") || signal === "diff:inline" || signal === "review:branch-pair")) {
    return true;
  }
  if (hasConcreteBehaviorAnchor(task)) {
    return true;
  }
  return /https?:\/\/\S+/i.test(task) ||
    /\b(?:PBI|PB|REQ|ISSUE|BUG|TASK|JIRA|GH|PR)[-_]?\d+\b/i.test(task) ||
    /#\d{2,}\b/.test(task) ||
    /\b(?:base|target|develop|main|master|release|branch)\s+[-A-Za-z0-9_./]+\s+(?:to|into|<-|<--|from|vs|against)\s+(?:head|source|feature|branch)?\s*[-A-Za-z0-9_./]+/i.test(task) ||
    /\b(?:feature|head|source|branch)\s+[-A-Za-z0-9_./]+\s+(?:to|into|->|-->|against)\s+(?:develop|main|master|release|target|base|branch)\s+[-A-Za-z0-9_./]+/i.test(task) ||
    /\b(?:requirement|pbi|acceptance criteria|completed task|task summary|transcript|diff|changed files?|risky surface|behavior)\s*:\s*\S.{20,}/is.test(task) ||
    /```[\s\S]{20,}```/.test(task) ||
    /[`"'][^`"']{20,}[`"']/.test(task);
}

function hasConcreteBehaviorAnchor(task: string): boolean {
  const anchorTask = stripRouterOutputContractText(task);
  return /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[A-Za-z0-9_./{}:-]+/i.test(anchorTask) ||
    /(?:^|\s)\/[A-Za-z0-9_{}:-]+(?:\/[A-Za-z0-9_{}:-]+)+/.test(anchorTask) ||
    hasConcreteIdentifierAnchor(anchorTask) ||
    hasConcreteHyphenAnchor(anchorTask) ||
    /\b(?:route|endpoint|api|request\s+param|query\s+param|parameter|field|property|flag|config)\s+(?:for|around|of|called|named|by|on|in)?\s*[`"']?[A-Za-z0-9_./:-]{5,}/i.test(anchorTask) ||
    /\b(?:behavior|flow)\s*:\s*\S.{12,}/i.test(anchorTask) ||
    /\b(?:behavior|flow)\s+(?:for|around|of|called|named)\s+[`"']?[A-Za-z0-9_./:-]{5,}/i.test(anchorTask);
}

function stripRouterOutputContractText(text: string): string {
  return text.replace(/\bReturn\s+(?:valid\s+)?(?:compact\s+)?JSON\b[\s\S]*$/i, "").trim();
}

const GENERIC_HYPHEN_ANCHORS = new Set([
  "end-to-end",
  "integration-test",
  "line-level",
  "on-call",
  "test-plan",
  "unit-test"
]);

const GENERIC_IDENTIFIER_ANCHORS = new Set([
  "existing_coverage",
  "existingcoverage",
  "implementation_plan",
  "implementationplan",
  "likely_root_causes",
  "likelyrootcauses",
  "missing_coverage",
  "missingcoverage",
  "target_behavior",
  "targetbehavior",
  "test_commands",
  "testcommands",
  "tests_to_add",
  "tests_to_run",
  "teststoadd",
  "teststorun"
]);

function hasConcreteIdentifierAnchor(task: string): boolean {
  for (const match of task.matchAll(/\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/g)) {
    if (!isGenericIdentifierAnchor(match[0])) {
      return true;
    }
  }
  for (const match of task.matchAll(/\b[a-z][a-z0-9]+(?:_[a-z0-9]+)+\b/g)) {
    if (!isGenericIdentifierAnchor(match[0])) {
      return true;
    }
  }
  return false;
}

function isGenericIdentifierAnchor(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return GENERIC_IDENTIFIER_ANCHORS.has(value.toLowerCase()) ||
    GENERIC_IDENTIFIER_ANCHORS.has(normalized) ||
    /^(?:tag|value|example|sample|foo|bar|baz)[a-z0-9]?$/i.test(value);
}

function hasConcreteHyphenAnchor(task: string): boolean {
  for (const match of task.matchAll(/\b[a-z][a-z0-9]+(?:-[a-z0-9]+)+\b/g)) {
    if (!GENERIC_HYPHEN_ANCHORS.has(match[0].toLowerCase())) {
      return true;
    }
  }
  return false;
}

function missingArtifactTaskType(task: string, prompt: string, requestedTaskType?: EvidenceTaskType): EvidenceTaskType {
  if (requestedTaskType) {
    return requestedTaskType;
  }
  if (isUnitTestPlanningPrompt(prompt)) {
    return "write_unittest";
  }
  if (isPbiOrRequirementPlanPrompt(prompt)) {
    return "implement";
  }
  if (isReviewPrompt(prompt)) {
    return "review_diff";
  }
  if (/\b(build|handoff|onboard)\b/i.test(task)) {
    return "build_handoff";
  }
  return "investigate";
}

function isSecurityAuditPrompt(prompt: string): boolean {
  const explicitSecurityReview = /\b(security[-\s]*focused\s+review|security\s+(audit|review)|audit\s+security)\b/i.test(prompt);
  const explicitVulnerabilityReview = /\b(vulnerab|exploit|privilege\s+escalation|secret\s+(leak|exposure|scan|review)|csrf|xss|sql injection|deseriali[sz]ation)\b/i.test(prompt) &&
    /\b(review|audit|findings?|risky surfaces?|changed behavior)\b/i.test(prompt);
  return explicitSecurityReview || explicitVulnerabilityReview;
}

function isPromoteReviewMemoryPrompt(prompt: string): boolean {
  return /\b(promote|promoted|promoting|promotion)\b/i.test(prompt) && /\b(review memory|memory)\b/i.test(prompt);
}

function isUnitTestPlanningPrompt(prompt: string): boolean {
  return /\b(unit tests?|unittest|write tests?|add tests?|test plan|test strategy)\b/i.test(prompt);
}

function isPbiOrRequirementPlanPrompt(prompt: string): boolean {
  return /\b(?:pbi|requirement)\b/i.test(prompt) && /\b(?:implementation plan|implement|preserving compatibility|compatibility)\b/i.test(prompt);
}

function isRequirementAnalysisPrompt(prompt: string): boolean {
  return /\banaly[sz]e\b/i.test(prompt) && /\brequirement\b/i.test(prompt);
}

function isCodingCoveragePrompt(task: string, requestedTaskType?: EvidenceTaskType): boolean {
  if (requestedTaskType === "implement" || requestedTaskType === "write_unittest") {
    return true;
  }
  return /\b(unit tests?|unittest|write tests?|add tests?|test coverage|implement|add feature|code change|modify|patch|fix bug|bugfix|fix failing|failing test|stack trace|exception|traceback|build failure|compilation error|debug|root cause|caused by)\b/i.test(task);
}

function inferCodingTaskType(task: string): EvidenceTaskType {
  if (/\b(unit tests?|unittest|write tests?|add tests?|test coverage)\b/i.test(task)) {
    return "write_unittest";
  }
  if (/\b(stack trace|exception|traceback|build failure|compilation error|debug|root cause|caused by|fix bug|bugfix|fix failing|failing test)\b/i.test(task)) {
    return "investigate";
  }
  return "implement";
}

function collectPromptSignals(task: string): string[] {
  const signals: string[] = [];
  for (const match of task.matchAll(/\b[A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|java|py|go|rs|kt|scala|xml|json|ya?ml|md)\b/g)) {
    signals.push(`file:${match[0].replace(/\\/g, "/")}`);
  }
  for (const match of task.matchAll(/\b[A-Z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?\b/g)) {
    const symbol = match[0];
    if (GENERIC_SYMBOL_SIGNALS.has(symbol)) {
      continue;
    }
    if (symbol.includes(".") || /(?:Service|Controller|Repository|Gateway|Manager|Client|Factory|Handler|Config|Test|Exception|Error)$/.test(symbol)) {
      signals.push(`symbol:${symbol}`);
    }
  }
  if (/^diff --git\b/m.test(task) || /^@@\s/m.test(task)) {
    signals.push("diff:inline");
  }
  if (/\b(PR|pull request|changed files?)\b/i.test(task)) {
    signals.push("review:changed-files");
  }
  if (/\bbranch\s+[-A-Za-z0-9_./]+\s+(?:to|into|against|vs)\s+branch\s+[-A-Za-z0-9_./]+/i.test(task) ||
      /\b(?:base|target|head|source)\s*[:=]\s*[-A-Za-z0-9_./]+/i.test(task)) {
    signals.push("review:branch-pair");
  }
  if (/\b[A-Z][A-Z0-9]+-\d+\b|\bjira\b|atlassian\.net\/browse\//i.test(task)) {
    signals.push("business:jira");
  }
  if (/\bconfluence\b|\/wiki\/spaces\/|\/pages\/viewpage\.action/i.test(task)) {
    signals.push("business:confluence");
  }
  for (const anchor of collectConcreteBehaviorAnchors(task).slice(0, 6)) {
    signals.push(`anchor:${anchor}`);
  }
  return [...new Set(signals)].slice(0, 16);
}

function collectConcreteBehaviorAnchors(task: string): string[] {
  const anchorTask = stripRouterOutputContractText(task);
  const anchors: string[] = [];
  for (const match of anchorTask.matchAll(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9_./{}:-]+)/gi)) {
    anchors.push(match[1]!);
  }
  for (const match of anchorTask.matchAll(/(?:^|\s)(\/[A-Za-z0-9_{}:-]+(?:\/[A-Za-z0-9_{}:-]+)+)/g)) {
    anchors.push(match[1]!);
  }
  for (const match of anchorTask.matchAll(/\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/g)) {
    if (isGenericIdentifierAnchor(match[0])) {
      continue;
    }
    anchors.push(match[0]);
  }
  for (const match of anchorTask.matchAll(/\b[a-z][a-z0-9]+(?:[_-][a-z0-9]+)+\b/g)) {
    if (GENERIC_HYPHEN_ANCHORS.has(match[0].toLowerCase()) || isGenericIdentifierAnchor(match[0])) {
      continue;
    }
    anchors.push(match[0]);
  }
  return [...new Set(anchors)].slice(0, 12);
}

function isReviewPrompt(prompt: string): boolean {
  return /^diff --git\b/m.test(prompt) ||
    /\b(?:code review|review-code|pull request|merge request|pr|mr|changed files?|risky surface)\b/i.test(prompt) ||
    /\breview\s+(?:this|the|a|an|my|our|pr|mr|pull request|merge request|diff|patch|change|changes|changed|code|commit|branch|file|files)\b/i.test(prompt) ||
    /\b(?:perform|do|run)\s+(?:a\s+)?(?:security-focused\s+)?review\b/i.test(prompt) ||
    /\b(?:diff|patch)\b[\s\S]{0,80}\b(?:review|findings?|risky|changed files?)\b/i.test(prompt) ||
    /\b(?:review|findings?)\b[\s\S]{0,80}\b(?:diff|patch)\b/i.test(prompt);
}

function inferBroadTaskType(task: string): EvidenceTaskType {
  if (/\b(unit test|unittest|write test|add test|test plan|test strategy)\b/i.test(task)) {
    return "write_unittest";
  }
  if (/\b(business|product|domain|customer|research|purpose|what does this repo do)\b/i.test(task)) {
    return "research_business";
  }
  if (/\b(flow|sequence\s*diagram|flowchart|diagram|mermaid|end-to-end|e2e|journey|api|endpoint|route)\b/i.test(task)) {
    return "api_flow";
  }
  if (/\b(build|test|compile|gradle|maven|npm|package|version|wrapper|onboard|handoff|daily task)\b/i.test(task)) {
    return "build_handoff";
  }
  if (/\b(implement|change|add feature|modify|patch|code change)\b/i.test(task)) {
    return "implement";
  }
  if (/\b(investigate|debug|diagnose|root cause|why|triage)\b/i.test(task)) {
    return "investigate";
  }
  return "investigate";
}
