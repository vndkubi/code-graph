import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { evaluatePolicy } from "./policy-core.js";
import { buildNodeCommand } from "./shell.js";
import { extractTextFromToolResponse } from "./log-compressor.js";
import { appendEvent, writeArtifact } from "./observability.js";
import type { PolicyDecision, TokenOptEvent, TokenOptHookEventName } from "./types.js";

const COPILOT_EVENT_MAP: Record<string, TokenOptHookEventName> = {
  UserPromptSubmit: "user-prompt-submit",
  userPromptSubmit: "user-prompt-submit",
  PreToolUse: "pre-tool-use",
  preToolUse: "pre-tool-use",
  PostToolUse: "post-tool-use",
  postToolUse: "post-tool-use",
  PreCompact: "pre-compact",
  preCompact: "pre-compact",
  Stop: "agent-stop",
  stop: "agent-stop",
  AgentStop: "agent-stop",
  agentStop: "agent-stop"
};

export async function handleCopilotHook(eventName: TokenOptHookEventName): Promise<void> {
  const rawText = await readStdin();
  const raw = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
  const loaded = loadConfig({ cwd: typeof raw.cwd === "string" ? raw.cwd : process.cwd() });
  const event = normalizeCopilotEvent(raw, eventName);
  const decision = evaluatePolicy(event, loaded.config, {
    repoRoot: loaded.repoRoot,
    tokenoptCommand: buildNodeCommand(getCliEntryPath(), [])
  });

  let artifactPath: string | undefined;
  let outputDecision = decision;
  if (decision.action === "compress" && decision.shouldPersistRaw) {
    const rawOutput = extractTextFromToolResponse(event.toolResponse);
    artifactPath = writeArtifact(loaded.config, loaded.repoRoot, "copilot-tool-output.log", rawOutput);
    outputDecision = {
      ...decision,
      replacementText: `${decision.replacementText ?? ""}\n\nRaw artifact: ${artifactPath}`
    };
  }

  appendEvent(loaded.config, {
    timestamp: new Date().toISOString(),
    source: "copilot",
    eventName: `copilot-${event.eventName}`,
    repoRoot: loaded.repoRoot,
    action: decision.action,
    reason: decision.reason,
    toolName: event.toolName,
    artifactPath,
    estimatedTokensSaved: decision.estimatedTokensSaved,
    metadata: decision.metadata
  });

  const output = adaptDecisionToCopilot(event.eventName, outputDecision);
  if (output) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}

export function normalizeCopilotEvent(raw: Record<string, unknown>, fallbackName?: TokenOptHookEventName): TokenOptEvent {
  const rawName = typeof raw.hook_event_name === "string"
    ? raw.hook_event_name
    : typeof raw.hookEventName === "string"
      ? raw.hookEventName
      : "";
  const eventName = COPILOT_EVENT_MAP[rawName] ?? fallbackName;
  if (!eventName) {
    throw new Error(`Unsupported Copilot hook event: ${rawName || "<missing>"}`);
  }
  return {
    source: "copilot",
    eventName,
    cwd: typeof raw.cwd === "string" ? raw.cwd : process.cwd(),
    sessionId: typeof raw.session_id === "string" ? raw.session_id : typeof raw.sessionId === "string" ? raw.sessionId : undefined,
    turnId: typeof raw.turn_id === "string" ? raw.turn_id : typeof raw.turnId === "string" ? raw.turnId : undefined,
    permissionMode: typeof raw.permission_mode === "string" ? raw.permission_mode : undefined,
    transcriptPath: typeof raw.transcript_path === "string" ? raw.transcript_path : null,
    toolName: typeof raw.tool_name === "string" ? raw.tool_name : typeof raw.toolName === "string" ? raw.toolName : undefined,
    toolUseId: typeof raw.tool_use_id === "string" ? raw.tool_use_id : typeof raw.toolUseId === "string" ? raw.toolUseId : undefined,
    toolInput: raw.tool_input ?? raw.toolInput,
    toolResponse: raw.tool_response ?? raw.toolResponse,
    prompt: typeof raw.prompt === "string" ? raw.prompt : undefined,
    trigger: typeof raw.trigger === "string" ? raw.trigger : undefined,
    raw
  };
}

export function adaptDecisionToCopilot(eventName: TokenOptHookEventName, decision: PolicyDecision): Record<string, unknown> | undefined {
  if (decision.action === "allow") {
    return undefined;
  }
  if (eventName === "user-prompt-submit") {
    if (decision.action === "deny") {
      return { decision: "block", reason: decision.reason ?? "Blocked by TokenOpt." };
    }
    if (decision.additionalContext) {
      return { additionalContext: decision.additionalContext };
    }
  }
  if (eventName === "pre-tool-use") {
    if (decision.action === "deny") {
      return {
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason ?? "Blocked by TokenOpt."
      };
    }
    if (decision.action === "rewrite") {
      return {
        permissionDecision: "allow",
        modifiedArgs: decision.updatedInput
      };
    }
    if (decision.additionalContext) {
      return {
        permissionDecision: "allow",
        additionalContext: decision.additionalContext
      };
    }
  }
  if (eventName === "post-tool-use" && decision.action === "compress") {
    return {
      modifiedResult: decision.replacementText ?? decision.reason ?? "TokenOpt compressed the tool output.",
      additionalContext: decision.replacementText ?? decision.reason
    };
  }
  if (eventName === "post-tool-use" && decision.additionalContext) {
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: decision.additionalContext
      }
    };
  }
  if (eventName === "agent-stop") {
    if (decision.action === "deny") {
      return {
        hookSpecificOutput: {
          hookEventName: "Stop",
          decision: "block",
          reason: decision.reason ?? "ContextGate policy blocked stop."
        }
      };
    }
    if (decision.additionalContext) {
      return {
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext: decision.additionalContext
        }
      };
    }
  }
  if (eventName === "pre-compact" && decision.systemMessage) {
    return {
      continue: true,
      systemMessage: decision.systemMessage
    };
  }
  return undefined;
}

function getCliEntryPath(): string {
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}
