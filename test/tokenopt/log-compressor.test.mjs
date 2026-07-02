import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compressText } from "../../dist/tokenopt/log-compressor.js";
import { repoKey } from "../../dist/tokenopt/observability.js";

test("compressor extracts failure signal", () => {
  const result = compressText("FAIL src/example.test.ts\nAssertionError: expected 1 to be 2\n".repeat(50), 2000);
  assert.equal(result.kind, "vitest");
  assert.match(result.text, /AssertionError/);
  assert.ok(result.estimatedTokensSaved > 0);
});

test("compressor recognizes pytest output", () => {
  const result = compressText("FAILED tests/test_api.py::test_create_user - AssertionError\nTraceback (most recent call last):\n".repeat(20), 2000);
  assert.equal(result.kind, "pytest");
  assert.match(result.text, /test_create_user/);
});

test("compressor recognizes TypeScript output", () => {
  const result = compressText("src/index.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n".repeat(20), 2000);
  assert.equal(result.kind, "tsc");
  assert.match(result.text, /TS2322/);
});

test("compressor recognizes ESLint output", () => {
  const result = compressText("src/index.ts:4:10: error  'x' is defined but never used  no-unused-vars\n".repeat(20), 2000);
  assert.equal(result.kind, "eslint");
  assert.match(result.text, /no-unused-vars/);
});

test("compressor falls back to generic output", () => {
  const result = compressText("plain log line\n".repeat(20), 2000);
  assert.equal(result.kind, "generic");
  assert.match(result.text, /plain log line/);
});

test("repo keys differ for unrelated roots", () => {
  assert.notEqual(repoKey(path.join(os.tmpdir(), "repo-a")), repoKey(path.join(os.tmpdir(), "repo-b")));
});
