import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { freshUsageTokens, totalUsageTokens } from "./token-estimator.js";

export { freshUsageTokens, totalUsageTokens };

type WorkflowMode = "baseline" | "tokenopt" | "speckit" | "speckit-tokenopt" | "tokenopt-prompt-chain" | "speckit-gate-first" | "speckit-compact";
type UsageStatus = "completed" | "timeout" | "missing";
type McpMode = "lite" | "full";

interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

interface CodexRunMetrics {
  exitCode: number | null;
  durationMs: number;
  finalAnswer: string;
  usage: CodexUsage;
  usageStatus: UsageStatus;
  toolCalls: number;
  shellCalls: number;
  mcpCalls: number;
  toolInputChars: number;
  toolOutputChars: number;
  warnings: number;
  rawLogPath: string;
  lastMessagePath: string;
}

interface WorkflowFeature {
  id: string;
  title: string;
  prompt: string;
  qualityRubric: string[];
  testCommand?: string;
}

interface WorkflowBenchmarkOptions {
  repo: string;
  workflows: WorkflowMode[];
  feature: WorkflowFeature;
  baseRef: string;
  rawDir: string;
  codexPackage: string;
  timeoutMs: number;
  validationTimeoutMs: number;
  outPath?: string;
  markdownPath?: string;
  json: boolean;
  showAnswers: boolean;
  model?: string;
  testCommand?: string;
  mcpMode: McpMode;
}

interface WorkflowQualityCheck {
  name: string;
  passed: boolean;
}

interface WorkflowQualityResult {
  score: number;
  passed: number;
  total: number;
  checks: WorkflowQualityCheck[];
}

interface WorkflowBenchmarkRow extends CodexRunMetrics {
  workflow: WorkflowMode;
  repo: string;
  worktree: string;
  baseCommit: string;
  featureId: string;
  prompt: string;
  testCommand?: string;
  testExitCode: number | null;
  testDurationMs: number;
  testOutputPath: string;
  testsPassed: boolean;
  changedFiles: string[];
  validationGeneratedFiles: string[];
  diffShortStat: string;
  diffStat: string;
  diffPath: string;
  qualityScore: number;
  qualityChecks: string;
  qualityPassed: boolean;
  qualityDetails: WorkflowQualityCheck[];
}

const CODEX_PACKAGE = "@openai/codex@0.137.0";
const WORKFLOWS: WorkflowMode[] = ["baseline", "tokenopt", "speckit", "speckit-tokenopt", "speckit-gate-first", "speckit-compact"];

