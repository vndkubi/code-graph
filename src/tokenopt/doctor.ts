import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { LoadedConfig } from "./types.js";

export function runDoctor(loaded: LoadedConfig): string {
  const cliEntryPath = fileURLToPath(new URL("./cli.js", import.meta.url));
  const checks = [
    check("node", process.version, true),
    check("tokenopt cli", cliEntryPath, fs.existsSync(cliEntryPath)),
    checkCommand("npm", process.platform === "win32" ? "npm.cmd" : "npm", ["--version"]),
    check("user config", loaded.userConfigPath, fs.existsSync(loaded.userConfigPath)),
    check("repo config", loaded.repoConfigPath, fs.existsSync(loaded.repoConfigPath))
  ];

  const lines = [
    "TokenOpt doctor",
    "",
    ...checks.map((item) => `${item.ok ? "[ok]" : "[warn]"} ${item.name}: ${item.detail}`)
  ];
  return lines.join("\n");
}

function check(name: string, detail: string, ok: boolean): { name: string; detail: string; ok: boolean } {
  return { name, detail, ok };
}

function checkCommand(name: string, command: string, args: string[]): { name: string; detail: string; ok: boolean } {
  try {
    const result = spawnSync(command, args, { encoding: "utf8", shell: process.platform === "win32" });
    const output = `${result.stdout ?? ""}`.trim() || `${result.stderr ?? ""}`.trim();
    return check(name, output.split("\n")[0] ?? command, result.status === 0);
  } catch (error) {
    return check(name, error instanceof Error ? error.message : String(error), false);
  }
}
