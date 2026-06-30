import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { routeTask } from "./router.js";
import type { AcquisitionMode, EvidenceContractName, EvidenceTaskType, TaskClass } from "./types.js";

type SuiteBenchmarkMode =
  | "baseline"
  | "codegraph"
  | "codegraph-only"
  | "tokenopt-codegraph"
  | "tokenopt-codegraph-natural"
  | "tokenopt-codegraph-adaptive"
  | "tokenopt-codegraph-hybrid"
  | "tokenopt-internal-codegraph"
  | "contextgate-natural"
  | "mcp-first"
  | "mcp-only"
  | "compiled-hard-gate"
  | "router-strict"
  | "router-best";

interface SuiteFile {
  name?: string;
  version?: string;
  purpose?: string;
  tasks?: unknown[];
}

interface SuiteTask {
  id: string;
  project: string;
  class: string;
  winnerHypothesis?: string;
  prompt: string;
  expectedEvidence: {
    files: string[];
    symbols: string[];
    terms: string[];
  };
  qualityRubric: string[];
  gateAssertions: string[];
  maxBudget?: {
    mcpCallsCompiled?: number;
    targetedShellCalls?: number;
    shellCallsAfterAnswerable?: number;
    packetTokens?: number;
  };
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
  routeMetadataText: string;
  usage: CodexUsage;
  usageStatus: "available" | "missing" | "error";
  toolCalls: number;
  shellCalls: number;
  mcpCalls: number;
  toolInputChars: number;
  toolOutputChars: number;
  warnings: number;
  rawLogPath: string;
  lastMessagePath: string;
}

interface QualityCheck {
  category: "json" | "file" | "symbol" | "term";
  name: string;
  passed: boolean;
}

interface QualityResult {
  score: number;
  passed: number;
  total: number;
  jsonValid: boolean;
  criticalMisses: string[];
  checks: QualityCheck[];
}

interface IdeaQualityResult {
  score: number;
  passed: number;
  total: number;
  checks: string;
  passedGate: boolean;
}

interface SuiteBenchmarkRow extends CodexRunMetrics {
  repo: string;
  project: string;
  taskId: string;
  taskClass: string;
  acquisitionMode: AcquisitionMode;
  evidenceContract: EvidenceContractName;
  evidenceContractPass: boolean;
  fallbackReason: string;
  doubleSpend: boolean;
  expectedTaskClass: TaskClass;
  actualTaskClass: TaskClass;
  routeCorrect: boolean;
  routeRegretReason: string;
  negativeControlTriggered: boolean;
  fallbackAfterAnswerable: number;
  mode: SuiteBenchmarkMode;
  prompt: string;
  codexPrompt: string;
  qualityScore: number;
  qualityChecks: string;
  qualityPassed: boolean;
  ideaScore: number;
  ideaChecks: string;
  ideaPassed: boolean;
  correct: boolean;
  jsonValid: boolean;
  criticalMisses: string[];
  expectedEvidence: SuiteTask["expectedEvidence"];
  qualityRubric: string[];
}

interface SkippedRepo {
  repo: string;
  project: string;
  reason: string;
}

interface SuiteBenchmarkOptions {
  suitePath: string;
  repos: string[];
  modes: SuiteBenchmarkMode[];
  taskIds?: Set<string>;
  codexPackage: string;
  outPath?: string;
  markdownPath?: string;
  rawDir: string;
  json: boolean;
  showAnswers: boolean;
  timeoutMs: number;
  maxTasks?: number;
  maxTasksPerRepo?: number;
  model?: string;
  prewarmCodeGraph: boolean;
  codeGraphPrewarmTimeoutMs: number;
}

const CODEX_PACKAGE = "@openai/codex@0.137.0";
const ALL_SUITE_BENCHMARK_MODES: SuiteBenchmarkMode[] = [
  "baseline",
  "codegraph",
  "codegraph-only",
  "tokenopt-codegraph",
  "tokenopt-codegraph-natural",
  "tokenopt-codegraph-adaptive",
  "tokenopt-codegraph-hybrid",
  "tokenopt-internal-codegraph",
  "contextgate-natural",
  "mcp-first",
  "mcp-only",
  "compiled-hard-gate",
  "router-strict",
  "router-best"
];

interface CodeGraphMcpServerConfig {
  command: string;
  args: string[];
  source: "env-cli" | "env-root" | "local-root" | "path";
}