export async function runWorkflowAbBenchmarkCommand(args: string[]): Promise<number> {
  // dry-run: print prompts without running Codex
  if (args.includes("--dry-run")) {
    const options = parseOptions(args.filter((a) => a !== "--dry-run"));
    for (const workflow of options.workflows) {
      const prompt = buildWorkflowPrompt({ workflow, feature: options.feature, repo: options.repo, worktree: options.repo, testCommand: options.testCommand });
      process.stdout.write(`\n${"=".repeat(60)}\n[${workflow}] ${prompt.split("\n").length} lines, ~${Math.round(prompt.length / 4)} tokens est\n${"=".repeat(60)}\n${prompt}\n`);
    }
    return 0;
  }

  const options = parseOptions(args);
  const baseCommit = gitOutput(options.repo, ["rev-parse", options.baseRef]).trim();
  fs.mkdirSync(options.rawDir, { recursive: true });

  const rows: WorkflowBenchmarkRow[] = [];
  for (const workflow of options.workflows) {
    const row = runWorkflow(options, workflow, baseCommit);
    rows.push(row);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    runner: "codex exec --json",
    codexPackage: options.codexPackage,
    repo: options.repo,
    baseRef: options.baseRef,
    baseCommit,
    feature: options.feature,
    workflows: options.workflows,
    rows: options.showAnswers ? rows : rows.map((row) => ({ ...row, finalAnswer: undefined, prompt: undefined }))
  };

  if (options.outPath) {
    fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
    fs.writeFileSync(options.outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
  if (options.markdownPath) {
    fs.mkdirSync(path.dirname(options.markdownPath), { recursive: true });
    fs.writeFileSync(options.markdownPath, formatWorkflowMarkdown(options.feature, rows, options), "utf8");
  }

  process.stdout.write(options.json ? `${JSON.stringify(payload, null, 2)}\n` : formatWorkflowRows(rows, options.showAnswers));
  return rows.some((row) => row.exitCode !== 0 || !row.testsPassed || !row.qualityPassed) ? 1 : 0;
}

export function buildWorkflowPrompt(input: {
  workflow: WorkflowMode;
  feature: WorkflowFeature;
  repo: string;
  worktree: string;
  testCommand?: string;
}): string {
  const testCommand = input.testCommand ?? input.feature.testCommand;
  const outputContract = [
    "Return compact JSON only with:",
    "{",
    '  "workflow": "baseline|tokenopt|speckit|speckit-tokenopt|tokenopt-prompt-chain",',
    '  "acquisition_mode": "native_bounded|tokenopt_bypass|tokenopt_mcp|speckit|speckit_tokenopt_bypass|speckit_tokenopt_mcp|speckit_gate_first_mcp|speckit_compact_mcp|tokenopt_prompt_chain_bypass|tokenopt_prompt_chain_mcp",',
    '  "changed_files": [],',
    '  "tests_run": [],',
    '  "tests_passed": true,',
    '  "requirement_coverage": [],',
    '  "edge_case_coverage": [],',
    '  "risks": []',
    "}"
  ].join("\n");
  const common = [
    "Implement one scoped feature in this isolated benchmark worktree.",
    `Repository root: ${input.worktree}`,
    `Feature id: ${input.feature.id}`,
    `Feature title: ${input.feature.title}`,
    "",
    "Feature request:",
    input.feature.prompt.trim(),
    "",
    "Implementation constraints:",
    "- Keep edits minimal and compatible with existing behavior.",
    "- Add or update targeted tests when the feature is testable.",
    "- Do not change generated benchmark artifacts outside the repository worktree.",
    testCommand ? `- Run this validation command before final answer: ${testCommand}` : "- Run the narrowest relevant validation command before final answer.",
    "- If validation cannot run, explain the blocker in risks.",
    "",
    "Quality rubric:",
    ...input.feature.qualityRubric.map((item) => `- ${item}`),
    "",
    outputContract
  ];

  if (input.workflow === "baseline") {
    return [
      "Workflow: baseline",
      "",
      "Use the normal Codex implementation workflow with standard tools.",
      "Do not use TokenOpt MCP instructions and do not follow Spec Kit phases unless the repository itself requires them.",
      "Do not create Spec Kit artifacts for this baseline run; implement the requested code change directly with bounded exploration and targeted validation.",
      "",
      ...common
    ].join("\n");
  }

  if (input.workflow === "tokenopt") {
    return [
      "Workflow: tokenopt",
      "",
      "Use TokenOpt adaptively as a cost gate, not as mandatory overhead.",
      "Before any MCP call, classify whether TokenOpt will replace broad exploration or add an extra hop.",
      "Bypass TokenOpt and set acquisition_mode=tokenopt_bypass when the task is exact/small: the owning module, command, class, file family, or validation test is already clear; expected edits look limited to one or two source/test areas; and native bounded search/read is enough.",
      "Use native bounded shell/search/read directly for a bypassed exact/small task. Keep exploration tight and avoid repo-wide scans.",
      "Call tokenopt_compile_evidence only when the task needs broad repository discovery, business/domain synthesis, unknown ownership, or cross-module impact analysis.",
      "When calling tokenopt_compile_evidence, pass task_type=implement, cwd set to the repository root, budget_tokens around 1200, and task set only to the text under Feature request. Do not include this benchmark wrapper, quality rubric, test command, or output contract in the MCP task.",
      "If the packet is answerable, implement from the packet and do not repeat broad repo exploration.",
      "If the packet has missing exact evidence, use only the allowed narrow follow-up reads/searches for named files, symbols, tests, or commands.",
      "After ownership is known, edit only the narrow files required and run targeted validation.",
      "",
      ...common
    ].join("\n");
  }

  if (input.workflow === "speckit-tokenopt") {
    return [
      "Workflow: speckit-tokenopt",
      "",
      "Use a Spec Kit style spec-driven workflow, with TokenOpt only when it replaces broad repository discovery.",
      "Phase 1 - specify: write concise local spec artifacts for the requested behavior before editing code.",
      "Phase 2 - plan: decide whether TokenOpt is useful. Bypass TokenOpt and set acquisition_mode=speckit_tokenopt_bypass when the spec points to an exact/small implementation surface and native bounded search/read is cheaper.",
      "If TokenOpt is useful, call tokenopt_compile_evidence once with task_type=implement, cwd set to the repository root, budget_tokens around 1200, and task set only to the text under Feature request. Do not include this benchmark wrapper, quality rubric, test command, or output contract in the MCP task.",
      "Phase 3 - tasks: derive implementation tasks from the spec plus either TokenOpt packet facts or the bounded native evidence used for bypass. If the packet is answerable, do not repeat broad shell/search exploration.",
      "Phase 4 - implement: edit only exact files/symbols/tests from the plan, then run targeted validation.",
      "Create local spec artifacts under specs/workflow-ab-<feature-id>/spec.md, plan.md, and tasks.md unless equivalent artifacts already exist.",
      "",
      ...common
    ].join("\n");
  }

  if (input.workflow === "speckit-gate-first") {
    return [
      "Workflow: speckit-gate-first",
      "",
      "Use a ContextGate-first spec-driven workflow. Evidence acquisition happens BEFORE specification, not during it.",
      "",
      "Phase 0 - evidence (MUST run first, before any spec writing):",
      "  Call contextgate_get_context once with the full Feature request text as the task and task_type=implement.",
      "  Do NOT grep, read, or shell-explore the repository before this call.",
      "  If the packet is answerable, proceed to Phase 1 using only packet facts.",
      "  If the packet has missing slots, fill ONLY the exact named files/symbols listed in allowed_followups — no broad search.",
      "",
      "Phase 1 - specify (from packet, not from exploration):",
      "  Write specs/workflow-ab-<feature-id>/spec.md using evidence from the packet.",
      "  Include: WHAT (behavior), WHERE (exact files/symbols from packet), HOW (approach), acceptance criteria, risks.",
      "  Do not run additional shell commands to discover information already in the packet.",
      "",
      "Phase 2 - plan (from spec + packet):",
      "  Write specs/workflow-ab-<feature-id>/plan.md with exact target files, symbols, test changes.",
      "  Source only from spec.md and the packet — no new discovery.",
      "",
      "Phase 3 - tasks:",
      "  Write specs/workflow-ab-<feature-id>/tasks.md as a numbered checklist derived from the plan.",
      "",
      "Phase 4 - implement:",
      "  Edit only the exact files listed in plan.md. Do not re-explore.",
      "",
      "Phase 5 - validate:",
      "  Run the configured validation command.",
      "",
      ...common
    ].join("\n");
  }

  if (input.workflow === "speckit-compact") {
    return [
      "Workflow: speckit-compact",
      "",
      "Use a ContextGate-first compact workflow: evidence first, single inline specplan, then implement.",
      "No separate spec/plan/tasks files are written to disk — produce a single specplan block, then implement directly.",
      "",
      "Phase 0 - evidence (MUST run first):",
      "  Call contextgate_get_context once with the full Feature request text as the task and task_type=implement.",
      "  Do NOT grep, read, or shell-explore the repository before this call.",
      "  If answerable, skip directly to Phase 2 — no specplan needed when evidence is complete.",
      "  If missing slots, fill ONLY the exact named files/symbols from allowed_followups.",
      "",
      "Phase 1 - specplan (inline, not written to disk):",
      "  Output a compact specplan block in your reasoning (NOT as a file write):",
      "  SPECPLAN:",
      "    what: <single line behavior>",
      "    files: <exact files from packet>",
      "    tests: <exact test files from packet>",
      "    tasks:",
      "      - <concrete edit step>",
      "      - ...",
      "  Keep it under 15 lines total. Do not write spec.md, plan.md, or tasks.md.",
      "",
      "Phase 2 - implement:",
      "  Edit only the exact files listed in the specplan/packet.",
      "  Do not re-explore or run broad searches.",
      "",
      "Phase 3 - validate:",
      "  Run the configured validation command.",
      "",
      ...common
    ].join("\n");
  }

  if (input.workflow === "tokenopt-prompt-chain") {
    return [
      "Workflow: tokenopt-prompt-chain",
      "",
      "Use the TokenOpt native prompt-pack workflow in three compact phases, then implement the feature in this same run.",
      "Phase 1 - investigate-pbi / requirement-analysis:",
      "- Analyze the Feature request into WHAT, WHY, HOW, acceptance criteria, impacted areas, tests, and unknowns.",
      "- If the requirement text is missing, stop and ask for it. In this benchmark the Feature request is the concrete requirement artifact.",
      "Phase 2 - pbi-plan:",
      "- Create a compatibility-preserving implementation plan with impacted areas, target files, tests, compatibility risks, and missing items.",
      "Phase 3 - implement-feature:",
      "- Implement the smallest safe code change only after the plan identifies target files.",
      "- Add or update targeted tests and run the configured validation command.",
      "",
      "TokenOpt routing:",
      "- Choose the cheapest evidence path first.",
      "- If the owning command/module/file family is clear from the PBI, bypass MCP-first and set acquisition_mode=tokenopt_prompt_chain_bypass.",
      "- If ownership is unknown or broad cross-module evidence is needed, call tokenopt_compile_evidence once with task_type=implement, cwd set to the repository root, budget_tokens around 1200, and task set only to the Feature request text.",
      "- Do not use TokenOpt first and then repeat the same evidence acquisition with broad shell/search/read.",
      "- Keep followups exact and bounded.",
      "",
      "Do not create Spec Kit artifacts for this prompt-chain run.",
      "",
      ...common
    ].join("\n");
  }

  return [
    "Workflow: speckit",
    "",
    "Use a Spec Kit style spec-driven workflow before implementation.",
    "Follow the phases: specify the behavior, plan the technical approach, break it into tasks, then implement.",
    "Create lightweight local spec artifacts for this feature when the repository does not already contain Spec Kit artifacts: specs/workflow-ab-<feature-id>/spec.md, plan.md, and tasks.md.",
    "Keep the artifacts concise, trace implementation and tests back to the spec, then execute the implementation tasks.",
    "",
    ...common
  ].join("\n");
}

export function scoreWorkflowResult(input: {
  feature: WorkflowFeature;
  row: Pick<WorkflowBenchmarkRow, "exitCode" | "testsPassed" | "changedFiles" | "diffShortStat" | "finalAnswer" | "workflow" | "mcpCalls">;
  diffText: string;
}): WorkflowQualityResult {
  const combined = `${input.row.finalAnswer}\n${input.diffText}\n${input.row.changedFiles.join("\n")}`;
  const checks: WorkflowQualityCheck[] = [
    { name: "codex_exit_zero", passed: input.row.exitCode === 0 },
    { name: "tests_passed", passed: input.row.testsPassed },
    { name: "changed_files_present", passed: input.row.changedFiles.length > 0 },
    { name: "diff_non_empty", passed: input.row.diffShortStat.trim().length > 0 },
    { name: "final_answer_mentions_tests", passed: /\b(tests?_run|tests?_passed|validation|test)\b/i.test(input.row.finalAnswer) }
  ];
  if (input.row.workflow === "speckit" || input.row.workflow === "speckit-tokenopt" || input.row.workflow === "speckit-gate-first") {
    checks.push({ name: "speckit_artifacts_created", passed: input.row.changedFiles.some((file) => /^specs\/workflow-ab-[^/]+\/(?:spec|plan|tasks)\.md$/i.test(file.replace(/\\/g, "/"))) });
  }
  if (input.row.workflow === "speckit-tokenopt") {
    checks.push({ name: "hybrid_followed_tokenopt_policy", passed: input.row.mcpCalls > 0 || /"acquisition_mode"\s*:\s*"speckit_tokenopt_bypass"/i.test(input.row.finalAnswer) });
  }
  if (input.row.workflow === "speckit-gate-first" || input.row.workflow === "speckit-compact") {
    checks.push({ name: "gate_called_first", passed: input.row.mcpCalls > 0 });
  }
  for (const item of input.feature.qualityRubric) {
    const validationPassed = /\b(validation|validate|passes?|passed)\b/i.test(item) && input.row.testsPassed;
    const testFileUpdated = /\b(updates?|updated|adds?|added).*\btests?\b|\btests?.*\b(updates?|updated|adds?|added)\b/i.test(item) &&
      input.row.changedFiles.some((file) => /(?:^|\/|\\)(?:test|tests)\//i.test(file.replace(/\\/g, "/")) || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(file));
    checks.push({ name: `rubric:${item}`, passed: validationPassed || testFileUpdated || rubricMatches(combined, item) });
  }
  const passed = checks.filter((check) => check.passed).length;
  const total = checks.length || 1;
  return {
    score: Number((passed / total).toFixed(3)),
    passed,
    total,
    checks
  };
}

export function formatWorkflowMarkdown(feature: WorkflowFeature, rows: WorkflowBenchmarkRow[], options?: { showAnswers?: boolean; mcpMode?: McpMode; validationTimeoutMs?: number }): string {
  const lines: string[] = [
    "# Workflow A/B Benchmark",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Feature: ${feature.id} - ${feature.title}`,
    ...(options ? [`MCP mode: ${options.mcpMode ?? "n/a"}`, `Validation timeout: ${options.validationTimeoutMs ?? "n/a"} ms`] : []),
    "",
    "## Summary",
    "",
    formatMarkdownTable(
      ["Workflow", "Quality", "Tests", "Usage", "Input", "Cached", "Output", "Reasoning", "Raw Total", "Fresh Total", "Tool", "MCP", "Shell", "Changed", "Generated", "Duration"],
      rows.map((row) => [
        row.workflow,
        `${row.qualityScore.toFixed(3)} (${row.qualityChecks})`,
        row.testsPassed ? "pass" : "fail",
        row.usageStatus,
        formatUsageValue(row, row.usage.input_tokens),
        formatUsageValue(row, row.usage.cached_input_tokens),
        formatUsageValue(row, row.usage.output_tokens),
        formatUsageValue(row, row.usage.reasoning_output_tokens),
        formatUsageValue(row, totalUsageTokens(row.usage)),
        formatUsageValue(row, freshUsageTokens(row.usage)),
        String(row.toolCalls),
        String(row.mcpCalls),
        String(row.shellCalls),
        String(row.changedFiles.length),
        String(row.validationGeneratedFiles.length),
        String(row.durationMs)
      ])
    ),
    "",
    "## Token Comparison",
    "",
    ...formatTokenComparison(rows),
    "",
    "## Runs",
    ""
  ];

  for (const row of rows) {
    lines.push(
      `### ${row.workflow}`,
      "",
      `- Worktree: ${row.worktree}`,
      `- Raw log: ${row.rawLogPath}`,
      `- Last message: ${row.lastMessagePath}`,
      `- Diff: ${row.diffPath}`,
      `- Test output: ${row.testOutputPath}`,
      `- Diff stat: ${row.diffShortStat || "(no diff)"}`,
      `- Test command: ${row.testCommand ?? "(not configured)"}`,
      `- Test exit: ${row.testExitCode}`,
      `- Usage status: ${row.usageStatus}`,
      "",
      "Quality checks:",
      ...row.qualityDetails.map((check) => `- ${check.passed ? "pass" : "fail"}: ${check.name}`),
      "",
      "Changed files:",
      ...(row.changedFiles.length > 0 ? row.changedFiles.map((file) => `- ${file}`) : ["- (none)"]),
      "",
      "Validation-generated files:",
      ...(row.validationGeneratedFiles.length > 0 ? row.validationGeneratedFiles.map((file) => `- ${file}`) : ["- (none)"]),
      ""
    );
    if (options?.showAnswers) {
      lines.push("Final answer:", "", "```json", row.finalAnswer.trim(), "```", "");
    }
  }

  return `${lines.join("\n")}\n`;
}

function runWorkflow(options: WorkflowBenchmarkOptions, workflow: WorkflowMode, baseCommit: string): WorkflowBenchmarkRow {
  const worktree = path.join(options.rawDir, "worktrees", workflow);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  gitOutput(options.repo, ["worktree", "add", "--detach", worktree, baseCommit]);

  const prompt = buildWorkflowPrompt({
    workflow,
    feature: options.feature,
    repo: options.repo,
    worktree,
    testCommand: options.testCommand
  });
  const run = runCodex(worktree, workflow, options, prompt);
  const trackedDiffText = gitOutput(worktree, ["diff", baseCommit]);
  const untrackedFiles = listUntrackedFiles(worktree);
  const diffText = buildDiffWithUntracked(worktree, trackedDiffText, untrackedFiles);
  const diffPath = path.join(options.rawDir, `${workflow}-diff.patch`);
  fs.writeFileSync(diffPath, diffText, "utf8");
  const changedFiles = [...new Set([...listTrackedChangedFiles(worktree, baseCommit), ...untrackedFiles])];
  const diffShortStat = withUntrackedSummary(gitOutput(worktree, ["diff", "--shortstat", baseCommit]).trim(), untrackedFiles);
  const diffStat = withUntrackedSummary(gitOutput(worktree, ["diff", "--stat", baseCommit]).trim(), untrackedFiles);
  const test = runValidation(worktree, options.testCommand ?? options.feature.testCommand, workflow, options.rawDir, options.validationTimeoutMs);
  const postValidationChangedFiles = listChangedFiles(worktree, baseCommit);
  const validationGeneratedFiles = postValidationChangedFiles.filter((file) => !changedFiles.includes(file));

  const partial = {
    ...run,
    workflow,
    repo: options.repo,
    worktree,
    baseCommit,
    featureId: options.feature.id,
    prompt,
    testCommand: options.testCommand ?? options.feature.testCommand,
    testExitCode: test.exitCode,
    testDurationMs: test.durationMs,
    testOutputPath: test.outputPath,
    testsPassed: test.exitCode === 0,
    changedFiles,
    validationGeneratedFiles,
    diffShortStat,
    diffStat,
    diffPath
  };
  const quality = scoreWorkflowResult({
    feature: options.feature,
    row: partial,
    diffText
  });
  return {
    ...partial,
    qualityScore: quality.score,
    qualityChecks: `${quality.passed}/${quality.total}`,
    qualityPassed: quality.score >= 0.8,
    qualityDetails: quality.checks
  };
}

function runCodex(
  worktree: string,
  workflow: WorkflowMode,
  options: Pick<WorkflowBenchmarkOptions, "codexPackage" | "timeoutMs" | "model" | "rawDir" | "mcpMode">,
  prompt: string
): CodexRunMetrics {
  const start = Date.now();
  const rawLogPath = path.join(options.rawDir, `${workflow}-codex.jsonl`);
  const lastMessagePath = path.join(options.rawDir, `${workflow}-last.txt`);
  const args = [
    "-y",
    options.codexPackage,
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "-C",
    worktree,
    "-o",
    lastMessagePath,
    "--color",
    "never"
  ];
  if (options.model) {
    args.push("-m", options.model);
  }
  if (workflow === "tokenopt" || workflow === "speckit-tokenopt" || workflow === "tokenopt-prompt-chain" || workflow === "speckit-gate-first" || workflow === "speckit-compact") {
    args.push(
      "-c",
      "mcp_servers.tokenopt.command='node'",
      "-c",
      `mcp_servers.tokenopt.args=['${slash(path.join(process.cwd(), "dist", "cli.js"))}','mcp','--mode','${options.mcpMode}']`
    );
  }
  args.push("-");

  const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", args, {
    cwd: worktree,
    encoding: "utf8",
    input: prompt,
    maxBuffer: 128 * 1024 * 1024,
    timeout: options.timeoutMs,
    shell: process.platform === "win32"
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const spawnError = result.error ? `\n--- SPAWN ERROR ---\n${String(result.error)}` : "";
  fs.writeFileSync(rawLogPath, `${stdout}${stderr ? `\n--- STDERR ---\n${stderr}` : ""}${spawnError}`, "utf8");
  const parsed = parseCodexJsonl(stdout);
  const fileAnswer = fs.existsSync(lastMessagePath) ? fs.readFileSync(lastMessagePath, "utf8").trim() : "";
  const timedOut = Boolean(result.error && /ETIMEDOUT|timed out/i.test(String(result.error)));
  return {
    exitCode: result.status,
    durationMs: Date.now() - start,
    finalAnswer: fileAnswer || parsed.finalAnswer,
    usage: parsed.usage,
    usageStatus: parsed.usageCompleted ? "completed" : timedOut ? "timeout" : "missing",
    toolCalls: parsed.toolCalls,
    shellCalls: parsed.shellCalls,
    mcpCalls: parsed.mcpCalls,
    toolInputChars: parsed.toolInputChars,
    toolOutputChars: parsed.toolOutputChars,
    warnings: parsed.warnings + stderr.split(/\r?\n/).filter((line) => line.trim()).length + (result.error ? 1 : 0),
    rawLogPath,
    lastMessagePath
  };
}

function runValidation(cwd: string, command: string | undefined, workflow: WorkflowMode, rawDir: string, timeoutMs: number): {
  exitCode: number | null;
  durationMs: number;
  outputPath: string;
} {
  const outputPath = path.join(rawDir, `${workflow}-test-output.txt`);
  if (!command) {
    fs.writeFileSync(outputPath, "No validation command configured.\n", "utf8");
    return { exitCode: 0, durationMs: 0, outputPath };
  }
  const start = Date.now();
  const result = spawnSync(command, {
    cwd,
    encoding: "utf8",
    shell: true,
    maxBuffer: 128 * 1024 * 1024,
    timeout: timeoutMs
  });
  fs.writeFileSync(outputPath, `${result.stdout ?? ""}${result.stderr ? `\n--- STDERR ---\n${result.stderr}` : ""}${result.error ? `\n--- ERROR ---\n${String(result.error)}` : ""}`, "utf8");
  return { exitCode: result.status, durationMs: Date.now() - start, outputPath };
}

function parseOptions(args: string[]): WorkflowBenchmarkOptions {
  let repo = process.cwd();
  let workflows: WorkflowMode[] = WORKFLOWS;
  let featureFile: string | undefined;
  let featureText: string | undefined;
  let featureId = "workflow-ab-feature";
  let featureTitle = "Workflow A/B feature";
  let testCommand: string | undefined;
  let baseRef = "HEAD";
  let codexPackage = CODEX_PACKAGE;
  let timeoutMs = 600_000;
  let validationTimeoutMs = 300_000;
  let outPath: string | undefined;
  let markdownPath: string | undefined;
  let rawDir = path.resolve("benchmark-results", `workflow-ab-${Date.now()}`);
  let json = false;
  let showAnswers = false;
  let model: string | undefined;
  let mcpMode: McpMode = "lite";
  const qualityRubric: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      repo = path.resolve(requireValue(args, index, "--repo"));
      index += 1;
      continue;
    }
    if (arg === "--workflow" || arg === "--workflows") {
      workflows = requireValue(args, index, arg).split(",").map(parseWorkflow);
      index += 1;
      continue;
    }
    if (arg === "--feature-file") {
      featureFile = path.resolve(requireValue(args, index, "--feature-file"));
      index += 1;
      continue;
    }
    if (arg === "--feature") {
      featureText = requireValue(args, index, "--feature");
      index += 1;
      continue;
    }
    if (arg === "--feature-id") {
      featureId = safeName(requireValue(args, index, "--feature-id"));
      index += 1;
      continue;
    }
    if (arg === "--title") {
      featureTitle = requireValue(args, index, "--title");
      index += 1;
      continue;
    }
    if (arg === "--quality") {
      qualityRubric.push(requireValue(args, index, "--quality"));
      index += 1;
      continue;
    }
    if (arg === "--test-command") {
      testCommand = requireValue(args, index, "--test-command");
      index += 1;
      continue;
    }
    if (arg === "--base-ref") {
      baseRef = requireValue(args, index, "--base-ref");
      index += 1;
      continue;
    }
    if (arg === "--codex-package") {
      codexPackage = requireValue(args, index, "--codex-package");
      index += 1;
      continue;
    }
    if (arg === "--model") {
      model = requireValue(args, index, "--model");
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = Number.parseInt(requireValue(args, index, "--timeout-ms"), 10);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("--timeout-ms must be a positive integer");
      }
      index += 1;
      continue;
    }
    if (arg === "--validation-timeout-ms") {
      validationTimeoutMs = Number.parseInt(requireValue(args, index, "--validation-timeout-ms"), 10);
      if (!Number.isFinite(validationTimeoutMs) || validationTimeoutMs <= 0) {
        throw new Error("--validation-timeout-ms must be a positive integer");
      }
      index += 1;
      continue;
    }
    if (arg === "--mcp-mode") {
      mcpMode = parseMcpMode(requireValue(args, index, "--mcp-mode"));
      index += 1;
      continue;
    }
    if (arg === "--raw-dir") {
      rawDir = path.resolve(requireValue(args, index, "--raw-dir"));
      index += 1;
      continue;
    }
    if (arg === "--out") {
      outPath = path.resolve(requireValue(args, index, "--out"));
      index += 1;
      continue;
    }
    if (arg === "--markdown") {
      markdownPath = path.resolve(requireValue(args, index, "--markdown"));
      index += 1;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--show-answers") {
      showAnswers = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new Error(workflowBenchmarkHelp());
    }
    throw new Error(`Unknown workflow A/B benchmark argument: ${arg}`);
  }

  const fileFeature = featureFile ? readFeatureFile(featureFile) : undefined;
  const feature: WorkflowFeature = fileFeature ?? {
    id: featureId,
    title: featureTitle,
    prompt: featureText ?? "",
    qualityRubric,
    testCommand
  };
  if (featureText && fileFeature) {
    feature.prompt = featureText;
  }
  if (qualityRubric.length > 0 && fileFeature) {
    feature.qualityRubric = qualityRubric;
  }
  if (testCommand) {
    feature.testCommand = testCommand;
  }
  if (!feature.prompt.trim()) {
    throw new Error("--feature or --feature-file is required");
  }
  if (feature.qualityRubric.length === 0) {
    feature.qualityRubric = ["implements requested behavior", "has targeted validation", "keeps compatibility risks explicit"];
  }

  return {
    repo,
    workflows,
    feature,
    baseRef,
    rawDir,
    codexPackage,
    timeoutMs,
    validationTimeoutMs,
    outPath,
    markdownPath,
    json,
    showAnswers,
    model,
    testCommand,
    mcpMode
  };
}

