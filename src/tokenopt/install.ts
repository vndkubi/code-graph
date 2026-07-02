import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCliEntryPath } from "./codex-adapter.js";
import { buildNodeCommand } from "./shell.js";

type CodexScope = "user" | "repo";

interface CodexHookHandler {
  type: "command";
  command: string;
  commandWindows?: string;
  timeout?: number;
  statusMessage?: string;
}

interface CodexHookGroup {
  matcher?: string;
  hooks: CodexHookHandler[];
}

interface CodexHooksFile {
  hooks: Record<string, CodexHookGroup[]>;
}

const TOKENOPT_STATUS_PREFIX = "TokenOpt";

export function installCodexHooks(scope: CodexScope, cwd = process.cwd()): string {
  const hooksPath = getCodexHooksPath(scope, cwd);
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  const existing = readHooksFile(hooksPath);
  const merged = mergeTokenOptHooks(existing, buildCodexHooksConfig(getCliEntryPath()));
  fs.writeFileSync(hooksPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return hooksPath;
}

export function getCodexHooksPath(scope: CodexScope, cwd = process.cwd()): string {
  if (scope === "user") {
    return path.join(os.homedir(), ".codex", "hooks.json");
  }
  return path.join(path.resolve(cwd), ".codex", "hooks.json");
}

export function buildCodexHooksConfig(cliEntryPath: string): CodexHooksFile {
  const base = (event: string) => buildNodeCommand(cliEntryPath, ["hook", "codex", event]);
  const handler = (event: string, timeout: number, statusMessage: string): CodexHookHandler => {
    const command = base(event);
    return {
      type: "command",
      command,
      commandWindows: command,
      timeout,
      statusMessage
    };
  };
  return {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            handler("user-prompt-submit", 5, "TokenOpt prompt budget")
          ]
        }
      ],
      PreToolUse: [
        {
          matcher: "Bash|apply_patch|mcp__.*",
          hooks: [
            handler("pre-tool-use", 10, "TokenOpt tool budget")
          ]
        }
      ],
      PostToolUse: [
        {
          matcher: "Bash|apply_patch|mcp__.*",
          hooks: [
            handler("post-tool-use", 10, "TokenOpt output compressor")
          ]
        }
      ],
      PreCompact: [
        {
          matcher: "manual|auto",
          hooks: [
            handler("pre-compact", 5, "TokenOpt compaction metadata")
          ]
        }
      ]
    }
  };
}

function readHooksFile(filePath: string): CodexHooksFile {
  if (!fs.existsSync(filePath)) {
    return { hooks: {} };
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<CodexHooksFile>;
  return { hooks: parsed.hooks ?? {} };
}

function mergeTokenOptHooks(existing: CodexHooksFile, tokenopt: CodexHooksFile): CodexHooksFile {
  const merged: CodexHooksFile = { hooks: { ...existing.hooks } };
  for (const [eventName, groups] of Object.entries(tokenopt.hooks)) {
    const current = (merged.hooks[eventName] ?? []).filter((group) => !isTokenOptGroup(group));
    merged.hooks[eventName] = [...current, ...groups];
  }
  return merged;
}

function isTokenOptGroup(group: CodexHookGroup): boolean {
  return group.hooks.some((hook) => hook.statusMessage?.startsWith(TOKENOPT_STATUS_PREFIX) || /\btokenopt\b|\bcli\.js["']?\s+hook\s+codex\b/.test(hook.command));
}