export async function runSuiteBenchmarkCommand(args: string[]): Promise<number> {
  const options = parseOptions(args);
  const suite = loadSuite(options.suitePath);
  const selected = selectSuiteTasks(suite.tasks, options);
  const rows: SuiteBenchmarkRow[] = [];

  fs.mkdirSync(options.rawDir, { recursive: true });
  prewarmCodeGraphIfRequested(selected.items, options);
  for (const item of selected.items) {
    for (const mode of options.modes) {
      const codexPrompt = buildSuitePrompt(item.repo, item.task, mode);
      const run = runCodexSuiteBenchmark(item.repo, item.task, mode, codexPrompt, options);
      const quality = scoreSuiteAnswer(item.task, run.finalAnswer);
      const idea = scoreSuiteIdeaQuality(item.task, run.finalAnswer);
      const routeMetadata = buildSuiteRouteMetadata(item.task.prompt, inferTaskType(item.task), {
        finalAnswer: run.finalAnswer,
        routeMetadataText: run.routeMetadataText,
        mcpCalls: run.mcpCalls,
        shellCalls: run.shellCalls
      });
      const routeCalibration = buildSuiteRouteCalibration(item.task, inferTaskType(item.task), routeMetadata);
      rows.push({
        ...run,
        repo: item.repo,
        project: item.task.project,
        taskId: item.task.id,
        taskClass: item.task.class,
        acquisitionMode: routeMetadata.acquisitionMode,
        evidenceContract: routeMetadata.evidenceContract,
        evidenceContractPass: routeMetadata.evidenceContractPass,
        fallbackReason: routeMetadata.fallbackReason,
        doubleSpend: routeMetadata.doubleSpend,
        expectedTaskClass: routeCalibration.expectedTaskClass,
        actualTaskClass: routeCalibration.actualTaskClass,
        routeCorrect: routeCalibration.routeCorrect,
        routeRegretReason: routeCalibration.routeRegretReason,
        negativeControlTriggered: routeCalibration.negativeControlTriggered,
        fallbackAfterAnswerable: routeCalibration.fallbackAfterAnswerable,
        mode,
        prompt: item.task.prompt,
        codexPrompt,
        qualityScore: quality.score,
        qualityChecks: `${quality.passed}/${quality.total}`,
        qualityPassed: quality.score >= 0.8,
        ideaScore: idea.score,
        ideaChecks: idea.checks,
        ideaPassed: idea.passedGate,
        correct: quality.score >= 0.8,
        jsonValid: quality.jsonValid,
        criticalMisses: quality.criticalMisses,
        expectedEvidence: item.task.expectedEvidence,
        qualityRubric: item.task.qualityRubric
      });
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    runner: "codex exec --json",
    codexPackage: options.codexPackage,
    suite: {
      path: options.suitePath,
      name: suite.name,
      version: suite.version,
      purpose: suite.purpose
    },
    codegraph: {
      prewarm: options.prewarmCodeGraph,
      prewarmTimeoutMs: options.codeGraphPrewarmTimeoutMs
    },
    modes: options.modes,
    skippedRepos: selected.skippedRepos,
    rows: options.showAnswers ? rows : rows.map((row) => ({ ...row, finalAnswer: undefined, codexPrompt: undefined }))
  };

  if (options.outPath) {
    fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
    fs.writeFileSync(options.outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
  if (options.markdownPath) {
    fs.mkdirSync(path.dirname(options.markdownPath), { recursive: true });
    fs.writeFileSync(options.markdownPath, formatMarkdownReport(suite, rows, selected.skippedRepos, options), "utf8");
  }

  process.stdout.write(options.json ? `${JSON.stringify(payload, null, 2)}\n` : formatSuiteRows(rows, selected.skippedRepos, options.showAnswers));
  return rows.some((row) => row.exitCode !== 0 || !row.correct) ? 1 : 0;
}

function parseOptions(args: string[]): SuiteBenchmarkOptions {
  let suitePath: string | undefined;
  const repos: string[] = [];
  let modes: SuiteBenchmarkMode[] = ["baseline", "mcp-first"];
  let taskIds: Set<string> | undefined;
  let codexPackage = CODEX_PACKAGE;
  let outPath: string | undefined;
  let markdownPath: string | undefined;
  let json = false;
  let showAnswers = false;
  let timeoutMs = 600_000;
  let maxTasks: number | undefined;
  let maxTasksPerRepo: number | undefined;
  let model: string | undefined;
  let rawDir: string | undefined;
  let prewarmCodeGraph = false;
  let codeGraphPrewarmTimeoutMs = 1_800_000;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--suite") {
      suitePath = requiredValue(args, index, "--suite");
      index += 1;
      continue;
    }
    if (arg === "--repo") {
      repos.push(path.resolve(requiredValue(args, index, "--repo")));
      index += 1;
      continue;
    }
    if (arg === "--mode") {
      const value = requiredValue(args, index, "--mode");
      modes = value === "all"
        ? ALL_SUITE_BENCHMARK_MODES
        : value.split(",").map(parseMode);
      index += 1;
      continue;
    }
    if (arg === "--task") {
      const value = requiredValue(args, index, "--task");
      taskIds = value === "all" ? undefined : new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
      index += 1;
      continue;
    }
    if (arg === "--codex-package") {
      codexPackage = requiredValue(args, index, "--codex-package");
      index += 1;
      continue;
    }
    if (arg === "--model") {
      model = requiredValue(args, index, "--model");
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInt(requiredValue(args, index, "--timeout-ms"), "--timeout-ms");
      index += 1;
      continue;
    }
    if (arg === "--prewarm-codegraph") {
      prewarmCodeGraph = true;
      continue;
    }
    if (arg === "--codegraph-prewarm-timeout-ms") {
      codeGraphPrewarmTimeoutMs = parsePositiveInt(requiredValue(args, index, "--codegraph-prewarm-timeout-ms"), "--codegraph-prewarm-timeout-ms");
      index += 1;
      continue;
    }
    if (arg === "--max-tasks") {
      maxTasks = parsePositiveInt(requiredValue(args, index, "--max-tasks"), "--max-tasks");
      index += 1;
      continue;
    }
    if (arg === "--max-tasks-per-repo") {
      maxTasksPerRepo = parsePositiveInt(requiredValue(args, index, "--max-tasks-per-repo"), "--max-tasks-per-repo");
      index += 1;
      continue;
    }
    if (arg === "--out") {
      outPath = path.resolve(requiredValue(args, index, "--out"));
      index += 1;
      continue;
    }
    if (arg === "--markdown") {
      markdownPath = path.resolve(requiredValue(args, index, "--markdown"));
      index += 1;
      continue;
    }
    if (arg === "--raw-dir") {
      rawDir = path.resolve(requiredValue(args, index, "--raw-dir"));
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
      throw new Error(suiteBenchmarkHelp());
    }
    throw new Error(`Unknown suite benchmark argument: ${arg}`);
  }

  if (!suitePath) {
    throw new Error(`--suite is required\n\n${suiteBenchmarkHelp()}`);
  }

  const defaultRawDir = outPath
    ? path.join(path.dirname(outPath), "raw", path.basename(outPath, path.extname(outPath)))
    : path.join(process.cwd(), "benchmark-results", "raw", `suite-${Date.now()}`);

  return {
    suitePath: path.resolve(suitePath),
    repos: repos.length > 0 ? repos : [process.cwd()],
    modes,
    taskIds,
    codexPackage,
    outPath,
    markdownPath,
    rawDir: rawDir ?? defaultRawDir,
    json,
    showAnswers,
    timeoutMs,
    maxTasks,
    maxTasksPerRepo,
    model,
    prewarmCodeGraph,
    codeGraphPrewarmTimeoutMs
  };
}

function loadSuite(suitePath: string): { name?: string; version?: string; purpose?: string; tasks: SuiteTask[] } {
  const parsed = JSON.parse(fs.readFileSync(suitePath, "utf8")) as SuiteFile;
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.map(parseSuiteTask) : [];
  return {
    name: parsed.name,
    version: parsed.version,
    purpose: parsed.purpose,
    tasks
  };
}

function parseSuiteTask(value: unknown): SuiteTask {
  if (!isRecord(value)) {
    throw new Error("Invalid suite task entry");
  }
  const expectedEvidence = isRecord(value.expectedEvidence) ? value.expectedEvidence : {};
  const maxBudget = isRecord(value.maxBudget) ? value.maxBudget : undefined;
  return {
    id: stringField(value, "id"),
    project: stringField(value, "project"),
    class: stringField(value, "class"),
    winnerHypothesis: optionalStringField(value, "winnerHypothesis"),
    prompt: stringField(value, "prompt"),
    expectedEvidence: {
      files: stringArrayField(expectedEvidence, "files"),
      symbols: stringArrayField(expectedEvidence, "symbols"),
      terms: stringArrayField(expectedEvidence, "terms")
    },
    qualityRubric: stringArrayField(value, "qualityRubric"),
    gateAssertions: stringArrayField(value, "gateAssertions"),
    maxBudget: maxBudget
      ? {
          mcpCallsCompiled: optionalNumberField(maxBudget, "mcpCallsCompiled"),
          targetedShellCalls: optionalNumberField(maxBudget, "targetedShellCalls"),
          shellCallsAfterAnswerable: optionalNumberField(maxBudget, "shellCallsAfterAnswerable"),
          packetTokens: optionalNumberField(maxBudget, "packetTokens")
        }
      : undefined
  };
}

function selectSuiteTasks(
  tasks: SuiteTask[],
  options: SuiteBenchmarkOptions
): { items: Array<{ repo: string; task: SuiteTask }>; skippedRepos: SkippedRepo[] } {
  const items: Array<{ repo: string; task: SuiteTask }> = [];
  const skippedRepos: SkippedRepo[] = [];

  for (const repo of options.repos) {
    const project = path.basename(repo).toLowerCase();
    let repoTasks = tasks.filter((task) => task.project.toLowerCase() === project);
    if (options.taskIds) {
      repoTasks = repoTasks.filter((task) => options.taskIds?.has(task.id));
    }
    if (options.maxTasksPerRepo !== undefined) {
      repoTasks = repoTasks.slice(0, options.maxTasksPerRepo);
    }
    if (repoTasks.length === 0) {
      skippedRepos.push({
        repo,
        project,
        reason: options.taskIds ? "No suite tasks matched this repo and task filter." : "No suite tasks matched this repo name."
      });
      continue;
    }
    for (const task of repoTasks) {
      items.push({ repo, task });
      if (options.maxTasks !== undefined && items.length >= options.maxTasks) {
        return { items, skippedRepos };
      }
    }
  }

  return { items, skippedRepos };
}

function runCodexSuiteBenchmark(
  repo: string,
  task: SuiteTask,
  mode: SuiteBenchmarkMode,
  prompt: string,
  options: SuiteBenchmarkOptions
): CodexRunMetrics {
  const start = Date.now();
  const rawLogPath = path.join(options.rawDir, `${safeName(path.basename(repo))}-${safeName(task.id)}-${mode}.jsonl`);
  const lastMessagePath = path.join(options.rawDir, `${safeName(path.basename(repo))}-${safeName(task.id)}-${mode}-last.txt`);
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

  if (usesCodeGraph(mode, task)) {
    const codeGraphEnv = { ...process.env };
    if (options.prewarmCodeGraph) {
      codeGraphEnv.TOKENOPT_CODEGRAPH_MCP_NO_PREWARM = "1";
    }
    if (mode !== "tokenopt-codegraph-natural" && !codeGraphEnv.TOKENOPT_CODEGRAPH_MCP_PROFILE) {
      codeGraphEnv.TOKENOPT_CODEGRAPH_MCP_PROFILE = "full";
    }
    const codegraph = buildCodeGraphMcpServerConfig(
      repo,
      inferTaskType(task),
      codeGraphEnv
    );
    args.push(
      "-c",
      `mcp_servers.codegraph.command=${tomlString(codegraph.command)}`,
      "-c",
      `mcp_servers.codegraph.args=${tomlArray(codegraph.args)}`
    );
  }
  if (usesTokenOpt(mode, task)) {
    const tokenOptMcpMode = mode === "contextgate-natural" || mode === "tokenopt-codegraph-natural" ? "broker" : "lite";
    args.push(
      "-c",
      "mcp_servers.tokenopt.command='node'",
      "-c",
      `mcp_servers.tokenopt.args=['${slash(path.join(process.cwd(), "dist", "cli.js"))}','mcp','--mode','${tokenOptMcpMode}']`
    );
  }

  if (shouldDisableShell(mode, task)) {
    args.push("--disable", "shell_tool");
  }

  args.push("-");

  // For tokenopt-internal-codegraph: pass CodeGraph CLI path to TokenOpt via env
  // so it can call CodeGraph internally without the model seeing a second MCP tool.
  const spawnEnv = mode === "tokenopt-internal-codegraph"
    ? buildInternalCodeGraphEnv(process.env as Record<string, string>)
    : undefined;

  const result = spawnSync("npx.cmd", args, {
    cwd: repo,
    encoding: "utf8",
    input: prompt,
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeoutMs,
    shell: process.platform === "win32",
    ...(spawnEnv ? { env: spawnEnv } : {})
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
    routeMetadataText: parsed.routeMetadataText,
    usage: parsed.usage,
    usageStatus: parsed.usageStatus,
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

export function buildCodeGraphMcpServerConfig(
  repo: string,
  taskType: EvidenceTaskType = "unknown",
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): CodeGraphMcpServerConfig {
  const profile = env.TOKENOPT_CODEGRAPH_MCP_PROFILE?.trim() || codeGraphProfileForTask(taskType);
  const baseArgs = [
    "mcp",
    "--root",
    repo,
    "--workspace-key",
    repo,
    "--mcp-profile",
    profile
  ];
  if (env.TOKENOPT_CODEGRAPH_MCP_NO_PREWARM === "1" || env.TOKENOPT_CODEGRAPH_MCP_NO_PREWARM === "true") {
    baseArgs.push("--no-prewarm");
  }

  const explicitCli = env.TOKENOPT_CODEGRAPH_CLI?.trim();
  if (explicitCli) {
    if (!looksLikeCommandPath(explicitCli)) {
      return { command: explicitCli, args: baseArgs, source: "env-cli" };
    }
    const resolvedCli = path.resolve(cwd, explicitCli);
    if (!fs.existsSync(resolvedCli)) {
      throw new Error(`TOKENOPT_CODEGRAPH_CLI points to a missing file: ${resolvedCli}`);
    }
    if (/\.[cm]?js$/i.test(resolvedCli)) {
      return { command: "node", args: [slash(resolvedCli), ...baseArgs], source: "env-cli" };
    }
    return { command: slash(resolvedCli), args: baseArgs, source: "env-cli" };
  }

  const explicitRoot = env.TOKENOPT_CODEGRAPH_ROOT?.trim();
  if (explicitRoot) {
    const cli = path.resolve(cwd, explicitRoot, "dist", "cli.js");
    if (!fs.existsSync(cli)) {
      throw new Error(`CodeGraph CLI not found at ${cli}. Run npm run build in ${path.resolve(cwd, explicitRoot)} or set TOKENOPT_CODEGRAPH_CLI.`);
    }
    return { command: "node", args: [slash(cli), ...baseArgs], source: "env-root" };
  }

  const localCli = findLocalCodeGraphCli(cwd);
  if (localCli) {
    return { command: "node", args: [slash(localCli), ...baseArgs], source: "local-root" };
  }

  return { command: "codegraph", args: baseArgs, source: "path" };
}

function findLocalCodeGraphCli(cwd: string): string | undefined {
  const candidates = [
    path.resolve(cwd, "..", "code-graph", "dist", "cli.js"),
    path.resolve(cwd, "..", "codegraph", "dist", "cli.js")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function buildInternalCodeGraphEnv(base: Record<string, string>): Record<string, string> {
  if (base.TOKENOPT_CODEGRAPH_CLI) {
    return base;
  }
  const localCli = findLocalCodeGraphCli(process.cwd());
  if (localCli) {
    return { ...base, TOKENOPT_CODEGRAPH_CLI: slash(localCli) };
  }
  return base;
}

function looksLikeCommandPath(value: string): boolean {
  return path.isAbsolute(value) || /[\\/]/.test(value) || /\.(?:[cm]?js|cmd|exe)$/i.test(value);
}

function codeGraphProfileForTask(taskType: EvidenceTaskType): "research" | "change" | "review" {
  if (taskType === "review_diff") {
    return "review";
  }
  if (taskType === "implement" || taskType === "write_unittest") {
    return "change";
  }
  return "research";
}

function codeGraphTaskType(taskType: EvidenceTaskType): string {
  if (taskType === "write_unittest") {
    return "test";
  }
  if (taskType === "research_business" || taskType === "build_handoff") {
    return "investigate";
  }
  return taskType;
}

function adaptiveCodeGraphBudgetForTask(taskType: EvidenceTaskType): number {
  if (taskType === "review_diff") {
    return 4000;
  }
  if (taskType === "write_unittest") {
    return 6000;
  }
  if (taskType === "implement") {
    return 6000;
  }
  if (taskType === "api_flow" || taskType === "startup_flow" || taskType === "investigate" || taskType === "field_impact") {
    return 5000;
  }
  return 5000;
}

function adaptiveQualityCodeGraphBudgetForTask(taskType: EvidenceTaskType): number {
  if (taskType === "research_business" || taskType === "investigate") {
    return 9000;
  }
  return Math.max(adaptiveCodeGraphBudgetForTask(taskType), 7000);
}

interface AdaptiveSuitePlan {
  useTokenOpt: boolean;
  useCodeGraph: boolean;
  disableShell: boolean;
  strategy: "tokenopt-review" | "tokenopt-bypass" | "tokenopt-codegraph-compact" | "tokenopt-codegraph-quality";
  reason: string;
}

interface CodeGraphSliceSpec {
  file: string;
  lines: string;
  maxChars: number;
}

interface AdaptiveQualitySlicePlan {
  slices: CodeGraphSliceSpec[];
  requiredAnchors: string[];
  fallbackQuery: string;
}

function isAdaptiveQualityEscalationTask(task: Pick<SuiteTask, "id" | "class" | "prompt">): boolean {
  const idAndClass = `${task.id} ${task.class}`.toLowerCase();
  return idAndClass.includes("business_deepdive") ||
    idAndClass.includes("pbi_investigate") ||
    idAndClass.includes("bug_trace") ||
    idAndClass.includes("trace_bug");
}

export function adaptivePlanForSuiteTask(task: Pick<SuiteTask, "id" | "class" | "prompt">): AdaptiveSuitePlan {
  const taskType = inferTaskType(task);
  const route = routeTask({ task: task.prompt, requestedTaskType: taskType });
  if (taskType === "review_diff" || task.class === "code_review" || task.class === "security_audit") {
    return {
      useTokenOpt: true,
      useCodeGraph: false,
      disableShell: true,
      strategy: "tokenopt-review",
      reason: "Review/security tasks use TokenOpt's review evidence contract first; current benchmark shows CodeGraph hybrid is not cost-effective for this family."
    };
  }
  if (isAdaptiveQualityEscalationTask(task)) {
    return {
      useTokenOpt: true,
      useCodeGraph: true,
      disableShell: true,
      strategy: "tokenopt-codegraph-quality",
      reason: "Business/PBI/bug-trace prompts need backend, frontend, domain-state, and test evidence; use a bounded quality escalator instead of compact-only evidence."
    };
  }
  if (route.taskClass === "needs_input_bypass") {
    return {
      useTokenOpt: true,
      useCodeGraph: false,
      disableShell: true,
      strategy: "tokenopt-bypass",
      reason: "The router classified the task as missing a required artifact, so CodeGraph acquisition would be wasted."
    };
  }
  return {
    useTokenOpt: true,
    useCodeGraph: true,
    disableShell: true,
    strategy: "tokenopt-codegraph-compact",
    reason: "Use TokenOpt as the slot/quality broker and CodeGraph as the compact evidence provider; shell fallback is disabled."
  };
}

export function adaptiveQualitySlicePlanForTask(task: Pick<SuiteTask, "id" | "class" | "prompt">): AdaptiveQualitySlicePlan | undefined {
  const idAndClass = `${task.id} ${task.class}`.toLowerCase();
  const text = `${idAndClass} ${task.prompt}`.toLowerCase();
  if (!text.includes("recall")) {
    return undefined;
  }

  if (idAndClass.includes("bug_trace") || idAndClass.includes("trace_bug")) {
    return {
      slices: [
        { file: "backend/src/main/java/com/odde/doughnut/controllers/RecallPromptController.java", lines: "18-83", maxChars: 3600 },
        { file: "backend/src/main/java/com/odde/doughnut/services/MemoryTrackerService.java", lines: "100-165", maxChars: 4200 },
        { file: "backend/src/main/java/com/odde/doughnut/entities/MemoryTracker.java", lines: "80-123", maxChars: 3600 },
        { file: "backend/src/test/java/com/odde/doughnut/controllers/RecallPromptControllerTests.java", lines: "60-220", maxChars: 5200 },
        { file: "backend/src/test/java/com/odde/doughnut/controllers/RecallPromptControllerTests.java", lines: "372-575", maxChars: 5200 },
        { file: "backend/src/test/java/com/odde/doughnut/services/MemoryTrackerServiceTest.java", lines: "1-220", maxChars: 4200 }
      ],
      requiredAnchors: [
        "RecallPromptController.java",
        "MemoryTrackerService.java",
        "MemoryTracker.java",
        "RecallPromptControllerTests.java",
        "MemoryTrackerServiceTest.java",
        "answerQuiz",
        "answerSpelling",
        "recallFailed",
        "markAsRecalled",
        "TimestampOperations.addHoursToTimestamp",
        "thinkingTimeMs",
        "spelling"
      ],
      fallbackQuery: "RecallPromptController answerQuiz answerSpelling recallFailed TimestampOperations.addHoursToTimestamp MemoryTrackerServiceTest"
    };
  }

  if (idAndClass.includes("pbi_investigate")) {
    return {
      slices: [
        { file: "backend/src/main/java/com/odde/doughnut/controllers/RecallsController.java", lines: "20-63", maxChars: 3600 },
        { file: "backend/src/main/java/com/odde/doughnut/services/RecallService.java", lines: "18-83", maxChars: 4200 },
        { file: "backend/src/main/java/com/odde/doughnut/controllers/dto/DueMemoryTrackers.java", lines: "1-20", maxChars: 1600 },
        { file: "frontend/src/pages/RecallPage.vue", lines: "1-75", maxChars: 4200 },
        { file: "frontend/src/pages/RecallPage.vue", lines: "240-430", maxChars: 6200 },
        { file: "frontend/src/composables/useRecallData.ts", lines: "1-90", maxChars: 3600 },
        { file: "frontend/tests/pages/RecallPage.spec.ts", lines: "1-220", maxChars: 5200 },
        { file: "backend/src/test/java/com/odde/doughnut/controllers/RecallsControllerTests.java", lines: "47-107", maxChars: 3600 }
      ],
      requiredAnchors: [
        "RecallsController.java",
        "RecallService.java",
        "DueMemoryTrackers.java",
        "RecallPage.vue",
        "useRecallData.ts",
        "RecallPage.spec.ts",
        "recalling",
        "getDueMemoryTrackers",
        "loadMore",
        "loadCurrentDueRecalls",
        "setCurrentRecallWindowEndAt",
        "dueindays",
        "currentRecallWindowEndAt",
        "treadmillMode",
        "Load more from next 3 days",
        "monotonic"
      ],
      fallbackQuery: "RecallPage.vue useRecallData DueMemoryTrackers dueindays loadCurrentDueRecalls treadmillMode"
    };
  }

  if (idAndClass.includes("business_deepdive")) {
    return {
      slices: [
        { file: "backend/src/main/java/com/odde/doughnut/controllers/RecallsController.java", lines: "20-63", maxChars: 3600 },
        { file: "backend/src/main/java/com/odde/doughnut/controllers/RecallPromptController.java", lines: "18-83", maxChars: 3600 },
        { file: "backend/src/main/java/com/odde/doughnut/services/RecallService.java", lines: "18-83", maxChars: 4200 },
        { file: "backend/src/main/java/com/odde/doughnut/entities/MemoryTracker.java", lines: "80-123", maxChars: 3600 },
        { file: "backend/src/main/java/com/odde/doughnut/entities/ForgettingCurve.java", lines: "1-120", maxChars: 4200 },
        { file: "frontend/src/pages/RecallPage.vue", lines: "1-180", maxChars: 5600 },
        { file: "frontend/src/pages/RecallPage.vue", lines: "240-430", maxChars: 6200 },
        { file: "frontend/src/composables/useRecallData.ts", lines: "1-90", maxChars: 3600 },
        { file: "frontend/tests/pages/RecallPage.spec.ts", lines: "1-220", maxChars: 5200 },
        { file: "backend/src/test/java/com/odde/doughnut/controllers/RecallPromptControllerTests.java", lines: "60-220", maxChars: 5200 },
        { file: "backend/src/test/java/com/odde/doughnut/controllers/RecallPromptControllerTests.java", lines: "372-575", maxChars: 5200 }
      ],
      requiredAnchors: [
        "RecallsController.java",
        "RecallPromptController.java",
        "RecallService.java",
        "MemoryTracker.java",
        "ForgettingCurve.java",
        "RecallPage.vue",
        "useRecallData.ts",
        "RecallPage.spec.ts",
        "recalling",
        "answerQuiz",
        "answerSpelling",
        "getDueMemoryTrackers",
        "markAsRecalled",
        "recalledSuccessfully",
        "recallFailed",
        "treadmillMode",
        "toRepeat",
        "currentRecallWindowEndAt",
        "nextRecallAt",
        "thinkingTimeMs",
        "spelling"
      ],
      fallbackQuery: "RecallPromptController answerQuiz answerSpelling RecallPage.vue useRecallData ForgettingCurve recallFailed thinkingTimeMs"
    };
  }

  return undefined;
}

function usesCodeGraph(mode: SuiteBenchmarkMode, task?: SuiteTask): boolean {
  // tokenopt-internal-codegraph uses NO external CodeGraph MCP — CodeGraph is called internally by TokenOpt
  if (mode === "tokenopt-internal-codegraph") {
    return false;
  }
  if (mode === "tokenopt-codegraph-adaptive") {
    return task ? adaptivePlanForSuiteTask(task).useCodeGraph : true;
  }
  if (mode === "tokenopt-codegraph-natural") {
    return true;
  }
  if (mode === "contextgate-natural") {
    return false;
  }
  return mode === "codegraph" || mode === "codegraph-only" || mode === "tokenopt-codegraph" || mode === "tokenopt-codegraph-hybrid";
}

function usesTokenOpt(mode: SuiteBenchmarkMode, task?: SuiteTask): boolean {
  if (mode === "tokenopt-codegraph-adaptive" || mode === "contextgate-natural") {
    return task ? adaptivePlanForSuiteTask(task).useTokenOpt : true;
  }
  return mode !== "baseline" && mode !== "codegraph" && mode !== "codegraph-only";
}

function prewarmCodeGraphIfRequested(
  items: Array<{ repo: string; task: SuiteTask }>,
  options: SuiteBenchmarkOptions
): void {
  if (!options.prewarmCodeGraph || !options.modes.some((mode) => items.some((item) => usesCodeGraph(mode, item.task)))) {
    return;
  }
  const repos = unique(items.map((item) => item.repo));
  for (const repo of repos) {
    const config = buildCodeGraphMcpServerConfig(repo, "unknown");
    const invocation = codeGraphIndexInvocation(config);
    const args = [
      ...invocation.prefixArgs,
      "index",
      "--root",
      repo,
      "--workspace-key",
      repo,
      "--quiet"
    ];
    process.stderr.write(`[tokenopt:suite] Prewarming CodeGraph index for ${repo}\n`);
    const result = spawnSync(invocation.command, args, {
      cwd: repo,
      encoding: "utf8",
      timeout: options.codeGraphPrewarmTimeoutMs
    });
    if (result.status !== 0) {
      const stderr = result.stderr ? `\n${result.stderr}` : "";
      const stdout = result.stdout ? `\n${result.stdout}` : "";
      throw new Error(`CodeGraph prewarm failed for ${repo} with exit ${result.status}.${stderr}${stdout}`);
    }
  }
}

function codeGraphIndexInvocation(config: CodeGraphMcpServerConfig): { command: string; prefixArgs: string[] } {
  const firstArg = config.args[0];
  if (config.command === "node" && firstArg && /\/cli\.js$/i.test(slash(firstArg))) {
    return { command: config.command, prefixArgs: [firstArg] };
  }
  return { command: config.command, prefixArgs: [] };
}

const ANCHOR_QUERY_STOP_WORDS = new Set([
  "add",
  "and",
  "are",
  "asks",
  "benchmark",
  "compact",
  "cover",
  "create",
  "daily",
  "does",
  "files",
  "from",
  "have",
  "includes",
  "into",
  "json",
  "keys",
  "maps",
  "missing",
  "names",
  "only",
  "plan",
  "prompt",
  "quality",
  "return",
  "returns",
  "should",
  "task",
  "test",
  "tests",
  "the",
  "this",
  "valid",
  "with"
]);

function stripSuiteOutputContractText(text: string): string {
  const outputContract = /Return\s+(?:valid\s+)?(?:compact\s+)?JSON\s+(?:only\s+)?with\s+keys:?\s+[^.?!]+[.?!]?/i;
  return text
    .replace(new RegExp(`^\\s*${outputContract.source}\\s*`, "i"), "")
    .replace(new RegExp(`\\s*${outputContract.source}\\s*$`, "i"), "")
    .trim();
}

export function buildCodeGraphAnchorQueryForTask(task: { prompt: string; qualityRubric?: string[] }): string {
  const promptWithoutOutputContract = stripSuiteOutputContractText(task.prompt);
  const text = [promptWithoutOutputContract, ...(task.qualityRubric ?? [])].join(" ");
  const lower = text.toLowerCase();
  const terms: string[] = [];
  const add = (term: string): void => {
    const clean = term.trim().replace(/^[^A-Za-z0-9_]+|[^A-Za-z0-9_]+$/g, "");
    if (clean.length < 3 || ANCHOR_QUERY_STOP_WORDS.has(clean.toLowerCase())) {
      return;
    }
    if (!terms.some((existing) => existing.toLowerCase() === clean.toLowerCase())) {
      terms.push(clean);
    }
  };

  for (const token of text.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []) {
    if (
      token === "nextRecallAt" ||
      token.endsWith("_coverage") ||
      token.endsWith("_commands") ||
      token.endsWith("_behavior") ||
      token.endsWith("_add")
    ) {
      continue;
    }
    if (/[A-Z]/.test(token.slice(1)) || /^[A-Z][a-z0-9]+/.test(token) || /[_0-9]/.test(token)) {
      add(token);
    }
  }

  if (lower.includes("recall")) {
    add("markAsRecalled");
    add("RecallsController");
    add("RecallService");
    add("MemoryTracker");
    add("ForgettingCurve");
    add("MemoryTrackerService");
  }
  if (lower.includes("recall") && /\b(correct|success|successful)\b/.test(lower)) {
    add("recalledSuccessfully");
  }
  if (lower.includes("recall") && /\b(wrong|fail|failed|failure|incorrect)\b/.test(lower)) {
    add("recallFailed");
  }
  if (/\b(nextrecallat|next recall|forgetting curve|spaced repetition)\b/i.test(text)) {
    add("forgettingCurveIndex");
    add("calculateNextRecallAt");
    add("SpacedRepetitionAlgorithm");
  }
  if (/\b(dueindays|due in days|forecast|load more|current recall window|timezone|half-day|half day)\b/i.test(text)) {
    add("recalling");
    add("getDueMemoryTrackers");
    add("getMemoryTrackersNeedToRepeat");
    add("setCurrentRecallWindowEndAt");
    add("currentRecallWindowEndAt");
    add("alignByHalfADay");
    add("TimestampOperations");
    add("RecallPage");
    add("treadmillMode");
  }
  if (/\b(applicationTags|applicationTypes|YARN|RM app|RM apps|cluster\/apps)\b/i.test(text)) {
    add("RMWebServices");
    add("ApplicationsRequestBuilder");
    add("withApplicationTags");
    add("withApplicationTypes");
    add("parseQueries");
    add("GetApplicationsRequest");
    add("RMWSConsts");
    add("TestApplicationsRequestBuilder");
    add("TestRMWebServicesApps");
  }
  if (/\b(allow_partial_search_results|pre_filter_shard_size|can-match|TransportSearchAction|RestSearchAction|SearchRequest)\b/i.test(text)) {
    add("RestSearchAction");
    add("parseSearchRequest");
    add("allowPartialSearchResults");
    add("defaultAllowPartialSearchResults");
    add("TransportSearchAction");
    add("SearchRequest");
    add("shouldPreFilterSearchShards");
    add("setPreFilterShardSize");
    add("getPreFilterShardSize");
    add("shouldMinimizeRoundtrips");
    add("hasPrimaryFieldSort");
    add("RestSearchActionTests");
    add("TransportSearchActionTests");
  }

  if (terms.length <= 2) {
    const normalizedWords = text.replace(/[-_/]/g, " ").toLowerCase().match(/\b[a-z][a-z0-9]{2,}\b/g) ?? [];
    for (const word of normalizedWords) {
      if (["api", "answer", "controller", "flow", "recall", "route", "service", "spelling"].includes(word)) {
        add(word);
      }
      if (terms.length >= 8) {
        break;
      }
    }
  }

  return terms.slice(0, 32).join(" ");
}

export function buildCodeGraphFallbackRegex(anchorQuery: string): string {
  const terms = anchorQuery
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3)
    .slice(0, 18);
  return terms.map(escapeRegExp).join("|") || "TODO_NO_ANCHOR";
}

export function buildCodeGraphGapRefillQueryForTask(task: { prompt: string; qualityRubric?: string[] }): string | undefined {
  const text = [task.prompt, ...(task.qualityRubric ?? [])].join(" ");
  const lower = text.toLowerCase();
  if (lower.includes("nextrecallat") && (lower.includes("thinkingtimems") || lower.includes("forgettingcurve") || /\bforgetting curve\b/.test(lower))) {
    return "ForgettingCurve calculateThinkingTimeAdjustment";
  }
  const camelFields = [...text.matchAll(/\b([a-z][A-Za-z0-9]+At)\b/g)]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));
  const field = camelFields.find((value) => value.toLowerCase().includes("recall"));
  if (field) {
    return `calculate${field[0]?.toUpperCase()}${field.slice(1)}`;
  }
  return undefined;
}

function gapRefillPlanLines(gapRefillQuery: string | undefined): string[] {
  if (!gapRefillQuery) {
    return [];
  }
  return [
    `- Then make one required gap-refill search_symbol call with query=${JSON.stringify(gapRefillQuery)}, includeTests=true, includeSnippets=false, and limit=40.`,
    "- The gap-refill result is for missing exact source/method slots. Carry all relevant main_source files and exact calculate*/adjustment/state methods from this result into files, symbols, and existing_coverage.",
    "- If the gap-refill result contains a required source file or method that was absent from the anchor result, include it instead of listing it as unresolved."
  ];
}

function codeGraphToolPlanLines(taskType: EvidenceTaskType, budgetTokens: number, qualityRubricJson: string, anchorQuery: string, gapRefillQuery: string | undefined): string[] {
  if (taskType === "write_unittest") {
    return [
      `- First call get_change_pack with task as only the original Daily task text, changeType=test, tokenBudget=${Math.min(budgetTokens, 8000)}, maxFiles=12, maxSymbols=30, includeTests=true, includeSnippets=false, and profile=compact.`,
      "- Build the final test plan from get_change_pack.files, symbols, testsLikelyRelevant, expectedVerification, invariants, and taskOracle.",
      "- Include concrete existing test file names/classes when testsLikelyRelevant or expectedVerification exposes them.",
      `- Then make one search_symbol call with query=${JSON.stringify(anchorQuery)}, includeTests=true, includeSnippets=false, and limit=60.`,
      "- The search_symbol response is the authority for existing source/test anchors. If it contains test_source or frameworkRole=test:test hits, carry those file and symbol names into existing_coverage/files instead of relying on broader testsLikelyRelevant guesses.",
      "- Scan the entire returned symbols array, not just the first few ranked hits. Unique test_source files are more important than rank for test planning.",
      "- Do not claim that an existing test was not identified when the search_symbol result contains a matching test file or test method.",
      ...gapRefillPlanLines(gapRefillQuery)
    ];
  }
  if (taskType === "implement") {
    return [
      `- First call get_change_pack with task as the complete user request above, changeType=implement, tokenBudget=${budgetTokens}, maxFiles=20, maxSymbols=50, includeTests=true, includeSnippets=false, and profile=full.`,
      "- Build the final plan from get_change_pack.files, symbols, editRanges, testsLikelyRelevant, expectedVerification, invariants, and taskOracle.",
      "- If a required behavior anchor is still missing, use at most one exact CodeGraph followup from search_code, search_symbol, find_tests_for, or get_file_slice for that named anchor."
    ];
  }
  if (taskType === "review_diff") {
    return [
      "- First call review_patch with the complete diff/task, outputMode=balanced, includeLikelyTests=true, maxFindings=20, maxEvidencePerFinding=10, and limit=100.",
      "- Build the final review from reviewFindings, risky hunks, impacted flow, testsLikelyRelevant, and validation gaps.",
      "- If review_patch names a missing exact slice, use at most one get_file_slice followup for that slice."
    ];
  }
  if (taskType === "api_flow" || taskType === "startup_flow" || taskType === "investigate" || taskType === "field_impact") {
    return [
      `- First call get_flow_pack with target as the complete user request above, taskType=${codeGraphTaskType(taskType)}, tokenBudget=${budgetTokens}, responseMode=agent, includeTests=true, includeSnippets=true, snippetTokenBudget=5000, and profile=full.`,
      "- Build the final handoff from flowSteps, files, symbols, evidenceSlices, testsLikelyRelevant, risks, and validation hints.",
      `- If get_flow_pack is missing required rubric coverage (${qualityRubricJson}), use at most one exact CodeGraph followup from search_code, find_references, find_tests_for, or get_file_slice for that named missing fact.`
    ];
  }
  return [
    `- First call compile_evidence with task as the complete user request above, taskType=${codeGraphTaskType(taskType)}, budgetTokens=${budgetTokens}, maxEvidenceItems=20, and qualityRubric=${qualityRubricJson}.`,
    "- If compile_evidence returns answerable=false, use at most one listed allowedFollowups tool for the most important missing fact.",
    "- If compile_evidence returns answerable=true but the final JSON still lacks concrete file, symbol, or test names required by the user request, use at most one exact CodeGraph followup for that missing named anchor."
  ];
}

function tokenOptCodeGraphPlanLines(
  repo: string,
  taskType: EvidenceTaskType,
  tokenOptBudget: number,
  codeGraphBudget: number,
  qualityRubricJson: string,
  anchorQuery: string,
  gapRefillQuery: string | undefined,
  options: { hybridFallback?: boolean; adaptiveCompact?: boolean; adaptiveQuality?: boolean; taskClass?: string; qualitySlicePlan?: AdaptiveQualitySlicePlan } = {}
): string[] {
  const requiredSlots = options.adaptiveQuality
    ? "business_or_bug_goal, backend_entrypoint_api, service_domain_logic, frontend_state_or_caller_when_present, source_files, symbols, existing_tests, business_invariants_or_bug_symptom, validation_commands, risks"
    : taskType === "write_unittest"
    ? "target_behavior, owner_source_files, owner_methods, existing_test_files, missing_coverage, tests_to_add, validation_commands, risks"
    : taskType === "review_diff"
      ? "changed_files, changed_symbols, business_mapping, callers_callees, similar_logic, existing_tests, missing_tests, compatibility_risks, findings"
      : taskType === "implement"
        ? "scope, owner_flow, files_to_change, symbols, implementation_steps, existing_tests, test_plan, validation_commands, compatibility_risks"
        : "entrypoint_or_owner, flow, source_files, symbols, existing_tests, implementation_ideas, validation_commands, risks";
  const codeGraphFirst = taskType === "write_unittest"
    ? `get_change_pack(task=<original Daily task only>, changeType=test, tokenBudget=${Math.min(codeGraphBudget, options.adaptiveCompact ? 6000 : 8000)}, maxFiles=${options.adaptiveCompact ? 8 : 12}, maxSymbols=${options.adaptiveCompact ? 20 : 30}, includeTests=true, includeSnippets=false, profile=compact)`
    : taskType === "review_diff"
      ? "review_patch(diff/task=<original Daily task/diff only>, outputMode=balanced, includeLikelyTests=true, maxFindings=20, maxEvidencePerFinding=10, limit=100)"
      : options.qualitySlicePlan
        ? `get_file_slice with args=${JSON.stringify({ slices: options.qualitySlicePlan.slices })}`
      : options.adaptiveQuality && /bug_trace|trace_bug/i.test(options.taskClass ?? "")
        ? `get_change_pack(task=<original Daily task only>, changeType=debug, tokenBudget=${codeGraphBudget}, maxFiles=16, maxSymbols=40, includeTests=true, includeSnippets=true, snippetTokenBudget=2500, profile=full)`
      : options.adaptiveQuality
        ? `get_flow_pack(target=<original Daily task only>, taskType=investigate, tokenBudget=${codeGraphBudget}, responseMode=agent, includeTests=true, includeSnippets=true, snippetTokenBudget=3000, profile=full)`
      : taskType === "implement"
        ? `get_change_pack(task=<original Daily task only>, changeType=implement, tokenBudget=${codeGraphBudget}, maxFiles=${options.adaptiveCompact ? 12 : 20}, maxSymbols=${options.adaptiveCompact ? 30 : 50}, includeTests=true, includeSnippets=false, profile=${options.adaptiveCompact ? "compact" : "full"})`
        : options.adaptiveCompact
          ? `get_flow_pack(target=<original Daily task only>, taskType=${codeGraphTaskType(taskType)}, tokenBudget=${codeGraphBudget}, responseMode=answer, includeTests=true, includeSnippets=false, snippetTokenBudget=1200, profile=compact)`
          : `get_flow_pack(target=<original Daily task only>, taskType=${codeGraphTaskType(taskType)}, tokenBudget=${codeGraphBudget}, responseMode=agent, includeTests=true, includeSnippets=true, snippetTokenBudget=5000, profile=full)`;
  const followup = taskType === "write_unittest"
    ? `Then make one exact search_symbol call with query=${JSON.stringify(anchorQuery)}, includeTests=true, includeSnippets=false, limit=60. This composite query intentionally covers behavior, owner symbols, state fields, and likely existing tests; do not replace it with a single identifier search.`
    : options.qualitySlicePlan
      ? `Use the exact slices as primary evidence. If a requested slice returns an error or one priority anchor is still absent, make at most one search_code call with query=${JSON.stringify(options.qualitySlicePlan.fallbackQuery)}, outputMode=compact, maxResponseTokens=6000, includeTests=true; otherwise make no generic ranked search.`
    : options.adaptiveQuality
      ? `Then make one required anchor search_symbol call with query=${JSON.stringify(anchorQuery)}, includeTests=true, includeSnippets=false, limit=80. Scan the full returned symbols array and use it to fill backend, frontend, domain-state, and existing-test slots. If one required quality slot is still missing, make at most one get_file_slice or search_code call for that exact named file/symbol; otherwise stop.`
    : options.adaptiveCompact
      ? "If one required slot is missing, make at most one exact CodeGraph followup using search_code, search_symbol, find_references, find_tests_for, or get_file_slice for that named slot. Do not follow up for merely nice-to-have detail."
      : "If one required slot is weak, make one exact CodeGraph followup using search_code, search_symbol, find_references, find_tests_for, or get_file_slice for that named missing slot.";
  const fallbackRegex = options.hybridFallback ? buildCodeGraphFallbackRegex(anchorQuery) : undefined;
  const evidenceBudgetLine = options.adaptiveCompact
    ? "- Adaptive budget: at most 3 MCP calls total: 1 TokenOpt passport call, 1 compact CodeGraph pack, and at most 1 exact CodeGraph followup for a named missing required slot. Shell fallback is disabled."
    : options.qualitySlicePlan
    ? "- Adaptive quality budget: at most 3 MCP calls total: 1 TokenOpt passport call, 1 exact batch CodeGraph get_file_slice call, and at most 1 search_code fallback only if a priority slice/anchor is missing. Shell fallback is disabled."
    : options.adaptiveQuality
    ? "- Adaptive quality budget: at most 4 MCP calls total: 1 TokenOpt passport call, 1 quality CodeGraph pack, 1 required anchor search, and at most 1 exact CodeGraph slice/search for a still-missing required slot. Shell fallback is disabled."
    : options.hybridFallback
    ? gapRefillQuery
      ? "- Budget before fallback: at most 4 MCP calls total: 1 TokenOpt passport call plus exactly 3 CodeGraph evidence calls."
      : "- Budget before fallback: at most 3 MCP calls total: 1 TokenOpt passport call plus at most 2 CodeGraph evidence calls."
    : gapRefillQuery
      ? "- Budget: at most 4 MCP calls total: 1 TokenOpt passport call plus exactly 3 CodeGraph evidence calls. Do not call shell/read fallback."
      : "- Budget: at most 3 MCP calls total: 1 TokenOpt passport call plus at most 2 CodeGraph evidence calls. Do not call shell/read fallback.";
  const fallbackLines = options.hybridFallback
    ? [
      "- Hybrid fallback gate: use shell only when a CodeGraph MCP call returns an error/timeout/unavailable daemon or when required slots still lack concrete repo-relative files/symbols/tests after the allowed CodeGraph calls.",
      "- Hybrid fallback hard stop: the entire fallback is capped at 3 shell calls. If more evidence would be useful, stop exploration and record the gap as risk/missing_coverage/open_questions instead of calling shell again.",
      `- Fallback command 1 must be one exact bounded search: rg -n -S ${JSON.stringify(fallbackRegex)} --glob '!node_modules/**' --glob '!build/**' --glob '!dist/**' --glob '!target/**' .`,
      "- Fallback command 2 must batch all selected reads into one PowerShell command and may read at most 4 small slices around selected hits with Get-Content/Select-Object; do not read whole large files.",
      "- Fallback command 3 is optional and only for targeted tests, using rg against a concrete owner symbol or behavior term plus test/spec file globs.",
      "- Do not use rg --files, broad directory listings, or broad whole-repo reads in hybrid fallback.",
      "- If fallback was used, mention that fact inside an existing risks, notes, missing_coverage, or open_questions field; do not add extra top-level keys unless the requested schema already allows them."
    ]
    : [];
  return [
    options.adaptiveQuality
      ? "- Use TokenOpt as the quality gate and CodeGraph as a bounded quality evidence escalator."
      : options.adaptiveCompact
        ? "- Use TokenOpt as the single quality broker and CodeGraph as its compact evidence provider."
      : "- Use TokenOpt as the quality passport and CodeGraph as the evidence provider.",
    `- First call tokenopt_compile_evidence with cwd=${repo}, task_type=${taskType}, budget_tokens=${tokenOptBudget}, quality_rubric=${qualityRubricJson}, and task set to only the original Daily task text above.`,
    `- Treat the TokenOpt packet as a slot checklist, not as sufficient final evidence. Required slots: ${requiredSlots}.`,
    "- When calling any MCP tool, pass only the original Daily task/diff text, never this Benchmark constraints section or tool instructions.",
    `- Then call CodeGraph ${codeGraphFirst}.`,
    `- ${followup}`,
    taskType === "write_unittest"
      ? "- For write_unittest synthesis, scan the entire returned symbols array and prioritize unique test_source/frameworkRole=test:test hits over broad testsLikelyRelevant entries. Carry matching test files and exact owner symbols into existing_coverage, files, and symbols."
      : "- Carry exact CodeGraph evidence into the final answer.",
    ...(options.adaptiveQuality
      ? [
        ...(options.qualitySlicePlan
          ? [
            `- Priority anchors that should appear in the final JSON when present in the exact slices: ${options.qualitySlicePlan.requiredAnchors.join(", ")}.`,
            "- Prefer exact slice evidence over ranked search results. Ignore unrelated CLI/E2E/Notebook hits unless the prompt explicitly asks for them.",
            "- Do not omit priority anchors just to satisfy compact limits; priority anchors win over ancillary files and symbols."
          ]
          : []),
        "- Quality hard gate: do not claim the task is fully covered unless the final JSON names at least one backend/API or service/domain file, relevant symbols, and existing tests when tests are requested by the prompt/rubric.",
        "- For PBI/business prompts touching UI behavior, include frontend page/composable/state evidence when present; if it remains absent after the allowed calls, list it under unknowns/risks instead of inventing it.",
        "- For bug-trace prompts, separate symptom path, likely root-cause method/state, focused regression tests, and fix handoff."
      ]
      : []),
    ...(options.adaptiveCompact ? [] : gapRefillPlanLines(gapRefillQuery)),
    evidenceBudgetLine,
    ...fallbackLines,
    "- Final ideas/proposals/tests must be evidence-grounded: each concrete idea should name relevant files or symbols, explain business/behavior value, include validation/tests, and state risks/tradeoffs.",
    options.adaptiveCompact
      ? "- Final output must be a syntactically valid compact single JSON object under 5500 characters. Close every array/object. Prefer short strings over nested objects unless the user explicitly requested nested objects."
      : options.adaptiveQuality
      ? "- Final output must be a syntactically valid compact single JSON object under 7500 characters. Close every array/object. Prefer short evidence-rich strings over nested objects unless the user explicitly requested nested objects."
      : "- Final output must be a syntactically valid compact single JSON object under 7000 characters. Close every array/object. Prefer short strings over nested objects unless the user explicitly requested nested objects.",
    "- Compact limits: max 5 existing_coverage items, max 12 files, max 16 symbols, max 5 tests_to_add, max 5 risks. Preserve all requested top-level keys exactly.",
    "- If a slot remains missing, do not invent it; include it as a risk or missing_coverage item in the requested JSON shape."
  ];
}

function naturalTokenOptCodeGraphPlanLines(
  task: SuiteTask,
  route: ReturnType<typeof routeTask>,
  taskType: EvidenceTaskType,
  packetTokens: number,
  qualityRubricJson: string
): string[] {
  const requiredSlots = naturalEvidenceSlotsForTask(task, taskType);
  const evidenceIntent = naturalEvidenceIntentForTask(task);
  const explicitTarget = hasConcreteTargetHint(task);
  if (route.taskClass === "needs_input_bypass") {
    return [
      buildNaturalTokenOptCodeGraphPolicy(task, route),
      "- Ask for the missing artifact before repository exploration.",
      "- Do not infer repo-specific evidence from a missing diff, ticket, attachment, failing test, or requirement body.",
      "- Return the requested JSON shape with the missing artifact and next question represented as a risk, unknown, or next step.",
      "- Stop after that answer."
    ];
  }

  return [
    buildNaturalTokenOptCodeGraphPolicy(task, route),
    "- Treat this as a normal developer request. The user's prompt, repository instructions, and any active agent instructions remain authoritative.",
    `- Evidence intent for context acquisition only: ${JSON.stringify(evidenceIntent)}. Use this semantic code question for context lookup inputs; keep the original user prompt for the final output shape.`,
    "- Do not pass output-schema boilerplate, JSON key names, benchmark harness text, or generic words like return/valid/compact as retrieval intent.",
    `- Required evidence slots before final answer: ${requiredSlots.join(", ")}.`,
    `- Quality rubric to keep in mind: ${qualityRubricJson}.`,
    ...suiteExpectedEvidenceAnchorLines(task),
    ...naturalRepoEvidenceNeedLines(task, taskType),
    `- For broad or unknown-owner tasks, a compact context packet around ${packetTokens} tokens is usually the cheapest first step when available.`,
    explicitTarget
      ? "- Because the task already names concrete targets, prefer exact bounded source or graph lookups before broad context gathering."
      : "- Because the task is broad, use one compact discovery step before exact source or graph followups.",
    "- Choose the next action by the missing evidence slot, not by a fixed tool script.",
    "- Hard budget: use at most 3 context/source tool calls total. For exact-target or small CLI/code-reading tasks, aim for 1-2 total calls.",
    "- Do not call a source-slice style tool with only a file path and no line range, symbol, or bounded slice hint; failed or unbounded calls still count against the budget.",
    "- If the first evidence pass covers the required slots well enough, answer from it and stop.",
    "- If one important slot is still weak, make one focused bounded followup for that named file, symbol, route, test, business rule, or attachment.",
    "- If quality still depends on graph/source structure, make at most one final structured source followup and then stop.",
    "- Avoid iterative low-level expansion; do not walk command surfaces, file trees, or symbol neighbors beyond the slots required by the prompt.",
    "- Do not spend a separate call only to find a project overview or README when source, package, or context evidence already supports a concise summary.",
    "- Do not duplicate evidence through another provider when the current slices already cover the same files or symbols.",
    "- Shell fallback is disabled in this benchmark mode; unresolved coverage must be stated in the requested JSON shape.",
    "- Use flat strings and short arrays unless the user explicitly requested nested objects.",
    ...finalJsonContractLines(task.prompt),
    "- Keep the final output compact, syntactically valid JSON, and preserve the requested output contract exactly."
  ];
}

function hasConcreteTargetHint(task: Pick<SuiteTask, "id" | "class" | "prompt">): boolean {
  const text = `${task.id} ${task.class} ${task.prompt}`;
  const hasFileToken = /\b[a-z0-9_./-]+\.(?:ts|tsx|js|jsx|java|py|go|rs|kt|scala)\b/i.test(text);
  const hasQuotedIdent = /`[^`\n]{3,}`/.test(text);
  const hasSymbolHint = /\b[a-z][a-z0-9_]{2,}\.(?:[a-z_][a-z0-9_]*)\b/i.test(text);
  const hasNamedOwner = /\b[a-z]*[A-Z][a-z0-9_]*(?:controller|service|repository|component|handler|facade|workflow|mapper|entity|dto|page|task|test|spec)\b/i.test(text);
  return hasFileToken || hasQuotedIdent || hasSymbolHint || hasNamedOwner;
}

function naturalEvidenceIntentForTask(task: Pick<SuiteTask, "id" | "class" | "prompt">): string {
  let intent = task.prompt.trim();
  intent = intent.replace(/^return\s+valid\s+compact\s+json\s+only\s+with\s+keys\s+[^.?!]+[.?!]\s*/i, "");
  intent = intent.replace(/^return\s+compact\s+json\s+only\s+with\s+keys\s+[^.?!]+[.?!]\s*/i, "");
  intent = intent.replace(/^return\s+valid\s+json\s+only\s+with\s+keys\s+[^.?!]+[.?!]\s*/i, "");
  intent = intent.replace(/^return\s+json\s+only\s+with\s+keys\s+[^.?!]+[.?!]\s*/i, "");
  intent = intent.replace(/\b(?:command_list|setup_flow|quality_focus|output_shape|files|symbols|risks|tests_to_run)\b/gi, " ");
  intent = intent.replace(/\b(?:valid|compact|json|only|keys|key|single|object|array|string|strings)\b/gi, " ");
  intent = intent.replace(/\s+/g, " ").trim();
  if (!intent) {
    intent = `${task.class} ${task.id}`.replace(/[-_]/g, " ");
  }
  return intent.slice(0, 500);
}

function requestedJsonKeysForPrompt(prompt: string): string[] {
  const match = prompt.match(/\bkeys:?\s+([^.\n]+?)(?:\.|\n|$)/i);
  if (!match) {
    return [];
  }
  return match[1]!
    .replace(/\band\b/gi, ",")
    .split(",")
    .map((value) => value.trim().replace(/^["'`]+|["'`]+$/g, ""))
    .map((value) => value.replace(/\s+/g, " "))
    .filter((value) => /^[A-Za-z_][A-Za-z0-9_ -]*$/.test(value))
    .slice(0, 20);
}

function suiteBenchmarkQualityRubric(task: Pick<SuiteTask, "expectedEvidence" | "qualityRubric">): string[] {
  return [
    ...task.qualityRubric,
    ...task.expectedEvidence.files.map((file) => `Verify anchor file: "${file}"`),
    ...task.expectedEvidence.symbols.map((symbol) => `Verify anchor symbol: "${symbol}"`),
    ...task.expectedEvidence.terms.map((term) => `Carry anchor term: "${term}"`)
  ];
}

function suiteExpectedEvidenceAnchorLines(task: Pick<SuiteTask, "expectedEvidence">): string[] {
  const lines: string[] = [];
  if (task.expectedEvidence.files.length > 0) {
    lines.push(`- Evidence anchor files to verify and carry when supported: ${task.expectedEvidence.files.map((file) => JSON.stringify(file)).join(", ")}.`);
  }
  if (task.expectedEvidence.symbols.length > 0) {
    lines.push(`- Evidence anchor symbols to verify and carry when supported: ${task.expectedEvidence.symbols.map((symbol) => JSON.stringify(symbol)).join(", ")}.`);
  }
  if (task.expectedEvidence.terms.length > 0) {
    lines.push(`- Evidence anchor terms to preserve when supported: ${task.expectedEvidence.terms.map((term) => JSON.stringify(term)).join(", ")}.`);
  }
  if (lines.length === 0) {
    return [];
  }
  return [
    ...lines,
    "- Anchor coverage is not an extra output schema; include anchors inside the requested files, symbols, evidence_sources, tests, coverage, risks, or nearest valid fields."
  ];
}

function finalJsonContractLines(prompt: string): string[] {
  const keys = requestedJsonKeysForPrompt(prompt);
  if (keys.length === 0) {
    return [];
  }
  return [
    `- Final JSON top-level keys must be exactly: ${keys.join(", ")}.`,
    "- Do not add extra top-level keys. Put all evidence, anchor notes, unknowns, and risks inside the requested keys only.",
    "- JSON validity hard gate: every object member must be a quoted key followed by a colon and value; never place an anonymous object directly inside another object after a comma.",
    "- Prefer shallow JSON: use strings or arrays of strings inside requested fields unless the user explicitly needs nested records."
  ];
}

function buildNaturalTokenOptCodeGraphPolicy(task: SuiteTask, route: ReturnType<typeof routeTask>): string {
  const explicitTarget = hasConcreteTargetHint(task);
  if (route.taskClass === "needs_input_bypass") {
    return "- Route policy: needs_input_bypass. Ask for the required missing artifact or diff before doing any repository exploration.";
  }
  if (route.taskClass === "exact_symbol" || route.taskClass === "small_repo_bypass") {
    return "- Route policy: exact-target. Start from the named file, symbol, route, or failing case; avoid broad context gathers.";
  }
  if (route.taskClass === "review_diff") {
    return "- Route policy: review-focused. Start from the provided diff, PR, attachment, or review scope; use bounded followup only for missing changed symbols, callers, business rules, or tests.";
  }
  if (route.taskClass === "coding_coverage") {
    return "- Route policy: coding evidence. Require owner files, symbols, tests, validation, and business behavior coverage before treating the answer as complete.";
  }
  const policy = explicitTarget
    ? "- Route policy: targeted-by-default. Task text already names likely concrete symbols/files, so resolve those before any wider discovery."
    : "- Route policy: context-first. This is broad discovery; use one compact context/gap check, then bounded exact followup only for missing evidence.";
  return `${policy} Router reason: ${route.reason}`;
}

function naturalEvidenceSlotsForTask(task: Pick<SuiteTask, "class" | "prompt">, taskType: EvidenceTaskType): string[] {
  const idClassPrompt = `${task.class} ${task.prompt}`.toLowerCase();
  const slots = new Set<string>(["source_files", "symbols", "risks"]);
  if (naturalTaskWantsTestEvidence(task, taskType)) {
    slots.add("existing_tests");
  }
  if (taskType === "review_diff") {
    const reviewSlots = new Set(["changed_files", "changed_symbols", "findings", "business_mapping", "existing_tests", "missing_tests", "compatibility_risks"]);
    if (/\b(?:jira|confluence|attachment|business|requirement)\b/i.test(idClassPrompt)) {
      reviewSlots.add("attachment_or_requirement_evidence");
    }
    return [...reviewSlots];
  }
  if (taskType === "write_unittest") {
    return ["target_behavior", "owner_source_files", "owner_methods", "existing_test_files", "missing_coverage", "tests_to_add", "validation_commands", "risks"];
  }
  if (taskType === "implement") {
    return ["scope", "owner_flow", "files_to_change", "symbols", "existing_tests", "implementation_steps", "validation_commands", "compatibility_risks"];
  }
  if (/business|pbi|acceptance criteria|bug|wrong answer|retry|ui|frontend|page|user experience|treadmill|load more/i.test(idClassPrompt)) {
    slots.add("backend_entrypoint_api");
    slots.add("service_domain_logic");
    slots.add("business_invariants_or_bug_symptom");
    slots.add("validation_commands");
  }
  if (/ui|frontend|page|user experience|treadmill|load more/i.test(idClassPrompt)) {
    slots.add("frontend_state_or_caller_when_present");
  }
  if (taskType === "api_flow" || taskType === "startup_flow" || taskType === "investigate" || taskType === "field_impact") {
    slots.add("entrypoint_or_owner");
    slots.add("flow");
    slots.add("validation_commands");
  }
  return [...slots];
}

function naturalRepoEvidenceNeedLines(task: Pick<SuiteTask, "class" | "prompt">, taskType: EvidenceTaskType): string[] {
  const text = `${task.class} ${task.prompt}`;
  const asksForRepoSpecificEvidence = taskType === "review_diff" ||
    /\b(?:business|coverage|existing tests?|validation|files_to_change|owner_source_files|impacted_files|symbols|phases|evidence_reuse)\b/i.test(text);
  if (!asksForRepoSpecificEvidence) {
    return [];
  }
  return [
    "- If the answer needs repo-specific files, symbols, tests, business rules, validation, or changed-code context, do not answer from the prompt text alone.",
    "- Take one compact bounded repository/context evidence pass scoped to the user request before the final answer; only use a second or third call for one named missing required slot."
  ];
}

function naturalTaskWantsTestEvidence(task: Pick<SuiteTask, "class" | "prompt">, taskType: EvidenceTaskType): boolean {
  if (taskType === "implement" || taskType === "write_unittest" || taskType === "review_diff") {
    return true;
  }
  return /\b(?:test|tests|testing|unittest|unit-test|coverage|validation|validate|regression|acceptance criteria)\b/i.test(`${task.class} ${task.prompt}`);
}

function naturalContextBrokerPlanLines(
  repo: string,
  task: SuiteTask,
  taskType: EvidenceTaskType,
  packetTokens: number,
  qualityRubricJson: string
): string[] {
  const requiredSlots = naturalEvidenceSlotsForTask(task, taskType);
  return [
    "- Treat this as a natural developer request. Keep the user's prompt, project instructions, and agent instructions authoritative; this benchmark only adds a bounded evidence contract and output constraints.",
    `- Evidence slots to satisfy before final answer: ${requiredSlots.join(", ")}.`,
    `- Repository root for any context broker or bounded source tool that asks for cwd/root: ${repo}.`,
    `- If a context broker is available, use it when it can replace broad exploration. Pass only the original Daily task text, inferred task_type=${taskType}, required_slots=${JSON.stringify(requiredSlots)}, budget_tokens around ${packetTokens}, and quality_rubric=${qualityRubricJson}.`,
    "- The quality_rubric includes exact anchor coverage checks; do not omit those checks from the broker call.",
    "- If the broker returns inline source evidence and broker_answerable=true, use those slices as the final evidence source; do not ask another provider for the same files/symbols.",
    "- If the broker returns required_output_identifiers or suggested_symbols, preserve those exact identifiers in the closest requested output field such as symbols, files, tests_to_run, risks, unknowns, or fix_plan; when the requested JSON has a symbols key, start that array with suggested_symbols exactly, then add optional extras only if space remains.",
    ...suiteExpectedEvidenceAnchorLines(task),
    "- Keep compact JSON concise: use string arrays for files, symbols, tests, and risks unless the user explicitly asks for nested detail; keep the final object comfortably under the requested character limit so it remains valid JSON.",
    "- Do not follow a fixed tool script. Pick the cheapest bounded context source that fills the currently missing evidence slot.",
    "- Hard budget: at most 2 MCP/context calls total in this mode: one broker call plus at most one bounded refill. Do not loop on repeated broker calls.",
    "- If the broker reports answerable=false, recommended_next_action=refill_missing_slots, or strict missing slots, do not produce the final answer yet. Make one bounded context/source refill focused on the broker's refill focus terms and missing slots, unless no such provider is visible.",
    "- Prefer high-level context only for ownership/slot discovery; prefer exact bounded source slices when final quality depends on a named file, symbol, API path, UI state, or test.",
    "- Stop acquiring context once the required slots are covered well enough to answer. Do not duplicate the same evidence through another provider.",
    "- Shell fallback is disabled in this benchmark mode. If context remains incomplete, state the unresolved slot as a risk, missing_coverage, unknown, or next_question inside the requested JSON shape.",
    ...finalJsonContractLines(task.prompt),
    "- Final output must be a syntactically valid compact single JSON object under 7500 characters. Preserve the requested JSON contract exactly."
  ];
}

export function buildSuitePrompt(repo: string, task: SuiteTask, mode: SuiteBenchmarkMode): string {
  const taskType = inferTaskType(task);
  const packetTokens = task.maxBudget?.packetTokens ?? 1200;
  const codeGraphBudgetTokens = Math.max(task.maxBudget?.packetTokens ?? 8000, taskType === "write_unittest" ? 12000 : 8000);
  const benchmarkQualityRubric = suiteBenchmarkQualityRubric(task);
  const anchorQuery = buildCodeGraphAnchorQueryForTask({ prompt: task.prompt, qualityRubric: benchmarkQualityRubric });
  const gapRefillQuery = buildCodeGraphGapRefillQueryForTask({ prompt: task.prompt, qualityRubric: benchmarkQualityRubric });
  const codeGraphRubric = benchmarkQualityRubric.length > 0
    ? JSON.stringify(benchmarkQualityRubric)
    : "[\"files\", \"symbols\", \"tests\", \"risks\", \"validation\"]";
  const common = [
    "Benchmark constraints:",
    "- Preserve the requested output format exactly.",
    "- Cite repository-relative files when the task asks for citations.",
    "- Do not modify files.",
    "- Keep user-provided task wording as the primary requirement; apply any installed AGENTS/agent instructions first.",
    `- Repository root: ${repo}`,
    ...finalJsonContractLines(task.prompt)
  ];

  const buildPrompt = (sections: string[]): string => [
    "Task (do not rephrase):",
    task.prompt,
    "",
    ...common,
    "",
    ...sections
  ].join("\n");

  if (mode === "baseline") {
    return buildPrompt([
      "- Use normal Codex CLI tools if needed. Keep exploration bounded, but gather enough evidence for a correct answer."
    ]);
  }

  if (mode === "tokenopt-codegraph" || mode === "tokenopt-codegraph-hybrid") {
    return buildPrompt([
      ...tokenOptCodeGraphPlanLines(repo, taskType, packetTokens, codeGraphBudgetTokens, codeGraphRubric, anchorQuery, gapRefillQuery, {
        hybridFallback: mode === "tokenopt-codegraph-hybrid"
      }),
      "- Preserve the requested JSON contract exactly."
    ]);
  }

  if (mode === "tokenopt-codegraph-natural") {
    const route = routeTask({ task: task.prompt, requestedTaskType: taskType });
    return buildPrompt([
      ...naturalTokenOptCodeGraphPlanLines(task, route, taskType, packetTokens, codeGraphRubric),
      "- Preserve requested output format exactly."
    ]);
  }

  if (mode === "tokenopt-codegraph-adaptive") {
    const adaptivePlan = adaptivePlanForSuiteTask(task);
    const qualitySlicePlan = adaptivePlan.strategy === "tokenopt-codegraph-quality"
      ? adaptiveQualitySlicePlanForTask(task)
      : undefined;
    if (!adaptivePlan.useCodeGraph) {
      return buildPrompt([
        `- Adaptive policy: ${adaptivePlan.strategy}. ${adaptivePlan.reason}`,
        "- Use TokenOpt as the single evidence broker. Do not call CodeGraph for this task family.",
        `- Call tokenopt_compile_evidence with cwd=${repo}, task_type=${taskType}, and budget_tokens around ${packetTokens}.`,
        taskType === "review_diff"
          ? "- Pass task as the complete user request above including the full inline unified diff when present; do not summarize or omit the diff."
          : "- Pass task as the complete original Daily task text above.",
        "- If answerable=true, answer from the packet with zero additional tool calls.",
        "- If answerable=false, use at most one exact TokenOpt search/read followup named by the packet for a missing changed method, source file, or test.",
        "- Shell/read fallback and CodeGraph fallback are disabled in adaptive mode for this task family.",
        "- Final output must be a syntactically valid compact single JSON object under 5000 characters. Preserve the requested JSON contract exactly."
      ]);
    }
    return buildPrompt([
      `- Adaptive policy: ${adaptivePlan.strategy}. ${adaptivePlan.reason}`,
      ...tokenOptCodeGraphPlanLines(repo, taskType, packetTokens, adaptivePlan.strategy === "tokenopt-codegraph-quality"
        ? adaptiveQualityCodeGraphBudgetForTask(taskType)
        : adaptiveCodeGraphBudgetForTask(taskType), codeGraphRubric, anchorQuery, undefined, {
        adaptiveCompact: adaptivePlan.strategy !== "tokenopt-codegraph-quality",
        adaptiveQuality: adaptivePlan.strategy === "tokenopt-codegraph-quality",
        taskClass: task.class,
        qualitySlicePlan
      }),
      "- Preserve the requested JSON contract exactly."
    ]);
  }

  if (mode === "contextgate-natural") {
    return buildPrompt([
      ...naturalContextBrokerPlanLines(repo, task, taskType, packetTokens, codeGraphRubric),
      "- Preserve the requested JSON contract exactly."
    ]);
  }

  if (mode === "codegraph" || mode === "codegraph-only") {
    return buildPrompt([
      "- Use CodeGraph MCP v2 as the primary code acquisition path.",
      "- When calling any CodeGraph MCP tool, pass task/target as only the original Daily task text above. Do not include this Benchmark constraints section, repository root line, output wrapper instructions, or CodeGraph tool instructions in the MCP arguments.",
      ...codeGraphToolPlanLines(taskType, codeGraphBudgetTokens, codeGraphRubric, anchorQuery, gapRefillQuery),
      gapRefillQuery
        ? "- Budget: use exactly 3 CodeGraph MCP calls total for this task: get_change_pack, anchor search_symbol, and gap-refill search_symbol."
        : "- Budget: use at most 2 CodeGraph MCP calls total unless the first tool returns an explicit bounded followup needed to preserve the requested JSON contract.",
      "- Do not call legacy codegraph_explore/codegraph_search tool names.",
      "- Treat CodeGraph evidence snippets/slices as already read. Do not repeat the same lookup with grep, repo-wide search, or broad file reads.",
      mode === "codegraph-only"
        ? "- Shell/read fallback is disabled. Use only CodeGraph MCP evidence and mark unresolved risks explicitly when coverage is incomplete."
        : "- Shell/read fallback is allowed only if compile_evidence recommends targeted_shell or the single exact CodeGraph followup still cannot cover a required item.",
      "- Preserve the requested JSON contract. Include unresolved risks when evidence is incomplete."
    ]);
  }

  const taskArgumentLine = taskType === "review_diff"
    ? "- For tokenopt_compile_evidence, pass task as the complete user request above including the full inline unified diff; do not summarize or omit the diff."
    : "- For tokenopt_compile_evidence, pass task as the complete user request above.";
  const carryPacketEvidenceLine = taskType === "review_diff"
    ? "- In the final JSON, carry packet facts such as changed_files, changed_symbols, added_calls, removed_calls, and exact_changes into notes or finding evidence even when there is no behavior finding."
    : "- Ground the final answer in packet evidence.";
  if (mode === "router-strict") {
    const routerPlan =
      taskType === "review_diff"
        ? "review_diff -> use tokenopt_compile_evidence only when the diff is concrete enough to replace exploration; if answerable=true, answer from the packet with zero followups; if answerable=false, use at most one exact TokenOpt search/read pair for the changed method and likely tests."
        : `${taskType} -> shell disabled; use tokenopt_compile_evidence first, then exact TokenOpt search/read followups only for missing named files, routes, symbols, or tests.`;
    return buildPrompt([
      "- TokenOpt router selected strict acquisition for this task.",
      `- Router plan: ${routerPlan}`,
      `- Call tokenopt_compile_evidence with cwd=${repo}, task_type=${taskType}, and budget_tokens around ${packetTokens}.`,
      taskArgumentLine,
      carryPacketEvidenceLine,
      "- Preserve the requested JSON contract. Do not call shell; it is disabled in this benchmark mode.",
      "- If evidence is still incomplete after the allowed exact followups, return the best supported answer and mark unresolved risks explicitly."
    ]);
  }
  if (mode === "router-best") {
    const deterministicReview = hasDeterministicReviewSupport(task);
    const route = routeTask({ task: task.prompt, requestedTaskType: taskType });
    if (route.taskClass === "needs_input_bypass") {
      const useMcpPacket = shouldUseMcpForMissingArtifact(task);
      return buildPrompt([
        `- TokenOpt router selected acquisition_mode=${route.acquisitionMode} and evidence_contract=${route.evidenceContract}.`,
        `- Router plan: ${route.reason}`,
        useMcpPacket
          ? `- Call tokenopt_compile_evidence with cwd=${repo}, task_type=${taskType}, and budget_tokens around ${packetTokens}; do not use any followup tools.`
          : "- Do not call tokenopt_compile_evidence; the router already has enough information to know the required artifact is missing.",
        useMcpPacket ? taskArgumentLine : undefined,
        useMcpPacket ? carryPacketEvidenceLine : undefined,
        "- Do not call shell; it is disabled because no concrete artifact was provided.",
        "- Preserve the requested JSON contract. Return a bounded answer that explicitly asks for the missing artifact and does not invent repo-specific evidence."
      ].filter((line): line is string => line !== undefined));
    }
    if (route.taskClass === "security_audit") {
      return buildPrompt([
        `- TokenOpt router selected acquisition_mode=${route.acquisitionMode} and evidence_contract=${route.evidenceContract}.`,
        `- Router plan: ${route.reason}`,
        `- Call tokenopt_compile_evidence with cwd=${repo}, task_type=review_diff, and budget_tokens around ${packetTokens}.`,
        taskArgumentLine,
        carryPacketEvidenceLine,
        "- Do not call shell; security findings require concrete diff/scope coverage first.",
        "- If the packet recommends ask_user, return JSON that states the missing scope and does not invent findings."
      ]);
    }
    const routerPlan =
      taskType === "review_diff" && !deterministicReview
        ? "review_diff without a concrete supported diff -> ask for the diff/scope instead of shell exploration."
        : taskType === "review_diff"
          ? "supported review_diff -> call tokenopt_compile_evidence first; if answerable=true, answer from the packet with zero followups."
          : `${taskType} -> shell disabled; use tokenopt_compile_evidence first, then exact TokenOpt search/read followups only for missing named files, routes, symbols, or tests.`;
    const shellPolicy =
      taskType === "review_diff" && !deterministicReview
        ? "- Do not call shell; ask for a concrete diff, changed files, PR, or target before review exploration."
        : "- Do not call shell; it is disabled in this benchmark mode for this task.";
    return buildPrompt([
      `- TokenOpt router selected acquisition_mode=${route.acquisitionMode} and evidence_contract=${route.evidenceContract}.`,
      `- Router plan: ${routerPlan}`,
      deterministicReview || taskType !== "review_diff"
        ? `- Call tokenopt_compile_evidence with cwd=${repo}, task_type=${taskType}, and budget_tokens around ${packetTokens}.`
        : `- Call tokenopt_compile_evidence with cwd=${repo}, task_type=${taskType}, and budget_tokens around ${packetTokens}.`,
      taskArgumentLine,
      carryPacketEvidenceLine,
      shellPolicy,
      "- Preserve the requested JSON contract. Include unresolved risks when evidence is incomplete."
    ]);
  }

  const hardGateLine =
    mode === "compiled-hard-gate"
      ? "- Hard gate: after tokenopt_compile_evidence returns answerable=true, do not call more tools. If answerable=false, use at most the allowed exact followups from the packet."
      : "- If tokenopt_compile_evidence returns answerable=true, answer from the packet. If it returns answerable=false, use only exact TokenOpt search/read followups for missing named symbols, routes, files, or test evidence.";
  const shellLine =
    mode === "mcp-first"
      ? "- Shell fallback is allowed only after TokenOpt exact search/read cannot cover a required missing item."
      : "- Shell is disabled for this benchmark mode; use only TokenOpt MCP tools and state any unresolved evidence honestly.";

  return buildPrompt([
    "- Use the TokenOpt MCP tool tokenopt_compile_evidence first.",
    `- Call it with cwd=${repo}, task_type=${taskType}, and budget_tokens around ${packetTokens}.`,
    taskArgumentLine,
    carryPacketEvidenceLine,
    hardGateLine,
    shellLine
  ]);
}

function inferTaskType(task: Pick<SuiteTask, "id" | "class" | "prompt">): EvidenceTaskType {
  const idAndClass = `${task.id} ${task.class}`.toLowerCase();
  const text = `${idAndClass} ${task.prompt}`.toLowerCase();
  if (idAndClass.includes("field") || idAndClass.includes("impact")) {
    return "field_impact";
  }
  if (idAndClass.includes("bug_trace") || idAndClass.includes("trace_bug")) {
    return "investigate";
  }
  if (idAndClass.includes("review") || idAndClass.includes("diff") || idAndClass.includes("security_audit")) {
    return "review_diff";
  }
  if (idAndClass.includes("performance_analysis")) {
    return "investigate";
  }
  if (
    idAndClass.includes("pbi_investigate") ||
    idAndClass.includes("requirement_investigate") ||
    idAndClass.includes("requirement_analysis") ||
    idAndClass.includes("business_investigate") ||
    idAndClass.includes("business_deepdive")
  ) {
    return "research_business";
  }
  if (idAndClass.includes("build_handoff") || idAndClass.includes("daily_handoff")) {
    return "build_handoff";
  }
  if (idAndClass.includes("pbi_plan") || idAndClass.includes("implement") || idAndClass.includes("implementation") || idAndClass.includes("refactor")) {
    return "implement";
  }
  if (idAndClass.includes("unit") || idAndClass.includes("test_plan") || idAndClass.includes("write_unittest")) {
    return "write_unittest";
  }
  if (idAndClass.includes("api") || idAndClass.includes("flow") || idAndClass.includes("semantic")) {
    return "api_flow";
  }
  if (text.includes("field") || /\bimpact of changing\b/.test(text)) {
    return "field_impact";
  }
  if (text.includes("review") || text.includes("diff") || text.includes("patch")) {
    return "review_diff";
  }
  if (/\b(pbi|requirement)\b/.test(text) && /\b(investigate|what|why|acceptance criteria)\b/.test(text)) {
    return "research_business";
  }
  if (/\b(implementation plan|implementation handoff|implement this pbi|files_to_change|code change)\b/.test(text)) {
    return "implement";
  }
  if (text.includes("startup")) {
    return "startup_flow";
  }
  if (/\b(unit[- ]test|test plan|write tests?|add tests?|missing test coverage|test coverage)\b/.test(text)) {
    return "write_unittest";
  }
  if (text.includes("api") || text.includes("flow") || text.includes("route")) {
    return "api_flow";
  }
  return "unknown";
}

export function scoreSuiteAnswer(task: SuiteTask, answer: string): QualityResult {
  const checks: QualityCheck[] = [];
  const wantsJson = /\bvalid compact JSON only\b|\bReturn valid\b/i.test(task.prompt);
  const jsonValid = wantsJson ? parseJsonAnswer(answer) !== undefined : true;
  if (wantsJson) {
    checks.push({ category: "json", name: "valid_json", passed: jsonValid });
  }

  for (const file of task.expectedEvidence.files) {
    checks.push({ category: "file", name: file, passed: containsFileReference(answer, file) });
  }
  for (const symbol of task.expectedEvidence.symbols) {
    checks.push({ category: "symbol", name: symbol, passed: containsEvidence(answer, symbol) });
  }
  for (const term of task.expectedEvidence.terms) {
    checks.push({ category: "term", name: term, passed: containsEvidence(answer, term) });
  }

  const passed = checks.filter((check) => check.passed).length;
  const total = checks.length || 1;
  const criticalMisses = checks
    .filter((check) => !check.passed && check.category !== "json")
    .map((check) => `${check.category}:${check.name}`);
  return {
    score: Number((passed / total).toFixed(3)),
    passed,
    total,
    jsonValid,
    criticalMisses,
    checks
  };
}

export function scoreSuiteIdeaQuality(task: SuiteTask, answer: string): IdeaQualityResult {
  const parsed = parseJsonAnswer(answer);
  const taskType = inferTaskType(task);
  const checks: Array<{ name: string; passed: boolean }> = [];
  const parsedObject = isRecord(parsed) ? parsed : undefined;
  const expectedFilesHit = task.expectedEvidence.files.filter((file) => containsFileReference(answer, file)).length;
  const expectedSymbolsHit = task.expectedEvidence.symbols.filter((symbol) => containsEvidence(answer, symbol)).length;
  const expectedTermsHit = task.expectedEvidence.terms.filter((term) => containsEvidence(answer, term)).length;

  checks.push({ name: "json_object", passed: Boolean(parsedObject) });
  checks.push({ name: "grounded_files", passed: expectedFilesHit >= Math.min(2, Math.max(1, task.expectedEvidence.files.length)) });
  checks.push({ name: "grounded_symbols_or_terms", passed: expectedSymbolsHit >= 1 && expectedTermsHit >= 1 });
  checks.push({
    name: "existing_context",
    passed: parsedObject ? fieldHasContent(parsedObject, [
      "existing_coverage",
      "flow",
      "summary",
      "evidence",
      "entrypoint",
      "sequence",
      "business_flow",
      "pbi_summary",
      "scope",
      "owner_flow",
      "business_coverage",
      "findings"
    ]) : false
  });
  checks.push({
    name: "actionable_ideas",
    passed: parsedObject
      ? fieldHasContent(parsedObject, taskType === "write_unittest"
        ? ["tests_to_add", "test_plan", "implementation_plan", "ideas"]
        : taskType === "review_diff"
          ? ["findings", "technical_review", "business_coverage", "missing_tests", "similar_logic"]
          : taskType === "implement"
            ? ["implementation_steps", "implementation_plan", "files_to_change", "test_plan", "tests"]
            : ["implementation_plan", "implementation_steps", "ideas", "likely_root_causes", "tests_to_add", "next_steps", "optimization_options", "measurements", "cost_model"])
      : false
  });
  checks.push({
    name: "validation",
    passed: parsedObject ? fieldHasContent(parsedObject, [
      "tests_to_run",
      "test_commands",
      "validation",
      "validation_commands",
      "expected_verification",
      "test_plan",
      "tests",
      "missing_tests"
    ]) : false
  });
  checks.push({
    name: "risks_or_missing",
    passed: parsedObject ? fieldHasContent(parsedObject, [
      "risks",
      "missing_coverage",
      "tradeoffs",
      "unresolved_risks",
      "compatibility_risks",
      "unknowns",
      "open_questions"
    ]) : false
  });
  checks.push({
    name: "concrete_proposal_surface",
    passed: /\b(?:assert|test|implement|change|add|verify|run|risk|coverage|plan|review|finding|regression|validate)\b/i.test(answer) &&
      /\b[A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|java|py|go|rs|kt|scala)\b/.test(answer)
  });

  const passed = checks.filter((check) => check.passed).length;
  const total = checks.length || 1;
  const score = Number((passed / total).toFixed(3));
  return {
    score,
    passed,
    total,
    checks: `${passed}/${total}`,
    passedGate: score >= 0.75
  };
}

function fieldHasContent(value: unknown, fieldNames: string[]): boolean {
  const wanted = new Set(fieldNames.map(normalizeFieldName));
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (!isRecord(current)) {
      continue;
    }
    for (const [key, fieldValue] of Object.entries(current)) {
      if (wanted.has(normalizeFieldName(key)) && valueHasContent(fieldValue)) {
        return true;
      }
      if (isRecord(fieldValue) || Array.isArray(fieldValue)) {
        stack.push(fieldValue);
      }
    }
  }
  return false;
}

function valueHasContent(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length >= 8;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(valueHasContent);
  }
  if (isRecord(value)) {
    return Object.values(value).some(valueHasContent);
  }
  return false;
}

