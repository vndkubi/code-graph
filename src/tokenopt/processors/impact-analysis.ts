import fs from "node:fs";
import path from "node:path";

export interface ImpactAnalysisResult {
  target: string;
  changedFiles: string[];
  definitions: string[];
  usages: string[];
  publicContracts: string[];
  likelyTests: string[];
  hotPaths: string[];
  missing: string[];
}

export function analyzeImpact(input: {
  repoRoot: string;
  target: string;
  changedFiles: string[];
  repoFiles: string[];
}): ImpactAnalysisResult {
  const normalizedFiles = input.repoFiles.map((file) => file.replace(/\\/g, "/"));
  const targetTerms = extractTargetTerms(input.target, input.changedFiles);
  const candidateFiles = normalizedFiles.filter((file) => shouldScan(file, targetTerms, input.changedFiles)).slice(0, 300);
  const definitions: string[] = [];
  const usages: string[] = [];

  for (const file of candidateFiles) {
    const absolute = path.join(input.repoRoot, file);
    if (!isReadableSource(absolute)) {
      continue;
    }
    const lines = readLines(absolute);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (looksLikeDefinition(line, targetTerms)) {
        definitions.push(`${file}:${index + 1}:${line.trim()}`);
      } else if (lineMatchesTerms(line, targetTerms)) {
        usages.push(`${file}:${index + 1}:${line.trim()}`);
      }
      if (definitions.length + usages.length > 220) {
        break;
      }
    }
  }

  const publicContracts = normalizedFiles
    .filter((file) => pathMatchesAny(file, targetTerms) && /(controller|resource|endpoint|openapi|swagger|proto|graphql|route|security|listener|schema|migration)/i.test(file))
    .slice(0, 40);
  const likelyTests = normalizedFiles
    .filter((file) => isTestPath(file) && (pathMatchesAny(file, targetTerms) || nearChanged(file, input.changedFiles)))
    .slice(0, 60);
  const hotPaths = normalizedFiles
    .filter((file) => pathMatchesAny(file, targetTerms) && /(controller|service|manager|processor|repository|listener|handler|facade|workflow)/i.test(file))
    .slice(0, 60);

  return {
    target: input.target,
    changedFiles: input.changedFiles,
    definitions: definitions.slice(0, 80),
    usages: usages.slice(0, 120),
    publicContracts,
    likelyTests,
    hotPaths,
    missing: [
      definitions.length === 0 ? "No definition-like line found for target." : "",
      likelyTests.length === 0 ? "No likely tests found from path/term matching." : "",
      publicContracts.length === 0 ? "No public contract files found from path/term matching." : ""
    ].filter(Boolean)
  };
}

function extractTargetTerms(target: string, changedFiles: string[]): string[] {
  const raw = [
    target,
    ...target.split(/[. _:/\\-]+/),
    ...changedFiles.map((file) => path.basename(file, path.extname(file))),
    ...changedFiles.flatMap((file) => file.split(/[\\/_.-]+/))
  ];
  const stop = new Set(["src", "main", "test", "java", "class", "method", "file"]);
  return [...new Set(raw.map((item) => item.trim()).filter((item) => item.length >= 3 && !stop.has(item.toLowerCase())))].slice(0, 24);
}

function shouldScan(file: string, terms: string[], changedFiles: string[]): boolean {
  return /\.(ts|tsx|js|jsx|java|py|go|rs|kt|scala|cs|xml|ya?ml|json|md)$/i.test(file) &&
    (pathMatchesAny(file, terms) || nearChanged(file, changedFiles) || isTestPath(file));
}

function pathMatchesAny(file: string, terms: string[]): boolean {
  const normalized = file.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return terms.some((term) => normalized.includes(term.toLowerCase().replace(/[^a-z0-9]+/g, "")));
}

function nearChanged(file: string, changedFiles: string[]): boolean {
  return changedFiles.some((changed) => {
    const changedDir = changed.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    return changedDir.length > 0 && file.startsWith(changedDir);
  });
}

function isTestPath(file: string): boolean {
  return /(^|\/)(test|tests|src\/test|qa|__tests__)(\/|$)|\.(test|spec)\.(ts|tsx|js|jsx)$|Test\.java$|Tests\.java$|IT\.java$/i.test(file);
}

function isReadableSource(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size <= 256 * 1024;
  } catch {
    return false;
  }
}

function readLines(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n");
  } catch {
    return [];
  }
}

function looksLikeDefinition(line: string, terms: string[]): boolean {
  return lineMatchesTerms(line, terms) &&
    /\b(class|interface|enum|record|function|def|const|let|var|public|private|protected|fun)\b/.test(line);
}

function lineMatchesTerms(line: string, terms: string[]): boolean {
  const normalized = line.toLowerCase();
  return terms.some((term) => normalized.includes(term.toLowerCase()));
}
