import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkflowPrompt,
  formatWorkflowMarkdown,
  freshUsageTokens,
  scoreWorkflowResult,
  totalUsageTokens
} from "../../dist/tokenopt/workflow-ab-benchmark.js";

const feature = {
  id: "token-helper",
  title: "Token helper",
  prompt: "Add a total token helper with tests.",
  qualityRubric: ["total token helper", "targeted validation"]
};

test("workflow A/B prompts encode tokenopt and speckit acquisition rules", () => {
  const baselinePrompt = buildWorkflowPrompt({
    workflow: "baseline",
    feature,
    repo: "/repo",
    worktree: "/repo-baseline",
    testCommand: "npm test"
  });
  assert.match(baselinePrompt, /normal Codex implementation workflow/i);
  assert.doesNotMatch(baselinePrompt, /tokenopt_compile_evidence/);
  assert.match(baselinePrompt, /Do not create Spec Kit artifacts/i);

  const tokenoptPrompt = buildWorkflowPrompt({
    workflow: "tokenopt",
    feature,
    repo: "/repo",
    worktree: "/repo-tokenopt",
    testCommand: "npm test"
  });
  assert.match(tokenoptPrompt, /Use TokenOpt adaptively as a cost gate/i);
  assert.match(tokenoptPrompt, /Bypass TokenOpt/i);
  assert.match(tokenoptPrompt, /tokenopt_compile_evidence/);
  assert.match(tokenoptPrompt, /task_type=implement/);
  assert.match(tokenoptPrompt, /task set only to the text under Feature request/i);
  assert.match(tokenoptPrompt, /do not repeat broad repo exploration/i);
  assert.match(tokenoptPrompt, /npm test/);

  const speckitPrompt = buildWorkflowPrompt({
    workflow: "speckit",
    feature,
    repo: "/repo",
    worktree: "/repo-speckit",
    testCommand: "npm test"
  });
  assert.match(speckitPrompt, /spec-driven workflow/i);
  assert.match(speckitPrompt, /specify the behavior, plan the technical approach, break it into tasks, then implement/i);
  assert.match(speckitPrompt, /specs\/workflow-ab-<feature-id>\/spec\.md/);

  const hybridPrompt = buildWorkflowPrompt({
    workflow: "speckit-tokenopt",
    feature,
    repo: "/repo",
    worktree: "/repo-hybrid",
    testCommand: "npm test"
  });
  assert.match(hybridPrompt, /Spec Kit style spec-driven workflow/i);
  assert.match(hybridPrompt, /TokenOpt only when it replaces broad repository discovery/i);
  assert.match(hybridPrompt, /Bypass TokenOpt/i);
  assert.match(hybridPrompt, /tokenopt_compile_evidence once/);
  assert.match(hybridPrompt, /do not repeat broad shell\/search exploration/i);

  const promptChainPrompt = buildWorkflowPrompt({
    workflow: "tokenopt-prompt-chain",
    feature,
    repo: "/repo",
    worktree: "/repo-prompt-chain",
    testCommand: "npm test"
  });
  assert.match(promptChainPrompt, /requirement-analysis/i);
  assert.match(promptChainPrompt, /pbi-plan/i);
  assert.match(promptChainPrompt, /implement-feature/i);
  assert.match(promptChainPrompt, /tokenopt_prompt_chain_bypass/i);
  assert.match(promptChainPrompt, /task set only to the Feature request text/i);
  assert.match(promptChainPrompt, /Do not create Spec Kit artifacts/i);
});

test("workflow A/B scoring combines validation, diff, and rubric evidence", () => {
  const quality = scoreWorkflowResult({
    feature,
    row: {
      exitCode: 0,
      testsPassed: true,
      changedFiles: ["src/token-estimator.ts", "test/token-estimator.test.mjs"],
      diffShortStat: "2 files changed, 10 insertions(+)",
      finalAnswer: '{"tests_run":["npm test"],"tests_passed":true}',
      workflow: "tokenopt",
      mcpCalls: 1
    },
    diffText: "export function totalUsageTokens() {}\n// total token helper\n// targeted validation"
  });

  assert.equal(quality.score, 1);
  assert.equal(quality.checks.every((check) => check.passed), true);
});

