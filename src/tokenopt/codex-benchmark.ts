import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

type CodexBenchmarkMode = "baseline" | "tokenopt-mcp" | "tokenopt-mcp+gate" | "tokenopt-mcp-instructed";
type CodexTaskId =
  | "build-handoff"
  | "investigate"
  | "research-business"
  | "implement"
  | "write-unittest"
  | "investigate-flow"
  | "pbi-plan"
  | "write-unittest-class"
  | "requirement-analysis"
  | "repo-benchmark-analysis";

interface CodexTask {
  id: CodexTaskId;
  taskType: string;
  prompt: string;
  gatePattern: string;
}

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
  toolCalls: number;
  shellCalls: number;
  mcpCalls: number;
  toolInputChars: number;
  toolOutputChars: number;
  answerablePackets: number;
  fallbackAfterAnswerable: number;
  warnings: number;
  rawLogPath: string;
  lastMessagePath: string;
}

interface CodexBenchmarkRow extends CodexRunMetrics {
  repo: string;
  task: CodexTaskId;
  taskType: string;
  mode: CodexBenchmarkMode;
  userPrompt: string;
  injectedInstruction: string;
  prompt: string;
  qualityScore: number;
  qualityChecks: string;
  correct: boolean;
}

const CODEX_PACKAGE = "@openai/codex@0.137.0";
const DAILY_CODEX_TASKS: CodexTask[] = [
  {
    id: "build-handoff",
    taskType: "build_handoff",
    prompt:
      "Prepare a daily build handoff for this repo. Identify build tool, wrapper/package manager, version facts, scripts or targeted test command. Do not modify files.",
    gatePattern: "build_tool"
  },
  {
    id: "investigate",
    taskType: "investigate",
    prompt:
      "Investigate how to triage a failing build or test in this repo. Give likely hypotheses, exact first commands, and evidence to inspect next. Do not modify files.",
    gatePattern: "test"
  },
  {
    id: "research-business",
    taskType: "research_business",
    prompt:
      "Research the business, product, or domain purpose of this repository. Summarize what it appears to do and major project areas. Do not modify files.",
    gatePattern: "README"
  },
  {
    id: "implement",
    taskType: "implement",
    prompt:
      "Create an implementation handoff for a small behavior change in this repo: where to inspect, how to edit safely, and what tests to run. Do not modify files.",
    gatePattern: "src"
  },
  {
    id: "write-unittest",
    taskType: "write_unittest",
    prompt:
      "Create a unit-test handoff for this repo: where tests likely live, what targeted test command to run, and what assertions to cover. Do not modify files.",
    gatePattern: "test"
  }
];
const REALISTIC_CODEX_TASKS: CodexTask[] = [
  {
    id: "investigate-flow",
    taskType: "investigate",
    prompt:
      "Investigate the primary user flow in this codebase. Identify likely entry points, core code paths, dependencies, likely failure points, exact first commands to verify, and what evidence is still missing. Do not modify files.",
    gatePattern: "flow"
  },
  {
    id: "pbi-plan",
    taskType: "implement",
    prompt:
      "Based on this requirement/PBI, please help me investigate and plan implementation: users need a safer way to change an important configuration without breaking existing behavior. Analyze likely impacted areas, implementation approach, risks, tests, and rollout notes. Do not modify files.",
    gatePattern: "config"
  },
  {
    id: "write-unittest-class",
    taskType: "write_unittest",
    prompt:
      "Please help me write a unit-test plan for the class or module most likely responsible for the primary business flow in this repository. Identify candidate class/module, test file location, targeted command, mocks/fixtures, and assertions. Do not modify files.",
    gatePattern: "test"
  },
  {
    id: "requirement-analysis",
    taskType: "implement",
    prompt:
      "Analyze this requirement against the codebase and produce WHAT, WHY, HOW, acceptance criteria, impacted code areas, test strategy, unknowns, and a practical implementation plan: add a guarded behavior change that preserves backwards compatibility for existing users. Do not modify files.",
    gatePattern: "requirement"
  },
  {
    id: "repo-benchmark-analysis",
    taskType: "investigate",
    prompt:
      "If this repository contains benchmark, evaluation, or performance documentation/scripts, identify what exists, how it is run, what it measures, and how to include it in a validation plan for future changes. If there is no benchmark material, say so. Do not modify files.",
    gatePattern: "benchmark"
  }
];
const CODEX_TASKS: CodexTask[] = [...DAILY_CODEX_TASKS, ...REALISTIC_CODEX_TASKS];

