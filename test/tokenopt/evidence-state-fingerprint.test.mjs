import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readActiveEvidenceTaskState,
  readEvidenceTaskState,
  writeEvidenceTaskState
} from "../../dist/tokenopt/evidence-state.js";
import { loadConfig } from "../../dist/tokenopt/config.js";

test("evidence task state invalidates when repository fingerprint changes", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-evidence-fingerprint-repo-"));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-evidence-fingerprint-cache-"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "fingerprint-fixture" }, null, 2));

  const loaded = loadConfig({
    cwd: repo,
    env: { ...process.env, TOKENOPT_ARTIFACT_DIR: artifactDir }
  });
  writeEvidenceTaskState(loaded.config, loaded.repoRoot, packet(repo));

  const raw = readEvidenceTaskState(loaded.config, loaded.repoRoot);
  assert.equal(raw?.repo_fingerprint?.strategy, "file-metadata-v1");
  assert.ok(readActiveEvidenceTaskState(loaded.config, loaded.repoRoot));

  fs.writeFileSync(path.join(repo, "src.js"), "export const changed = true;\n");

  assert.equal(readActiveEvidenceTaskState(loaded.config, loaded.repoRoot), undefined);
  assert.ok(readEvidenceTaskState(loaded.config, loaded.repoRoot));
});

function packet(repoRoot) {
  const now = new Date();
  return {
    packet_id: "pkt-test",
    task: "Summarize repo",
    task_type: "research_business",
    repo_root: repoRoot,
    acquisition_mode: "compile_evidence",
    evidence_contract: "overview_contract",
    evidence_contract_pass: true,
    answerable: true,
    confidence: 0.9,
    coverage: { overview: "covered" },
    evidence: [],
    missing: [],
    answer_contract: {
      format: "bullets",
      must_include: [],
      quality_checks: []
    },
    allowed_followups: [],
    disallowed_followups: [],
    recommended_next_action: "answer_now",
    max_additional_calls: 0,
    token_budget: {
      budget_tokens: 1200,
      evidence_tokens_est: 0,
      response_tokens_est: 200
    },
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 60_000).toISOString()
  };
}
