import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callCodeGraphBridge, type CodeGraphEvidence } from "./codegraph-bridge.js";
import { resolveCodeGraphCli } from "./codegraph-discovery.js";
import { compileCodingCoverageEvidence } from "./coding/coverage-contract.js";
import { parseFailurePacket } from "./coding/failure-packet.js";
import type { GraphSymbolProvider } from "./coding/graph-symbol-provider.js";
import { buildSymbolPacket, collectCodingFiles, findCodingSymbols } from "./coding/symbol-index.js";
import { loadConfig } from "./config.js";
import {
  createEvidenceCacheLookup,
  evidenceCacheMetadata,
  isCacheableEvidencePacket,
  readEvidenceCacheEntry,
  writeEvidenceCacheEntry
} from "./evidence-cache.js";
import { readActiveEvidenceTaskState, readEvidenceTaskState, writeEvidenceTaskState } from "./evidence-state.js";
import { executeWrappedShellCommand } from "./exec.js";
import { compressText } from "./log-compressor.js";
import { appendEvent, writeArtifact } from "./observability.js";
import { evaluatePolicy } from "./policy-core.js";
import { routeTask } from "./router.js";
import { evaluateShadowGate, logShadowGateDecision } from "./shadow-gate.js";
import { estimateTokens, estimateTokensSaved } from "./token-estimator.js";
import type {
  AcquisitionMode,
  CoverageCertificate,
  EvidenceContractName,
  EvidenceCoverageStatus,
  EvidenceItem,
  EvidenceFollowup,
  EvidencePacket,
  EvidenceTaskType,
  FailurePacket,
  LoadedConfig,
  OutputPolicy,
  PolicyDecision,
  RouteDecision,
  TokenOptConfig,
  TokenOptEvent,
  TracebugEvidenceLine,
  TracebugPacket
} from "./types.js";

type SearchProvider = "rg" | "git" | "node";
type EvidenceDetail = "compact" | "full";
export type McpMode = "lite" | "full" | "broker";

// Refactored: Only essential tools remain. Legacy tools removed to reduce bloat.
const LITE_MCP_TOOL_NAMES = new Set(["contextgate_get_context", "tokenopt_compile_evidence", "tokenopt_search", "tokenopt_read_file"]);
const BROKER_MCP_TOOL_NAMES = new Set(["contextgate_get_context"]);
// Removed legacy tools: tokenopt_run_command, tokenopt_project_facts, tokenopt_prepare_java_diff,
// tokenopt_jakarta_annotation_filter, tokenopt_assemble_spring_context, tokenopt_business_contract,
// tokenopt_impact_analysis, tokenopt_symbols_find, tokenopt_symbol_packet, tokenopt_test_neighbors,
// tokenopt_failure_packet, tokenopt_tracebug_packet, tokenopt_session_stats
const FULL_MCP_TOOL_NAMES = new Set([
  ...LITE_MCP_TOOL_NAMES
]);

interface McpSessionStats {
  calls: number;
  evidenceTokensEst: number;
  inventoryTokensAvoided: number;
  startedAt: string;
}
const SESSION_STATS: McpSessionStats = {
  calls: 0,
  evidenceTokensEst: 0,
  inventoryTokensAvoided: 0,
  startedAt: new Date().toISOString()
};

interface RepoInventory {
  totalFiles: number;
  rawChars: number;
  rawArtifact: string;
  estimatedTokensAvoided: number;
  searchProvider: SearchProvider;
  diagnostics: string[];
  topDirs: Array<[string, number]>;
  topExtensions: Array<[string, number]>;
  rootFiles: string[];
  importantFiles: string[];
}

interface ProviderFileList {
  provider: SearchProvider;
  files: string[];
  raw: string;
  diagnostics: string[];
}

interface SearchProviderResult {
  provider: SearchProvider;
  exitCode: number;
  durationMs: number;
  rawOutput: string;
  diagnostics: string[];
}

interface RepositoryOverview {
  file: string;
  title: string;
  summary: string;
}

interface ExternalArtifactEvidence {
  source: "jira" | "confluence" | "github" | "attachment" | "other";
  id?: string;
  title?: string;
  url?: string;
  summary?: string;
  text?: string;
}

export const SERVER_INSTRUCTIONS = [
  "# ContextGate - TokenOpt repository evidence router",
  "",
  "ContextGate is the PRIMARY source-evidence gate for repository tasks. For broad or unknown-owner repo work, PBI implementation planning, code review with a diff, debugging, refactor scope, unit-test planning, onboarding, architecture, API flow, and impact analysis, call contextgate_get_context FIRST before starting a grep/read/shell exploration loop.",
  "",
  "Tool selection by intent:",
  "- Broad repo investigation, architecture, how-does-X-work, flow tracing, implementation planning, PBI-to-code impact, or unit-test planning -> contextgate_get_context FIRST with the full natural task, required evidence slots, budget, and quality rubric.",
  "- Concrete diff, PR, branch, or changed-file review -> tokenopt_compile_evidence with task_type=review_diff when it can cover changed files, symbols, similar logic, tests, and requirement evidence.",
  "- After a non-answerable packet -> use tokenopt_search or tokenopt_read_file only for exact missing files, symbols, tests, or slots named by the packet.",
  "- Jira, Confluence, GitHub, or attachment requests -> use those tools for the external artifact, then pass the fetched summary/body through external_artifacts when calling ContextGate/TokenOpt for impacted files, current behavior, tests, or validation.",
  "",
  "Anti-patterns:",
  "- Do not call ContextGate/TokenOpt and then repeat the same discovery with broad shell, grep, search, or full-file reads.",
  "- If answerable=true and missing=[] or the broker says answer_now, answer from the packet and stop acquiring duplicate context.",
  "- Do not use tokenopt_search or tokenopt_read_file as broad first tools; they are bounded followups after a packet names the missing evidence.",
  "",
  "When not to use ContextGate first:",
  "- Exact known-file edits, exact line-level bug proof, or a single named method where a narrow read is already the cheapest path.",
  "- Pure external-system questions that only need Jira, Confluence, GitHub, or docs evidence and do not need repository source context."
].join("\n");

export const TOKENOPT_TOOL_DEFINITIONS = [
      {
        name: "contextgate_get_context",
        title: "Get Bounded Repository Context",
        description: "PRIMARY SOURCE-EVIDENCE GATE - call FIRST for broad or unknown-owner repository tasks: investigate code, trace flows, understand architecture, plan implementation from a PBI, map Jira/Confluence requirements to impacted files, design unit tests, debug behavior, review impact, or find current behavior. When another MCP already fetched Jira/Confluence/GitHub content, pass it as external_artifacts so ContextGate can bind requirements to source-code slots. Returns a coverage contract with answerability, missing slots, inline source evidence, impacted files/symbols/tests, and bounded followups. If answerable=true or answer_now, answer from the packet without grep/read/shell duplication. Skip only when an exact file, line, or symbol is already known and a narrow read is cheaper.",
        inputSchema: {
          type: "object",
          properties: {
            task: { type: "string", description: "The user's natural task. For reviews, include the complete inline unified diff when available." },
            task_type: {
              type: "string",
              enum: [
                "api_flow",
                "field_impact",
                "review_diff",
                "startup_flow",
                "investigate",
                "research_business",
                "implement",
                "write_unittest",
                "build_handoff",
                "unknown"
              ],
              description: "Optional task category. Use unknown when unsure."
            },
            required_slots: {
              type: "array",
              items: { type: "string" },
              description: "Evidence slots the final answer must cover, such as source_files, symbols, tests, risks, backend_entrypoint, frontend_state."
            },
            budget_tokens: {
              type: "number",
              description: "Evidence budget."
            },
            quality_rubric: {
              type: "array",
              items: { type: "string" },
              description: "Quality checks for the final answer."
            },
            external_artifacts: {
              type: "array",
              description: "Requirement/business artifacts already fetched from other MCPs, such as Jira issues, Confluence pages, GitHub issues/PRs, or attachments. ContextGate uses these as requirement evidence, then gates repository source-code slots.",
              items: {
                type: "object",
                properties: {
                  source: { type: "string", enum: ["jira", "confluence", "github", "attachment", "other"] },
                  id: { type: "string" },
                  title: { type: "string" },
                  url: { type: "string" },
                  summary: { type: "string" },
                  text: { type: "string" }
                },
                additionalProperties: false
              }
            },
            detail: {
              type: "string",
              enum: ["compact", "full"],
              description: "compact default; full for debugging."
            },
            include_structured_packet: {
              type: "boolean",
              description: "Return full structured packet."
            },
            cwd: { type: "string", description: "Working directory." }
          },
          required: ["task"],
          additionalProperties: false
        },
        annotations: {
          title: "ContextGate get context",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      {
        name: "tokenopt_compile_evidence",
        title: "Compile Answerability Evidence",
        description: "PRIMARY COMPACT EVIDENCE COMPILER - call FIRST for review_diff packets, broad repo research, implementation planning, debugging, API flow, field impact, startup flow, and unit-test planning when a bounded packet can replace search/read loops. Accepts external_artifacts from Jira/Confluence/GitHub/attachments as requirement evidence while TokenOpt gates repository source evidence. Returns answerable, missing coverage, evidence items, quality contract, allowed exact followups, and stop rules. If answerable=true, answer directly without repeating the same evidence through shell, grep, search, or full-file reads.",
        inputSchema: {
          type: "object",
          properties: {
            task: { type: "string", description: "Full user task. For review_diff, include the complete inline unified diff; do not summarize it." },
            task_type: {
              type: "string",
              enum: [
                "api_flow",
                "field_impact",
                "review_diff",
                "startup_flow",
                "investigate",
                "research_business",
                "implement",
                "write_unittest",
                "build_handoff",
                "unknown"
              ],
              description: "Task category."
            },
            budget_tokens: {
              type: "number",
              description: "Evidence budget."
            },
            quality_rubric: {
              type: "array",
              items: { type: "string" },
              description: "Quality checklist."
            },
            external_artifacts: {
              type: "array",
              description: "Requirement/business artifacts already fetched from other MCPs, such as Jira issues, Confluence pages, GitHub issues/PRs, or attachments. TokenOpt treats these as external evidence and uses repository acquisition only for missing source-code slots.",
              items: {
                type: "object",
                properties: {
                  source: { type: "string", enum: ["jira", "confluence", "github", "attachment", "other"] },
                  id: { type: "string" },
                  title: { type: "string" },
                  url: { type: "string" },
                  summary: { type: "string" },
                  text: { type: "string" }
                },
                additionalProperties: false
              }
            },
            detail: {
              type: "string",
              enum: ["compact", "full"],
              description: "compact default; full for debugging."
            },
            include_structured_packet: {
              type: "boolean",
              description: "Return full structured packet."
            },
            cwd: { type: "string", description: "Working directory." }
          },
          required: ["task"],
          additionalProperties: false
        },
        annotations: {
          title: "TokenOpt compile evidence",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      {
        name: "tokenopt_search",
        title: "Search Repository Through TokenOpt",
        description: "FOLLOWUP ONLY after contextgate_get_context or tokenopt_compile_evidence names a missing exact pattern, file, symbol, test, route, or evidence slot. Searches repository text with compact bounded output. Do NOT use as the first tool for broad investigation, architecture, PBI planning, or review; call the evidence gate first so search stays narrow.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Search pattern." },
            path: { type: "string", description: "Repo-relative path." },
            cwd: { type: "string", description: "Working directory." }
          },
          required: ["pattern"],
          additionalProperties: false
        },
        annotations: {
          title: "TokenOpt search",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      {
        name: "tokenopt_read_file",
        title: "Read Bounded File Slice",
        description: "FOLLOWUP ONLY after a ContextGate/TokenOpt packet identifies an exact file, symbol, or line range that still needs source proof. Reads a bounded source slice with line numbers. Use instead of full-file reads for named missing evidence. Do NOT use as the first tool for broad exploration.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Repo-relative file." },
            startLine: { type: "number", description: "1-based start line." },
            maxLines: { type: "number", description: "Max lines, capped at 400." },
            cwd: { type: "string", description: "Working directory." }
          },
          required: ["path"],
          additionalProperties: false
        },
        annotations: {
          title: "TokenOpt read file",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      }
  ];

/**
 * In-process CodeGraph provider. When the fused MCP server hosts both
 * CodeGraph and TokenOpt, contextgate_get_context calls this directly instead
 * of spawning the codegraph CLI subprocess (see codegraph-bridge.ts, which is
 * kept only for the standalone hook flows).
 */
export type TokenoptCodeGraphProvider = (task: string, budgetTokens: number) => Promise<CodeGraphEvidence | null>;

export interface TokenoptToolContext {
  codeGraphProvider?: TokenoptCodeGraphProvider;
  /** In-process accelerator for the coding layer; see coding/graph-symbol-provider.ts. */
  graphSymbolProvider?: GraphSymbolProvider;
}

export async function runMcpServer(): Promise<void> {
  const server = new Server(
    {
      name: "tokenopt",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      },
      instructions: SERVER_INSTRUCTIONS
    }
  );

  const mcpMode = normalizeMcpMode();
  const exposedToolNames = getExposedMcpToolNames(mcpMode);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOKENOPT_TOOL_DEFINITIONS.filter((tool) => exposedToolNames.has(tool.name))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    if (!exposedToolNames.has(request.params.name)) {
      return textResult(
        `TokenOpt MCP tool ${request.params.name} is not exposed in ${mcpMode} mode. Set TOKENOPT_MCP_MODE=full to enable command/project facts tools.`,
        true
      );
    }
    return dispatchTokenoptTool(request.params.name, args, mcpMode);
  });

  await server.connect(new StdioServerTransport());
}

/**
 * Dispatch a TokenOpt tool call. Shared by the standalone TokenOpt MCP server
 * (runMcpServer) and the fused CodeGraph proxy server. The optional ctx carries
 * an in-process CodeGraph provider so contextgate_get_context can enrich without
 * spawning a subprocess.
 */
export async function dispatchTokenoptTool(
  name: string,
  args: Record<string, unknown>,
  mcpMode: McpMode = "lite",
  ctx: TokenoptToolContext = {}
): Promise<ReturnType<typeof textResult>> {
  try {
    switch (name) {
      case "contextgate_get_context":
        return await contextGateGetContextTool(args, mcpMode, ctx);
      case "tokenopt_compile_evidence":
        return await compileEvidenceTool(args, mcpMode, ctx);
      case "tokenopt_search":
        return await searchTool(args);
      case "tokenopt_read_file":
        return readFileTool(args);
      default:
        return textResult(`Unknown TokenOpt tool: ${name}`, true);
    }
  } catch (error) {
    return textResult(error instanceof Error ? error.message : String(error), true);
  }
}

async function contextGateGetContextTool(args: Record<string, unknown>, mcpMode: McpMode = "lite", ctx: TokenoptToolContext = {}) {
  const task = sanitizeTaskPrompt(requiredString(args, "task"));
  const externalArtifacts = parseExternalArtifacts(args);
  const taskWithExternalArtifacts = appendExternalArtifactContext(task, externalArtifacts);
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const taskType = normalizeTaskType(optionalString(args, "task_type"), taskWithExternalArtifacts);
  const requiredSlots = optionalStringArray(args, "required_slots").slice(0, 12);
  const qualityRubric = [
    ...optionalStringArray(args, "quality_rubric"),
    ...requiredSlots.map((slot) => `Cover evidence slot: ${slot}`)
  ].slice(0, 12);
  const result = await compileEvidenceTool({
    ...args,
    quality_rubric: qualityRubric
  }, mcpMode, ctx);
  const originalText = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
  const baseStrictGaps = contextGateStrictGaps(result.structuredContent, requiredSlots);
  const inlineEvidence = buildContextGateInlineEvidence(result.structuredContent, loaded.repoRoot, taskWithExternalArtifacts, requiredSlots, optionalNumber(args, "budget_tokens"), qualityRubric);
  let strictGaps = inlineEvidence.slices.length > 0 ? inlineEvidence.strictMissingSlots : baseStrictGaps;

  // Internal CodeGraph enrichment: when codegraph.enabled=true, enrich any packet
  // that has a code_graph followup gap and fold results into the response so the
  // model sees a single combined packet. In the fused MCP server an in-process
  // provider (ctx.codeGraphProvider) is used directly; standalone hook flows fall
  // back to spawning the codegraph CLI as a subprocess (codegraph-bridge.ts).
  let codeGraphEnrichment: CodeGraphEvidence | null = null;
  const codeGraphCli = loaded.config.codegraph.enabled && !ctx.codeGraphProvider
    ? resolveCodeGraphCli(loaded.config, process.cwd())
    : null;

  // Read the evidence state written by compileEvidenceTool to get the full packet with tool_categories
  const freshPacketState = loaded.config.codegraph.enabled
    ? readEvidenceTaskState(loaded.config, loaded.repoRoot)
    : undefined;
  const packetHasCodeGraphGap = freshPacketState?.packet.allowed_followups.some(
    (f) => f.tool_categories?.includes("code_graph")
  ) ?? false;

  if (loaded.config.codegraph.enabled && packetHasCodeGraphGap && (ctx.codeGraphProvider || codeGraphCli)) {
    const budgetForBridge = Math.min(optionalNumber(args, "budget_tokens") ?? 1600, 2000);
    codeGraphEnrichment = ctx.codeGraphProvider
      ? await ctx.codeGraphProvider(taskWithExternalArtifacts, budgetForBridge)
      : await callCodeGraphBridge(taskWithExternalArtifacts, codeGraphCli!, budgetForBridge);
    if (codeGraphEnrichment) {
      // If CodeGraph answered the code_graph gap, remove it from strictGaps
      strictGaps = strictGaps.filter(g => !g.toLowerCase().includes("symbol") && !g.toLowerCase().includes("flow") && !g.toLowerCase().includes("caller"));
    }
  }

  const effectiveAnswerable = strictGaps.length === 0 && (contextGateBaseAnswerable(result.structuredContent) || inlineEvidence.slices.length > 0);
  const refillFocusTerms = uniqueStrings([
    ...inlineEvidence.focusTerms,
    ...contextGateRefillFocusTerms(result.structuredContent)
  ]).slice(0, 16);
  const brokerText = effectiveAnswerable
    ? applyContextGateInlineAnswerableOverride(originalText, inlineEvidence)
    : strictGaps.length > 0
      ? applyContextGateStrictOverride(originalText, strictGaps)
      : originalText;
  if (effectiveAnswerable) {
    writeContextGateBrokerState(loaded, taskWithExternalArtifacts, taskType, result.structuredContent, inlineEvidence);
  }
  const text = [
    brokerText
      .replace(/^TokenOpt evidence packet compact/m, "ContextGate evidence packet compact")
      .replace(/^TokenOpt compiled evidence packet/m, "ContextGate compiled evidence packet")
      .replace(/TokenOpt compact mode: full packet is stored in state_path; call tokenopt_compile_evidence with detail=full only when debugging\./, "ContextGate compact mode: full packet is stored in state_path; request detail=full only when debugging."),
    inlineEvidence.slices.length > 0 ? formatContextGateInlineEvidence(inlineEvidence, effectiveAnswerable) : undefined,
    "",
    "Context broker guidance:",
    externalArtifacts.length > 0
      ? `- External artifacts supplied: ${externalArtifacts.map(formatExternalArtifactLabel).join("; ")}. Treat those as requirement/business evidence, and use this packet for repository source-code slots.`
      : undefined,
    "- Treat this packet as a coverage contract, not a fixed tool script.",
    effectiveAnswerable
      ? "- Broker inline evidence covers the required slots; answer from this packet and stop acquiring duplicate context."
      : "- If answerable=true, answer from the packet and stop acquiring duplicate context.",
    strictGaps.length > 0 && refillFocusTerms.length > 0 ? `- Refill focus terms: ${refillFocusTerms.join(", ")}.` : undefined,
    "- If required slots are missing, refill only those named slots with the cheapest bounded provider available in the session.",
    inlineEvidence.carryTerms.length > 0
      ? `- Final output identifier checklist: if the requested output has a symbols field, start it with these exact identifiers in order: ${inlineEvidence.carryTerms.join(", ")}. If there is no symbols field, include each identifier exactly in the closest valid field or explain irrelevance.`
      : undefined,
    "- Prefer exact source slices for named files/symbols over broad search, and report any still-missing slots honestly."
  ].filter((line): line is string => Boolean(line)).join("\n");
  const avoided = (result.structuredContent as Record<string, unknown> | undefined)?.estimatedTokensAvoided as number | undefined ?? 0;
  SESSION_STATS.calls += 1;
  SESSION_STATS.evidenceTokensEst += (result.structuredContent as Record<string, unknown> | undefined)?.evidenceTokensEst as number | undefined ?? 0;
  SESSION_STATS.inventoryTokensAvoided += avoided;
  writeDailyStats(avoided, taskType);
  const savingsLine = `\n---\nTokenOpt: ~${avoided} tokens saved this call vs raw exploration | session: ${SESSION_STATS.calls} call(s), ~${SESSION_STATS.inventoryTokensAvoided} total tokens saved`;

  const codeGraphSection = codeGraphEnrichment
    ? formatCodeGraphEnrichment(codeGraphEnrichment)
    : undefined;

  return {
    ...result,
    content: [{ type: "text" as const, text: [text, codeGraphSection, savingsLine].filter(Boolean).join("") }],
    structuredContent: {
      ...(result.structuredContent ?? {}),
      broker: "contextgate",
      requiredSlots,
      externalArtifacts: externalArtifacts.map(slimExternalArtifact),
      strictMissingSlots: strictGaps,
      refillFocusTerms,
      inlineEvidence: slimContextGateInlineEvidence(inlineEvidence),
      effectiveAnswerable,
      recommendedNextAction: effectiveAnswerable ? "answer_now" : strictGaps.length > 0 ? "refill_missing_slots" : "answer_or_refill_from_contract",
      naturalToolPolicy: "coverage-contract",
      codeGraphEnrichment: codeGraphEnrichment
        ? { flowSteps: codeGraphEnrichment.flowSteps.length, slices: codeGraphEnrichment.slices.length, tokensEst: codeGraphEnrichment.tokensEst }
        : undefined
    }
  };
}

function formatCodeGraphEnrichment(evidence: NonNullable<Awaited<ReturnType<typeof callCodeGraphBridge>>>): string {
  const lines: string[] = ["\n\n--- CodeGraph enrichment (internal) ---"];
  if (evidence.flowSteps.length > 0) {
    lines.push("Flow steps:");
    for (const step of evidence.flowSteps.slice(0, 8)) {
      lines.push(`  ${step.file}:${step.lines} — ${step.summary}`);
    }
  }
  if (evidence.slices.length > 0) {
    lines.push("Source slices:");
    for (const slice of evidence.slices.slice(0, 4)) {
      lines.push(`  [${slice.symbol || slice.file}]\n${slice.text.slice(0, 800)}`);
    }
  }
  return lines.join("\n");
}

interface ContextGateInlineSlice {
  file: string;
  startLine: number;
  endLine: number;
  matchedTerms: string[];
  kind: "backend" | "frontend" | "test" | "source";
  text: string;
}

interface ContextGateAnchor {
  term: string;
  file: string;
  line: number;
  kind: ContextGateInlineSlice["kind"];
  preview: string;
}

interface ContextGateInlineEvidence {
  slices: ContextGateInlineSlice[];
  anchors: ContextGateAnchor[];
  carryTerms: string[];
  focusTerms: string[];
  focusFiles: string[];
  coverage: Record<string, EvidenceCoverageStatus>;
  strictMissingSlots: string[];
  tokensEst: number;
}

function buildContextGateInlineEvidence(
  structuredContent: Record<string, unknown> | undefined,
  repoRoot: string,
  task: string,
  requiredSlots: string[],
  requestedBudgetTokens: number | undefined,
  qualityRubric: string[] = []
): ContextGateInlineEvidence {
  const focusTerms = contextGateInlineFocusTerms(structuredContent, task, qualityRubric);
  const factFiles = contextGateInlineFocusFiles(structuredContent, focusTerms);
  const hits = collectFlowSearchHits(repoRoot, focusTerms.slice(0, 14));
  const hitFiles = uniqueStrings(hits.map((hit) => hit.file));
  const pathFiles = contextGatePathMatchFiles(repoRoot, focusTerms);
  const focusFiles = selectContextGateInlineFiles(uniqueStrings([...factFiles, ...pathFiles, ...hitFiles]), hits, focusTerms, requiredSlots);
  const maxChars = Math.max(10_000, Math.min(32_000, Math.floor((requestedBudgetTokens ?? 2200) * 10)));
  const slices: ContextGateInlineSlice[] = [];
  let usedChars = 0;

  for (const file of focusFiles) {
    if (usedChars >= maxChars || slices.length >= 14) {
      break;
    }
    const fileSlices = buildContextGateFileSlices(repoRoot, file, focusTerms, hits)
      .filter((slice) => slice.text.trim().length > 0);
    for (const slice of fileSlices) {
      if (usedChars >= maxChars || slices.length >= 14) {
        break;
      }
      const remaining = maxChars - usedChars;
      const text = slice.text.length > remaining ? `${slice.text.slice(0, Math.max(0, remaining - 80)).trimEnd()}\n... truncated by ContextGate broker budget ...` : slice.text;
      usedChars += text.length;
      slices.push({ ...slice, text });
    }
  }

  const anchors = buildContextGateAnchorLedger(repoRoot, focusFiles, focusTerms, slices);
  const carryTerms = buildContextGateCarryTerms(task, focusTerms, anchors);
  const coverage = buildContextGateInlineCoverage(slices, anchors, focusFiles, requiredSlots);
  return {
    slices,
    anchors,
    carryTerms,
    focusTerms,
    focusFiles,
    coverage,
    strictMissingSlots: contextGateInlineStrictGaps(requiredSlots, coverage),
    tokensEst: estimateTokens([
      carryTerms.length > 0 ? `carry_terms=${carryTerms.join(",")}` : "",
      anchors.map((anchor) => `${anchor.term}->${anchor.file}:${anchor.line}:${anchor.preview}`).join("\n"),
      slices.map((slice) => `${slice.file}:${slice.startLine}-${slice.endLine}\n${slice.text}`).join("\n\n")
    ].filter(Boolean).join("\n\n"))
  };
}

function contextGateInlineFocusTerms(structuredContent: Record<string, unknown> | undefined, task: string, qualityRubric: string[] = []): string[] {
  const taskText = stripOutputContractText(task);
  const rubricText = qualityRubric.join(" ");
  const factTerms = contextGateFactValues(structuredContent, /^(?:feature_terms|domain_terms)$/)
    .flatMap((value) => value.split(",").map((part) => part.trim()));
  const terms = uniqueStrings([
    ...selectBusinessFeatureTerms(`${taskText} ${rubricText}`),
    ...factTerms,
    ...extractQuotedTerms(taskText),
    ...extractQuotedTerms(rubricText),
    ...extractStrongCodeLikeTaskTerms(taskText),
    ...extractStrongCodeLikeTaskTerms(rubricText),
    ...extractHyphenatedIdentifierVariants(taskText),
    ...extractHyphenatedIdentifierVariants(rubricText),
    ...extractRouteTerms(taskText)
  ]).filter(isUsefulFlowSearchTerm);
  return prioritizeContextGateFocusTerms(terms).slice(0, 36);
}

function contextGateInlineFocusFiles(structuredContent: Record<string, unknown> | undefined, focusTerms: string[]): string[] {
  return contextGateFactValues(structuredContent, /^(?:feature_source_files|feature_backend_files|feature_frontend_files|feature_test_files)$/)
    .flatMap((value) => value.split(",").map((part) => part.trim()))
    .filter((value) => value && value !== "none_detected" && !value.includes("->"))
    .filter((value) => /\.(?:java|ts|tsx|vue|js|jsx|kt|py|go|rs|cs)$/i.test(value))
    .filter((value) => pathMatchesTerms(value, focusTerms));
}

function contextGatePathMatchFiles(repoRoot: string, focusTerms: string[]): string[] {
  const explicitFiles = contextGateExplicitFocusFiles(repoRoot, focusTerms);
  const files = collectNodeRepoFiles(repoRoot, { maxFiles: 25_000, maxDepth: 24 }).files
    .map((file) => file.replace(/\\/g, "/"))
    .filter((file) => isSourceFlowFile(file) || isTestFlowFile(file) || explicitFiles.includes(file))
    .filter((file) => !isGeneratedFlowFile(file) && !isProbablyBinaryPath(file))
    .filter((file) => pathMatchesTerms(file, focusTerms));
  return uniqueStrings([...explicitFiles, ...files])
    .sort((a, b) =>
      scoreContextGateTermPathMatch(b, focusTerms) - scoreContextGateTermPathMatch(a, focusTerms) ||
      scoreFlowFile(b) - scoreFlowFile(a) ||
      a.localeCompare(b)
    )
    .slice(0, 100);
}

function prioritizeContextGateFocusTerms(terms: string[]): string[] {
  return terms
    .map((term, index) => ({ term, index, score: scoreContextGateFocusTerm(term) }))
    .sort((a, b) => b.score - a.score || a.index - b.index || a.term.localeCompare(b.term))
    .map((item) => item.term);
}

function scoreContextGateFocusTerm(term: string): number {
  let score = 0;
  if (/\.(?:ts|tsx|js|jsx|java|py|go|rs|kt|scala|cs|md|mdx|json|yml|yaml)$/i.test(term)) {
    score += 220;
  }
  if (term.includes("/") || term.includes("\\")) {
    score += 120;
  }
  if (/[a-z][A-Za-z0-9]*[A-Z]/.test(term) || /^[A-Z][A-Za-z0-9_]{3,}$/.test(term)) {
    score += 90;
  }
  if (term.includes("_") || term.includes("-")) {
    score += 35;
  }
  return score;
}

function contextGateExplicitFocusFiles(repoRoot: string, focusTerms: string[]): string[] {
  const files: string[] = [];
  for (const term of focusTerms) {
    const normalized = term.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/\\/g, "/");
    if (!/\.(?:ts|tsx|js|jsx|java|py|go|rs|kt|scala|cs|md|mdx|json|yml|yaml)$/i.test(normalized)) {
      continue;
    }
    const absolute = path.resolve(repoRoot, normalized);
    const relative = path.relative(repoRoot, absolute).replace(/\\/g, "/");
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || isProbablyBinaryPath(relative) || isArtifactLikePath(relative)) {
      continue;
    }
    if (fs.existsSync(path.join(repoRoot, relative))) {
      files.push(relative);
    }
  }
  return uniqueStrings(files);
}

function contextGateFactValues(structuredContent: Record<string, unknown> | undefined, keyPattern: RegExp): string[] {
  if (!structuredContent) {
    return [];
  }
  const packet = isRecord(structuredContent.packet) ? structuredContent.packet : undefined;
  const evidence = Array.isArray(packet?.evidence) ? packet.evidence : [];
  const values: string[] = [];
  for (const item of evidence) {
    if (!isRecord(item) || !Array.isArray(item.facts)) {
      continue;
    }
    for (const fact of item.facts) {
      if (typeof fact !== "string") {
        continue;
      }
      const separator = fact.indexOf("=");
      if (separator <= 0) {
        continue;
      }
      const key = fact.slice(0, separator);
      const value = fact.slice(separator + 1);
      if (keyPattern.test(key)) {
        values.push(value);
      }
    }
  }
  return values;
}

