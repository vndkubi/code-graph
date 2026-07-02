import type { FailurePacket } from "../types.js";

export interface FailurePacketInput {
  output: string;
}

export function parseFailurePacket(input: FailurePacketInput): FailurePacket {
  const lines = input.output.replace(/\r\n/g, "\n").split("\n");
  const errors: FailurePacket["errors"] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const parsed = parseFailureLine(line, lines[index + 1]);
    if (parsed) {
      errors.push(parsed);
    }
    if (errors.length >= 40) {
      break;
    }
  }

  const suggested_slices = errors
    .filter((error): error is FailurePacket["errors"][number] & { file: string; line: number } => Boolean(error.file && error.line))
    .map((error) => ({
      file: normalizePath(error.file),
      startLine: Math.max(1, error.line - 25),
      maxLines: 90,
      reason: error.symbol ? `Inspect failure around ${error.symbol}.` : "Inspect failure location."
    }))
    .slice(0, 12);

  return {
    failure_kind: inferFailureKind(errors, input.output),
    errors: dedupeErrors(errors),
    suggested_slices,
    raw_lines_kept: Math.min(lines.length, 120)
  };
}

function parseFailureLine(line: string, nextLine = ""): FailurePacket["errors"][number] | undefined {
  const tsParen = line.match(/(.+\.(?:ts|tsx|js|jsx))\((\d+),(\d+)\):\s*(error\s+\w+:\s*.+)$/i);
  if (tsParen) {
    return {
      file: normalizePath(tsParen[1]!),
      line: Number.parseInt(tsParen[2]!, 10),
      column: Number.parseInt(tsParen[3]!, 10),
      symbol: extractLikelySymbol(tsParen[4]!),
      message: tsParen[4]!.trim()
    };
  }

  const colon = line.match(/(?:^|\s)([A-Za-z]:?[^\s:]+?\.(?:ts|tsx|js|jsx|py|java)):(\d+):(?:(\d+):)?\s*(.+)$/i);
  if (colon) {
    return {
      file: normalizePath(colon[1]!),
      line: Number.parseInt(colon[2]!, 10),
      column: colon[3] ? Number.parseInt(colon[3], 10) : undefined,
      symbol: extractLikelySymbol(colon[4]!),
      message: colon[4]!.trim()
    };
  }

  const maven = line.match(/(?:\[ERROR\]\s*)?(.+?\.java):\[(\d+),(\d+)\]\s*(.+)$/i);
  if (maven) {
    return {
      file: normalizePath(maven[1]!),
      line: Number.parseInt(maven[2]!, 10),
      column: Number.parseInt(maven[3]!, 10),
      symbol: extractLikelySymbol(`${maven[4]} ${nextLine}`),
      message: `${maven[4]!.trim()} ${nextLine.trim()}`.trim()
    };
  }

  const javaFrame = line.match(/\(([^():]+\.java):(\d+)\)/);
  if (javaFrame) {
    return {
      file: normalizePath(javaFrame[1]!),
      line: Number.parseInt(javaFrame[2]!, 10),
      symbol: extractLikelySymbol(line),
      message: line.trim()
    };
  }

  const pyFile = line.match(/File\s+"([^"]+\.py)",\s+line\s+(\d+)/);
  if (pyFile) {
    return {
      file: normalizePath(pyFile[1]!),
      line: Number.parseInt(pyFile[2]!, 10),
      symbol: extractLikelySymbol(nextLine),
      message: nextLine.trim() || line.trim()
    };
  }

  const pytestShort = line.match(/([A-Za-z0-9_./\\-]+\.py):(\d+):\s*(.+)$/);
  if (pytestShort) {
    return {
      file: normalizePath(pytestShort[1]!),
      line: Number.parseInt(pytestShort[2]!, 10),
      symbol: extractLikelySymbol(pytestShort[3]!),
      message: pytestShort[3]!.trim()
    };
  }

  return undefined;
}

function inferFailureKind(errors: FailurePacket["errors"], output: string): FailurePacket["failure_kind"] {
  if (errors.some((error) => /\.(ts|tsx)$/i.test(error.file ?? "")) || /\bTS\d{4}\b/.test(output)) {
    return "typescript";
  }
  if (errors.some((error) => /\.(js|jsx)$/i.test(error.file ?? ""))) {
    return "javascript";
  }
  if (errors.some((error) => /\.py$/i.test(error.file ?? "")) || /\bpytest\b|Traceback \(most recent call last\)/i.test(output)) {
    return "python";
  }
  if (errors.some((error) => /\.java$/i.test(error.file ?? "")) || /BUILD FAILURE|COMPILATION ERROR|org\.junit/i.test(output)) {
    return "java";
  }
  if (/Tests run:|FAIL|AssertionError|expected|received/i.test(output)) {
    return "test";
  }
  return "unknown";
}

function extractLikelySymbol(text: string): string | undefined {
  const quoted = text.match(/['"`]([A-Za-z_$][\w$]*)['"`]/);
  if (quoted) {
    return quoted[1];
  }
  const cannotFind = text.match(/cannot find symbol\s+(?:symbol:\s*)?(?:class|method|variable)?\s*([A-Za-z_$][\w$]*)/i);
  if (cannotFind) {
    return cannotFind[1];
  }
  const name = text.match(/\b([A-Z][A-Za-z0-9_]*(?:Exception|Error|Service|Controller|Repository|Test)?)\b/);
  return name?.[1];
}

function dedupeErrors(errors: FailurePacket["errors"]): FailurePacket["errors"] {
  const seen = new Set<string>();
  const result: FailurePacket["errors"] = [];
  for (const error of errors) {
    const key = `${error.file ?? ""}:${error.line ?? ""}:${error.column ?? ""}:${error.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(error);
  }
  return result;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}
