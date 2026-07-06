import fs from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { V2Indexer } from '../index/indexer.js';
import { watchWorkspace, type WorkspaceWatchHandle } from '../index/watcher.js';
import { getWorkspacePaths } from '../paths.js';
import { V2QueryService } from '../query/service.js';
import { openCodeGraphDb, type CodeGraphDb } from '../storage/database.js';
import { inspectWorkspaceReadiness } from '../workspace-health.js';
import { isLocalMcpFallbackTool, runLocalMcpFallback } from './local-fallback.js';
import { buildV2ToolDefinitionsForProfile, mcpToolNamesForProfile, parseToolArgs } from './tools.js';
import {
  TOKENOPT_TOOL_DEFINITIONS,
  dispatchTokenoptTool,
  getExposedMcpToolNames,
  normalizeMcpMode,
  type McpMode,
  type TokenoptCodeGraphProvider,
} from '../../tokenopt/mcp.js';
import { parseCodeGraphResult } from '../../tokenopt/codegraph-bridge.js';
import { createGraphSymbolProvider, type GraphSymbolProvider } from '../../tokenopt/coding/graph-symbol-provider.js';

const TOKENOPT_TOOL_NAMES = new Set(TOKENOPT_TOOL_DEFINITIONS.map(tool => tool.name));

export interface RunMcpProxyOptions {
  root: string;
  prewarm?: boolean;
  refreshOnStart?: boolean;
  workspaceKey?: string;
  autoRefresh?: boolean;
  watch?: boolean;
  warnStale?: boolean;
  indexProviders?: string[] | string;
  scipIndexPath?: string;
  mcpProfile?: string;
}

type RegisteredWorkspace = Awaited<ReturnType<V2Indexer['registerWorkspace']>>;
type McpRuntime = {
  db: CodeGraphDb;
  dbPath: string;
  logPath: string;
  indexer: V2Indexer;
  queries: V2QueryService;
  workspace: RegisteredWorkspace;
};

interface CachedRuntimeFailure {
  expiresAt: number;
  payload: Record<string, unknown>;
}

class McpStructuredError extends Error {
  constructor(readonly payload: Record<string, unknown>) {
    super(structuredErrorMessage(payload));
  }
}