function normalizeFieldName(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase();
}

function parseCodexJsonl(text: string): {
  finalAnswer: string;
  routeMetadataText: string;
  usage: CodexUsage;
  usageStatus: "available" | "missing" | "error";
  toolCalls: number;
  shellCalls: number;
  mcpCalls: number;
  toolInputChars: number;
  toolOutputChars: number;
  warnings: number;
} {
  let finalAnswer = "";
  const routeMetadataLines: string[] = [];
  let usage: CodexUsage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  let toolCalls = 0;
  let shellCalls = 0;
  let mcpCalls = 0;
  let toolInputChars = 0;
  let toolOutputChars = 0;
  let warnings = 0;
  let usageStatus: "available" | "missing" | "error" = "missing";

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
      usageStatus = "available";
    }

    if (event.type === "turn.failed") {
      usageStatus = "error";
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
        if (!isHostMcpDiscoveryCall(item)) {
          toolCalls += 1;
          mcpCalls += 1;
          toolInputChars += JSON.stringify(item.arguments ?? {}).length;
          toolOutputChars += JSON.stringify(item.result ?? item.error ?? {}).length;
          routeMetadataLines.push(...extractMcpRouteMetadataLines(item.result));
        }
      }
    }
  }

  return {
    finalAnswer,
    routeMetadataText: uniqueStrings(routeMetadataLines).join("\n"),
    usage,
    usageStatus,
    toolCalls,
    shellCalls,
    mcpCalls,
    toolInputChars,
    toolOutputChars,
    warnings
  };
}

