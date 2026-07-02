import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../../dist/tokenopt/config.js";
import { evaluatePolicy } from "../../dist/tokenopt/policy-core.js";

// Regression proof for the "MCP-skip gap": an agent that goes straight to native
// search/read on a BROAD repository investigation never creates an evidence packet,
// so the post-packet answerability gate never fires. The pre-packet gateway now
// classifies broad_flow tasks as broad_research and steers (shadow) / blocks (hard)
// raw acquisition before any packet exists.

function mkRepo(name) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), name));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "fixture" }));
  return repo;
}

function load(repo, gatewayMode) {
  const env = { ...process.env, TOKENOPT_ARTIFACT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "art-")) };
  if (gatewayMode) env.TOKENOPT_GATEWAY_POLICY = gatewayMode;
  return loadConfig({ cwd: repo, env });
}

test("broad-research skip: shadow gateway steers native grep before any packet exists", () => {
  const repo = mkRepo("skip-broad-shadow-");
  const loaded = load(repo); // gateway defaults to shadow
  const runtime = { repoRoot: loaded.repoRoot };
  const base = { source: "codex", cwd: repo, sessionId: "s", turnId: "t", raw: {} };

  const prompt = evaluatePolicy(
    { ...base, eventName: "user-prompt-submit", prompt: "How does the order checkout flow work in this codebase?" },
    loaded.config, runtime);
  assert.equal(prompt.metadata.gateway.requiresContextGate, true);
  assert.equal(prompt.metadata.gateway.requirementKind, "broad_research");

  // Agent SKIPS contextgate and goes straight to native grep. Before the fix -> allow.
  const grep = evaluatePolicy(
    { ...base, eventName: "pre-tool-use", toolName: "Bash", toolInput: { command: "grep -rn checkout src" } },
    loaded.config, runtime);
  assert.equal(grep.action, "context");
  assert.match(grep.reason, /shadow policy would deny/);
  assert.match(grep.additionalContext, /broad repository investigation/i);
});

test("broad-research skip: hard gateway DENIES native grep before any packet exists", () => {
  const repo = mkRepo("skip-broad-hard-");
  const loaded = load(repo, "hard");
  const runtime = { repoRoot: loaded.repoRoot };
  const base = { source: "codex", cwd: repo, sessionId: "s", turnId: "t", raw: {} };

  evaluatePolicy(
    { ...base, eventName: "user-prompt-submit", prompt: "Investigate how authentication is wired across the repo" },
    loaded.config, runtime);
  const grep = evaluatePolicy(
    { ...base, eventName: "pre-tool-use", toolName: "Bash", toolInput: { command: "grep -rn auth src" } },
    loaded.config, runtime);
  assert.equal(grep.action, "deny");
  assert.equal(grep.metadata.reason, "contextgate_required_before_broad_research");
});

test("broad-research: calling contextgate clears the gate, then native search is allowed", () => {
  const repo = mkRepo("skip-broad-clear-");
  const loaded = load(repo, "hard");
  const runtime = { repoRoot: loaded.repoRoot };
  const base = { source: "codex", cwd: repo, sessionId: "s", turnId: "t", raw: {} };

  evaluatePolicy(
    { ...base, eventName: "user-prompt-submit", prompt: "Onboard me to this repository's architecture" },
    loaded.config, runtime);
  // Agent does the right thing: calls contextgate first.
  evaluatePolicy(
    { ...base, eventName: "post-tool-use", toolName: "mcp__tokenopt__contextgate_get_context",
      toolResponse: "packet_id: 22222222-2222-4222-8222-222222222222\nanswerable: false" },
    loaded.config, runtime);
  const grep = evaluatePolicy(
    { ...base, eventName: "pre-tool-use", toolName: "Bash", toolInput: { command: "grep -rn module src" } },
    loaded.config, runtime);
  assert.equal(grep.action, "allow");
});

test("no false positives: external-only summary and exact tasks are NOT gated", () => {
  const repo = mkRepo("skip-broad-negatives-");
  const loaded = load(repo, "hard"); // hard mode: any false positive would visibly DENY
  const runtime = { repoRoot: loaded.repoRoot };

  // (a) requirement-only summary -> must stay ungated (preserves existing behavior).
  const summary = evaluatePolicy(
    { source: "codex", cwd: repo, sessionId: "s", turnId: "ta", raw: {},
      eventName: "user-prompt-submit", prompt: "Summarize Jira ABC-123." },
    loaded.config, runtime);
  assert.equal(summary.metadata.gateway.requiresContextGate, false);

  // (b) exact symbol task -> native grep must remain allowed (narrow path preserved).
  evaluatePolicy(
    { source: "codex", cwd: repo, sessionId: "s", turnId: "tb", raw: {},
      eventName: "user-prompt-submit", prompt: "Find usages of PaymentGateway.authorize" },
    loaded.config, runtime);
  const exactGrep = evaluatePolicy(
    { source: "codex", cwd: repo, sessionId: "s", turnId: "tb", raw: {},
      eventName: "pre-tool-use", toolName: "Bash", toolInput: { command: "grep -rn authorize src" } },
    loaded.config, runtime);
  assert.equal(exactGrep.action, "allow");
});
