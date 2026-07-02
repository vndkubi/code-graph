import type { CompressionResult } from "../types.js";
import { estimateTokensSaved } from "../token-estimator.js";

export function looksLikeJsonResult(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 200 && ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]")));
}

export function compressJsonResult(text: string, limitChars: number): CompressionResult {
  const normalized = text.replace(/\r\n/g, "\n");
  const parsed = tryParseJson(normalized);
  if (parsed === undefined) {
    return fallback(normalized, limitChars);
  }

  const flattened = flattenJson(parsed).slice(0, 160);
  const errorLines = flattened.filter((line) => /error|exception|failure|failed|warning|status|message|reason/i.test(line));
  const body = [
    "TokenOpt compressed tool output",
    "kind: json-result",
    `originalChars: ${normalized.length}`,
    "",
    "High-signal fields:",
    ...(errorLines.length > 0 ? errorLines.slice(0, 80) : flattened.slice(0, 80)),
    "",
    "Shape:",
    ...describeShape(parsed).slice(0, 40)
  ].join("\n").trimEnd();
  const capped = cap(body, limitChars);
  return {
    kind: "json-result",
    text: capped,
    originalChars: normalized.length,
    compressedChars: capped.length,
    estimatedTokensSaved: estimateTokensSaved(normalized.length, capped.length, { kind: "json" })
  };
}

function fallback(text: string, limitChars: number): CompressionResult {
  const capped = cap([
    "TokenOpt compressed tool output",
    "kind: json-result",
    `originalChars: ${text.length}`,
    "",
    text.slice(0, limitChars)
  ].join("\n"), limitChars);
  return {
    kind: "json-result",
    text: capped,
    originalChars: text.length,
    compressedChars: capped.length,
    estimatedTokensSaved: estimateTokensSaved(text.length, capped.length, { kind: "json" })
  };
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function flattenJson(value: unknown, prefix = "$"): string[] {
  if (Array.isArray(value)) {
    const lines = [`${prefix}.length=${value.length}`];
    for (let index = 0; index < Math.min(value.length, 12); index += 1) {
      lines.push(...flattenJson(value[index], `${prefix}[${index}]`));
    }
    return lines;
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => flattenJson(child, `${prefix}.${key}`));
  }
  const printable = typeof value === "string" ? value.replace(/\s+/g, " ").slice(0, 240) : String(value);
  return [`${prefix}=${printable}`];
}

function describeShape(value: unknown, prefix = "$"): string[] {
  if (Array.isArray(value)) {
    return [`${prefix}: array(${value.length})`, ...(value.length > 0 ? describeShape(value[0], `${prefix}[]`) : [])];
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return [
      `${prefix}: object(${entries.map(([key]) => key).slice(0, 20).join(",")})`,
      ...entries.slice(0, 12).flatMap(([key, child]) => describeShape(child, `${prefix}.${key}`))
    ];
  }
  return [`${prefix}: ${typeof value}`];
}

function cap(text: string, limitChars: number): string {
  return text.length > limitChars ? `${text.slice(0, Math.max(0, limitChars - 80))}\n\n[truncated by TokenOpt]` : text;
}