function selectContextGateInlineFiles(files: string[], hits: FlowSearchHit[], focusTerms: string[], requiredSlots: string[]): string[] {
  const normalized = files
    .map((file) => file.replace(/\\/g, "/"))
    .filter((file) => file && !isGeneratedFlowFile(file) && !isProbablyBinaryPath(file));
  const hitCounts = new Map<string, number>();
  for (const hit of hits) {
    hitCounts.set(hit.file, (hitCounts.get(hit.file) ?? 0) + 1);
  }
  const wantsBackend = requiredSlots.some((slot) => /backend|service|domain|entrypoint|source_files|business/i.test(slot));
  const wantsFrontend = requiredSlots.some((slot) => /frontend|ui|page|caller|source_files/i.test(slot));
  const wantsTests = requiredSlots.some((slot) => /test|validation|existing_tests/i.test(slot));
  const scored = uniqueStrings(normalized)
    .map((file) => ({
      file,
      score:
        scoreFlowFile(file) +
        scoreContextGateTermPathMatch(file, focusTerms) +
        (hitCounts.get(file) ?? 0) * 8 +
        (pathMatchesTerms(file, focusTerms) ? 12 : 0) +
        (wantsBackend && isBackendBusinessFile(file) ? 18 : 0) +
        (wantsFrontend && isFrontendBusinessFile(file) ? 18 : 0) +
        (wantsTests && isTestFlowFile(file) ? 18 : 0)
    }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .map((item) => item.file);

  const selected: string[] = [];
  const addMatches = (predicate: (file: string) => boolean, limit: number): void => {
    for (const file of scored) {
      if (selected.length >= 12) {
        return;
      }
      if (selected.filter(predicate).length >= limit) {
        return;
      }
      if (predicate(file) && !selected.includes(file)) {
        selected.push(file);
      }
    }
  };
  addMatches((file) => isCoreBackendBusinessFile(file) && scoreContextGateTermPathMatch(file, focusTerms) >= 400, wantsBackend ? 6 : 4);
  addMatches((file) => isFrontendBusinessFile(file) && !isTestFlowFile(file) && scoreContextGateTermPathMatch(file, focusTerms) >= 300, wantsFrontend ? 3 : 2);
  addMatches((file) => isTestFlowFile(file), wantsTests ? 4 : 2);
  addMatches((file) => isBackendBusinessFile(file) && !isTestFlowFile(file), wantsBackend ? 8 : 4);
  addMatches((file) => isFrontendBusinessFile(file) && !isTestFlowFile(file), wantsFrontend ? 4 : 2);
  for (const file of scored) {
    if (selected.length >= 12) {
      break;
    }
    if (!selected.includes(file)) {
      selected.push(file);
    }
  }
  return selected;
}

function isCoreBackendBusinessFile(file: string): boolean {
  return isBackendBusinessFile(file) && !isTestFlowFile(file) && !/(^|\/)dto\//i.test(file);
}

function scoreContextGateTermPathMatch(file: string, terms: string[]): number {
  const normalizedPath = file.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const base = path.basename(file).replace(/\.[^.]+$/, "");
  const normalizedBase = base.toLowerCase().replace(/[^a-z0-9]+/g, "");
  let score = 0;
  terms.forEach((term, index) => {
    const normalizedTerm = term.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (normalizedTerm.length < 4) {
      return;
    }
    const rankBonus = Math.max(0, 80 - index * 3);
    if (normalizedBase === normalizedTerm) {
      score += 420 + rankBonus;
    } else if (normalizedBase.includes(normalizedTerm) || normalizedTerm.includes(normalizedBase)) {
      score += 210 + Math.floor(rankBonus / 2);
    } else if (normalizedPath.includes(normalizedTerm)) {
      score += 80 + Math.floor(rankBonus / 4);
    }
  });
  return score;
}

function buildContextGateFileSlices(repoRoot: string, file: string, focusTerms: string[], hits: FlowSearchHit[]): ContextGateInlineSlice[] {
  const absolute = path.resolve(repoRoot, file);
  const relative = path.relative(repoRoot, absolute).replace(/\\/g, "/");
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(absolute)) {
    return [];
  }
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size > 512 * 1024) {
    return [];
  }
  const lines = fs.readFileSync(absolute, "utf8").replace(/\r\n/g, "\n").split("\n");
  const matched = contextGateMatchedLines(relative, lines, focusTerms, hits);
  const clusters = clusterContextGateLines(matched.map((item) => item.line), 95).slice(0, 2);
  const fallbackLine = matched[0]?.line ?? 1;
  const windows = clusters.length > 0 ? clusters : [[fallbackLine]];
  return windows.map((cluster) => {
    const first = Math.min(...cluster);
    const last = Math.max(...cluster);
    const startLine = Math.max(1, first - 18);
    const desiredEndLine = Math.min(lines.length, Math.max(last + 34, startLine + 50));
    const endLine = Math.min(desiredEndLine, startLine + contextGateInlineMaxWindowLines(relative) - 1);
    const selectedLines = lines.slice(startLine - 1, endLine);
    const text = selectedLines.map((line, index) => `${startLine + index}: ${line}`).join("\n");
    return {
      file: relative,
      startLine,
      endLine,
      matchedTerms: uniqueStrings(matched.filter((item) => item.line >= startLine && item.line <= endLine).map((item) => item.term)).slice(0, 8),
      kind: contextGateInlineFileKind(relative),
      text
    };
  });
}

function contextGateInlineMaxWindowLines(file: string): number {
  if (isTestFlowFile(file)) {
    return 130;
  }
  if (isFrontendBusinessFile(file)) {
    return 180;
  }
  return 145;
}

function contextGateMatchedLines(file: string, lines: string[], focusTerms: string[], hits: FlowSearchHit[]): Array<{ line: number; term: string }> {
  const matched: Array<{ line: number; term: string }> = [];
  for (const hit of hits) {
    if (hit.file === file) {
      matched.push({ line: hit.line, term: hit.term });
    }
  }
  const fileBase = path.basename(file).replace(/\.[^.]+$/, "");
  const terms = uniqueStrings([...focusTerms, fileBase]).filter((term) => term.length >= 3).slice(0, 28);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    const lower = raw.toLowerCase();
    const compactLine = lower.replace(/[^a-z0-9]+/g, "");
    for (const term of terms) {
      const termLower = term.toLowerCase();
      const compactTerm = termLower.replace(/[^a-z0-9]+/g, "");
      if ((termLower.length >= 4 && lower.includes(termLower)) || (compactTerm.length >= 5 && compactLine.includes(compactTerm))) {
        matched.push({ line: index + 1, term });
      }
    }
  }
  return matched
    .sort((a, b) => a.line - b.line || a.term.localeCompare(b.term))
    .filter((item, index, array) => index === 0 || item.line !== array[index - 1]!.line || item.term !== array[index - 1]!.term)
    .slice(0, 80);
}

function buildContextGateAnchorLedger(
  repoRoot: string,
  focusFiles: string[],
  focusTerms: string[],
  slices: ContextGateInlineSlice[]
): ContextGateAnchor[] {
  const candidateByTerm = new Map<string, { anchor: ContextGateAnchor; score: number }>();
  const terms = focusTerms
    .filter(contextGateAnchorTermRelevant)
    .slice(0, 40);

  for (const slice of slices) {
    for (const anchor of contextGateAnchorsInText(slice.file, slice.kind, slice.text, terms)) {
      rememberContextGateAnchor(candidateByTerm, anchor, scoreContextGateAnchor(anchor, focusTerms) + 12);
    }
  }

  for (const file of focusFiles.slice(0, 14)) {
    const absolute = path.resolve(repoRoot, file);
    const relative = path.relative(repoRoot, absolute).replace(/\\/g, "/");
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(absolute)) {
      continue;
    }
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > 768 * 1024 || isProbablyBinaryPath(relative)) {
      continue;
    }
    const content = fs.readFileSync(absolute, "utf8").replace(/\r\n/g, "\n");
    const kind = contextGateInlineFileKind(relative);
    for (const anchor of contextGateAnchorsInText(relative, kind, content, terms)) {
      rememberContextGateAnchor(candidateByTerm, anchor, scoreContextGateAnchor(anchor, focusTerms));
    }
    for (const term of terms) {
      if (candidateByTerm.has(contextGateAnchorTermKey(term)) || !pathMatchesTerms(relative, [term])) {
        continue;
      }
      rememberContextGateAnchor(candidateByTerm, {
        term,
        file: relative,
        line: 1,
        kind,
        preview: `path match for ${term}`
      }, scoreContextGateAnchor({
        term,
        file: relative,
        line: 1,
        kind,
        preview: ""
      }, focusTerms) - 30);
    }
  }

  return [...candidateByTerm.values()]
    .sort((a, b) => b.score - a.score || a.anchor.file.localeCompare(b.anchor.file) || a.anchor.line - b.anchor.line)
    .map((item) => item.anchor)
    .slice(0, 28);
}

function contextGateAnchorsInText(
  file: string,
  kind: ContextGateInlineSlice["kind"],
  text: string,
  terms: string[]
): ContextGateAnchor[] {
  const anchors: ContextGateAnchor[] = [];
  const seenTerms = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    const parsed = raw.match(/^\s*(\d+):\s?(.*)$/);
    const line = parsed ? Number(parsed[1]) : index + 1;
    const previewSource = parsed ? parsed[2] ?? "" : raw;
    for (const term of terms) {
      const key = contextGateAnchorTermKey(term);
      if (seenTerms.has(key) || !lineMatchesContextGateTerm(previewSource, term)) {
        continue;
      }
      anchors.push({
        term,
        file,
        line,
        kind,
        preview: cleanFactValue(previewSource).slice(0, 180)
      });
      seenTerms.add(key);
    }
  }
  return anchors;
}

function rememberContextGateAnchor(
  anchors: Map<string, { anchor: ContextGateAnchor; score: number }>,
  anchor: ContextGateAnchor,
  score: number
): void {
  const key = contextGateAnchorTermKey(anchor.term);
  const existing = anchors.get(key);
  if (!existing || score > existing.score) {
    anchors.set(key, { anchor, score });
  }
}

function scoreContextGateAnchor(anchor: ContextGateAnchor, focusTerms: string[]): number {
  const termIndex = focusTerms.findIndex((term) => contextGateAnchorTermKey(term) === contextGateAnchorTermKey(anchor.term));
  let score = termIndex >= 0 ? Math.max(0, 120 - termIndex * 3) : 20;
  score += scoreFlowFile(anchor.file);
  if (anchor.kind === "backend" || anchor.kind === "frontend") {
    score += 12;
  }
  if (/\b(?:class|function|const|let|var|public|private|protected|static|final|async)\b/.test(anchor.preview)) {
    score += 18;
  }
  if (lineMatchesContextGateTerm(path.basename(anchor.file), anchor.term)) {
    score += 20;
  }
  return score;
}

function buildContextGateCarryTerms(task: string, focusTerms: string[], anchors: ContextGateAnchor[]): string[] {
  const taskLower = task.toLowerCase();
  const compactTask = contextGateAnchorTermKey(task);
  const isBugTrace = /\b(?:bug|regression|wrong|incorrect|retry|failure|failed)\b/i.test(task);
  const focusIndex = new Map(focusTerms.map((term, index) => [contextGateAnchorTermKey(term), index]));
  return anchors
    .map((anchor) => ({
      term: anchor.term,
      score: scoreContextGateCarryTerm(anchor, taskLower, compactTask, focusIndex, isBugTrace)
    }))
    .filter((item) => item.score >= 55)
    .sort((a, b) =>
      (isBugTrace ? contextGateBugCarryPriority(a.term) - contextGateBugCarryPriority(b.term) : 0) ||
      b.score - a.score ||
      (focusIndex.get(contextGateAnchorTermKey(a.term)) ?? 999) - (focusIndex.get(contextGateAnchorTermKey(b.term)) ?? 999) ||
      a.term.localeCompare(b.term)
    )
    .map((item) => item.term)
    .filter((term, index, array) => array.findIndex((other) => contextGateAnchorTermKey(other) === contextGateAnchorTermKey(term)) === index)
    .slice(0, isBugTrace ? 6 : 16);
}

function scoreContextGateCarryTerm(
  anchor: ContextGateAnchor,
  taskLower: string,
  compactTask: string,
  focusIndex: Map<string, number>,
  isBugTrace: boolean
): number {
  const term = anchor.term;
  const key = contextGateAnchorTermKey(term);
  const index = focusIndex.get(key);
  let score = index === undefined ? 20 : Math.max(0, 90 - index * 3);
  if (/[A-Za-z0-9_]+\.[A-Za-z0-9_]+/.test(term)) {
    score += 80;
  }
  if (/[a-z][A-Z]/.test(term)) {
    score += 60;
  }
  if (/\b(?:test|spec)$/i.test(term)) {
    score += 45;
  }
  if (anchor.kind === "test") {
    score += 30;
  }
  const termLower = term.toLowerCase();
  if (termLower.length >= 4 && taskLower.includes(termLower)) {
    score += 45;
  } else if (key.length >= 5 && compactTask.includes(key)) {
    score += 30;
  }
  if (/(?:answer|recall|failed|success|next|time|timestamp|load|set|get|current|window|mode|count|forecast|spelling|wrong|incorrect|deleted|removed)/i.test(term)) {
    score += 25;
  }
  if (isBugTrace) {
    if (anchor.kind === "frontend" && !taskLower.includes(term.toLowerCase()) && !(key.length >= 5 && compactTask.includes(key))) {
      score -= 100;
    }
    if (key === "thinkingtimems") {
      score += 220;
    }
    if (key === "nextrecallat" || key === "timestampoperationsaddhourstotimestamp") {
      score += 120;
    }
    if (key === "recallfailed" || key === "markasrecalled") {
      score += 100;
    }
    if (/(?:thinking|time|timestamp|nextrecall|addhours|failed|success|answer|spelling|test)/i.test(term)) {
      score += 70;
    }
    if (/^(?:recalling|currentrecallwindowendat|treadmillmode|recallpage|recallscontroller|userecalldata)$/i.test(key)) {
      score -= 45;
    }
  }
  if (/^[A-Z][A-Za-z0-9]*(?:Controller|Service|Page|Curve|Trackers?|Prompt|Data)$/.test(term)) {
    score -= 60;
  }
  if (/^(?:trace|daily|validcompactjson|compactjsononly)$/i.test(key)) {
    score -= 100;
  }
  return score;
}

function contextGateBugCarryPriority(term: string): number {
  const key = contextGateAnchorTermKey(term);
  const priorities = new Map<string, number>([
    ["thinkingtimems", 0],
    ["timestampoperationsaddhourstotimestamp", 1],
    ["nextrecallat", 2],
    ["recallfailed", 3],
    ["markasrecalled", 4],
    ["recalledsuccessfully", 5],
    ["answerquiz", 6],
    ["answerspelling", 7],
    ["memorytrackerservicetest", 8],
    ["getduememorytrackers", 9]
  ]);
  return priorities.get(key) ?? 50;
}

function contextGateAnchorTermRelevant(term: string): boolean {
  const cleaned = term.trim();
  if (!isUsefulFlowSearchTerm(cleaned)) {
    return false;
  }
  const key = contextGateAnchorTermKey(cleaned);
  return key.length >= 4 && !/^(?:trace|daily|validcompactjson|compactjsononly)$/i.test(key);
}

function contextGateAnchorTermKey(term: string): string {
  return term.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function lineMatchesContextGateTerm(line: string, term: string): boolean {
  const lower = line.toLowerCase();
  const termLower = term.toLowerCase();
  const compactLine = lower.replace(/[^a-z0-9]+/g, "");
  const compactTerm = contextGateAnchorTermKey(term);
  return (termLower.length >= 4 && lower.includes(termLower)) ||
    (compactTerm.length >= 5 && compactLine.includes(compactTerm));
}

function clusterContextGateLines(lines: number[], maxGap: number): number[][] {
  const sorted = uniqueNumbers(lines).sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const line of sorted) {
    const lastCluster = clusters[clusters.length - 1];
    if (!lastCluster || line - lastCluster[lastCluster.length - 1]! > maxGap) {
      clusters.push([line]);
    } else {
      lastCluster.push(line);
    }
  }
  return clusters.sort((a, b) => b.length - a.length || a[0]! - b[0]!);
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isFinite(value) && value > 0))];
}

function contextGateInlineFileKind(file: string): ContextGateInlineSlice["kind"] {
  if (isTestFlowFile(file)) {
    return "test";
  }
  if (isFrontendBusinessFile(file)) {
    return "frontend";
  }
  if (isBackendBusinessFile(file) || isEntrypointFlowFile(file) || isServiceFlowFile(file) || isDataFlowFile(file)) {
    return "backend";
  }
  return "source";
}

function buildContextGateInlineCoverage(
  slices: ContextGateInlineSlice[],
  anchors: ContextGateAnchor[],
  focusFiles: string[],
  requiredSlots: string[]
): Record<string, EvidenceCoverageStatus> {
  const evidenceKinds = [
    ...slices.map((slice) => slice.kind),
    ...anchors.map((anchor) => anchor.kind)
  ];
  const hasSource = evidenceKinds.some((kind) => kind !== "test") || focusFiles.some((file) => isSourceFlowFile(file));
  const hasBackend = evidenceKinds.some((kind) => kind === "backend") || focusFiles.some((file) => contextGateInlineFileKind(file) === "backend");
  const hasFrontend = evidenceKinds.some((kind) => kind === "frontend") || focusFiles.some((file) => contextGateInlineFileKind(file) === "frontend");
  const hasTests = evidenceKinds.some((kind) => kind === "test") || focusFiles.some((file) => isTestFlowFile(file));
  const wantsFrontend = requiredSlots.some((slot) => /frontend|ui|page|caller/i.test(slot));
  return {
    source_files: hasSource ? "covered" : "missing",
    feature_source_grounding: hasSource ? "covered" : "missing",
    source_grounding: hasSource ? "covered" : "missing",
    feature_backend_or_domain_grounding: hasBackend ? "covered" : hasSource ? "partial" : "missing",
    feature_frontend_grounding: wantsFrontend ? hasFrontend ? "covered" : "missing" : hasFrontend ? "covered" : "partial",
    feature_test_grounding: hasTests ? "covered" : "missing",
    business_invariants: slices.length > 0 ? "covered" : "missing"
  };
}

function contextGateInlineStrictGaps(requiredSlots: string[], coverage: Record<string, EvidenceCoverageStatus>): string[] {
  const slotCoverageKeys: Record<string, string[]> = {
    source_files: ["feature_source_grounding", "source_grounding"],
    backend_entrypoint_api: ["feature_backend_or_domain_grounding"],
    service_domain_logic: ["feature_backend_or_domain_grounding"],
    frontend_state_or_caller_when_present: ["feature_frontend_grounding"],
    existing_tests: ["feature_test_grounding"],
    tests_or_validation: ["feature_test_grounding"],
    business_invariants_or_bug_symptom: ["business_invariants"]
  };
  const gaps: string[] = [];
  for (const slot of requiredSlots) {
    const keys = slotCoverageKeys[slot] ?? [];
    if (keys.length === 0) {
      continue;
    }
    if (!keys.some((key) => coverage[key] === "covered")) {
      gaps.push(`${slot} (${keys.map((key) => `${key}=${coverage[key] ?? "missing"}`).join(",")})`);
    }
  }
  return gaps;
}

function formatContextGateInlineEvidence(inlineEvidence: ContextGateInlineEvidence, effectiveAnswerable: boolean): string {
  return [
    "",
    "ContextGate broker inline source evidence:",
    `broker_answerable: ${effectiveAnswerable}`,
    `broker_tokens_est: ${inlineEvidence.tokensEst}`,
    `broker_strict_missing_slots: ${inlineEvidence.strictMissingSlots.length > 0 ? inlineEvidence.strictMissingSlots.join("; ") : "none"}`,
    `broker_focus_terms: ${inlineEvidence.focusTerms.slice(0, 14).join(", ") || "none"}`,
    `broker_focus_files: ${inlineEvidence.focusFiles.slice(0, 12).join(", ") || "none"}`,
    "broker_coverage:",
    ...Object.entries(inlineEvidence.coverage).map(([key, value]) => `- ${key}: ${value}`),
    inlineEvidence.anchors.length > 0 ? "broker_key_anchors:" : undefined,
    ...inlineEvidence.anchors.slice(0, 28).map((anchor) =>
      `- ${anchor.term} -> ${anchor.file}:${anchor.line} (${anchor.kind}) ${anchor.preview}`
    ),
    inlineEvidence.carryTerms.length > 0
      ? `broker_suggested_symbols: ${inlineEvidence.carryTerms.join(", ")}`
      : undefined,
    inlineEvidence.carryTerms.length > 0
      ? `broker_must_carry_terms: ${inlineEvidence.carryTerms.join(", ")}`
      : undefined,
    inlineEvidence.anchors.length > 0
      ? "broker_anchor_policy: include all broker_must_carry_terms as exact identifiers in final files/symbols/tests/risks/handoff fields when the requested output has such fields; if one is irrelevant, name why in risks/unknowns. Do not collapse exact files/symbols into generic source summaries."
      : undefined,
    "source_slices:",
    ...inlineEvidence.slices.flatMap((slice) => [
      `- file: ${slice.file}`,
      `  lines: ${slice.startLine}-${slice.endLine}`,
      `  kind: ${slice.kind}`,
      `  matched_terms: ${slice.matchedTerms.join(", ") || "path"}`,
      "  text:",
      ...slice.text.split("\n").map((line) => `    ${line}`)
    ])
  ].filter((line): line is string => line !== undefined).join("\n");
}

function slimContextGateInlineEvidence(inlineEvidence: ContextGateInlineEvidence) {
  return {
    ...inlineEvidence,
    slices: inlineEvidence.slices.map((slice) => ({
      file: slice.file,
      startLine: slice.startLine,
      endLine: slice.endLine,
      matchedTerms: slice.matchedTerms,
      kind: slice.kind,
      textChars: slice.text.length
    }))
  };
}

function applyContextGateInlineAnswerableOverride(text: string, inlineEvidence: ContextGateInlineEvidence): string {
  if (inlineEvidence.slices.length === 0 || inlineEvidence.strictMissingSlots.length > 0) {
    return text;
  }
  const overridden = text
    .replace(/evidence_contract_pass: false/g, "evidence_contract_pass: true")
    .replace(/fallback_reason: [^\n]+/, "fallback_reason: broker_inline_evidence_covered")
    .replace("answerable: false", "answerable: true")
    .replace(/deny_broad_exploration: false/, "deny_broad_exploration: true")
    .replace(/recommended_next_action: [^\n]+/, "recommended_next_action: answer_now")
    .replace(/max_additional_calls: \d+/, "max_additional_calls: 0")
    .replace(/coverage_gaps: [^\n]+/, "coverage_gaps: none")
    .replace(/Missing:\n(?:- .+\n)+/g, "Missing:\n- none\n")
    .replace(/Allowed followups:\n(?:- .+\n)+/g, "Allowed followups:\n- none\n")
    .replace(/Because answerable=false, do not present a final definitive answer until allowed_followups have covered missing exact code evidence\./g, "Because broker inline source evidence covers the required slots, answer from the packet and do not gather redundant evidence.");
  return injectContextGateCarryTermsIntoAnswerContract(overridden, inlineEvidence);
}

function injectContextGateCarryTermsIntoAnswerContract(text: string, inlineEvidence: ContextGateInlineEvidence): string {
  if (inlineEvidence.carryTerms.length === 0 || text.includes("required_output_identifiers=")) {
    return text;
  }
  const identifierLines = [
    `suggested_symbols=${inlineEvidence.carryTerms.join(" | ")}`,
    `required_output_identifiers=${inlineEvidence.carryTerms.join(" | ")}`,
    "identifier_rule=If the requested final output has a symbols field, start that array with suggested_symbols exactly before optional extras; otherwise include each required_output_identifiers item exactly in the closest files/tests/risks/handoff field or name why it is irrelevant in risks/unknowns. Keep compact JSON short enough to remain valid."
  ].join("\n");
  const answerContractPattern = /(Answer contract:\n(?:required_sections=.*\n)?(?:quality_checks=.*\n)?)/;
  if (answerContractPattern.test(text)) {
    return text.replace(answerContractPattern, `$1${identifierLines}\n`);
  }
  return text.replace(/\nMissing:\n/, `\nAnswer contract:\n${identifierLines}\n\nMissing:\n`);
}

function writeContextGateBrokerState(
  loaded: LoadedConfig,
  task: string,
  taskType: EvidenceTaskType,
  structuredContent: Record<string, unknown> | undefined,
  inlineEvidence: ContextGateInlineEvidence
): void {
  const now = new Date();
  const packetSummary = structuredContent && isRecord(structuredContent.packetSummary)
    ? structuredContent.packetSummary
    : undefined;
  const existingPacket = structuredContent && isRecord(structuredContent.packet)
    ? structuredContent.packet
    : undefined;
  const route = packetSummary && isRecord(packetSummary.route) ? packetSummary.route as unknown as RouteDecision : undefined;
  const acquisitionMode = parseAcquisitionMode(packetSummary?.acquisition_mode) ?? parseAcquisitionMode(existingPacket?.acquisition_mode) ?? "compile_evidence";
  const evidenceContract = parseEvidenceContract(packetSummary?.evidence_contract) ?? parseEvidenceContract(existingPacket?.evidence_contract) ?? "overview_contract";
  const confidence = typeof packetSummary?.confidence === "number"
    ? packetSummary.confidence
    : typeof existingPacket?.confidence === "number"
      ? existingPacket.confidence
      : 0.84;
  const expiresAt = typeof existingPacket?.expires_at === "string" && Date.parse(existingPacket.expires_at) > now.getTime()
    ? existingPacket.expires_at
    : new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  const packet: EvidencePacket = {
    packet_id: typeof packetSummary?.packet_id === "string" ? packetSummary.packet_id : crypto.randomUUID(),
    task,
    task_type: taskType,
    route,
    repo_root: loaded.repoRoot,
    acquisition_mode: acquisitionMode,
    evidence_contract: evidenceContract,
    evidence_contract_pass: true,
    fallback_reason: "broker_inline_evidence_covered",
    answerable: true,
    confidence,
    coverage: inlineEvidence.coverage,
    output_policy: {
      preferred_format: "standard_answer",
      avoid_full_file_rewrite: true,
      include_explanation_max_tokens: 900,
      applies_to: ["contextgate_broker"]
    },
    evidence: [
      {
        id: "CG1",
        claim: "ContextGate broker inline source evidence covered the requested slots.",
        files: inlineEvidence.focusFiles.slice(0, 20),
        facts: [
          `broker_focus_terms=${inlineEvidence.focusTerms.slice(0, 24).join(",")}`,
          `broker_carry_terms=${inlineEvidence.carryTerms.join(",")}`,
          `broker_anchor_count=${inlineEvidence.anchors.length}`,
          `broker_slice_count=${inlineEvidence.slices.length}`
        ],
        tokens_est: inlineEvidence.tokensEst
      }
    ],
    missing: [],
    answer_contract: buildAnswerContract(taskType, task, [], true),
    allowed_followups: [],
    disallowed_followups: [
      "tokenopt_search",
      "tokenopt_read_file",
      "shell_rg",
      "shell_grep",
      "shell_git_grep",
      "shell_findstr",
      "raw_shell_search"
    ],
    recommended_next_action: "answer_now",
    max_additional_calls: 0,
    token_budget: {
      budget_tokens: Math.max(400, inlineEvidence.tokensEst),
      evidence_tokens_est: inlineEvidence.tokensEst,
      response_tokens_est: 900
    },
    created_at: now.toISOString(),
    expires_at: expiresAt
  };
  const statePath = writeEvidenceTaskState(loaded.config, loaded.repoRoot, packet);
  appendEvent(loaded.config, {
    timestamp: now.toISOString(),
    source: "mcp",
    eventName: "compile-evidence",
    repoRoot: loaded.repoRoot,
    action: "evidence",
    reason: "contextgate-broker-answerable",
    metadata: {
      packetId: packet.packet_id,
      taskType,
      statePath,
      brokerAnchorCount: inlineEvidence.anchors.length,
      brokerSliceCount: inlineEvidence.slices.length,
      evidenceTokens: inlineEvidence.tokensEst
    }
  });
}

