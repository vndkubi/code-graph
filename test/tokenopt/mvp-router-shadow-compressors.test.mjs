import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../../dist/tokenopt/config.js";
import { writeEvidenceTaskState } from "../../dist/tokenopt/evidence-state.js";
import { compressText } from "../../dist/tokenopt/log-compressor.js";
import { readRepoEvents } from "../../dist/tokenopt/observability.js";
import { evaluatePolicy } from "../../dist/tokenopt/policy-core.js";
import { getPlaybook, listPlaybooks } from "../../dist/tokenopt/playbooks.js";
import { routeTask } from "../../dist/tokenopt/router.js";

test("router classifies review, debug, refactor, exact, and small-repo bypass tasks", () => {
  assert.equal(routeTask({ task: "Review this PR diff for changed files" }).taskClass, "needs_input_bypass");
  assert.equal(routeTask({ task: "Review this diff:\ndiff --git a/src/orders/OrderService.ts b/src/orders/OrderService.ts" }).taskClass, "review_diff");
  assert.equal(routeTask({ task: "Research developer tasks this repo supports, including research, investigate code, investigate PBI, implement, unit-test, review, and Spec Kit workflows." }).taskClass, "broad_flow");
  assert.equal(routeTask({ task: "Investigate this PBI: Given a developer asks naturally, When the task is broad, Then use compact context and bounded followups." }).taskClass, "broad_flow");
  assert.equal(routeTask({ task: "Investigate this PBI: Given a developer asks naturally, When the task is broad, Then use compact context first; When the task names a file/symbol/diff, Then go exact first." }).taskClass, "broad_flow");
  assert.equal(routeTask({ task: "/review-code branch feature/orders-fix to branch develop/main. Review net diff in two phases." }).taskClass, "review_diff");
  const branchReviewWithRequirements = routeTask({ task: "/review-code branch feature/orders-fix to branch develop/main with Jira ABC-123 and Confluence page https://example.atlassian.net/wiki/spaces/ABC/pages/123/Spec" });
  assert.equal(branchReviewWithRequirements.taskClass, "review_diff");
  assert.equal(branchReviewWithRequirements.promptSignals.includes("business:jira"), true);
  assert.equal(branchReviewWithRequirements.promptSignals.includes("business:confluence"), true);
  const requirementOnlyReview = routeTask({ task: "/review-code Jira ABC-123 with Confluence page https://example.atlassian.net/wiki/spaces/ABC/pages/123/Spec" });
  assert.equal(requirementOnlyReview.taskClass, "needs_input_bypass");
  assert.equal(requirementOnlyReview.evidenceContract, "artifact_sufficiency");
  assert.equal(requirementOnlyReview.promptSignals.includes("artifact:missing"), true);
  assert.equal(requirementOnlyReview.promptSignals.includes("business:jira"), true);
  assert.equal(requirementOnlyReview.promptSignals.includes("business:confluence"), true);
  assert.match(requirementOnlyReview.reason, /requirement evidence/);
  assert.equal(routeTask({ task: "Perform a security-focused review of changed behavior or risky surfaces. Return JSON findings." }).taskClass, "security_audit");
  assert.equal(routeTask({ task: "Code review this PR. Review focus: security privilege automaton language equivalence.\ndiff --git a/Authz.java b/Authz.java" }).taskClass, "review_diff");
  assert.equal(routeTask({ task: "Create an implementation plan for a small PBI/requirement while preserving compatibility. Return JSON." }).taskClass, "needs_input_bypass");
  assert.equal(routeTask({ task: "Analyze a requirement and produce WHAT, WHY, HOW, acceptance criteria, impacted areas, tests, and unknowns. Return JSON." }).taskClass, "needs_input_bypass");
  assert.equal(routeTask({ task: "Write a unit-test plan for the likely owning class/module of a behavior. Return JSON." }).taskClass, "needs_input_bypass");
  const anchoredTestPlan = routeTask({
    task: "Daily task: create a focused test plan for search pre-filtering/can-match behavior. Cover pre_filter_shard_size request param.",
    requestedTaskType: "api_flow"
  });
  assert.equal(anchoredTestPlan.taskClass, "broad_flow");
  assert.equal(anchoredTestPlan.promptSignals.includes("artifact:missing"), false);
  assert.equal(anchoredTestPlan.promptSignals.includes("anchor:pre_filter_shard_size"), true);
  const camelCaseTestPlan = routeTask({
    task: "Daily task: prepare a unit/integration test plan for hardening YARN RM app filtering by applicationTypes and applicationTags.",
    requestedTaskType: "api_flow"
  });
  assert.equal(camelCaseTestPlan.taskClass, "broad_flow");
  assert.equal(camelCaseTestPlan.promptSignals.includes("anchor:applicationTypes"), true);
  assert.equal(routeTask({ task: "Identify what should be promoted into review memory after a completed task. Return JSON." }).taskClass, "needs_input_bypass");
  const failureRoute = routeTask({ task: "Debug this Spring stack trace\njava.lang.NullPointerException\n\tat com.acme.OrderService.load(OrderService.java:42)" });
  assert.equal(failureRoute.taskClass, "debug_runtime");
  assert.equal(failureRoute.acquisitionMode, "failure_packet");
  assert.equal(failureRoute.evidenceContract, "failure_contract");
  assert.equal(routeTask({ task: "Implement validation in OrderService" }).taskClass, "coding_coverage");
  assert.equal(routeTask({ task: "Write unit tests for OrderService" }).taskClass, "coding_coverage");
  assert.equal(routeTask({ task: "Refactor OrderService to extract validation" }).taskClass, "refactor_scope");
  assert.equal(routeTask({ task: "Find usages of PaymentGateway.authorize" }).taskClass, "exact_symbol");

  const tracebug = routeTask({ task: "Tracebug OrderService.java:42 failing test OrderServiceTest.shouldRejectMissingPartition" });
  assert.equal(tracebug.taskClass, "exact_symbol");
  assert.equal(tracebug.action, "exact_route");
  assert.equal(tracebug.acquisitionMode, "direct_narrow");
  assert.equal(tracebug.evidenceContract, "trace_proof");

  const missingTracebug = routeTask({ task: "tracebug this issue" });
  assert.equal(missingTracebug.taskClass, "needs_input_bypass");
  assert.equal(missingTracebug.acquisitionMode, "ask_or_bypass");
  assert.equal(missingTracebug.evidenceContract, "artifact_sufficiency");
  assert.equal(missingTracebug.budgetPolicy.maxTotalActions, 0);

  const small = routeTask({
    task: "Inspect src/orders/OrderService.ts and explain the risk",
    repoFileCount: 42
  });
  assert.equal(small.taskClass, "small_repo_bypass");
  assert.equal(small.action, "bypass");
});

