import fs from "node:fs";
import path from "node:path";
import { getRepoCacheDir } from "./observability.js";
import { getRepoFingerprint, sameRepoFingerprint } from "./repo-fingerprint.js";
import type { EvidencePacket, EvidenceTaskState, TokenOptConfig } from "./types.js";

const STATE_FILE = "evidence-task-state.json";

export function writeEvidenceTaskState(
  config: TokenOptConfig,
  repoRoot: string,
  packet: EvidencePacket
): string {
  const dir = getRepoCacheDir(config, repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, STATE_FILE);
  const state: EvidenceTaskState = {
    packet,
    stored_at: new Date().toISOString(),
    repo_fingerprint: getRepoFingerprint(repoRoot)
  };
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return filePath;
}

export function readActiveEvidenceTaskState(
  config: TokenOptConfig,
  repoRoot: string,
  now = new Date()
): EvidenceTaskState | undefined {
  const state = readEvidenceTaskState(config, repoRoot);
  if (!state) {
    return undefined;
  }

  if (!state.packet.answerable || state.packet.recommended_next_action !== "answer_now") {
    return undefined;
  }
  if (Date.parse(state.packet.expires_at) <= now.getTime()) {
    return undefined;
  }
  if (state.repo_fingerprint && !sameRepoFingerprint(state.repo_fingerprint, getRepoFingerprint(repoRoot, now))) {
    return undefined;
  }
  return state;
}

export function readEvidenceTaskState(
  config: TokenOptConfig,
  repoRoot: string
): EvidenceTaskState | undefined {
  const filePath = path.join(getRepoCacheDir(config, repoRoot), STATE_FILE);
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  let state: EvidenceTaskState;
  try {
    state = JSON.parse(fs.readFileSync(filePath, "utf8")) as EvidenceTaskState;
  } catch {
    return undefined;
  }

  return state;
}