function readFeatureFile(filePath: string): WorkflowFeature {
  const content = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  if (filePath.endsWith(".json") || content.trim().startsWith("{")) {
    const parsed = JSON.parse(content) as Partial<WorkflowFeature>;
    if (typeof parsed.prompt !== "string" || !parsed.prompt.trim()) {
      throw new Error("feature JSON must include a non-empty prompt");
    }
    return {
      id: safeName(parsed.id ?? path.basename(filePath, path.extname(filePath))),
      title: parsed.title ?? parsed.id ?? path.basename(filePath),
      prompt: parsed.prompt,
      qualityRubric: Array.isArray(parsed.qualityRubric) ? parsed.qualityRubric.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [],
      testCommand: parsed.testCommand
    };
  }
  return {
    id: safeName(path.basename(filePath, path.extname(filePath))),
    title: path.basename(filePath),
    prompt: content,
    qualityRubric: []
  };
}

function parseCodexJsonl(text: string): {
  finalAnswer: string;
  usage: CodexUsage;
  usageCompleted: boolean;
  toolCalls: number;
  shellCalls: number;
  mcpCalls: number;
  toolInputChars: number;
  toolOutputChars: number;
  warnings: number;
} {
  let finalAnswer = "";
  let usage: CodexUsage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  let usageCompleted = false;
  let toolCalls = 0;
  let shellCalls = 0;
  let mcpCalls = 0;
  let toolInputChars = 0;
  let toolOutputChars = 0;
  let warnings = 0;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (!trimmed.startsWith("{")) {
      warnings += 1;
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(trimmed) as unknown;
    } catch {
      warnings += 1;
      continue;
    }
    if (!isRecord(event)) {
      continue;
    }
    if (event.type === "turn.completed" && isRecord(event.usage)) {
      usageCompleted = true;
      usage = {
        input_tokens: numberValue(event.usage.input_tokens),
        cached_input_tokens: numberValue(event.usage.cached_input_tokens),
        output_tokens: numberValue(event.usage.output_tokens),
        reasoning_output_tokens: numberValue(event.usage.reasoning_output_tokens)
      };
    }
    if (event.type === "item.completed" && isRecord(event.item)) {
      const item = event.item;
      if (item.type === "agent_message" && typeof item.text === "string") {
        finalAnswer = item.text;
      }
      if (item.type === "command_execution") {
        toolCalls += 1;
        shellCalls += 1;
        toolInputChars += typeof item.command === "string" ? item.command.length : 0;
        toolOutputChars += typeof item.aggregated_output === "string" ? item.aggregated_output.length : 0;
      }
      if (item.type === "mcp_tool_call") {
        toolCalls += 1;
        mcpCalls += 1;
        toolInputChars += JSON.stringify(item.arguments ?? {}).length;
        toolOutputChars += JSON.stringify(item.result ?? item.error ?? {}).length;
      }
    }
  }

  return { finalAnswer, usage, usageCompleted, toolCalls, shellCalls, mcpCalls, toolInputChars, toolOutputChars, warnings };
}

