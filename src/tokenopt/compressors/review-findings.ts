import type { CompressionResult } from "../types.js";
import { estimateTokensSaved } from "../token-estimator.js";

interface Finding {
  file: string;
  lines?: string;
  severity: string;
  evidence: string;
  suggestion: string;
}

export function looksLikeReviewFindings(text: string): boolean {
  return /\b(P0|P1|P2|P3|severity|finding|review)\b/i.test(text) &&
    /\b[\w./\\-]+\.(?:ts|tsx|js|jsx|java|py|go|rs|kt|scala|cs|xml|json|ya?ml|md)(?::\d+)?/i.test(text);
}

export function compressReviewFindings(text: string, limitChars: number): CompressionResult {
  const normalized = text.replace(/\r\n/g, "\n");
  const findings = extractFindings(normalized);
  const body = [
    "TokenOpt compressed tool output",
    "kind: review-findings",
    `originalChars: ${normalized.length}`,
    `findings: ${findings.length}`,
    "",
    JSON.stringify(findings.slice(0, 40), null, 2)
  ].join("\n").trimEnd();
  const capped = body.length > limitChars ? `${body.slice(0, Math.max(0, limitChars - 80))}\n\n[truncated by TokenOpt]` : body;
  return {
    kind: "review-findings",
    text: capped,
    originalChars: normalized.length,
    compressedChars: capped.length,
    estimatedTokensSaved: estimateTokensSaved(normalized.length, capped.length)
  };
}

function extractFindings(text: string): Finding[] {
  const blocks = text.split(/\n(?=(?:[-*]\s*)?(?:\[?P[0-3]\]?|severity|finding|\b[A-Z][\w /-]{2,}:))/i);
  const findings: Finding[] = [];
  for (const block of blocks) {
    const fileMatch = block.match(/\b([\w./\\-]+\.(?:ts|tsx|js|jsx|java|py|go|rs|kt|scala|cs|xml|json|ya?ml|md))(?::(\d+(?:-\d+)?))?/i);
    if (!fileMatch) {
      continue;
    }
    const severity = block.match(/\b(P[0-3])\b/i)?.[1]?.toUpperCase() ?? "P2";
    const compact = block.replace(/\s+/g, " ").trim();
    findings.push({
      file: fileMatch[1]!.replace(/\\/g, "/"),
      lines: fileMatch[2],
      severity,
      evidence: compact.slice(0, 280),
      suggestion: inferSuggestion(compact)
    });
  }
  return findings.length > 0 ? findings : [{
    file: "unknown",
    severity: "P2",
    evidence: text.replace(/\s+/g, " ").slice(0, 400),
    suggestion: "Review the cited change and verify with targeted tests."
  }];
}

function inferSuggestion(text: string): string {
  const suggestion = text.match(/\b(?:suggestion|fix|recommend(?:ed)?):\s*(.{20,240})/i)?.[1];
  if (suggestion) {
    return suggestion.trim();
  }
  if (/test|coverage/i.test(text)) {
    return "Add or update targeted regression coverage for the cited behavior.";
  }
  if (/null|undefined|exception|error/i.test(text)) {
    return "Guard the failing path and verify the error case with a focused test.";
  }
  return "Inspect the cited file/lines and apply the smallest behavior-preserving fix.";
}
