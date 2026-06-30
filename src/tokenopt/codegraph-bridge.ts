import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { estimateTokens } from "./token-estimator.js";
import type { CodeGraphCliLocation } from "./codegraph-discovery.js";

export interface CodeGraphFlowStep {
  file: string;
  lines: string;
  summary: string;
  symbol?: string;
}

export interface CodeGraphSlice {
  file: string;
  symbol: string;
  text: string;
  tokensEst: number;
}

export interface CodeGraphEvidence {
  flowSteps: CodeGraphFlowStep[];
  slices: CodeGraphSlice[];
  tokensEst: number;
  answerable: boolean;
}

const BRIDGE_TIMEOUT_MS = 12_000;
const MAX_SLICE_CHARS = 4_000;

/**
 * Call codegraph_context as an internal subprocess via MCP stdio protocol.
 * Returns null on any failure (CodeGraph not available, timeout, parse error).
 * All failures are silent — CodeGraph is optional enrichment.
 */
export async function callCodeGraphBridge(
  task: string,
  location: CodeGraphCliLocation,
  budgetTokens = 2_000
): Promise<CodeGraphEvidence | null> {
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;

  try {
    transport = new StdioClientTransport({
      command: location.command,
      args: location.args,
      env: process.env as Record<string, string>
    });

    client = new Client({ name: "tokenopt-internal", version: "1.0.0" }, { capabilities: {} });
    await withTimeout(client.connect(transport), BRIDGE_TIMEOUT_MS, "connect");

    const result = await withTimeout(
      client.callTool({
        name: "codegraph_context",
        arguments: {
          task,
          budgetTokens,
          profile: "compact",
          responseMode: "agent",
          includeSnippets: true
        }
      }),
      BRIDGE_TIMEOUT_MS,
      "call"
    );

    return parseCodeGraphResult(result);
  } catch {
    return null;
  } finally {
    try { await client?.close(); } catch { /* ignore */ }
  }
}

export function parseCodeGraphResult(result: unknown): CodeGraphEvidence | null {
  const text = extractText(result);
  if (!text) return null;

  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = undefined;
  }

  const flowSteps: CodeGraphFlowStep[] = [];
  const slices: CodeGraphSlice[] = [];

  if (parsed && typeof parsed === "object") {
    // flowSteps field
    const rawSteps = parsed.flowSteps ?? parsed.flow_steps;
    if (Array.isArray(rawSteps)) {
      for (const step of rawSteps) {
        if (step && typeof step === "object") {
          const s = step as Record<string, unknown>;
          flowSteps.push({
            file: String(s.file ?? ""),
            lines: String(s.lines ?? ""),
            summary: String(s.summary ?? ""),
            symbol: s.symbol ? String(s.symbol) : undefined
          });
        }
      }
    }

    // evidenceSlices field
    const rawSlices = parsed.evidenceSlices ?? parsed.evidence_slices;
    if (Array.isArray(rawSlices)) {
      for (const slice of rawSlices) {
        if (slice && typeof slice === "object") {
          const s = slice as Record<string, unknown>;
          const sliceText = String(s.text ?? "").slice(0, MAX_SLICE_CHARS);
          slices.push({
            file: String(s.file ?? ""),
            symbol: String(s.symbol ?? s.file ?? ""),
            text: sliceText,
            tokensEst: estimateTokens(sliceText)
          });
        }
      }
    }
  }

  // Fallback: if no JSON fields, treat raw text as a single slice summary
  if (flowSteps.length === 0 && slices.length === 0 && text.length > 40) {
    const trimmed = text.slice(0, MAX_SLICE_CHARS);
    slices.push({ file: "", symbol: "codegraph_summary", text: trimmed, tokensEst: estimateTokens(trimmed) });
  }

  if (flowSteps.length === 0 && slices.length === 0) {
    return null;
  }

  const totalTokens = slices.reduce((sum, s) => sum + s.tokensEst, 0) +
    estimateTokens(flowSteps.map(f => f.summary).join("\n"));

  const answerable = parsed
    ? (parsed.answerable === true || parsed.effectiveAnswerable === true)
    : false;

  return { flowSteps, slices, tokensEst: totalTokens, answerable };
}

function extractText(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const content = r.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item === "object") {
        const text = (item as Record<string, unknown>).text;
        if (typeof text === "string") return text;
      }
    }
  }
  if (typeof r.text === "string") return r.text;
  return null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CodeGraph bridge timeout (${label})`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}
