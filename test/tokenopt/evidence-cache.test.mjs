import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../../dist/tokenopt/config.js";
import {
  createEvidenceCacheLookup,
  isCacheableEvidencePacket,
  readEvidenceCacheEntry,
  writeEvidenceCacheEntry
} from "../../dist/tokenopt/evidence-cache.js";

test("evidence cache returns hits for the same task and fingerprint", () => {
  const { loaded, repo } = makeRepo("tokenopt-cache-hit-");
  const lookup = lookupFor(repo, "Research business purpose");
  const packet = packetFor(repo, { task: "Research business purpose" });

  writeEvidenceCacheEntry(loaded.config, loaded.repoRoot, lookup, packet);
  const cached = readEvidenceCacheEntry(loaded.config, loaded.repoRoot, lookup);

  assert.ok(cached);
  assert.equal(cached.keyHash, lookup.keyHash);
  assert.equal(cached.packet.packet_id, packet.packet_id);
});

test("evidence cache invalidates after repository fingerprint changes", () => {
  const { loaded, repo } = makeRepo("tokenopt-cache-stale-");
  const lookup = lookupFor(repo, "Research business purpose");
  writeEvidenceCacheEntry(loaded.config, loaded.repoRoot, lookup, packetFor(repo));

  fs.writeFileSync(path.join(repo, "src.js"), "export const changed = true;\n");

  assert.equal(readEvidenceCacheEntry(loaded.config, loaded.repoRoot, lookup), undefined);
  const freshLookup = lookupFor(repo, "Research business purpose");
  assert.equal(readEvidenceCacheEntry(loaded.config, loaded.repoRoot, freshLookup), undefined);
});

test("evidence cache skips expired packets", () => {
  const { loaded, repo } = makeRepo("tokenopt-cache-expired-");
  const lookup = lookupFor(repo, "Research business purpose");
  writeEvidenceCacheEntry(
    loaded.config,
    loaded.repoRoot,
    lookup,
    packetFor(repo, { expiresAt: new Date(Date.now() - 1_000).toISOString() })
  );

  assert.equal(readEvidenceCacheEntry(loaded.config, loaded.repoRoot, lookup), undefined);
});

test("evidence cache policy rejects missing artifact, direct narrow, and failure packets", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-cache-policy-"));
  assert.equal(isCacheableEvidencePacket(packetFor(repo, {
    acquisitionMode: "ask_or_bypass",
    recommendedNextAction: "ask_user"
  })), false);
  assert.equal(isCacheableEvidencePacket(packetFor(repo, {
    acquisitionMode: "direct_narrow",
    evidenceContract: "trace_proof"
  })), false);
  assert.equal(isCacheableEvidencePacket(packetFor(repo, {
    acquisitionMode: "failure_packet",
    evidenceContract: "failure_contract"
  })), false);
  assert.equal(isCacheableEvidencePacket(packetFor(repo)), true);
});

function makeRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}artifacts-`));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "cache-fixture" }, null, 2));
  const loaded = loadConfig({
    cwd: repo,
    env: { ...process.env, TOKENOPT_ARTIFACT_DIR: artifactDir }
  });
  return { loaded, repo };
}

function lookupFor(repo, task) {
  return createEvidenceCacheLookup(repo, {
    task,
    taskType: "research_business",
    budgetTokens: 1600,
    mcpMode: "lite",
    detail: "compact",
    qualityRubric: ["summarize purpose"]
  });
}

function packetFor(repo, options = {}) {
  const now = new Date();
  return {
    packet_id: options.packetId ?? "pkt-cache-test",
    task: options.task ?? "Research business purpose",
    task_type: "research_business",
    repo_root: repo,
    acquisition_mode: options.acquisitionMode ?? "compile_evidence",
    evidence_contract: options.evidenceContract ?? "overview_contract",
    evidence_contract_pass: true,
    answerable: true,
    confidence: 0.9,
    coverage: { overview: "covered" },
    evidence: [],
    missing: [],
    answer_contract: {
      required_sections: ["summary"],
      evidence_rules: [],
      quality_checks: [],
      failure_conditions: [],
      user_rubric: []
    },
    allowed_followups: [],
    disallowed_followups: [],
    recommended_next_action: options.recommendedNextAction ?? "answer_now",
    max_additional_calls: 0,
    token_budget: {
      budget_tokens: 1600,
      evidence_tokens_est: 0,
      response_tokens_est: 200
    },
    created_at: now.toISOString(),
    expires_at: options.expiresAt ?? new Date(now.getTime() + 60_000).toISOString()
  };
}