export async function runCodexBenchmarkCommand(args: string[]): Promise<number> {
  const options = parseOptions(args);
  const rows: CodexBenchmarkRow[] = [];
  for (const repo of options.repos) {
    for (const task of options.tasks) {
      for (const mode of options.modes) {
        const promptParts = buildPromptParts(repo, task, mode);
        const run = runCodexBenchmark(repo, task, mode, options, promptParts.prompt);
        const quality = scoreCodexAnswer(task, run.finalAnswer);
        rows.push({
          ...run,
          repo,
          task: task.id,
          taskType: task.taskType,
          mode,
          userPrompt: promptParts.userPrompt,
          injectedInstruction: promptParts.injectedInstruction,
          prompt: promptParts.prompt,
          qualityScore: quality.score,
          qualityChecks: `${quality.passed}/${quality.total}`,
          correct: quality.score >= 0.8
        });
      }
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    runner: "codex exec --json",
    codexPackage: options.codexPackage,
    rows: options.showAnswers ? rows : rows.map((row) => ({ ...row, finalAnswer: undefined }))
  };
  if (options.outPath) {
    fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
    fs.writeFileSync(options.outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  process.stdout.write(options.json ? `${JSON.stringify(payload, null, 2)}\n` : formatRows(rows, options.showAnswers));
  return rows.some((row) => row.exitCode !== 0 || !row.correct) ? 1 : 0;
}

function parseOptions(args: string[]): {
  repos: string[];
  tasks: CodexTask[];
  modes: CodexBenchmarkMode[];
  codexPackage: string;
  outPath?: string;
  json: boolean;
  showAnswers: boolean;
  timeoutMs: number;
  model?: string;
} {
  const repos: string[] = [];
  let tasks = [CODEX_TASKS[0]];
  let modes: CodexBenchmarkMode[] = ["baseline", "tokenopt-mcp"];
  let codexPackage = CODEX_PACKAGE;
  let outPath: string | undefined;
  let json = false;
  let showAnswers = false;
  let timeoutMs = 300_000;
  let model: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      const repo = args[index + 1];
      if (!repo) {
        throw new Error("--repo requires a path");
      }
      repos.push(path.resolve(repo));
      index += 1;
      continue;
    }
    if (arg === "--task") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--task requires a value");
      }
      tasks = parseTaskSelection(value);
      index += 1;
      continue;
    }
    if (arg === "--mode") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--mode requires a value");
      }
      modes = value === "all" ? ["baseline", "tokenopt-mcp", "tokenopt-mcp+gate", "tokenopt-mcp-instructed"] : value.split(",").map(parseMode);
      index += 1;
      continue;
    }
    if (arg === "--codex-package") {
      codexPackage = args[index + 1] ?? codexPackage;
      index += 1;
      continue;
    }
    if (arg === "--model") {
      model = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = Number.parseInt(args[index + 1] ?? "", 10);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("--timeout-ms must be a positive integer");
      }
      index += 1;
      continue;
    }
    if (arg === "--out") {
      const output = args[index + 1];
      if (!output) {
        throw new Error("--out requires a path");
      }
      outPath = path.resolve(output);
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
      throw new Error(codexBenchmarkHelp());
    }
    throw new Error(`Unknown codex benchmark argument: ${arg}`);
  }

  return {
    repos: repos.length > 0 ? repos : [process.cwd()],
    tasks,
    modes,
    codexPackage,
    outPath,
    json,
    showAnswers,
    timeoutMs,
    model
  };
}

