import { estimateTokensSaved } from "../token-estimator.js";

export interface JavaDiffFileSummary {
  file: string;
  additions: number;
  deletions: number;
  categories: string[];
  impactedSymbols: string[];
  likelyTests: string[];
}

export interface JavaDiffSummary {
  changedFiles: JavaDiffFileSummary[];
  categories: Record<string, number>;
  impactedSymbols: string[];
  likelyTests: string[];
  semanticHints: string[];
  originalChars: number;
  summaryChars: number;
  estimatedTokensSaved: number;
}

interface CurrentFile {
  file: string;
  additions: string[];
  deletions: string[];
}

const LOMBOK_ANNOTATIONS = new Set([
  "Getter",
  "Setter",
  "ToString",
  "EqualsAndHashCode",
  "NoArgsConstructor",
  "AllArgsConstructor",
  "RequiredArgsConstructor",
  "Builder",
  "Data",
  "Value"
]);

export function prepareJavaDiff(diffText: string): JavaDiffSummary {
  const normalized = diffText.replace(/\r\n/g, "\n");
  const files = parseFiles(normalized);
  const summaries = files
    .filter((file) => /\.java$/i.test(file.file))
    .map(summarizeFile);
  const categoryCounts: Record<string, number> = {};
  for (const summary of summaries) {
    for (const category of summary.categories) {
      categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    }
  }
  const impactedSymbols = uniqueStrings(summaries.flatMap((summary) => summary.impactedSymbols)).slice(0, 40);
  const likelyTests = uniqueStrings(summaries.flatMap((summary) => summary.likelyTests)).slice(0, 40);
  const semanticHints = buildSemanticHints(summaries, categoryCounts);
  const compactText = JSON.stringify({ changedFiles: summaries, categoryCounts, impactedSymbols, likelyTests, semanticHints });

  return {
    changedFiles: summaries,
    categories: categoryCounts,
    impactedSymbols,
    likelyTests,
    semanticHints,
    originalChars: normalized.length,
    summaryChars: compactText.length,
    estimatedTokensSaved: estimateTokensSaved(normalized.length, compactText.length, { kind: "java" })
  };
}

function parseFiles(diffText: string): CurrentFile[] {
  const files: CurrentFile[] = [];
  let current: CurrentFile | undefined;
  for (const line of diffText.split("\n")) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      if (current) {
        files.push(current);
      }
      current = { file: diffMatch[2]!, additions: [], deletions: [] };
      continue;
    }
    const plusMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (plusMatch) {
      if (!current) {
        current = { file: plusMatch[1]!, additions: [], deletions: [] };
      } else {
        current.file = plusMatch[1]!;
      }
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.additions.push(line.slice(1));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.deletions.push(line.slice(1));
    }
  }
  if (current) {
    files.push(current);
  }
  return files;
}

function summarizeFile(file: CurrentFile): JavaDiffFileSummary {
  const changed = [...file.additions, ...file.deletions].filter((line) => line.trim().length > 0);
  const categories = classifyChangedLines(file.additions, file.deletions);
  const impactedSymbols = extractImpactedSymbols(changed);
  return {
    file: file.file,
    additions: file.additions.length,
    deletions: file.deletions.length,
    categories,
    impactedSymbols,
    likelyTests: inferLikelyTests(file.file, impactedSymbols)
  };
}

