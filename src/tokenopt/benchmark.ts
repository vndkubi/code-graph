import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "./config.js";
import { readRepoEvents } from "./observability.js";
import { routeTask } from "./router.js";
import { estimateTokens } from "./token-estimator.js";
import type { EvidenceTaskType } from "./types.js";

type BenchmarkMode =
  | "baseline"
  | "compiled-packet"
  | "compiled-shadow-gate"
  | "compiled-packet+gate"
  | "router-best"
  | "router-shadow-gate"
  | "router-shadow-gate+compressors"
  | "gold-packet"
  | "oracle-packet"
  | "codegraph-only"
  | "tokenopt-codegraph";
type BenchmarkTaskId = "build-handoff" | "investigate" | "research-business" | "implement" | "write-unittest" | "review-diff";

interface BenchmarkTask {
  id: BenchmarkTaskId;
  label: string;
  taskType: EvidenceTaskType;
  prompt: string;
  qualityRubric: string[];
  oracleRubric: string[];
  redundantPattern: string;
}

interface RepoSignals {
  facts: string[];
  buildTool?: string;
  projectName?: string;
  overviewTitle?: string;
  overviewSummary?: string;
  overviewFile?: string;
  topDirs: string[];
  sourceDirs: string[];
  testDirs: string[];
  configFiles: string[];
  importantFiles: string[];
  rootFiles: string[];
}

interface QualityResult {
  score: number;
  passed: number;
  total: number;
  checks: Array<{ name: string; passed: boolean }>;
}

interface BenchmarkRow {
  repo: string;
  task: BenchmarkTaskId;
  mode: BenchmarkMode;
  correct: boolean;
  answerable: boolean;
  qualityScore: number;
  qualityPassed: boolean;
  qualityChecks: string;
  toolCalls: number;
  mcpCalls: number;
  shellCalls: number;
  toolInputChars: number;
  toolOutputChars: number;
  finalOutputChars: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  fallbackAfterAnswerable: number;
  run: number;
  estimatedTokensAvoided: number;
  redundantCallRate: number;
  routeDecision: string;
  routeReason: string;
  routerRegret: string;
  answer: string;
  notes: string;
}

const ALL_MODES: BenchmarkMode[] = [
  "baseline",
  "compiled-packet",
  "compiled-shadow-gate",
  "compiled-packet+gate",
  "router-best",
  "router-shadow-gate",
  "router-shadow-gate+compressors",
  "gold-packet",
  "oracle-packet",
  "codegraph-only",
  "tokenopt-codegraph"
];
const DAILY_TASKS: BenchmarkTask[] = [
  {
    id: "build-handoff",
    label: "Build handoff",
    taskType: "build_handoff",
    prompt:
      "Prepare a daily build handoff for this repo: identify build tool, wrapper/package manager, version facts, and scripts.",
    qualityRubric: ["identify build tool", "identify wrapper/package manager", "list version or script facts"],
    oracleRubric: [
      "identify build tool",
      "identify wrapper or package manager",
      "extract version facts",
      "list build/test scripts",
      "stop without redundant exploration when answerable"
    ],
    redundantPattern: "build_tool"
  },
  {
    id: "investigate",
    label: "Investigate",
    taskType: "investigate",
    prompt:
      "Investigate how to triage a failing build or test in this repo. Produce likely hypotheses, exact first commands, and evidence to inspect next.",
    qualityRubric: ["state hypotheses", "give exact commands", "cite repo evidence"],
    oracleRubric: ["state hypotheses", "give exact commands", "cite repo evidence", "avoid broad shell fallback"],
    redundantPattern: "test"
  },
  {
    id: "research-business",
    label: "Research business",
    taskType: "research_business",
    prompt:
      "Research the business, product, or domain purpose of this repository. Summarize what it appears to do and the major project areas.",
    qualityRubric: ["summarize purpose", "identify project/domain", "list major areas"],
    oracleRubric: ["summarize purpose", "identify project/domain", "list major areas", "include confidence/caveats"],
    redundantPattern: "README"
  },
  {
    id: "implement",
    label: "Implement handoff",
    taskType: "implement",
    prompt:
      "Create an implementation handoff for a small behavior change in this repo: where to inspect, how to edit safely, and what tests to run.",
    qualityRubric: ["name files/areas to inspect", "outline implementation steps", "include test strategy"],
    oracleRubric: ["name files/areas to inspect", "outline implementation steps", "include test strategy", "include risks"],
    redundantPattern: "src"
  },
  {
    id: "write-unittest",
    label: "Write unit test",
    taskType: "write_unittest",
    prompt:
      "Create a unit-test handoff for this repo: where tests likely live, what targeted test command to run, and what assertions to cover.",
    qualityRubric: ["identify test locations", "give targeted test command", "state assertion focus"],
    oracleRubric: ["identify test locations", "give targeted test command", "state assertion focus", "cite build context"],
    redundantPattern: "test"
  },
  {
    id: "review-diff",
    label: "Code review round 1 (business)",
    taskType: "review_diff",
    prompt:
      "Review this change for business correctness.\n\n" +
      "Diff:\n" +
      "```diff\n" +
      "--- a/src/service/UserService.java\n" +
      "+++ b/src/service/UserService.java\n" +
      "@@ -42,7 +42,10 @@ public class UserService {\n" +
      "     public User findById(Long id) {\n" +
      "-        return userRepository.findById(id).orElseThrow();\n" +
      "+        User user = userRepository.findById(id).orElseThrow();\n" +
      "+        if (!user.isActive()) {\n" +
      "+            throw new UserInactiveException(\"User \" + id + \" is inactive\");\n" +
      "+        }\n" +
      "+        return user;\n" +
      "     }\n" +
      "--- a/src/service/OrderService.java\n" +
      "+++ b/src/service/OrderService.java\n" +
      "@@ -18,3 +18,4 @@ public class OrderService {\n" +
      "     public Order createOrder(Long userId, List<Item> items) {\n" +
      "-        User user = userService.findById(userId);\n" +
      "+        User user = userService.findById(userId); // now throws UserInactiveException\n" +
      "         return new Order(user, items);\n" +
      "     }\n" +
      "--- a/src/controller/UserController.java\n" +
      "+++ b/src/controller/UserController.java\n" +
      "@@ -31,2 +31,5 @@ public class UserController {\n" +
      "+    @ExceptionHandler(UserInactiveException.class)\n" +
      "+    public ResponseEntity<String> handleInactive(UserInactiveException ex) {\n" +
      "+        return ResponseEntity.status(403).body(ex.getMessage());\n" +
      "+    }\n" +
      "```\n\n" +
      "Identify which modules are affected, what business rules the change touches, " +
      "whether requirement coverage is complete, and flag any missing edge cases or breaking changes.",
    qualityRubric: ["identify affected modules", "state business rules touched", "flag missing cases or risks"],
    oracleRubric: [
      "identify affected modules",
      "state business rules touched",
      "flag missing cases or risks",
      "cite specific files/symbols",
      "distinguish confirmed from inferred impact"
    ],
    redundantPattern: "src"
  }
];

