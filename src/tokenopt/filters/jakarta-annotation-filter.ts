import { estimateTokensSaved } from "../token-estimator.js";

export interface JakartaAnnotationFilterResult {
  text: string;
  collapsedGroups: number;
  collapsedAnnotations: string[];
  originalChars: number;
  filteredChars: number;
  estimatedTokensSaved: number;
}

const LOW_SIGNAL_ANNOTATIONS = new Set([
  "Getter",
  "Setter",
  "ToString",
  "EqualsAndHashCode",
  "NoArgsConstructor",
  "AllArgsConstructor",
  "RequiredArgsConstructor",
  "Builder",
  "SuperBuilder",
  "Data",
  "Value",
  "Slf4j",
  "Log4j2"
]);

export function filterJakartaAnnotations(source: string): JakartaAnnotationFilterResult {
  const normalized = source.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const output: string[] = [];
  const collapsedAnnotations: string[] = [];
  let collapsedGroups = 0;
  let pending: Array<{ line: string; annotation: string; indent: string }> = [];

  for (const line of lines) {
    const annotation = parseLowSignalAnnotation(line);
    if (annotation) {
      pending.push(annotation);
      continue;
    }
    flushPending(output, pending, collapsedAnnotations);
    if (pending.length > 0) {
      collapsedGroups += 1;
      pending = [];
    }
    output.push(line);
  }
  flushPending(output, pending, collapsedAnnotations);
  if (pending.length > 0) {
    collapsedGroups += 1;
  }

  const text = output.join("\n");
  return {
    text,
    collapsedGroups,
    collapsedAnnotations: [...new Set(collapsedAnnotations)],
    originalChars: normalized.length,
    filteredChars: text.length,
    estimatedTokensSaved: estimateTokensSaved(normalized.length, text.length, { kind: "java" })
  };
}

function parseLowSignalAnnotation(line: string): { line: string; annotation: string; indent: string } | undefined {
  const match = line.match(/^(\s*)@(?:lombok\.)?([A-Za-z0-9_]+)(?:\([^)]*\))?\s*$/);
  if (!match) {
    return undefined;
  }
  const annotation = match[2]!;
  if (!LOW_SIGNAL_ANNOTATIONS.has(annotation)) {
    return undefined;
  }
  return {
    line,
    annotation: `@${annotation}`,
    indent: match[1] ?? ""
  };
}

function flushPending(
  output: string[],
  pending: Array<{ line: string; annotation: string; indent: string }>,
  collapsedAnnotations: string[]
): void {
  if (pending.length === 0) {
    return;
  }
  collapsedAnnotations.push(...pending.map((item) => item.annotation));
  const indent = pending[0]?.indent ?? "";
  output.push(`${indent}// [Lombok: ${pending.map((item) => item.annotation).join(", ")}]`);
}