function formatWorkflowRows(rows: WorkflowBenchmarkRow[], showAnswers: boolean): string {
  const header = [
    "Workflow",
    "Quality",
    "Tests",
    "Usage",
    "Exit",
    "Tool",
    "MCP",
    "Shell",
    "Input tok",
    "Cached",
    "Output tok",
    "Reason tok",
    "Raw tok",
    "Fresh tok",
    "Changed",
    "Generated",
    "Duration ms"
  ];
  const body = rows.map((row) => [
    row.workflow,
    `${row.qualityScore.toFixed(3)} ${row.qualityChecks}`,
    row.testsPassed ? "pass" : "fail",
    row.usageStatus,
    String(row.exitCode),
    String(row.toolCalls),
    String(row.mcpCalls),
    String(row.shellCalls),
    formatUsageValue(row, row.usage.input_tokens),
    formatUsageValue(row, row.usage.cached_input_tokens),
    formatUsageValue(row, row.usage.output_tokens),
    formatUsageValue(row, row.usage.reasoning_output_tokens),
    formatUsageValue(row, totalUsageTokens(row.usage)),
    formatUsageValue(row, freshUsageTokens(row.usage)),
    String(row.changedFiles.length),
    String(row.validationGeneratedFiles.length),
    String(row.durationMs)
  ]);
  const table = [header, ...body];
  const widths = header.map((_, column) => Math.max(...table.map((row) => row[column].length)));
  const lines = table.map((row, index) => {
    const line = row.map((cell, column) => cell.padEnd(widths[column])).join("  ");
    return index === 0 ? `${line}\n${widths.map((width) => "-".repeat(width)).join("  ")}` : line;
  });
  if (!showAnswers) {
    return `${lines.join("\n")}\n`;
  }
  return `${lines.join("\n")}\n\nAnswers:\n${rows.map((row) => `\n[${row.workflow}]\nworktree: ${row.worktree}\nrawLog: ${row.rawLogPath}\ndiff: ${row.diffPath}\nanswer:\n${row.finalAnswer}`).join("\n")}\n`;
}