function classifyChangedLines(additions: string[], deletions: string[]): string[] {
  const changed = [...additions, ...deletions].map((line) => line.trim()).filter(Boolean);
  if (changed.length === 0) {
    return ["whitespace"];
  }
  const categories = new Set<string>();
  if (isWhitespaceOnlyChange(additions, deletions)) {
    categories.add("whitespace");
  }
  if (changed.every((line) => /^import\s+/.test(line))) {
    categories.add("import-reorder");
  }
  if (changed.some(isLombokLine)) {
    categories.add("lombok-change");
  }
  if (changed.every((line) => line.startsWith("@") || isLombokLine(line))) {
    categories.add("annotation-change");
  }
  if (changed.some((line) => /@Transactional|\bTransaction(?:al|Manager|Template)?\b|EntityManager/i.test(line))) {
    categories.add("transaction-boundary");
  }
  if (changed.some((line) => /@JmsListener|\bJMS\b|\bQueue\b|\bTopic\b|jakarta\.jms|javax\.jms/i.test(line))) {
    categories.add("jms-config");
  }
  if (changed.some((line) => /@PreAuthorize|@Secured|SecurityFilterChain|Authentication|Authorization/i.test(line))) {
    categories.add("security-contract");
  }
  if (changed.some((line) => !line.startsWith("import ") && !line.startsWith("@") && !/^\/\/|\/\*|\*/.test(line))) {
    categories.add("business-logic");
  }
  return [...categories].length > 0 ? [...categories] : ["unknown-java-change"];
}

function isWhitespaceOnlyChange(additions: string[], deletions: string[]): boolean {
  const normalize = (lines: string[]) => lines.map((line) => line.replace(/\s+/g, "")).filter(Boolean).sort().join("\n");
  return normalize(additions) === normalize(deletions);
}

function isLombokLine(line: string): boolean {
  const annotation = line.match(/^@(?:lombok\.)?([A-Za-z0-9_]+)/)?.[1];
  return Boolean(annotation && LOMBOK_ANNOTATIONS.has(annotation)) || /import\s+lombok\./.test(line);
}

function extractImpactedSymbols(lines: string[]): string[] {
  const symbols = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(/\b(?:class|interface|enum|record)\s+([A-Z][A-Za-z0-9_]*)/g)) {
      symbols.add(match[1]!);
    }
    for (const match of line.matchAll(/\b(?:public|protected|private)\s+(?:static\s+)?(?:final\s+)?[A-Za-z0-9_<>, ?\[\]]+\s+([a-zA-Z_][A-Za-z0-9_]*)\s*\(/g)) {
      symbols.add(match[1]!);
    }
    for (const match of line.matchAll(/@(?:Get|Post|Put|Patch|Delete|Request)Mapping\s*(?:\(([^)]*)\))?/g)) {
      symbols.add(match[0].replace(/\s+/g, " "));
    }
  }
  return [...symbols].slice(0, 20);
}

function inferLikelyTests(filePath: string, symbols: string[]): string[] {
  const normalized = filePath.replace(/\\/g, "/");
  if (/\/src\/test\//.test(normalized) || /Test\.java$|Tests\.java$|IT\.java$/.test(normalized)) {
    return [normalized];
  }
  const base = normalized.replace(/\/src\/main\//, "/src/test/").replace(/\.java$/, "");
  const className = symbols.find((symbol) => /^[A-Z]/.test(symbol)) ?? normalized.match(/([^/]+)\.java$/)?.[1] ?? "Target";
  return uniqueStrings([
    `${base}Test.java`,
    `${base}Tests.java`,
    `${base}IT.java`,
    normalized.replace(/src\/main\/java\/(.+)\/[^/]+\.java$/, `src/test/java/$1/${className}Test.java`)
  ]).slice(0, 6);
}

function buildSemanticHints(files: JavaDiffFileSummary[], categoryCounts: Record<string, number>): string[] {
  const hints: string[] = [];
  if (categoryCounts["business-logic"]) {
    hints.push("Prioritize business-logic hunks over import, whitespace, and Lombok-only changes.");
  }
  if (categoryCounts["transaction-boundary"]) {
    hints.push("Review transaction boundary changes for rollback, propagation, and lazy-loading side effects.");
  }
  if (categoryCounts["jms-config"]) {
    hints.push("Review JMS listener/destination changes for ack mode, retry behavior, and message contract compatibility.");
  }
  if (categoryCounts["security-contract"]) {
    hints.push("Review security contract changes for authorization bypass and role/scope drift.");
  }
  if (files.some((file) => file.categories.every((category) => category === "import-reorder" || category === "whitespace"))) {
    hints.push("Collapse import/whitespace-only files in review output unless they hide compile-impacting changes.");
  }
  return hints.length > 0 ? hints : ["No high-risk Java semantic categories detected."];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
