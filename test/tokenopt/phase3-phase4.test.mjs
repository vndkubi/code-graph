import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../../dist/tokenopt/config.js";
import { adaptDecisionToCopilot, normalizeCopilotEvent } from "../../dist/tokenopt/copilot-adapter.js";
import { evaluatePolicy } from "../../dist/tokenopt/policy-core.js";
import { evaluateHardGate } from "../../dist/tokenopt/hard-gate.js";
import { buildInstructionGraph } from "../../dist/tokenopt/instruction-audit.js";
import { compressText } from "../../dist/tokenopt/log-compressor.js";
import { linkBusinessContracts } from "../../dist/tokenopt/processors/business-contract-linker.js";
import { analyzeImpact } from "../../dist/tokenopt/processors/impact-analysis.js";

function evidenceState(repoRoot) {
  return {
    stored_at: new Date().toISOString(),
    packet: {
      packet_id: "phase3-packet",
      task: "build handoff",
      task_type: "build_handoff",
      repo_root: repoRoot,
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
        budget_tokens: 1200,
        evidence_tokens_est: 100,
        response_tokens_est: 300
      },
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString()
    }
  };
}

test("hard gate module returns deny, shadow, and off decisions", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-hard-gate-"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "hard-gate" }));
  for (const [mode, expected] of [["hard", "deny"], ["shadow", "context"], ["off", "allow"]]) {
    const loaded = loadConfig({
      cwd: repo,
      env: {
        ...process.env,
        TOKENOPT_ARTIFACT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-hard-artifacts-")),
        TOKENOPT_ANSWERABILITY_GATE: mode
      }
    });
    const decision = evaluateHardGate({
      config: loaded.config,
      repoRoot: loaded.repoRoot,
      state: evidenceState(loaded.repoRoot),
      toolName: "Bash",
      toolInput: { command: "grep -R Needle src" },
      reason: "test_gate",
      hardReason: "blocked",
      shadowContext: "would block",
      forceWouldDeny: true
    });
    assert.equal(decision.action, expected);
    assert.equal(decision.metadata.hardGateMode, mode);
  }
});

test("compressor v2 handles JSON, review findings, and generic error summaries", () => {
  const json = compressText(JSON.stringify({ status: "failed", error: { message: "bad thing", reason: "missing config" }, items: Array.from({ length: 20 }, (_, id) => ({ id })) }), 2000);
  assert.equal(json.kind, "json-result");
  assert.match(json.text, /missing config/);

  const review = compressText("[P1] src/main/java/App.java:42: missing authorization check. Suggestion: add endpoint-level authorization coverage.", 2000);
  assert.equal(review.kind, "review-findings");
  assert.match(review.text, /src\/main\/java\/App.java/);

  const error = compressText("noise\n".repeat(200) + "Fatal error: failed to start\nCaused by: missing config\n", 2000);
  assert.equal(error.kind, "error-summary");
  assert.match(error.text, /missing config/);
});

test("business contract linker and impact analyzer return scoped evidence", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-impact-"));
  fs.mkdirSync(path.join(repo, "src/main/java/com/acme"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src/test/java/com/acme"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src/main/java/com/acme/OrderController.java"), "class OrderController { OrderService service; }\n");
  fs.writeFileSync(path.join(repo, "src/main/java/com/acme/OrderService.java"), "class OrderService { void approve() {} }\n");
  fs.writeFileSync(path.join(repo, "src/test/java/com/acme/OrderServiceTest.java"), "class OrderServiceTest {}\n");
  const repoFiles = [
    "src/main/java/com/acme/OrderController.java",
    "src/main/java/com/acme/OrderService.java",
    "src/test/java/com/acme/OrderServiceTest.java"
  ];

  const contracts = linkBusinessContracts({
    task: "review order approval change",
    changedFiles: ["src/main/java/com/acme/OrderService.java"],
    repoFiles
  });
  assert.equal(contracts.candidates.some((candidate) => candidate.type === "api"), true);
  assert.equal(contracts.candidates.some((candidate) => candidate.type === "test"), true);

  const impact = analyzeImpact({
    repoRoot: repo,
    target: "OrderService",
    changedFiles: ["src/main/java/com/acme/OrderService.java"],
    repoFiles
  });
  assert.equal(impact.definitions.some((item) => item.includes("OrderService.java")), true);
  assert.equal(impact.likelyTests.some((item) => item.endsWith("OrderServiceTest.java")), true);
});

test("Copilot adapter normalizes events and adapts decisions", () => {
  const event = normalizeCopilotEvent({
    hookEventName: "PreToolUse",
    cwd: process.cwd(),
    toolName: "Bash",
    toolInput: { command: "rg --files" }
  });
  assert.equal(event.eventName, "pre-tool-use");
  assert.equal(event.toolName, "Bash");

  const output = adaptDecisionToCopilot("pre-tool-use", {
    action: "deny",
    reason: "blocked"
  });
  assert.deepEqual(output, {
    permissionDecision: "deny",
    permissionDecisionReason: "blocked"
  });
});

