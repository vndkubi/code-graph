import assert from "node:assert/strict";
import test from "node:test";

import { computeAdaptiveOutputBudget } from "../../dist/tokenopt/budget.js";
import { compressText } from "../../dist/tokenopt/log-compressor.js";

test("adaptive output budget picks output-kind caps under hard ceiling", () => {
  assert.equal(computeAdaptiveOutputBudget({ configuredMaxChars: 16_000, outputKind: "json-result" }).maxChars, 6_000);
  assert.equal(computeAdaptiveOutputBudget({ configuredMaxChars: 16_000, outputKind: "build-log" }).maxChars, 8_000);
  assert.equal(computeAdaptiveOutputBudget({ configuredMaxChars: 16_000, outputKind: "generic" }).maxChars, 10_000);
});

test("adaptive output budget respects explicit and configured ceilings", () => {
  assert.equal(
    computeAdaptiveOutputBudget({ configuredMaxChars: 16_000, outputKind: "build-log", requestedMaxChars: 4_000 }).maxChars,
    4_000
  );
  assert.equal(computeAdaptiveOutputBudget({ configuredMaxChars: 3_000, outputKind: "json-result" }).maxChars, 3_000);
});

test("compressText attaches budget metadata for specialized output", () => {
  const json = JSON.stringify({
    status: "failed",
    errors: Array.from({ length: 500 }, (_, index) => ({ message: `failure ${index}`, reason: "boom" }))
  });
  const compressed = compressText(json, 16_000);

  assert.equal(compressed.kind, "json-result");
  assert.equal(compressed.budget?.maxChars, 6_000);
  assert.equal(compressed.budget?.reason, "output-kind");
});
