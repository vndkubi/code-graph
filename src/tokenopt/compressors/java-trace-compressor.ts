import type { CompressionResult } from "../types.js";
import { estimateTokensSaved } from "../token-estimator.js";

const FRAME_LIMIT = 12;
const FRAME_PATTERN = /^\s*at\s+([A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*\([^)]*\)/;
const FRAME_OWNER_PATTERN = /^\s*at\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/;
const FRAMEWORK_PREFIXES = [
  "org.springframework.",
  "org.hibernate.",
  "org.apache.catalina.",
  "org.apache.tomcat.",
  "io.undertow.",
  "jakarta.servlet.",
  "javax.servlet.",
  "java.util.concurrent.",
  "reactor.",
  "net.sf.cglib.",
  "com.sun.proxy."
];

export function looksLikeJavaTrace(text: string): boolean {
  return /(?:^|\n)(?:Exception in thread|Caused by:|[\w.$]+(?:Exception|Error):)/.test(text) &&
    (text.match(/^\s*at\s+[\w.$]+\(.*:\d+\)/gm)?.length ?? 0) >= 3;
}

export function compressJavaTrace(text: string, limitChars: number): CompressionResult {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const selected: string[] = [];
  let keptFrames = 0;
  let collapsedFrameworkFrames = 0;

  for (const line of lines) {
    if (isCauseOrExceptionLine(line)) {
      flushCollapsed(selected, collapsedFrameworkFrames);
      collapsedFrameworkFrames = 0;
      selected.push(line.trimEnd());
      continue;
    }

    if (!FRAME_PATTERN.test(line)) {
      if (selected.length < 16 && isContextLine(line)) {
        selected.push(line.trimEnd());
      }
      continue;
    }

    if (isFrameworkFrame(line)) {
      collapsedFrameworkFrames += 1;
      continue;
    }

    flushCollapsed(selected, collapsedFrameworkFrames);
    collapsedFrameworkFrames = 0;
    if (keptFrames < FRAME_LIMIT) {
      selected.push(line.trimEnd());
      keptFrames += 1;
    }
  }
  flushCollapsed(selected, collapsedFrameworkFrames);

  const body = [
    "TokenOpt compressed tool output",
    "kind: java-trace",
    `originalChars: ${normalized.length}`,
    `keptFrames: ${keptFrames}`,
    "",
    ...dedupeConsecutive(selected).slice(0, 220)
  ].join("\n").trimEnd();
  const capped = body.length > limitChars ? `${body.slice(0, Math.max(0, limitChars - 80))}\n\n[truncated by TokenOpt]` : body;

  return {
    kind: "java-trace",
    text: capped,
    originalChars: normalized.length,
    compressedChars: capped.length,
    estimatedTokensSaved: estimateTokensSaved(normalized.length, capped.length, { kind: "java" })
  };
}

function isCauseOrExceptionLine(line: string): boolean {
  return /^(?:Exception in thread|Caused by:|Suppressed:|\s*[\w.$]+(?:Exception|Error):)/.test(line.trim());
}

function isContextLine(line: string): boolean {
  return /(?:BUILD FAILURE|Tests run:|ERROR|WARN|failed|failure|\[ERROR\])/i.test(line);
}

function isFrameworkFrame(line: string): boolean {
  const owner = line.match(FRAME_OWNER_PATTERN)?.[1] ?? "";
  return FRAMEWORK_PREFIXES.some((prefix) => owner.startsWith(prefix));
}

function flushCollapsed(lines: string[], count: number): void {
  if (count > 0) {
    lines.push(`  ... ${count} framework/internal frames collapsed by TokenOpt`);
  }
}

function dedupeConsecutive(lines: string[]): string[] {
  const result: string[] = [];
  let previous = "";
  for (const line of lines) {
    if (line === previous) {
      continue;
    }
    result.push(line);
    previous = line;
  }
  return result;
}