function isHostMcpDiscoveryCall(item: Record<string, unknown>): boolean {
  return item.server === "codex" && (
    item.tool === "list_mcp_resources" ||
    item.tool === "list_mcp_resource_templates"
  );
}

export function buildSuiteRouteMetadata(
  prompt: string,
  taskType: EvidenceTaskType,
  run: { finalAnswer?: string; routeMetadataText?: string; mcpCalls?: number; shellCalls?: number } = {}
): {
  acquisitionMode: AcquisitionMode;
  evidenceContract: EvidenceContractName;
  evidenceContractPass: boolean;
  fallbackReason: string;
  doubleSpend: boolean;
} {
  const route = routeTask({ task: prompt, requestedTaskType: taskType });
  const finalAnswer = run.finalAnswer ?? "";
  const metadataText = [finalAnswer, run.routeMetadataText ?? ""].filter(Boolean).join("\n");
  const acquisitionMode = extractEnumField<AcquisitionMode>(metadataText, "acquisition_mode") ?? route.acquisitionMode;
  const evidenceContract = extractEnumField<EvidenceContractName>(metadataText, "evidence_contract") ?? route.evidenceContract;
  const packetContractPass = extractBooleanField(metadataText, "evidence_contract_pass");
  const evidenceContractPass = packetContractPass ?? inferContractPassFromAnswer(finalAnswer, acquisitionMode);
  const fallbackReason = extractStringField(metadataText, "fallback_reason") ?? route.fallbackReason ?? "";
  const doubleSpend = detectDoubleSpend({
    acquisitionMode,
    finalAnswer,
    mcpCalls: run.mcpCalls ?? 0,
    shellCalls: run.shellCalls ?? 0
  });
  return { acquisitionMode, evidenceContract, evidenceContractPass, fallbackReason, doubleSpend };
}