test("playbook registry resolves acquisition modes and budgets", () => {
  const ids = listPlaybooks().map((playbook) => playbook.id).sort();
  assert.deepEqual(ids, [
    "broad_compile",
    "coding_coverage",
    "failure_packet",
    "missing_artifact",
    "review_bounded",
    "security_audit",
    "tracebug_direct"
  ]);

  assert.equal(getPlaybook("tracebug_direct").acquisitionMode, "direct_narrow");
  assert.equal(getPlaybook("tracebug_direct").evidenceContract, "trace_proof");
  assert.equal(getPlaybook("missing_artifact").budgetPolicy.maxTotalActions, 0);
  assert.equal(getPlaybook("coding_coverage").budgetPolicy.maxFollowups, 1);
  assert.match(getPlaybook("review_bounded").answerabilityRule, /ISTQB/);
  assert.match(getPlaybook("review_bounded").answerabilityRule, /invariant/);
  assert.match(getPlaybook("review_bounded").answerabilityRule, /user checklist/);
  assert.equal(getPlaybook("review_bounded").taskSignals.includes("user_checklist"), true);
});

test("shadow answerability gate logs would-deny without blocking", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-shadow-policy-"));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-shadow-artifacts-"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "shadow-fixture" }));
  const loaded = loadConfig({
    cwd: repo,
    env: {
      ...process.env,
      TOKENOPT_ARTIFACT_DIR: artifactDir,
      TOKENOPT_ANSWERABILITY_GATE: "shadow"
    }
  });
  writeEvidenceTaskState(loaded.config, loaded.repoRoot, {
    packet_id: "packet-shadow",
    task: "Prepare a daily build handoff",
    task_type: "build_handoff",
    repo_root: loaded.repoRoot,
    answerable: true,
    confidence: 0.9,
    coverage: { build_system: "covered" },
    evidence: [],
    missing: [],
    allowed_followups: [],
    disallowed_followups: ["shell_grep"],
    recommended_next_action: "answer_now",
    max_additional_calls: 0,
    token_budget: {
      budget_tokens: 1600,
      evidence_tokens_est: 100,
      response_tokens_est: 400
    },
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString()
  });

  const decision = evaluatePolicy(
    {
      source: "codex",
      eventName: "pre-tool-use",
      cwd: repo,
      toolName: "Bash",
      toolInput: { command: "grep -R shadow src" },
      raw: {}
    },
    loaded.config,
    { repoRoot: loaded.repoRoot }
  );

  assert.equal(decision.action, "context");
  assert.match(decision.reason, /shadow gate would deny/);
  assert.equal(decision.metadata.shadowGate.wouldDeny, true);

  const events = readRepoEvents(loaded.config, loaded.repoRoot);
  assert.equal(events.some((event) => event.eventName === "shadow-gate" && event.metadata.shadowGate.taskId === "packet-shadow"), true);
});

test("compressText applies Java trace and build log compressors", () => {
  const javaTrace = [
    "java.lang.IllegalStateException: failed to start",
    "\tat com.acme.orders.OrderService.load(OrderService.java:42)",
    "\tat org.springframework.aop.framework.CglibAopProxy.invoke(CglibAopProxy.java:123)",
    "\tat org.springframework.cglib.proxy.MethodProxy.invoke(MethodProxy.java:99)",
    "\tat org.hibernate.engine.spi.ActionQueue.execute(ActionQueue.java:88)",
    "Caused by: java.lang.NullPointerException: missing order",
    "\tat com.acme.orders.OrderRepository.find(OrderRepository.java:17)",
    "\tat java.util.concurrent.ThreadPoolExecutor.runWorker(ThreadPoolExecutor.java:1136)"
  ].join("\n");
  const traceResult = compressText(javaTrace, 2000);
  assert.equal(traceResult.kind, "java-trace");
  assert.match(traceResult.text, /Caused by: java\.lang\.NullPointerException/);
  assert.match(traceResult.text, /OrderService\.java:42/);
  assert.match(traceResult.text, /framework\/internal frames collapsed/);

  const buildLog = [
    "Downloading from central: https://repo.maven.apache.org/maven2/example.jar",
    "Progress (1): 10 kB",
    "[ERROR] COMPILATION ERROR :",
    "[ERROR] /src/main/java/App.java:[12,8] cannot find symbol",
    "Tests run: 4, Failures: 1, Errors: 0, Skipped: 0",
    "BUILD FAILURE"
  ].join("\n");
  const buildResult = compressText(buildLog, 2000);
  assert.equal(buildResult.kind, "build-log");
  assert.match(buildResult.text, /BUILD FAILURE/);
  assert.match(buildResult.text, /cannot find symbol/);
  assert.doesNotMatch(buildResult.text, /Downloading from central/);
});
