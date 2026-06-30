import { spawn } from "node:child_process";
import { compressText } from "./log-compressor.js";
import { appendEvent, writeArtifact } from "./observability.js";
import type { TokenOptConfig } from "./types.js";

export interface WrappedCommandResult {
  command: string;
  exitCode: number;
  durationMs: number;
  rawArtifact: string;
  summary: string;
  rawOutput: string;
  estimatedTokensSaved: number;
}

export async function runWrappedCommand(args: string[], config: TokenOptConfig, repoRoot: string): Promise<number> {
  if (args.length === 0) {
    process.stderr.write("Usage: tokenopt exec -- <command...>\n");
    return 2;
  }

  const result = await executeWrappedProcess(args, config, repoRoot, process.cwd());
  process.stdout.write(`${result.summary}\n`);
  return result.exitCode;
}

export async function executeWrappedProcess(
  args: string[],
  config: TokenOptConfig,
  repoRoot: string,
  cwd = process.cwd()
): Promise<WrappedCommandResult> {
  const started = Date.now();
  const child = spawn(args[0]!, args.slice(1), {
    cwd,
    env: process.env,
    shell: process.platform === "win32"
  });
  return collectWrappedResult(child, args.join(" "), started, config, repoRoot);
}

export async function executeWrappedShellCommand(
  command: string,
  config: TokenOptConfig,
  repoRoot: string,
  cwd = process.cwd()
): Promise<WrappedCommandResult> {
  const started = Date.now();
  const child = spawn(command, {
    cwd,
    env: process.env,
    shell: true
  });
  return collectWrappedResult(child, command, started, config, repoRoot);
}

async function collectWrappedResult(
  child: ReturnType<typeof spawn>,
  command: string,
  started: number,
  config: TokenOptConfig,
  repoRoot: string
): Promise<WrappedCommandResult> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  const artifactPath = writeArtifact(config, repoRoot, "exec-output.log", combined);
  const compressed = compressText(combined || `(command exited with ${exitCode} and no output)`, config.policy.maxCommandOutputChars);
  const durationMs = Date.now() - started;

  appendEvent(config, {
    timestamp: new Date().toISOString(),
    source: "cli",
    eventName: "exec",
    repoRoot,
    action: "exec",
    command,
    artifactPath,
    estimatedTokensSaved: compressed.estimatedTokensSaved,
    metadata: {
      exitCode,
      durationMs,
      compressionBudgetChars: compressed.budget?.maxChars,
      compressionBudgetReason: compressed.budget?.reason
    }
  });

  const summary = [
    `TokenOpt exec summary`,
    `command: ${command}`,
    `exitCode: ${exitCode}`,
    `durationMs: ${durationMs}`,
    `rawArtifact: ${artifactPath}`,
    "",
    compressed.text
  ].join("\n");
  return {
    command,
    exitCode,
    durationMs,
    rawArtifact: artifactPath,
    summary,
    rawOutput: combined,
    estimatedTokensSaved: compressed.estimatedTokensSaved
  };
}