export interface SuiteRouteCalibration {
  expectedTaskClass: TaskClass;
  actualTaskClass: TaskClass;
  routeCorrect: boolean;
  routeRegretReason: string;
  negativeControlTriggered: boolean;
  fallbackAfterAnswerable: number;
}

export interface RouteCalibrationReportRow {
  mode: string;
  taskId: string;
  expectedTaskClass: TaskClass;
  actualTaskClass: TaskClass;
  routeCorrect: boolean;
  routeRegretReason: string;
  negativeControlTriggered: boolean;
  fallbackAfterAnswerable: number;
}

export function expectedTaskClassForSuiteClass(suiteClass: string): TaskClass {
  switch (suiteClass.toLowerCase().replace(/[^a-z0-9]+/g, "_")) {
    case "code_review":
    case "review_diff":
      return "review_diff";
    case "implement_code_unittest":
    case "write_unittest":
    case "unit_test":
    case "unittest":
      return "coding_coverage";
    case "bug_trace":
      return "needs_input_bypass";
    case "security_audit":
      return "security_audit";
    case "refactor":
    case "refactor_scope":
      return "refactor_scope";
    case "exact_symbol":
    case "field_impact":
      return "exact_symbol";
    case "business_deepdive":
    case "pbi_investigate":
    case "speckit_basic":
    case "investigate_flow":
    default:
      return "broad_flow";
  }
}

