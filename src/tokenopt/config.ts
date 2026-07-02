import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LoadedConfig, TokenOptConfig } from "./types.js";

export const DEFAULT_CONFIG: TokenOptConfig = {
  version: 1,
  policy: {
    enabled: true,
    maxFileReadBytes: 96_000,
    maxCommandOutputChars: 16_000,
    denyGeneratedReads: true,
    denyLockfileReads: true,
    broadSearch: {
      mode: "deny",
      maxResults: 80
    },
    expensiveTests: {
      mode: "rewrite",
      patterns: [
        "^npm(?:\\.cmd)?\\s+(?:run\\s+)?test(?::\\w+)?(?:\\s+--)?\\s*$",
        "^yarn\\s+test\\s*$",
        "^pnpm\\s+(?:run\\s+)?test\\s*$",
        "^pytest\\s*$",
        "^go\\s+test\\s+\\.\\/\\.\\.\\.\\s*$",
        "^cargo\\s+test\\s*$",
        "^(?:\\.\\/|\\.\\\\)?gradlew(?:\\.bat)?\\s+(?:test|check)\\s*$",
        "^gradle(?:\\.bat)?\\s+(?:test|check)\\s*$",
        "^mvn(?:\\.cmd)?(?:\\s+[^\\s]+)*\\s+(?:test|verify)(?:\\s|$)"
      ],
      targetedHint: "Run a targeted test first, or let TokenOpt wrap the command to compact noisy output."
    },
    answerabilityGate: {
      mode: "hard",
      logShadowDecisions: true
    },
    gateway: {
      mode: "shadow",
      requireContextGateFor: ["pbi_code", "requirement_code", "review_business_coverage", "broad_research"]
    }
  },
  context: {
    enableSecretBlock: true,
    userPromptGuidance:
      "ContextGate is the primary source-evidence gate and evidence broker for broad or unknown-owner repository tasks. For repo investigation, architecture, flow tracing, implementation planning, PBI-to-code impact, code review with a diff, debugging, refactor scope, build handoff, or unit-test planning, call contextgate_get_context first when it can replace raw exploration. Use Jira/Confluence/GitHub tools for external artifacts, then use ContextGate for source-code slots such as impacted files, symbols, current behavior, tests, and validation. Treat the packet as a coverage contract: if answerable=true or recommended_next_action=answer_now, answer from it with zero redundant exploration; if slots are missing, refill only those named slots with bounded TokenOpt search/read followups. For exact known-file or exact line-level edits, narrow direct reads are acceptable. Avoid MCP+shell double-spend."
  },
  paths: {},
  codex: {
    installScope: "repo"
  },
  codegraph: {
    enabled: false,
    cliPath: undefined
  }
};

export interface LoadConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const home = getHomeDir(env);
  const userConfigPath = path.join(home, ".tokenopt", "config.json");
  const repoRoot = findRepoRoot(cwd);
  const repoConfigPath = path.join(repoRoot, ".tokenopt", "config.json");
  const loadedPaths: string[] = [];

  let config = cloneConfig(DEFAULT_CONFIG);
  const userConfig = readJsonIfExists(userConfigPath);
  if (userConfig) {
    config = deepMerge(config, userConfig) as TokenOptConfig;
    loadedPaths.push(userConfigPath);
  }

  const repoConfig = readJsonIfExists(repoConfigPath);
  if (repoConfig) {
    config = deepMerge(config, repoConfig) as TokenOptConfig;
    loadedPaths.push(repoConfigPath);
  }

  config = applyEnvOverrides(config, env);
  return { config, repoRoot, userConfigPath, repoConfigPath, loadedPaths };
}

export function getHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function findRepoRoot(startDir: string): string {
  let current = path.resolve(startDir);
  while (true) {
    if (
      fs.existsSync(path.join(current, ".tokenopt", "config.json")) ||
      fs.existsSync(path.join(current, ".git")) ||
      fs.existsSync(path.join(current, "package.json"))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir);
    }
    current = parent;
  }
}

export function makeDefaultRepoConfig(): TokenOptConfig {
  return cloneConfig(DEFAULT_CONFIG);
}

export function ensureConfigDir(configPath: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
}

function applyEnvOverrides(config: TokenOptConfig, env: NodeJS.ProcessEnv): TokenOptConfig {
  const next = cloneConfig(config);
  if (env.TOKENOPT_POLICY) {
    next.policy.enabled = !["0", "false", "off", "no"].includes(env.TOKENOPT_POLICY.toLowerCase());
  }
  if (env.TOKENOPT_MAX_OUTPUT_CHARS) {
    const parsed = Number.parseInt(env.TOKENOPT_MAX_OUTPUT_CHARS, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      next.policy.maxCommandOutputChars = parsed;
    }
  }
  if (env.TOKENOPT_ARTIFACT_DIR) {
    next.paths.artifactDir = env.TOKENOPT_ARTIFACT_DIR;
  }
  if (env.TOKENOPT_ANSWERABILITY_GATE) {
    const mode = env.TOKENOPT_ANSWERABILITY_GATE.toLowerCase();
    if (mode === "hard" || mode === "shadow" || mode === "off") {
      next.policy.answerabilityGate.mode = mode;
    }
  }
  if (env.TOKENOPT_GATEWAY_POLICY) {
    const mode = env.TOKENOPT_GATEWAY_POLICY.toLowerCase();
    if (mode === "hard" || mode === "shadow" || mode === "off") {
      next.policy.gateway.mode = mode;
    }
  }
  if (env.TOKENOPT_CODEGRAPH_CLI) {
    next.codegraph.cliPath = env.TOKENOPT_CODEGRAPH_CLI.trim();
  }
  return next;
}

function readJsonIfExists(filePath: string): unknown | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as unknown;
}

function cloneConfig(config: TokenOptConfig): TokenOptConfig {
  return JSON.parse(JSON.stringify(config)) as TokenOptConfig;
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) {
    return override ?? base;
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    result[key] = key in result ? deepMerge(result[key], value) : value;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