test("policy gateway requires ContextGate for PBI plus code tasks", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-gateway-policy-"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "gateway-policy" }));
  const loaded = loadConfig({
    cwd: repo,
    env: {
      ...process.env,
      TOKENOPT_ARTIFACT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-gateway-artifacts-")),
      TOKENOPT_GATEWAY_POLICY: "hard"
    }
  });
  const runtime = { repoRoot: loaded.repoRoot };
  const base = { source: "copilot", cwd: repo, sessionId: "s1", turnId: "t1", raw: {} };

  const promptDecision = evaluatePolicy({
    ...base,
    eventName: "user-prompt-submit",
    prompt: "Implement Jira PBI ABC-123 and identify impacted source files and tests."
  }, loaded.config, runtime);
  assert.equal(promptDecision.action, "context");
  assert.equal(promptDecision.metadata.gateway.requiresContextGate, true);
  assert.match(promptDecision.additionalContext, /incomplete until ContextGate produces repository source evidence/);

  const requirementDecision = evaluatePolicy({
    ...base,
    eventName: "post-tool-use",
    toolName: "mcp__jira__get_issue",
    toolResponse: "ABC-123 acceptance criteria mention OrderService"
  }, loaded.config, runtime);
  assert.equal(requirementDecision.action, "context");
  assert.match(requirementDecision.additionalContext, /external_artifacts/);

  const deniedSearch = evaluatePolicy({
    ...base,
    eventName: "pre-tool-use",
    toolName: "Bash",
    toolInput: { command: "rg OrderService src" }
  }, loaded.config, runtime);
  assert.equal(deniedSearch.action, "deny");
  assert.match(deniedSearch.reason, /ContextGate source-evidence packet/);

  const allowedRequirementRead = evaluatePolicy({
    ...base,
    eventName: "pre-tool-use",
    toolName: "mcp__confluence__search_content",
    toolInput: { query: "ABC-123" }
  }, loaded.config, runtime);
  assert.equal(allowedRequirementRead.action, "allow");

  const stopDenied = evaluatePolicy({
    ...base,
    eventName: "agent-stop",
    raw: { stop_hook_active: false }
  }, loaded.config, runtime);
  assert.equal(stopDenied.action, "deny");
  assert.match(stopDenied.reason, /blocked final answer/);

  evaluatePolicy({
    ...base,
    eventName: "post-tool-use",
    toolName: "mcp__tokenopt__contextgate_get_context",
    toolResponse: "packet_id: 11111111-1111-4111-8111-111111111111\nanswerable: true\nrecommended_next_action: answer_now"
  }, loaded.config, runtime);
  const stopAllowed = evaluatePolicy({
    ...base,
    eventName: "agent-stop",
    raw: { stop_hook_active: false }
  }, loaded.config, runtime);
  assert.equal(stopAllowed.action, "allow");
});

test("policy gateway leaves requirement-only prompts alone and shadows before hard enforcement", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-gateway-shadow-"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "gateway-shadow" }));
  const loaded = loadConfig({
    cwd: repo,
    env: {
      ...process.env,
      TOKENOPT_ARTIFACT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-gateway-shadow-artifacts-")),
      TOKENOPT_GATEWAY_POLICY: "shadow"
    }
  });
  const runtime = { repoRoot: loaded.repoRoot };
  const base = { source: "copilot", cwd: repo, sessionId: "s2", turnId: "t2", raw: {} };

  const summaryOnly = evaluatePolicy({
    ...base,
    eventName: "user-prompt-submit",
    prompt: "Summarize Jira ABC-123."
  }, loaded.config, runtime);
  assert.equal(summaryOnly.metadata.gateway.requiresContextGate, false);
  assert.doesNotMatch(summaryOnly.additionalContext, /incomplete until ContextGate/);

  evaluatePolicy({
    ...base,
    turnId: "t3",
    eventName: "user-prompt-submit",
    prompt: "Plan implementation for Jira ABC-123 and tests."
  }, loaded.config, runtime);
  const shadowSearch = evaluatePolicy({
    ...base,
    turnId: "t3",
    eventName: "pre-tool-use",
    toolName: "Bash",
    toolInput: { command: "rg ABC-123 src" }
  }, loaded.config, runtime);
  assert.equal(shadowSearch.action, "context");
  assert.match(shadowSearch.reason, /shadow policy would deny/);
});

test("instruction graph planner emits root and path-specific files", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-instruction-graph-"));
  const plan = buildInstructionGraph(repo);
  const files = plan.files.map((file) => file.path.replace(/\\/g, "/"));
  assert.equal(files.some((file) => file.endsWith(".github/copilot-instructions.md")), true);
  assert.equal(files.some((file) => file.endsWith("tokenopt-review.instructions.md")), true);
  assert.equal(files.some((file) => file.endsWith("tokenopt-runtime.instructions.md")), true);
  const reviewInstructions = plan.files.find((file) => file.path.endsWith(path.join(".github", "instructions", "tokenopt-review.instructions.md")));
  assert.match(reviewInstructions.content, /two phases/i);
  assert.match(reviewInstructions.content, /branch pair/);
  assert.match(reviewInstructions.content, /tokenopt_compile_evidence/);
  assert.match(reviewInstructions.content, /codegraph_context/);
  assert.match(reviewInstructions.content, /review broker is available/);
  assert.match(reviewInstructions.content, /direct attachment summaries/);
  assert.match(reviewInstructions.content, /Do not ask the user to paste full content/);
  assert.match(reviewInstructions.content, /business\/test coverage review/);
  assert.match(reviewInstructions.content, /effective config\/policy math/);
  assert.match(reviewInstructions.content, /ISTQB dimensions/);
  assert.match(reviewInstructions.content, /user provides a review checklist/);
  assert.match(reviewInstructions.content, /pass, fail, gap, or not_applicable/);
  assert.ok(plan.totalEstimatedTokens > 0);
});