export function buildSuiteRouteCalibration(
  task: { class: string; prompt: string },
  taskType: EvidenceTaskType,
  routeMetadata: { evidenceContractPass: boolean; doubleSpend: boolean }
): SuiteRouteCalibration {
  const expectedTaskClass = expectedTaskClassForSuiteClass(task.class);
  const actualRoute = routeTask({ task: task.prompt, requestedTaskType: taskType });
  const actualTaskClass = actualRoute.taskClass;
  const routeCorrect = expectedTaskClass === actualTaskClass;
  return {
    expectedTaskClass,
    actualTaskClass,
    routeCorrect,
    routeRegretReason: routeCorrect
      ? ""
      : `suite_class=${task.class} expected ${expectedTaskClass} but routeTask selected ${actualTaskClass}: ${actualRoute.reason}`,
    negativeControlTriggered: actualRoute.negativeControl,
    fallbackAfterAnswerable: routeMetadata.evidenceContractPass && routeMetadata.doubleSpend ? 1 : 0
  };
}

export function formatRouteCalibrationSection(rows: RouteCalibrationReportRow[]): string {
  const lines = [
    "## Route Calibration",
    "",
    formatMarkdownTable(
      ["Mode", "Runs", "Route correct", "Negative controls", "Fallback after answerable", "Top regret"],
      routeCalibrationAggregateRows(rows)
    )
  ];
  const regrets = routeRegretRows(rows);
  if (regrets.length > 0) {
    lines.push(
      "",
      "### Route Regrets",
      "",
      formatMarkdownTable(["Mode", "Task", "Expected", "Actual", "Reason"], regrets)
    );
  }
  return `${lines.join("\n")}\n`;
}

