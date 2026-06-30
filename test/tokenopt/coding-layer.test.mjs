import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileCodingCoverageEvidence } from "../../dist/tokenopt/coding/coverage-contract.js";
import { parseFailurePacket } from "../../dist/tokenopt/coding/failure-packet.js";
import { buildSymbolPacket, findCodingSymbols, findCodingSymbolsWithStats, getCodingSymbolIndexStats } from "../../dist/tokenopt/coding/symbol-index.js";
import { findTestNeighbors } from "../../dist/tokenopt/coding/test-neighbors.js";

function makeCodingFixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-coding-fixture-"));
  fs.mkdirSync(path.join(repo, "src", "orders"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src", "benchmark"), { recursive: true });
  fs.mkdirSync(path.join(repo, "test", "orders"), { recursive: true });
  fs.mkdirSync(path.join(repo, "test", "benchmark"), { recursive: true });
  fs.mkdirSync(path.join(repo, "backend", "src", "main", "java", "com", "acme"), { recursive: true });
  fs.mkdirSync(path.join(repo, "pkg"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "src", "orders", "OrderService.ts"),
    [
      "import { OrderRepository } from './OrderRepository';",
      "",
      "export class OrderService {",
      "  constructor(private repo: OrderRepository) {}",
      "",
      "  authorizePayment(orderId: string): boolean {",
      "    if (!orderId) throw new Error('missing order');",
      "    return this.repo.find(orderId).status === 'ready';",
      "  }",
      "}",
      "",
      "export function normalizeOrderId(value: string): string {",
      "  return value.trim();",
      "}"
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(repo, "test", "orders", "OrderService.test.ts"),
    [
      "import { describe, expect, it, vi } from 'vitest';",
      "import { OrderService } from '../../src/orders/OrderService';",
      "",
      "describe('OrderService', () => {",
      "  it('authorizes ready orders', () => {",
      "    const repo = { find: vi.fn(() => ({ status: 'ready' })) };",
      "    expect(new OrderService(repo).authorizePayment('o1')).toBe(true);",
      "  });",
      "});"
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(repo, "src", "benchmark", "suite-benchmark.ts"),
    [
      "export function buildSuitePrompt(): string {",
      "  return naturalTokenOptCodeGraphPlanLines().join('\\n');",
      "}",
      "",
      "export function naturalTokenOptCodeGraphPlanLines(): string[] {",
      "  return ['preserve business coverage validation'];",
      "}",
      "",
      "export function naturalTaskWantsTestEvidence(): boolean {",
      "  return true;",
      "}"
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(repo, "test", "benchmark", "suite-benchmark-metadata.test.ts"),
    "import { buildSuitePrompt } from '../../src/benchmark/suite-benchmark';\nit('keeps benchmark prompt contract', () => expect(buildSuitePrompt()).toContain('validation'));\n"
  );
  fs.writeFileSync(
    path.join(repo, "backend", "src", "main", "java", "com", "acme", "PaymentGateway.java"),
    [
      "package com.acme;",
      "import java.util.UUID;",
      "public class PaymentGateway {",
      "  public boolean authorize(UUID id) {",
      "    return id != null;",
      "  }",
      "}"
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(repo, "pkg", "integrations.py"),
    [
      "class IntegrationBase:",
      "    def register(self, key: str) -> None:",
      "        if not key:",
      "            raise ValueError('missing key')",
      "",
      "def normalize_key(value: str) -> str:",
      "    return value.strip()"
    ].join("\n")
  );
  return repo;
}

test("regex-lite symbol scanner extracts TS, Java, and Python symbols", () => {
  const repo = makeCodingFixture();
  const orderSymbols = findCodingSymbols({ repoRoot: repo, query: "OrderService authorizePayment" });
  assert.equal(orderSymbols.some((symbol) => symbol.name === "OrderService" && symbol.kind === "class"), true);
  assert.equal(orderSymbols.some((symbol) => symbol.name === "authorizePayment" && symbol.kind === "method"), true);

  const javaSymbols = findCodingSymbols({ repoRoot: repo, query: "PaymentGateway authorize" });
  assert.equal(javaSymbols.some((symbol) => symbol.name === "PaymentGateway" && symbol.language === "java"), true);
  assert.equal(javaSymbols.some((symbol) => symbol.name === "authorize" && symbol.kind === "method"), true);

  const pythonSymbols = findCodingSymbols({ repoRoot: repo, query: "IntegrationBase normalize_key" });
  assert.equal(pythonSymbols.some((symbol) => symbol.name === "IntegrationBase" && symbol.language === "python"), true);
  assert.equal(pythonSymbols.some((symbol) => symbol.name === "normalize_key" && symbol.kind === "function"), true);
});

test("persistent symbol index reuses cache and rebuilds after source changes", () => {
  const repo = makeCodingFixture();
  const first = getCodingSymbolIndexStats(repo, { forceRebuild: true });
  assert.equal(first.cacheHit, false);
  assert.ok(first.fileCount >= 4);
  assert.ok(first.symbolCount >= 5);
  assert.equal(fs.existsSync(first.cachePath), true);

  const second = getCodingSymbolIndexStats(repo);
  assert.equal(second.cacheHit, true);
  assert.equal(second.symbolCount, first.symbolCount);

  fs.writeFileSync(
    path.join(repo, "src", "orders", "OrderPolicy.ts"),
    [
      "export class OrderPolicy {",
      "  canAuthorize(orderId: string): boolean {",
      "    return orderId.length > 0;",
      "  }",
      "}"
    ].join("\n")
  );

  const rebuilt = getCodingSymbolIndexStats(repo);
  assert.equal(rebuilt.cacheHit, false);
  assert.ok(rebuilt.symbolCount > first.symbolCount);
});

test("symbol search returns cache-hit metadata without a second index load", () => {
  const repo = makeCodingFixture();
  const first = findCodingSymbolsWithStats({ repoRoot: repo, query: "OrderService authorizePayment" });
  assert.equal(first.indexStats.cacheHit, false);
  assert.ok(first.symbols.length > 0);

  const second = findCodingSymbolsWithStats({ repoRoot: repo, query: "OrderService authorizePayment" });
  assert.equal(second.indexStats.cacheHit, true);
  assert.equal(second.indexStats.symbolCount, first.indexStats.symbolCount);
});

test("symbol packet includes definition, dependencies, callers, callees, and nearby tests", () => {
  const repo = makeCodingFixture();
  const packet = buildSymbolPacket({ repoRoot: repo, query: "OrderService" });
  assert.ok(packet);
  assert.equal(packet.symbol.name, "OrderService");
  assert.match(packet.definition_slice.text, /authorizePayment/);
  assert.equal(packet.dependencies.includes("OrderRepository"), true);
  assert.equal(packet.nearby_tests.includes("test/orders/OrderService.test.ts"), true);
  assert.equal(packet.coverage.nearby_tests, "covered");
});

test("test neighbor finder maps source files to test style and mocking hints", () => {
  const repo = makeCodingFixture();
  const neighbors = findTestNeighbors({ repoRoot: repo, target: "src/orders/OrderService.ts", symbolName: "OrderService" });
  assert.deepEqual(neighbors.test_files, ["test/orders/OrderService.test.ts"]);
  assert.equal(neighbors.framework_hints.some((hint) => /vitest/.test(hint)), true);
  assert.equal(neighbors.mocking_hints.some((hint) => /vi\.mock|vi\.fn/.test(hint)), true);
  assert.equal(neighbors.coverage.existing_test_neighbor, "covered");
});

test("failure packet extracts compiler and test failure locations", () => {
  const packet = parseFailurePacket({
    output: [
      "src/orders/OrderService.ts(6,12): error TS2304: Cannot find name 'OrderStatus'.",
      "[ERROR] backend/src/main/java/App.java:[12,8] cannot find symbol",
      "File \"pkg/integrations.py\", line 4, in register"
    ].join("\n")
  });
  assert.equal(packet.errors.length, 3);
  assert.equal(packet.failure_kind, "typescript");
  assert.equal(packet.suggested_slices.some((slice) => slice.file === "src/orders/OrderService.ts"), true);
});

test("coding coverage contract prevents early answerability when exact coverage is missing", () => {
  const repo = makeCodingFixture();
  const result = compileCodingCoverageEvidence({
    repoRoot: repo,
    task: "Write unit tests for UnknownBillingService",
    taskType: "write_unittest",
    firstEvidenceIndex: 5,
    hasBuildFacts: true,
    codingToolsAvailable: true
  });
  assert.ok(result);
  assert.equal(result.answerable, false);
  assert.equal(result.coverage.target_symbol, "missing");
  assert.equal(result.metadata.symbol_index_hit, false);
  assert.equal(typeof result.metadata.symbol_index_symbol_count, "number");
  assert.equal(result.contract.metadata.symbol_index_hit, false);
  assert.equal(result.allowedFollowups.some((followup) => followup.tool === "tokenopt_symbols_find"), true);
});

test("coding coverage uses quality rubric anchors for symbol discovery", () => {
  const repo = makeCodingFixture();
  const result = compileCodingCoverageEvidence({
    repoRoot: repo,
    task: "Create an implementation handoff for improving natural benchmark prompt quality.",
    taskType: "implement",
    qualityRubric: [
      'Verify anchor file: "src/benchmark/suite-benchmark.ts"',
      'Verify anchor symbol: "naturalTokenOptCodeGraphPlanLines"',
      'Verify anchor symbol: "naturalTaskWantsTestEvidence"',
      'Verify anchor symbol: "buildSuitePrompt"',
      'Verify anchor file: "test/benchmark/suite-benchmark-metadata.test.ts"'
    ],
    firstEvidenceIndex: 5,
    hasBuildFacts: true,
    codingToolsAvailable: true
  });
  assert.ok(result);
  assert.equal(result.evidence.some((item) =>
    item.facts?.some((fact) => fact.includes("naturalTokenOptCodeGraphPlanLines") && fact.includes("buildSuitePrompt"))
  ), true);
  assert.equal(result.evidence.some((item) =>
    item.files?.some((file) => file === "test/benchmark/suite-benchmark-metadata.test.ts")
  ), true);
});