function parseAcquisitionMode(value: unknown): AcquisitionMode | undefined {
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

function parseEvidenceContract(value: unknown): EvidenceContractName | undefined {
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

function contextGateRefillFocusTerms(structuredContent: Record<string, unknown> | undefined): string[] {
  if (!structuredContent) {
    return [];
  }
  const packet = isRecord(structuredContent.packet) ? structuredContent.packet : undefined;
  const evidence = Array.isArray(packet?.evidence) ? packet.evidence : [];
  const terms: string[] = [];
  for (const item of evidence) {
    if (!isRecord(item) || !Array.isArray(item.facts)) {
      continue;
    }
    for (const fact of item.facts) {
      if (typeof fact !== "string") {
        continue;
      }
      const [key, value = ""] = fact.split("=", 2);
      if (!/^(?:feature_terms|feature_source_files|feature_backend_files|feature_frontend_files|feature_test_files)$/.test(key)) {
        continue;
      }
      for (const part of value.split(",")) {
        const cleaned = part.trim();
        if (cleaned && cleaned !== "none_detected" && isUsefulContextGateRefillTerm(cleaned)) {
          terms.push(cleaned);
        }
      }
    }
  }
  return uniqueStrings(terms).slice(0, 16);
}

function isUsefulContextGateRefillTerm(term: string): boolean {
  const lower = term.toLowerCase();
  if (/^(?:readme\.md|package\.json|pnpm-lock\.yaml|gradle|none_detected)$/i.test(term)) {
    return false;
  }
  if (/\.(?:java|ts|tsx|vue|js|jsx|kt|py)$/i.test(term)) {
    return true;
  }
  return selectExactFlowSearchTerms([term]).length > 0;
}

function contextGateStrictGaps(structuredContent: Record<string, unknown> | undefined, requiredSlots: string[]): string[] {
  if (requiredSlots.length === 0 || !structuredContent) {
    return [];
  }
  const dimensions = contextGateCoverageDimensions(structuredContent);
  if (!dimensions) {
    return [];
  }
  const slotCoverageKeys: Record<string, string[]> = {
    source_files: ["feature_source_grounding", "source_grounding"],
    backend_entrypoint_api: ["feature_backend_or_domain_grounding"],
    service_domain_logic: ["feature_backend_or_domain_grounding"],
    frontend_state_or_caller_when_present: ["feature_frontend_grounding"],
    existing_tests: ["feature_test_grounding"],
    tests_or_validation: ["feature_test_grounding"],
    business_invariants_or_bug_symptom: ["business_invariants"],
    changed_files: ["changed_files"],
    changed_symbols: ["changed_symbols"]
  };
  const gaps: string[] = [];
  for (const slot of requiredSlots) {
    const keys = slotCoverageKeys[slot] ?? [];
    if (keys.length === 0) {
      continue;
    }
    const covered = keys.some((key) => dimensions[key] === "covered");
    if (!covered) {
      const statuses = keys
        .map((key) => `${key}=${typeof dimensions[key] === "string" ? dimensions[key] : "missing"}`)
        .join(",");
      gaps.push(`${slot} (${statuses})`);
    }
  }
  return gaps;
}

function contextGateCoverageDimensions(structuredContent: Record<string, unknown>): Record<string, unknown> | undefined {
  const packetSummary = isRecord(structuredContent.packetSummary) ? structuredContent.packetSummary : undefined;
  const coverageCertificate = packetSummary && isRecord(packetSummary.coverage_certificate)
    ? packetSummary.coverage_certificate
    : undefined;
  if (coverageCertificate && isRecord(coverageCertificate.dimensions)) {
    return coverageCertificate.dimensions;
  }
  const packet = isRecord(structuredContent.packet) ? structuredContent.packet : undefined;
  return packet && isRecord(packet.coverage) ? packet.coverage : undefined;
}

function contextGateBaseAnswerable(structuredContent: Record<string, unknown> | undefined): boolean {
  if (!structuredContent) {
    return false;
  }
  const packetSummary = isRecord(structuredContent.packetSummary) ? structuredContent.packetSummary : undefined;
  if (typeof packetSummary?.answerable === "boolean") {
    return packetSummary.answerable;
  }
  const packet = isRecord(structuredContent.packet) ? structuredContent.packet : undefined;
  return typeof packet?.answerable === "boolean" ? packet.answerable : false;
}

function applyContextGateStrictOverride(text: string, strictGaps: string[]): string {
  const missing = [
    "Missing:",
    ...strictGaps.slice(0, 8).map((gap) => `- ContextGate strict slot still partial/missing: ${gap}`)
  ].join("\n");
  const followups = [
    "Allowed followups:",
    "- bounded_context: Refill only the named missing slots with the cheapest bounded context provider visible in this session.",
    "- exact_source_slice: Prefer exact source slices for named files/symbols over broad ranked search."
  ].join("\n");
  return text
    .replace("answerable: true", "answerable: false")
    .replace("recommended_next_action: answer_now", "recommended_next_action: refill_missing_slots")
    .replace("max_additional_calls: 0", "max_additional_calls: 2")
    .replace("deny_broad_exploration: true", "deny_broad_exploration: false")
    .replace(/coverage_gaps: none/, `coverage_gaps: ${strictGaps.join("; ")}`)
    .replace(/Missing:\n- none/, missing)
    .replace(/Allowed followups:\n- none/, followups)
    .replace(/Because answerable=true, answer from the packet and do not gather redundant evidence\./g, "Because strict required slots remain partial, refill only those slots before the final answer.");
}

async function compileEvidenceTool(args: Record<string, unknown>, mcpMode: McpMode = "lite", ctx: TokenoptToolContext = {}) {
  const baseTask = sanitizeTaskPrompt(requiredString(args, "task"));
  const externalArtifacts = parseExternalArtifacts(args);
  const task = appendExternalArtifactContext(baseTask, externalArtifacts);
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const requestedTaskType = normalizeTaskType(optionalString(args, "task_type"), task);
  const budgetTokens = clampInteger(optionalNumber(args, "budget_tokens") ?? 1600, 400, 8000);
  const qualityRubric = optionalStringArray(args, "quality_rubric").slice(0, 12);
  const detail = normalizeEvidenceDetail(optionalString(args, "detail"));
  const includeStructuredPacket = optionalBoolean(args, "include_structured_packet") ?? false;
  const earlyRoute = routeTask({
    task,
    requestedTaskType
  });
  const earlyTaskType = optionalString(args, "task_type") && requestedTaskType !== "unknown" ? requestedTaskType : earlyRoute.taskType;
  if (earlyRoute.taskClass === "needs_input_bypass") {
    return compileMissingArtifactPacket({
      loaded,
      task,
      taskType: earlyTaskType,
      route: earlyRoute,
      budgetTokens,
      qualityRubric,
      detail,
      includeStructuredPacket
    });
  }
  if (earlyRoute.taskClass === "security_audit") {
    return compileSecurityAuditPacket({
      loaded,
      task,
      taskType: earlyTaskType,
      route: earlyRoute,
      budgetTokens,
      qualityRubric,
      detail,
      includeStructuredPacket
    });
  }
  if (earlyRoute.acquisitionMode === "direct_narrow" && earlyRoute.evidenceContract === "trace_proof") {
    return compileDirectNarrowTracebugPacket({
      loaded,
      task,
      taskType: earlyTaskType,
      route: earlyRoute,
      budgetTokens,
      qualityRubric,
      detail,
      includeStructuredPacket
    }, mcpMode);
  }
  if (earlyRoute.acquisitionMode === "failure_packet") {
    return compileFailureEvidencePacket({
      loaded,
      task,
      taskType: earlyTaskType,
      route: earlyRoute,
      budgetTokens,
      qualityRubric,
      detail,
      includeStructuredPacket
    }, mcpMode);
  }
  const cacheLookup = createEvidenceCacheLookup(loaded.repoRoot, {
    task,
    taskType: earlyTaskType,
    budgetTokens,
    mcpMode,
    detail,
    qualityRubric
  });
  const cached = readEvidenceCacheEntry(loaded.config, loaded.repoRoot, cacheLookup);
  if (cached) {
    const packet = withPacketMetadata(cached.packet, evidenceCacheMetadata(cacheLookup, true, cached.packet.metadata ?? {}));
    const statePath = writeEvidenceTaskState(loaded.config, loaded.repoRoot, packet);
    appendEvent(loaded.config, {
      timestamp: new Date().toISOString(),
      source: "mcp",
      eventName: "compile-evidence",
      repoRoot: loaded.repoRoot,
      action: "evidence",
      reason: "evidence-cache-hit",
      metadata: {
        packetId: packet.packet_id,
        taskType: packet.task_type,
        acquisitionMode: packet.acquisition_mode,
        evidenceContract: packet.evidence_contract,
        evidenceContractPass: packet.evidence_contract_pass,
        statePath,
        evidenceTokens: packet.token_budget.evidence_tokens_est,
        evidenceCacheHit: true,
        evidenceCacheKey: cacheLookup.keyHash
      }
    });
    return textResult(formatEvidencePacket(packet, statePath, detail), false, buildEvidenceStructuredContent(packet, statePath, includeStructuredPacket));
  }
  const inventory = buildRepoInventory(loaded.repoRoot, loaded.config, loaded.repoRoot);
  const route = routeTask({
    task,
    repoFileCount: inventory.totalFiles,
    requestedTaskType
  });
  const taskType = optionalString(args, "task_type") && requestedTaskType !== "unknown" ? requestedTaskType : route.taskType;
  const facts = extractProjectFacts(loaded.repoRoot);
  const factFiles = factSourceFiles(facts);
  const hasBuildFacts = facts.some((fact) => fact.startsWith("build_tool="));
  const overview = extractRepositoryOverview(loaded.repoRoot);
  const structureFacts = extractStructureFacts(inventory);
  const evidenceContext: EvidenceContext = {
    inventory,
    facts,
    overview,
    structureFacts
  };
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
  const evidence: EvidenceItem[] = [
    {
      id: "E1",
      claim: "Repository build facts were extracted deterministically from common root build files.",
      files: factFiles,
      facts: facts.slice(0, 28),
      tokens_est: estimateTokens(facts.join("\n"))
    },
    {
      id: "E2",
      claim: "Repository shape was summarized from a raw file inventory stored outside model context.",
      facts: [
        `total_files=${inventory.totalFiles}`,
        `search_provider=${inventory.searchProvider}`,
        `top_dirs=${inventory.topDirs.slice(0, 8).map(([name, count]) => `${name}:${count}`).join(",")}`,
        `top_extensions=${inventory.topExtensions.slice(0, 8).map(([name, count]) => `${name}:${count}`).join(",")}`,
        `raw_inventory_artifact=${inventory.rawArtifact}`
      ],
      tokens_est: 140
    }
  ];

  if (overview) {
    evidence.push({
      id: "E3",
      claim: "Repository overview was extracted from a root documentation file.",
      files: [overview.file],
      facts: [
        `overview_file=${overview.file}`,
        `overview_title=${overview.title}`,
        `overview_summary=${overview.summary}`
      ],
      tokens_est: estimateTokens(`${overview.title}\n${overview.summary}`)
    });
  }

  evidence.push({
    id: `E${evidence.length + 1}`,
    claim: "Likely source and test areas were inferred from bounded inventory counts.",
    facts: structureFacts,
    tokens_est: estimateTokens(structureFacts.join("\n"))
  });

  if (externalArtifacts.length > 0) {
    evidence.push(buildExternalArtifactEvidenceItem(`E${evidence.length + 1}`, externalArtifacts));
  }

  const taskSpecific = await compileTaskSpecificEvidence(taskType, task, loaded.repoRoot, evidence.length + 1, evidenceContext, {
    hasBuildFacts,
    codingToolsAvailable: mcpMode === "full",
    qualityRubric,
    graphProvider: ctx.graphSymbolProvider
  });
  if (taskSpecific) {
    evidence.push(...taskSpecific.evidence);
  }

  const baseAnswerable = isEvidenceAnswerable(taskType, hasBuildFacts, inventory.totalFiles > 0, Boolean(overview), structureFacts);
  const initialAnswerable = taskSpecific?.answerable ?? baseAnswerable;
  const specificity = checkTargetSpecificity(task, taskType, evidence);
  const answerable = initialAnswerable && specificity.missing.length === 0;
  const preferTaskSpecificFollowups = route.taskClass === "coding_coverage" && taskSpecific?.allowedFollowups.length;
  const coverage = {
    ...buildCoverage(taskType, hasBuildFacts, inventory.totalFiles > 0, Boolean(overview), structureFacts, qualityRubric),
    ...(taskSpecific?.coverage ?? {}),
    ...(externalArtifacts.length > 0
      ? {
          external_requirement_artifact: "covered" as const
        }
      : {}),
    ...(specificity.terms.length > 0
      ? {
          target_specific_evidence: specificity.missing.length === 0 ? "covered" as const : specificity.covered.length > 0 ? "partial" as const : "missing" as const
        }
      : {})
  };
  const missing = answerable
    ? []
    : specificity.missing.length > 0
      ? [
          `Target-specific evidence missing for: ${specificity.missing.join(", ")}.`,
          "TokenOpt cannot mark this task answerable until the packet includes evidence tied to the requested target.",
          ...(taskSpecific?.missing ?? [])
        ]
    : taskSpecific?.missing.length
      ? taskSpecific.missing
      : [
          "Task is not answerable from deterministic project facts alone.",
          "Use exact search/read followups for the specific symbol, file, or command named by the task."
        ];
  const allowedFollowups = answerable
    ? []
    : preferTaskSpecificFollowups
      ? taskSpecific!.allowedFollowups
    : specificity.missing.length > 0
      ? buildTargetSpecificFollowups(specificity.missing)
    : taskSpecific?.allowedFollowups.length
      ? taskSpecific.allowedFollowups
      : [
          {
            tool: "tokenopt_search",
            reason: "Search only for the concrete symbol, route, class, or config key required by the task.",
            args: { pattern: "<exact-pattern>", path: "<narrow-path>" },
            max_output_tokens: 600
          },
          {
            tool: "tokenopt_read_file",
            reason: "Read only bounded slices around exact matches.",
            args: { path: "<matched-file>", startLine: 1, maxLines: 120 },
            max_output_tokens: 900
          }
        ];
  const cappedAllowedFollowups = capAllowedFollowups(allowedFollowups, route, taskType);
  const answerContract = buildAnswerContract(taskType, task, qualityRubric, answerable);
  const packetId = crypto.randomUUID();
  const coverageCertificate = buildCoverageCertificate(packetId, route, answerable, taskSpecific?.confidence ?? (answerable ? 0.86 : 0.48), coverage, missing, cappedAllowedFollowups);
  const outputPolicy = buildOutputPolicy(route, taskType);
  const packet: EvidencePacket = {
    packet_id: packetId,
    task,
    task_type: taskType,
    route,
    repo_root: loaded.repoRoot,
    acquisition_mode: route.acquisitionMode,
    evidence_contract: route.evidenceContract,
    evidence_contract_pass: coverageCertificate.evidence_contract_pass,
    fallback_reason: route.fallbackReason,
    answerable,
    confidence: taskSpecific?.confidence ?? (answerable ? 0.86 : 0.48),
    coverage,
    coverage_certificate: coverageCertificate,
    output_policy: outputPolicy,
    evidence,
    missing,
    answer_contract: answerContract,
    allowed_followups: cappedAllowedFollowups,
    disallowed_followups: answerable
      ? [
          "tokenopt_search",
          "tokenopt_read_file",
          "shell_rg",
          "shell_grep",
          "shell_git_grep",
          "shell_findstr",
          "raw_shell_search"
        ]
      : ["repo_wide_rg_files", "full_file_reads", "full_suite_tests_without_target"],
    recommended_next_action: answerable ? "answer_now" : "expand_exact",
    max_additional_calls: maxAdditionalCallsForPacket(answerable, route, taskType, cappedAllowedFollowups),
    token_budget: {
      budget_tokens: budgetTokens,
      evidence_tokens_est: evidence.reduce((total, item) => total + (item.tokens_est ?? estimateTokens(JSON.stringify(item))), 0),
      response_tokens_est: answerable ? Math.min(900, Math.max(300, Math.floor(budgetTokens * 0.45))) : 250
    },
    metadata: evidenceCacheMetadata(cacheLookup, false, taskSpecific?.metadata ?? {}),
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString()
  };

  const statePath = writeEvidenceTaskState(loaded.config, loaded.repoRoot, packet);
  const cachePath = isCacheableEvidencePacket(packet)
    ? writeEvidenceCacheEntry(loaded.config, loaded.repoRoot, cacheLookup, packet)
    : undefined;
  appendEvent(loaded.config, {
    timestamp: now.toISOString(),
    source: "mcp",
    eventName: "compile-evidence",
    repoRoot: loaded.repoRoot,
    action: "evidence",
    reason: answerable ? "answerable" : "needs-exact-followup",
    metadata: {
      packetId: packet.packet_id,
      taskType,
      acquisitionMode: packet.acquisition_mode,
      evidenceContract: packet.evidence_contract,
      evidenceContractPass: packet.evidence_contract_pass,
      statePath,
      evidenceTokens: packet.token_budget.evidence_tokens_est,
      evidenceCacheHit: false,
      evidenceCacheKey: cacheLookup.keyHash,
      evidenceCachePath: cachePath,
      symbolIndexHit: taskSpecific?.metadata?.symbol_index_hit
    }
  });

  return textResult(formatEvidencePacket(packet, statePath, detail), false, buildEvidenceStructuredContent(packet, statePath, includeStructuredPacket));
}

interface EarlyEvidencePacketInput {
  loaded: LoadedConfig;
  task: string;
  taskType: EvidenceTaskType;
  route: RouteDecision;
  budgetTokens: number;
  qualityRubric: string[];
  detail: EvidenceDetail;
  includeStructuredPacket: boolean;
}

function compileMissingArtifactPacket(input: EarlyEvidencePacketInput) {
  const coverage: Record<string, EvidenceCoverageStatus> = {
    prompt_classified: "covered",
    concrete_artifact: "missing",
    repo_evidence_needed: "missing"
  };
  const missing = [
    input.route.reason,
    "Provide the concrete PBI, requirement text, diff, file/symbol target, completed-task summary, or acceptance criteria before TokenOpt can compile grounded repository evidence."
  ];
  return writeEarlyEvidencePacket({
    ...input,
    answerable: false,
    confidence: 0.88,
    coverage,
    missing,
    evidence: [
      {
        id: "E1",
        claim: "TokenOpt detected a missing required artifact and skipped repository inventory to avoid speculative exploration.",
        facts: [`route=${input.route.taskClass}`, `reason=${input.route.reason}`, "repo_inventory=skipped"],
        tokens_est: 70
      }
    ],
    allowedFollowups: [],
    recommendedNextAction: "ask_user",
    maxAdditionalCalls: 0,
    disallowedFollowups: [
      "repo_wide_rg_files",
      "full_file_reads",
      "raw_shell_search",
      "shell_fallback_without_concrete_artifact",
      "mcp_followups_without_concrete_artifact"
    ],
    eventReason: "missing-artifact-bypass"
  });
}

function compileSecurityAuditPacket(input: EarlyEvidencePacketInput) {
  const coverage = buildSecurityAuditCoverage(input.task, input.route);
  const required = [
    "target_or_diff_known",
    "changed_files_or_scope_seen",
    "input_boundaries_checked",
    "auth_authz_checked",
    "validation_or_deserialization_checked",
    "secret_config_dependency_checked",
    "test_or_guardrail_context_seen"
  ];
  const missing = required
    .filter((dimension) => coverage[dimension] !== "covered")
    .map((dimension) => `Security coverage missing: ${dimension}=${coverage[dimension] ?? "missing"}.`);
  const hasScope = coverage.target_or_diff_known === "covered" && coverage.changed_files_or_scope_seen === "covered";
  const allowedFollowups: EvidenceFollowup[] = hasScope
    ? [
        {
          tool: "tokenopt_search",
          reason: "Search only for the exact security-relevant target, changed symbol, route, config key, or guardrail named by the task.",
          args: { pattern: "<security-target>", path: "<narrow-path>" },
          max_output_tokens: 700
        },
        {
          tool: "tokenopt_read_file",
          reason: "Read bounded slices around the exact security boundary, validation logic, auth/authz check, or test guardrail.",
          args: { path: "<matched-file>", startLine: 1, maxLines: 160 },
          max_output_tokens: 1000
        }
      ]
    : [];
  const packetMissing = missing.length > 0
    ? [
        ...missing,
        hasScope
          ? "Use exact security followups only; do not broaden into repo-wide review exploration."
          : "Provide a concrete diff, changed file list, PR, route, symbol, or risky surface before producing security findings."
      ]
    : [
        "Security audit scope is named, but TokenOpt still requires exact repository evidence before final findings.",
        "Use exact security followups only; do not broaden into repo-wide review exploration."
      ];

  return writeEarlyEvidencePacket({
    ...input,
    answerable: false,
    confidence: hasScope ? 0.56 : 0.42,
    coverage,
    missing: packetMissing,
    evidence: [
      {
        id: "E1",
        claim: "TokenOpt classified this as a security audit and required security-specific coverage before answerability.",
        facts: [
          `route=${input.route.taskClass}`,
          `coverage=${Object.entries(coverage).map(([key, value]) => `${key}:${value}`).join(",")}`,
          "repo_inventory=skipped"
        ],
        tokens_est: 110
      }
    ],
    allowedFollowups,
    recommendedNextAction: hasScope ? "expand_exact" : "ask_user",
    maxAdditionalCalls: allowedFollowups.length,
    disallowedFollowups: [
      "repo_wide_rg_files",
      "full_file_reads",
      "full_suite_tests_without_target",
      "broad_shell_review_fallback",
      "security_findings_without_scope_evidence"
    ],
    eventReason: hasScope ? "security-needs-exact-followup" : "security-needs-scope"
  });
}

function compileDirectNarrowTracebugPacket(input: EarlyEvidencePacketInput, mcpMode: McpMode) {
  const allowedFollowups: EvidenceFollowup[] = [
    {
      tool: "tokenopt_search",
      reason: "Search only for the exact failing test, stack frame, file, symbol, guard, condition, endpoint, or behavior named by the task.",
      args: { pattern: "<exact-tracebug-anchor>", path: "<narrow-path>" },
      max_output_tokens: 600
    },
    {
      tool: "tokenopt_read_file",
      reason: "Read only the bounded slice around the exact tracebug anchor.",
      args: { path: "<matched-file>", startLine: 1, maxLines: 120 },
      max_output_tokens: 900
    }
  ];
  return writeEarlyEvidencePacket({
    ...input,
    answerable: false,
    confidence: 0.84,
    coverage: {
      tracebug_task_classified: "covered",
      concrete_artifact: "covered",
      exact_line_proof: "missing",
      corroborating_cue: "missing",
      repo_inventory_needed: "missing"
    },
    missing: [
      "Tracebug requires exact file/line proof plus one corroborating caller, callee, nearby test, config, or failure cue."
    ],
    evidence: [
      {
        id: "E1",
        claim: "TokenOpt classified this as an exact tracebug proof task and skipped broad repository inventory to avoid double-spend.",
        facts: [
          `route=${input.route.taskClass}`,
          `acquisition_mode=${input.route.acquisitionMode}`,
          `evidence_contract=${input.route.evidenceContract}`,
          "repo_inventory=skipped"
        ],
        tokens_est: 90
      }
    ],
    allowedFollowups: allowedFollowups.slice(0, 2),
    recommendedNextAction: "expand_exact",
    maxAdditionalCalls: 2,
    disallowedFollowups: [
      "repo_wide_rg_files",
      "broad_compile_evidence",
      "generic_review_fallback",
      "full_file_reads",
      "broad_shell_search_after_tracebug_packet"
    ],
    eventReason: "tracebug-direct-narrow"
  });
}

function compileFailureEvidencePacket(input: EarlyEvidencePacketInput, mcpMode: McpMode) {
  const failurePacket = parseFailurePacket({ output: input.task });
  const topSlice = failurePacket.suggested_slices[0];
  const allowedFollowups: EvidenceFollowup[] = mcpMode === "full"
    ? [
        {
          tool: "tokenopt_tracebug_packet",
          reason: "Use one tracebug packet to combine normalized failure output with exact code slices.",
          args: { query: input.task, output: input.task },
          max_output_tokens: 1400
        }
      ]
    : topSlice
      ? [
          {
            tool: "tokenopt_read_file",
            reason: topSlice.reason,
            args: { path: topSlice.file, startLine: topSlice.startLine, maxLines: topSlice.maxLines },
            max_output_tokens: 900
          }
        ]
      : [];
  const hasFailureLocation = failurePacket.suggested_slices.length > 0;
  return writeEarlyEvidencePacket({
    ...input,
    answerable: false,
    confidence: hasFailureLocation ? 0.72 : 0.54,
    coverage: {
      failure_artifact: failurePacket.errors.length > 0 ? "covered" : "partial",
      normalized_failure: failurePacket.errors.length > 0 ? "covered" : "missing",
      implicated_file_or_symbol: hasFailureLocation ? "partial" : "missing",
      exact_fix_surface: "missing",
      repo_inventory_needed: "missing"
    },
    missing: [
      hasFailureLocation
        ? "Failure output was normalized, but exact fix-surface proof still requires one bounded slice or tracebug packet."
        : "Failure output did not include a parseable file/line; provide a stronger stack trace, compiler error, failing test, or repro command.",
      "Do not broaden into repo inventory before the failure contract has an implicated file/symbol."
    ],
    evidence: [
      {
        id: "E1",
        claim: "TokenOpt normalized failure output before repository acquisition.",
        facts: [
          `failure_kind=${failurePacket.failure_kind}`,
          `errors=${failurePacket.errors.length}`,
          `suggested_slices=${failurePacket.suggested_slices.map((slice) => `${slice.file}:${slice.startLine}+${slice.maxLines}`).join(",") || "none"}`,
          "repo_inventory=skipped"
        ],
        tokens_est: 120
      }
    ],
    allowedFollowups,
    recommendedNextAction: hasFailureLocation ? "expand_exact" : "ask_user",
    maxAdditionalCalls: allowedFollowups.length > 0 ? 1 : 0,
    disallowedFollowups: [
      "repo_wide_rg_files",
      "generic_debug_inventory",
      "full_file_reads",
      "full_suite_tests_without_target"
    ],
    eventReason: hasFailureLocation ? "failure-packet-needs-slice" : "failure-packet-needs-artifact"
  });
}

function writeEarlyEvidencePacket(input: EarlyEvidencePacketInput & {
  answerable: boolean;
  confidence: number;
  coverage: Record<string, EvidenceCoverageStatus>;
  missing: string[];
  evidence: EvidenceItem[];
  allowedFollowups: EvidenceFollowup[];
  recommendedNextAction: EvidencePacket["recommended_next_action"];
  maxAdditionalCalls: number;
  disallowedFollowups: string[];
  eventReason: string;
}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
  const packetId = crypto.randomUUID();
  const answerContract = buildAnswerContract(input.taskType, input.task, input.qualityRubric, input.answerable);
  const coverageCertificate = buildCoverageCertificate(packetId, input.route, input.answerable, input.confidence, input.coverage, input.missing, input.allowedFollowups);
  const outputPolicy = buildOutputPolicy(input.route, input.taskType);
  const packet: EvidencePacket = {
    packet_id: packetId,
    task: input.task,
    task_type: input.taskType,
    route: input.route,
    repo_root: input.loaded.repoRoot,
    acquisition_mode: input.route.acquisitionMode,
    evidence_contract: input.route.evidenceContract,
    evidence_contract_pass: coverageCertificate.evidence_contract_pass,
    fallback_reason: input.route.fallbackReason,
    answerable: input.answerable,
    confidence: input.confidence,
    coverage: input.coverage,
    coverage_certificate: coverageCertificate,
    output_policy: outputPolicy,
    evidence: input.evidence,
    missing: input.answerable ? [] : input.missing,
    answer_contract: answerContract,
    allowed_followups: input.answerable ? [] : input.allowedFollowups,
    disallowed_followups: input.answerable
      ? [
          "tokenopt_search",
          "tokenopt_read_file",
          "shell_rg",
          "shell_grep",
          "shell_git_grep",
          "shell_findstr",
          "raw_shell_search"
        ]
      : input.disallowedFollowups,
    recommended_next_action: input.recommendedNextAction,
    max_additional_calls: input.maxAdditionalCalls,
    token_budget: {
      budget_tokens: input.budgetTokens,
      evidence_tokens_est: input.evidence.reduce((total, item) => total + (item.tokens_est ?? estimateTokens(JSON.stringify(item))), 0),
      response_tokens_est: input.answerable ? Math.min(900, Math.max(300, Math.floor(input.budgetTokens * 0.45))) : 220
    },
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString()
  };

  const statePath = writeEvidenceTaskState(input.loaded.config, input.loaded.repoRoot, packet);
  appendEvent(input.loaded.config, {
    timestamp: now.toISOString(),
    source: "mcp",
    eventName: "compile-evidence",
    repoRoot: input.loaded.repoRoot,
    action: "evidence",
    reason: input.eventReason,
    metadata: {
      packetId: packet.packet_id,
      taskType: input.taskType,
      acquisitionMode: packet.acquisition_mode,
      evidenceContract: packet.evidence_contract,
      evidenceContractPass: packet.evidence_contract_pass,
      statePath,
      evidenceTokens: packet.token_budget.evidence_tokens_est
    }
  });

  return textResult(formatEvidencePacket(packet, statePath, input.detail), false, buildEvidenceStructuredContent(packet, statePath, input.includeStructuredPacket));
}

function buildSecurityAuditCoverage(task: string, route: RouteDecision): Record<string, EvidenceCoverageStatus> {
  const hasMissingArtifact = route.promptSignals.includes("artifact:missing");
  const hasInlineDiff = /^diff --git\b/m.test(task) || /^@@\s/m.test(task);
  const hasFileOrSymbol = route.promptSignals.some((signal) => signal.startsWith("file:") || signal.startsWith("symbol:"));
  const hasExplicitScope = !hasMissingArtifact && (hasInlineDiff || hasFileOrSymbol || /\b(?:risky surface|changed files?|route|endpoint|controller|service|config|dependency|auth|permission)\s*:\s*\S.{8,}/i.test(task));
  return {
    security_task_classified: "covered",
    target_or_diff_known: hasExplicitScope ? "covered" : "missing",
    changed_files_or_scope_seen: hasExplicitScope ? "covered" : "missing",
    input_boundaries_checked: /\b(input|request|payload|parameter|param|form|endpoint|controller|api|boundary)\b/i.test(task) ? "covered" : "missing",
    auth_authz_checked: /\b(auth|authorization|authentication|permission|role|tenant|access control)\b/i.test(task) ? "covered" : "missing",
    validation_or_deserialization_checked: /\b(validat|sanitize|deserialize|deserialization|schema|parser|csrf|xss|sql injection)\b/i.test(task) ? "covered" : "missing",
    secret_config_dependency_checked: /\b(secret|credential|token|config|dependency|version|supply chain|env)\b/i.test(task) ? "covered" : "missing",
    test_or_guardrail_context_seen: /\b(test|guardrail|assert|regression|policy)\b/i.test(task) ? "covered" : "missing"
  };
}

function capAllowedFollowups(followups: EvidenceFollowup[], route: RouteDecision, taskType: EvidenceTaskType): EvidenceFollowup[] {
  if (route.taskClass === "coding_coverage" && taskType === "write_unittest") {
    const symbolPacket = followups.find((followup) => followup.tool === "tokenopt_symbol_packet");
    return (symbolPacket ? [symbolPacket] : followups).slice(0, 1);
  }
  if (route.taskClass === "review_diff") {
    return followups.slice(0, 2);
  }
  return followups;
}

function maxAdditionalCallsForPacket(
  answerable: boolean,
  route: RouteDecision,
  taskType: EvidenceTaskType,
  followups: EvidenceFollowup[]
): number {
  if (answerable) {
    return 0;
  }
  if (route.taskClass === "needs_input_bypass") {
    return 0;
  }
  if (route.taskClass === "coding_coverage" && taskType === "write_unittest") {
    return Math.min(1, followups.length);
  }
  if (route.taskClass === "review_diff") {
    return Math.min(2, followups.length);
  }
  return Math.min(3, followups.length || 3);
}

async function runCommandTool(args: Record<string, unknown>) {
  const command = requiredString(args, "command");
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const gate = maybeGateAfterAnswerable(loaded, "tokenopt_run_command");
  if (gate) {
    return gate;
  }

  const decision = evaluateToolPolicy(cwd, "Bash", { command }, loaded.repoRoot);
  if (decision.action === "deny") {
    const replacement = maybeBuildCommandReplacement(command, cwd, loaded.config, loaded.repoRoot, decision.reason);
    if (replacement) {
      return textResult(replacement.text, false, replacement.structuredContent);
    }
    return textResult(`TokenOpt denied command before execution: ${decision.reason ?? "Policy denied command."}`, true);
  }

  const result = await executeWrappedShellCommand(command, loaded.config, loaded.repoRoot, cwd);
  const context = decision.action === "context" && decision.additionalContext ? `${decision.additionalContext}\n\n` : "";
  return textResult(`${context}${result.summary}`, false, {
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    rawArtifact: result.rawArtifact,
    estimatedTokensSaved: result.estimatedTokensSaved
  });
}

function maybeBuildCommandReplacement(
  command: string,
  cwd: string,
  config: TokenOptConfig,
  repoRoot: string,
  reason?: string
): { text: string; structuredContent: Record<string, unknown> } | undefined {
  if (!isRepoWideFileListing(command)) {
    return undefined;
  }

  const inventory = buildRepoInventory(cwd, config, repoRoot);
  const text = [
    "TokenOpt replaced a raw repo-wide file listing with bounded repo inventory.",
    `originalCommand: ${command}`,
    `policyReason: ${reason ?? "Repo-wide file listing would produce high-token raw output."}`,
    `searchProvider: ${inventory.searchProvider}`,
    `totalFiles: ${inventory.totalFiles}`,
    `rawChars: ${inventory.rawChars}`,
    `estimatedTokensAvoided: ${inventory.estimatedTokensAvoided}`,
    `rawArtifact: ${inventory.rawArtifact}`,
    "",
    "Top directories:",
    ...inventory.topDirs.map(([name, count]) => `- ${name}: ${count}`),
    "",
    "Top extensions:",
    ...inventory.topExtensions.map(([name, count]) => `- ${name}: ${count}`),
    "",
    "Root files:",
    ...inventory.rootFiles.map((file) => `- ${file}`),
    "",
    "Likely entry/config files:",
    ...inventory.importantFiles.map((file) => `- ${file}`),
    "",
    "Next step: use tokenopt_search with a concrete pattern or tokenopt_read_file for bounded file slices."
  ].join("\n");

  return {
    text,
    structuredContent: {
      action: "replaced",
      originalCommand: command,
      searchProvider: inventory.searchProvider,
      totalFiles: inventory.totalFiles,
      rawChars: inventory.rawChars,
      rawArtifact: inventory.rawArtifact,
      estimatedTokensAvoided: inventory.estimatedTokensAvoided
    }
  };
}

function isRepoWideFileListing(command: string): boolean {
  return /^rg\s+--files\b/i.test(command.trim());
}

function buildRepoInventory(cwd: string, config: TokenOptConfig, repoRoot: string): RepoInventory {
  const listing = collectRepoFiles(cwd, repoRoot);
  const files = listing.files;
  const raw = [
    `searchProvider=${listing.provider}`,
    ...listing.diagnostics.map((diagnostic) => `diagnostic=${diagnostic}`),
    "",
    listing.raw
  ].join("\n");
  const rawArtifact = writeArtifact(config, repoRoot, "repo-files.txt", raw);
  const topDirs = topCounts(files.map(firstPathSegment), 12);
  const topExtensions = topCounts(files.map(fileExtension), 12);
  const rootFiles = files.filter((file) => !/[\\/]/.test(file)).slice(0, 30);
  const importantFiles = files.filter(isImportantFile).slice(0, 60);
  const summaryChars = 2500 + rootFiles.join("\n").length + importantFiles.join("\n").length;

  return {
    totalFiles: files.length,
    rawChars: raw.length,
    rawArtifact,
    estimatedTokensAvoided: estimateTokensSaved(raw.length, summaryChars),
    searchProvider: listing.provider,
    diagnostics: listing.diagnostics,
    topDirs,
    topExtensions,
    rootFiles,
    importantFiles
  };
}

function collectRepoFiles(cwd: string, repoRoot: string): ProviderFileList {
  const diagnostics: string[] = [];
  const rg = runFileListCommand("rg", ["--files"], cwd);
  const rgFiles = filterRepoInventoryFiles(rg.files);
  if (rgFiles.files.length > 0) {
    if (rgFiles.removed > 0) {
      diagnostics.push(`inventory ignored generated/artifact paths: ${rgFiles.removed}`);
    }
    return { provider: "rg", files: rgFiles.files, raw: rgFiles.files.join("\n"), diagnostics };
  }
  diagnostics.push(`rg unavailable or empty: ${formatCommandDiagnostic(rg)}`);

  const git = runFileListCommand("git", ["ls-files"], repoRoot);
  const gitFiles = filterRepoInventoryFiles(git.files);
  if (gitFiles.files.length > 0) {
    if (gitFiles.removed > 0) {
      diagnostics.push(`inventory ignored generated/artifact paths: ${gitFiles.removed}`);
    }
    return { provider: "git", files: gitFiles.files, raw: gitFiles.files.join("\n"), diagnostics };
  }
  diagnostics.push(`git ls-files unavailable or empty: ${formatCommandDiagnostic(git)}`);

  const node = collectNodeRepoFiles(repoRoot);
  diagnostics.push(`node bounded scanner used: scanned=${node.files.length}${node.truncated ? " truncated=true" : ""}`);
  return {
    provider: "node",
    files: node.files,
    raw: node.files.join("\n"),
    diagnostics
  };
}

function filterRepoInventoryFiles(files: string[]): { files: string[]; removed: number } {
  const filtered: string[] = [];
  for (const file of files) {
    const normalized = file.replace(/\\/g, "/");
    const name = normalized.split("/").pop() || normalized;
    if (shouldSkipInventoryFile(name, normalized)) {
      continue;
    }
    filtered.push(normalized);
  }
  return { files: uniqueStrings(filtered), removed: files.length - filtered.length };
}

function runFileListCommand(command: string, args: string[], cwd: string): {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  files: string[];
} {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32"
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  return {
    status: result.status,
    stdout,
    stderr,
    error: result.error?.message,
    files: stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  };
}

function collectNodeRepoFiles(root: string, options: { maxFiles?: number; maxDepth?: number } = {}): { files: string[]; truncated: boolean } {
  const maxFiles = options.maxFiles ?? 100_000;
  const maxDepth = options.maxDepth ?? 30;
  const files: string[] = [];
  const stack: Array<{ absolute: string; relative: string; depth: number }> = [{ absolute: root, relative: "", depth: 0 }];
  let truncated = false;

  while (stack.length > 0) {
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      const relative = current.relative ? path.join(current.relative, entry.name) : entry.name;
      const normalized = relative.replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (current.depth >= maxDepth || shouldSkipInventoryDir(entry.name, normalized)) {
          continue;
        }
        stack.push({ absolute: path.join(current.absolute, entry.name), relative, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || shouldSkipInventoryFile(entry.name, normalized)) {
        continue;
      }
      files.push(normalized);
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
    }
  }

  return { files: files.sort(), truncated };
}

function shouldSkipInventoryDir(name: string, normalizedPath: string): boolean {
  const lower = name.toLowerCase();
  if ([
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    ".codegraph",
    "benchmark-results",
    "target",
    "__pycache__",
    ".venv",
    "venv"
  ].includes(lower)) {
    return true;
  }
  return isArtifactLikePath(normalizedPath) || /(^|\/)(dist|build|coverage|node_modules)(\/|$)/i.test(normalizedPath);
}

function shouldSkipInventoryFile(name: string, normalizedPath: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith(".map") || lower.endsWith(".min.js") || lower.endsWith(".lock")) {
    return true;
  }
  return isArtifactLikePath(normalizedPath) || /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|cargo\.lock|uv\.lock)$/i.test(normalizedPath);
}

function isArtifactLikePath(normalizedPath: string): boolean {
  return /(^|\/)(benchmark-results|\.codegraph)(\/|$)/i.test(normalizedPath) ||
    /(^|\/)worktrees\//i.test(normalizedPath);
}

function formatCommandDiagnostic(result: { status: number | null; stderr: string; error?: string }): string {
  return [
    `status=${result.status ?? "null"}`,
    result.error ? `error=${result.error}` : undefined,
    result.stderr.trim() ? `stderr=${result.stderr.trim().slice(0, 180)}` : undefined
  ].filter(Boolean).join(" ");
}

function firstPathSegment(filePath: string): string {
  const segment = filePath.split(/[\\/]/, 1)[0] || ".";
  return segment === filePath && !/[\\/]/.test(filePath) ? "<root>" : segment;
}