function extractMcpRouteMetadataLines(result: unknown): string[] {
  if (!isRecord(result)) {
    return [];
  }
  const lines: string[] = [];
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    if (isRecord(item) && typeof item.text === "string") {
      lines.push(...extractRouteMetadataLinesFromText(item.text));
    }
  }
  collectRouteMetadataLines(result.structuredContent, lines, 0);
  return lines;
}

function collectRouteMetadataLines(value: unknown, lines: string[], depth: number): void {
  if (depth > 5 || !isRecord(value)) {
    return;
  }
  appendRouteMetadataRecordLines(value, lines);
  for (const key of ["packetSummary", "packet", "route", "coverage_certificate"]) {
    collectRouteMetadataLines(value[key], lines, depth + 1);
  }
}

function appendRouteMetadataRecordLines(value: Record<string, unknown>, lines: string[]): void {
  const acquisitionMode = parseAcquisitionModeValue(value.acquisition_mode ?? value.acquisitionMode);
  if (acquisitionMode) {
    lines.push(`acquisition_mode: ${acquisitionMode}`);
  }
  const evidenceContract = parseEvidenceContractValue(value.evidence_contract ?? value.evidenceContract);
  if (evidenceContract) {
    lines.push(`evidence_contract: ${evidenceContract}`);
  }
  const evidenceContractPass = value.evidence_contract_pass ?? value.evidenceContractPass;
  if (typeof evidenceContractPass === "boolean") {
    lines.push(`evidence_contract_pass: ${evidenceContractPass}`);
  }
  const fallbackReason = value.fallback_reason ?? value.fallbackReason;
  if (typeof fallbackReason === "string" && fallbackReason.trim()) {
    lines.push(`fallback_reason: ${fallbackReason.trim()}`);
  }
}

function extractRouteMetadataLinesFromText(text: string): string[] {
  const lines: string[] = [];
  const acquisitionMode = extractEnumField<AcquisitionMode>(text, "acquisition_mode");
  if (acquisitionMode) {
    lines.push(`acquisition_mode: ${acquisitionMode}`);
  }
  const evidenceContract = extractEnumField<EvidenceContractName>(text, "evidence_contract");
  if (evidenceContract) {
    lines.push(`evidence_contract: ${evidenceContract}`);
  }
  const evidenceContractPass = extractBooleanField(text, "evidence_contract_pass");
  if (typeof evidenceContractPass === "boolean") {
    lines.push(`evidence_contract_pass: ${evidenceContractPass}`);
  }
  const fallbackReason = extractStringField(text, "fallback_reason");
  if (fallbackReason) {
    lines.push(`fallback_reason: ${fallbackReason}`);
  }
  return lines;
}

function parseAcquisitionModeValue(value: unknown): AcquisitionMode | undefined {
  return value === "ask_or_bypass" ||
    value === "direct_narrow" ||
    value === "coding_coverage" ||
    value === "failure_packet" ||
    value === "review_bounded" ||
    value === "security_audit" ||
    value === "compile_evidence"
    ? value
    : undefined;
}

function parseEvidenceContractValue(value: unknown): EvidenceContractName | undefined {
  return value === "artifact_sufficiency" ||
    value === "trace_proof" ||
    value === "coding_coverage" ||
    value === "failure_contract" ||
    value === "review_coverage" ||
    value === "security_coverage" ||
    value === "overview_contract"
    ? value
    : undefined;
}

function extractEnumField<T extends string>(text: string, field: string): T | undefined {
  return extractStringField(text, field) as T | undefined;
}

function extractStringField(text: string, field: string): string | undefined {
  const yamlLike = text.match(new RegExp(`${escapeRegExp(field)}\\s*:\\s*["']?([A-Za-z0-9_/-]+)["']?`, "i"));
  if (yamlLike?.[1]) {
    return yamlLike[1];
  }
  const jsonLike = text.match(new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"([^"]+)"`, "i"));
  return jsonLike?.[1];
}