function formatTokenComparison(rows: WorkflowBenchmarkRow[]): string[] {
  const baseline = rows.find((row) => row.workflow === "baseline");
  const tokenopt = rows.find((row) => row.workflow === "tokenopt");
  const speckit = rows.find((row) => row.workflow === "speckit");
  const hybrid = rows.find((row) => row.workflow === "speckit-tokenopt");
  const lines: string[] = [];
  if (baseline) {
    lines.push("Compared to baseline:");
    for (const row of rows.filter((candidate) => candidate.workflow !== "baseline")) {
      lines.push(
        `${row.workflow}:`,
        formatUsageDeltaLine("Input tokens", row, row.usage.input_tokens, baseline, baseline.usage.input_tokens),
        formatUsageDeltaLine("Output tokens", row, row.usage.output_tokens, baseline, baseline.usage.output_tokens),
        formatUsageDeltaLine("Reasoning tokens", row, row.usage.reasoning_output_tokens, baseline, baseline.usage.reasoning_output_tokens),
        formatUsageDeltaLine("Raw total tokens", row, totalUsageTokens(row.usage), baseline, totalUsageTokens(baseline.usage)),
        formatUsageDeltaLine("Fresh total tokens", row, freshUsageTokens(row.usage), baseline, freshUsageTokens(baseline.usage)),
        `Quality delta: ${row.workflow} ${row.qualityScore.toFixed(3)} vs baseline ${baseline.qualityScore.toFixed(3)}.`,
        `Tool calls: ${row.workflow} ${row.toolCalls} vs baseline ${baseline.toolCalls}; MCP ${row.mcpCalls} vs ${baseline.mcpCalls}; shell ${row.shellCalls} vs ${baseline.shellCalls}.`,
        ""
      );
    }
  }
  if (!tokenopt || !speckit) {
    return lines.length > 0 ? lines : ["Need both tokenopt and speckit rows for delta comparison."];
  }
  lines.push(
    "TokenOpt vs SpecKit:",
    formatUsageDeltaLine("Input tokens", tokenopt, tokenopt.usage.input_tokens, speckit, speckit.usage.input_tokens),
    formatUsageDeltaLine("Output tokens", tokenopt, tokenopt.usage.output_tokens, speckit, speckit.usage.output_tokens),
    formatUsageDeltaLine("Reasoning tokens", tokenopt, tokenopt.usage.reasoning_output_tokens, speckit, speckit.usage.reasoning_output_tokens),
    formatUsageDeltaLine("Raw total tokens", tokenopt, totalUsageTokens(tokenopt.usage), speckit, totalUsageTokens(speckit.usage)),
    formatUsageDeltaLine("Fresh total tokens", tokenopt, freshUsageTokens(tokenopt.usage), speckit, freshUsageTokens(speckit.usage)),
    `Quality delta: tokenopt ${tokenopt.qualityScore.toFixed(3)} vs speckit ${speckit.qualityScore.toFixed(3)}.`,
    `Test result: tokenopt ${tokenopt.testsPassed ? "pass" : "fail"}, speckit ${speckit.testsPassed ? "pass" : "fail"}.`
  );
  if (hybrid) {
    lines.push(
      "",
      "Hybrid vs SpecKit:",
      formatUsageDeltaLine("Input tokens", hybrid, hybrid.usage.input_tokens, speckit, speckit.usage.input_tokens),
      formatUsageDeltaLine("Output tokens", hybrid, hybrid.usage.output_tokens, speckit, speckit.usage.output_tokens),
      formatUsageDeltaLine("Reasoning tokens", hybrid, hybrid.usage.reasoning_output_tokens, speckit, speckit.usage.reasoning_output_tokens),
      formatUsageDeltaLine("Raw total tokens", hybrid, totalUsageTokens(hybrid.usage), speckit, totalUsageTokens(speckit.usage)),
      formatUsageDeltaLine("Fresh total tokens", hybrid, freshUsageTokens(hybrid.usage), speckit, freshUsageTokens(speckit.usage)),
      `Quality delta: speckit-tokenopt ${hybrid.qualityScore.toFixed(3)} vs speckit ${speckit.qualityScore.toFixed(3)}.`,
      "",
      "Hybrid vs TokenOpt:",
      formatUsageDeltaLine("Input tokens", hybrid, hybrid.usage.input_tokens, tokenopt, tokenopt.usage.input_tokens),
      formatUsageDeltaLine("Output tokens", hybrid, hybrid.usage.output_tokens, tokenopt, tokenopt.usage.output_tokens),
      formatUsageDeltaLine("Reasoning tokens", hybrid, hybrid.usage.reasoning_output_tokens, tokenopt, tokenopt.usage.reasoning_output_tokens),
      formatUsageDeltaLine("Raw total tokens", hybrid, totalUsageTokens(hybrid.usage), tokenopt, totalUsageTokens(tokenopt.usage)),
      formatUsageDeltaLine("Fresh total tokens", hybrid, freshUsageTokens(hybrid.usage), tokenopt, freshUsageTokens(tokenopt.usage)),
      `Quality delta: speckit-tokenopt ${hybrid.qualityScore.toFixed(3)} vs tokenopt ${tokenopt.qualityScore.toFixed(3)}.`
    );
  }
  return lines;
}

