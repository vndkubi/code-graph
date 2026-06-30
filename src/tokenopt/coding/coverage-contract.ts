import type {
  CodingCoverageContract,
  CodingSymbol,
  EvidenceCoverageStatus,
  EvidenceFollowup,
  EvidenceItem,
  EvidenceTaskType,
  FailurePacket,
  SymbolPacket,
  TestNeighborPacket
} from "../types.js";
import { parseFailurePacket } from "./failure-packet.js";
import { buildSymbolPacket, findCodingSymbolsWithStats, tokenizeQuery } from "./symbol-index.js";
import { findTestNeighbors } from "./test-neighbors.js";

export interface CompileCodingCoverageInput {
  repoRoot: string;
  task: string;
  taskType: EvidenceTaskType;
  qualityRubric?: string[];
  firstEvidenceIndex: number;
  hasBuildFacts: boolean;
  codingToolsAvailable: boolean;
}

export interface CodingEvidenceResult {
  answerable: boolean;
  confidence: number;
  coverage: Record<string, EvidenceCoverageStatus>;
  evidence: EvidenceItem[];
  missing: string[];
  allowedFollowups: EvidenceFollowup[];
  contract: CodingCoverageContract;
  metadata: Record<string, unknown>;
}

export function compileCodingCoverageEvidence(input: CompileCodingCoverageInput): CodingEvidenceResult | undefined {
  const taskKind = inferCodingTaskKind(input.taskType, input.task);
  if (!taskKind) {
    return undefined;
  }

  const query = extractCodingQuery([input.task, ...(input.qualityRubric ?? [])].join(" "));
  const search = findCodingSymbolsWithStats({ repoRoot: input.repoRoot, query, limit: 12 });
  const candidates = search.symbols;
  const symbolPacket = candidates[0] ? buildSymbolPacket({ repoRoot: input.repoRoot, symbolId: candidates[0].id }) : undefined;
  const failurePacket = shouldParseFailure(input.task) ? parseFailurePacket({ output: input.task }) : undefined;
  const exactTargets = extractExactTargetNames(input.task);
  const target = symbolPacket?.symbol.file ?? symbolPacket?.symbol.name ?? query;
  const testNeighbors = target ? findTestNeighbors({ repoRoot: input.repoRoot, target, symbolName: symbolPacket?.symbol.name }) : undefined;
  const coverage = buildCodingCoverage({
    taskKind,
    hasBuildFacts: input.hasBuildFacts,
    candidates,
    symbolPacket,
    testNeighbors,
    failurePacket,
    exactTargets,
    task: input.task
  });
  const requiredDimensions = requiredCoverageDimensions(taskKind);
  const missing = missingCoverageMessages(requiredDimensions, coverage);
  const answerable = missing.length === 0;
  const allowedFollowups = answerable
    ? []
    : buildCodingFollowups({
        query,
        symbolPacket,
        failurePacket,
        codingToolsAvailable: input.codingToolsAvailable,
        taskKind
      });
  const confidence = answerable ? 0.88 : symbolPacket ? 0.64 : candidates.length > 0 ? 0.58 : 0.42;
  const evidence = buildCodingEvidenceItems(input.firstEvidenceIndex, candidates, symbolPacket, testNeighbors, failurePacket, coverage);
  const contract: CodingCoverageContract = {
    task_kind: taskKind,
    answerable,
    confidence,
    coverage,
    missing,
    allowed_followups: allowedFollowups,
    metadata: {
      symbol_index_hit: search.indexStats.cacheHit,
      symbol_index_file_count: search.indexStats.fileCount,
      symbol_index_symbol_count: search.indexStats.symbolCount
    }
  };

  return {
    answerable,
    confidence,
    coverage,
    evidence,
    missing,
    allowedFollowups,
    contract,
    metadata: contract.metadata ?? {}
  };
}

function inferCodingTaskKind(
  taskType: EvidenceTaskType,
  task: string
): CodingCoverageContract["task_kind"] | undefined {
  if (taskType === "write_unittest" || /\b(unit test|unittest|write test|add test|test coverage)\b/i.test(task)) {
    return "write_unittest";
  }
  if (taskType === "implement" || /\b(implement|add feature|code change|modify|patch|change this|build this)\b/i.test(task)) {
    return "implement";
  }
  if (/\b(fix bug|bugfix|fix failing|regression|broken|failing test)\b/i.test(task)) {
    return "fix_bug";
  }
  if (taskType === "investigate" && /\b(stack trace|exception|traceback|build failure|compilation error|runtime|debug|root cause|caused by)\b/i.test(task)) {
    return "debug_runtime";
  }
  if (taskType === "field_impact" || /\b(find usages|where defined|callers|references|definition|impact of)\b/i.test(task)) {
    return "exact_symbol";
  }
  return undefined;
}