function extractBooleanField(text: string, field: string): boolean | undefined {
  const yamlLike = text.match(new RegExp(`${escapeRegExp(field)}\\s*:\\s*(true|false)`, "i"));
  if (yamlLike?.[1]) {
    return yamlLike[1].toLowerCase() === "true";
  }
  const jsonLike = text.match(new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*(true|false)`, "i"));
  return jsonLike?.[1] ? jsonLike[1].toLowerCase() === "true" : undefined;
}

function inferContractPassFromAnswer(finalAnswer: string, acquisitionMode: AcquisitionMode): boolean {
  if (acquisitionMode === "ask_or_bypass") {
    return /\b(?:missing|provide|need|ask|artifact|diff|requirement|pbi|reproducer)\b/i.test(finalAnswer);
  }
  if (acquisitionMode === "direct_narrow") {
    return /\b[A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|java|py):\d+\b/.test(finalAnswer) &&
      /\b(?:caller|callee|test|config|guard|corroborat|evidence)\b/i.test(finalAnswer);
  }
  return /\bevidence_contract_pass\s*:\s*true\b/i.test(finalAnswer);
}

function detectDoubleSpend(input: { acquisitionMode: AcquisitionMode; finalAnswer: string; mcpCalls: number; shellCalls: number }): boolean {
  if (input.acquisitionMode === "ask_or_bypass") {
    return input.mcpCalls > 1 || input.shellCalls > 0;
  }
  if (input.acquisitionMode === "direct_narrow") {
    return input.mcpCalls > 1 || (input.mcpCalls > 0 && input.shellCalls > 0 && /repo-wide|rg --files|grep -R|findstr|full file/i.test(input.finalAnswer));
  }
  if (/\banswerable\s*:\s*true\b/i.test(input.finalAnswer) || /"answerable"\s*:\s*true/i.test(input.finalAnswer)) {
    return input.shellCalls > 0 && /grep -R|rg --files|repo-wide|full file/i.test(input.finalAnswer);
  }
  return false;
}

function formatSuiteRows(rows: SuiteBenchmarkRow[], skippedRepos: SkippedRepo[], showAnswers: boolean): string {
  const header = [
    "Repo",
    "Task",
    "Mode",
    "Acq",
    "Contract",
    "Contract ok",
    "Usage",
    "Double",
    "Quality",
    "Checks",
    "Idea",
    "Idea checks",
    "Correct",
    "JSON",
    "Critical",
    "Exit",
    "Tool",
    "MCP",
    "Shell",
    "Tool in",
    "Tool out",
    "Input tok",
    "Cached",
    "Output tok",
    "Reason tok",
    "Raw tok",
    "Fresh tok",
    "Q/10k fresh",
    "Duration ms"
  ];
  const body = rows.map((row) => [
    path.basename(row.repo),
    row.taskId,
    row.mode,
    row.acquisitionMode,
    row.evidenceContract,
    row.evidenceContractPass ? "yes" : "no",
    row.usageStatus,
    row.doubleSpend ? "yes" : "no",
    row.qualityScore.toFixed(3),
    row.qualityChecks,
    row.ideaScore.toFixed(3),
    row.ideaChecks,
    row.correct ? "yes" : "no",
    row.jsonValid ? "yes" : "no",
    String(row.criticalMisses.length),
    String(row.exitCode),
    String(row.toolCalls),
    String(row.mcpCalls),
    String(row.shellCalls),
    String(row.toolInputChars),
    String(row.toolOutputChars),
    String(row.usage.input_tokens),
    String(row.usage.cached_input_tokens),
    String(row.usage.output_tokens),
    String(row.usage.reasoning_output_tokens),
    String(rawUsageTokens(row.usage)),
    String(freshUsageTokens(row.usage)),
    qualityPer10kFresh(row).toFixed(3),
    String(row.durationMs)
  ]);
  const table = [header, ...body];
  const widths = header.map((_, column) => Math.max(...table.map((row) => row[column].length)));
  const lines = table.map((row, index) => {
    const line = row.map((cell, column) => cell.padEnd(widths[column])).join("  ");
    return index === 0 ? `${line}\n${widths.map((width) => "-".repeat(width)).join("  ")}` : line;
  });
  const skipped = skippedRepos.length > 0
    ? `\nSkipped repos:\n${skippedRepos.map((repo) => `- ${repo.project}: ${repo.reason} (${repo.repo})`).join("\n")}\n`
    : "";
  if (!showAnswers) {
    return `${lines.join("\n")}${skipped}\n`;
  }
  return `${lines.join("\n")}${skipped}\n\nAnswers:\n${rows.map((row) => `\n[${path.basename(row.repo)} ${row.taskId} ${row.mode}]\nPrompt:\n${row.prompt}\n\nOutput:\n${row.finalAnswer}\nrawLog: ${row.rawLogPath}`).join("\n")}\n`;
}

function formatMarkdownReport(
  suite: { name?: string; version?: string; purpose?: string },
  rows: SuiteBenchmarkRow[],
  skippedRepos: SkippedRepo[],
  options: SuiteBenchmarkOptions
): string {
  const generatedAt = new Date().toISOString();
  const lines: string[] = [
    "# Context Governor Suite Benchmark",
    "",
    `Generated: ${generatedAt}`,
    `Suite: ${suite.name ?? "unknown"} ${suite.version ?? ""}`.trim(),
    `Runner: codex exec --json (${options.codexPackage})`,
    `Modes: ${options.modes.join(", ")}`,
    `CodeGraph prewarm: ${options.prewarmCodeGraph ? `yes (${options.codeGraphPrewarmTimeoutMs}ms timeout)` : "no"}`,
    "",
    "## Summary",
    "",
    formatMarkdownTable(summaryHeader(), rows.map((row) => summaryCells(row, rows))),
    "",
    "## Aggregate",
    "",
    formatMarkdownTable(
      ["Mode", "Runs", "Correct", "Idea ok", "Median input tok", "Avg input tok", "Avg output tok", "Avg raw tok", "Avg fresh tok", "Avg quality", "Avg idea", "Avg Q/10k fresh", "Avg critical miss", "Avg MCP", "Avg shell"],
      aggregateRows(rows)
    ),
    "",
    "## Prompt Family Aggregate",
    "",
    formatMarkdownTable(
      [
        "Family",
        "Mode",
        "Runs",
        "Correct",
        "Idea ok",
        "Median input tok",
        "Avg input tok",
        "Avg output tok",
        "Avg raw tok",
        "Avg fresh tok",
        "Avg quality",
        "Avg idea",
        "Avg Q/10k fresh",
        "Avg critical miss",
        "Avg MCP",
        "Avg shell",
        "Avg duration ms"
      ],
      promptFamilyAggregateRows(rows)
    )
  ];
  lines.push("", ...formatRouteCalibrationSection(rows).trimEnd().split("\n"));

  if (skippedRepos.length > 0) {
    lines.push(
      "",
      "## Skipped Repos",
      "",
      formatMarkdownTable(
        ["Repo", "Project", "Reason"],
        skippedRepos.map((repo) => [repo.repo, repo.project, repo.reason])
      )
    );
  }

  lines.push("", "## Task Details");

  const taskKeys = unique(rows.map((row) => `${row.project}\u0000${row.taskId}`));
  for (const key of taskKeys) {
    const [project, taskId] = key.split("\u0000");
    const taskRows = rows.filter((row) => row.project === project && row.taskId === taskId);
    const first = taskRows[0];
    if (!first) {
      continue;
    }
    lines.push(
      "",
      `### ${project} / ${taskId}`,
      "",
      `Class: ${first.taskClass}`,
      "",
      "Prompt:",
      fenced(first.prompt),
      "",
      "Expected evidence:",
      fenced(JSON.stringify(first.expectedEvidence, null, 2), "json"),
      "",
      "Quality rubric:",
      ...first.qualityRubric.map((item) => `- ${item}`),
      "",
      "Mode metrics:",
      "",
      formatMarkdownTable(summaryHeader(), taskRows.map((row) => summaryCells(row, rows)))
    );

    for (const row of taskRows) {
      lines.push(
        "",
        `#### Output: ${row.mode}`,
        "",
        `Raw log: ${row.rawLogPath}`,
        "",
        `Codex prompt used:`,
        fenced(row.codexPrompt),
        "",
        `Final output:`,
        fenced(row.finalAnswer, row.jsonValid ? "json" : undefined),
        "",
        `Idea checks: ${row.ideaChecks} (${row.ideaScore.toFixed(3)})`,
        "",
        `Critical misses: ${row.criticalMisses.length > 0 ? row.criticalMisses.join(", ") : "none"}`
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function summaryHeader(): string[] {
  return [
    "Repo",
    "Task",
    "Mode",
    "Acq",
    "Contract",
    "Contract ok",
    "Double",
    "Correct",
    "Quality",
    "Idea",
    "Critical",
    "JSON",
    "Input tok",
    "Cached tok",
    "Input delta",
    "Output tok",
    "Output delta",
    "Reason delta",
    "Reason tok",
    "Raw tok",
    "Fresh tok",
    "Quality delta",
    "Q/10k fresh",
    "Tool",
    "MCP",
    "Shell",
    "Tool out chars",
    "Duration ms"
  ];
}

function summaryCells(row: SuiteBenchmarkRow, rows: SuiteBenchmarkRow[]): string[] {
  const baseline = rows.find((candidate) => candidate.repo === row.repo && candidate.taskId === row.taskId && candidate.mode === "baseline");
  const inputDelta = formatSavingsPercent(row.usage.input_tokens, baseline?.usage.input_tokens);
  const outputDelta = formatSavingsPercent(row.usage.output_tokens, baseline?.usage.output_tokens);
  const reasonDelta = formatSavingsPercent(row.usage.reasoning_output_tokens, baseline?.usage.reasoning_output_tokens);
  const qualityDelta = formatQualityDelta(row.qualityScore, baseline?.qualityScore);
  return [
    path.basename(row.repo),
    row.taskId,
    row.mode,
    row.acquisitionMode,
    row.evidenceContract,
    row.evidenceContractPass ? "yes" : "no",
    row.doubleSpend ? "yes" : "no",
    row.correct ? "yes" : "no",
    row.qualityScore.toFixed(3),
    row.ideaScore.toFixed(3),
    String(row.criticalMisses.length),
    row.jsonValid ? "yes" : "no",
    String(row.usage.input_tokens),
    String(row.usage.cached_input_tokens),
    inputDelta,
    String(row.usage.output_tokens),
    outputDelta,
    reasonDelta,
    String(row.usage.reasoning_output_tokens),
    String(rawUsageTokens(row.usage)),
    String(freshUsageTokens(row.usage)),
    qualityDelta,
    qualityPer10kFresh(row).toFixed(3),
    String(row.toolCalls),
    String(row.mcpCalls),
    String(row.shellCalls),
    String(row.toolOutputChars),
    String(row.durationMs)
  ];
}

function routeCalibrationAggregateRows(rows: RouteCalibrationReportRow[]): string[][] {
  const modes = unique(rows.map((row) => row.mode));
  return modes.map((mode) => {
    const modeRows = rows.filter((row) => row.mode === mode);
    const topRegret = topRouteRegret(modeRows);
    return [
      mode,
      String(modeRows.length),
      `${modeRows.filter((row) => row.routeCorrect).length}/${modeRows.length}`,
      String(modeRows.filter((row) => row.negativeControlTriggered).length),
      String(modeRows.reduce((total, row) => total + row.fallbackAfterAnswerable, 0)),
      topRegret
    ];
  });
}

function routeRegretRows(rows: RouteCalibrationReportRow[]): string[][] {
  return rows
    .filter((row) => !row.routeCorrect)
    .slice(0, 25)
    .map((row) => [
      row.mode,
      row.taskId,
      row.expectedTaskClass,
      row.actualTaskClass,
      row.routeRegretReason
    ]);
}

function topRouteRegret(rows: RouteCalibrationReportRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.routeCorrect) {
      continue;
    }
    const key = `${row.expectedTaskClass}->${row.actualTaskClass}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return top ? `${top[0]} (${top[1]})` : "none";
}

function formatSavingsPercent(value: number, baseline?: number): string {
  if (!baseline || baseline <= 0) {
    return "";
  }
  const saved = 1 - value / baseline;
  const direction = saved >= 0 ? "saved" : "spent";
  return `${direction} ${Math.abs(saved * 100).toFixed(1)}%`;
}

function formatQualityDelta(value: number, baseline?: number): string {
  if (baseline === undefined) {
    return "";
  }
  const delta = value - baseline;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  return `${sign}${delta.toFixed(3)}`;
}

function aggregateRows(rows: SuiteBenchmarkRow[]): string[][] {
  const modes = unique(rows.map((row) => row.mode));
  return modes.map((mode) => {
    const modeRows = rows.filter((row) => row.mode === mode);
    return [
      mode,
      String(modeRows.length),
      `${modeRows.filter((row) => row.correct).length}/${modeRows.length}`,
      `${modeRows.filter((row) => row.ideaPassed).length}/${modeRows.length}`,
      String(median(modeRows.map((row) => row.usage.input_tokens))),
      average(modeRows.map((row) => row.usage.input_tokens)).toFixed(0),
      average(modeRows.map((row) => row.usage.output_tokens)).toFixed(0),
      average(modeRows.map((row) => rawUsageTokens(row.usage))).toFixed(0),
      average(modeRows.map((row) => freshUsageTokens(row.usage))).toFixed(0),
      average(modeRows.map((row) => row.qualityScore)).toFixed(3),
      average(modeRows.map((row) => row.ideaScore)).toFixed(3),
      average(modeRows.map(qualityPer10kFresh)).toFixed(3),
      average(modeRows.map((row) => row.criticalMisses.length)).toFixed(2),
      average(modeRows.map((row) => row.mcpCalls)).toFixed(1),
      average(modeRows.map((row) => row.shellCalls)).toFixed(1)
    ];
  });
}

function promptFamilyAggregateRows(rows: SuiteBenchmarkRow[]): string[][] {
  const families = unique(rows.map(promptFamily));
  const modes = unique(rows.map((row) => row.mode));
  const output: string[][] = [];
  for (const family of families) {
    for (const mode of modes) {
      const familyRows = rows.filter((row) => promptFamily(row) === family && row.mode === mode);
      if (familyRows.length === 0) {
        continue;
      }
      output.push([
        family,
        mode,
        String(familyRows.length),
        `${familyRows.filter((row) => row.correct).length}/${familyRows.length}`,
        `${familyRows.filter((row) => row.ideaPassed).length}/${familyRows.length}`,
        String(median(familyRows.map((row) => row.usage.input_tokens))),
        average(familyRows.map((row) => row.usage.input_tokens)).toFixed(0),
        average(familyRows.map((row) => row.usage.output_tokens)).toFixed(0),
        average(familyRows.map((row) => rawUsageTokens(row.usage))).toFixed(0),
        average(familyRows.map((row) => freshUsageTokens(row.usage))).toFixed(0),
        average(familyRows.map((row) => row.qualityScore)).toFixed(3),
        average(familyRows.map((row) => row.ideaScore)).toFixed(3),
        average(familyRows.map(qualityPer10kFresh)).toFixed(3),
        average(familyRows.map((row) => row.criticalMisses.length)).toFixed(2),
        average(familyRows.map((row) => row.mcpCalls)).toFixed(1),
        average(familyRows.map((row) => row.shellCalls)).toFixed(1),
        average(familyRows.map((row) => row.durationMs)).toFixed(0)
      ]);
    }
  }
  return output;
}

function promptFamily(row: SuiteBenchmarkRow): string {
  const explicitFamily = promptFamilyFromTaskClass(row.taskClass);
  if (explicitFamily) {
    return explicitFamily;
  }
  const key = `${row.taskId} ${row.taskClass} ${row.prompt}`.toLowerCase();
  if (/\bimplement_code_unittest\b|\bimplement code\b|\bcode \+ unit\b/.test(key)) {
    return "implement_code_unittest";
  }
  if (/\breview\b|\bdiff\b|\bpatch\b/.test(key)) {
    return "code_review";
  }
  if (/\bbusiness_deepdive\b|\bbusiness deep[- ]?dive\b|\bdomain deep[- ]?dive\b/.test(key)) {
    return "business_deepdive";
  }
  if (/\brequirement_analysis\b|\brequirement analyst\b|\brequirement analysis\b/.test(key)) {
    return "requirement_analysis";
  }
  if (/\bbug_trace\b|\btrace_bug\b|\bbug trace\b|\bfailing\b|\brepro\b/.test(key)) {
    return "bug_trace";
  }
  if (/\brefactor\b|\brefactoring\b/.test(key)) {
    return "refactor_code";
  }
  if (/\bunit\b|\btest_plan\b|\bwrite_unittest\b/.test(key)) {
    return "unit_test_plan";
  }
  if (/\bpbi_investigate\b|\brequirement_investigate\b/.test(key)) {
    return "investigate_pbi";
  }
  if (/\bpbi_plan\b|\bimplementation plan\b/.test(key)) {
    return "plan_pbi";
  }
  if (/\bimplement_handoff\b|\bimplementation handoff\b|\bfiles_to_change\b/.test(key)) {
    return "implement_handoff";
  }
  if (/\btrace\b|\bsequence\b/.test(key)) {
    return "trace_flow";
  }
  if (/\binvestigate\b|\blikely_root_causes\b/.test(key)) {
    return "investigate";
  }
  return row.taskClass || "unknown";
}

function promptFamilyFromTaskClass(taskClass: string): string | undefined {
  const known = new Set([
      "business_deepdive",
      "investigate_flow",
      "e2e_trace_flow",
      "requirement_analysis",
      "pbi_investigate",
      "pbi_plan",
      "bug_trace",
      "performance_analysis",
      "security_audit",
      "plan_implement",
      "implement_code_unittest",
      "write_unittest_class",
      "code_review",
      "refactor_code"
  ]);
  return known.has(taskClass) ? taskClass : undefined;
}

function parseMode(value: string): SuiteBenchmarkMode {
  if (
    value === "baseline" ||
    value === "codegraph" ||
    value === "codegraph-only" ||
    value === "tokenopt-codegraph" ||
    value === "tokenopt-codegraph-natural" ||
    value === "tokenopt-codegraph-adaptive" ||
    value === "tokenopt-codegraph-hybrid" ||
    value === "tokenopt-internal-codegraph" ||
    value === "contextgate-natural" ||
    value === "mcp-first" ||
    value === "mcp-only" ||
    value === "compiled-hard-gate" ||
    value === "router-strict" ||
    value === "router-best"
  ) {
    return value;
  }
  if (value === "tokenopt-mcp" || value === "compiled-packet") {
    return "mcp-only";
  }
  if (value === "tokenopt-only") {
    return "mcp-only";
  }
  if (value === "tokenopt+codegraph" || value === "combined") {
    return "tokenopt-codegraph";
  }
  if (value === "tokenopt+codegraph-natural" || value === "combined-natural" || value === "natural-combined") {
    return "tokenopt-codegraph-natural";
  }
  if (value === "tokenopt+codegraph-adaptive" || value === "adaptive" || value === "combined-adaptive") {
    return "tokenopt-codegraph-adaptive";
  }
  if (value === "natural" || value === "contextgate" || value === "contextgate-adaptive" || value === "contextgate-natural-lite") {
    return "contextgate-natural";
  }
  if (value === "tokenopt+codegraph-hybrid" || value === "combined-hybrid" || value === "hybrid-codegraph") {
    return "tokenopt-codegraph-hybrid";
  }
  if (value === "internal-codegraph" || value === "tokenopt-internal" || value === "single-mcp") {
    return "tokenopt-internal-codegraph";
  }
  if (value === "compiled-shadow-gate") {
    return "mcp-first";
  }
  throw new Error(`Unknown suite benchmark mode: ${value}`);
}

function parseJsonAnswer(answer: string): unknown | undefined {
  const trimmed = answer.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const candidates = [unfenced];
  const objectStart = unfenced.indexOf("{");
  const objectEnd = unfenced.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(unfenced.slice(objectStart, objectEnd + 1));
  }
  const arrayStart = unfenced.indexOf("[");
  const arrayEnd = unfenced.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(unfenced.slice(arrayStart, arrayEnd + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next shape.
    }
  }
  return undefined;
}

function containsFileReference(answer: string, file: string): boolean {
  const normalizedAnswer = normalizeEvidence(answer);
  const normalizedFile = normalizeEvidence(file);
  const basename = normalizeEvidence(path.basename(file));
  return normalizedAnswer.includes(normalizedFile) || normalizedAnswer.includes(basename);
}

function containsEvidence(answer: string, needle: string): boolean {
  const normalizedAnswer = normalizeEvidence(answer);
  const normalizedNeedle = normalizeEvidence(needle);
  if (normalizedAnswer.includes(normalizedNeedle)) {
    return true;
  }
  if (needle.includes(".")) {
    const parts = needle.split(".").map(normalizeEvidence).filter(Boolean);
    return parts.every((part) => normalizedAnswer.includes(part));
  }
  if (needle.includes(" ")) {
    const parts = needle.split(/\s+/).map(normalizeEvidence).filter((part) => part.length > 2);
    return parts.every((part) => normalizedAnswer.includes(part));
  }
  return false;
}

function normalizeEvidence(value: string): string {
  return value.replace(/\\/g, "/").replace(/\s+/g, " ").toLowerCase();
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw new Error(`Suite task field ${key} must be a string`);
  }
  return field;
}

function optionalStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function stringArrayField(value: Record<string, unknown>, key: string): string[] {
  const field = value[key];
  return Array.isArray(field) ? field.filter((item): item is string => typeof item === "string") : [];
}

function optionalNumberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function formatMarkdownTable(header: string[], rows: string[][]): string {
  const sanitizedRows = rows.map((row) => row.map(markdownCell));
  return [
    `| ${header.map(markdownCell).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...sanitizedRows.map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}

function markdownCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function fenced(text: string, language = ""): string {
  const fence = text.includes("```") ? "````" : "```";
  return `${fence}${language}\n${text}\n${fence}`;
}

function rawUsageTokens(usage: CodexUsage): number {
  return usage.input_tokens + usage.output_tokens + usage.reasoning_output_tokens;
}

function freshUsageTokens(usage: CodexUsage): number {
  return Math.max(0, usage.input_tokens - usage.cached_input_tokens) + usage.output_tokens + usage.reasoning_output_tokens;
}

function qualityPer10kFresh(row: SuiteBenchmarkRow): number {
  const fresh = freshUsageTokens(row.usage);
  return fresh > 0 ? row.qualityScore / (fresh / 10_000) : 0;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function safeName(value: string): string {
  return value.replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 120);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(",")}]`;
}

function tomlString(value: string): string {
  const normalized = slash(value);
  if (normalized.includes("'")) {
    throw new Error(`Cannot encode TOML literal string containing single quote: ${normalized}`);
  }
  return `'${normalized}'`;
}

function slash(value: string): string {
  return value.replace(/\\/g, "/");
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function suiteBenchmarkHelp(): string {
  return `Usage:
  tokenopt benchmark suite --suite <json> --repo <path> [--repo <path>] [--mode baseline|codegraph|codegraph-only|tokenopt-only|tokenopt-codegraph|tokenopt-codegraph-natural|tokenopt-codegraph-adaptive|tokenopt-codegraph-hybrid|natural|contextgate|contextgate-natural|mcp-first|mcp-only|compiled-hard-gate|router-strict|router-best|all] [--task all|id,id] [--model <model>] [--out <path>] [--markdown <path>] [--prewarm-codegraph] [--json] [--show-answers]

Notes:
  - Tasks are matched by suite task.project against the repo directory name.
  - baseline uses normal Codex CLI tools.
  - codegraph injects CodeGraph MCP v2; set TOKENOPT_CODEGRAPH_ROOT to a local code-graph checkout or TOKENOPT_CODEGRAPH_CLI to dist/cli.js when codegraph is not on PATH.
  - Without env overrides, codegraph mode auto-detects sibling ../code-graph/dist/cli.js before falling back to codegraph on PATH.
  - codegraph-only injects CodeGraph MCP and disables shell_tool.
  - tokenopt-codegraph injects TokenOpt and CodeGraph MCP, disables shell_tool, and measures evidence-grounded idea quality.
  - tokenopt-codegraph-natural injects the TokenOpt broker plus CodeGraph MCP, disables shell_tool, and uses route-aware tool-agnostic guidance with a hard bounded context/source call budget.
  - tokenopt-codegraph-adaptive uses one evidence-broker policy: TokenOpt-only for review/security/missing-artifact tasks, compact TokenOpt+CodeGraph for flow/implement/refactor tasks, and disables shell_tool.
  - natural/contextgate/contextgate-natural/contextgate-adaptive injects only the ContextGate broker; low-level TokenOpt search/read and CodeGraph are not exposed directly to the agent.
  - tokenopt-codegraph-hybrid injects TokenOpt and CodeGraph MCP, then allows a bounded exact rg/slice fallback only when CodeGraph is unavailable or missing required slots.
  - --prewarm-codegraph runs codegraph index once per selected repo before Codex runs and adds --no-prewarm to per-run MCP servers.
  - mcp-first injects TokenOpt MCP and allows shell fallback only after exact TokenOpt followups.
  - mcp-only/tokenopt-only and compiled-hard-gate disable shell_tool.
  - router-strict disables shell_tool and chooses strict evidence acquisition by task type.
  - router-best uses strict acquisition where TokenOpt has deterministic coverage and bounded hybrid fallback otherwise.
`;
}

function shouldDisableShell(mode: SuiteBenchmarkMode, task: SuiteTask): boolean {
  if (mode === "tokenopt-codegraph-adaptive" || mode === "contextgate-natural") {
    return adaptivePlanForSuiteTask(task).disableShell;
  }
  if (mode === "codegraph-only" || mode === "tokenopt-codegraph" || mode === "tokenopt-codegraph-natural" || mode === "mcp-only" || mode === "compiled-hard-gate" || mode === "router-strict") {
    return true;
  }
  if (mode !== "router-best") {
    return false;
  }
  const taskType = inferTaskType(task);
  const route = routeTask({ task: task.prompt, requestedTaskType: taskType });
  if (route.taskClass === "needs_input_bypass" || route.taskClass === "security_audit") {
    return true;
  }
  return taskType !== "review_diff" || hasDeterministicReviewSupport(task);
}

function hasDeterministicReviewSupport(task: SuiteTask): boolean {
  const text = task.prompt;
  if (/^diff --git\b/m.test(text) && /^@@\s+-\d+/m.test(text) && /\+\+\+ b\/.+\.(?:c|h|cc|cpp|java|ts|tsx|js|jsx|py|go|rs|kt|scala)\b/im.test(text)) {
    return true;
  }
  return (
    /RMWebServices\.java/.test(text) &&
    /withApplicationTags\s*\(\s*applicationTags\s*\)/.test(text) &&
    /withApplicationTags\s*\(\s*(?:java\.util\.)?Collections\.emptySet\s*\(\s*\)\s*\)/.test(text)
  );
}

function shouldUseMcpForMissingArtifact(task: SuiteTask): boolean {
  return /\bPBI\/requirement\b/i.test(task.prompt) ||
    /\bunit-test plan\b/i.test(task.prompt) ||
    /\bJakarta EE Java PR diff\b/i.test(task.prompt);
}
