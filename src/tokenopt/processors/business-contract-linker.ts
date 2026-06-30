export interface BusinessContractCandidate {
  file: string;
  type: "api" | "schema" | "messaging" | "security" | "test" | "docs";
  reason: string;
}

export interface BusinessContractLink {
  task: string;
  changedFiles: string[];
  candidates: BusinessContractCandidate[];
  missingContractTypes: string[];
  reviewHints: string[];
}

export function linkBusinessContracts(input: {
  task: string;
  changedFiles: string[];
  repoFiles: string[];
}): BusinessContractLink {
  const terms = extractTerms(input.task, input.changedFiles);
  const candidates = input.repoFiles.flatMap((file) => classifyContractFile(file, terms, input.changedFiles)).slice(0, 80);
  const types = new Set(candidates.map((candidate) => candidate.type));
  const missingContractTypes = ["api", "schema", "messaging", "security", "test"].filter((type) => !types.has(type as BusinessContractCandidate["type"]));
  return {
    task: input.task,
    changedFiles: input.changedFiles,
    candidates,
    missingContractTypes,
    reviewHints: buildReviewHints(types, input.changedFiles)
  };
}

function classifyContractFile(filePath: string, terms: string[], changedFiles: string[]): BusinessContractCandidate[] {
  const normalized = filePath.replace(/\\/g, "/");
  const haystack = normalized.toLowerCase();
  const nearChanged = changedFiles.some((changed) => {
    const changedDir = changed.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    return changedDir.length > 0 && normalized.startsWith(changedDir);
  });
  const termMatch = terms.some((term) => term.length >= 3 && haystack.includes(term));
  const shouldInclude = nearChanged || termMatch;
  const candidates: BusinessContractCandidate[] = [];
  if (!shouldInclude && !isGlobalContractPath(haystack)) {
    return candidates;
  }
  if (/(controller|resource|endpoint|route|openapi|swagger|api-docs|graphql|proto)/i.test(normalized)) {
    candidates.push({ file: normalized, type: "api", reason: nearChanged ? "near changed API code" : "API contract path/name match" });
  }
  if (/(entity|schema|migration|repository|dao|model|table|liquibase|flyway)/i.test(normalized)) {
    candidates.push({ file: normalized, type: "schema", reason: nearChanged ? "near changed data code" : "data/schema contract path/name match" });
  }
  if (/(jms|kafka|rabbit|queue|topic|listener|message|event)/i.test(normalized)) {
    candidates.push({ file: normalized, type: "messaging", reason: nearChanged ? "near changed messaging code" : "messaging contract path/name match" });
  }
  if (/(security|auth|permission|role|oauth|jwt|filterchain)/i.test(normalized)) {
    candidates.push({ file: normalized, type: "security", reason: nearChanged ? "near changed security code" : "security contract path/name match" });
  }
  if (/(^|\/)(test|tests|src\/test|qa|__tests__)(\/|$)|Test\.java$|Tests\.java$|IT\.java$/i.test(normalized)) {
    candidates.push({ file: normalized, type: "test", reason: nearChanged ? "near changed tests" : "test contract path/name match" });
  }
  if (/(^|\/)(docs|doc|README|readme)|\.(md|adoc|asciidoc)$/i.test(normalized)) {
    candidates.push({ file: normalized, type: "docs", reason: termMatch ? "task term appears in documentation path" : "documentation contract candidate" });
  }
  return candidates;
}

function buildReviewHints(types: Set<BusinessContractCandidate["type"]>, changedFiles: string[]): string[] {
  const hints: string[] = [];
  if (types.has("api")) {
    hints.push("Check API request/response compatibility and endpoint-level tests.");
  }
  if (types.has("schema")) {
    hints.push("Check persistence schema/entity compatibility and migration safety.");
  }
  if (types.has("messaging")) {
    hints.push("Check message payload, destination, retry, and backward compatibility.");
  }
  if (types.has("security")) {
    hints.push("Check authorization boundaries and role/scope drift.");
  }
  if (!types.has("test") && changedFiles.length > 0) {
    hints.push("No nearby tests detected; require targeted regression coverage before accepting risky behavior changes.");
  }
  return hints.length > 0 ? hints : ["No obvious business contract files detected; review changed-file semantics directly."];
}

function extractTerms(task: string, changedFiles: string[]): string[] {
  const words = [
    ...task.toLowerCase().split(/[^a-z0-9]+/),
    ...changedFiles.flatMap((file) => file.toLowerCase().split(/[^a-z0-9]+/))
  ];
  const stop = new Set(["the", "and", "for", "with", "this", "that", "review", "diff", "change", "file", "java", "src", "main", "test"]);
  return [...new Set(words.filter((word) => word.length >= 3 && !stop.has(word)))].slice(0, 30);
}

function isGlobalContractPath(pathValue: string): boolean {
  return /(^|\/)(openapi|swagger|api|schema|proto|graphql|docs|security)(\/|$)/.test(pathValue);
}