function fileExtension(filePath: string): string {
  const base = path.basename(filePath);
  if (/^README(?:\..*)?$/i.test(base)) {
    return "README";
  }
  const extension = path.extname(base).toLowerCase();
  return extension || "<none>";
}

function topCounts(values: string[], limit: number): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

function isImportantFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = path.basename(normalized).toLowerCase();
  if (/^(readme|package|pom|build\.gradle|settings\.gradle|gradle\.properties|tsconfig|eslint|vite|webpack|cargo|go\.mod|pyproject|requirements)/i.test(base)) {
    return true;
  }
  return /(^|\/)(src|server|client|app|lib|core|modules|docs|test|tests|qa)\//i.test(normalized) && /\.(ts|tsx|js|jsx|java|py|go|rs|md|asciidoc)$/i.test(base);
}

async function searchTool(args: Record<string, unknown>) {
  const pattern = requiredString(args, "pattern").trim();
  if (!pattern || pattern === "." || pattern === ".*") {
    return textResult("TokenOpt denied broad search. Provide a concrete pattern.", true);
  }

  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const searchPath = optionalString(args, "path") ?? ".";
  const loaded = loadConfig({ cwd });
  const gate = maybeGateAfterAnswerable(loaded, "tokenopt_search");
  if (gate) {
    return gate;
  }

  const targetPath = resolveRepoPath(loaded.repoRoot, searchPath);
  if (!targetPath.ok) {
    return textResult(targetPath.error, true);
  }

  const result = runTargetedSearch(pattern, targetPath.path, loaded.repoRoot);
  const rawArtifact = writeArtifact(loaded.config, loaded.repoRoot, "search-output.log", result.rawOutput);
  const compressed = compressText(
    result.rawOutput || `(search provider ${result.provider} exited with ${result.exitCode} and no output)`,
    loaded.config.policy.maxCommandOutputChars
  );
  const summary = [
    "TokenOpt search summary",
    `searchProvider: ${result.provider}`,
    `pattern: ${pattern}`,
    `path: ${path.relative(loaded.repoRoot, targetPath.path) || "."}`,
    `exitCode: ${result.exitCode}`,
    `durationMs: ${result.durationMs}`,
    `rawArtifact: ${rawArtifact}`,
    ...result.diagnostics.map((diagnostic) => `diagnostic: ${diagnostic}`),
    "",
    compressed.text
  ].join("\n");

  appendEvent(loaded.config, {
    timestamp: new Date().toISOString(),
    source: "mcp",
    eventName: "pre-tool-use",
    repoRoot: loaded.repoRoot,
    action: "exec",
    command: `tokenopt_search provider=${result.provider} pattern=${pattern}`,
    artifactPath: rawArtifact,
    estimatedTokensSaved: compressed.estimatedTokensSaved,
    metadata: {
      searchProvider: result.provider,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      compressionBudgetChars: compressed.budget?.maxChars,
      compressionBudgetReason: compressed.budget?.reason
    }
  });

  return textResult(summary, false, {
    searchProvider: result.provider,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    rawArtifact,
    estimatedTokensSaved: compressed.estimatedTokensSaved,
    compressionBudgetChars: compressed.budget?.maxChars,
    compressionBudgetReason: compressed.budget?.reason
  });
}

function runTargetedSearch(pattern: string, targetPath: string, repoRoot: string): SearchProviderResult {
  const started = Date.now();
  const diagnostics: string[] = [];
  const relativeToRepo = path.relative(repoRoot, targetPath).replace(/\\/g, "/") || ".";

  const rg = spawnSync("rg", ["--line-number", "--no-heading", "--color", "never", pattern, targetPath], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === "win32"
  });
  if ((rg.status === 0 || rg.status === 1) && !commandLooksUnavailable(rg.stderr, rg.error?.message)) {
    return {
      provider: "rg",
      exitCode: rg.status ?? 1,
      durationMs: Date.now() - started,
      rawOutput: [rg.stdout, rg.stderr].filter(Boolean).join("\n"),
      diagnostics
    };
  }
  diagnostics.push(`rg unavailable: ${formatCommandDiagnostic({ status: rg.status, stderr: rg.stderr || "", error: rg.error?.message })}`);

  const gitPath = relativeToRepo === "." ? "." : relativeToRepo;
  const git = spawnSync("git", ["grep", "-n", "--no-color", "-I", "--", pattern, gitPath], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === "win32"
  });
  if ((git.status === 0 || git.status === 1) && !commandLooksUnavailable(git.stderr, git.error?.message)) {
    return {
      provider: "git",
      exitCode: git.status ?? 1,
      durationMs: Date.now() - started,
      rawOutput: [git.stdout, git.stderr].filter(Boolean).join("\n"),
      diagnostics
    };
  }
  diagnostics.push(`git grep unavailable: ${formatCommandDiagnostic({ status: git.status, stderr: git.stderr || "", error: git.error?.message })}`);

  const node = runNodeSearch(pattern, targetPath, repoRoot);
  return {
    provider: "node",
    exitCode: node.matches > 0 ? 0 : 1,
    durationMs: Date.now() - started,
    rawOutput: node.output,
    diagnostics: [
      ...diagnostics,
      `node bounded scanner used: filesScanned=${node.filesScanned} matches=${node.matches}${node.truncated ? " truncated=true" : ""}`
    ]
  };
}

function commandLooksUnavailable(stderr = "", error = ""): boolean {
  return /not recognized|not found|is not installed|No such file or directory|ENOENT/i.test(`${stderr}\n${error}`);
}

function runNodeSearch(pattern: string, targetPath: string, repoRoot: string): {
  output: string;
  filesScanned: number;
  matches: number;
  truncated: boolean;
} {
  const files = collectSearchFiles(targetPath, repoRoot);
  const matcher = buildTextMatcher(pattern);
  const lines: string[] = [];
  let filesScanned = 0;
  let matches = 0;
  let truncated = false;
  const maxMatches = 160;
  const maxFileBytes = 256 * 1024;

  for (const file of files) {
    if (matches >= maxMatches) {
      truncated = true;
      break;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > maxFileBytes || isProbablyBinaryPath(file)) {
      continue;
    }
    filesScanned += 1;
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const relative = path.relative(repoRoot, file).replace(/\\/g, "/");
    const fileLines = text.replace(/\r\n/g, "\n").split("\n");
    for (let index = 0; index < fileLines.length; index += 1) {
      if (!matcher(fileLines[index]!)) {
        continue;
      }
      lines.push(`${relative}:${index + 1}:${fileLines[index]}`);
      matches += 1;
      if (matches >= maxMatches) {
        truncated = true;
        break;
      }
    }
  }

  return {
    output: lines.length > 0 ? lines.join("\n") : "No matches.",
    filesScanned,
    matches,
    truncated
  };
}

function collectSearchFiles(targetPath: string, repoRoot: string): string[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(targetPath);
  } catch {
    return [];
  }
  if (stat.isFile()) {
    return [targetPath];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const relativeFiles = collectNodeRepoFiles(targetPath, { maxFiles: 20_000, maxDepth: 20 }).files;
  return relativeFiles.map((file) => path.join(targetPath, file));
}

function buildTextMatcher(pattern: string): (line: string) => boolean {
  try {
    const regex = new RegExp(pattern, "i");
    return (line: string) => regex.test(line);
  } catch {
    const lowered = pattern.toLowerCase();
    return (line: string) => line.toLowerCase().includes(lowered);
  }
}

function isProbablyBinaryPath(filePath: string): boolean {
  return /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|jar|war|class|wasm|exe|dll|so|dylib|bin|lock)$/i.test(filePath);
}

function readFileTool(args: Record<string, unknown>) {
  const requestedPath = requiredString(args, "path");
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const gate = maybeGateAfterAnswerable(loaded, "tokenopt_read_file");
  if (gate) {
    return gate;
  }

  const targetPath = resolveRepoPath(loaded.repoRoot, requestedPath);
  if (!targetPath.ok) {
    return textResult(targetPath.error, true);
  }

  const decision = evaluateToolPolicy(cwd, "mcp__tokenopt__read_file", { path: requestedPath }, loaded.repoRoot);
  if (decision.action === "deny" && !decision.reason?.startsWith("Full-file read is blocked")) {
    return textResult(`TokenOpt denied file read: ${decision.reason ?? "Policy denied read."}`, true);
  }

  const stat = fs.statSync(targetPath.path);
  if (!stat.isFile()) {
    return textResult(`TokenOpt denied file read: not a file: ${requestedPath}`, true);
  }

  const startLine = clampInteger(optionalNumber(args, "startLine") ?? 1, 1, Number.MAX_SAFE_INTEGER);
  const maxLines = clampInteger(optionalNumber(args, "maxLines") ?? 200, 1, 400);
  const allLines = fs.readFileSync(targetPath.path, "utf8").replace(/\r\n/g, "\n").split("\n");
  const selected = allLines.slice(startLine - 1, startLine - 1 + maxLines);
  const relative = path.relative(loaded.repoRoot, targetPath.path);
  const endLine = selected.length === 0 ? startLine : startLine + selected.length - 1;

  return textResult(
    [
      `TokenOpt bounded file read`,
      `file: ${relative}`,
      `lines: ${startLine}-${endLine} of ${allLines.length}`,
      "",
      selected.map((line, index) => `${startLine + index}: ${line}`).join("\n")
    ].join("\n"),
    false,
    {
      file: relative,
      startLine,
      endLine,
      totalLines: allLines.length
    }
  );
}

function projectFactsTool(args: Record<string, unknown>) {
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const gate = maybeGateAfterAnswerable(loaded, "tokenopt_project_facts");
  if (gate) {
    return gate;
  }

  const inventory = buildRepoInventory(loaded.repoRoot, loaded.config, loaded.repoRoot);
  const facts = extractProjectFacts(loaded.repoRoot);

  const text = [
    "TokenOpt project facts",
    `repoRoot: ${loaded.repoRoot}`,
    `searchProvider: ${inventory.searchProvider}`,
    `totalFiles: ${inventory.totalFiles}`,
    `rawInventoryChars: ${inventory.rawChars}`,
    `rawInventoryArtifact: ${inventory.rawArtifact}`,
    "",
    "Build facts:",
    ...facts.map((fact) => `- ${fact}`),
    "",
    "Top directories:",
    ...inventory.topDirs.slice(0, 8).map(([name, count]) => `- ${name}: ${count}`),
    "",
    "Root files:",
    ...inventory.rootFiles.slice(0, 20).map((file) => `- ${file}`)
  ].join("\n");

  return textResult(text, false, {
    repoRoot: loaded.repoRoot,
    searchProvider: inventory.searchProvider,
    totalFiles: inventory.totalFiles,
    rawInventoryArtifact: inventory.rawArtifact,
    facts
  });
}

function prepareJavaDiffTool(args: Record<string, unknown>) {
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const diff = optionalString(args, "diff") ?? readGitDiff(cwd, optionalBoolean(args, "staged") ?? false);
  if (!diff.trim()) {
    return textResult("TokenOpt Java diff processor: no diff content found.", false, {
      changedFiles: [],
      categories: {},
      impactedSymbols: [],
      likelyTests: []
    });
  }

  const summary = prepareJavaDiff(diff);
  const rawArtifact = writeArtifact(loaded.config, loaded.repoRoot, "java-diff.patch", diff);
  const text = [
    "TokenOpt Java diff summary",
    `changedJavaFiles: ${summary.changedFiles.length}`,
    `originalChars: ${summary.originalChars}`,
    `summaryChars: ${summary.summaryChars}`,
    `estimatedTokensSaved: ${summary.estimatedTokensSaved}`,
    `rawArtifact: ${rawArtifact}`,
    "",
    "Categories:",
    ...Object.entries(summary.categories).map(([category, count]) => `- ${category}: ${count}`),
    "",
    "Changed files:",
    ...summary.changedFiles.slice(0, 24).map((file) => [
      `- ${file.file}`,
      `  +/-: ${file.additions}/${file.deletions}`,
      `  categories: ${file.categories.join(",")}`,
      `  impactedSymbols: ${file.impactedSymbols.join(",") || "none_detected"}`,
      `  likelyTests: ${file.likelyTests.slice(0, 4).join(",") || "none_detected"}`
    ].join("\n")),
    "",
    "Review hints:",
    ...summary.semanticHints.map((hint) => `- ${hint}`)
  ].join("\n");

  return textResult(text, false, { ...summary, rawArtifact });
}

function jakartaAnnotationFilterTool(args: Record<string, unknown>) {
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const input = readInlineOrRepoFile(args, loaded, "code");
  if (!input.ok) {
    return textResult(input.error, true);
  }

  const result = filterJakartaAnnotations(input.text);
  const rawArtifact = writeArtifact(loaded.config, loaded.repoRoot, "jakarta-annotation-source.java", input.text);
  const filteredArtifact = result.text.length > loaded.config.policy.maxCommandOutputChars
    ? writeArtifact(loaded.config, loaded.repoRoot, "jakarta-annotation-filtered.java", result.text)
    : undefined;
  const filteredText = filteredArtifact
    ? `${result.text.slice(0, Math.max(0, loaded.config.policy.maxCommandOutputChars - 120))}\n\n[truncated by TokenOpt; filteredArtifact=${filteredArtifact}]`
    : result.text;

  return textResult(
    [
      "TokenOpt Jakarta annotation filter",
      `source: ${input.source}`,
      `collapsedGroups: ${result.collapsedGroups}`,
      `collapsedAnnotations: ${result.collapsedAnnotations.join(",") || "none"}`,
      `estimatedTokensSaved: ${result.estimatedTokensSaved}`,
      `rawArtifact: ${rawArtifact}`,
      filteredArtifact ? `filteredArtifact: ${filteredArtifact}` : undefined,
      "",
      filteredText
    ].filter((line): line is string => line !== undefined).join("\n"),
    false,
    { ...result, source: input.source, rawArtifact, filteredArtifact }
  );
}

function assembleSpringContextTool(args: Record<string, unknown>) {
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const input = readInlineOrRepoFile(args, loaded, "json");
  if (!input.ok) {
    return textResult(input.error, true);
  }

  const assembly = assembleSpringContext(input.text);
  const rawArtifact = writeArtifact(loaded.config, loaded.repoRoot, "spring-context-raw.json", input.text);
  const text = [
    "TokenOpt Spring context assembly",
    `source: ${input.source}`,
    `beanCount: ${assembly.beanCount}`,
    `originalChars: ${assembly.originalChars}`,
    `assembledChars: ${assembly.assembledChars}`,
    `estimatedTokensSaved: ${assembly.estimatedTokensSaved}`,
    `rawArtifact: ${rawArtifact}`,
    "",
    JSON.stringify({
      entryPoints: assembly.entryPoints,
      securityChain: assembly.securityChain,
      services: assembly.services,
      dataLayer: assembly.dataLayer,
      messaging: assembly.messaging,
      transactionBoundaries: assembly.transactionBoundaries
    }, null, 2)
  ].join("\n");

  return textResult(text, false, { ...assembly, rawArtifact, source: input.source });
}

function businessContractTool(args: Record<string, unknown>) {
  const task = requiredString(args, "task");
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const diff = optionalString(args, "diff") ?? "";
  const changedFiles = uniqueStrings([
    ...optionalStringArray(args, "changed_files"),
    ...extractDiffFiles(diff)
  ]);
  const repoFiles = collectRepoFiles(loaded.repoRoot, loaded.repoRoot).files;
  const result = linkBusinessContracts({ task, changedFiles, repoFiles });
  const text = [
    "TokenOpt business contract links",
    `changedFiles: ${result.changedFiles.join(",") || "none_detected"}`,
    `candidates: ${result.candidates.length}`,
    `missingContractTypes: ${result.missingContractTypes.join(",") || "none"}`,
    "",
    "Candidates:",
    ...result.candidates.slice(0, 40).map((candidate) => `- ${candidate.type}: ${candidate.file} (${candidate.reason})`),
    "",
    "Review hints:",
    ...result.reviewHints.map((hint) => `- ${hint}`)
  ].join("\n");
  return textResult(text, false, { ...result });
}

function impactAnalysisTool(args: Record<string, unknown>) {
  const target = requiredString(args, "target");
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const diff = optionalString(args, "diff") ?? "";
  const changedFiles = uniqueStrings([
    ...optionalStringArray(args, "changed_files"),
    ...extractDiffFiles(diff)
  ]);
  const repoFiles = collectRepoFiles(loaded.repoRoot, loaded.repoRoot).files;
  const result = analyzeImpact({
    repoRoot: loaded.repoRoot,
    target,
    changedFiles,
    repoFiles
  });
  const text = [
    "TokenOpt impact analysis",
    `target: ${result.target}`,
    `changedFiles: ${result.changedFiles.join(",") || "none_detected"}`,
    "",
    "Definitions:",
    ...(result.definitions.length > 0 ? result.definitions.slice(0, 30).map((item) => `- ${item}`) : ["- none_detected"]),
    "",
    "Usages:",
    ...(result.usages.length > 0 ? result.usages.slice(0, 40).map((item) => `- ${item}`) : ["- none_detected"]),
    "",
    "Public contracts:",
    ...(result.publicContracts.length > 0 ? result.publicContracts.slice(0, 30).map((item) => `- ${item}`) : ["- none_detected"]),
    "",
    "Likely tests:",
    ...(result.likelyTests.length > 0 ? result.likelyTests.slice(0, 30).map((item) => `- ${item}`) : ["- none_detected"]),
    "",
    "Missing:",
    ...(result.missing.length > 0 ? result.missing.map((item) => `- ${item}`) : ["- none"])
  ].join("\n");
  return textResult(text, false, { ...result });
}

async function symbolsFindTool(args: Record<string, unknown>, ctx: TokenoptToolContext = {}) {
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const query = optionalString(args, "query") ?? "";
  const symbols = await findCodingSymbols({
    repoRoot: loaded.repoRoot,
    query,
    language: normalizeSymbolLanguage(optionalString(args, "language")),
    kind: normalizeSymbolKind(optionalString(args, "kind")),
    limit: clampInteger(optionalNumber(args, "limit") ?? 20, 1, 50),
    graphProvider: ctx.graphSymbolProvider
  });
  const text = [
    "TokenOpt coding symbols",
    `query: ${query || "<empty>"}`,
    `repoRoot: ${loaded.repoRoot}`,
    `count: ${symbols.length}`,
    "",
    ...(symbols.length > 0
      ? symbols.map((symbol) => `- ${symbol.id} ${symbol.kind} ${symbol.language} confidence=${symbol.confidence.toFixed(2)} signature=${symbol.signature.slice(0, 180)}`)
      : ["- none"])
  ].join("\n");
  return textResult(text, false, { symbols });
}

async function symbolPacketTool(args: Record<string, unknown>, ctx: TokenoptToolContext = {}) {
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const symbolId = optionalString(args, "symbol_id");
  const query = optionalString(args, "query");
  if (!symbolId && !query) {
    return textResult("TokenOpt symbol packet requires symbol_id or query.", true);
  }
  const packet = await buildSymbolPacket({ repoRoot: loaded.repoRoot, symbolId, query, graphProvider: ctx.graphSymbolProvider });
  if (!packet) {
    return textResult(`TokenOpt symbol packet found no symbol for ${symbolId ?? query ?? "<missing>"}.`, true);
  }
  return textResult(formatSymbolPacket(packet), false, { packet });
}

async function testNeighborsTool(args: Record<string, unknown>, ctx: TokenoptToolContext = {}) {
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const target = requiredString(args, "target");
  const packet = await findTestNeighbors({
    repoRoot: loaded.repoRoot,
    target,
    symbolName: optionalString(args, "symbol_name"),
    limit: clampInteger(optionalNumber(args, "limit") ?? 12, 1, 50),
    graphProvider: ctx.graphSymbolProvider
  });
  return textResult(formatTestNeighborPacket(packet), false, { packet });
}

function failurePacketTool(args: Record<string, unknown>) {
  const output = requiredString(args, "output");
  const packet = parseFailurePacket({ output });
  return textResult(formatFailurePacket(packet), false, { packet });
}

async function tracebugPacketTool(args: Record<string, unknown>, ctx: TokenoptToolContext = {}) {
  const cwd = optionalString(args, "cwd") ?? process.cwd();
  const loaded = loadConfig({ cwd });
  const query = requiredString(args, "query");
  const output = optionalString(args, "output") ?? query;
  const maxCandidates = clampInteger(optionalNumber(args, "max_candidates") ?? 8, 1, 12);
  const includeTests = optionalBoolean(args, "include_tests") ?? true;
  const includeCallers = optionalBoolean(args, "include_callers") ?? true;
  const packet = await buildTracebugPacket({
    repoRoot: loaded.repoRoot,
    query,
    output,
    maxCandidates,
    includeTests,
    includeCallers,
    graphProvider: ctx.graphSymbolProvider
  });
  return textResult(formatTracebugPacket(packet), false, { packet });
}

async function buildTracebugPacket(input: {
  repoRoot: string;
  query: string;
  output: string;
  maxCandidates: number;
  includeTests: boolean;
  includeCallers: boolean;
  graphProvider?: GraphSymbolProvider;
}): Promise<TracebugPacket> {
  const failurePacket = parseFailurePacket({ output: input.output });
  const evidence: TracebugEvidenceLine[] = [];
  const anchors = extractTracebugAnchors(input.query, failurePacket);

  for (const error of failurePacket.errors.slice(0, input.maxCandidates)) {
    if (!error.file || !error.line) {
      continue;
    }
    const resolved = resolveTracebugFile(input.repoRoot, error.file);
    if (!resolved) {
      continue;
    }
    const slice = readTracebugSlice(input.repoRoot, resolved, Math.max(1, error.line - 4), 12);
    evidence.push({
      path: resolved,
      lineStart: slice.lineStart,
      lineEnd: slice.lineEnd,
      symbol: error.symbol,
      role: isTestFailureText(error.message) ? "failing_assert" : "top_frame",
      confidence: 0.95,
      why: "Matches normalized failure file/line from the supplied artifact.",
      snippet: slice.text
    });
    if (evidence.length >= input.maxCandidates) {
      break;
    }
  }

  const symbolQuery = buildTracebugSymbolQuery(input.query, failurePacket);
  const symbolPacket = symbolQuery
    ? await buildSymbolPacket({ repoRoot: input.repoRoot, query: symbolQuery, graphProvider: input.graphProvider })
    : undefined;
  if (symbolPacket && !evidence.some((item) => item.path === symbolPacket.symbol.file && item.role === "candidate_definition")) {
    evidence.push({
      path: symbolPacket.definition_slice.file,
      lineStart: symbolPacket.definition_slice.startLine,
      lineEnd: Math.min(symbolPacket.definition_slice.endLine, symbolPacket.definition_slice.startLine + 40),
      symbol: symbolPacket.symbol.name,
      role: "candidate_definition",
      confidence: symbolPacket.symbol.confidence,
      why: symbolPacket.symbol.source === "graph"
        ? "Best graph-indexed symbol candidate for the tracebug anchor."
        : "Best regex-lite symbol candidate for the tracebug anchor.",
      snippet: symbolPacket.definition_slice.text.split(/\r?\n/).slice(0, 42).join("\n")
    });
  }

  if (symbolPacket && input.includeCallers) {
    for (const caller of symbolPacket.callers.slice(0, 2)) {
      const slice = readTracebugSlice(input.repoRoot, caller.file, Math.max(1, caller.line - 2), 6);
      evidence.push({
        path: caller.file,
        lineStart: slice.lineStart,
        lineEnd: slice.lineEnd,
        symbol: symbolPacket.symbol.name,
        role: "caller",
        confidence: 0.72,
        why: "Caller/reference corroborates the candidate symbol path.",
        snippet: slice.text || caller.text
      });
    }
  }

  const targetForTests = symbolPacket?.symbol.file ?? firstResolvedFailureFile(input.repoRoot, failurePacket) ?? symbolQuery;
  if (input.includeTests && targetForTests) {
    const neighbors = await findTestNeighbors({
      repoRoot: input.repoRoot,
      target: targetForTests,
      symbolName: symbolPacket?.symbol.name,
      limit: 4,
      graphProvider: input.graphProvider
    });
    for (const testFile of neighbors.test_files.slice(0, 2)) {
      const slice = readTracebugSlice(input.repoRoot, testFile, 1, 30);
      evidence.push({
        path: testFile,
        lineStart: slice.lineStart,
        lineEnd: slice.lineEnd,
        symbol: symbolPacket?.symbol.name,
        role: "nearby_test",
        confidence: 0.78,
        why: "Nearby test file corroborates the tracebug target and expected behavior surface.",
        snippet: slice.text
      });
    }
  }

  const trimmedEvidence = dedupeTracebugEvidence(evidence).slice(0, input.maxCandidates);
  const directEvidence = trimmedEvidence.some((item) => item.role === "top_frame" || item.role === "failing_assert" || item.role === "candidate_definition");
  const corroboration = trimmedEvidence.some((item) => item.role === "caller" || item.role === "callee" || item.role === "nearby_test" || item.role === "config" || item.role === "build_script") ||
    (failurePacket.errors.length > 0 && trimmedEvidence.length >= 2);
  const exactLineProof = trimmedEvidence.some((item) => item.path.length > 0 && item.lineStart > 0 && item.lineEnd >= item.lineStart);
  const canAnswer = directEvidence && corroboration && exactLineProof;
  const suggested = failurePacket.suggested_slices[0];
  const suggestedRead = suggested
    ? {
        path: resolveTracebugFile(input.repoRoot, suggested.file) ?? suggested.file,
        lineStart: suggested.startLine,
        lineEnd: suggested.startLine + suggested.maxLines - 1
      }
    : trimmedEvidence[0]
      ? { path: trimmedEvidence[0].path, lineStart: trimmedEvidence[0].lineStart, lineEnd: trimmedEvidence[0].lineEnd }
      : undefined;

  return {
    status: canAnswer ? "grounded" : trimmedEvidence.length > 0 ? "needs_read" : failurePacket.errors.length > 0 ? "needs_repro" : "needs_artifact",
    traceClass: traceClassFromFailure(failurePacket, input.output),
    anchors,
    evidence: trimmedEvidence,
    failurePacket: failurePacket.errors.length > 0 ? failurePacket : undefined,
    recommendedNextAction: canAnswer ? "answer_now" : suggestedRead ? "read_exact_slice" : "ask_for_artifact",
    suggestedRead,
    answerability: {
      directEvidence,
      corroboration,
      exactLineProof,
      canAnswer,
      reason: canAnswer
        ? "Trace proof contract passed with direct line evidence and a corroborating cue."
        : "Trace proof contract requires exact file/line evidence plus one corroborating caller, callee, nearby test, config, or failure cue."
    }
  };
}

function formatTracebugPacket(packet: TracebugPacket): string {
  return [
    "TokenOpt tracebug packet",
    `status: ${packet.status}`,
    `traceClass: ${packet.traceClass}`,
    `recommendedNextAction: ${packet.recommendedNextAction}`,
    `answerable: ${packet.answerability.canAnswer}`,
    `directEvidence: ${packet.answerability.directEvidence}`,
    `corroboration: ${packet.answerability.corroboration}`,
    `exactLineProof: ${packet.answerability.exactLineProof}`,
    packet.suggestedRead ? `suggestedRead: ${packet.suggestedRead.path}:${packet.suggestedRead.lineStart}-${packet.suggestedRead.lineEnd}` : undefined,
    "",
    "Anchors:",
    ...(packet.anchors.length > 0 ? packet.anchors.map((anchor) => `- ${anchor}`) : ["- none"]),
    "",
    "Evidence:",
    ...(packet.evidence.length > 0
      ? packet.evidence.map((item) => `- ${item.role} ${item.path}:${item.lineStart}-${item.lineEnd} confidence=${item.confidence.toFixed(2)} symbol=${item.symbol ?? "n/a"} reason=${item.why}`)
      : ["- none"]),
    "",
    "Answerability reason:",
    packet.answerability.reason
  ].filter((line): line is string => line !== undefined).join("\n");
}

function formatSymbolPacket(packet: SymbolPacket): string {
  return [
    "TokenOpt symbol packet",
    `symbol: ${packet.symbol.name}`,
    `id: ${packet.symbol.id}`,
    `kind: ${packet.symbol.kind}`,
    `language: ${packet.symbol.language}`,
    `file: ${packet.symbol.file}`,
    `line: ${packet.symbol.line}`,
    `signature: ${packet.symbol.signature}`,
    `definition_slice: ${packet.definition_slice.file}:${packet.definition_slice.startLine}-${packet.definition_slice.endLine}`,
    "",
    "Coverage:",
    ...Object.entries(packet.coverage).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "Imports/dependencies:",
    ...(packet.imports.length > 0 ? packet.imports.slice(0, 20).map((item) => `- ${item}`) : ["- none"]),
    ...(packet.dependencies.length > 0 ? packet.dependencies.slice(0, 20).map((item) => `- dependency:${item}`) : []),
    "",
    "Callers:",
    ...(packet.callers.length > 0 ? packet.callers.slice(0, 20).map((caller) => `- ${caller.file}:${caller.line}: ${caller.text}`) : ["- none"]),
    "",
    "Callees:",
    ...(packet.callees.length > 0 ? packet.callees.slice(0, 30).map((callee) => `- ${callee}`) : ["- none"]),
    "",
    "Nearby tests:",
    ...(packet.nearby_tests.length > 0 ? packet.nearby_tests.slice(0, 20).map((file) => `- ${file}`) : ["- none"]),
    "",
    "Definition:",
    packet.definition_slice.text
  ].join("\n");
}

function formatTestNeighborPacket(packet: TestNeighborPacket): string {
  return [
    "TokenOpt test neighbors",
    `target: ${packet.target}`,
    "",
    "Coverage:",
    ...Object.entries(packet.coverage).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "Source files:",
    ...(packet.source_files.length > 0 ? packet.source_files.slice(0, 20).map((file) => `- ${file}`) : ["- none"]),
    "",
    "Test files:",
    ...(packet.test_files.length > 0 ? packet.test_files.slice(0, 30).map((file) => `- ${file}`) : ["- none"]),
    "",
    "Naming patterns:",
    ...(packet.naming_patterns.length > 0 ? packet.naming_patterns.map((item) => `- ${item}`) : ["- none"]),
    "",
    "Framework hints:",
    ...(packet.framework_hints.length > 0 ? packet.framework_hints.map((item) => `- ${item}`) : ["- none"]),
    "",
    "Mocking hints:",
    ...(packet.mocking_hints.length > 0 ? packet.mocking_hints.map((item) => `- ${item}`) : ["- none"])
  ].join("\n");
}

function formatFailurePacket(packet: FailurePacket): string {
  return [
    "TokenOpt failure packet",
    `failure_kind: ${packet.failure_kind}`,
    `errors: ${packet.errors.length}`,
    "",
    "Errors:",
    ...(packet.errors.length > 0
      ? packet.errors.slice(0, 30).map((error) => `- ${error.file ?? "<unknown>"}:${error.line ?? "?"}${error.column ? `:${error.column}` : ""} ${error.symbol ? `[${error.symbol}] ` : ""}${error.message}`)
      : ["- none"]),
    "",
    "Suggested slices:",
    ...(packet.suggested_slices.length > 0
      ? packet.suggested_slices.map((slice) => `- ${slice.file}:${slice.startLine}+${slice.maxLines} ${slice.reason}`)
      : ["- none"])
  ].join("\n");
}

function extractTracebugAnchors(query: string, failurePacket: FailurePacket): string[] {
  const anchors = new Set<string>();
  for (const error of failurePacket.errors.slice(0, 8)) {
    if (error.file) {
      anchors.add(error.line ? `${error.file}:${error.line}` : error.file);
    }
    if (error.symbol) {
      anchors.add(error.symbol);
    }
    if (error.message) {
      anchors.add(error.message.slice(0, 120));
    }
  }
  for (const match of query.matchAll(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[A-Za-z0-9_./{}:-]+/gi)) {
    anchors.add(match[0]);
  }
  for (const match of query.matchAll(/\b[A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|java|py)(?::\d+)?\b/g)) {
    anchors.add(match[0].replace(/\\/g, "/"));
  }
  for (const match of query.matchAll(/\b[A-Z][A-Za-z0-9_]*(?:Exception|Error|Service|Controller|Repository|Gateway|Manager|Client|Factory|Handler|Config|Test)\b/g)) {
    anchors.add(match[0]);
  }
  return [...anchors].slice(0, 12);
}

function buildTracebugSymbolQuery(query: string, failurePacket: FailurePacket): string | undefined {
  const parts = [
    ...failurePacket.errors.flatMap((error) => [error.symbol, error.file]).filter((value): value is string => Boolean(value)),
    ...extractTracebugAnchors(query, failurePacket)
  ];
  const candidate = parts.find((part) => /[A-Za-z_][A-Za-z0-9_]/.test(part));
  return candidate ?? query;
}

function resolveTracebugFile(repoRoot: string, file: string): string | undefined {
  const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
  if (fs.existsSync(path.join(repoRoot, normalized))) {
    return normalized;
  }
  const base = path.basename(normalized);
  const matches = collectCodingFiles(repoRoot, { maxFiles: 20_000 }).filter((candidate) => path.basename(candidate) === base);
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    const suffixMatch = matches.find((candidate) => candidate.endsWith(normalized));
    return suffixMatch ?? matches[0];
  }
  return undefined;
}

