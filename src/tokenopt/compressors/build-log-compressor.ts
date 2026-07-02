import type { CompressionResult } from "../types.js";
import { estimateTokensSaved } from "../token-estimator.js";

const DROP_PATTERNS = [
  /^\s*Downloading from /i,
  /^\s*Downloaded from /i,
  /^\s*Uploading to /i,
  /^\s*Uploaded to /i,
  /^\s*Progress \(/i,
  /^\s*Transferring /i,
  /^\s*> Task :[^ ]+\s+(?:UP-TO-DATE|SKIPPED|NO-SOURCE)\s*$/i
];

const KEEP_PATTERNS = [
  /\bBUILD (?:FAILURE|FAILED|SUCCESS)\b/i,
  /\bTests run:\s*\d+/i,
  /\bFailures:\s*[1-9]/i,
  /\bErrors:\s*[1-9]/i,
  /\bFailed tests?:/i,
  /\bCompilation failure\b/i,
  /\bThere are test failures\b/i,
  /\b(?:Exception|Error|AssertionError)\b/,
  /\bCaused by:/,
  /^\[ERROR\]/,
  /^\[WARNING\]/,
  /^>\s*Task .* FAILED\b/i,
  /^\s*at\s+[\w.$]+\(.*:\d+\)/
];

export function looksLikeBuildLog(text: string): boolean {
  return /\b(?:mvn|Maven|Gradle|gradlew|BUILD FAILURE|BUILD FAILED|Tests run:)\b/.test(text) &&
    (/\b(?:Downloading from|Transferring|BUILD FAILURE|BUILD FAILED|Tests run:)\b/i.test(text));
}

export function compressBuildLog(text: string, limitChars: number): CompressionResult {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const kept: string[] = [];
  let droppedNoise = 0;

  for (const line of lines) {
    if (isDroppedNoise(line)) {
      droppedNoise += 1;
      continue;
    }
    if (KEEP_PATTERNS.some((pattern) => pattern.test(line))) {
      kept.push(line.trimEnd());
    }
  }

  const contextualLines = lines.filter((line) => line.trim() && !isDroppedNoise(line));
  const head = contextualLines.slice(0, 12);
  const tail = contextualLines.slice(-20);
  const bodyLines = dedupeLines([
    ...kept.slice(0, 180),
    "",
    "--- first non-empty lines ---",
    ...head,
    "",
    "--- last non-empty lines ---",
    ...tail
  ]).filter(Boolean);

  const body = [
    "TokenOpt compressed tool output",
    "kind: build-log",
    `originalChars: ${normalized.length}`,
    `droppedNoiseLines: ${droppedNoise}`,
    "",
    ...bodyLines
  ].join("\n").trimEnd();
  const capped = body.length > limitChars ? `${body.slice(0, Math.max(0, limitChars - 80))}\n\n[truncated by TokenOpt]` : body;

  return {
    kind: "build-log",
    text: capped,
    originalChars: normalized.length,
    compressedChars: capped.length,
    estimatedTokensSaved: estimateTokensSaved(normalized.length, capped.length)
  };
}

function isDroppedNoise(line: string): boolean {
  return DROP_PATTERNS.some((pattern) => pattern.test(line));
}

function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const key = line.trim();
    if (key && seen.has(key)) {
      continue;
    }
    if (key) {
      seen.add(key);
    }
    result.push(line);
  }
  return result;
}
