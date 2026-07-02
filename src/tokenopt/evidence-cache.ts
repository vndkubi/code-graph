import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRepoCacheDir } from "./observability.js";
import { getRepoFingerprint, sameRepoFingerprint } from "./repo-fingerprint.js";
import { TOKEN_ESTIMATOR_VERSION } from "./token-estimator.js";
import type { EvidencePacket, EvidenceTaskType, RepoFingerprint, TokenOptConfig } from "./types.js";

export type EvidenceCacheMcpMode = "lite" | "full" | "broker";
export type EvidenceCacheDetail = "compact" | "full";

export interface EvidenceCacheKey {
  taskType: EvidenceTaskType;
  normalizedTaskHash: string;
  qualityRubricHash: string;
  budgetTokens: number;
  repoFingerprintHash: string;
  mcpMode: EvidenceCacheMcpMode;
  detail: EvidenceCacheDetail;
}

export interface EvidenceCacheLookup {
  key: EvidenceCacheKey;
  keyHash: string;
  repoFingerprint: RepoFingerprint;
}

export interface EvidenceCacheEntry {
  key: EvidenceCacheKey;
  keyHash: string;
  packet: EvidencePacket;
  repoFingerprint: RepoFingerprint;
  createdAt: string;
  expiresAt: string;
  estimatorVersion: string;
}

export interface EvidenceCacheInput {
  task: string;
  taskType: EvidenceTaskType;
  budgetTokens: number;
  mcpMode: EvidenceCacheMcpMode;
  detail: EvidenceCacheDetail;
  qualityRubric: string[];
}

export function createEvidenceCacheLookup(repoRoot: string, input: EvidenceCacheInput): EvidenceCacheLookup {
  const repoFingerprint = getRepoFingerprint(repoRoot);
  const key: EvidenceCacheKey = {
    taskType: input.taskType,
    normalizedTaskHash: hashText(normalizeTask(input.task)),
    qualityRubricHash: hashJson(input.qualityRubric.map((item) => item.trim()).filter(Boolean)),
    budgetTokens: input.budgetTokens,
    repoFingerprintHash: hashRepoFingerprint(repoFingerprint),
    mcpMode: input.mcpMode,
    detail: input.detail
  };
  return {
    key,
    keyHash: hashJson(key),
    repoFingerprint
  };
}

export function readEvidenceCacheEntry(
  config: TokenOptConfig,
  repoRoot: string,
  lookup: EvidenceCacheLookup,
  now = new Date()
): EvidenceCacheEntry | undefined {
  const currentFingerprint = getRepoFingerprint(repoRoot, now);
  if (!sameRepoFingerprint(lookup.repoFingerprint, currentFingerprint)) {
    return undefined;
  }
  const filePath = evidenceCachePath(config, repoRoot, lookup.keyHash);
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  let entry: EvidenceCacheEntry;
  try {
    entry = JSON.parse(fs.readFileSync(filePath, "utf8")) as EvidenceCacheEntry;
  } catch {
    return undefined;
  }

  if (entry.keyHash !== lookup.keyHash || entry.key.repoFingerprintHash !== lookup.key.repoFingerprintHash) {
    return undefined;
  }
  if (!entry.repoFingerprint || !sameRepoFingerprint(entry.repoFingerprint, currentFingerprint)) {
    return undefined;
  }
  if (Date.parse(entry.expiresAt) <= now.getTime() || Date.parse(entry.packet.expires_at) <= now.getTime()) {
    return undefined;
  }
  return entry;
}

export function writeEvidenceCacheEntry(
  config: TokenOptConfig,
  repoRoot: string,
  lookup: EvidenceCacheLookup,
  packet: EvidencePacket
): string {
  const filePath = evidenceCachePath(config, repoRoot, lookup.keyHash);
  const entry: EvidenceCacheEntry = {
    key: lookup.key,
    keyHash: lookup.keyHash,
    packet,
    repoFingerprint: lookup.repoFingerprint,
    createdAt: new Date().toISOString(),
    expiresAt: packet.expires_at,
    estimatorVersion: TOKEN_ESTIMATOR_VERSION
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  return filePath;
}

export function isCacheableEvidencePacket(packet: EvidencePacket): boolean {
  return packet.recommended_next_action !== "ask_user" &&
    packet.acquisition_mode !== "ask_or_bypass" &&
    packet.acquisition_mode !== "direct_narrow" &&
    packet.acquisition_mode !== "failure_packet";
}

export function evidenceCacheMetadata(
  lookup: EvidenceCacheLookup,
  cacheHit: boolean,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ...extra,
    estimator_version: TOKEN_ESTIMATOR_VERSION,
    repo_fingerprint: lookup.repoFingerprint,
    evidence_cache_hit: cacheHit,
    evidence_cache_key: lookup.keyHash
  };
}

export function hashRepoFingerprint(fingerprint: RepoFingerprint): string {
  return hashJson({
    strategy: fingerprint.strategy,
    repoRoot: path.resolve(fingerprint.repoRoot),
    head: fingerprint.head,
    statusHash: fingerprint.statusHash,
    fileHash: fingerprint.fileHash
  });
}

function evidenceCachePath(config: TokenOptConfig, repoRoot: string, keyHash: string): string {
  return path.join(getRepoCacheDir(config, repoRoot), "evidence-cache", "v1", `${keyHash}.json`);
}

function normalizeTask(task: string): string {
  return task.trim().replace(/\s+/g, " ");
}

function hashJson(value: unknown): string {
  return hashText(stableJson(value));
}

function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