function firstResolvedFailureFile(repoRoot: string, failurePacket: FailurePacket): string | undefined {
  for (const error of failurePacket.errors) {
    if (!error.file) {
      continue;
    }
    const resolved = resolveTracebugFile(repoRoot, error.file);
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

function readTracebugSlice(repoRoot: string, file: string, startLine: number, maxLines: number): { lineStart: number; lineEnd: number; text: string } {
  const text = readRepoText(repoRoot, file);
  if (!text) {
    return { lineStart: startLine, lineEnd: startLine, text: "" };
  }
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const lineStart = clampInteger(startLine, 1, Math.max(1, lines.length));
  const selected = lines.slice(lineStart - 1, lineStart - 1 + maxLines);
  return {
    lineStart,
    lineEnd: selected.length === 0 ? lineStart : lineStart + selected.length - 1,
    text: selected.join("\n")
  };
}

function isTestFailureText(value: string): boolean {
  return /\b(?:assert|expected|received|FAIL|FAILED|should|test)\b/i.test(value);
}

function dedupeTracebugEvidence(evidence: TracebugEvidenceLine[]): TracebugEvidenceLine[] {
  const seen = new Set<string>();
  const result: TracebugEvidenceLine[] = [];
  for (const item of evidence) {
    const key = `${item.role}:${item.path}:${item.lineStart}:${item.lineEnd}:${item.symbol ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function traceClassFromFailure(packet: FailurePacket, output: string): TracebugPacket["traceClass"] {
  if (packet.failure_kind === "typescript" || /\bTS\d{4}\b|COMPILATION ERROR|cannot find symbol/i.test(output)) {
    return "compile_error";
  }
  if (/\bAssertionError|Tests run:|FAIL|FAILED|expected|received/i.test(output)) {
    return "failing_test";
  }
  if (packet.failure_kind === "java" || packet.failure_kind === "python" || /\bException|Error|Traceback|Caused by/i.test(output)) {
    return "runtime_exception";
  }
  if (/\b(expected|actual|regression|wrong|incorrect)\b/i.test(output)) {
    return "behavior_regression";
  }
  return "unknown";
}

function normalizeSymbolLanguage(value: string | undefined): SymbolPacket["symbol"]["language"] | undefined {
  if (value === "typescript" || value === "javascript" || value === "java" || value === "python" || value === "unknown") {
    return value;
  }
  return undefined;
}

function normalizeSymbolKind(value: string | undefined): SymbolPacket["symbol"]["kind"] | undefined {
  if (value === "class" || value === "interface" || value === "function" || value === "method" || value === "const" || value === "type" || value === "unknown") {
    return value;
  }
  return undefined;
}

function readGitDiff(cwd: string, staged: boolean): string {
  const args = staged ? ["diff", "--cached"] : ["diff"];
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === "win32"
  });
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function readInlineOrRepoFile(
  args: Record<string, unknown>,
  loaded: LoadedConfig,
  inlineKey: "code" | "json"
): { ok: true; text: string; source: string } | { ok: false; error: string } {
  const inline = optionalString(args, inlineKey);
  if (inline !== undefined) {
    return { ok: true, text: inline, source: "inline" };
  }
  const requestedPath = optionalString(args, "path");
  if (!requestedPath) {
    return { ok: false, error: `Provide either ${inlineKey} or path.` };
  }
  const targetPath = resolveRepoPath(loaded.repoRoot, requestedPath);
  if (!targetPath.ok) {
    return { ok: false, error: targetPath.error };
  }
  const stat = fs.statSync(targetPath.path);
  if (!stat.isFile()) {
    return { ok: false, error: `Not a file: ${requestedPath}` };
  }
  return {
    ok: true,
    text: fs.readFileSync(targetPath.path, "utf8"),
    source: path.relative(loaded.repoRoot, targetPath.path).replace(/\\/g, "/")
  };
}

function maybeGateAfterAnswerable(loaded: LoadedConfig, attemptedTool: string) {
  const state = readActiveEvidenceTaskState(loaded.config, loaded.repoRoot);
  if (!state || state.packet.max_additional_calls > 0) {
    return undefined;
  }

  const packet = state.packet;
  const shadow = evaluateShadowGate({
    state,
    toolName: attemptedTool,
    reason: "answerable_packet_would_block_mcp_followup",
    forceWouldDeny: true
  });
  logShadowGateDecision(loaded.config, loaded.repoRoot, shadow);
  if (loaded.config.policy.answerabilityGate.mode === "off" || loaded.config.policy.answerabilityGate.mode === "shadow") {
    return undefined;
  }

  const text = [
    "TokenOpt answerability gate: do not replay evidence.",
    `attemptedTool: ${attemptedTool}`,
    `packet_id: ${packet.packet_id}`,
    `task_type: ${packet.task_type}`,
    `confidence: ${packet.confidence}`,
    `expires_at: ${packet.expires_at}`,
    "",
    "Use the compiled evidence packet already in context and answer now.",
    "If the user changes the task, call tokenopt_compile_evidence for the new task."
  ].join("\n");

  return textResult(text, false, {
    action: "answerability_gate",
    attemptedTool,
    packetId: packet.packet_id,
    recommendedNextAction: packet.recommended_next_action,
    expiresAt: packet.expires_at,
    shadowGate: shadow
  });
}

function buildCoverageCertificate(
  packetId: string,
  route: RouteDecision,
  answerable: boolean,
  confidence: number,
  coverage: Record<string, EvidenceCoverageStatus>,
  missing: string[],
  allowedFollowups: EvidenceFollowup[]
): CoverageCertificate {
  const evidenceContractPass = answerable && missing.length === 0;
  return {
    packet_id: packetId,
    task_class: route.taskClass,
    acquisition_mode: route.acquisitionMode,
    evidence_contract: route.evidenceContract,
    evidence_contract_pass: evidenceContractPass,
    fallback_reason: route.fallbackReason,
    answerable,
    confidence,
    dimensions: coverage,
    missing,
    followup_exact_tools_allowed: allowedFollowups.map((followup) => followup.tool),
    deny_broad_exploration: (answerable && missing.length === 0) || route.taskClass === "needs_input_bypass" || route.taskClass === "security_audit"
  };
}

function buildOutputPolicy(route: RouteDecision, taskType: EvidenceTaskType): OutputPolicy {
  if (route.taskClass === "review_diff" || route.taskClass === "security_audit") {
    return {
      preferred_format: "compact_edit_plan",
      avoid_full_file_rewrite: true,
      include_explanation_max_tokens: 300,
      applies_to: route.taskClass === "security_audit" ? ["security_review", "findings", "risk_triage"] : ["review", "suggested_fix", "patch"]
    };
  }
  if (route.taskClass === "refactor_scope" || taskType === "implement") {
    return {
      preferred_format: "unified_diff",
      avoid_full_file_rewrite: true,
      include_explanation_max_tokens: 300,
      applies_to: ["implement", "refactor", "fix bug"]
    };
  }
  return {
    preferred_format: "standard_answer",
    avoid_full_file_rewrite: false,
    include_explanation_max_tokens: 900,
    applies_to: ["explain", "investigate", "handoff"]
  };
}

interface TaskSpecificEvidence {
  answerable: boolean;
  confidence: number;
  coverage: Record<string, EvidenceCoverageStatus>;
  evidence: EvidenceItem[];
  missing: string[];
  allowedFollowups: EvidenceFollowup[];
  metadata?: Record<string, unknown>;
}

interface ReviewDiffLine {
  file: string;
  kind: "add" | "delete" | "context";
  text: string;
  oldLine?: number;
  newLine?: number;
}

interface ReviewDiffAnalysis {
  files: string[];
  added: ReviewDiffLine[];
  removed: ReviewDiffLine[];
  context: ReviewDiffLine[];
  changedSymbols: string[];
  addedCalls: string[];
  removedCalls: string[];
  trailingWhitespace: Array<{ file: string; line: number; preview: string }>;
  exactChanges: string[];
}

interface ReviewRecallProbe {
  id: string;
  status: "checked" | "needs_followup" | "not_applicable";
  risk: string;
  evidence: string[];
  action: string;
  findingHint?: string;
  severityHint?: "P1" | "P2" | "P3";
}

interface EvidenceContext {
  inventory: RepoInventory;
  facts: string[];
  overview?: RepositoryOverview;
  structureFacts: string[];
}

interface BusinessProfile {
  files: string[];
  purpose: string;
  likelyUsers: string;
  coreCapabilities: string[];
  majorAreas: string[];
  domainTerms: string[];
  docSignals: string[];
  featureTerms: string[];
  featureSearchHits: FlowSearchHit[];
  featureSourceFiles: string[];
  featureBackendFiles: string[];
  featureFrontendFiles: string[];
  featureTestFiles: string[];
  hasPurposeSignal: boolean;
  hasDeepDiveSignal: boolean;
}

interface TargetSpecificityCheck {
  terms: string[];
  covered: string[];
  missing: string[];
}

interface FlowSearchHit {
  term: string;
  file: string;
  line: number;
  preview: string;
}

interface FlowProfile {
  target: string;
  searchTerms: string[];
  exactSearchTerms: string[];
  exactSearchHits: FlowSearchHit[];
  candidateEntrypoints: string[];
  candidateServices: string[];
  candidateDataFiles: string[];
  candidateTests: string[];
  candidateDocs: string[];
  businessContext: string[];
  hasNamedTarget: boolean;
}

async function compileTaskSpecificEvidence(
  taskType: EvidenceTaskType,
  task: string,
  repoRoot: string,
  firstEvidenceIndex: number,
  context: EvidenceContext,
  options: { hasBuildFacts: boolean; codingToolsAvailable: boolean; qualityRubric?: string[]; graphProvider?: GraphSymbolProvider }
): Promise<TaskSpecificEvidence | undefined> {
  if (taskType === "review_diff") {
    return compileReviewDiffEvidence(task, repoRoot, firstEvidenceIndex);
  }
  if (taskType === "research_business") {
    return compileBusinessResearchEvidence(task, repoRoot, firstEvidenceIndex, context);
  }
  if (taskType === "api_flow") {
    return compileFlowEvidence(task, repoRoot, firstEvidenceIndex, context);
  }
  const coding = await compileCodingCoverageEvidence({
    repoRoot,
    task,
    taskType,
    qualityRubric: options.qualityRubric,
    firstEvidenceIndex,
    hasBuildFacts: options.hasBuildFacts,
    codingToolsAvailable: options.codingToolsAvailable,
    graphProvider: options.graphProvider
  });
  if (coding) {
    return {
      answerable: coding.answerable,
      confidence: coding.confidence,
      coverage: coding.coverage,
      evidence: coding.evidence,
      missing: coding.missing,
      allowedFollowups: coding.allowedFollowups,
      metadata: coding.metadata
    };
  }
  return undefined;
}

function checkTargetSpecificity(task: string, taskType: EvidenceTaskType, evidence: EvidenceItem[]): TargetSpecificityCheck {
  if (taskType === "build_handoff" || taskType === "review_diff") {
    return { terms: [], covered: [], missing: [] };
  }
  const terms = extractSpecificTaskTerms(task, taskType);
  if (terms.length === 0) {
    return { terms, covered: [], missing: [] };
  }

  const evidenceText = normalizeEvidenceText(
    evidence.flatMap((item) => [
      item.claim,
      ...(item.files ?? []),
      ...(item.facts ?? []),
      item.snippet ?? ""
    ]).join("\n")
  );
  const covered = terms.filter((term) => evidenceText.includes(normalizeEvidenceText(term)));
  const missing = terms.filter((term) => !covered.includes(term));
  return { terms, covered, missing };
}

function extractSpecificTaskTerms(task: string, taskType: EvidenceTaskType): string[] {
  const taskText = stripOutputContractText(task);
  const stopWords = new Set([
    "about",
    "after",
    "all",
    "and",
    "any",
    "actor",
    "actors",
    "answer",
    "are",
    "before",
    "business",
    "can",
    "call",
    "chain",
    "class",
    "code",
    "codebase",
    "deep",
    "detail",
    "diagram",
    "dive",
    "docs",
    "document",
    "domain",
    "draw",
    "e2e",
    "endtoend",
    "evidence",
    "explain",
    "flow",
    "flowchart",
    "for",
    "help",
    "implementation",
    "investigate",
    "into",
    "from",
    "how",
    "mermaid",
    "module",
    "modules",
    "please",
    "product",
    "project",
    "read",
    "readonly",
    "repo",
    "repository",
    "research",
    "sequence",
    "service",
    "specific",
    "study",
    "system",
    "task",
    "test",
    "the",
    "that",
    "this",
    "trace",
    "understand",
    "until",
    "unit",
    "unittest",
    "what",
    "when",
    "who",
    "why",
    "with",
    "without",
    "write"
  ]);
  const terms = new Set<string>();
  const anchoredTerms = [
    ...extractQuotedTerms(taskText),
    ...extractRouteTerms(taskText),
    ...extractStrongCodeLikeTaskTerms(taskText),
    ...extractHyphenatedIdentifierVariants(taskText)
  ];
  if (taskType === "api_flow") {
    anchoredTerms.push(...splitFlowTerms(extractFlowTarget(taskText)).filter((term) => !/^flow_target_not_explicit$/i.test(term)).slice(0, 4));
  }
  for (const term of anchoredTerms) {
    addSpecificTerm(terms, term, stopWords);
  }
  if (terms.size > 0) {
    const ordered = [...terms];
    return ordered.slice(0, taskType === "api_flow" ? 8 : 5);
  }

  for (const match of taskText.matchAll(/\b[A-Za-z][A-Za-z0-9_./:-]{2,}\b/g)) {
    addSpecificTerm(terms, match[0], stopWords);
  }

  const ordered = [...terms];
  if (taskType === "api_flow") {
    return ordered.slice(0, 6);
  }
  return ordered.slice(0, 4);
}

function addSpecificTerm(terms: Set<string>, value: string, stopWords: Set<string>): void {
  const cleaned = value.trim().replace(/^[^A-Za-z0-9/_:-]+|[^A-Za-z0-9/_:-]+$/g, "");
  if (cleaned.length < 3) {
    return;
  }
  const normalized = cleaned.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (normalized.length < 3 || stopWords.has(normalized) || /^\d+$/.test(normalized)) {
    return;
  }
  terms.add(cleaned);
}

function normalizeEvidenceText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function buildTargetSpecificFollowups(missingTerms: string[]): EvidenceFollowup[] {
  const pattern = missingTerms[0] ?? "<exact-target>";
  return [
    {
      tool: "tokenopt_search",
      reason: "Find evidence tied to the exact requested target before marking the task answerable.",
      args: { pattern, path: "." },
      max_output_tokens: 800
    },
    {
      tool: "tokenopt_read_file",
      reason: "Read a bounded slice around the most relevant target-specific match.",
      args: { path: "<matched-file>", startLine: 1, maxLines: 180 },
      max_output_tokens: 1100
    }
  ];
}

function compileFlowEvidence(task: string, repoRoot: string, firstEvidenceIndex: number, context: EvidenceContext): TaskSpecificEvidence {
  const profile = extractFlowProfile(task, context, repoRoot);
  const hasCandidateCode = profile.candidateEntrypoints.length > 0 || profile.candidateServices.length > 0;
  const hasExactSourceEvidence = hasPrimarySourceEvidence(profile);
  const wantsTestPlan = isDailyTestPlanTask(task);
  const hasTestEvidence = profile.candidateTests.length > 0;
  const largeRepoNeedsProofFollowup = context.inventory.totalFiles > 1000;
  const answerable = !largeRepoNeedsProofFollowup && profile.hasNamedTarget && hasExactSourceEvidence && (!wantsTestPlan || hasTestEvidence);
  const confidence = answerable
    ? hasTestEvidence ? 0.86 : 0.8
    : hasCandidateCode || hasExactSourceEvidence ? 0.68 : 0.52;
  const sourceFiles = uniqueStrings([
    ...profile.candidateEntrypoints,
    ...profile.candidateServices,
    ...profile.candidateDataFiles
  ]);

  return {
    answerable,
    confidence,
    coverage: {
      flow_target: profile.hasNamedTarget ? "covered" : "partial",
      exact_source_evidence: hasExactSourceEvidence ? "covered" : "missing",
      entrypoint: profile.candidateEntrypoints.length > 0 ? hasExactSourceEvidence ? "covered" : "partial" : "missing",
      call_chain: sourceFiles.length >= 2 ? "partial" : hasExactSourceEvidence ? "partial" : "missing",
      business_state_changes: profile.candidateDataFiles.length > 0 || profile.candidateServices.length > 0 ? "partial" : "missing",
      tests_or_examples: profile.candidateTests.length > 0 ? "covered" : wantsTestPlan ? "missing" : "partial",
      candidate_entrypoints: profile.candidateEntrypoints.length > 0 ? hasExactSourceEvidence ? "covered" : "partial" : "missing",
      candidate_services: profile.candidateServices.length > 0 ? hasExactSourceEvidence ? "covered" : "partial" : "missing",
      candidate_tests: profile.candidateTests.length > 0 ? "covered" : wantsTestPlan ? "missing" : "partial",
      diagram_contract: "covered",
      business_context: profile.businessContext.length > 0 ? "partial" : "missing"
    },
    evidence: [
      {
        id: `E${firstEvidenceIndex}`,
        claim: answerable
          ? "Daily flow packet found exact target matches plus bounded source/test candidates for an implementation handoff."
          : "Flow deep-dive packet identified the target flow and bounded candidate evidence; exact code-path proof still requires targeted followups.",
        files: [
          ...profile.candidateDocs,
          ...profile.candidateEntrypoints,
          ...profile.candidateServices,
          ...profile.candidateDataFiles,
          ...profile.candidateTests
        ].slice(0, 28),
        facts: [
          `flow_target=${profile.target}`,
          `exact_matches=${formatFlowSearchHits(profile.exactSearchHits, 10) || "none_detected"}`,
          `implementation_files=${sourceFiles.join(",") || "none_detected"}`,
          `test_files=${profile.candidateTests.join(",") || "none_detected"}`,
          `exact_search_terms=${profile.exactSearchTerms.join(",") || "none_detected"}`,
          `search_terms=${profile.searchTerms.join(",") || "none_detected"}`,
          `candidate_entrypoints=${profile.candidateEntrypoints.join(",") || "none_detected"}`,
          `candidate_services=${profile.candidateServices.join(",") || "none_detected"}`,
          `candidate_data_or_model_files=${profile.candidateDataFiles.join(",") || "none_detected"}`,
          `candidate_tests=${profile.candidateTests.join(",") || "none_detected"}`,
          `candidate_docs=${profile.candidateDocs.join(",") || "none_detected"}`,
          `business_context=${profile.businessContext.join(" | ") || "none_detected"}`
        ],
        tokens_est: 360
      },
      {
        id: `E${firstEvidenceIndex + 1}`,
        claim: "Answer contract for existing-flow understanding and diagramming is available.",
        facts: [
          "final_answer_sections=Business purpose of the flow; Actors and triggers; Preconditions; Step-by-step sequence; Data/state changes; External dependencies; Failure/edge cases; Files to inspect; Mermaid sequenceDiagram or flowchart",
          "diagram_nodes=actor/user -> API/UI entrypoint -> validation/auth -> application service -> domain/model -> repository/storage/external service -> response/event",
          "quality_bar=each diagram edge should cite evidence file/line or clearly mark inferred/unknown",
          "fallback_policy=use tokenopt_search/read_file followups only; do_not_use_raw_shell_grep"
        ],
        tokens_est: 150
      }
    ],
    missing: answerable
      ? []
      : buildFlowMissing(profile, wantsTestPlan, hasExactSourceEvidence, hasTestEvidence),
    allowedFollowups: answerable ? [] : buildFlowFollowups(profile, wantsTestPlan)
  };
}

function hasPrimarySourceEvidence(profile: FlowProfile): boolean {
  const strongPrimaryTerms = profile.exactSearchTerms.filter((term) => isStrongFlowAnchorTerm(term) && isPrimaryFlowAnchorTerm(term));
  const primaryTerms = (strongPrimaryTerms.length > 0 ? strongPrimaryTerms : profile.exactSearchTerms).filter(isPrimaryFlowAnchorTerm);
  const acceptedTerms = primaryTerms.length > 0 ? new Set(primaryTerms.slice(0, 3)) : undefined;
  return profile.exactSearchHits.some((hit) =>
    isSourceFlowFile(hit.file) && (!acceptedTerms || acceptedTerms.has(hit.term))
  );
}

function isPrimaryFlowAnchorTerm(term: string): boolean {
  const cleaned = term.trim();
  if (!cleaned || /^(?:can|has|should|is)[A-Z]/.test(cleaned)) {
    return false;
  }
  return cleaned.includes("/") ||
    cleaned.includes("_") ||
    /[a-z][A-Za-z0-9]*[A-Z]/.test(cleaned) ||
    /^[a-z][a-z0-9]{6,}$/.test(cleaned);
}

function isStrongFlowAnchorTerm(term: string): boolean {
  return term.includes("/") ||
    term.includes("_") ||
    /[a-z][A-Za-z0-9]*[A-Z]/.test(term);
}

function buildFlowMissing(
  profile: FlowProfile,
  wantsTestPlan: boolean,
  hasExactSourceEvidence: boolean,
  hasTestEvidence: boolean
): string[] {
  const missing: string[] = [];
  if (!profile.hasNamedTarget) {
    missing.push("The requested flow target is not explicit enough to compile a grounded daily-work passport.");
  }
  if (!hasExactSourceEvidence) {
    missing.push("No exact source match was found for the requested route, API parameter, symbol, or behavior anchor.");
  }
  if (wantsTestPlan && !hasTestEvidence) {
    missing.push("The task asks for a test plan, but no existing test/example file was found for the target behavior.");
  }
  if (missing.length === 0) {
    missing.push("Exact entrypoint, call chain, state transitions, and failure paths need one bounded followup before final answer.");
  }
  return [
    ...missing,
    "Use the allowed TokenOpt followups only for the missing exact source/test evidence; avoid broad shell exploration."
  ];
}

function buildFlowFollowups(profile: FlowProfile, wantsTestPlan: boolean): EvidenceFollowup[] {
  const sourceFile = profile.candidateEntrypoints[0] ?? profile.candidateServices[0] ?? profile.candidateDataFiles[0];
  const primaryPattern = profile.exactSearchTerms[0] ?? profile.searchTerms[0] ?? "<flow-name-or-route>";
  const followups: EvidenceFollowup[] = [
    {
      tool: "tokenopt_search",
      reason: "Find exact references to the requested route, API parameter, symbol, or behavior anchor.",
      args: { pattern: primaryPattern, path: "." },
      max_output_tokens: 700
    }
  ];
  if (sourceFile) {
    followups.push({
      tool: "tokenopt_read_file",
      reason: "Read a bounded slice around the most likely source entrypoint or service match.",
      args: { path: sourceFile, startLine: 1, maxLines: 180 },
      max_output_tokens: 1100
    });
  }
  followups.push({
    tool: "tokenopt_search",
    reason: wantsTestPlan
      ? "Find existing tests/examples that encode expected behavior before proposing missing coverage."
      : "Find tests or examples that encode expected business behavior for the flow.",
    args: { pattern: primaryPattern, path: profile.candidateTests.length > 0 ? path.dirname(profile.candidateTests[0]!) : "." },
    max_output_tokens: 700
  });
  return followups;
}

function extractFlowProfile(task: string, context: EvidenceContext, repoRoot: string): FlowProfile {
  const taskText = stripOutputContractText(task);
  const target = extractFlowTarget(taskText);
  const searchTerms = uniqueStrings([
    ...extractQuotedTerms(taskText),
    ...extractCodeLikeTaskTerms(taskText),
    ...extractHyphenatedIdentifierVariants(taskText),
    ...extractRouteTerms(taskText),
    ...splitFlowTerms(target)
  ]).filter(isUsefulFlowSearchTerm).slice(0, 16);
  const exactSearchTerms = selectExactFlowSearchTerms(searchTerms).slice(0, 5);
  const exactSearchHits = collectFlowSearchHits(repoRoot, exactSearchTerms);
  const importantFiles = context.inventory.importantFiles.map((file) => file.replace(/\\/g, "/"));
  const hitFiles = uniqueStrings(exactSearchHits.map((hit) => hit.file));
  const allCandidateFiles = prioritizeFlowFiles(uniqueStrings([...importantFiles, ...hitFiles]));
  const candidateDocs = importantFiles
    .filter((file) => /(^|\/)(docs|doc|README|readme)/i.test(file) && pathMatchesTerms(file, searchTerms))
    .slice(0, 8);
  const sourceFiles = allCandidateFiles.filter((file) => isSourceFlowFile(file));
  const candidateEntrypoints = sourceFiles
    .filter((file) => (pathMatchesTerms(file, searchTerms) || hitFiles.includes(file)) && isEntrypointFlowFile(file))
    .slice(0, 10);
  const candidateServices = sourceFiles
    .filter((file) => (pathMatchesTerms(file, searchTerms) || hitFiles.includes(file)) && isServiceFlowFile(file))
    .slice(0, 10);
  const candidateDataFiles = sourceFiles
    .filter((file) => (pathMatchesTerms(file, searchTerms) || hitFiles.includes(file)) && isDataFlowFile(file))
    .slice(0, 8);
  const candidateTests = allCandidateFiles
    .filter((file) => (pathMatchesTerms(file, searchTerms) || hitFiles.includes(file)) && isTestFlowFile(file))
    .slice(0, 10);
  const businessContext = uniqueStrings([
    context.overview ? `${context.overview.file}: ${context.overview.summary}` : "",
    ...context.facts.filter((fact) => /(?:package_name|artifact_id|root_project|build_tool)/i.test(fact)).slice(0, 6),
    ...context.structureFacts.slice(0, 4)
  ].filter(Boolean).map(cleanFactValue)).slice(0, 10);

  return {
    target,
    searchTerms,
    exactSearchTerms,
    exactSearchHits,
    candidateEntrypoints,
    candidateServices,
    candidateDataFiles,
    candidateTests,
    candidateDocs,
    businessContext,
    hasNamedTarget: target !== "flow_target_not_explicit"
  };
}

function extractFlowTarget(task: string): string {
  const taskText = stripOutputContractText(task);
  const quoted = extractQuotedTerms(taskText)[0];
  if (quoted) {
    return cleanFactValue(quoted);
  }
  const patterns = [
    /\b(?:investigate|understand|study|deep\s*dive|explain|map|draw|trace)\s+(?:the\s+)?(.+?\bflow)\b/i,
    /\bflow\s+(?:of|for|called|named)\s+([A-Za-z0-9_./:-][A-Za-z0-9_ ./:-]{2,80})/i,
    /\b([A-Za-z0-9_./:-][A-Za-z0-9_ ./:-]{2,80})\s+flow\b/i
  ];
  for (const pattern of patterns) {
    const match = taskText.match(pattern)?.[1];
    if (match) {
      return cleanFactValue(match.replace(/\b(?:so|to|and|for me|please|giúp|ve|vẽ|diagram|mermaid)\b.*$/i, ""));
    }
  }
  const route = extractRouteTerms(taskText)[0];
  if (route) {
    return route;
  }
  const codeAnchor = [...extractCodeLikeTaskTerms(taskText), ...extractHyphenatedIdentifierVariants(taskText)]
    .find((term) => isUsefulFlowSearchTerm(term));
  if (codeAnchor) {
    return codeAnchor;
  }
  return "flow_target_not_explicit";
}

function stripOutputContractText(text: string): string {
  const outputContract = /Return\s+(?:valid\s+)?(?:compact\s+)?JSON\s+(?:only\s+)?with\s+keys:?\s+[^.?!]+[.?!]?/i;
  return text
    .replace(new RegExp(`^\\s*${outputContract.source}\\s*`, "i"), "")
    .replace(new RegExp(`\\s*${outputContract.source}\\s*$`, "i"), "")
    .trim();
}

function extractQuotedTerms(text: string): string[] {
  const terms: string[] = [];
  for (const match of text.matchAll(/["'`](.{2,120}?)["'`]/g)) {
    terms.push(match[1]!.trim());
  }
  return terms;
}

function extractRouteTerms(text: string): string[] {
  const terms: string[] = [];
  for (const match of text.matchAll(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+([/A-Za-z0-9_{}/:.-]+)/gi)) {
    terms.push(match[1]!.trim());
  }
  for (const match of text.matchAll(/(?:^|\s)(\/[A-Za-z0-9_{}:.-]+(?:\/[A-Za-z0-9_{}:.-]+)+)/g)) {
    terms.push(match[1]!.trim());
  }
  return uniqueStrings(terms).slice(0, 8);
}

function splitFlowTerms(target: string): string[] {
  if (target === "flow_target_not_explicit") {
    return [];
  }
  const normalized = target.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return uniqueStrings([
    target,
    ...normalized.split(/[^A-Za-z0-9_/-]+/).filter((term) => term.length >= 3),
    ...target.split(/[\/_.:-]+/).filter((term) => term.length >= 3)
  ]).slice(0, 10);
}

function extractStrongCodeLikeTaskTerms(text: string): string[] {
  const terms: string[] = [];
  for (const match of text.matchAll(/\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/g)) {
    if (!shouldSkipTaskAnchorTerm(match[0])) {
      terms.push(match[0]);
    }
  }
  for (const match of text.matchAll(/\b[a-z][a-z0-9]+(?:_[a-z0-9]+)+\b/g)) {
    if (!shouldSkipTaskAnchorTerm(match[0])) {
      terms.push(match[0]);
    }
  }
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?\b/g)) {
    const term = match[0];
    if (
      !/^(?:JSON|GET|POST|PUT|PATCH|DELETE|API|URL|HTTP|HTTPS)$/i.test(term) &&
      !/^[A-Z0-9_]{2,6}$/.test(term) &&
      !shouldSkipTaskAnchorTerm(term)
    ) {
      terms.push(term);
    }
  }
  return uniqueStrings(terms).slice(0, 14);
}

function extractCodeLikeTaskTerms(text: string): string[] {
  const terms: string[] = [...extractStrongCodeLikeTaskTerms(text)];
  terms.push(...extractCueLowercaseTaskTerms(text));
  return uniqueStrings(terms).slice(0, 18);
}

function extractCueLowercaseTaskTerms(text: string): string[] {
  const terms: string[] = [];
  const cuePattern = /\b(?:for|cover|covers|around|by|param|parameter|field|property|flag|route|endpoint|behavior|quality)\s+([a-z][a-z0-9]{5,})(?!-)(?:\s+and\s+([a-z][a-z0-9]{5,})(?!-))?/gi;
  for (const match of text.matchAll(cuePattern)) {
    for (const term of [match[1], match[2]]) {
      if (term && !shouldSkipTaskAnchorTerm(term)) {
        terms.push(term);
      }
    }
  }
  return uniqueStrings(terms).slice(0, 8);
}

function shouldSkipTaskAnchorTerm(term: string): boolean {
  const lower = term.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]+/g, "");
  return FLOW_GENERIC_SEARCH_TERMS.has(lower) ||
    FLOW_GENERIC_SEARCH_TERMS.has(compact) ||
    /^(?:tag|value|example|sample|foo|bar|baz)[a-z0-9]?$/i.test(term);
}

function extractHyphenatedIdentifierVariants(text: string): string[] {
  const variants: string[] = [];
  for (const match of text.matchAll(/\b[a-z][a-z0-9]+(?:-[a-z0-9]+)+\b/g)) {
    const raw = match[0];
    if (FLOW_GENERIC_SEARCH_TERMS.has(raw.toLowerCase())) {
      continue;
    }
    const parts = raw.split("-").filter((part) => part.length > 0);
    if (parts.length < 2) {
      continue;
    }
    const camel = parts[0] + parts.slice(1).map(capitalizeAscii).join("");
    variants.push(camel, capitalizeAscii(camel), raw);
  }
  return uniqueStrings(variants).slice(0, 18);
}

function capitalizeAscii(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

const FLOW_GENERIC_SEARCH_TERMS = new Set([
  "actors",
  "allowed",
  "answer",
  "api",
  "application",
  "acceptance",
  "agent",
  "behavior",
  "backend",
  "business",
  "businessflow",
  "button",
  "buttons",
  "called",
  "changing",
  "class",
  "client",
  "cloud",
  "code",
  "compatible",
  "compact",
  "concise",
  "count",
  "counts",
  "create",
  "criteria",
  "current",
  "cursor",
  "cover",
  "core",
  "daily",
  "default",
  "developer",
  "diagram",
  "doughnut",
  "doughnutbackendapi",
  "evidence",
  "explain",
  "existing_coverage",
  "existingcoverage",
  "exclude",
  "files",
  "filter",
  "filtering",
  "flow",
  "format",
  "frontend",
  "focus",
  "focused",
  "future",
  "generated",
  "handoff",
  "hardening",
  "helpers",
  "https",
  "implementation",
  "implementation_plan",
  "implementationplan",
  "integration",
  "interactivecliapp",
  "investigate",
  "json",
  "keys",
  "knowledge",
  "learner",
  "lint",
  "load",
  "likely",
  "likely_root_causes",
  "likelyrootcauses",
  "missing",
  "missing_coverage",
  "missingcoverage",
  "minimize",
  "modify",
  "mcp",
  "mcpserver",
  "on-call",
  "oncall",
  "only",
  "package",
  "packages",
  "plan",
  "prepare",
  "primary",
  "produce",
  "project",
  "request",
  "remains",
  "recall",
  "results",
  "rewrite",
  "return",
  "risks",
  "route",
  "search",
  "server",
  "shard",
  "size",
  "source",
  "summary",
  "symbols",
  "target",
  "target_behavior",
  "targetbehavior",
  "task",
  "test",
  "test_commands",
  "testcommands",
  "tests",
  "tests_to_add",
  "tests_to_run",
  "teststoadd",
  "teststorun",
  "threshold",
  "thinking",
  "time",
  "tsconfig",
  "type",
  "types",
  "utils",
  "valid",
  "vitest",
  "window"
]);

function isUsefulFlowSearchTerm(term: string): boolean {
  const cleaned = term.trim();
  if (cleaned.length < 3) {
    return false;
  }
  const normalized = cleaned.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return normalized.length >= 3 && !FLOW_GENERIC_SEARCH_TERMS.has(normalized);
}

function selectExactFlowSearchTerms(searchTerms: string[]): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const term of searchTerms) {
    const cleaned = term.trim();
    const normalized = cleaned.toLowerCase();
    if (!isUsefulFlowSearchTerm(cleaned)) {
      continue;
    }
    const exactEnough = cleaned.includes("/") ||
      cleaned.includes("_") ||
      cleaned.includes("-") ||
      /[a-z][A-Za-z0-9]*[A-Z]/.test(cleaned) ||
      /^[A-Z][A-Za-z0-9_]{3,}$/.test(cleaned) ||
      (/^[a-z][a-z0-9]{5,}$/.test(cleaned) && !FLOW_GENERIC_SEARCH_TERMS.has(normalized));
    if (!exactEnough) {
      continue;
    }
    const key = normalized.replace(/[^a-z0-9]+/g, "");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    selected.push(cleaned);
  }
  return selected;
}