function formatUsageValue(row: Pick<WorkflowBenchmarkRow, "usageStatus">, value: number): string {
  return row.usageStatus === "completed" ? String(value) : "n/a";
}

function formatUsageDeltaLine(
  label: string,
  left: Pick<WorkflowBenchmarkRow, "workflow" | "usageStatus">,
  leftValue: number,
  right: Pick<WorkflowBenchmarkRow, "workflow" | "usageStatus">,
  rightValue: number
): string {
  if (left.usageStatus !== "completed" || right.usageStatus !== "completed") {
    return `- ${label}: ${left.workflow}=${formatUsageValue(left, leftValue)}, ${right.workflow}=${formatUsageValue(right, rightValue)}, delta unavailable (${left.workflow} usage=${left.usageStatus}, ${right.workflow} usage=${right.usageStatus}).`;
  }
  if (rightValue <= 0) {
    return `- ${label}: ${left.workflow}=${leftValue}, ${right.workflow}=${rightValue}, delta unavailable.`;
  }
  const saved = 1 - leftValue / rightValue;
  return `- ${label}: ${left.workflow}=${leftValue}, ${right.workflow}=${rightValue}, ${left.workflow} ${saved >= 0 ? "saved" : "spent"} ${Math.abs(saved * 100).toFixed(1)}% vs ${right.workflow}.`;
}

