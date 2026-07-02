import type { CompressionResult } from "../types.js";
import { estimateTokensSaved } from "../token-estimator.js";

export function looksLikeErrorSummary(text: string): boolean {
  return /(error|exception|failed|failure|panic|fatal|assertion)/i.test(text) && text.length > 800;
}

export function compressErrorSummary(text: string, limitChars: number): CompressionResult {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const interesting = lines
    .filter((line) => /(error|exception|failed|failure|panic|fatal|assertion|caused by|expected|received|actual)/i.test(line))
    .map((line) => line.trimEnd());
  const stackFrames = lines.filter((line) => /^\s*at\s+|^\s*File ".+", line \d+|^\s*#\d+\s+/.test(line)).slice(0, 24);
  const body = [
    "TokenOpt compressed tool output",
    "kind: error-summary",
    `originalChars: ${normalized.length}`,
    "",
    "Failure summary:",
    ...dedupe(interesting).slice(0, 120),
    "",
    "Stack/context sample:",
    ...dedupe(stackFrames).slice(0, 40),
    "",
    "Last lines:",
    ...lines.slice(-20)
  ].join("\n").trimEnd();
  const capped = body.length > limitChars ? `${body.slice(0, Math.max(0, limitChars - 80))}\n\n[truncated by TokenOpt]` : body;
  return {
    kind: "error-summary",
    text: capped,
    originalChars: normalized.length,
    compressedChars: capped.length,
    estimatedTokensSaved: estimateTokensSaved(normalized.length, capped.length)
  };
}

function dedupe(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const key = line.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(line);
  }
  return result;
}