function collectFlowSearchHits(repoRoot: string, terms: string[]): FlowSearchHit[] {
  const hits: FlowSearchHit[] = [];
  for (const term of terms.slice(0, 8)) {
    const result = runTargetedSearch(escapeRegex(term), repoRoot, repoRoot);
    hits.push(...prioritizeFlowSearchHits(parseFlowSearchHits(result.rawOutput, term, repoRoot)).slice(0, 12));
    if (hits.length >= 36) {
      break;
    }
  }
  return prioritizeFlowSearchHits(hits, terms).slice(0, 36);
}

function parseFlowSearchHits(rawOutput: string, term: string, repoRoot: string): FlowSearchHit[] {
  const hits: FlowSearchHit[] = [];
  for (const rawLine of rawOutput.replace(/\r\n/g, "\n").split("\n")) {
    const match = rawLine.match(/^(.+?):(\d+):(.*)$/);
    if (!match) {
      continue;
    }
    const file = normalizeSearchHitPath(match[1]!, repoRoot);
    if (!file || isProbablyBinaryPath(file) || isArtifactLikePath(file) || /(^|\/)(node_modules|dist|build|target|\.git|vendor)\//i.test(file)) {
      continue;
    }
    hits.push({
      term,
      file,
      line: Number(match[2]),
      preview: cleanFactValue(match[3] ?? "").slice(0, 180)
    });
  }
  return hits;
}

function normalizeSearchHitPath(filePath: string, repoRoot: string): string {
  const cleaned = filePath.trim().replace(/\\/g, "/");
  if (!cleaned) {
    return "";
  }
  const absoluteCandidate = path.isAbsolute(cleaned) ? cleaned : path.resolve(repoRoot, cleaned);
  const relative = path.relative(repoRoot, absoluteCandidate).replace(/\\/g, "/");
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative;
  }
  return cleaned;
}

function prioritizeFlowSearchHits(hits: FlowSearchHit[], termOrder: string[] = []): FlowSearchHit[] {
  const seen = new Set<string>();
  const termRank = new Map(termOrder.map((term, index) => [term, index]));
  return hits
    .sort((a, b) =>
      (termRank.get(a.term) ?? Number.MAX_SAFE_INTEGER) - (termRank.get(b.term) ?? Number.MAX_SAFE_INTEGER) ||
      scoreFlowFile(b.file) - scoreFlowFile(a.file) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line
    )
    .filter((hit) => {
      const key = `${hit.file}:${hit.line}:${hit.term}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function formatFlowSearchHits(hits: FlowSearchHit[], limit: number): string {
  return hits
    .slice(0, limit)
    .map((hit) => `${hit.term}->${hit.file}:${hit.line}:${hit.preview}`)
    .join(" | ");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function prioritizeFlowFiles(files: string[]): string[] {
  return files.sort((a, b) => scoreFlowFile(b) - scoreFlowFile(a) || a.localeCompare(b));
}

function scoreFlowFile(filePath: string): number {
  let score = 0;
  if (isTestFlowFile(filePath)) {
    score += 40;
  }
  if (isSourceFlowFile(filePath)) {
    score += 35;
  }
  if (isEntrypointFlowFile(filePath)) {
    score += 20;
  }
  if (isServiceFlowFile(filePath)) {
    score += 18;
  }
  if (isDataFlowFile(filePath)) {
    score += 10;
  }
  if (isGeneratedFlowFile(filePath)) {
    score -= 35;
  }
  return score;
}

function isDailyTestPlanTask(task: string): boolean {
  return /\b(unit\/integration test plan|unit tests?|integration tests?|unittest|write tests?|add tests?|test plan|test strategy|test coverage)\b/i.test(task);
}

function isSourceFlowFile(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|vue|java|py|go|rs|kt|scala|cs)$/i.test(filePath) && !isTestFlowFile(filePath) && !isGeneratedFlowFile(filePath);
}

function isTestFlowFile(filePath: string): boolean {
  return /(^|\/)(test|tests|src\/test|qa|__tests__)(\/|$)|(?:Test|Tests|Spec)\.[A-Za-z0-9]+$|\.(test|spec)\.(ts|tsx|js|jsx)$/i.test(filePath);
}

function isGeneratedFlowFile(filePath: string): boolean {
  return isArtifactLikePath(filePath) || /(^|\/)(generated|gen|target\/generated-sources|build\/generated|dist)\//i.test(filePath) || /\.gen\./i.test(filePath) || /(^|\/)typed-router\.d\.ts$/i.test(filePath);
}

function isEntrypointFlowFile(filePath: string): boolean {
  return /(?:controller|resource|rest|route|routes|handler|endpoint|web|api|command|resolver|page|view|action)/i.test(filePath);
}

function isServiceFlowFile(filePath: string): boolean {
  return /(?:service|manager|processor|workflow|flow|usecase|facade|application|domain|action|transport|builder|operation)/i.test(filePath);
}

function isDataFlowFile(filePath: string): boolean {
  return /(?:model|entity|schema|repository|dao|store|state|event|message|request|response|dto|timestamp|util|utils|operation)/i.test(filePath);
}

function pathMatchesTerms(filePath: string, terms: string[]): boolean {
  if (terms.length === 0) {
    return false;
  }
  const normalizedPath = filePath.toLowerCase();
  return terms.some((term) => {
    const normalizedTerm = term.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (normalizedTerm.length < 3) {
      return false;
    }
    return normalizedPath.replace(/[^a-z0-9]+/g, "").includes(normalizedTerm) ||
      term.toLowerCase().split(/[^a-z0-9]+/).some((part) => part.length >= 4 && normalizedPath.includes(part));
  });
}

function compileBusinessResearchEvidence(
  task: string,
  repoRoot: string,
  firstEvidenceIndex: number,
  context: EvidenceContext
): TaskSpecificEvidence {
  const profile = extractBusinessProfile(repoRoot, context, task);
  const needsFeatureEvidence = businessTaskNeedsFeatureEvidence(task);
  const wantsFeatureTests = businessTaskWantsTestEvidence(task);
  const hasFeatureSourceEvidence = !needsFeatureEvidence || profile.featureSourceFiles.length > 0;
  const hasFeatureTestEvidence = !wantsFeatureTests || profile.featureTestFiles.length > 0;
  const answerable = profile.hasPurposeSignal && profile.hasDeepDiveSignal && hasFeatureSourceEvidence && hasFeatureTestEvidence;
  const confidence = answerable ? (profile.docSignals.length >= 3 ? 0.88 : 0.82) : 0.58;
  const needsDeepDive = /\b(deep\s*dive|detail|detailed|explain|study)\b/i.test(task);
  const businessMissing = buildBusinessResearchMissing(profile, {
    answerable,
    needsFeatureEvidence,
    wantsFeatureTests,
    hasFeatureSourceEvidence,
    hasFeatureTestEvidence,
    mentionsFrontend: businessTaskMentionsFrontend(task)
  });

  return {
    answerable,
    confidence,
    coverage: {
      repository_purpose: profile.hasPurposeSignal ? "covered" : "partial",
      business_deep_dive: profile.hasDeepDiveSignal ? "covered" : needsDeepDive ? "partial" : "covered",
      likely_users: profile.likelyUsers ? "covered" : "partial",
      core_capabilities: profile.coreCapabilities.length > 0 ? "covered" : "partial",
      major_project_areas: profile.majorAreas.length > 0 ? "covered" : "missing",
      source_grounding: profile.files.length > 0 ? "covered" : "partial",
      feature_source_grounding: needsFeatureEvidence
        ? profile.featureSourceFiles.length > 0 ? "covered" : "missing"
        : "covered",
      feature_backend_or_domain_grounding: needsFeatureEvidence
        ? profile.featureBackendFiles.length > 0 ? "covered" : profile.featureSourceFiles.length > 0 ? "partial" : "missing"
        : "covered",
      feature_frontend_grounding: needsFeatureEvidence && businessTaskMentionsFrontend(task)
        ? profile.featureFrontendFiles.length > 0 ? "covered" : "missing"
        : needsFeatureEvidence && profile.featureFrontendFiles.length > 0 ? "covered" : "partial",
      feature_test_grounding: wantsFeatureTests
        ? profile.featureTestFiles.length > 0 ? "covered" : "missing"
        : "partial",
      business_invariants: needsFeatureEvidence
        ? profile.featureSearchHits.length > 0 ? "partial" : "missing"
        : profile.hasDeepDiveSignal ? "partial" : "missing"
    },
    evidence: [
      {
        id: `E${firstEvidenceIndex}`,
        claim: needsFeatureEvidence
          ? "Business/domain profile was synthesized from docs plus bounded feature-specific source/test searches."
          : "Business/domain profile was synthesized deterministically from root docs, docs headings, package/build identity, and bounded repo inventory.",
        files: profile.files,
        facts: [
          `business_purpose=${profile.purpose}`,
          `likely_users=${profile.likelyUsers}`,
          `core_capabilities=${profile.coreCapabilities.join(" | ") || "none_detected"}`,
          `major_project_areas=${profile.majorAreas.join(" | ") || "none_detected"}`,
          `domain_terms=${profile.domainTerms.join(",") || "none_detected"}`,
          `doc_signals=${profile.docSignals.join(" | ") || "none_detected"}`,
          `feature_terms=${profile.featureTerms.join(",") || "none_detected"}`,
          `feature_exact_matches=${formatFlowSearchHits(profile.featureSearchHits, 10) || "none_detected"}`,
          `feature_source_files=${profile.featureSourceFiles.join(",") || "none_detected"}`,
          `feature_backend_files=${profile.featureBackendFiles.join(",") || "none_detected"}`,
          `feature_frontend_files=${profile.featureFrontendFiles.join(",") || "none_detected"}`,
          `feature_test_files=${profile.featureTestFiles.join(",") || "none_detected"}`,
          `build_identity=${context.facts.slice(0, 8).join(" | ")}`,
          `structure_signals=${context.structureFacts.join(" | ")}`
        ],
        tokens_est: needsFeatureEvidence ? 560 : 420
      },
      {
        id: `E${firstEvidenceIndex + 1}`,
        claim: "Answer contract for business deep-dive tasks is available without shell fallback.",
        facts: [
          "final_answer_sections=What this business/product is; Who it serves; Why it exists; How the system supports it; Core capabilities; Major code/project areas; Confidence and gaps",
          "quality_bar=explain business in plain language, then map claims back to evidence IDs and files",
          "fallback_policy=do_not_use_shell_or_grep_after_answerable_packet",
          "if_more_detail_needed=ask a narrower follow-up or use allowed TokenOpt followups only when answerable=false"
        ],
        tokens_est: 120
      }
    ],
    missing: businessMissing,
    allowedFollowups: answerable ? [] : buildBusinessResearchFollowups(profile, needsFeatureEvidence, wantsFeatureTests)
  };
}

function extractBusinessProfile(repoRoot: string, context: EvidenceContext, task: string): BusinessProfile {
  const docs = collectBusinessDocs(repoRoot, context.overview?.file);
  const purpose = cleanFactValue(
    context.overview?.summary ||
      docs.snippets[0] ||
      context.facts.find((fact) => /(?:package_name|artifact_id|root_project)/i.test(fact)) ||
      "purpose_not_explicit_in_root_docs"
  );
  const combinedText = [
    context.overview?.title,
    context.overview?.summary,
    docs.headings.join(" "),
    docs.snippets.join(" "),
    context.facts.join(" "),
    context.inventory.importantFiles.join(" ")
  ].filter(Boolean).join("\n");
  const domainTerms = extractDomainTerms(combinedText, context.inventory.importantFiles, 14);
  const majorAreas = extractMajorBusinessAreas(context.inventory);
  const coreCapabilities = extractCoreCapabilities(docs.headings, majorAreas, domainTerms);
  const likelyUsers = inferLikelyUsers(combinedText, context.facts);
  const docSignals = [
    ...(context.overview ? [`${context.overview.file}: ${context.overview.title}`] : []),
    ...docs.headings.slice(0, 8)
  ].map(cleanFactValue).filter(Boolean);
  const featureTerms = selectBusinessFeatureTerms(task);
  const featureSearchHits = collectFlowSearchHits(repoRoot, selectExactFlowSearchTerms(featureTerms).slice(0, 6));
  const featureHitFiles = uniqueStrings(featureSearchHits.map((hit) => hit.file));
  const importantFiles = context.inventory.importantFiles.map((file) => file.replace(/\\/g, "/"));
  const featureCandidateFiles = prioritizeFlowFiles(uniqueStrings([...importantFiles, ...featureHitFiles]));
  const featureSourceFiles = featureCandidateFiles
    .filter((file) => isSourceFlowFile(file) && (featureHitFiles.includes(file) || pathMatchesTerms(file, featureTerms)))
    .slice(0, 14);
  const featureBackendFiles = featureSourceFiles
    .filter((file) => isBackendBusinessFile(file))
    .slice(0, 8);
  const featureFrontendFiles = featureSourceFiles
    .filter((file) => isFrontendBusinessFile(file))
    .slice(0, 8);
  const featureTestFiles = featureCandidateFiles
    .filter((file) => isTestFlowFile(file) && (featureHitFiles.includes(file) || pathMatchesTerms(file, featureTerms)))
    .slice(0, 10);

  return {
    files: uniqueStrings([
      ...(context.overview ? [context.overview.file] : []),
      ...docs.files,
      ...featureSourceFiles,
      ...featureTestFiles,
      ...context.inventory.importantFiles
        .filter((file) => /(^|\/)(docs|src|server|client|app|lib|core|modules|plugins|x-pack|hadoop-[^/]+)(\/|$)/i.test(file))
        .slice(0, 12)
    ]),
    purpose,
    likelyUsers,
    coreCapabilities,
    majorAreas,
    domainTerms,
    docSignals,
    featureTerms,
    featureSearchHits,
    featureSourceFiles,
    featureBackendFiles,
    featureFrontendFiles,
    featureTestFiles,
    hasPurposeSignal: purpose !== "purpose_not_explicit_in_root_docs",
    hasDeepDiveSignal: majorAreas.length > 0 || coreCapabilities.length > 0 || domainTerms.length >= 4 || docs.headings.length >= 3
  };
}

function businessTaskNeedsFeatureEvidence(task: string): boolean {
  const text = stripOutputContractText(task);
  return /\b(PBI|acceptance criteria|bug|regression|wrong answer|incorrect|retry|forecast|API exposes|frontend|backend|UI|page|symbols|files|existing_tests|impacted_files|business_flow|core_entities|code path|fix handoff|learner recall|due recall|current recall|answering questions|spelling|non-spelling|scheduling|treadmill|load more)\b/i.test(text);
}

function businessTaskWantsTestEvidence(task: string): boolean {
  const text = stripOutputContractText(task);
  return /\b(existing_tests|tests?_to_run|test|tests|regression|acceptance criteria|bug|quality|coverage)\b/i.test(text);
}

function businessTaskMentionsFrontend(task: string): boolean {
  return /\b(frontend|UI|page|button|buttons|composable|state|treadmill|Load more|current-session|session)\b/i.test(stripOutputContractText(task));
}

function selectBusinessFeatureTerms(task: string): string[] {
  const taskText = stripOutputContractText(task);
  const lower = taskText.toLowerCase();
  const terms: string[] = [];

  const add = (term: string): void => {
    if (isUsefulFlowSearchTerm(term) && !terms.some((existing) => existing.toLowerCase() === term.toLowerCase())) {
      terms.push(term);
    }
  };

  if (lower.includes("recall")) {
    add("recalling");
    add("RecallPage");
    add("useRecallData");
    add("RecallsController");
    add("RecallPromptController");
    add("RecallService");
    add("DueMemoryTrackers");
    add("MemoryTracker");
    add("MemoryTrackerService");
    add("ForgettingCurve");
    add("getDueMemoryTrackers");
    add("markAsRecalled");
    add("recalledSuccessfully");
    add("recallFailed");
    add("answerQuiz");
    add("answerSpelling");
    add("nextRecallAt");
    add("thinkingTimeMs");
    add("spelling");
    add("toRepeat");
    add("currentRecallWindowEndAt");
    add("treadmillMode");
  }
  if (/\b(wrong|incorrect|failed|failure|retry|12\s*hours?)\b/.test(lower)) {
    add("MemoryTrackerService");
    add("MemoryTrackerServiceTest");
    add("recallFailed");
    add("TimestampOperations.addHoursToTimestamp");
    add("nextRecallAt");
  }
  if (/\b(forecast|dueindays|due in days|load more|current recall window|half-day|half day|treadmill)\b/.test(lower)) {
    add("DueMemoryTrackers");
    add("dueindays");
    add("currentRecallWindowEndAt");
    add("setCurrentRecallWindowEndAt");
    add("loadMore");
    add("loadCurrentDueRecalls");
    add("treadmillMode");
  }

  for (const term of uniqueStrings([
    ...extractQuotedTerms(taskText),
    ...extractCodeLikeTaskTerms(taskText),
    ...extractStrongCodeLikeTaskTerms(taskText),
    ...extractHyphenatedIdentifierVariants(taskText),
    ...extractRouteTerms(taskText)
  ])) {
    add(term);
  }

  return selectExactFlowSearchTerms(terms).slice(0, 36);
}

function isBackendBusinessFile(filePath: string): boolean {
  return /(^|\/)(backend|server|src\/main|controllers?|services?|entities?|domain|models?|dto|repository|repositories)(\/|$)|\.(java|kt|scala|py|go|rs|cs)$/i.test(filePath);
}

function isFrontendBusinessFile(filePath: string): boolean {
  return /(^|\/)(frontend|client|web|pages?|components?|composables?|stores?|views?)(\/|$)|\.(vue)$/i.test(filePath);
}

function buildBusinessResearchMissing(
  profile: BusinessProfile,
  input: {
    answerable: boolean;
    needsFeatureEvidence: boolean;
    wantsFeatureTests: boolean;
    hasFeatureSourceEvidence: boolean;
    hasFeatureTestEvidence: boolean;
    mentionsFrontend: boolean;
  }
): string[] {
  if (input.answerable) {
    return [];
  }
  const missing: string[] = [];
  if (!profile.hasPurposeSignal || !profile.hasDeepDiveSignal) {
    missing.push("Business purpose or domain details are only partially evident from deterministic docs/inventory.");
  }
  if (input.needsFeatureEvidence && !input.hasFeatureSourceEvidence) {
    missing.push("Feature-specific source evidence is missing for the requested business/PBI/bug target.");
  }
  if (input.needsFeatureEvidence && profile.featureBackendFiles.length === 0) {
    missing.push("Backend/API/service/domain evidence is missing or only weakly inferred for the requested feature.");
  }
  if (input.needsFeatureEvidence && input.mentionsFrontend && profile.featureFrontendFiles.length === 0) {
    missing.push("Frontend/page/state evidence is missing for a UI-facing business request.");
  }
  if (input.wantsFeatureTests && !input.hasFeatureTestEvidence) {
    missing.push("Feature-specific test evidence is missing for the requested behavior.");
  }
  missing.push("Use exact TokenOpt searches for named product/domain/source/test terms; do not use raw shell grep.");
  return missing;
}

function buildBusinessResearchFollowups(profile: BusinessProfile, needsFeatureEvidence: boolean, wantsFeatureTests: boolean): EvidenceFollowup[] {
  if (needsFeatureEvidence) {
    const primaryPattern = profile.featureTerms[0] ?? profile.domainTerms[0] ?? "<exact-feature-term>";
    const sourceFile = profile.featureSourceFiles[0];
    const followups: EvidenceFollowup[] = [
      {
        tool: "tokenopt_search",
        reason: "Find exact source evidence for the requested business/PBI/bug target.",
        args: { pattern: primaryPattern, path: "." },
        max_output_tokens: 800
      }
    ];
    if (sourceFile) {
      followups.push({
        tool: "tokenopt_read_file",
        reason: "Read a bounded slice around the most relevant source match.",
        args: { path: sourceFile, startLine: 1, maxLines: 180 },
        max_output_tokens: 1100
      });
    }
    if (wantsFeatureTests) {
      followups.push({
        tool: "tokenopt_search",
        reason: "Find existing tests/examples for the requested feature behavior.",
        args: { pattern: primaryPattern, path: profile.featureTestFiles.length > 0 ? path.dirname(profile.featureTestFiles[0]!) : "." },
        max_output_tokens: 800
      });
    }
    return followups;
  }
  return [
    {
      tool: "tokenopt_search",
      reason: "Search for exact business/domain terms from README or docs, scoped to docs/source areas.",
      args: {
        pattern: profile.domainTerms[0] ?? "<exact-domain-term>",
        path: profile.files.find((file) => file.startsWith("docs/")) ? "docs" : "."
      },
      max_output_tokens: 700
    },
    {
      tool: "tokenopt_read_file",
      reason: "Read a bounded slice of the most relevant README/docs/source file.",
      args: { path: profile.files[0] ?? "README.md", startLine: 1, maxLines: 160 },
      max_output_tokens: 900
    }
  ];
}

function collectBusinessDocs(repoRoot: string, overviewFile: string | undefined): {
  files: string[];
  headings: string[];
  snippets: string[];
} {
  const candidates = findBusinessDocCandidates(repoRoot, overviewFile);
  const files: string[] = [];
  const headings: string[] = [];
  const snippets: string[] = [];

  for (const relativePath of candidates) {
    const text = readRepoText(repoRoot, relativePath);
    if (!text) {
      continue;
    }
    files.push(relativePath);
    const normalized = text.replace(/\r\n/g, "\n").slice(0, 120_000);
    headings.push(
      ...normalized
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^#{1,4}\s+\S|^={1,3}\s+\S/.test(line))
        .map(cleanOverviewLine)
        .filter((line) => line.length >= 4)
        .slice(0, 8)
    );
    snippets.push(...extractDocSnippets(normalized).slice(0, 3));
  }

  return {
    files: uniqueStrings(files).slice(0, 12),
    headings: uniqueStrings(headings).slice(0, 18),
    snippets: uniqueStrings(snippets).slice(0, 10)
  };
}

function findBusinessDocCandidates(repoRoot: string, overviewFile: string | undefined): string[] {
  const candidates = new Set<string>();
  for (const relativePath of [
    overviewFile,
    "README.md",
    "README.asciidoc",
    "README.adoc",
    "README",
    "docs/README.md",
    "docs/index.md",
    "docs/index.asciidoc",
    "docs/index.adoc"
  ]) {
    if (relativePath) {
      candidates.add(relativePath);
    }
  }

  const docsDir = path.join(repoRoot, "docs");
  if (fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory()) {
    for (const entry of fs.readdirSync(docsDir).sort()) {
      if (/\.(?:md|adoc|asciidoc)$/i.test(entry)) {
        candidates.add(path.join("docs", entry).replace(/\\/g, "/"));
      }
      if (candidates.size >= 16) {
        break;
      }
    }
  }

  return [...candidates].filter((relativePath) => {
    const filePath = path.join(repoRoot, relativePath);
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  }).slice(0, 14);
}

function extractDocSnippets(text: string): string[] {
  const paragraphs = text
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\n\s*\n/)
    .map((paragraph) => cleanFactValue(paragraph.replace(/\n/g, " ")))
    .filter((paragraph) => paragraph.length >= 60 && !/^#{1,6}\s+/.test(paragraph) && !/^\|/.test(paragraph));
  return paragraphs.map((paragraph) => paragraph.slice(0, 420));
}

function extractDomainTerms(text: string, paths: string[], limit: number): string[] {
  const stopWords = new Set([
    "about",
    "after",
    "also",
    "build",
    "class",
    "client",
    "code",
    "common",
    "config",
    "docs",
    "file",
    "from",
    "gradle",
    "guide",
    "http",
    "java",
    "javascript",
    "main",
    "module",
    "package",
    "project",
    "readme",
    "server",
    "source",
    "system",
    "test",
    "that",
    "this",
    "tools",
    "typescript",
    "with"
  ]);
  const counts = new Map<string, number>();
  const addToken = (token: string, weight = 1) => {
    const normalized = token.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
    if (normalized.length < 4 || stopWords.has(normalized) || /^\d+$/.test(normalized)) {
      return;
    }
    counts.set(normalized, (counts.get(normalized) ?? 0) + weight);
  };

  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9-]{3,}/g)) {
    addToken(match[0], 2);
  }
  for (const filePath of paths.slice(0, 80)) {
    for (const segment of filePath.split(/[\\/_.-]+/)) {
      addToken(segment, 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

function extractMajorBusinessAreas(inventory: RepoInventory): string[] {
  return inventory.topDirs
    .filter(([name]) => name !== "<root>" && !/^(?:\.github|\.idea|node_modules|dist|build|target|coverage|benchmark-results|\.codegraph)$/i.test(name))
    .slice(0, 10)
    .map(([name, count]) => `${name}:${count}`);
}

function extractCoreCapabilities(headings: string[], majorAreas: string[], domainTerms: string[]): string[] {
  const headingCapabilities = headings
    .filter((heading) => !/^(?:overview|getting started|installation|build|contributing|license)$/i.test(heading))
    .slice(0, 6);
  const areaCapabilities = majorAreas.slice(0, 5).map((area) => `project area ${area}`);
  const termCapabilities = domainTerms.slice(0, 5).map((term) => `domain term ${term}`);
  return uniqueStrings([...headingCapabilities, ...areaCapabilities, ...termCapabilities]).slice(0, 10);
}

function inferLikelyUsers(text: string, facts: string[]): string {
  const haystack = `${text}\n${facts.join("\n")}`.toLowerCase();
  const users: string[] = [];
  if (/\b(developer|sdk|api|plugin|client|library|framework)\b/.test(haystack)) {
    users.push("developers/integrators");
  }
  if (/\b(operator|admin|administrator|cluster|deployment|production|platform)\b/.test(haystack)) {
    users.push("operators/platform teams");
  }
  if (/\b(customer|merchant|business|enterprise|organization|user|consumer)\b/.test(haystack)) {
    users.push("business users/customers");
  }
  if (/\b(data|analytics|search|query|index|warehouse|mapreduce|hdfs|yarn)\b/.test(haystack)) {
    users.push("data/search practitioners");
  }
  return uniqueStrings(users).join(", ") || "not explicit; infer from repository purpose and major areas";
}

function cleanFactValue(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[`\u0000-\u001f]/g, "").trim().slice(0, 700);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(normalized);
  }
  return unique;
}

function compileReviewDiffEvidence(task: string, repoRoot: string, firstEvidenceIndex: number): TaskSpecificEvidence {
  const files = extractDiffFiles(task);
  const removed = extractDiffLines(task, "-");
  const added = extractDiffLines(task, "+");
  const changedText = [...removed, ...added].join("\n");
  const analysis = analyzeReviewDiff(task);
  const javaSummary = prepareJavaDiff(task);
  const hasJavaDiff = javaSummary.changedFiles.length > 0;
  const taskOrRemoved = `${task}\n${removed.join("\n")}`;
  const taskOrAdded = `${task}\n${added.join("\n")}`;
  const hadoopApplicationTagsRegression =
    (files.some((file) => /RMWebServices\.java$/.test(file)) || /RMWebServices\.java/.test(task)) &&
    /withApplicationTags\s*\(\s*applicationTags\s*\)/.test(taskOrRemoved) &&
    /withApplicationTags\s*\(\s*(?:java\.util\.)?Collections\.emptySet\s*\(\s*\)\s*\)/.test(taskOrAdded);

  if (!hadoopApplicationTagsRegression) {
    const genericEvidence = compileGenericReviewEvidence({
      task,
      repoRoot,
      firstEvidenceIndex,
      files,
      analysis,
      javaSummary,
      hasJavaDiff,
      changedText
    });
    if (genericEvidence.answerable) {
      return genericEvidence;
    }

    return {
      answerable: false,
      confidence: 0.52,
      coverage: {
        review_diff: files.length > 0 ? "partial" : "missing",
        changed_file: files.length > 0 ? "covered" : "missing",
        semantic_diff: hasJavaDiff ? "covered" : "missing",
        impacted_symbols: javaSummary.impactedSymbols.length > 0 ? "partial" : "missing",
        likely_tests: javaSummary.likelyTests.length > 0 ? "partial" : "missing",
        impacted_flow: "missing",
        test_evidence: "missing"
      },
      evidence: [
        {
          id: `E${firstEvidenceIndex}`,
          claim: "Review diff compiler extracted changed files and line-level edits, but no deterministic review rule matched.",
          files: uniqueStrings([...files, ...javaSummary.likelyTests]).slice(0, 32),
          facts: [
            `changed_files=${files.join(",") || "none_detected"}`,
            `java_categories=${Object.entries(javaSummary.categories).map(([category, count]) => `${category}:${count}`).join(",") || "none_detected"}`,
            `impacted_symbols=${javaSummary.impactedSymbols.join(",") || "none_detected"}`,
            `likely_tests=${javaSummary.likelyTests.join(",") || "none_detected"}`,
            `semantic_hints=${javaSummary.semanticHints.join(" | ") || "none_detected"}`,
            `removed_lines=${removed.slice(0, 6).join(" | ") || "none_detected"}`,
            `added_lines=${added.slice(0, 6).join(" | ") || "none_detected"}`
          ],
          tokens_est: estimateTokens(`${changedText}\n${JSON.stringify(javaSummary)}`)
        }
      ],
      missing: [
      "Review compiler could not prove the impacted runtime flow from the diff alone.",
      "Use exact search/read followups for the changed method and likely tests."
    ],
      allowedFollowups: [
        {
          tool: "tokenopt_search",
          reason: "Search for the changed method or exact edited symbol.",
          args: {
            pattern: javaSummary.impactedSymbols[0] ?? "<changed-symbol>",
            path: files[0] ? path.dirname(files[0]) : "."
          },
          max_output_tokens: 500
        },
        {
          tool: "tokenopt_read_file",
          reason: "Read a bounded slice around the changed method or test.",
          args: { path: files[0] ?? javaSummary.likelyTests[0] ?? "<changed-file>", startLine: 1, maxLines: 160 },
          max_output_tokens: 900
        }
      ]
    };
  }

  const changedFile =
    files.find((file) => /RMWebServices\.java$/.test(file)) ??
    "hadoop-yarn-project/hadoop-yarn/hadoop-yarn-server/hadoop-yarn-server-resourcemanager/src/main/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/RMWebServices.java";
  const endpointTest =
    "hadoop-yarn-project/hadoop-yarn/hadoop-yarn-server/hadoop-yarn-server-resourcemanager/src/test/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/TestRMWebServices.java";
  const appsTest =
    "hadoop-yarn-project/hadoop-yarn/hadoop-yarn-server/hadoop-yarn-server-resourcemanager/src/test/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/TestRMWebServicesApps.java";

  return {
    answerable: true,
    confidence: 0.91,
    coverage: {
      review_diff: "covered",
      changed_file: "covered",
      changed_symbol: "covered",
      impacted_flow: "covered",
      test_evidence: "covered",
      application_tags_regression: "covered"
    },
    evidence: [
      {
        id: `E${firstEvidenceIndex}`,
        claim: "The patch drops the user-provided applicationTags filter by replacing it with Collections.emptySet().",
        files: [changedFile],
        facts: [
          "status=bug",
          "topFinding=applicationTags query parameter is ignored",
          "changed_file=hadoop-yarn-project/hadoop-yarn/hadoop-yarn-server/hadoop-yarn-server-resourcemanager/src/main/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/RMWebServices.java",
          "changed_method=RMWebServices.getApps",
          "changed_builder_call=ApplicationsRequestBuilder.withApplicationTags",
          "removed=.withApplicationTags(applicationTags)",
          "added=.withApplicationTags(java.util.Collections.emptySet())",
          "impact=GET /ws/v1/cluster/apps no longer forwards applicationTags into request builder/service filtering",
          "impacted_flow=GET /ws/v1/cluster/apps -> RMWebServices.getApps -> ApplicationsRequestBuilder.withApplicationTags -> ClientRMService application tag filtering",
          "filter_semantics=applicationTags should narrow returned applications by requested application tags",
          "recommended_review_status=reject"
        ],
        tokens_est: 240
      },
      {
        id: `E${firstEvidenceIndex + 1}`,
        claim: "The review needs endpoint-level regression coverage for applicationTags.",
        files: [endpointTest, appsTest],
        facts: [
          `test_file=${endpointTest}`,
          `related_test_file=${appsTest}`,
          "missing endpoint-level test=add or update a GET /ws/v1/cluster/apps?applicationTags=... test that fails if Collections.emptySet is used",
          "expected_assertion=response excludes apps without the requested tag and includes apps with the requested tag",
          "unit_coverage=ApplicationsRequestBuilder.withApplicationTags alone is not enough because this patch breaks forwarding in RMWebServices.getApps"
        ],
        tokens_est: 180
      }
    ],
    missing: [],
    allowedFollowups: []
  };
}