test("workflow A/B scoring does not trust claimed speckit artifacts without diff evidence", () => {
  const quality = scoreWorkflowResult({
    feature,
    row: {
      exitCode: 0,
      testsPassed: true,
      changedFiles: ["src/token-estimator.ts", "test/token-estimator.test.mjs"],
      diffShortStat: "2 files changed, 10 insertions(+)",
      finalAnswer: '{"tests_run":["npm test"],"tests_passed":true,"requirement_coverage":["Spec Kit artifacts created"]}',
      workflow: "speckit",
      mcpCalls: 0
    },
    diffText: "export function totalUsageTokens() {}\n// total token helper\n// targeted validation"
  });

  assert.equal(quality.checks.find((check) => check.name === "speckit_artifacts_created").passed, false);
});

test("workflow A/B scoring accepts hybrid TokenOpt evidence or explicit bypass with real spec artifacts", () => {
  const quality = scoreWorkflowResult({
    feature,
    row: {
      exitCode: 0,
      testsPassed: true,
      changedFiles: [
        "src/token-estimator.ts",
        "test/token-estimator.test.mjs",
        "specs/workflow-ab-token-helper/spec.md"
      ],
      diffShortStat: "3 files changed, 20 insertions(+)",
      finalAnswer: '{"tests_run":["npm test"],"tests_passed":true}',
      workflow: "speckit-tokenopt",
      mcpCalls: 1
    },
    diffText: "export function totalUsageTokens() {}\n// total token helper\n// targeted validation"
  });

  assert.equal(quality.checks.find((check) => check.name === "speckit_artifacts_created").passed, true);
  assert.equal(quality.checks.find((check) => check.name === "hybrid_followed_tokenopt_policy").passed, true);

  const bypassQuality = scoreWorkflowResult({
    feature,
    row: {
      exitCode: 0,
      testsPassed: true,
      changedFiles: [
        "src/token-estimator.ts",
        "test/token-estimator.test.mjs",
        "specs/workflow-ab-token-helper/spec.md"
      ],
      diffShortStat: "3 files changed, 20 insertions(+)",
      finalAnswer: '{"acquisition_mode":"speckit_tokenopt_bypass","tests_run":["npm test"],"tests_passed":true}',
      workflow: "speckit-tokenopt",
      mcpCalls: 0
    },
    diffText: "export function totalUsageTokens() {}\n// total token helper\n// targeted validation"
  });
  assert.equal(bypassQuality.checks.find((check) => check.name === "hybrid_followed_tokenopt_policy").passed, true);
});

test("workflow A/B markdown reports token deltas", () => {
  const baseRow = {
    repo: "/repo",
    worktree: "/worktree",
    baseCommit: "abc123",
    featureId: feature.id,
    prompt: "prompt",
    exitCode: 0,
    durationMs: 100,
    finalAnswer: "{}",
    usageStatus: "completed",
    toolCalls: 1,
    shellCalls: 1,
    mcpCalls: 0,
    toolInputChars: 1,
    toolOutputChars: 1,
    warnings: 0,
    rawLogPath: "/raw.jsonl",
    lastMessagePath: "/last.txt",
    testCommand: "npm test",
    testExitCode: 0,
    testDurationMs: 10,
    testOutputPath: "/test.txt",
    testsPassed: true,
    changedFiles: ["src/a.ts"],
    validationGeneratedFiles: [],
    diffShortStat: "1 file changed",
    diffStat: "src/a.ts | 1 +",
    diffPath: "/diff.patch",
    qualityScore: 1,
    qualityChecks: "7/7",
    qualityPassed: true,
    qualityDetails: [{ name: "tests_passed", passed: true }]
  };
  const markdown = formatWorkflowMarkdown(feature, [
    {
      ...baseRow,
      workflow: "baseline",
      usage: { input_tokens: 300, cached_input_tokens: 30, output_tokens: 60, reasoning_output_tokens: 90 }
    },
    {
      ...baseRow,
      workflow: "tokenopt",
      usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 30 }
    },
    {
      ...baseRow,
      workflow: "speckit",
      usage: { input_tokens: 200, cached_input_tokens: 20, output_tokens: 40, reasoning_output_tokens: 60 }
    }
  ]);

  assert.equal(totalUsageTokens({ input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 30 }), 150);
  assert.equal(freshUsageTokens({ input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 30 }), 140);
  assert.match(markdown, /Compared to baseline/);
  assert.match(markdown, /Raw total tokens: tokenopt=150, baseline=450, tokenopt saved 66\.7% vs baseline/);
  assert.match(markdown, /Fresh total tokens: tokenopt=140, baseline=420, tokenopt saved 66\.7% vs baseline/);
  assert.match(markdown, /Raw total tokens: tokenopt=150, speckit=300, tokenopt saved 50\.0% vs speckit/);
  assert.match(markdown, /Quality delta: tokenopt 1\.000 vs speckit 1\.000/);
});