function runCodexBenchmark(
  repo: string,
  task: CodexTask,
  mode: CodexBenchmarkMode,
  options: { codexPackage: string; timeoutMs: number; model?: string },
  prompt: string
): CodexRunMetrics {
  const start = Date.now();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-codex-benchmark-"));
  const rawLogPath = path.join(runDir, `${task.id}-${mode}.jsonl`);
  const lastMessagePath = path.join(runDir, `${task.id}-${mode}-last.txt`);
  const args = [
    "-y",
    options.codexPackage,
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "-C",
    repo,
    "-o",
    lastMessagePath,
    "--color",
    "never"
  ];

  if (options.model) {
    args.push("-m", options.model);
  }

  if (mode !== "baseline") {
    args.push(
      "--disable",
      "shell_tool",
      "-c",
      "mcp_servers.tokenopt.command='node'",
      "-c",
      `mcp_servers.tokenopt.args=['${slash(path.join(process.cwd(), "dist", "cli.js"))}','mcp','--mode','lite']`
    );
  }

  args.push("-");

  const result = spawnSync("npx.cmd", args, {
    cwd: repo,
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

  return {
    exitCode: result.status,
    durationMs: Date.now() - start,
    finalAnswer: fileAnswer || parsed.finalAnswer,
    usage: parsed.usage,
    toolCalls: parsed.toolCalls,
    shellCalls: parsed.shellCalls,
    mcpCalls: parsed.mcpCalls,
    toolInputChars: parsed.toolInputChars,
    toolOutputChars: parsed.toolOutputChars,
    answerablePackets: parsed.answerablePackets,
    fallbackAfterAnswerable: parsed.fallbackAfterAnswerable,
    warnings: parsed.warnings + stderr.split(/\r?\n/).filter((line) => line.trim()).length + (result.error ? 1 : 0),
    rawLogPath,
    lastMessagePath
  };
}

function buildPromptParts(repo: string, task: CodexTask, mode: CodexBenchmarkMode): {
  userPrompt: string;
  injectedInstruction: string;
  prompt: string;
} {
  const outputContract = [
    "Return a concise final answer with these headings exactly:",
    "Summary:",
    "Evidence:",
    "Recommended next steps:",
    "Do not modify files."
  ].join("\n");
  const userPrompt = task.prompt;

  if (mode === "baseline") {
    const injectedInstruction = [
      "Use normal Codex CLI tools if needed. Keep shell/search calls minimal, but gather enough evidence for a correct answer.",
      outputContract
    ].join("\n");
    return {
      userPrompt,
      injectedInstruction,
      prompt: [userPrompt, "", injectedInstruction].join("\n")
    };
  }

  if (mode === "tokenopt-mcp-instructed") {
    const injectedInstruction = [
      "Project instruction injected by TokenOpt setup:",
      "The user may ask naturally and does not need to name MCP tools.",
      "Use TokenOpt as a cost gate, not a mandatory extra step before normal tools.",
      "Call tokenopt_compile_evidence only when it can replace broad exploration. If this is an exact code-flow/class/PBI deep dive and native shell/search would still be needed, skip MCP-first in shell-enabled sessions.",
      "This benchmark disables shell for TokenOpt modes, so strict MCP-only acquisition is acceptable here.",
      `For this request, if TokenOpt is appropriate, the benchmark oracle classifies the task_type as ${task.taskType}; call tokenopt_compile_evidence with cwd=${repo}, task=<verbatim user request>, task_type=${task.taskType}, budget_tokens around 1200, and a concrete quality_rubric.`,
      "If tokenopt_compile_evidence returns answerable=true, answer from the packet and do not call shell/search/read tools just to verify the same evidence.",
      "If missing is non-empty, use only allowed_followups from the packet and report unresolved evidence honestly.",
      outputContract
    ].join("\n");
    return {
      userPrompt,
      injectedInstruction,
      prompt: [injectedInstruction, "", "User request:", userPrompt].join("\n")
    };
  }

  const gateLine =
    mode === "tokenopt-mcp+gate"
      ? `After tokenopt_compile_evidence returns answerable=true, deliberately call tokenopt_search once with pattern ${JSON.stringify(task.gatePattern)} to verify the answerability gate, then answer.`
      : "If tokenopt_compile_evidence returns answerable=true, do not call more tools; answer from the packet.";

  const injectedInstruction = [
    "You must use the TokenOpt MCP tool tokenopt_compile_evidence first.",
    `Call it with cwd=${repo}, task_type=${task.taskType}, and a budget around 1200 tokens.`,
    gateLine,
    outputContract
  ].join("\n");
  return {
    userPrompt,
    injectedInstruction,
    prompt: [userPrompt, "", injectedInstruction].join("\n")
  };
}

function parseCodexJsonl(text: string): {
  finalAnswer: string;
  usage: CodexUsage;
  toolCalls: number;
  shellCalls: number;
  mcpCalls: number;
  toolInputChars: number;
  toolOutputChars: number;
  answerablePackets: number;
  fallbackAfterAnswerable: number;
  warnings: number;
} {
  let finalAnswer = "";
  let usage: CodexUsage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  let toolCalls = 0;
  let shellCalls = 0;
  let mcpCalls = 0;
  let toolInputChars = 0;
  let toolOutputChars = 0;
  let answerablePackets = 0;
  let fallbackAfterAnswerable = 0;
  let sawAnswerablePacket = false;
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
        if (sawAnswerablePacket) {
          fallbackAfterAnswerable += 1;
        }
      }
      if (item.type === "mcp_tool_call") {
        toolCalls += 1;
        mcpCalls += 1;
        const argumentsText = JSON.stringify(item.arguments ?? {});
        const resultText = JSON.stringify(item.result ?? item.error ?? {});
        const itemText = JSON.stringify(item);
        const isCompileEvidenceCall = /tokenopt_compile_evidence/.test(itemText);
        toolInputChars += argumentsText.length;
        toolOutputChars += resultText.length;
        if (sawAnswerablePacket && !isCompileEvidenceCall) {
          fallbackAfterAnswerable += 1;
        }
        if (isCompileEvidenceCall && /"answerable"\s*:\s*true|answerable=true/i.test(resultText)) {
          answerablePackets += 1;
          sawAnswerablePacket = true;
        }
      }
    }
  }

  return {
    finalAnswer,
    usage,
    toolCalls,
    shellCalls,
    mcpCalls,
    toolInputChars,
    toolOutputChars,
    answerablePackets,
    fallbackAfterAnswerable,
    warnings
  };
}