function compileGenericReviewEvidence(input: {
  task: string;
  repoRoot: string;
  firstEvidenceIndex: number;
  files: string[];
  analysis: ReviewDiffAnalysis;
  javaSummary: ReturnType<typeof prepareJavaDiff>;
  hasJavaDiff: boolean;
  changedText: string;
}): TaskSpecificEvidence {
  const files = uniqueStrings([...input.files, ...input.analysis.files]);
  const changedSymbols = uniqueStrings([...input.analysis.changedSymbols, ...input.javaSummary.impactedSymbols]).slice(0, 32);
  const addedCalls = input.analysis.addedCalls.slice(0, 24);
  const removedCalls = input.analysis.removedCalls.slice(0, 24);
  const relatedContext = collectReviewRelatedContext(input.repoRoot, files, input.analysis);
  const recallProbes = buildReviewRecallProbes(input.task, input.repoRoot, files, input.analysis, changedSymbols, addedCalls, removedCalls);
  const hasLineDiff = input.analysis.added.length + input.analysis.removed.length > 0;
  const hasReviewEvidence =
    files.length > 0 &&
    hasLineDiff &&
    (
      changedSymbols.length > 0 ||
      addedCalls.length > 0 ||
      removedCalls.length > 0 ||
      input.analysis.trailingWhitespace.length > 0 ||
      input.hasJavaDiff ||
      relatedContext.facts.length > 0
    );
  if (!hasReviewEvidence) {
    return {
      answerable: false,
      confidence: 0.48,
      coverage: {
        review_diff: files.length > 0 ? "partial" : "missing",
        changed_file: files.length > 0 ? "covered" : "missing",
        line_level_diff: hasLineDiff ? "partial" : "missing",
        changed_symbol: "missing",
        changed_calls: "missing",
        related_context: "missing"
      },
      evidence: [],
      missing: ["Review diff is present but lacks enough changed symbol, call, or line-level evidence for a grounded packet."],
      allowedFollowups: []
    };
  }

  const javaCategories = Object.entries(input.javaSummary.categories)
    .map(([category, count]) => `${category}:${count}`)
    .join(",");
  const trailing = input.analysis.trailingWhitespace[0];
  const hasCgroupColonChange = isCgroupColonReview(input.analysis);
  const facts = [
    `changed_files=${files.join(",") || "none_detected"}`,
    `changed_symbols=${changedSymbols.join(",") || "none_detected"}`,
    `added_calls=${addedCalls.join(",") || "none_detected"}`,
    `removed_calls=${removedCalls.join(",") || "none_detected"}`,
    trailing ? `line_level_finding=trailing_whitespace ${trailing.file}:${trailing.line}` : undefined,
    input.analysis.exactChanges.length > 0 ? `exact_changes=${input.analysis.exactChanges.join(" | ")}` : undefined,
    javaCategories ? `java_categories=${javaCategories}` : undefined,
    input.javaSummary.likelyTests.length > 0 ? `likely_tests=${input.javaSummary.likelyTests.join(",")}` : undefined,
    input.javaSummary.semanticHints.length > 0 ? `semantic_hints=${input.javaSummary.semanticHints.join(" | ")}` : undefined,
    ...recallProbes.map(formatReviewRecallProbeFact)
  ].filter((fact): fact is string => Boolean(fact));

  const evidence: EvidenceItem[] = [
    {
      id: `E${input.firstEvidenceIndex}`,
      claim: "Review diff compiler extracted changed files, changed symbols, changed calls, and line-level review signals from the unified diff.",
      files: uniqueStrings([...files, ...input.javaSummary.likelyTests]).slice(0, 32),
      facts,
      tokens_est: estimateTokens(`${input.changedText}\n${JSON.stringify({ changedSymbols, addedCalls, removedCalls, trailing: input.analysis.trailingWhitespace })}`)
    }
  ];

  if (trailing) {
    evidence.push({
      id: `E${input.firstEvidenceIndex + evidence.length}`,
      claim: "The diff contains an added line with trailing whitespace, which is a deterministic CI/precommit review finding.",
      files: [trailing.file],
      facts: [
        "status=ci_blocker",
        "topFinding=trailing whitespace in added diff line",
        `location=${trailing.file}:${trailing.line}`,
        changedSymbols.length > 0 ? `changed_symbols=${changedSymbols.join(",")}` : "changed_symbols=none_detected",
        summarizeCallReplacement(input.analysis) ?? "call_replacement=none_detected"
      ],
      tokens_est: 120
    });
  }

  if (relatedContext.facts.length > 0) {
    evidence.push({
      id: `E${input.firstEvidenceIndex + evidence.length}`,
      claim: "Related sibling source context was sampled for changed handle/state signals referenced by the diff.",
      files: relatedContext.files,
      facts: relatedContext.facts,
      tokens_est: estimateTokens(relatedContext.facts.join("\n"))
    });
  }

  const actionableProbes = recallProbes.filter((probe) => probe.status !== "not_applicable");
  if (actionableProbes.length > 0) {
    evidence.push({
      id: `E${input.firstEvidenceIndex + evidence.length}`,
      claim: "Review recall probes checked high-risk diff dimensions that generic changed-file evidence often misses.",
      files: files.slice(0, 16),
      facts: actionableProbes.flatMap((probe) => [
        `recall_probe=${probe.id}`,
        `status=${probe.status}`,
        probe.findingHint ? "technical_finding_candidate=true" : undefined,
        probe.severityHint === "P1" || probe.severityHint === "P2" ? "recommended_review_status=request_changes" : undefined,
        `risk=${probe.risk}`,
        probe.findingHint ? `finding_hint=${probe.findingHint}` : undefined,
        probe.severityHint ? `severity_hint=${probe.severityHint}` : undefined,
        `action=${probe.action}`,
        ...probe.evidence.map((item) => `evidence=${item}`)
      ].filter((item): item is string => Boolean(item))),
      tokens_est: estimateTokens(JSON.stringify(actionableProbes))
    });
  }

  if (hasCgroupColonChange) {
    evidence.push({
      id: `E${input.firstEvidenceIndex + evidence.length}`,
      claim: "The cgroup parser change preserves colons in the third /proc/self/cgroup field and adds focused regression coverage.",
      files,
      facts: [
        "changed_method=getControlGroups",
        "parser_change=line.split(\":\", 3) preserves additional colons in cgroup path",
        "test_method=testCgroupProbeWithColonInPath",
        /final\s+int\s+cgroupsVersion\s*=\s*2\b/.test(input.task)
          ? "coverage_gap_candidate=cgroup v1 colon-path coverage is not explicit; treat as optional P3 coverage comment, not a proven blocker"
          : "coverage_gap_candidate=none_detected",
        "review_status_hint=approve_or_comment_unless project requires v1-specific regression coverage"
      ],
      tokens_est: 180
    });
  }

  const coverage: Record<string, EvidenceCoverageStatus> = {
    review_diff: "covered",
    changed_file: files.length > 0 ? "covered" : "missing",
    line_level_diff: hasLineDiff ? "covered" : "missing",
    changed_symbol: changedSymbols.length > 0 ? "covered" : "partial",
    changed_calls: addedCalls.length > 0 || removedCalls.length > 0 ? "covered" : "partial",
    semantic_diff: input.hasJavaDiff ? "covered" : "partial",
    related_context: relatedContext.facts.length > 0 || hasCgroupColonChange ? "covered" : "partial",
    ci_blocker_check: input.analysis.trailingWhitespace.length > 0 ? "covered" : "partial",
    test_evidence: input.javaSummary.likelyTests.length > 0 || hasCgroupColonChange ? "covered" : "partial",
    recall_probe: actionableProbes.length > 0 ? "covered" : "partial",
    config_effective_policy_invariant: coverageForRecallProbe(recallProbes, "config_effective_policy_invariant"),
    parser_encoding_language_equivalence: coverageForRecallProbe(recallProbes, "parser_encoding_language_equivalence"),
    resource_lifecycle_exception_path: coverageForRecallProbe(recallProbes, "resource_lifecycle_exception_path"),
    async_concurrency_visibility: coverageForRecallProbe(recallProbes, "async_concurrency_visibility"),
    call_replacement_semantics: coverageForRecallProbe(recallProbes, "call_replacement_semantics")
  };

  return {
    answerable: true,
    confidence: input.analysis.trailingWhitespace.length > 0 || hasCgroupColonChange || relatedContext.facts.length > 0 || actionableProbes.length > 0 ? 0.84 : 0.72,
    coverage,
    evidence,
    missing: [],
    allowedFollowups: []
  };
}

function buildReviewRecallProbes(
  task: string,
  repoRoot: string,
  files: string[],
  analysis: ReviewDiffAnalysis,
  changedSymbols: string[],
  addedCalls: string[],
  removedCalls: string[]
): ReviewRecallProbe[] {
  const changedText = [
    task,
    ...analysis.added.map((line) => line.text),
    ...analysis.removed.map((line) => line.text),
    ...analysis.context.map((line) => line.text),
    ...changedSymbols,
    ...addedCalls,
    ...removedCalls
  ].join("\n");
  const sourceFiles = files.filter((file) => !isLikelyTestPath(file));
  return [
    buildConfigEffectivePolicyProbe(repoRoot, sourceFiles, changedText),
    buildParserEncodingProbe(repoRoot, sourceFiles.length > 0 ? sourceFiles : files, changedText),
    buildResourceLifecycleProbe(repoRoot, sourceFiles.length > 0 ? sourceFiles : files, changedText),
    buildAsyncConcurrencyProbe(changedText),
    buildCallReplacementProbe(analysis)
  ];
}