function extractCodingQuery(task: string): string {
  const directTargets = [
    ...Array.from(task.matchAll(/\b[A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|java|py)\b/g)).map((match) => match[0]),
    ...Array.from(task.matchAll(/[`"']([A-Za-z_$][A-Za-z0-9_.$-]+)[`"']/g)).map((match) => match[1]!),
    ...Array.from(task.matchAll(/\b[A-Z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?\b/g)).map((match) => match[0])
  ];
  if (directTargets.length > 0) {
    return directTargets.slice(0, 6).join(" ");
  }
  const tokens = tokenizeQuery(task)
    .filter((token) => !STOP_QUERY_TOKENS.has(token))
    .slice(0, 8);
  return tokens.join(" ");
}

function extractExactTargetNames(task: string): string[] {
  const names = new Set<string>();
  for (const match of task.matchAll(/\b[A-Z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?\b/g)) {
    const value = match[0].split(".").at(-1)!;
    if (value.length >= 3 && !STOP_QUERY_TOKENS.has(value.toLowerCase())) {
      names.add(value);
    }
  }
  for (const match of task.matchAll(/\b[A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|java|py)\b/g)) {
    const base = match[0].replace(/\\/g, "/").split("/").at(-1)!.replace(/\.(?:ts|tsx|js|jsx|java|py)$/i, "");
    if (base.length >= 3) {
      names.add(base);
    }
  }
  return [...names].slice(0, 8);
}

function shouldParseFailure(task: string): boolean {
  return /\b(error|exception|traceback|failed|failure|cannot find symbol|TS\d{4}|BUILD FAILURE|Tests run:)\b/i.test(task);
}

function buildCodingCoverage(input: {
  taskKind: CodingCoverageContract["task_kind"];
  hasBuildFacts: boolean;
  candidates: CodingSymbol[];
  symbolPacket?: SymbolPacket;
  testNeighbors?: TestNeighborPacket;
  failurePacket?: FailurePacket;
  exactTargets: string[];
  task: string;
}): Record<string, EvidenceCoverageStatus> {
  const packet = input.symbolPacket;
  const neighbors = input.testNeighbors;
  const coverage: Record<string, EvidenceCoverageStatus> = {
    coding_task_classified: "covered",
    target_symbol: targetSymbolCoverage(packet, input.candidates, input.exactTargets),
    signature_or_definition: packet?.symbol.signature ? "covered" : "missing",
    bounded_definition_slice: packet ? "covered" : "missing"
  };

  if (input.taskKind === "write_unittest") {
    coverage.public_api = hasPublicApi(packet) ? "covered" : packet ? "partial" : "missing";
    coverage.dependencies_or_injected_services = hasDependencySignal(packet) ? "covered" : packet ? "partial" : "missing";
    coverage.existing_test_neighbor = neighbors && neighbors.test_files.length > 0 ? "covered" : "missing";
    coverage.test_style = neighbors && neighbors.framework_hints.length > 0 ? "covered" : "missing";
    coverage.mocking_style = neighbors && neighbors.mocking_hints.length > 0 ? "covered" : "partial";
    coverage.edge_or_error_paths = hasEdgeCaseSignal(input.task, packet, input.failurePacket) ? "covered" : "partial";
    coverage.build_or_test_command = input.hasBuildFacts ? "covered" : "partial";
    return coverage;
  }

  if (input.taskKind === "implement") {
    coverage.related_type_or_interface = hasDependencySignal(packet) ? "covered" : packet ? "partial" : "missing";
    coverage.callers_or_usages = packet && packet.callers.length > 0 ? "covered" : "partial";
    coverage.similar_implementation = input.candidates.length > 1 ? "covered" : "partial";
    coverage.test_neighbor = neighbors && neighbors.test_files.length > 0 ? "covered" : "missing";
    coverage.build_or_test_command = input.hasBuildFacts ? "covered" : "partial";
    return coverage;
  }

  if (input.taskKind === "fix_bug" || input.taskKind === "debug_runtime") {
    coverage.failure_context = input.failurePacket && input.failurePacket.errors.length > 0 ? "covered" : "missing";
    coverage.failure_locations = input.failurePacket && input.failurePacket.suggested_slices.length > 0 ? "covered" : "partial";
    coverage.target_symbol_from_failure = packet ? "covered" : input.failurePacket && input.failurePacket.errors.length > 0 ? "partial" : "missing";
    coverage.test_neighbor = neighbors && neighbors.test_files.length > 0 ? "covered" : "partial";
    coverage.build_or_test_command = input.hasBuildFacts ? "covered" : "partial";
    return coverage;
  }

  coverage.callers_or_references = packet && packet.callers.length > 0 ? "covered" : "partial";
  coverage.test_neighbor = neighbors && neighbors.test_files.length > 0 ? "covered" : "partial";
  return coverage;
}

function requiredCoverageDimensions(taskKind: CodingCoverageContract["task_kind"]): string[] {
  switch (taskKind) {
    case "write_unittest":
      return [
        "target_symbol",
        "signature_or_definition",
        "public_api",
        "dependencies_or_injected_services",
        "existing_test_neighbor",
        "test_style",
        "build_or_test_command"
      ];
    case "implement":
      return [
        "target_symbol",
        "signature_or_definition",
        "related_type_or_interface",
        "callers_or_usages",
        "test_neighbor",
        "build_or_test_command"
      ];
    case "fix_bug":
    case "debug_runtime":
      return ["failure_context", "failure_locations", "target_symbol_from_failure", "build_or_test_command"];
    case "exact_symbol":
      return ["target_symbol", "signature_or_definition", "callers_or_references"];
  }
}

function missingCoverageMessages(required: string[], coverage: Record<string, EvidenceCoverageStatus>): string[] {
  const missing = required.filter((dimension) => coverage[dimension] !== "covered");
  return missing.map((dimension) => `Coding coverage missing: ${dimension}=${coverage[dimension] ?? "missing"}.`);
}

function buildCodingFollowups(input: {
  query: string;
  symbolPacket?: SymbolPacket;
  failurePacket?: FailurePacket;
  codingToolsAvailable: boolean;
  taskKind: CodingCoverageContract["task_kind"];
}): EvidenceFollowup[] {
  const query = input.symbolPacket?.symbol.name ?? input.failurePacket?.errors.find((error) => error.symbol)?.symbol ?? (input.query || "<target-symbol-or-file>");
  if (input.codingToolsAvailable) {
    const followups: EvidenceFollowup[] = [];
    if (input.taskKind === "fix_bug" || input.taskKind === "debug_runtime") {
      followups.push({
        tool: "tokenopt_failure_packet",
        reason: "Parse compiler/test/runtime output into exact failure files, lines, and suggested slices.",
        args: { output: "<failure-output>" },
        max_output_tokens: 700
      });
    }
    followups.push({
      tool: "tokenopt_symbols_find",
      reason: "Find exact candidate symbols before deciding implementation or test coverage is complete.",
      args: { query, limit: 12 },
      max_output_tokens: 700
    });
    followups.push({
      tool: "tokenopt_symbol_packet",
      reason: "Read signature, bounded definition slice, imports/dependencies, callers, callees, and nearby tests for the chosen symbol.",
      args: { query },
      max_output_tokens: 1200
    });
    followups.push({
      tool: "tokenopt_test_neighbors",
      reason: "Find existing test files, naming patterns, framework, and mocking style for the target.",
      args: { target: input.symbolPacket?.symbol.file ?? query },
      max_output_tokens: 800
    });
    return followups.slice(0, 4);
  }

  return [
    {
      tool: "tokenopt_search",
      reason: "Find the exact target symbol, source file, or failing test reference before marking coding evidence answerable.",
      args: { pattern: query, path: "." },
      max_output_tokens: 800
    },
    {
      tool: "tokenopt_read_file",
      reason: "Read a bounded slice around the matched symbol and nearby tests.",
      args: { path: "<matched-file>", startLine: 1, maxLines: 180 },
      max_output_tokens: 1100
    }
  ];
}

function buildCodingEvidenceItems(
  firstEvidenceIndex: number,
  candidates: CodingSymbol[],
  symbolPacket: SymbolPacket | undefined,
  testNeighbors: TestNeighborPacket | undefined,
  failurePacket: FailurePacket | undefined,
  coverage: Record<string, EvidenceCoverageStatus>
): EvidenceItem[] {
  const evidence: EvidenceItem[] = [];
  evidence.push({
    id: `E${firstEvidenceIndex}`,
    claim: "Coding coverage layer ran regex-lite symbol discovery before allowing coding-task answerability.",
    files: candidates.slice(0, 8).map((symbol) => symbol.file),
    facts: [
      `candidate_symbols=${candidates.slice(0, 8).map(formatSymbolFact).join(";") || "none"}`,
      `coverage=${Object.entries(coverage).map(([key, value]) => `${key}:${value}`).join(",")}`
    ],
    tokens_est: 180
  });

  if (symbolPacket) {
    evidence.push({
      id: `E${firstEvidenceIndex + evidence.length}`,
      claim: "Symbol packet captured the chosen symbol signature, bounded definition slice, dependencies, callers, callees, and nearby tests.",
      files: [symbolPacket.symbol.file, ...symbolPacket.nearby_tests].slice(0, 12),
      facts: [
        `symbol=${symbolPacket.symbol.name}`,
        `kind=${symbolPacket.symbol.kind}`,
        `signature=${symbolPacket.symbol.signature.slice(0, 220)}`,
        `definition_slice=${symbolPacket.definition_slice.file}:${symbolPacket.definition_slice.startLine}-${symbolPacket.definition_slice.endLine}`,
        `dependencies=${symbolPacket.dependencies.slice(0, 12).join(",") || "none"}`,
        `callers=${symbolPacket.callers.slice(0, 8).map((caller) => `${caller.file}:${caller.line}`).join(",") || "none"}`,
        `callees=${symbolPacket.callees.slice(0, 12).join(",") || "none"}`
      ],
      tokens_est: 260
    });
  }

  if (testNeighbors) {
    evidence.push({
      id: `E${firstEvidenceIndex + evidence.length}`,
      claim: "Test neighbor finder mapped the target to nearby tests, naming conventions, framework, and mocking hints.",
      files: testNeighbors.test_files.slice(0, 12),
      facts: [
        `source_files=${testNeighbors.source_files.slice(0, 8).join(",") || "none"}`,
        `test_files=${testNeighbors.test_files.slice(0, 8).join(",") || "none"}`,
        `naming_patterns=${testNeighbors.naming_patterns.join(",") || "none"}`,
        `framework_hints=${testNeighbors.framework_hints.join(",") || "none"}`,
        `mocking_hints=${testNeighbors.mocking_hints.join(",") || "none"}`
      ],
      tokens_est: 220
    });
  }

  if (failurePacket) {
    evidence.push({
      id: `E${firstEvidenceIndex + evidence.length}`,
      claim: "Failure packet parser extracted compiler/test/runtime failure locations without dumping full output.",
      files: failurePacket.suggested_slices.map((slice) => slice.file).slice(0, 12),
      facts: [
        `failure_kind=${failurePacket.failure_kind}`,
        `errors=${failurePacket.errors.slice(0, 8).map((error) => `${error.file ?? "unknown"}:${error.line ?? "?"}:${error.message.slice(0, 120)}`).join(";") || "none"}`,
        `suggested_slices=${failurePacket.suggested_slices.slice(0, 8).map((slice) => `${slice.file}:${slice.startLine}+${slice.maxLines}`).join(",") || "none"}`
      ],
      tokens_est: 220
    });
  }

  return evidence;
}

function targetSymbolCoverage(
  packet: SymbolPacket | undefined,
  candidates: CodingSymbol[],
  exactTargets: string[]
): EvidenceCoverageStatus {
  if (!packet) {
    return candidates.length > 0 && exactTargets.length === 0 ? "partial" : "missing";
  }
  if (exactTargets.length === 0) {
    return "covered";
  }
  return exactTargets.some((target) => namesMatch(target, packet.symbol.name) || packet.symbol.file.toLowerCase().includes(target.toLowerCase()))
    ? "covered"
    : "missing";
}

function namesMatch(expected: string, actual: string): boolean {
  const expectedLower = expected.toLowerCase();
  const actualLower = actual.toLowerCase();
  return expectedLower === actualLower || expectedLower.endsWith(`.${actualLower}`);
}

function hasPublicApi(packet: SymbolPacket | undefined): boolean {
  if (!packet) {
    return false;
  }
  if (packet.symbol.kind === "function" || packet.symbol.kind === "method") {
    return true;
  }
  return /\b(public\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::|throws|\{|;)/.test(packet.definition_slice.text);
}

function hasDependencySignal(packet: SymbolPacket | undefined): boolean {
  return Boolean(packet && (packet.dependencies.length > 0 || packet.imports.length > 0 || packet.callees.length > 0));
}

function hasEdgeCaseSignal(task: string, packet: SymbolPacket | undefined, failurePacket: FailurePacket | undefined): boolean {
  return /\b(edge|error|exception|invalid|validation|throw|failure|empty|null|undefined|permission|unauthorized)\b/i.test(task) ||
    Boolean(failurePacket?.errors.length) ||
    Boolean(packet && /\b(throw|catch|if\s*\(|return\s+null|undefined|validate|invalid)\b/.test(packet.definition_slice.text));
}

function formatSymbolFact(symbol: CodingSymbol): string {
  return `${symbol.name}@${symbol.file}:${symbol.line}:${symbol.kind}`;
}

const STOP_QUERY_TOKENS = new Set([
  "add",
  "and",
  "before",
  "bug",
  "change",
  "class",
  "code",
  "debug",
  "feature",
  "file",
  "fix",
  "for",
  "implement",
  "module",
  "please",
  "test",
  "unit",
  "update",
  "write"
]);
