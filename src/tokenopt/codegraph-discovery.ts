import fs from "node:fs";
import path from "node:path";
import type { TokenOptConfig } from "./types.js";

export interface CodeGraphCliLocation {
  command: string;
  args: string[];
  source: "config" | "env-cli" | "env-root" | "local-root" | "path";
}

/**
 * Resolve the CodeGraph CLI location from (in priority order):
 * 1. config.codegraph.cliPath (explicit config)
 * 2. env TOKENOPT_CODEGRAPH_CLI (explicit path or command)
 * 3. env TOKENOPT_CODEGRAPH_ROOT + /dist/cli.js
 * 4. ../code-graph/dist/cli.js or ../codegraph/dist/cli.js (sibling dir)
 * 5. "codegraph" on PATH
 *
 * Returns null if CodeGraph is not available (missing file, etc.)
 */
export function resolveCodeGraphCli(
  config: TokenOptConfig,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): CodeGraphCliLocation | null {
  const baseArgs = ["mcp", "--profile", "compact"];

  // 1. Explicit config path
  if (config.codegraph.cliPath) {
    return resolveJsCli(config.codegraph.cliPath, cwd, baseArgs, "config");
  }

  // 2. TOKENOPT_CODEGRAPH_CLI env
  const envCli = env.TOKENOPT_CODEGRAPH_CLI?.trim();
  if (envCli) {
    return resolveJsCli(envCli, cwd, baseArgs, "env-cli");
  }

  // 3. TOKENOPT_CODEGRAPH_ROOT env
  const envRoot = env.TOKENOPT_CODEGRAPH_ROOT?.trim();
  if (envRoot) {
    const cli = path.resolve(envRoot, "dist", "cli.js");
    if (!fs.existsSync(cli)) {
      return null;
    }
    return { command: "node", args: [slash(cli), ...baseArgs], source: "env-root" };
  }

  // 4. Sibling directory (../code-graph or ../codegraph)
  const localCli = findLocalCodeGraphCli(cwd);
  if (localCli) {
    return { command: "node", args: [slash(localCli), ...baseArgs], source: "local-root" };
  }

  // 5. PATH fallback — caller must validate availability
  return { command: "codegraph", args: baseArgs, source: "path" };
}

function resolveJsCli(
  value: string,
  cwd: string,
  baseArgs: string[],
  source: CodeGraphCliLocation["source"]
): CodeGraphCliLocation | null {
  if (!looksLikeFilePath(value)) {
    return { command: value, args: baseArgs, source };
  }
  const resolved = path.resolve(cwd, value);
  if (!fs.existsSync(resolved)) {
    return null;
  }
  if (/\.[cm]?js$/i.test(resolved)) {
    return { command: "node", args: [slash(resolved), ...baseArgs], source };
  }
  return { command: resolved, args: baseArgs, source };
}

function findLocalCodeGraphCli(cwd: string): string | undefined {
  const candidates = [
    path.resolve(cwd, "..", "code-graph", "dist", "cli.js"),
    path.resolve(cwd, "..", "codegraph", "dist", "cli.js")
  ];
  return candidates.find(c => fs.existsSync(c));
}

function looksLikeFilePath(value: string): boolean {
  return value.startsWith(".") || value.startsWith("/") || /^[A-Za-z]:\\/.test(value) || /[/\\]/.test(value);
}

function slash(p: string): string {
  return p.replace(/\\/g, "/");
}