function scoreCodexAnswer(task: CodexTask, answer: string): { score: number; passed: number; total: number } {
  const checks: Array<[string, boolean]> = [
    ["summary", /Summary:/i.test(answer)],
    ["evidence", /Evidence:/i.test(answer)],
    ["next_steps", /Recommended next steps:/i.test(answer)]
  ];

  if (task.id === "build-handoff") {
    checks.push(["build_tool", /\b(Gradle|Maven|Npm|npm|package\.json|pom\.xml|gradlew|mvn)\b/i.test(answer)]);
    checks.push(["command_or_script", /\b(test|build|script|command|gradlew|mvn|npm)\b/i.test(answer)]);
  } else if (task.id === "investigate" || task.id === "investigate-flow" || task.id === "repo-benchmark-analysis") {
    checks.push(["hypothesis", /\b(hypothes|likely|cause|triage|investigate)\b/i.test(answer)]);
    checks.push(["command", /\b(command|run|gradlew|mvn|npm|rg)\b/i.test(answer)]);
    if (task.id === "investigate-flow") {
      checks.push(["flow_or_path", /\b(flow|entry|path|route|controller|service|module|dependency)\b/i.test(answer)]);
      checks.push(["missing_evidence", /\b(missing|unknown|inspect next|evidence to inspect)\b/i.test(answer)]);
    }
    if (task.id === "repo-benchmark-analysis") {
      checks.push(["benchmark_material", /\b(benchmark|bench|evaluation|eval|performance|perf)\b/i.test(answer)]);
      checks.push(["measures", /\b(measure|metric|token|latency|accuracy|throughput|cost|quality)\b/i.test(answer)]);
      checks.push(["validation_plan", /\b(validation|verify|plan|future changes|regression)\b/i.test(answer)]);
    }
  } else if (task.id === "research-business") {
    checks.push(["purpose", /\b(purpose|repository|project|domain|product)\b/i.test(answer)]);
    checks.push(["areas", /\b(area|module|component|directory|project)\b/i.test(answer)]);
  } else if (task.id === "implement" || task.id === "pbi-plan") {
    checks.push(["implementation", /\b(implement|change|edit|inspect|file)\b/i.test(answer)]);
    checks.push(["tests", /\b(test|verify|command)\b/i.test(answer)]);
    if (task.id === "pbi-plan") {
      checks.push(["impacted_areas", /\b(impact|area|module|component|file|risk)\b/i.test(answer)]);
      checks.push(["rollout_or_risk", /\b(risk|rollout|compat|migration|guard)\b/i.test(answer)]);
    }
  } else if (task.id === "requirement-analysis") {
    checks.push(["what", /\bwhat\b|Summary:/i.test(answer)]);
    checks.push(["why", /\bwhy\b|rationale|reason/i.test(answer)]);
    checks.push(["how", /\bhow\b|implementation|plan/i.test(answer)]);
    checks.push(["acceptance_criteria", /\bacceptance criteria\b|\bAC\b|criteria/i.test(answer)]);
    checks.push(["test_strategy", /\btest|verify|validation/i.test(answer)]);
  } else {
    checks.push(["test_location", /\b(test|tests|unit|location|directory)\b/i.test(answer)]);
    checks.push(["assertions", /\b(assert|cover|case|regression)\b/i.test(answer)]);
    if (task.id === "write-unittest-class") {
      checks.push(["candidate_class_or_module", /\b(class|module|service|component|candidate)\b/i.test(answer)]);
      checks.push(["mocks_or_fixtures", /\b(mock|fixture|stub|fake|test data)\b/i.test(answer)]);
    }
  }

  const passed = checks.filter(([, ok]) => ok).length;
  return { score: Number((passed / checks.length).toFixed(3)), passed, total: checks.length };
}