function formatMarkdownTable(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`)
  ].join("\n");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function rubricMatches(text: string, item: string): boolean {
  const normalizedWords = new Set(normalizeRubricText(text).split(/\s+/).filter(Boolean));
  const words = normalizeRubricText(item)
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !["with", "that", "this", "from", "into", "keeps", "keep"].includes(word));
  if (words.length === 0) {
    return normalizeRubricText(text).includes(normalizeRubricText(item));
  }
  const required = words.length <= 2 ? words : words.slice(0, Math.ceil(words.length * 0.7));
  return required.every((word) => [...normalizedWords].some((candidate) => candidate.startsWith(word) || word.startsWith(candidate)));
}

function normalizeRubricText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/(?:ing|ed|es|s)$/i, ""))
    .join(" ");
}

function parseWorkflow(value: string): WorkflowMode {
  if (value === "baseline" || value === "tokenopt" || value === "speckit" || value === "speckit-tokenopt" || value === "tokenopt-prompt-chain" || value === "speckit-gate-first" || value === "speckit-compact") {
    return value;
  }
  if (value === "speckit-only") {
    return "speckit";
  }
  if (value === "gate-first") {
    return "speckit-gate-first";
  }
  if (value === "compact") {
    return "speckit-compact";
  }
  throw new Error(`Unknown workflow: ${value}`);
}

function parseMcpMode(value: string): McpMode {
  if (value === "lite" || value === "full") {
    return value;
  }
  throw new Error(`Unknown MCP mode: ${value}`);
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function gitOutput(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${result.stderr || result.stdout}`);
  }
  return result.stdout ?? "";
}