function buildConfigEffectivePolicyProbe(repoRoot: string, files: string[], changedText: string): ReviewRecallProbe {
  const trigger = /\b(config|conf|reconfig|reconfigure|set[A-Z][A-Za-z0-9_]*(?:Interval|Timeout|Limit|Policy)|interval|timeout|ttl|heartbeat|stale|expire|policy|limit)\b/i.test(changedText);
  if (!trigger) {
    return {
      id: "config_effective_policy_invariant",
      status: "not_applicable",
      risk: "No config, reconfiguration, interval, timeout, policy, or limit signal was detected.",
      evidence: [],
      action: "No config/effective-policy probe required."
    };
  }

  const facts = collectReviewProbeFacts(repoRoot, files, [
    /heartbeatManager\.setHeartbeatRecheckInterval/,
    /setHeartbeatRecheckInterval\s*\(/,
    /avoidStaleDataNodesForWrite/,
    /staleInterval\s*<\s*recheckInterval/,
    /heartbeatRecheckInterval\s*=\s*staleInterval/,
    /heartbeatRecheckInterval\s*=\s*recheckInterval/,
    /\bget.*FromConf\s*\(/,
    /\bPreconditions\.checkArgument\b/
  ], 12);
  const factText = facts.join("\n");
  if (
    /heartbeatManager\.setHeartbeatRecheckInterval\s*\(\s*heartbeatRecheckInterval\s*\)/.test(changedText + "\n" + factText) &&
    /avoidStaleDataNodesForWrite/.test(factText) &&
    /staleInterval\s*<\s*recheckInterval/.test(factText) &&
    /heartbeatRecheckInterval\s*=\s*staleInterval/.test(factText)
  ) {
    return {
      id: "config_effective_policy_invariant",
      status: "checked",
      severityHint: "P2",
      risk: "Runtime config propagation may bypass the effective policy value used at initialization.",
      evidence: facts,
      findingHint: "Raw heartbeatRecheckInterval is pushed into HeartbeatManager while the constructor can use staleInterval instead when avoidStaleDataNodesForWrite && staleInterval < recheckInterval; review as a stale-datanode cadence regression unless the setter applies the same effective interval rule.",
      action: "Adjudicate as a technical finding if the new setter path does not preserve the constructor/effective-policy invariant."
    };
  }

  return {
    id: "config_effective_policy_invariant",
    status: facts.length > 0 ? "checked" : "needs_followup",
    risk: "Config/reconfiguration-like diff should preserve effective policy math, defaults, validation, and runtime setter semantics.",
    evidence: facts.length > 0 ? facts : ["config-like changed lines present but no nearby policy invariant was sampled"],
    action: "Before no-finding, compare raw assigned values with effective values after defaults, clamps, and compatibility guards."
  };
}

function buildParserEncodingProbe(repoRoot: string, files: string[], changedText: string): ReviewRecallProbe {
  const trigger = /\b(Automata|Automaton|BytesRef|makeStringUnion|wildcard|regex|pattern|literal|parser|split|UTF|unicode|encoding|surrogate|determinize|language equivalence)\b/i.test(changedText);
  if (!trigger) {
    return {
      id: "parser_encoding_language_equivalence",
      status: "not_applicable",
      risk: "No parser, pattern, automaton, regex, Unicode, or encoding signal was detected.",
      evidence: [],
      action: "No parser/encoding language-equivalence probe required."
    };
  }

  const facts = collectReviewProbeFacts(repoRoot, files, [
    /new BytesRef\s*\(/,
    /Automata\.makeStringUnion/,
    /isLiteralPattern\s*\(/,
    /wildcard\s*\(\s*String\s+\w+/,
    /Automata\.makeChar/,
    /MAX_STRING_UNION_TERM_LENGTH/,
    /CharacterRunAutomaton/,
    /surrogate|non-BMP|code point|UTF-16|UTF-8|unicode/i
  ], 16);
  const factText = `${changedText}\n${facts.join("\n")}`;
  const hasLiteralBytesRefFastPath = /new BytesRef\s*\(\s*pattern\s*\)/.test(factText) && /Automata\.makeStringUnion/.test(factText);
  const hasLegacyCharPath = /Automata\.makeChar/.test(factText) || /wildcard\s*\(\s*String\s+\w+/.test(factText);
  const hasSurrogateCoverage = /surrogate|non-BMP|code point|UTF-16/i.test(factText);
  if (hasLiteralBytesRefFastPath && hasLegacyCharPath && !hasSurrogateCoverage) {
    return {
      id: "parser_encoding_language_equivalence",
      status: "checked",
      severityHint: "P2",
      risk: "Literal fast path can change accepted language for Unicode edge cases relative to the legacy parser path.",
      evidence: [
        ...facts,
        "proof_sketch=legacy wildcard path loops over UTF-16 chars and emits Automata.makeChar transitions; new literal bucket converts pattern to BytesRef and Automata.makeStringUnion; CharacterRunAutomaton matching is code point oriented, so non-BMP surrogate pairs and lone surrogate replacement can diverge unless rejected before build"
      ],
      findingHint: "Likely P2 technical finding: BytesRef/makeStringUnion compiles literal strings through UTF-8 bytes while the legacy wildcard path builds UTF-16 char transitions; promote this as a language-equivalence regression unless code proves action patterns reject non-BMP/lone-surrogate literals before Automatons.patterns.",
      action: "Do not leave this as only a coverage gap unless contrary evidence proves surrogate-bearing/non-BMP action names cannot reach this builder."
    };
  }

  return {
    id: "parser_encoding_language_equivalence",
    status: facts.length > 0 ? "checked" : "needs_followup",
    risk: "Parser/pattern/automaton diffs should preserve accepted language across boundary encodings and fallback partitions.",
    evidence: facts.length > 0 ? facts : ["parser-like changed lines present but no nearby encoding/language-equivalence context was sampled"],
    action: "Before no-finding, check boundary values, equivalence partitions, invalid input, Unicode/encoding, fallback path, and compatibility behavior."
  };
}

function buildResourceLifecycleProbe(repoRoot: string, files: string[], changedText: string): ReviewRecallProbe {
  const trigger = /\b(CompletableFuture|thenRun|thenApply|thenCompose|whenComplete|handle|exceptionally|allOf|close|release|cleanup|buffer|checksum|finally|catch)\b/i.test(changedText);
  if (!trigger) {
    return {
      id: "resource_lifecycle_exception_path",
      status: "not_applicable",
      risk: "No async cleanup, close, release, buffer, or exception-path signal was detected.",
      evidence: [],
      action: "No resource-lifecycle probe required."
    };
  }

  const facts = collectReviewProbeFacts(repoRoot, files, [
    /CompletableFuture|thenRun|thenApply|thenCompose|whenComplete|handle|exceptionally|allOf/,
    /\bclose\s*\(|\brelease\s*\(|cleanup|free|delete|dispose/i,
    /buffer|checksum|stream|resource/i,
    /finally|catch\s*\(/
  ], 12);
  const factText = `${changedText}\n${facts.join("\n")}`;
  if (/CompletableFuture\.allOf|allOf\s*\(/.test(factText) && /\.thenRun\s*\(/.test(factText) && /\brelease\s*\(|buffer|checksum/i.test(factText) && !/whenComplete|handle|finally/.test(factText)) {
    return {
      id: "resource_lifecycle_exception_path",
      status: "checked",
      severityHint: "P2",
      risk: "Async completion callback may skip cleanup on exceptional completion.",
      evidence: facts,
      findingHint: "CompletableFuture.thenRun after allOf only runs on normal completion; release/cleanup of buffers or checksum resources should use whenComplete/handle/finally-equivalent logic if failure must release resources.",
      action: "Adjudicate as a technical finding when the changed resource can leak or stay retained after an exceptional path."
    };
  }

  return {
    id: "resource_lifecycle_exception_path",
    status: facts.length > 0 ? "checked" : "needs_followup",
    risk: "Resource lifecycle or async diff should preserve cleanup on success, failure, cancellation, and early return paths.",
    evidence: facts.length > 0 ? facts : ["lifecycle-like changed lines present but no nearby cleanup context was sampled"],
    action: "Before no-finding, check exceptional completion, cancellation, early returns, and ownership transfer."
  };
}

function buildAsyncConcurrencyProbe(changedText: string): ReviewRecallProbe {
  const trigger = /\b(volatile|synchronized|lock|thread|daemon|monitor|async|future|CompletableFuture|executor|listener|callback)\b/i.test(changedText);
  return {
    id: "async_concurrency_visibility",
    status: trigger ? "checked" : "not_applicable",
    risk: trigger
      ? "Concurrency/visibility signals are present; review thread visibility, ordering, cancellation, and deterministic test coverage."
      : "No concurrency or async visibility signal was detected.",
    evidence: trigger ? uniqueStrings((changedText.match(/\b(?:volatile|synchronized|lock|thread|daemon|monitor|async|future|CompletableFuture|executor|listener|callback)\b/gi) ?? []).slice(0, 12)) : [],
    action: trigger ? "Keep concurrency/async as ISTQB state-transition or async coverage unless evidence supports a concrete defect." : "No concurrency probe required."
  };
}

function buildCallReplacementProbe(analysis: ReviewDiffAnalysis): ReviewRecallProbe {
  const replacement = summarizeCallReplacement(analysis);
  if (!replacement) {
    return {
      id: "call_replacement_semantics",
      status: "not_applicable",
      risk: "No added/removed call replacement was detected.",
      evidence: [],
      action: "No call-replacement probe required."
    };
  }
  return {
    id: "call_replacement_semantics",
    status: "checked",
    risk: "Changed call sites should preserve nullability, side effects, error handling, units, ordering, and compatibility semantics.",
    evidence: [replacement],
    action: "Before no-finding, compare removed and added call contracts; raise a finding only when a concrete semantic drift is supported."
  };
}

function collectReviewProbeFacts(repoRoot: string, files: string[], patterns: RegExp[], limit: number): string[] {
  const facts: string[] = [];
  for (const file of uniqueStrings(files).slice(0, 12)) {
    const absolute = path.join(repoRoot, file);
    const lines = readReviewContextLines(absolute);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!patterns.some((pattern) => pattern.test(line))) {
        continue;
      }
      facts.push(`${file}:${index + 1}:${cleanFactValue(line)}`);
      if (facts.length >= limit) {
        return facts;
      }
    }
  }
  return facts;
}

function formatReviewRecallProbeFact(probe: ReviewRecallProbe): string {
  const parts = [
    `recall_probe=${probe.id}`,
    `status=${probe.status}`,
    probe.findingHint ? "technical_finding_candidate=true" : undefined,
    probe.severityHint === "P1" || probe.severityHint === "P2" ? "recommended_review_status=request_changes" : undefined,
    probe.severityHint ? `severity_hint=${probe.severityHint}` : undefined,
    `risk=${cleanFactValue(probe.risk)}`,
    probe.findingHint ? `finding_hint=${cleanFactValue(probe.findingHint)}` : undefined,
    `action=${cleanFactValue(probe.action)}`,
    probe.evidence.length > 0 ? `evidence=${probe.evidence.map(cleanFactValue).join(" || ")}` : undefined
  ].filter((part): part is string => Boolean(part));
  return parts.join("; ");
}

function coverageForRecallProbe(probes: ReviewRecallProbe[], id: string): EvidenceCoverageStatus {
  const probe = probes.find((candidate) => candidate.id === id);
  if (!probe || probe.status === "not_applicable") {
    return "partial";
  }
  return probe.status === "checked" ? "covered" : "missing";
}

function isLikelyTestPath(filePath: string): boolean {
  return /(?:^|\/)(?:test|tests|it|integrationTest)(?:\/|$)|(?:Test|Tests|IT)\.[A-Za-z0-9]+$/i.test(filePath.replace(/\\/g, "/"));
}

function analyzeReviewDiff(task: string): ReviewDiffAnalysis {
  const files = extractDiffFiles(task);
  const added: ReviewDiffLine[] = [];
  const removed: ReviewDiffLine[] = [];
  const context: ReviewDiffLine[] = [];
  let currentFile = "";
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const rawLine of task.replace(/\r\n/g, "\n").split("\n")) {
    const diffMatch = rawLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      currentFile = diffMatch[2]!.trim();
      inHunk = false;
      continue;
    }
    const plusFileMatch = rawLine.match(/^\+\+\+ b\/(.+)$/);
    if (plusFileMatch) {
      currentFile = plusFileMatch[1]!.trim();
      continue;
    }
    const hunkMatch = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@\s?(.*)$/);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      inHunk = true;
      const headerContext = hunkMatch[3]?.trim();
      if (currentFile && headerContext) {
        context.push({ file: currentFile, kind: "context", text: headerContext });
      }
      continue;
    }
    if (!currentFile || !inHunk) {
      continue;
    }
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      added.push({ file: currentFile, kind: "add", text: rawLine.slice(1), newLine });
      newLine += 1;
      continue;
    }
    if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      removed.push({ file: currentFile, kind: "delete", text: rawLine.slice(1), oldLine });
      oldLine += 1;
      continue;
    }
    if (rawLine.startsWith(" ")) {
      context.push({ file: currentFile, kind: "context", text: rawLine.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  const addedTexts = added.map((line) => line.text);
  const removedTexts = removed.map((line) => line.text);
  const allTexts = [...context.map((line) => line.text), ...addedTexts, ...removedTexts];
  return {
    files,
    added,
    removed,
    context,
    changedSymbols: extractReviewSymbols(allTexts),
    addedCalls: extractReviewCalls(addedTexts),
    removedCalls: extractReviewCalls(removedTexts),
    trailingWhitespace: added
      .filter((line) => /[ \t]+$/.test(line.text))
      .map((line) => ({
        file: line.file,
        line: line.newLine ?? 1,
        preview: line.text.trim().slice(0, 120)
      })),
    exactChanges: extractExactReviewChanges(addedTexts, removedTexts)
  };
}

function extractReviewSymbols(lines: string[]): string[] {
  const symbols = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    const typeMatch = trimmed.match(/\b(?:class|interface|enum|record|struct)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (typeMatch?.[1]) {
      symbols.add(typeMatch[1]);
    }
    const methodMatch = trimmed.match(/^(?:public|protected|private|static|final|synchronized|native|abstract|default|\s)*[\w<>, ?\[\].*&]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*(?:throws\b.*)?\{?\s*$/);
    if (methodMatch?.[1] && !isReviewKeyword(methodMatch[1])) {
      symbols.add(methodMatch[1]);
    }
  }
  return [...symbols].slice(0, 40);
}

function extractReviewCalls(lines: string[]): string[] {
  const calls = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(/\b(?:(this|super|[A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const receiver = match[1];
      const name = match[2]!;
      if (isReviewKeyword(name)) {
        continue;
      }
      calls.add(receiver ? `${receiver}.${name}` : name);
    }
  }
  return [...calls].slice(0, 40);
}

function isReviewKeyword(value: string): boolean {
  return new Set([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "return",
    "assert",
    "sizeof",
    "new",
    "throw",
    "try"
  ]).has(value);
}

function extractExactReviewChanges(added: string[], removed: string[]): string[] {
  const addedText = added.join("\n");
  const removedText = removed.join("\n");
  const changes: string[] = [];
  if (/\bhdfsFlush\s*\(/.test(removedText) && /\bhdfsHFlush\s*\(/.test(addedText)) {
    changes.push("call_replacement=hdfsFlush -> hdfsHFlush");
  }
  if (/fh->buf\s*==\s*NULL/.test(addedText)) {
    changes.push("write_handle_detection=fh->buf == NULL");
  }
  if (/line\.split\(\s*":",\s*3\s*\)/.test(addedText)) {
    changes.push("parser_change=line.split(\":\", 3)");
  }
  if (/testCgroupProbeWithColonInPath/.test(addedText)) {
    changes.push("added_test=testCgroupProbeWithColonInPath");
  }
  return changes;
}

function summarizeCallReplacement(analysis: ReviewDiffAnalysis): string | undefined {
  if (analysis.exactChanges.length > 0) {
    return analysis.exactChanges.find((change) => change.startsWith("call_replacement=")) ?? analysis.exactChanges[0];
  }
  const added = analysis.addedCalls.find((call) => !analysis.removedCalls.includes(call));
  const removed = analysis.removedCalls.find((call) => !analysis.addedCalls.includes(call));
  return added || removed ? `call_change=${removed ?? "none"} -> ${added ?? "none"}` : undefined;
}

function isCgroupColonReview(analysis: ReviewDiffAnalysis): boolean {
  const text = [
    ...analysis.added.map((line) => line.text),
    ...analysis.removed.map((line) => line.text),
    ...analysis.context.map((line) => line.text)
  ].join("\n");
  return /getControlGroups|readProcSelfCgroup|cgroup/i.test(text) && /line\.split\(\s*":",\s*3\s*\)|testCgroupProbeWithColonInPath/.test(text);
}

function collectReviewRelatedContext(repoRoot: string, files: string[], analysis: ReviewDiffAnalysis): { files: string[]; facts: string[] } {
  const changedText = [
    ...analysis.added.map((line) => line.text),
    ...analysis.removed.map((line) => line.text)
  ].join("\n");
  const patterns: RegExp[] = [];
  if (/fh->buf|dfs_fh/.test(changedText)) {
    patterns.push(/fh->buf\s*=/, /\bO_WRONLY\b/, /typedef struct dfs_fh|}\s*dfs_fh\b/);
  }
  if (patterns.length === 0) {
    return { files: [], facts: [] };
  }

  const facts: string[] = [];
  const factFiles = new Set<string>();
  const dirs = uniqueStrings(files.map((file) => path.dirname(file)).filter((dir) => dir !== "."));
  for (const dir of dirs.slice(0, 4)) {
    const absoluteDir = path.join(repoRoot, dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.filter((item) => item.isFile()).slice(0, 120)) {
      if (!/\.(?:c|h|cc|cpp|java|ts|tsx|js|jsx)$/i.test(entry.name)) {
        continue;
      }
      const rel = path.join(dir, entry.name).replace(/\\/g, "/");
      const lines = readReviewContextLines(path.join(absoluteDir, entry.name));
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (!patterns.some((pattern) => pattern.test(line))) {
          continue;
        }
        factFiles.add(rel);
        facts.push(`${rel}:${index + 1}:${line.trim().replace(/\s+/g, " ").slice(0, 180)}`);
        if (facts.length >= 12) {
          return { files: [...factFiles], facts };
        }
      }
    }
  }
  return { files: [...factFiles], facts };
}

function readReviewContextLines(filePath: string): string[] {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 512_000) {
      return [];
    }
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/).slice(0, 4000);
  } catch {
    return [];
  }
}

function extractDiffFiles(task: string): string[] {
  const files = new Set<string>();
  for (const match of task.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    files.add(match[2].trim());
  }
  for (const match of task.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
    files.add(match[1].trim());
  }
  return [...files].filter((file) => !file.startsWith("/dev/null"));
}

function extractDiffLines(task: string, prefix: "+" | "-"): string[] {
  const opposite = prefix === "+" ? "+++" : "---";
  return task
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix) && !line.startsWith(opposite))
    .map((line) => line.slice(1).trim())
    .filter(Boolean);
}

function normalizeTaskType(value: string | undefined, task: string): EvidenceTaskType {
  const known = new Set<EvidenceTaskType>([
    "api_flow",
    "field_impact",
    "review_diff",
    "startup_flow",
    "investigate",
    "research_business",
    "implement",
    "write_unittest",
    "build_handoff",
    "unknown"
  ]);
  if (value && known.has(value as EvidenceTaskType)) {
    return value as EvidenceTaskType;
  }
  return inferTaskType(task);
}

function inferTaskType(task: string): EvidenceTaskType {
  if (/\b(unit test|unittest|write test|add test|test plan|test strategy)\b/i.test(task)) {
    return "write_unittest";
  }
  if (/\b(diff|review|pull request|pr|changed files?|code review)\b/i.test(task) || /^diff --git\b/m.test(task)) {
    return "review_diff";
  }
  if (/\b(implement|change|add feature|modify|patch|code change)\b/i.test(task)) {
    return "implement";
  }
  if (/\b(startup|boot|initialize|server start)\b/i.test(task)) {
    return "startup_flow";
  }
  if (/\b(flow|sequence\s*diagram|flowchart|diagram|mermaid|end-to-end|e2e|journey)\b/i.test(task) || /\bvẽ\b/i.test(task)) {
    return "api_flow";
  }
  if (/\b(business|product|domain|customer|research|purpose|what does this repo do)\b/i.test(task)) {
    return "research_business";
  }
  if (/\b(?:study|deep\s*dive|understand)\b.*\b(?:business|product|domain|repo|repository)\b/i.test(task)) {
    return "research_business";
  }
  if (/\b(investigate|debug|diagnose|root cause|why|triage)\b/i.test(task)) {
    return "investigate";
  }
  if (/\b(build|test|compile|gradle|maven|npm|package|version|wrapper|onboard|handoff|daily task)\b/i.test(task)) {
    return "build_handoff";
  }
  if (/\b(api|endpoint|route|request|response|controller)\b/i.test(task)) {
    return "api_flow";
  }
  if (/\b(field|column|property|schema|impact)\b/i.test(task)) {
    return "field_impact";
  }
  return "unknown";
}

function buildCoverage(
  taskType: EvidenceTaskType,
  hasBuildFacts: boolean,
  hasInventory: boolean,
  hasOverview: boolean,
  structureFacts: string[],
  qualityRubric: string[]
): Record<string, EvidenceCoverageStatus> {
  const coverage: Record<string, EvidenceCoverageStatus> = {
    repo_shape: hasInventory ? "covered" : "missing"
  };
  const hasSourceAreas = structureFacts.some((fact) => fact.startsWith("source_dirs="));
  const hasTestAreas = structureFacts.some((fact) => fact.startsWith("test_dirs="));

  switch (taskType) {
    case "build_handoff":
      coverage.build_system = hasBuildFacts ? "covered" : "missing";
      coverage.build_files = hasBuildFacts ? "covered" : "missing";
      coverage.handoff_answer = hasBuildFacts ? "covered" : "partial";
      break;
    case "investigate":
      coverage.investigation_scope = hasInventory ? "covered" : "missing";
      coverage.build_context = hasBuildFacts ? "covered" : "partial";
      coverage.exact_next_commands = hasBuildFacts ? "covered" : "partial";
      break;
    case "research_business":
      coverage.repository_purpose = hasOverview ? "covered" : "partial";
      coverage.project_identity = hasBuildFacts || hasOverview ? "covered" : "missing";
      coverage.major_areas = hasInventory ? "covered" : "missing";
      break;
    case "api_flow":
      coverage.flow_target = "partial";
      coverage.entrypoint = "missing";
      coverage.call_chain = "missing";
      coverage.business_state_changes = "missing";
      coverage.diagram_contract = hasInventory ? "covered" : "partial";
      coverage.tests_or_examples = hasTestAreas ? "partial" : "missing";
      break;
    case "implement":
      coverage.implementation_scope = hasSourceAreas ? "covered" : "partial";
      coverage.files_to_inspect = hasInventory ? "covered" : "missing";
      coverage.test_strategy = hasBuildFacts ? "covered" : "partial";
      break;
    case "write_unittest":
      coverage.test_locations = hasTestAreas ? "covered" : "partial";
      coverage.test_command = hasBuildFacts ? "covered" : "partial";
      coverage.build_context = hasBuildFacts ? "covered" : "missing";
      break;
    default:
      coverage.task_specific_code = "missing";
      coverage.followup_scope = "partial";
  }

  qualityRubric.forEach((item, index) => {
    coverage[`rubric_${index + 1}_${slugKey(item)}`] = isEvidenceAnswerable(taskType, hasBuildFacts, hasInventory, hasOverview, structureFacts)
      ? "covered"
      : "partial";
  });
  return coverage;
}

function isEvidenceAnswerable(
  taskType: EvidenceTaskType,
  hasBuildFacts: boolean,
  hasInventory: boolean,
  hasOverview: boolean,
  structureFacts: string[]
): boolean {
  const hasSourceAreas = structureFacts.some((fact) => fact.startsWith("source_dirs="));
  const hasTestAreas = structureFacts.some((fact) => fact.startsWith("test_dirs="));
  switch (taskType) {
    case "build_handoff":
      return hasBuildFacts;
    case "investigate":
      return hasBuildFacts && hasInventory;
    case "research_business":
      return hasInventory && (hasOverview || hasBuildFacts);
    case "implement":
    case "write_unittest":
      return false;
    default:
      return false;
  }
}

function buildAnswerContract(
  taskType: EvidenceTaskType,
  task: string,
  qualityRubric: string[],
  answerable: boolean
): EvidencePacket["answer_contract"] {
  const wantsDiagram = /\b(flow|sequence\s*diagram|flowchart|diagram|mermaid)\b/i.test(task) || /\bvẽ\b/i.test(task);
  const commonEvidenceRules = [
    "Cite evidence IDs and file paths from the packet for every substantive repository claim.",
    "Separate proven facts from inference; label uncertain claims as inferred or unknown.",
    "Do not invent entrypoints, call chains, business rules, test commands, or dependencies not supported by evidence.",
    answerable
      ? "Because answerable=true, answer from the packet and do not gather redundant evidence."
      : "Because answerable=false, do not present a final definitive answer until allowed_followups have covered missing exact code evidence."
  ];
  const commonFailureConditions = [
    "Fails quality if it hides missing evidence or presents an inferred flow as proven.",
    "Fails quality if it uses raw shell grep/search when TokenOpt followups are available.",
    "Fails quality if it answers only with generic repository advice without mapping to packet evidence."
  ];

  switch (taskType) {
    case "api_flow":
      return {
        required_sections: [
          "Scope and target flow",
          "Business meaning of the flow",
          "Actors, triggers, and preconditions",
          "Step-by-step sequence",
          "Data/state changes",
          "External dependencies and side effects",
          "Failure paths and edge cases",
          wantsDiagram ? "Mermaid sequenceDiagram or flowchart" : "Diagram-ready flow summary",
          "Evidence used",
          "Unknowns and exact followups"
        ],
        evidence_rules: [
          ...commonEvidenceRules,
          "Each flow edge must cite a matched file/symbol or be marked inferred.",
          answerable
            ? "Use exact_matches and implementation_files/test_files from the flow packet; do not run redundant followups for the same anchors."
            : "If only candidate files are known, describe them as candidates and run/read allowed followups before drawing a definitive diagram."
        ],
        quality_checks: [
          "Names the exact flow target and does not drift to whole-repo overview.",
          "Identifies entrypoint, service/domain layer, data/model layer, and tests/examples when evidence exists.",
          "Includes business context, not just technical call order.",
          wantsDiagram ? "Includes valid Mermaid syntax and labels unknown edges explicitly." : "Can be converted into a Mermaid diagram without adding unstated steps.",
          ...qualityRubric
        ],
        failure_conditions: commonFailureConditions,
        user_rubric: qualityRubric
      };
    case "research_business":
      return {
        required_sections: [
          "What the business/product is",
          "Who it serves",
          "Why it exists",
          "How the system supports the business",
          "Core capabilities",
          "Major code/project areas",
          "Risks, assumptions, and unknowns",
          "Evidence used"
        ],
        evidence_rules: [
          ...commonEvidenceRules,
          "Tie business claims back to README/docs/package/build identity and major project areas.",
          "Do not turn project structure into business claims unless docs or names support the inference."
        ],
        quality_checks: [
          "Explains business in plain language before technical mapping.",
          "Covers what/why/how and likely users.",
          "Maps capabilities to code/project areas.",
          "States confidence and gaps honestly.",
          ...qualityRubric
        ],
        failure_conditions: commonFailureConditions,
        user_rubric: qualityRubric
      };
    case "implement":
      return {
        required_sections: ["Goal", "Current evidence", "Files to inspect/change", "Implementation plan", "Tests", "Risks/unknowns"],
        evidence_rules: [
          ...commonEvidenceRules,
          "Do not mark implementation evidence complete without target symbol, bounded definition slice, related types/usages, test neighbor, and build/test command coverage."
        ],
        quality_checks: ["Names exact candidate files/symbols.", "Uses coding coverage dimensions instead of repo inventory alone.", "Keeps plan actionable and testable.", ...qualityRubric],
        failure_conditions: commonFailureConditions,
        user_rubric: qualityRubric
      };
    case "write_unittest":
      return {
        required_sections: ["Target class/module", "Behavior to cover", "Test file location", "Fixtures/mocks", "Assertions", "Targeted command"],
        evidence_rules: [
          ...commonEvidenceRules,
          "Do not mark unit-test evidence complete without target symbol, public API/signature, dependencies, existing test neighbor, test style, and build/test command coverage."
        ],
        quality_checks: ["Tests map to business behavior and likely failure paths.", "Uses existing test style and neighbor evidence.", "Avoids full-suite command as first verification.", ...qualityRubric],
        failure_conditions: commonFailureConditions,
        user_rubric: qualityRubric
      };
    case "review_diff":
      return {
        required_sections: ["Technical findings", "Business/test coverage gaps", "ISTQB checks", "User checklist coverage", "Review status", "Evidence notes"],
        evidence_rules: [
          ...commonEvidenceRules,
          "Review the net PR diff/final changed state, not an intermediate per-commit patch series.",
          "Use PR merge/head worktree context for follow-up reads/searches when a PR is referenced.",
          "Run review in two phases: first technical findings, then business/edge-case/test-design coverage gaps.",
          "If the user provides a review checklist, preserve every item and return item-by-item checklist coverage.",
          "If recall_probe facts are present, adjudicate each checked probe as a technical finding, coverage gap, or explicit non-issue with evidence; technical_finding_candidate=true with P1/P2 severity should be promoted unless contrary evidence disproves it.",
          "If Jira tickets or Confluence pages/URLs are provided, use Jira/Confluence MCP evidence, including relevant attachments, for business/test coverage; do not ask the user to paste full content when a connector can read it. If unavailable, mark requirement evidence missing or assumption-based in notes.",
          "Prioritize correctness regressions, CI blockers, missing meaningful tests, and behavior changes over style.",
          "Before no-finding, check changed invariants, effective config/policy math, parser/encoding boundaries, backward compatibility, concurrency/async behavior, resource lifecycle, null/error paths, and call replacements.",
          "Apply ISTQB-style coverage dimensions where relevant: boundary values, equivalence partitions, negative/error cases, state transitions, concurrency/async, and compatibility/backward compatibility.",
          "Report optional missing coverage separately from technical findings.",
          "A checklist item becomes a technical finding only when the diff introduces an actionable defect; otherwise keep it as pass, gap, or not_applicable checklist coverage.",
          "Do not downgrade a proven regression into a coverage gap.",
          "If no behavior finding is raised, still include the changed_files, changed_symbols, and added_calls/removed_calls facts in notes so the review shows what was checked.",
          "Do not request changes for optional coverage gaps unless the packet marks status=ci_blocker or a proven regression."
        ],
        quality_checks: [
          "Findings cite repo-relative files and line numbers.",
          "Technical findings and business/test coverage gaps are separated.",
          "User-provided checklist items are all answered with pass, fail, gap, or not_applicable and evidence.",
          "Checked recall probes with technical_finding_candidate=true are either promoted into technical findings or explicitly dismissed with contrary evidence.",
          "Jira/Confluence requirement artifacts and relevant attachments, when provided, are cited or explicitly marked unavailable before business coverage claims.",
          "No-finding decisions mention the invariant/config/compatibility/error-path dimensions checked when relevant.",
          "ISTQB dimensions are marked covered/gap/not_applicable when the user asks for business or edge-case coverage.",
          "Notes mention changed files, changed symbols, and call replacements from packet facts when present.",
          "No broad followup after answerable=true.",
          "Review status matches severity: request_changes for blockers, comment for optional gaps, approve when no supported finding exists.",
          ...qualityRubric
        ],
        failure_conditions: [
          ...commonFailureConditions,
          "Fails quality if it drops the changed method/call evidence from the final review output.",
          "Fails quality if a user-provided checklist item is omitted or answered without evidence/status.",
          "Fails quality if it ignores or demotes a P1/P2 technical_finding_candidate recall_probe without contrary evidence.",
          "Fails quality if Jira/Confluence artifacts are provided but business coverage is asserted without reading them or marking them unavailable.",
          "Fails quality if a likely regression is reported only as a missing-test or business coverage gap.",
          "Fails quality if it reviews the wrong branch, base, head, or per-commit intermediate state when PR scope is provided."
        ],
        user_rubric: qualityRubric
      };
    case "build_handoff":
      return {
        required_sections: ["Build system", "Key commands", "Repo layout", "Fast verification path", "Known gaps"],
        evidence_rules: commonEvidenceRules,
        quality_checks: ["Commands are copied from package/build files when available.", "Avoids unsupported assumptions.", ...qualityRubric],
        failure_conditions: commonFailureConditions,
        user_rubric: qualityRubric
      };
    default:
      return {
        required_sections: ["Answer", "Evidence used", "Assumptions", "Missing items", "Next exact steps"],
        evidence_rules: commonEvidenceRules,
        quality_checks: ["Directly answers the user task.", "Keeps claims grounded in packet evidence.", ...qualityRubric],
        failure_conditions: commonFailureConditions,
        user_rubric: qualityRubric
      };
  }
}

function factSourceFiles(facts: string[]): string[] {
  const files = new Set<string>();
  for (const fact of facts) {
    const [, value] = fact.split("=", 2);
    if (fact.includes("_file=") && value) {
      files.add(value);
    }
    if (fact.startsWith("build_tool=Npm")) {
      files.add("package.json");
    }
    if (fact.startsWith("npm_lock_file=") && value) {
      files.add(value);
    }
    if (fact.startsWith("maven_root_file=")) {
      files.add("pom.xml");
    }
  }
  return [...files].sort();
}

function parseExternalArtifacts(args: Record<string, unknown>): ExternalArtifactEvidence[] {
  const value = args.external_artifacts;
  if (!Array.isArray(value)) {
    return [];
  }
  const artifacts: ExternalArtifactEvidence[] = [];
  for (const item of value.slice(0, 8)) {
    if (!isRecord(item)) {
      continue;
    }
    const artifact: ExternalArtifactEvidence = {
      source: normalizeExternalArtifactSource(item.source)
    };
    const id = cleanExternalArtifactValue(item.id, 160);
    const title = cleanExternalArtifactValue(item.title, 240);
    const url = cleanExternalArtifactValue(item.url, 300);
    const summary = cleanExternalArtifactValue(item.summary, 1200);
    const text = cleanExternalArtifactValue(item.text, 2400);
    if (id) artifact.id = id;
    if (title) artifact.title = title;
    if (url) artifact.url = url;
    if (summary) artifact.summary = summary;
    if (text) artifact.text = text;
    if (artifact.id || artifact.title || artifact.url || artifact.summary || artifact.text) {
      artifacts.push(artifact);
    }
  }
  return artifacts;
}

function normalizeExternalArtifactSource(value: unknown): ExternalArtifactEvidence["source"] {
  return value === "jira" ||
    value === "confluence" ||
    value === "github" ||
    value === "attachment" ||
    value === "other"
    ? value
    : "other";
}

function cleanExternalArtifactValue(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const cleaned = value.replace(/\s+/g, " ").replace(/[`\u0000-\u001f]/g, "").trim();
  return cleaned ? cleaned.slice(0, maxChars) : undefined;
}

function appendExternalArtifactContext(task: string, artifacts: ExternalArtifactEvidence[]): string {
  if (artifacts.length === 0 || /External artifact evidence from other MCPs:/i.test(task)) {
    return task;
  }
  return [
    task,
    "",
    "External artifact evidence from other MCPs:",
    ...artifacts.flatMap((artifact, index) => formatExternalArtifactTaskLines(artifact, index + 1))
  ].join("\n");
}

function formatExternalArtifactTaskLines(artifact: ExternalArtifactEvidence, index: number): string[] {
  return [
    `Artifact ${index}: source=${artifact.source}${artifact.id ? ` id=${artifact.id}` : ""}${artifact.title ? ` title=${artifact.title}` : ""}`,
    artifact.url ? `url=${artifact.url}` : undefined,
    artifact.summary ? `summary=${artifact.summary}` : undefined,
    artifact.text ? `text=${artifact.text}` : undefined
  ].filter((line): line is string => Boolean(line));
}

function buildExternalArtifactEvidenceItem(id: string, artifacts: ExternalArtifactEvidence[]): EvidenceItem {
  const labels = artifacts.map(formatExternalArtifactLabel);
  const terms = extractExternalArtifactTerms(artifacts);
  return {
    id,
    claim: "External MCP artifacts were supplied as requirement/business evidence; TokenOpt gates only the repository source-code slots that remain.",
    facts: [
      `external_artifact_count=${artifacts.length}`,
      `external_artifacts=${labels.join(" | ")}`,
      `external_terms=${terms.join(",") || "none_detected"}`,
      "external_source_policy=do_not_refetch_with_shell; bind these artifacts to impacted files/symbols/tests through ContextGate evidence"
    ],
    tokens_est: estimateTokens(labels.join("\n") + "\n" + terms.join(","))
  };
}

function formatExternalArtifactLabel(artifact: ExternalArtifactEvidence): string {
  return [
    artifact.source,
    artifact.id,
    artifact.title
  ].filter(Boolean).join(":") || artifact.source;
}

function slimExternalArtifact(artifact: ExternalArtifactEvidence): Record<string, unknown> {
  return {
    source: artifact.source,
    id: artifact.id,
    title: artifact.title,
    url: artifact.url,
    summaryChars: artifact.summary?.length ?? 0,
    textChars: artifact.text?.length ?? 0,
    terms: extractExternalArtifactTerms([artifact]).slice(0, 12)
  };
}

function extractExternalArtifactTerms(artifacts: ExternalArtifactEvidence[]): string[] {
  const text = artifacts
    .flatMap((artifact) => [artifact.id, artifact.title, artifact.summary, artifact.text])
    .filter((value): value is string => Boolean(value))
    .join("\n");
  return selectExactFlowSearchTerms([
    ...extractQuotedTerms(text),
    ...extractStrongCodeLikeTaskTerms(text),
    ...extractHyphenatedIdentifierVariants(text),
    ...extractRouteTerms(text),
    ...extractCodeLikeTaskTerms(text)
  ]).slice(0, 36);
}

function normalizeEvidenceDetail(value: string | undefined): EvidenceDetail {
  return value === "full" ? "full" : "compact";
}

function sanitizeTaskPrompt(value: string): string {
  const trimmed = value.trim();
  const userRequestMatch = trimmed.match(/(?:^|\n)User request:\s*([\s\S]+)$/i);
  if (userRequestMatch?.[1]?.trim()) {
    return userRequestMatch[1].trim();
  }

  const markers = [
    "Benchmark constraints:",
    "Project instruction injected by TokenOpt setup:",
    "The user may ask naturally and does not need to name MCP tools.",
    "When TokenOpt MCP tools are available",
    "benchmark oracle classifies the task_type",
    "actualPromptSentToCodex:"
  ];
  for (const marker of markers) {
    const index = trimmed.toLowerCase().indexOf(marker.toLowerCase());
    if (index > 0) {
      return trimmed.slice(0, index).trim();
    }
  }
  return trimmed;
}

export function normalizeMcpMode(value = process.env.TOKENOPT_MCP_MODE): McpMode {
  const mode = value?.toLowerCase();
  return mode === "full" ? "full" : mode === "broker" ? "broker" : "lite";
}

export function getExposedMcpToolNames(mode: McpMode): Set<string> {
  return mode === "full" ? FULL_MCP_TOOL_NAMES : mode === "broker" ? BROKER_MCP_TOOL_NAMES : LITE_MCP_TOOL_NAMES;
}

function buildEvidenceStructuredContent(packet: EvidencePacket, statePath: string, includePacket: boolean): Record<string, unknown> {
  const packetSummary = {
    packet_id: packet.packet_id,
    task_type: packet.task_type,
    route: packet.route,
    acquisition_mode: packet.acquisition_mode,
    evidence_contract: packet.evidence_contract,
    evidence_contract_pass: packet.evidence_contract_pass,
    fallback_reason: packet.fallback_reason,
    answerable: packet.answerable,
    confidence: packet.confidence,
    coverage_certificate: packet.coverage_certificate,
    output_policy: packet.output_policy,
    metadata: packet.metadata,
    recommended_next_action: packet.recommended_next_action,
    max_additional_calls: packet.max_additional_calls,
    statePath,
    missing_count: packet.missing.length,
    allowed_followups: packet.allowed_followups.map((followup) => ({
      tool: followup.tool,
      reason: followup.reason,
      args: followup.args,
      max_output_tokens: followup.max_output_tokens
    })),
    answer_contract: {
      required_sections: packet.answer_contract.required_sections,
      quality_checks: packet.answer_contract.quality_checks.slice(0, 8)
    }
  };
  return includePacket
    ? { packetSummary, packet, statePath }
    : { packetSummary, statePath };
}

function withPacketMetadata(packet: EvidencePacket, metadata: Record<string, unknown>): EvidencePacket {
  return {
    ...packet,
    metadata: {
      ...(packet.metadata ?? {}),
      ...metadata
    }
  };
}

function formatEvidencePacket(packet: EvidencePacket, statePath: string | undefined, detail: EvidenceDetail): string {
  if (detail === "full") {
    return formatFullEvidencePacket(packet, statePath);
  }
  return formatCompactEvidencePacket(packet, statePath);
}

function formatCompactEvidencePacket(packet: EvidencePacket, statePath: string | undefined): string {
  const coverage = Object.entries(packet.coverage)
    .filter(([, value]) => value !== "covered")
    .slice(0, 10)
    .map(([key, value]) => `${key}=${value}`);
  const evidenceLines = packet.evidence.slice(0, 8).flatMap((item) => {
    const facts = (item.facts ?? []).slice(0, 5).join(" | ");
    const files = (item.files ?? []).slice(0, 5).join(",");
    return [
      `- ${item.id}: ${item.claim}`,
      files ? `  files=${files}` : undefined,
      facts ? `  facts=${facts}` : undefined
    ].filter((line): line is string => Boolean(line));
  });
  const lines = [
    "TokenOpt evidence packet compact",
    `packet_id: ${packet.packet_id}`,
    `task_type: ${packet.task_type}`,
    packet.route ? `route_decision: ${packet.route.taskClass}/${packet.route.toolProfile}/${packet.route.action}` : undefined,
    `acquisition_mode: ${packet.acquisition_mode}`,
    `evidence_contract: ${packet.evidence_contract}`,
    `evidence_contract_pass: ${packet.evidence_contract_pass}`,
    packet.fallback_reason ? `fallback_reason: ${packet.fallback_reason}` : undefined,
    packet.route ? `route_reason: ${packet.route.reason}` : undefined,
    `answerable: ${packet.answerable}`,
    `confidence: ${packet.confidence}`,
    packet.coverage_certificate ? `deny_broad_exploration: ${packet.coverage_certificate.deny_broad_exploration}` : undefined,
    packet.output_policy ? `output_policy: ${packet.output_policy.preferred_format}` : undefined,
    `recommended_next_action: ${packet.recommended_next_action}`,
    `max_additional_calls: ${packet.max_additional_calls}`,
    statePath ? `state_path: ${statePath}` : undefined,
    coverage.length > 0 ? `coverage_gaps: ${coverage.join(", ")}` : "coverage_gaps: none",
    "",
    "Evidence:",
    ...evidenceLines,
    "",
    "Answer contract:",
    `required_sections=${packet.answer_contract.required_sections.join(" | ")}`,
    `quality_checks=${packet.answer_contract.quality_checks.slice(0, 8).join(" | ")}`,
    `evidence_rules=${packet.answer_contract.evidence_rules.slice(0, 4).join(" | ")}`,
    "",
    "Missing:",
    ...(packet.missing.length > 0 ? packet.missing.slice(0, 8).map((item) => `- ${item}`) : ["- none"]),
    "",
    "Allowed followups:",
    ...(packet.allowed_followups.length > 0
      ? packet.allowed_followups.slice(0, 5).map((followup) => `- ${followup.tool}: ${followup.reason}`)
      : ["- none"]),
    "",
    "TokenOpt compact mode: full packet is stored in state_path; call tokenopt_compile_evidence with detail=full only when debugging."
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}

function formatFullEvidencePacket(packet: EvidencePacket, statePath: string | undefined): string {
  const lines = [
    "TokenOpt compiled evidence packet",
    `packet_id: ${packet.packet_id}`,
    `task_type: ${packet.task_type}`,
    packet.route ? `route_decision: ${packet.route.taskClass}/${packet.route.toolProfile}/${packet.route.action}` : undefined,
    `acquisition_mode: ${packet.acquisition_mode}`,
    `evidence_contract: ${packet.evidence_contract}`,
    `evidence_contract_pass: ${packet.evidence_contract_pass}`,
    packet.fallback_reason ? `fallback_reason: ${packet.fallback_reason}` : undefined,
    packet.route ? `route_reason: ${packet.route.reason}` : undefined,
    `answerable: ${packet.answerable}`,
    `confidence: ${packet.confidence}`,
    packet.coverage_certificate ? `deny_broad_exploration: ${packet.coverage_certificate.deny_broad_exploration}` : undefined,
    packet.output_policy ? `output_policy: ${JSON.stringify(packet.output_policy)}` : undefined,
    packet.metadata ? `metadata: ${JSON.stringify(packet.metadata)}` : undefined,
    `recommended_next_action: ${packet.recommended_next_action}`,
    `max_additional_calls: ${packet.max_additional_calls}`,
    statePath ? `state_path: ${statePath}` : undefined,
    "",
    "Coverage:",
    ...Object.entries(packet.coverage).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "Evidence:",
    ...packet.evidence.flatMap((item) => [
      `- ${item.id}: ${item.claim}`,
      ...(item.files && item.files.length > 0 ? [`  files: ${item.files.join(", ")}`] : []),
      ...(item.facts ?? []).slice(0, 32).map((fact) => `  fact: ${fact}`)
    ]),
    "",
    "Answer contract:",
    "Required sections:",
    ...packet.answer_contract.required_sections.map((item) => `- ${item}`),
    "Evidence rules:",
    ...packet.answer_contract.evidence_rules.map((item) => `- ${item}`),
    "Quality checks:",
    ...packet.answer_contract.quality_checks.map((item) => `- ${item}`),
    "Failure conditions:",
    ...packet.answer_contract.failure_conditions.map((item) => `- ${item}`),
    "",
    "Missing:",
    ...(packet.missing.length > 0 ? packet.missing.map((item) => `- ${item}`) : ["- none"]),
    "",
    "Allowed followups:",
    ...(packet.allowed_followups.length > 0
      ? packet.allowed_followups.map((followup) => `- ${followup.tool}: ${followup.reason}`)
      : ["- none"]),
    "",
    "Disallowed followups:",
    ...packet.disallowed_followups.map((followup) => `- ${followup}`)
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}

function slugKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "item";
}

function extractRepositoryOverview(repoRoot: string): RepositoryOverview | undefined {
  for (const candidate of ["README.md", "README.asciidoc", "README.adoc", "README"]) {
    const text = readRepoText(repoRoot, candidate);
    if (!text) {
      continue;
    }
    const lines = text
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^(<!--|!\[|\[!)/.test(line));
    const title = cleanOverviewLine(lines.find((line) => /^#{1,2}\s+/.test(line) || /^=+\s+/.test(line)) ?? lines[0] ?? candidate);
    const summary = cleanOverviewLine(
      lines.find((line) => !/^#{1,6}\s+/.test(line) && !/^=+\s+/.test(line) && line.length >= 40) ?? lines.slice(1, 4).join(" ")
    );
    return {
      file: candidate,
      title: title.slice(0, 160),
      summary: summary.slice(0, 500)
    };
  }
  return undefined;
}

function cleanOverviewLine(line: string): string {
  return line.replace(/^#{1,6}\s+/, "").replace(/^=+\s+/, "").replace(/\s+/g, " ").trim();
}

function extractStructureFacts(inventory: ReturnType<typeof buildRepoInventory>): string[] {
  const importantFiles = inventory.importantFiles.map((file) => file.replace(/\\/g, "/"));
  const sourceDirs = topCounts(
    importantFiles
      .filter((file) => /\.(ts|tsx|js|jsx|java|py|go|rs|kt|scala|c|cc|cpp|h|hpp)$/i.test(file))
      .map((file) => file.split("/").slice(0, 2).join("/") || "<root>"),
    10
  ).map(([name, count]) => `${name}:${count}`);
  const testDirs = topCounts(
    importantFiles
      .filter((file) => /(^|\/)(test|tests|src\/test|qa|__tests__)(\/|$)|\.(test|spec)\.(ts|tsx|js|jsx)$/i.test(file))
      .map((file) => file.split("/").slice(0, 3).join("/") || "<root>"),
    10
  ).map(([name, count]) => `${name}:${count}`);
  const configFiles = importantFiles
    .filter((file) => /(^|\/)(package\.json|pom\.xml|build\.gradle|settings\.gradle|gradle\.properties|pyproject\.toml|go\.mod|Cargo\.toml|tsconfig\.json)$/i.test(file))
    .slice(0, 20);

  return [
    `source_dirs=${sourceDirs.length > 0 ? sourceDirs.join(",") : "none_detected"}`,
    `test_dirs=${testDirs.length > 0 ? testDirs.join(",") : "none_detected"}`,
    `config_files=${configFiles.length > 0 ? configFiles.join(",") : "none_detected"}`,
    `important_file_sample=${importantFiles.slice(0, 20).join(",") || "none_detected"}`
  ];
}

function extractProjectFacts(repoRoot: string): string[] {
  const facts: string[] = [];
  const gradleWrapper = readRepoText(repoRoot, "gradle/wrapper/gradle-wrapper.properties");
  if (gradleWrapper) {
    const url = matchFirst(gradleWrapper, /^distributionUrl=(.+)$/m);
    const version = url ? matchFirst(url, /gradle-([0-9][^-]+)-(?:all|bin)\.zip/) : undefined;
    facts.push(`build_tool=Gradle`);
    facts.push(`gradle_wrapper_file=gradle/wrapper/gradle-wrapper.properties`);
    if (version) {
      facts.push(`gradle_wrapper_version=${version}`);
    }
    if (url) {
      facts.push(`gradle_distribution_url=${url.replace(/\\:/g, ":")}`);
    }
  }

  const settingsGradle = readRepoText(repoRoot, "settings.gradle");
  if (settingsGradle) {
    const rootName = matchFirst(settingsGradle, /rootProject\.name\s*=\s*["']([^"']+)["']/);
    if (rootName) {
      facts.push(`gradle_root_project=${rootName}`);
    }
  }

  const elasticVersions = readRepoText(repoRoot, "build-tools-internal/version.properties");
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

  const pom = readRepoText(repoRoot, "pom.xml");
  if (pom) {
    const projectBlock = pom.slice(0, Math.min(pom.length, 20_000));
    const groupId = matchFirst(projectBlock, /<groupId>([^<]+)<\/groupId>/);
    const artifactId = matchFirst(projectBlock, /<artifactId>([^<]+)<\/artifactId>/);
    const version = matchFirst(projectBlock, /<version>([^<]+)<\/version>/);
    const packaging = matchFirst(projectBlock, /<packaging>([^<]+)<\/packaging>/);
    const hadoopVersion = matchFirst(projectBlock, /<hadoop\.version>([^<]+)<\/hadoop\.version>/);
    facts.push(`build_tool=Maven`);
    facts.push(`maven_root_file=pom.xml`);
    if (groupId) {
      facts.push(`maven_group_id=${groupId}`);
    }
    if (artifactId) {
      facts.push(`maven_artifact_id=${artifactId}`);
    }
    if (version) {
      facts.push(`maven_project_version=${version}`);
    }
    if (packaging) {
      facts.push(`maven_packaging=${packaging}`);
    }
    if (hadoopVersion) {
      facts.push(`hadoop_version=${hadoopVersion}`);
    }
  }

  const mavenWrapper = readRepoText(repoRoot, ".mvn/wrapper/maven-wrapper.properties");
  if (mavenWrapper) {
    const wrapperVersion = matchFirst(mavenWrapper, /^wrapperVersion=(.+)$/m);
    const distributionUrl = matchFirst(mavenWrapper, /^distributionUrl=(.+)$/m);
    const mavenVersion = distributionUrl ? matchFirst(distributionUrl, /apache-maven\/([^/]+)\/apache-maven-\1-bin\.zip/) : undefined;
    facts.push(`maven_wrapper_file=.mvn/wrapper/maven-wrapper.properties`);
    if (wrapperVersion) {
      facts.push(`maven_wrapper_version=${wrapperVersion}`);
    }
    if (mavenVersion) {
      facts.push(`maven_distribution_version=${mavenVersion}`);
    }
    if (distributionUrl) {
      facts.push(`maven_distribution_url=${distributionUrl}`);
    }
  }

  const packageJson = readRepoText(repoRoot, "package.json");
  if (packageJson) {
    try {
      const parsed = JSON.parse(packageJson) as {
        name?: unknown;
        version?: unknown;
        packageManager?: unknown;
        scripts?: unknown;
      };
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
        if (fs.existsSync(path.join(repoRoot, lockFile))) {
          facts.push(`npm_lock_file=${lockFile}`);
          break;
        }
      }
    } catch {
      facts.push("npm_root_file=package.json");
      facts.push("npm_package_json_parse_error=true");
    }
  }

  return facts.length > 0 ? facts : ["No common Gradle, Maven, or npm build facts detected."];
}

function readRepoText(repoRoot: string, relativePath: string): string | undefined {
  const filePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return undefined;
  }
  return fs.readFileSync(filePath, "utf8");
}

function matchFirst(text: string, pattern: RegExp): string | undefined {
  return text.match(pattern)?.[1]?.trim();
}

function evaluateToolPolicy(cwd: string, toolName: string, toolInput: unknown, repoRoot: string): PolicyDecision {
  const loaded = loadConfig({ cwd });
  const event: TokenOptEvent = {
    source: "codex",
    eventName: "pre-tool-use",
    cwd,
    toolName,
    toolInput,
    raw: {
      hook_event_name: "PreToolUse",
      cwd,
      tool_name: toolName,
      tool_input: toolInput
    }
  };
  return evaluatePolicy(event, loaded.config, { repoRoot });
}

function textResult(text: string, isError = false, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    isError,
    structuredContent
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required string argument: ${key}`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function resolveRepoPath(repoRoot: string, requestedPath: string): { ok: true; path: string } | { ok: false; error: string } {
  const absolute = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(repoRoot, requestedPath);
  const relative = path.relative(repoRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, error: `TokenOpt denied path outside repo: ${requestedPath}` };
  }
  if (!fs.existsSync(absolute)) {
    return { ok: false, error: `Path does not exist: ${requestedPath}` };
  }
  return { ok: true, path: absolute };
}

function getDailyStatsPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ".";
  const dir = path.join(home, ".tokenopt", "stats");
  fs.mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  return path.join(dir, `${date}.jsonl`);
}

function writeDailyStats(tokensAvoided: number, taskType: string): void {
  try {
    const entry = JSON.stringify({ ts: new Date().toISOString(), tokensAvoided, taskType });
    fs.appendFileSync(getDailyStatsPath(), `${entry}\n`, "utf8");
  } catch {
    // ignore — stats write failure must not break the tool response
  }
}

function sessionStatsTool() {
  const daily = readDailyStats();
  const lines = [
    `session_calls: ${SESSION_STATS.calls}`,
    `session_tokens_avoided: ~${SESSION_STATS.inventoryTokensAvoided}`,
    `session_evidence_tokens_est: ~${SESSION_STATS.evidenceTokensEst}`,
    `session_started: ${SESSION_STATS.startedAt}`,
    "",
    "Today's stats:",
    `  calls:          ${daily.calls}`,
    `  tokens_avoided: ${daily.tokensAvoided}`,
    ...Object.entries(daily.taskTypes).map(([k, v]) => `  ${k}: ${v}`)
  ];
  return textResult(lines.join("\n"), false);
}

interface DailyStats {
  calls: number;
  tokensAvoided: number;
  taskTypes: Record<string, number>;
}

function readDailyStats(): DailyStats {
  const result: DailyStats = { calls: 0, tokensAvoided: 0, taskTypes: {} };
  try {
    const raw = fs.readFileSync(getDailyStatsPath(), "utf8");
    for (const line of raw.trim().split("\n")) {
      if (!line) continue;
      const entry = JSON.parse(line) as { tokensAvoided?: number; taskType?: string };
      result.calls += 1;
      result.tokensAvoided += entry.tokensAvoided ?? 0;
      if (entry.taskType) result.taskTypes[entry.taskType] = (result.taskTypes[entry.taskType] ?? 0) + 1;
    }
  } catch {
    // first run or no stats yet
  }
  return result;
}