export async function runBenchmarkCommand(args: string[]): Promise<number> {
  const subcommand = args[0];
  if (subcommand !== "daily") {
    process.stderr.write(benchmarkHelp());
    return 2;
  }

  const options = parseBenchmarkOptions(args.slice(1));
  const rows: BenchmarkRow[] = [];
  for (let run = 1; run <= options.repeat; run += 1) {
    const tasks = options.randomize ? shuffle(options.tasks, `tasks-${run}`) : options.tasks;
    const modes = options.randomize ? shuffle(options.modes, `modes-${run}`) : options.modes;
    for (const repo of options.repos) {
      for (const task of tasks) {
        for (const mode of modes) {
          rows.push({ ...(await runDailyMode(repo, task, mode)), run });
        }
      }
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    repeat: options.repeat,
    randomize: options.randomize,
    tasks: options.tasks.map((task) => ({ id: task.id, label: task.label, prompt: task.prompt })),
    rows: options.showAnswers ? rows : rows.map((row) => ({ ...row, answer: undefined }))
  };
  if (options.outPath) {
    fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
    fs.writeFileSync(options.outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
  process.stdout.write(options.json ? `${JSON.stringify(payload, null, 2)}\n` : formatBenchmark(rows, options.showAnswers));
  return 0;
}

function parseBenchmarkOptions(args: string[]): {
  repos: string[];
  modes: BenchmarkMode[];
  tasks: BenchmarkTask[];
  json: boolean;
  showAnswers: boolean;
  repeat: number;
  randomize: boolean;
  outPath?: string;
} {
  const repos: string[] = [];
  let modes: BenchmarkMode[] = ALL_MODES;
  let tasks: BenchmarkTask[] = DAILY_TASKS;
  let json = false;
  let showAnswers = false;
  let repeat = 1;
  let randomize = false;
  let outPath: string | undefined;

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
    if (arg === "--mode") {
      const mode = args[index + 1];
      if (!mode) {
        throw new Error("--mode requires a value");
      }
      modes = mode === "all" ? ALL_MODES : [parseBenchmarkMode(mode)];
      index += 1;
      continue;
    }
    if (arg === "--task") {
      const task = args[index + 1];
      if (!task) {
        throw new Error("--task requires a value");
      }
      tasks = task === "all" ? DAILY_TASKS : task.split(",").map(parseBenchmarkTask);
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
    if (arg === "--repeat") {
      const value = Number.parseInt(args[index + 1] ?? "", 10);
      if (!Number.isFinite(value) || value < 1 || value > 50) {
        throw new Error("--repeat must be an integer from 1 to 50");
      }
      repeat = value;
      index += 1;
      continue;
    }
    if (arg === "--randomize") {
      randomize = true;
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
    if (arg === "--help" || arg === "-h") {
      throw new Error(benchmarkHelp());
    }
    throw new Error(`Unknown benchmark argument: ${arg}`);
  }

  return {
    repos: repos.length > 0 ? repos : [process.cwd()],
    modes,
    tasks,
    json,
    showAnswers,
    repeat,
    randomize,
    outPath
  };
}

function parseBenchmarkMode(value: string): BenchmarkMode {
  if (
    value === "baseline" ||
    value === "compiled-packet" ||
    value === "compiled-shadow-gate" ||
    value === "compiled-packet+gate" ||
    value === "router-best" ||
    value === "router-shadow-gate" ||
    value === "router-shadow-gate+compressors" ||
    value === "gold-packet" ||
    value === "oracle-packet" ||
    value === "codegraph-only" ||
    value === "tokenopt-codegraph"
  ) {
    return value;
  }
  throw new Error(`Unknown benchmark mode: ${value}`);
}

function parseBenchmarkTask(value: string): BenchmarkTask {
  const task = DAILY_TASKS.find((candidate) => candidate.id === value);
  if (!task) {
    throw new Error(`Unknown benchmark task: ${value}`);
  }
  return task;
}

async function runDailyMode(repo: string, task: BenchmarkTask, mode: BenchmarkMode): Promise<BenchmarkRow> {
  if (mode === "baseline") {
    return runBaselineDaily(repo, task);
  }
  if (mode === "codegraph-only") {
    return runCodeGraphOnly(repo, task);
  }
  return runMcpDaily(repo, task, mode);
}

function runBaselineDaily(repo: string, task: BenchmarkTask, mode: BenchmarkMode = "baseline"): BenchmarkRow {
  const rgInput = "rg --files";
  const rg = spawnSync("rg", ["--files"], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32"
  });
  const rawInventory = rg.stdout || rg.stderr || "";
  const files = readBaselineFiles(repo);
  const toolOutput = [rawInventory, ...files.map((file) => `--- ${file.relativePath} ---\n${file.text}`)].join("\n");
  const toolInputChars = rgInput.length + files.reduce((total, file) => total + file.relativePath.length, 0);
  const signals = signalsFromBaseline(repo, rawInventory, files);
  const answer = renderAnswer(task, signals, "baseline");
  const quality = scoreAnswer(task, answer, signals);
  const route = routeTask({
    task: task.prompt,
    repoFileCount: rawInventory.split(/\r?\n/).filter(Boolean).length,
    requestedTaskType: task.taskType
  });

  return buildRow({
    repo,
    task,
    mode,
    answerable: hasMinimumSignals(task, signals),
    toolCalls: 1 + files.length,
    mcpCalls: 0,
    shellCalls: 1,
    toolInputChars,
    toolOutputChars: toolOutput.length,
    fallbackAfterAnswerable: 0,
    estimatedTokensAvoided: 0,
    redundantCallRate: 0,
    routeDecision: route.taskClass,
    routeReason: route.reason,
    routerRegret: "none",
    answer,
    quality,
    notes: `${mode !== "baseline" ? "router_bypass=true; " : ""}raw_inventory_chars=${rawInventory.length}; files_read=${files.length}`
  });
}

async function runMcpDaily(repo: string, task: BenchmarkTask, mode: Exclude<BenchmarkMode, "baseline">): Promise<BenchmarkRow> {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenopt-benchmark-"));
  const repoFileCount = countRepoFiles(repo);
  const route = routeTask({ task: task.prompt, repoFileCount, requestedTaskType: task.taskType });
  if (mode === "router-best" && route.action === "bypass") {
    return runBaselineDaily(repo, task, mode);
  }

  const shadowMode = mode === "compiled-shadow-gate" || mode === "router-shadow-gate" || mode === "router-shadow-gate+compressors";
  const { client, close } = await createMcpClient(repo, artifactDir, shadowMode ? { TOKENOPT_ANSWERABILITY_GATE: "shadow" } : undefined);
  try {
    const args = {
      task: task.prompt,
      task_type: mode.startsWith("router-") ? route.taskType : task.taskType,
      cwd: repo,
      budget_tokens: 1800,
      quality_rubric: mode === "oracle-packet" || mode === "gold-packet" ? task.oracleRubric : task.qualityRubric
    };
    const compile = await client.callTool({
      name: "tokenopt_compile_evidence",
      arguments: args
    });
    const compileText = toolText(compile);
    const structured = (compile as {
      structuredContent?: {
        packet?: { answerable?: boolean; route?: { taskClass?: string; reason?: string; action?: string } };
        packetSummary?: { answerable?: boolean; route?: { taskClass?: string; reason?: string; action?: string } };
      };
    }).structuredContent;
    const compilePacket = structured?.packetSummary ?? structured?.packet;
    const answerable = compilePacket?.answerable ?? /answerable:\s*true/.test(compileText);
    const packetRoute = compilePacket?.route;
    let signals = signalsFromCompiledPacket(compileText);
    let toolCalls = 1;
    let mcpCalls = 1;
    let shellCalls = 0;
    let toolInputChars = JSON.stringify(args).length;
    let toolOutputChars = compileText.length;
    let fallbackAfterAnswerable = 0;
    let estimatedTokensAvoided = 0;
    let redundantCallRate = 0;
    let notes = `artifact_dir=${artifactDir}`;

    if (mode === "tokenopt-codegraph") {
      try {
        const { client: cgClient, close: cgClose } = await createCodeGraphMcpClient(repo);
        try {
          const cgArgs = { task: task.prompt };
          const cgResult = await cgClient.callTool({ name: "codegraph_context", arguments: cgArgs });
          const cgText = toolText(cgResult);
          toolCalls += 1;
          mcpCalls += 1;
          toolInputChars += JSON.stringify(cgArgs).length;
          toolOutputChars += cgText.length;
          signals = mergeCodeGraphSignals(signals, cgText);
          notes = `${notes}; codegraph_chars=${cgText.length}`;
        } finally {
          await cgClose();
        }
      } catch (err) {
        notes = `${notes}; codegraph_error=${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const answer = renderAnswer(task, signals, mode);
    const quality = scoreAnswer(task, answer, signals);

    if (
      mode === "compiled-packet+gate" ||
      mode === "compiled-shadow-gate" ||
      mode === "router-shadow-gate" ||
      mode === "router-shadow-gate+compressors"
    ) {
      const redundantArgs = { pattern: task.redundantPattern, cwd: repo };
      const gated = await client.callTool({
        name: "tokenopt_search",
        arguments: redundantArgs
      });
      const gatedText = toolText(gated);
      toolCalls += 1;
      mcpCalls += 1;
      toolInputChars += JSON.stringify(redundantArgs).length;
      toolOutputChars += gatedText.length;
      fallbackAfterAnswerable = answerable && !/TokenOpt answerability gate/.test(gatedText) ? 1 : 0;
      const shadow = readShadowGateSummary(repo, artifactDir);
      estimatedTokensAvoided = shadow.estimatedTokensAvoided;
      redundantCallRate = toolCalls > 0 ? Number((shadow.redundantCalls / toolCalls).toFixed(3)) : 0;
      notes = `${notes}; gate_output_chars=${gatedText.length}`;
    }
    const routeDecision = packetRoute?.taskClass ?? route.taskClass;
    const routeReason = packetRoute?.reason ?? route.reason;
    const routerRegret = route.action === "bypass" && mode !== "router-best"
      ? "mcp_used_despite_bypass"
      : route.action === "exact_route" && answerable
        ? "compiled_exact_route"
        : "none";

    return buildRow({
      repo,
      task,
      mode,
      answerable,
      toolCalls,
      mcpCalls,
      shellCalls,
      toolInputChars,
      toolOutputChars,
      fallbackAfterAnswerable,
      estimatedTokensAvoided,
      redundantCallRate,
      routeDecision,
      routeReason,
      routerRegret,
      answer,
      quality,
      notes
    });
  } finally {
    await close();
  }
}

function buildRow(input: {
  repo: string;
  task: BenchmarkTask;
  mode: BenchmarkMode;
  answerable: boolean;
  toolCalls: number;
  mcpCalls: number;
  shellCalls: number;
  toolInputChars: number;
  toolOutputChars: number;
  fallbackAfterAnswerable: number;
  run?: number;
  estimatedTokensAvoided?: number;
  redundantCallRate?: number;
  routeDecision?: string;
  routeReason?: string;
  routerRegret?: string;
  answer: string;
  quality: QualityResult;
  notes: string;
}): BenchmarkRow {
  const promptTokens = estimateTokens(input.task.prompt);
  const toolInputTokens = estimateTokens(input.toolInputChars);
  const toolOutputTokens = estimateTokens(input.toolOutputChars);
  const finalOutputTokens = estimateTokens(input.answer);
  const estimatedInputTokens = promptTokens + toolInputTokens + toolOutputTokens;

  return {
    repo: input.repo,
    task: input.task.id,
    mode: input.mode,
    correct: input.quality.score >= 0.8,
    answerable: input.answerable,
    qualityScore: input.quality.score,
    qualityPassed: input.quality.score >= 0.8,
    qualityChecks: `${input.quality.passed}/${input.quality.total}`,
    toolCalls: input.toolCalls,
    mcpCalls: input.mcpCalls,
    shellCalls: input.shellCalls,
    toolInputChars: input.toolInputChars,
    toolOutputChars: input.toolOutputChars,
    finalOutputChars: input.answer.length,
    estimatedInputTokens,
    estimatedOutputTokens: finalOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + finalOutputTokens,
    fallbackAfterAnswerable: input.fallbackAfterAnswerable,
    run: input.run ?? 1,
    estimatedTokensAvoided: input.estimatedTokensAvoided ?? 0,
    redundantCallRate: input.redundantCallRate ?? 0,
    routeDecision: input.routeDecision ?? "unknown",
    routeReason: input.routeReason ?? "",
    routerRegret: input.routerRegret ?? "none",
    answer: input.answer,
    notes: `${input.notes}; failed_checks=${input.quality.checks.filter((check) => !check.passed).map((check) => check.name).join(",") || "none"}`
  };
}

function getCodeGraphCliPath(): string {
  const envPath = process.env.CODEGRAPH_CLI_PATH;
  if (envPath) return envPath;
  // assume sibling directory: <tokenopt>/../code-graph/dist/cli.js
  const tokenoptRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  return path.join(tokenoptRoot, "..", "code-graph", "dist", "cli.js");
}

async function createCodeGraphMcpClient(repo: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const cgCli = getCodeGraphCliPath();
  if (!fs.existsSync(cgCli)) {
    throw new Error(`CodeGraph CLI not found at ${cgCli}. Set CODEGRAPH_CLI_PATH env var.`);
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cgCli, "mcp", "--root", repo],
    cwd: repo,
    env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>
  });
  const client = new Client({ name: "tokenopt-benchmark-codegraph", version: "0.0.0" });
  await client.connect(transport);
  return { client, close: async () => { await client.close(); } };
}

function signalsFromCodeGraphText(text: string): Partial<RepoSignals> {
  // Try to extract from JSON-like structure
  const filePaths: string[] = [];
  const sourceDirs: string[] = [];
  const facts: string[] = [];

  // Extract file paths: patterns like "path": "src/..." or bare paths with extensions
  for (const match of text.matchAll(/"path"\s*:\s*"([^"]+\.\w{1,6})"/g)) {
    filePaths.push(match[1]);
  }
  for (const match of text.matchAll(/\b((?:src|backend|frontend|main\/java|test\/java|tests?)\/[\w/\-.]+\.\w{1,6})\b/g)) {
    if (!filePaths.includes(match[1])) filePaths.push(match[1]);
  }

  // Extract source_dirs
  for (const match of text.matchAll(/"source_dirs"\s*:\s*\[([^\]]+)\]/g)) {
    for (const part of match[1].split(",")) {
      const dir = part.replace(/[" \n\r]/g, "");
      if (dir) sourceDirs.push(dir);
    }
  }
  if (sourceDirs.length === 0) {
    for (const f of filePaths) {
      const parts = f.split("/");
      if (parts.length >= 2) sourceDirs.push(parts.slice(0, Math.min(3, parts.length - 1)).join("/"));
    }
  }

  // Extract _codegraph_meta counts
  const symMatch = text.match(/"symbols_returned"\s*:\s*(\d+)/);
  const fileMatch = text.match(/"files_returned"\s*:\s*(\d+)/);
  const edgeMatch = text.match(/"call_edges_returned"\s*:\s*(\d+)/);
  if (symMatch) facts.push(`codegraph_symbols_returned=${symMatch[1]}`);
  if (fileMatch) facts.push(`codegraph_files_returned=${fileMatch[1]}`);
  if (edgeMatch) facts.push(`codegraph_call_edges_returned=${edgeMatch[1]}`);

  return {
    facts,
    importantFiles: [...new Set(filePaths)].slice(0, 12),
    sourceDirs: [...new Set(sourceDirs)].slice(0, 6)
  };
}

function mergeCodeGraphSignals(base: RepoSignals, cgText: string): RepoSignals {
  const cg = signalsFromCodeGraphText(cgText);
  return {
    ...base,
    facts: [...base.facts, ...(cg.facts ?? [])],
    importantFiles: [...new Set([...base.importantFiles, ...(cg.importantFiles ?? [])])].slice(0, 20),
    sourceDirs: base.sourceDirs.length > 0
      ? base.sourceDirs
      : (cg.sourceDirs ?? [])
  };
}

async function runCodeGraphOnly(repo: string, task: BenchmarkTask): Promise<BenchmarkRow> {
  const mode: BenchmarkMode = "codegraph-only";
  const { client, close } = await createCodeGraphMcpClient(repo);
  const cgArgs = { task: task.prompt };
  try {
    const cgResult = await client.callTool({ name: "codegraph_context", arguments: cgArgs });
    const cgText = toolText(cgResult);
    const cgPartial = signalsFromCodeGraphText(cgText);
    const signals: RepoSignals = {
      facts: cgPartial.facts ?? [],
      topDirs: cgPartial.sourceDirs ?? [],
      sourceDirs: cgPartial.sourceDirs ?? [],
      testDirs: [],
      configFiles: [],
      importantFiles: cgPartial.importantFiles ?? [],
      rootFiles: []
    };
    const answer = renderAnswer(task, signals, mode);
    const quality = scoreAnswer(task, answer, signals);
    const toolInputChars = JSON.stringify(cgArgs).length;
    const toolOutputChars = cgText.length;
    const estTokens = estimateTokens(toolInputChars + toolOutputChars + answer.length);
    return buildRow({
      repo,
      task,
      mode,
      answerable: true,
      toolCalls: 1,
      mcpCalls: 1,
      shellCalls: 0,
      toolInputChars,
      toolOutputChars,
      fallbackAfterAnswerable: 0,
      estimatedTokensAvoided: 0,
      redundantCallRate: 0,
      routeDecision: "codegraph",
      routeReason: "codegraph-only mode",
      routerRegret: "none",
      answer,
      quality,
      notes: `codegraph_chars=${cgText.length}`
    });
  } finally {
    await close();
  }
}

async function createMcpClient(
  repo: string,
  artifactDir: string,
  envOverrides: NodeJS.ProcessEnv = {}
): Promise<{ client: Client; close: () => Promise<void> }> {
  const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "mcp"],
    cwd: repo,
    env: {
      ...process.env,
      ...envOverrides,
      TOKENOPT_ARTIFACT_DIR: artifactDir
    }
  });
  const client = new Client({ name: "tokenopt-benchmark", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
    }
  };
}

function countRepoFiles(repo: string): number {
  const rg = spawnSync("rg", ["--files"], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32"
  });
  if (rg.status === 0 && rg.stdout) {
    return rg.stdout.split(/\r?\n/).filter(Boolean).length;
  }
  return readAllFiles(repo).length;
}

function readAllFiles(root: string): string[] {
  const result: string[] = [];
  const stack = [root];
  while (stack.length > 0 && result.length < 20_000) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
      } else if (entry.isFile()) {
        result.push(path.relative(root, absolute));
      }
    }
  }
  return result;
}

function readShadowGateSummary(repo: string, artifactDir: string): { estimatedTokensAvoided: number; redundantCalls: number } {
  const loaded = loadConfig({
    cwd: repo,
    env: {
      ...process.env,
      TOKENOPT_ARTIFACT_DIR: artifactDir
    }
  });
  const events = readRepoEvents(loaded.config, loaded.repoRoot);
  let estimatedTokensAvoided = 0;
  let redundantCalls = 0;
  for (const event of events) {
    const shadow = (event.metadata as { shadowGate?: { wouldDeny?: boolean; estimatedTokensAvoided?: number } } | undefined)?.shadowGate;
    if (!shadow?.wouldDeny) {
      continue;
    }
    estimatedTokensAvoided += shadow.estimatedTokensAvoided ?? 0;
    redundantCalls += 1;
  }
  return { estimatedTokensAvoided, redundantCalls };
}

function readBaselineFiles(repo: string): Array<{ relativePath: string; text: string }> {
  return [
    "README.md",
    "README.asciidoc",
    "README.adoc",
    "README",
    "package.json",
    "pom.xml",
    "settings.gradle",
    "settings.gradle.kts",
    "build.gradle",
    "build.gradle.kts",
    "gradle.properties",
    "gradle/wrapper/gradle-wrapper.properties",
    ".mvn/wrapper/maven-wrapper.properties",
    "build-tools-internal/version.properties"
  ].flatMap((relativePath) => {
    const filePath = path.join(repo, relativePath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return [];
    }
    return [{ relativePath, text: fs.readFileSync(filePath, "utf8") }];
  });
}

function signalsFromBaseline(
  repo: string,
  rawInventory: string,
  files: Array<{ relativePath: string; text: string }>
): RepoSignals {
  const fileList = rawInventory.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const facts = extractFactsFromBaselineFiles(repo, files);
  const overview = extractOverviewFromFiles(files);
  const structure = structureFromFiles(fileList);
  return {
    facts,
    buildTool: firstFactValue(facts, "build_tool"),
    projectName: firstProjectName(facts) ?? overview?.title,
    overviewTitle: overview?.title,
    overviewSummary: overview?.summary,
    overviewFile: overview?.file,
    ...structure
  };
}

function signalsFromCompiledPacket(text: string): RepoSignals {
  const fullFacts = [...text.matchAll(/^\s*fact:\s*(.+)$/gm)].map((match) => match[1].trim());
  const compactFacts = [...text.matchAll(/^\s*facts=(.+)$/gm)].flatMap((match) =>
    match[1].split("|").map((item) => item.trim()).filter(Boolean)
  );
  const facts = [...new Set([...fullFacts, ...compactFacts])];
  const topDirs = splitFactList(firstFactValue(facts, "top_dirs")).map((item) => item.replace(/:\d+$/, ""));
  const sourceDirs = splitFactList(firstFactValue(facts, "source_dirs")).map((item) => item.replace(/:\d+$/, ""));
  const testDirs = splitFactList(firstFactValue(facts, "test_dirs")).map((item) => item.replace(/:\d+$/, ""));
  const configFiles = splitFactList(firstFactValue(facts, "config_files"));
  const importantFiles = splitFactList(firstFactValue(facts, "important_file_sample"));
  const overviewTitle = firstFactValue(facts, "overview_title");
  const overviewSummary = firstFactValue(facts, "overview_summary");
  const overviewFile = firstFactValue(facts, "overview_file");
  // Extract rootFiles from important_file_sample — filter to entries with no directory separator
  const rootFiles = importantFiles.filter((f) => !f.includes("/") && !f.includes("\\")).slice(0, 20);
  return {
    facts,
    buildTool: firstFactValue(facts, "build_tool"),
    projectName: firstProjectName(facts) ?? overviewTitle,
    overviewTitle,
    overviewSummary,
    overviewFile,
    topDirs,
    sourceDirs,
    testDirs,
    configFiles,
    importantFiles,
    rootFiles
  };
}

function extractFactsFromBaselineFiles(repo: string, files: Array<{ relativePath: string; text: string }>): string[] {
  const facts: string[] = [];
  const byPath = new Map(files.map((file) => [file.relativePath.replace(/\\/g, "/"), file.text]));
  const gradleWrapper = byPath.get("gradle/wrapper/gradle-wrapper.properties");
  if (gradleWrapper) {
    const url = matchFirst(gradleWrapper, /^distributionUrl=(.+)$/m);
    const version = url ? matchFirst(url, /gradle-([0-9][^-]+)-(?:all|bin)\.zip/) : undefined;
    facts.push("build_tool=Gradle");
    facts.push("gradle_wrapper_file=gradle/wrapper/gradle-wrapper.properties");
    if (version) {
      facts.push(`gradle_wrapper_version=${version}`);
    }
  }

  const settingsGradle = byPath.get("settings.gradle") ?? byPath.get("settings.gradle.kts");
  if (settingsGradle) {
    const rootName = matchFirst(settingsGradle, /rootProject\.name\s*=\s*["']([^"']+)["']/);
    if (rootName) {
      facts.push(`gradle_root_project=${rootName}`);
    }
  }

  const elasticVersions = byPath.get("build-tools-internal/version.properties");
  if (elasticVersions) {
    const elasticVersion = matchFirst(elasticVersions, /^elasticsearch\s*=\s*(.+)$/m);
    const luceneVersion = matchFirst(elasticVersions, /^lucene\s*=\s*(.+)$/m);
    if (elasticVersion) {
      facts.push(`elasticsearch_version=${elasticVersion.trim()}`);
    }
    if (luceneVersion) {
      facts.push(`lucene_version=${luceneVersion.trim()}`);
    }
  }

  const pom = byPath.get("pom.xml");
  if (pom) {
    const projectBlock = pom.slice(0, Math.min(pom.length, 20_000));
    facts.push("build_tool=Maven");
    facts.push("maven_root_file=pom.xml");
    for (const [name, pattern] of [
      ["maven_group_id", /<groupId>([^<]+)<\/groupId>/],
      ["maven_artifact_id", /<artifactId>([^<]+)<\/artifactId>/],
      ["maven_project_version", /<version>([^<]+)<\/version>/],
      ["maven_packaging", /<packaging>([^<]+)<\/packaging>/],
      ["hadoop_version", /<hadoop\.version>([^<]+)<\/hadoop\.version>/]
    ] as const) {
      const value = matchFirst(projectBlock, pattern);
      if (value) {
        facts.push(`${name}=${value}`);
      }
    }
  }

  const mavenWrapper = byPath.get(".mvn/wrapper/maven-wrapper.properties");
  if (mavenWrapper) {
    const wrapperVersion = matchFirst(mavenWrapper, /^wrapperVersion=(.+)$/m);
    const distributionUrl = matchFirst(mavenWrapper, /^distributionUrl=(.+)$/m);
    facts.push("maven_wrapper_file=.mvn/wrapper/maven-wrapper.properties");
    if (wrapperVersion) {
      facts.push(`maven_wrapper_version=${wrapperVersion}`);
    }
    if (distributionUrl) {
      facts.push(`maven_distribution_url=${distributionUrl}`);
    }
  }

  const packageJson = byPath.get("package.json");
  if (packageJson) {
    try {
      const parsed = JSON.parse(packageJson) as { name?: unknown; version?: unknown; packageManager?: unknown; scripts?: unknown };
      facts.push("build_tool=Npm");
      facts.push("npm_root_file=package.json");
      if (typeof parsed.name === "string") {
        facts.push(`npm_package_name=${parsed.name}`);
      }
      if (typeof parsed.version === "string") {
        facts.push(`npm_package_version=${parsed.version}`);
      }
      if (typeof parsed.packageManager === "string") {
        facts.push(`npm_package_manager=${parsed.packageManager}`);
      }
      if (parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)) {
        facts.push(`npm_scripts=${Object.keys(parsed.scripts).sort().join(",")}`);
      }
      for (const lockFile of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
        if (fs.existsSync(path.join(repo, lockFile))) {
          facts.push(`npm_lock_file=${lockFile}`);
          break;
        }
      }
    } catch {
      facts.push("npm_package_json_parse_error=true");
    }
  }
  return facts;
}

function extractOverviewFromFiles(files: Array<{ relativePath: string; text: string }>): { file: string; title: string; summary: string } | undefined {
  const readme = files.find((file) => /^README(?:\.(md|adoc|asciidoc))?$/i.test(path.basename(file.relativePath)));
  if (!readme) {
    return undefined;
  }
  const lines = readme.text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(<!--|!\[|\[!)/.test(line));
  const title = cleanLine(lines.find((line) => /^#{1,2}\s+/.test(line) || /^=+\s+/.test(line)) ?? lines[0] ?? path.basename(readme.relativePath));
  const summary = cleanLine(
    lines.find((line) => !/^#{1,6}\s+/.test(line) && !/^=+\s+/.test(line) && line.length >= 40) ?? lines.slice(1, 4).join(" ")
  );
  return {
    file: readme.relativePath,
    title: title.slice(0, 160),
    summary: summary.slice(0, 500)
  };
}

function structureFromFiles(files: string[]): Pick<RepoSignals, "topDirs" | "sourceDirs" | "testDirs" | "configFiles" | "importantFiles" | "rootFiles"> {
  const normalized = files.map((file) => file.replace(/\\/g, "/"));
  const importantFiles = normalized.filter(isImportantFile).slice(0, 80);
  const sourceDirs = topCounts(
    normalized
      .filter((file) => /\.(ts|tsx|js|jsx|java|py|go|rs|kt|scala|c|cc|cpp|h|hpp)$/i.test(file))
      .map((file) => file.split("/").slice(0, 2).join("/") || "<root>"),
    12
  ).map(([name]) => name);
  const testDirs = topCounts(
    normalized
      .filter((file) => /(^|\/)(test|tests|src\/test|qa|__tests__)(\/|$)|\.(test|spec)\.(ts|tsx|js|jsx)$/i.test(file))
      .map((file) => file.split("/").slice(0, 3).join("/") || "<root>"),
    12
  ).map(([name]) => name);
  const topDirs = topCounts(normalized.map((file) => file.split("/", 1)[0] || "<root>"), 12).map(([name]) => name);
  const configFiles = normalized
    .filter((file) => /(^|\/)(package\.json|pom\.xml|build\.gradle|settings\.gradle|gradle\.properties|pyproject\.toml|go\.mod|Cargo\.toml|tsconfig\.json)$/i.test(file))
    .slice(0, 20);
  const rootFiles = normalized.filter((file) => !file.includes("/")).slice(0, 30);
  return { topDirs, sourceDirs, testDirs, configFiles, importantFiles, rootFiles };
}

function renderAnswer(task: BenchmarkTask, signals: RepoSignals, mode: BenchmarkMode): string {
  const buildTool = signals.buildTool ?? "unknown";
  const project = signals.projectName ?? path.basename(process.cwd());
  const evidence = compactList([
    ...signals.facts.slice(0, 8),
    signals.overviewFile ? `overview=${signals.overviewFile}` : undefined,
    signals.sourceDirs.length > 0 ? `source_dirs=${signals.sourceDirs.slice(0, 4).join(",")}` : undefined,
    signals.testDirs.length > 0 ? `test_dirs=${signals.testDirs.slice(0, 4).join(",")}` : undefined
  ]);

  if (task.id === "build-handoff") {
    return [
      `Task: ${task.label}`,
      `Mode: ${mode}`,
      `Project: ${project}`,
      `Build tool: ${buildTool}`,
      `Build facts: ${signals.facts.slice(0, 10).join("; ") || "not detected"}`,
      `Recommended targeted command: ${targetedTestCommand(signals)}`,
      `Evidence: ${evidence}`
    ].join("\n");
  }

  if (task.id === "investigate") {
    return [
      `Task: ${task.label}`,
      `Mode: ${mode}`,
      `Project: ${project}`,
      `Investigation hypotheses: build configuration mismatch, stale generated output, or failing targeted tests near changed code.`,
      `Exact first commands: ${targetedTestCommand(signals)}; inspect ${compactList(signals.configFiles.slice(0, 4)) || "root build files"}.`,
      `Evidence: build_tool=${buildTool}; ${evidence}`
    ].join("\n");
  }

  if (task.id === "research-business") {
    return [
      `Task: ${task.label}`,
      `Mode: ${mode}`,
      `Repository purpose: ${signals.overviewSummary || signals.overviewTitle || `Project identity inferred from ${project}.`}`,
      `Project/domain: ${project}`,
      `Major areas: ${compactList(signals.topDirs.slice(0, 8)) || compactList(signals.sourceDirs.slice(0, 8)) || "not detected"}`,
      `Confidence/caveats: derived from README/build metadata and top-level inventory, not from external market research.`,
      `Evidence: ${evidence}`
    ].join("\n");
  }

  if (task.id === "implement") {
    return [
      `Task: ${task.label}`,
      `Mode: ${mode}`,
      `Project: ${project}`,
      `Implementation plan: inspect the nearest module under ${compactList(signals.sourceDirs.slice(0, 4)) || "the main source tree"}, make the smallest scoped change, then run targeted tests.`,
      `Files to inspect: ${compactList([...signals.configFiles, ...signals.importantFiles].slice(0, 8)) || "not detected"}`,
      `Test strategy: ${targetedTestCommand(signals)}`,
      `Risks: large repo conventions, generated code, and broad test suites should be avoided until a targeted test passes.`,
      `Evidence: build_tool=${buildTool}; ${evidence}`
    ].join("\n");
  }

  if (task.id === "review-diff") {
    const affectedModules = compactList(signals.sourceDirs.slice(0, 4)) || compactList(signals.topDirs.slice(0, 4)) || "not detected";
    const keyFiles = compactList(signals.importantFiles.slice(0, 6)) || "not detected";
    return [
      `Task: ${task.label}`,
      `Mode: ${mode}`,
      `Affected modules: ${affectedModules}`,
      `Business rules touched: domain logic in ${project}; changes to ${affectedModules} may affect business invariants — verify against requirement.`,
      `Key files: ${keyFiles}`,
      `Missing cases / risks: edge cases around boundary conditions and error paths should be verified; confirm integration tests cover the changed behavior.`,
      `Breaking changes: check callers of changed symbols in ${affectedModules}; any public API change needs downstream review.`,
      `Evidence: ${evidence}`
    ].join("\n");
  }

  return [
    `Task: ${task.label}`,
    `Mode: ${mode}`,
    `Unit test plan: add or update tests near ${compactList(signals.testDirs.slice(0, 5)) || compactList(signals.sourceDirs.slice(0, 5)) || "the changed module"}.`,
    `Targeted test command: ${targetedTestCommand(signals)}`,
    `Assertions to cover: success path, regression case, and boundary/error handling for the changed behavior.`,
    `Build context: build_tool=${buildTool}; project=${project}`,
    `Evidence: ${evidence}`
  ].join("\n");
}

function scoreAnswer(task: BenchmarkTask, answer: string, signals: RepoSignals): QualityResult {
  const checks: Array<{ name: string; passed: boolean }> = [
    { name: "has_evidence", passed: /Evidence:/i.test(answer) && signals.facts.length + signals.importantFiles.length > 0 },
    { name: "has_project_context", passed: /Project:|Project\/domain:|project=/i.test(answer) },
    { name: "not_unknown_build_when_required", passed: task.id === "research-business" || signals.buildTool !== undefined }
  ];

  if (task.id === "build-handoff") {
    checks.push(
      { name: "build_tool", passed: /Build tool:\s*(Gradle|Maven|Npm)/.test(answer) },
      { name: "build_facts", passed: /Build facts:.*(wrapper|root_file|version|scripts|root_project)/i.test(answer) },
      { name: "targeted_command", passed: /Recommended targeted command:/i.test(answer) }
    );
  } else if (task.id === "investigate") {
    checks.push(
      { name: "hypotheses", passed: /hypotheses/i.test(answer) },
      { name: "exact_commands", passed: /Exact first commands:/i.test(answer) },
      { name: "repo_evidence", passed: /build_tool=|source_dirs=|test_dirs=/i.test(answer) }
    );
  } else if (task.id === "research-business") {
    checks.push(
      { name: "purpose", passed: /Repository purpose:/i.test(answer) && Boolean(signals.overviewSummary || signals.projectName) },
      { name: "domain", passed: /Project\/domain:/i.test(answer) },
      { name: "major_areas", passed: /Major areas:/i.test(answer) && (signals.topDirs.length > 0 || signals.sourceDirs.length > 0) }
    );
  } else if (task.id === "implement") {
    checks.push(
      { name: "implementation_plan", passed: /Implementation plan:/i.test(answer) },
      { name: "files_to_inspect", passed: /Files to inspect:/i.test(answer) && signals.configFiles.length + signals.importantFiles.length > 0 },
      { name: "test_strategy", passed: /Test strategy:/i.test(answer) },
      { name: "risks", passed: /Risks:/i.test(answer) }
    );
  } else if (task.id === "review-diff") {
    checks.push(
      { name: "affected_modules", passed: /Affected modules:/i.test(answer) && (signals.sourceDirs.length > 0 || signals.topDirs.length > 0) },
      { name: "business_rules", passed: /Business rules touched:/i.test(answer) },
      { name: "key_files", passed: /Key files:/i.test(answer) && signals.importantFiles.length > 0 },
      { name: "missing_cases_or_risks", passed: /Missing cases|risks/i.test(answer) },
      { name: "breaking_changes", passed: /Breaking changes:/i.test(answer) }
    );
  } else {
    checks.push(
      { name: "test_locations", passed: /Unit test plan:/i.test(answer) && (signals.testDirs.length > 0 || signals.sourceDirs.length > 0) },
      { name: "targeted_test_command", passed: /Targeted test command:/i.test(answer) },
      { name: "assertions", passed: /Assertions to cover:/i.test(answer) },
      { name: "build_context", passed: /Build context:.*build_tool=/i.test(answer) }
    );
  }

  const passed = checks.filter((check) => check.passed).length;
  return {
    score: Number((passed / checks.length).toFixed(3)),
    passed,
    total: checks.length,
    checks
  };
}

function hasMinimumSignals(task: BenchmarkTask, signals: RepoSignals): boolean {
  if (task.id === "research-business") {
    return Boolean(signals.overviewSummary || signals.projectName || signals.topDirs.length > 0);
  }
  if (task.id === "implement") {
    return Boolean(signals.buildTool && signals.sourceDirs.length > 0);
  }
  if (task.id === "write-unittest") {
    return Boolean(signals.buildTool && (signals.testDirs.length > 0 || signals.sourceDirs.length > 0));
  }
  if (task.id === "review-diff") {
    return Boolean(signals.sourceDirs.length > 0 || signals.topDirs.length > 0);
  }
  return Boolean(signals.buildTool);
}

function targetedTestCommand(signals: RepoSignals): string {
  if (signals.buildTool === "Gradle") {
    return "./gradlew test --tests <ExactTestClass>";
  }
  if (signals.buildTool === "Maven") {
    return "mvn -pl <module> -Dtest=<ExactTestClass> test";
  }
  if (signals.buildTool === "Npm") {
    const scripts = firstFactValue(signals.facts, "npm_scripts") ?? "";
    if (scripts.split(",").includes("test")) {
      return "npm test -- <exact-test-file-or-name>";
    }
    return "npm run <targeted-script>";
  }
  return "run a targeted test for the exact changed module";
}

function isImportantFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = path.basename(normalized).toLowerCase();
  if (/^(readme|package|pom|build\.gradle|settings\.gradle|gradle\.properties|tsconfig|eslint|vite|webpack|cargo|go\.mod|pyproject|requirements)/i.test(base)) {
    return true;
  }
  return /(^|\/)(src|server|client|app|lib|core|modules|docs|test|tests|qa)\//i.test(normalized) && /\.(ts|tsx|js|jsx|java|py|go|rs|md|asciidoc)$/i.test(base);
}

function toolText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((item) => (typeof item.text === "string" ? item.text : "")).join("\n");
}

function firstFactValue(facts: string[], key: string): string | undefined {
  return facts.find((fact) => fact.startsWith(`${key}=`))?.slice(key.length + 1);
}

function firstProjectName(facts: string[]): string | undefined {
  return (
    firstFactValue(facts, "gradle_root_project") ??
    firstFactValue(facts, "maven_artifact_id") ??
    firstFactValue(facts, "npm_package_name")
  );
}

function splitFactList(value: string | undefined): string[] {
  if (!value || value === "none_detected") {
    return [];
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function compactList(values: Array<string | undefined>): string {
  return values.filter((value): value is string => Boolean(value && value !== "none_detected")).join(", ");
}

function shuffle<T>(items: T[], seed: string): T[] {
  const result = [...items];
  let state = hashSeed(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swapIndex = state % (index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function topCounts(values: string[], limit: number): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

function cleanLine(line: string): string {
  return line.replace(/^#{1,6}\s+/, "").replace(/^=+\s+/, "").replace(/\s+/g, " ").trim();
}

function matchFirst(text: string, pattern: RegExp): string | undefined {
  return text.match(pattern)?.[1]?.trim();
}

function formatBenchmark(rows: BenchmarkRow[], showAnswers: boolean): string {
  const header = [
    "Repo",
    "Run",
    "Task",
    "Mode",
    "Quality",
    "Checks",
    "Correct",
    "Answerable",
    "Tool calls",
    "MCP",
    "Shell",
    "Tool in",
    "Tool out",
    "Final out",
    "Input tok",
    "Output tok",
    "Total tok",
    "Fallback",
    "Avoided tok",
    "Redundant",
    "Route",
    "Regret"
  ];
  const body = rows.map((row) => [
    path.basename(row.repo),
    String(row.run),
    row.task,
    row.mode,
    row.qualityScore.toFixed(3),
    row.qualityChecks,
    row.correct ? "yes" : "no",
    row.answerable ? "yes" : "no",
    String(row.toolCalls),
    String(row.mcpCalls),
    String(row.shellCalls),
    String(row.toolInputChars),
    String(row.toolOutputChars),
    String(row.finalOutputChars),
    String(row.estimatedInputTokens),
    String(row.estimatedOutputTokens),
    String(row.estimatedTotalTokens),
    String(row.fallbackAfterAnswerable),
    String(row.estimatedTokensAvoided),
    row.redundantCallRate.toFixed(3),
    row.routeDecision,
    row.routerRegret
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
  return `${lines.join("\n")}\n\nAnswers:\n${rows.map((row) => `\n[${path.basename(row.repo)} ${row.task} ${row.mode}]\n${row.answer}`).join("\n")}\n`;
}

function benchmarkHelp(): string {
  return `Usage:
  tokenopt benchmark daily --repo <path> [--repo <path>] [--task all|build-handoff|investigate|research-business|implement|write-unittest|review-diff] [--mode baseline|compiled-packet|compiled-shadow-gate|compiled-packet+gate|router-best|router-shadow-gate|router-shadow-gate+compressors|gold-packet|oracle-packet|all] [--repeat <n>] [--randomize] [--json] [--show-answers] [--out <path>]
`;
}