function listTrackedChangedFiles(cwd: string, baseCommit: string): string[] {
  return gitOutput(cwd, ["diff", "--name-only", baseCommit])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function listChangedFiles(cwd: string, baseCommit: string): string[] {
  return [...new Set([...listTrackedChangedFiles(cwd, baseCommit), ...listUntrackedFiles(cwd)])];
}

function listUntrackedFiles(cwd: string): string[] {
  return gitOutput(cwd, ["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function buildDiffWithUntracked(cwd: string, trackedDiffText: string, untrackedFiles: string[]): string {
  const parts = [trackedDiffText.trimEnd()].filter(Boolean);
  for (const file of untrackedFiles) {
    const absolute = path.join(cwd, file);
    if (!fs.existsSync(absolute) || fs.statSync(absolute).size > 200_000) {
      parts.push(`diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n+<untracked file omitted from benchmark diff>`);
      continue;
    }
    const content = fs.readFileSync(absolute, "utf8");
    parts.push([
      `diff --git a/${file} b/${file}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${file}`,
      ...content.split(/\r?\n/).map((line) => `+${line}`)
    ].join("\n"));
  }
  return `${parts.join("\n")}\n`;
}

function withUntrackedSummary(stat: string, untrackedFiles: string[]): string {
  if (untrackedFiles.length === 0) {
    return stat;
  }
  const suffix = `${untrackedFiles.length} untracked file${untrackedFiles.length === 1 ? "" : "s"}`;
  return stat ? `${stat}; ${suffix}` : suffix;
}

function safeName(value: string): string {
  const safe = value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "workflow-ab-feature";
}

function slash(value: string): string {
  return value.replace(/\\/g, "/");
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workflowBenchmarkHelp(): string {
  return `Usage:
  tokenopt benchmark workflow-ab --repo <path> --feature-file <json|txt> [--workflow baseline,tokenopt,speckit,speckit-only,speckit-tokenopt,speckit-gate-first,speckit-compact,tokenopt-prompt-chain] [--base-ref HEAD] [--test-command <command>] [--mcp-mode lite|full] [--validation-timeout-ms 300000] [--out <json>] [--markdown <md>] [--show-answers]

Feature JSON:
  {
    "id": "short-id",
    "title": "Feature title",
    "prompt": "Implementation request",
    "qualityRubric": ["expected behavior", "targeted validation"],
    "testCommand": "npm test"
  }

Token usage:
  raw total = input + output + reasoning.
  fresh total = input - cached input + output + reasoning.
  Timed-out or missing usage is reported as unavailable instead of zero.
`;
}