function formatRows(rows: CodexBenchmarkRow[], showAnswers: boolean): string {
  const header = [
    "Repo",
    "Task",
    "Mode",
    "Quality",
    "Checks",
    "Correct",
    "Exit",
    "Tool",
    "MCP",
    "Shell",
    "Answerable",
    "Fallback",
    "Tool in",
    "Tool out",
    "Input tok",
    "Cached",
    "Output tok",
    "Reason tok",
    "Duration ms",
    "Warnings"
  ];
  const body = rows.map((row) => [
    path.basename(row.repo),
    row.task,
    row.mode,
    row.qualityScore.toFixed(3),
    row.qualityChecks,
    row.correct ? "yes" : "no",
    String(row.exitCode),
    String(row.toolCalls),
    String(row.mcpCalls),
    String(row.shellCalls),
    String(row.answerablePackets),
    String(row.fallbackAfterAnswerable),
    String(row.toolInputChars),
    String(row.toolOutputChars),
    String(row.usage.input_tokens),
    String(row.usage.cached_input_tokens),
    String(row.usage.output_tokens),
    String(row.usage.reasoning_output_tokens),
    String(row.durationMs),
    String(row.warnings)
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
  return `${lines.join("\n")}\n\nAnswers:\n${rows.map((row) => `\n[${path.basename(row.repo)} ${row.task} ${row.mode}]\ntask_type: ${row.taskType}\nanswerablePackets: ${row.answerablePackets}\nfallbackAfterAnswerable: ${row.fallbackAfterAnswerable}\nuserPrompt:\n${row.userPrompt}\n\ninjectedInstruction:\n${row.injectedInstruction}\n\nactualPromptSentToCodex:\n${row.prompt}\n\nanswer:\n${row.finalAnswer}\nrawLog: ${row.rawLogPath}`).join("\n")}\n`;
}

function parseTask(value: string): CodexTask {
  const task = CODEX_TASKS.find((candidate) => candidate.id === value);
  if (!task) {
    throw new Error(`Unknown codex benchmark task: ${value}`);
  }
  return task;
}

function parseTaskSelection(value: string): CodexTask[] {
  if (value === "all") {
    return CODEX_TASKS;
  }
  if (value === "daily") {
    return DAILY_CODEX_TASKS;
  }
  if (value === "realistic") {
    return REALISTIC_CODEX_TASKS;
  }
  return value.split(",").map(parseTask);
}

function parseMode(value: string): CodexBenchmarkMode {
  if (value === "baseline" || value === "tokenopt-mcp" || value === "tokenopt-mcp+gate" || value === "tokenopt-mcp-instructed") {
    return value;
  }
  throw new Error(`Unknown codex benchmark mode: ${value}`);
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

function codexBenchmarkHelp(): string {
  return `Usage:
  tokenopt benchmark codex-daily --repo <path> [--task daily|realistic|all|build-handoff|investigate|research-business|implement|write-unittest|investigate-flow|pbi-plan|write-unittest-class|requirement-analysis|repo-benchmark-analysis] [--mode baseline|tokenopt-mcp|tokenopt-mcp+gate|tokenopt-mcp-instructed|all] [--model <model>] [--out <path>] [--json] [--show-answers]
`;
}