export async function runMcpProxy(options: RunMcpProxyOptions): Promise<void> {
  const activeMcpProfile = options.mcpProfile ?? 'client';
  const allowedToolNames = mcpToolNamesForProfile(activeMcpProfile);
  const codegraphToolDefinitions = buildV2ToolDefinitionsForProfile(activeMcpProfile);
  // Single-gate surface (docs/mcp-adoption-plan.md P2): the embedded
  // TokenOpt/ContextGate tools are opt-in. Advertising three near-identical
  // "call FIRST" gates makes the model arbitrate between our own tools before
  // it arbitrates against grep, so the default client surface exposes exactly
  // one entry point — codegraph_context. Full profile keeps the whole toolset;
  // TOKENOPT_MCP_MODE=lite|full|broker restores the tokenopt surface on any
  // profile, TOKENOPT_MCP_MODE=off hides it even on full.
  const tokenoptEnv = process.env.TOKENOPT_MCP_MODE?.trim();
  const tokenoptOff = tokenoptEnv
    ? /^(off|none|0|false|disabled)$/i.test(tokenoptEnv)
    : activeMcpProfile !== 'full';
  const tokenoptMode: McpMode = tokenoptEnv && !tokenoptOff ? normalizeMcpMode(tokenoptEnv) : 'full';
  const tokenoptExposed = tokenoptOff ? new Set<string>() : getExposedMcpToolNames(tokenoptMode);
  const tokenoptToolDefinitions = TOKENOPT_TOOL_DEFINITIONS.filter(tool => tokenoptExposed.has(tool.name));
  const toolDefinitions = [...codegraphToolDefinitions, ...tokenoptToolDefinitions];
  const providerOptions = {
    indexProviders: options.indexProviders,
    scipIndexPath: options.scipIndexPath,
  };
  const shouldPrewarm = options.prewarm !== false;
  let runtimeValue: McpRuntime | undefined;
  let runtimePromise: Promise<McpRuntime> | undefined;
  let runtimeFailure: CachedRuntimeFailure | undefined;
  let watcher: WorkspaceWatchHandle | undefined;
  const runtime = async (): Promise<McpRuntime> => {
    if (runtimeValue) return runtimeValue;
    if (runtimeFailure && runtimeFailure.expiresAt > Date.now()) {
      throw new McpStructuredError(runtimeFailure.payload);
    }
    runtimeFailure = undefined;
    runtimePromise ??= initializeRuntime()
      .then(result => {
        runtimeValue = result;
        runtimeFailure = undefined;
        return result;
      })
      .catch(async error => {
        runtimePromise = undefined;
        const payload = dependencyFailurePayload(error);
        runtimeFailure = {
          expiresAt: Date.now() + mcpCircuitBreakerTtlMs(),
          payload,
        };
        throw new McpStructuredError(payload);
      });
    return runtimePromise;
  };
  const initializeRuntime = async (): Promise<McpRuntime> => {
    const opened = await openCodeGraphDb(options.root);
    const indexer = new V2Indexer(opened.db);
    const queries = new V2QueryService(opened.db);
    let workspace = await indexer.registerWorkspace(options.root, options.workspaceKey);
    if (shouldPrewarm && !workspace.currentSnapshotId) {
      await indexer.indexWorkspace({ root: workspace.root, workspaceKey: options.workspaceKey, ...providerOptions });
      workspace = await indexer.registerWorkspace(workspace.root, options.workspaceKey);
    } else if (options.refreshOnStart) {
      void indexer.indexWorkspace({ root: workspace.root, workspaceKey: options.workspaceKey, ...providerOptions })
        .then(async () => {
          workspace = await indexer.registerWorkspace(workspace.root, options.workspaceKey);
        })
        .catch(error => {
          process.stderr.write(`[codegraph] MCP background refresh startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
        });
    }
    if (options.watch === true && !watcher) {
      watcher = watchWorkspace(workspace.root, changedPaths => {
        void indexer.refreshWorkspacePaths({
          root: workspace.root,
          changedPaths,
          workspaceKey: options.workspaceKey,
          ...providerOptions,
        })
          .then(async () => {
            workspace = await indexer.registerWorkspace(workspace.root, options.workspaceKey);
          })
          .catch(error => {
            logQueryEvent(opened.paths.queryLogPath, {
              event: 'watch.refresh.failed',
              root: workspace.root,
              changedPaths: changedPaths.slice(0, 20),
              error: error instanceof Error ? error.message : String(error),
            });
          });
      });
    }
    return {
      db: opened.db,
      dbPath: opened.dbPath,
      logPath: opened.paths.queryLogPath,
      indexer,
      queries,
      workspace,
    };
  };
  const readyRuntime = async (): Promise<McpRuntime> => {
    const current = await runtime();
    if (!current.workspace.currentSnapshotId) {
      current.workspace = await current.indexer.registerWorkspace(options.root, options.workspaceKey);
    }
    if (shouldPrewarm && !current.workspace.currentSnapshotId) {
      await current.indexer.indexWorkspace({ root: current.workspace.root, workspaceKey: options.workspaceKey, ...providerOptions });
      current.workspace = await current.indexer.registerWorkspace(current.workspace.root, options.workspaceKey);
    }
    if (!current.workspace.currentSnapshotId) {
      throw new McpStructuredError({
        error: {
          code: 'workspace_not_indexed',
          message: `Workspace ${current.workspace.workspaceId} is not indexed yet.`,
          next: 'Run `codegraph index --root <workspace>` or `codegraph setup --root <workspace>` before using the MCP client.',
        },
      });
    }
    return current;
  };

  // Clients truncate long initialize instructions (observed cutoff ≈1,900
  // chars in Claude Code), so the base text stays under 1,500 and the tokenopt
  // addendum only ships when those tools are actually exposed. Appending the
  // full TokenOpt instructions would also reintroduce a second "call FIRST"
  // gate claim — exactly the ambiguity the single-gate surface removes.
  const server = new Server(
    { name: 'codegraph', version: '2.1.0' },
    {
      capabilities: { tools: {} },
      instructions: tokenoptExposed.size > 0
        ? `${MCP_SERVER_INSTRUCTIONS}\n\n${FULL_PROFILE_INSTRUCTIONS_SUFFIX}`
        : MCP_SERVER_INSTRUCTIONS,
    },
  );

  // In-process CodeGraph provider for the TokenOpt ContextGate broker. Replaces
  // the codegraph-bridge.ts subprocess spawn: contextgate_get_context enriches a
  // packet by querying the shared V2QueryService directly (no child process,
  // no double-spend).
  const codeGraphProvider: TokenoptCodeGraphProvider = async (task, budgetTokens) => {
    try {
      const current = await readyRuntime();
      const cgArgs: Record<string, unknown> = {
        task,
        budgetTokens,
        profile: 'compact',
        responseMode: 'agent',
        includeSnippets: true,
        warnStale: false,
      };
      const routed = routeMcpTool('codegraph_context', cgArgs);
      const result = await current.queries.query({
        workspaceId: current.workspace.workspaceId,
        toolName: routed.toolName,
        args: routed.args,
      });
      return parseCodeGraphResult({ content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch {
      return null;
    }
  };

  // In-process accelerator for the TokenOpt coding layer (symbol search, symbol
  // packets, test neighbors, tracebug). Replaces per-call regex-lite repo scans
  // with the shared V2QueryService symbol table when it has the answer; the
  // regex-lite scanner remains the fallback (see coding/graph-symbol-provider.ts).
  const graphSymbolProvider: GraphSymbolProvider = createGraphSymbolProvider(async (toolName, toolArgs) => {
    const current = await readyRuntime();
    return current.queries.query({
      workspaceId: current.workspace.workspaceId,
      toolName,
      args: toolArgs,
    });
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    let args: Record<string, unknown> | undefined;
    const startedAt = Date.now();
    try {
      if (TOKENOPT_TOOL_NAMES.has(request.params.name)) {
        if (!tokenoptExposed.has(request.params.name)) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: {
                  code: 'tool_not_available_in_profile',
                  message: `Tool ${request.params.name} is not exposed in this profile.`,
                  next: 'Call codegraph_context with the full task instead — it runs the same evidence flow. To expose the TokenOpt gate tools, run with --mcp-profile full or set TOKENOPT_MCP_MODE=lite|full|broker.',
                },
              }),
            }],
            isError: true,
          };
        }
        const tokenoptArgs = (request.params.arguments ?? {}) as Record<string, unknown>;
        const tokenoptResult = await dispatchTokenoptTool(request.params.name, tokenoptArgs, tokenoptMode, { codeGraphProvider, graphSymbolProvider });
        logQueryEvent(getWorkspacePaths(options.root).queryLogPath, {
          event: 'query',
          toolName: request.params.name,
          routedToolName: request.params.name,
          durationMs: Date.now() - startedAt,
          responseChars: JSON.stringify(tokenoptResult).length,
          args: summarizeArgs(tokenoptArgs),
        });
        return tokenoptResult;
      }
      if (allowedToolNames && !allowedToolNames.has(request.params.name)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: {
                code: 'tool_not_available_in_profile',
                message: `Tool ${request.params.name} is not available in MCP profile ${activeMcpProfile}. Use codegraph_context or codegraph_slice, or run with --mcp-profile full.`,
              },
            }),
          }],
          isError: true,
        };
      }
      args = parseToolArgs(request.params.name, request.params.arguments);
      if (request.params.name === 'codegraph_status') {
        const result = await codegraphStatus(options.root, args, runtimeValue);
        const serialized = JSON.stringify(result);
        logQueryEvent(getWorkspacePaths(options.root).queryLogPath, {
          event: 'query',
          toolName: request.params.name,
          routedToolName: request.params.name,
          durationMs: Date.now() - startedAt,
          responseChars: serialized.length,
          args: summarizeArgs(args),
          result: summarizeResult(result),
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }
      if (isAnswerPackTool(request.params.name) && options.autoRefresh !== true) {
        args.autoRefresh = false;
      } else if (options.autoRefresh && args.autoRefresh === undefined) {
        args.autoRefresh = true;
      }
      if (args.warnStale === undefined) {
        // Freshness check is cheap (a couple of git calls, cached via
        // freshnessCacheMs) and exists to protect the agent from answering
        // off a stale index, so it is on by default for every tool — not
        // just codegraph_context. The agent can still pass warnStale=false
        // per-call to skip it; options.warnStale === false at server startup
        // forces it off globally as an opt-out for benchmark/perf scenarios.
        args.warnStale = options.warnStale !== false;
      }
      const routed = routeMcpTool(request.params.name, args);
      const current = routed.requiresIndexedWorkspace === false
        ? await runtime()
        : await readyRuntime();
      const result = await current.queries.query({
        workspaceId: current.workspace.workspaceId,
        toolName: routed.toolName,
        args: routed.args,
      });
      const durationMs = Date.now() - startedAt;
      const serialized = JSON.stringify(result);
      logQueryEvent(current.logPath, {
        event: 'query',
        toolName: request.params.name,
        routedToolName: routed.toolName,
        workspaceId: current.workspace.workspaceId,
        durationMs,
        responseChars: serialized.length,
        args: summarizeArgs(args),
        result: summarizeResult(result),
      });
      const enriched = addResponseMeta(result, request.params.name, durationMs, serialized.length);
      return {
        content: [{ type: 'text' as const, text: withFreshnessBanner(JSON.stringify(enriched, null, 2), result) }],
      };
    } catch (error) {
      const payload = errorPayload(error);
      if (args && isLocalMcpFallbackTool(request.params.name) && isFallbackEligible(payload)) {
        const fallback = await runLocalMcpFallback(options.root, request.params.name, args, payload).catch(fallbackError => ({
          error: {
            code: 'local_fallback_failed',
            message: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            original: payload.error,
          },
        }));
        if (fallback && !('error' in fallback)) {
          const routed = routeMcpTool(request.params.name, args);
          const serialized = JSON.stringify(fallback);
          logQueryEvent(getWorkspacePaths(options.root).queryLogPath, {
            event: 'query',
            toolName: request.params.name,
            routedToolName: routed.toolName,
            durationMs: Date.now() - startedAt,
            responseChars: serialized.length,
            args: summarizeArgs(args),
            result: summarizeResult(fallback),
            fallbackReason: summarizeErrorPayload(payload),
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(fallback, null, 2) }],
          };
        }
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  const cleanup = async () => {
    await watcher?.close().catch(() => undefined);
    await runtimeValue?.db.close().catch(() => undefined);
  };
  process.once('SIGINT', () => { void cleanup().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(0)); });
  await server.connect(transport);
  void runtime().catch(error => {
    process.stderr.write(`[codegraph] MCP runtime init failed: ${error instanceof Error ? error.message : String(error)}\n`);
  });
}

export function routeMcpTool(name: string, args: Record<string, unknown>): {
  toolName: string;
  args: Record<string, unknown>;
  requiresIndexedWorkspace?: boolean;
} {
  if (name === 'codegraph_slice') {
    return { toolName: 'get_file_slice', args };
  }
  if (name !== 'codegraph_context') {
    return { toolName: name, args };
  }
  return routeCodeGraphContext(args);
}

export function routeCodeGraphContext(args: Record<string, unknown>): {
  toolName: string;
  args: Record<string, unknown>;
} {
  const task = String(args.task ?? args.target ?? '').trim();
  const target = typeof args.target === 'string' && args.target.trim().length > 0 ? args.target.trim() : task;
  const mode = inferCodeGraphContextMode(task, args);
  const tokenBudget = numberArg(args.budgetTokens, 6000);
  const common = copyDefined({
    profile: args.profile,
    includeSnippets: args.includeSnippets,
    snippetLines: args.snippetLines,
    snippetTokenBudget: args.snippetTokenBudget,
    riskMode: args.riskMode,
    autoRefresh: args.autoRefresh,
    warnStale: args.warnStale,
    debugTiming: args.debugTiming,
  });

  if (mode === 'review') {
    return {
      toolName: 'review_patch',
      args: copyDefined({
        diff: args.diff,
        files: args.files,
        symbols: args.symbols,
        focus: 'general',
        outputMode: args.profile === 'full' ? 'full' : 'compact',
        includeLikelyTests: true,
        ...freshnessArgs(common),
      }),
    };
  }
  if (mode === 'flow') {
    return {
      toolName: 'get_flow_pack',
      args: copyDefined({
        target,
        taskType: 'architecture',
        tokenBudget,
        responseMode: args.responseMode ?? 'answer',
        ...common,
      }),
    };
  }
  if (mode === 'change') {
    return {
      toolName: 'get_change_pack',
      args: copyDefined({
        task,
        target,
        diff: args.diff,
        files: args.files,
        symbols: args.symbols,
        tokenBudget,
        ...common,
      }),
    };
  }
  if (mode === 'evidence') {
    return {
      toolName: 'compile_evidence',
      args: copyDefined({
        task,
        target,
        diff: args.diff,
        files: args.files,
        symbols: args.symbols,
        budgetTokens: tokenBudget,
        ...common,
      }),
    };
  }
  return {
    toolName: 'get_research_pack',
    args: copyDefined({
      target,
      taskType: 'research',
      tokenBudget,
      responseMode: args.responseMode ?? 'answer',
      ...common,
    }),
  };
}

export type CodeGraphContextMode = 'research' | 'flow' | 'change' | 'review' | 'evidence';

export function inspectCodeGraphRoute(args: Record<string, unknown>): Record<string, unknown> {
  const task = String(args.task ?? args.target ?? '').trim();
  const mode = inferCodeGraphContextMode(task, args);
  const routed = routeCodeGraphContext(args);
  const answerReady = routed.toolName === 'compile_evidence';
  const exactSliceFirst = routed.toolName === 'get_change_pack';
  const expectedMaxAdditionalCalls = answerReady ? 0 : exactSliceFirst ? 1 : 0;
  const allowedFollowupTools = answerReady
    ? []
    : exactSliceFirst
      ? ['get_file_slice', 'codegraph_slice']
      : ['codegraph_slice', 'get_file_slice', 'search_symbol', 'search_files', 'search_code'];
  return {
    task,
    inferredMode: mode,
    primaryTool: 'codegraph_context',
    routedTool: routed.toolName,
    routedArgs: routed.args,
    packetContract: {
      requiresAnswerable: routed.toolName === 'compile_evidence',
      requiresAllowedFollowups: true,
      denyBroadShellAfterAnswerable: true,
      denyUnboundedMcpExploration: true,
    },
    expectedStopRule: answerReady
      ? 'answer_from_packet'
      : exactSliceFirst
        ? 'open_exact_slice_once'
        : 'answer_or_expand_exact_followup',
    expectedMaxAdditionalCalls,
    expectedAllowedFollowups: allowedFollowupTools,
    expectedDisallowedFollowups: [
      'shell_rg',
      'shell_read_loop',
      'broad_shell_search',
      'unbounded_file_reads',
      'unbounded_mcp_exploration',
    ],
    gatePolicy: {
      passWhen: [
        'codegraph_context is the first repository-context tool',
        'routed tool matches inferred intent',
        'answerable packets cause zero broad shell/search/read fallback',
        'partial packets use only listed exact follow-ups',
      ],
      failureSignals: [
        'shell/read/search after answerable=true',
        'lower-level search/slice called before codegraph_context for broad tasks',
        'more follow-up calls than expectedMaxAdditionalCalls without an allowed follow-up reason',
      ],
    },
  };
}

export function inferCodeGraphContextMode(task: string, args: Record<string, unknown>): CodeGraphContextMode {
  const explicit = typeof args.mode === 'string' ? args.mode : 'auto';
  if (explicit === 'research' || explicit === 'flow' || explicit === 'change' || explicit === 'review' || explicit === 'evidence') {
    return explicit;
  }
  const text = `${task}\n${typeof args.diff === 'string' ? args.diff.slice(0, 2000) : ''}`.toLowerCase();
  if (typeof args.diff === 'string' && args.diff.trim().length > 0) return 'review';
  if (hasReviewIntent(text)) return 'review';
  if (/\b(evidence|answerable|rubric|coverage|pbi|ticket|story|acceptance criteria)\b/.test(text)) return 'evidence';
  if (hasChangeIntent(text)) return 'change';
  if (hasExplicitFlowIntent(text)) return 'flow';
  return 'research';
}

function hasReviewIntent(text: string): boolean {
  // Review mode produces a diff-anchored packet; without changed material to resolve it
  // can only return a blocked "no-resolved-patch-input" packet. So route to review only on
  // an explicit changed-code artifact, or "review" used as an imperative command on changed
  // material. A bare mention of "review"/"risk"/"finding" as a domain noun (e.g. "spaced
  // repetition review", "due for review", "risk scoring") must not hijack routing.
  if (/\bpull requests?\b|\bpatch(?:es)?\b(?!\s*\/)/.test(text)) return true;
  return /\breview\b[\s\w]{0,24}?\b(?:changes?|diffs?|prs?|pull requests?|patch(?:es)?|commits?|edits?)\b/.test(text);
}

function hasChangeIntent(text: string): boolean {
  return /\b(implement|fix|debug|refactor|change|modify|test|add|remove|update|bug|regression|failure|failing|root cause)\b/.test(text)
    || /\binvestigate\b.*\b(bug|issue|error|failure|failing|regression|timeout|wrong|slow|root cause)\b/.test(text)
    || /\bwhy\b.*\b(fail|fails|failing|error|timeout|wrong|slow|happen|happens)\b/.test(text);
}

function hasExplicitFlowIntent(text: string): boolean {
  return /\b(get|post|put|delete|patch)\s+\//.test(text)
    || /\b(endpoint|api|route|request flow|startup flow|method flow|handler flow|rpc)\b/.test(text)
    || /\btrace\b.*\b(flow|route|endpoint|api|handler|request)\b/.test(text);
}

async function codegraphStatus(
  root: string,
  args: Record<string, unknown>,
  runtime: McpRuntime | undefined,
): Promise<Record<string, unknown>> {
  const readiness = inspectWorkspaceReadiness(root, {
    dbPath: runtime?.dbPath,
    workspaceId: runtime?.workspace.workspaceId,
    snapshotId: runtime?.workspace.currentSnapshotId,
  });
  if (args.includeDiagnostics !== true) {
    return {
      ok: readiness.ok,
      state: readiness.state,
      database: readiness.database,
      artifact: readiness.artifact,
      capabilities: readiness.capabilities,
      freshness: readiness.freshness,
      nextActions: readiness.nextActions,
    };
  }
  return { ...readiness };
}

function dependencyFailurePayload(error: unknown): Record<string, unknown> {
  return {
    error: {
      code: 'runtime_unavailable',
      state: 'sqlite_unavailable',
      message: error instanceof Error ? error.message : String(error),
      retryAfterMs: mcpCircuitBreakerTtlMs(),
      recommendedAction: 'Run `codegraph doctor --root <workspace>` and fix the reported workspace graph issue.',
    },
  };
}

function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof McpStructuredError) return error.payload;
  const message = error instanceof Error ? error.message : String(error);
  if (/is not indexed yet/i.test(message)) {
    return {
      error: {
        code: 'workspace_not_indexed',
        message,
        next: 'Run `codegraph index --root <workspace>` before using CodeGraph MCP for this workspace.',
      },
    };
  }
  return {
    error: {
      code: 'tool_failed',
      message,
      // Errors must never dead-end: always name the recovery path so one bad
      // call does not teach the agent to abandon the server for the session.
      next: 'Retry once. If it persists, run `codegraph doctor --root <workspace>`; for a known exact file/line, codegraph_slice still works directly.',
    },
  };
}

function isFallbackEligible(payload: Record<string, unknown>): boolean {
  const error = payload.error as { code?: unknown; message?: unknown } | undefined;
  const code = String(error?.code ?? '');
  if (code === 'runtime_unavailable' || code === 'workspace_not_indexed') return true;
  if (code !== 'tool_failed') return false;
  return /\b(database|sqlite|connection|timeout|terminated|unavailable|locked)\b/i.test(String(error?.message ?? ''));
}

function logQueryEvent(logPath: string, event: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, 'utf-8');
  } catch {
    // Query logging must never break MCP responses.
  }
}

function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  // sessionId keeps the query log usable as an adoption ledger: it groups the
  // calls of one conversation (see `codegraph adoption-report`).
  for (const key of ['target', 'symbol', 'source', 'module', 'file', 'query', 'task', 'taskType', 'tokenBudget', 'method', 'path', 'sessionId']) {
    const value = args[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      summary[key] = typeof value === 'string' && value.length > 240 ? `${value.slice(0, 237)}...` : value;
    }
  }
  return summary;
}

function summarizeResult(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) return {};
  return copyDefined({
    ok: booleanOrUndefined(result.ok),
    state: stringOrUndefined(result.state),
    degraded: booleanOrUndefined(result.degraded),
    source: stringOrUndefined(result.source),
    answerable: booleanOrUndefined(result.answerable),
    sufficientForAnswer: booleanOrUndefined(result.sufficientForAnswer),
    capabilities: summarizeCapabilities(result.capabilities),
    database: summarizeReadinessComponent(result.database),
    artifact: summarizeReadinessComponent(result.artifact),
    indexFreshness: summarizeIndexFreshness(result.indexFreshness),
    freshness: summarizeIndexFreshness(result.freshness),
    debugTiming: summarizeDebugTiming(result.debugTiming),
  });
}

function summarizeCapabilities(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return copyDefined({
    graphQueries: booleanOrUndefined(value.graphQueries),
    freshGraph: booleanOrUndefined(value.freshGraph),
    embeddedArtifact: booleanOrUndefined(value.embeddedArtifact),
    facadeContext: booleanOrUndefined(value.facadeContext),
  });
}

function summarizeReadinessComponent(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return copyDefined({
    ok: booleanOrUndefined(value.ok),
    state: stringOrUndefined(value.state),
  });
}

function summarizeErrorPayload(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const error = payload.error;
  if (!isRecord(error)) return undefined;
  return copyDefined({
    code: stringOrUndefined(error.code),
    message: stringOrUndefined(error.message),
    next: stringOrUndefined(error.next),
  });
}

function summarizeIndexFreshness(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return copyDefined({
    isStale: booleanOrUndefined(value.isStale),
    warning: stringOrUndefined(value.warning),
    autoRefreshSkipped: isRecord(value.autoRefreshSkipped)
      ? copyDefined({
        reason: stringOrUndefined(value.autoRefreshSkipped.reason),
        indexedFileCount: numberOrUndefined(value.autoRefreshSkipped.indexedFileCount),
        autoRefreshFileLimit: numberOrUndefined(value.autoRefreshSkipped.autoRefreshFileLimit),
      })
      : undefined,
  });
}

function summarizeDebugTiming(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const topPhase = isRecord(value.topPhase)
    ? copyDefined({
      name: stringOrUndefined(value.topPhase.name),
      durationMs: numberOrUndefined(value.topPhase.durationMs),
    })
    : undefined;
  const phaseCount = Array.isArray(value.phases) ? value.phases.length : undefined;
  return copyDefined({
    totalMs: numberOrUndefined(value.totalMs),
    phaseCount,
    topPhase,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function withFreshnessBanner(text: string, result: unknown): string {
  if (!isRecord(result)) return text;
  const freshness = result.indexFreshness;
  if (!isRecord(freshness) || freshness.isStale !== true) return text;
  const dirtyFiles = freshness.dirtyFiles;
  const samples = isRecord(dirtyFiles) && isRecord(dirtyFiles.samples) ? dirtyFiles.samples : undefined;
  const names = samples
    ? [
      ...(Array.isArray(samples.modified) ? samples.modified : []),
      ...(Array.isArray(samples.added) ? samples.added : []),
      ...(Array.isArray(samples.deleted) ? samples.deleted : []),
    ].slice(0, 10)
    : [];
  const list = names.length ? `: ${names.join(', ')}` : '';
  return `⚠️ Index may be stale${list}. Read these files directly if precision matters.\n\n${text}`;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function structuredErrorMessage(payload: Record<string, unknown>): string {
  const error = payload.error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return JSON.stringify(payload);
}

function mcpCircuitBreakerTtlMs(): number {
  const raw = Number(process.env.CODEGRAPH_MCP_CIRCUIT_BREAKER_TTL_MS ?? 30_000);
  if (!Number.isFinite(raw) || raw < 0) return 30_000;
  return Math.min(Math.floor(raw), 300_000);
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function copyDefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function freshnessArgs(args: Record<string, unknown>): Record<string, unknown> {
  return copyDefined({
    autoRefresh: args.autoRefresh,
    warnStale: args.warnStale,
  });
}

function addResponseMeta(
  result: unknown,
  toolName: string,
  durationMs: number,
  responseChars: number
): unknown {
  if (!isRecord(result)) return result;
  const tokensEst = Math.ceil(responseChars / 4);
  const symbolCount = Array.isArray(result.symbols) ? result.symbols.length : undefined;
  const callEdgeCount = Array.isArray(result.callEdges) ? result.callEdges.length : undefined;
  const fileCount = Array.isArray(result.files) ? result.files.length : undefined;
  const meta: Record<string, unknown> = {
    tool: toolName,
    duration_ms: durationMs,
    response_chars: responseChars,
    tokens_est: tokensEst
  };
  if (symbolCount !== undefined) meta.symbols_returned = symbolCount;
  if (callEdgeCount !== undefined) meta.call_edges_returned = callEdgeCount;
  if (fileCount !== undefined) meta.files_returned = fileCount;
  // Terminal-packet nudge: the stop rule travels with the packet itself, not
  // only in (truncatable) server instructions.
  if (result.answerable === true || result.sufficientForAnswer === true) {
    meta.next = result.trustPosture === 'spot_check_recommended'
      ? 'answerable=true, trustPosture=spot_check_recommended — answer from this packet, but verify any fact listed in verifyBudget via its verify.tool before asserting it; do not re-search or re-read other ground.'
      : 'answerable=true — answer from this packet; do not re-search or re-read the same ground.';
  }
  return { ...result, _codegraph_meta: meta };
}

export const MCP_SERVER_INSTRUCTIONS = `# CodeGraph — pre-indexed repository context

The workspace is pre-indexed into a code graph (symbols, calls, dependencies, endpoints). One codegraph_context call returns a bounded evidence packet — ranked files, call/dependency edges, line-numbered source — for a whole task, replacing a grep->read->grep loop (benchmarked: ~20% fewer tokens, ~5x fewer tool round-trips than raw file reads).

Session reuse first: pass the same sessionId string on EVERY call in a conversation. Already-delivered slices then return reusedFromEarlierCall=true with no text body — you already have that source; do NOT re-open it with other tools. Re-fetch one slice via codegraph_slice (or freshEvidence=true) only if it truly left your context.

Routing:
- Any repository question, or before any edit -> codegraph_context with the user's task verbatim.
- answerable=true or sufficientForAnswer=true -> answer from the packet; no grep/read/shell re-verification of the same ground.
- Packet names an exact missing file/line/symbol -> codegraph_slice (batch via slices[]).
- codegraph_status is diagnostic only.

Trust the packet: evidenceSlices are already-read source; when facts are missing the packet lists its own followups — use those, not broad search. Index missing/stale errors name the exact fix command (codegraph index); run it once, retry. Do not set autoRefresh=true unless the user asks for a fresh index.`;

/**
 * Appended to the base instructions only when the TokenOpt/pack tool surface is
 * actually exposed (full profile or explicit TOKENOPT_MCP_MODE). Kept to a
 * single paragraph so the combined text still survives client truncation, and
 * phrased so codegraph_context stays the one first-call gate.
 */
export const FULL_PROFILE_INSTRUCTIONS_SUFFIX = `Full profile addendum: direct pack tools (get_research_pack, get_flow_pack, get_change_pack, review_patch, compile_evidence) and the TokenOpt/ContextGate gate tools (contextgate_get_context, tokenopt_compile_evidence, tokenopt_search, tokenopt_read_file) are exposed for benchmark and power-user flows. codegraph_context remains the first call for broad tasks; it routes to the same packs.`;

function isAnswerPackTool(name: string): boolean {
  return name === 'get_flow_pack' || name === 'get_research_pack';
}