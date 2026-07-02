import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { evaluatePolicy } from "./policy-core.js";
import { buildNodeCommand } from "./shell.js";
import { extractTextFromToolResponse } from "./log-compressor.js";
import { appendEvent, writeArtifact } from "./observability.js";
import type { PolicyDecision, TokenOptEvent, TokenOptHookEventName } from "./types.js";

const CODEX_EVENT_MAP: Record<string, TokenOptHookEventName> = {
  UserPromptSubmit: "user-prompt-submit",
  PreToolUse: "pre-tool-use",
  PostToolUse: "post-tool-use",
  PreCompact: "pre-compact"
};

export async function handleCodexHook(eventName: TokenOptHookEventName): Promise<void> {
  const rawText = await readStdin();
  const raw = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
  const loaded = loadConfig({ cwd: typeof raw.cwd === "string" ? raw.cwd : process.cwd() });
  const event = normalizeCodexEvent(raw, eventName);
  const decision = evaluatePolicy(event, loaded.config, {
    repoRoot: loaded.repoRoot,
    tokenoptCommand: buildNodeCommand(getCliEntryPath(), [])
  });

  let artifactPath: string | undefined;
  let outputDecision = decision;
  if (decision.action === "compress" && decision.shouldPersistRaw) {
    const rawOutput = extractTextFromToolResponse(event.toolResponse);
    artifactPath = writeArtifact(loaded.config, loaded.repoRoot, "tool-output.log", rawOutput);
    outputDecision = {
      ...decision,
      replacementText: `${decision.replacementText ?? ""}\n\nRaw artifact: ${artifactPath}`
    };
  }

  if (event.eventName === "pre-compact") {
    artifactPath = writeArtifact(
      loaded.config,
      loaded.repoRoot,
      "pre-compact.json",
      JSON.stringify(
        {
          sessionId: event.sessionId,
          turnId: event.turnId,
          cwd: event.cwd,
          trigger: event.trigger,
          transcriptPath: event.transcriptPath,
          note: "TokenOpt records compaction metadata only; transcript contents are treated as unstable."
        },
        null,
        2
      )
    );
  }

  appendEvent(loaded.config, {
    timestamp: new Date().toISOString(),
    source: "codex",
    eventName: event.eventName,
    repoRoot: loaded.repoRoot,
    action: decision.action,
    reason: decision.reason,
    toolName: event.toolName,
    artifactPath,
    estimatedTokensSaved: decision.estimatedTokensSaved,
    metadata: decision.metadata
  });

  const codexOutput = adaptDecisionToCodex(event.eventName, outputDecision);
  if (codexOutput) {
    process.stdout.write(`${JSON.stringify(codexOutput)}\n`);
  }
}

export function normalizeCodexEvent(raw: Record<string, unknown>, fallbackName?: TokenOptHookEventName): TokenOptEvent {
  const rawName = typeof raw.hook_event_name === "string" ? raw.hook_event_name : "";
  const eventName = CODEX_EVENT_MAP[rawName] ?? fallbackName;
  if (!eventName) {
    throw new Error(`Unsupported Codex hook event: ${rawName || "<missing>"}`);
  }

  return {
    source: "codex",
    eventName,
    cwd: typeof raw.cwd === "string" ? raw.cwd : process.cwd(),
    sessionId: typeof raw.session_id === "string" ? raw.session_id : undefined,
    turnId: typeof raw.turn_id === "string" ? raw.turn_id : undefined,
    permissionMode: typeof raw.permission_mode === "string" ? raw.permission_mode : undefined,
    transcriptPath: typeof raw.transcript_path === "string" ? raw.transcript_path : null,
    toolName: typeof raw.tool_name === "string" ? raw.tool_name : undefined,
    toolUseId: typeof raw.tool_use_id === "string" ? raw.tool_use_id : undefined,
    toolInput: raw.tool_input,
    toolResponse: raw.tool_response,
    prompt: typeof raw.prompt === "string" ? raw.prompt : undefined,
    trigger: typeof raw.trigger === "string" ? raw.trigger : undefined,
    raw
  };
}

export function adaptDecisionToCodex(eventName: TokenOptHookEventName, decision: PolicyDecision): Record<string, unknown> | undefined {
  if (decision.action === "allow") {
    return undefined;
  }

  if (eventName === "user-prompt-submit") {
    if (decision.action === "deny") {
      return { decision: "block", reason: decision.reason ?? "Blocked by TokenOpt." };
    }
    if (decision.additionalContext) {
      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: decision.additionalContext
        }
      };
    }
  }

  if (eventName === "pre-tool-use") {
    if (decision.action === "deny") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: decision.reason ?? "Blocked by TokenOpt."
        }
      };
    }
    if (decision.action === "rewrite") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: decision.updatedInput
        }
      };
    }
    if (decision.additionalContext) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: decision.additionalContext
        }
      };
    }
  }

  if (eventName === "post-tool-use" && decision.action === "compress") {
    return {
      decision: "block",
      reason: decision.replacementText ?? decision.reason ?? "TokenOpt compressed the tool output.",
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: decision.replacementText ?? decision.reason
      }
    };
  }

  if (eventName === "pre-compact" && decision.systemMessage) {
    return {
      continue: true,
      systemMessage: decision.systemMessage
    };
  }

  return undefined;
}

export function getCliEntryPath(): string {
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}
