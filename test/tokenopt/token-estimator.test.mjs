import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateTokenDetails,
  estimateTokens,
  estimateTokensSaved,
  TOKEN_ESTIMATOR_VERSION,
  totalUsageTokens
} from "../../dist/tokenopt/token-estimator.js";

test("token estimator uses centralized ratio metadata", () => {
  const text = "const answer: number = 42;";
  const details = estimateTokenDetails(text, { kind: "typescript" });

  assert.equal(details.estimator, TOKEN_ESTIMATOR_VERSION);
  assert.equal(details.kind, "typescript");
  assert.equal(details.chars, text.length);
  assert.equal(details.ratio, 3.7);
  assert.equal(details.tokens, Math.ceil(text.length / 3.7));
});

test("token estimator supports language-specific ratios and zero savings", () => {
  assert.equal(estimateTokens(180, { kind: "vietnamese" }), 100);
  assert.equal(estimateTokens(208, { kind: "json" }), 40);
  assert.equal(estimateTokensSaved(1000, 480, { kind: "json" }), 100);
  assert.equal(estimateTokensSaved(100, 120), 0);
});

test("usage total sums billed token fields", () => {
  assert.equal(totalUsageTokens({
    input_tokens: 100,
    output_tokens: 25,
    reasoning_output_tokens: 7
  }), 132);
});

test("usage total excludes cached input tokens", () => {
  assert.equal(totalUsageTokens({
    input_tokens: 100,
    output_tokens: 25,
    reasoning_output_tokens: 7,
    cached_input_tokens: 90
  }), 132);
});
