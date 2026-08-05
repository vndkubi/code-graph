import fs from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { V2Indexer } from '../index/indexer.js';
import { watchWorkspace, type WorkspaceWatchHandle } from '../index/watcher.js';
import { getWorkspacePaths } from '../paths.js';
import { ReviewPullRequestUseCase } from '../application/review-use-case.js';
import type { CiReviewResult } from '../query/ci-review.js';
import { hasExplicitReviewPayload, resolveReviewInput, type ReviewInput } from '../query/review-input.js';
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
import { CheckpointConflictError, CheckpointStateStore, type CheckpointPhase, type CheckpointState } from '../checkpoint.js';

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
  checkpoints: CheckpointStateStore;
};

type McpReviewPacket = Record<string, unknown> & {
  answerable: boolean;
  sufficientForAnswer: boolean;
  reviewStatus: string;
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
      checkpoints: new CheckpointStateStore(options.root),
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
      if (request.params.name === 'codegraph_checkpoint') {
        const current = await runtime();
        const result = dispatchCheckpoint(current.checkpoints, args);
        const serialized = JSON.stringify(result);
        logQueryEvent(current.logPath, {
          event: 'query',
          toolName: request.params.name,
          routedToolName: request.params.name,
          durationMs: Date.now() - startedAt,
          responseChars: serialized.length,
          args: summarizeArgs(args),
          result: summarizeResult(result),
          checkpoint: true,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      }
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
      if (request.params.name === 'codegraph_context') {
        const reviewPacket = await executeMcpReviewIfRequested(options, args, providerOptions);
        if (reviewPacket) {
          const durationMs = Date.now() - startedAt;
          const serialized = JSON.stringify(reviewPacket);
          logQueryEvent(getWorkspacePaths(options.root).queryLogPath, {
            event: 'query',
            toolName: request.params.name,
            routedToolName: 'review_for_ci',
            durationMs,
            responseChars: serialized.length,
            args: summarizeArgs(args),
            result: summarizeResult(reviewPacket),
            reviewInput: reviewPacket.reviewInput,
          });
          const enriched = addResponseMeta(reviewPacket, request.params.name, durationMs, serialized.length);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(enriched, null, 2) }],
          };
        }
      }
      const routed = routeMcpTool(request.params.name, args);
      const current = routed.requiresIndexedWorkspace === false
        ? await runtime()
        : await readyRuntime();
      const effectiveArgs = request.params.name === 'codegraph_context' && typeof args.resumeTaskId === 'string'
        ? resumeContextArgs(current.checkpoints, args)
        : args;
      const routedWithResume = request.params.name === 'codegraph_context' ? routeMcpTool(request.params.name, effectiveArgs) : routed;
      const rawResult = isRecord(effectiveArgs._resumeBlocked)
        ? effectiveArgs._resumeBlocked
        : await current.queries.query({
          workspaceId: current.workspace.workspaceId,
          toolName: routedWithResume.toolName,
          args: routedWithResume.args,
        });
      const result = applyContextScopeGate(effectiveArgs, rawResult);
      const durationMs = Date.now() - startedAt;
      const serialized = JSON.stringify(result);
      logQueryEvent(current.logPath, {
        event: 'query',
        toolName: request.params.name,
        routedToolName: routedWithResume.toolName,
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
    runtimeValue?.checkpoints.close();
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

/**
 * Resolve review-only facade calls before the generic review_patch router. A
 * PR URL or branch range is a source locator, not a diff; the CLI already has
 * the safe immutable-worktree and batched-review pipeline, so MCP reuses it
 * here instead of returning a misleading zero-file review packet.
 */
export async function executeMcpReviewIfRequested(
  options: RunMcpProxyOptions,
  args: Record<string, unknown>,
  providerOptions: { indexProviders?: string[] | string; scipIndexPath?: string },
): Promise<McpReviewPacket | undefined> {
  const task = String(args.task ?? args.target ?? '').trim();
  if (inferCodeGraphContextMode(task, args) !== 'review' || hasExplicitReviewPayload(args)) return undefined;

  let input: ReviewInput | undefined;
  try {
    input = resolveReviewInput(task, args);
  } catch (error) {
    return missingMcpReviewInputPacket(task, undefined, error instanceof Error ? error.message : String(error));
  }
  if (!input) {
    return missingMcpReviewInputPacket(
      task,
      undefined,
      'A review needs a GitHub PR URL, baseRef/headRef, or an explicit unified diff/files payload.',
    );
  }

  try {
    const execution = await new ReviewPullRequestUseCase().execute({
      sourceRoot: options.root,
      input,
      isolateRangeWorkspace: true,
      focus: 'general',
      ...providerOptions,
    });
    return mcpReviewPacket(execution.review, input, task, execution.reviewRoot);
  } catch (error) {
    return missingMcpReviewInputPacket(
      task,
      input,
      error instanceof Error ? error.message : String(error),
      'input-resolution-failed',
    );
  }
}

function mcpReviewPacket(
  review: CiReviewResult,
  input: ReviewInput,
  task: string,
  reviewRoot: string,
): McpReviewPacket {
  const changedFiles = Array.isArray(review.changedFiles) ? review.changedFiles.map(String) : [];
  const reviewStatus = typeof review.reviewStatus === 'string' ? review.reviewStatus : 'unknown';
  const originalCoverage = isRecord(review.coverage) ? review.coverage : undefined;
  const coverage = originalCoverage ?? {
    complete: reviewStatus === 'no-changes' || reviewStatus === 'no-reviewable-changes',
    batchCount: 0,
    reviewableFileCount: changedFiles.length,
    graphResolvedFileCount: changedFiles.length,
    reviewableHunkCount: 0,
    reviewedHunkCount: 0,
    omittedFiles: [],
    omittedHunks: 0,
  };
  const answerable = coverage.complete === true && reviewStatus !== 'incomplete-coverage';
  const followup = reviewFollowupArgs(task, input);
  return {
    ...review,
    reviewRoot,
    reviewInput: input,
    reviewStatus,
    reviewFindings: review.findings,
    answerable,
    sufficientForAnswer: answerable,
    coverage,
    allowedFollowups: answerable ? [] : [{ tool: 'codegraph_context', args: followup }],
    disallowedFollowups: ['broad_shell_search', 'unbounded_file_reads', 'unbounded_mcp_exploration'],
    nextAction: answerable
      ? 'Answer from this complete review packet; do not re-run broad repository search.'
      : 'Retry codegraph_context with the exact review source shown in allowedFollowups before answering.',
    stopRule: answerable
      ? 'answerable=true: answer from the packet.'
      : 'answerable=false: use the exact codegraph_context follow-up; do not substitute broad shell search.',
    reviewMetrics: {
      changedFileCount: changedFiles.length,
      reviewableFileCount: numberOrUndefined(coverage.reviewableFileCount) ?? changedFiles.length,
      graphResolvedFileCount: numberOrUndefined(coverage.graphResolvedFileCount) ?? changedFiles.length,
      reviewableHunkCount: numberOrUndefined(coverage.reviewableHunkCount) ?? 0,
      reviewedHunkCount: numberOrUndefined(coverage.reviewedHunkCount) ?? 0,
    },
  };
}

function missingMcpReviewInputPacket(
  task: string,
  input: ReviewInput | undefined,
  reason: string,
  reviewStatus = 'input-unresolved',
): McpReviewPacket {
  const followup = reviewFollowupArgs(task, input);
  return {
    answerable: false,
    sufficientForAnswer: false,
    reviewStatus,
    reviewInput: input ?? { kind: 'missing' },
    changedFiles: [],
    reviewFindings: [{
      id: 'review-input-unresolved',
      ruleId: 'review-input-unresolved',
      priority: 'P1',
      category: 'correctness',
      title: 'Review source could not be resolved',
      why: reason,
      suggestedCheck: 'Provide a GitHub PR URL, baseRef/headRef, or a unified diff.',
      confidence: 0.99,
    }],
    coverage: {
      complete: false,
      batchCount: 0,
      reviewableFileCount: 0,
      graphEligibleFileCount: 0,
      graphResolvedFileCount: 0,
      reviewableHunkCount: 0,
      reviewedHunkCount: 0,
      omittedFiles: [],
      omittedHunks: 0,
    },
    missingFacts: [reason],
    allowedFollowups: [{ tool: 'codegraph_context', args: followup }],
    disallowedFollowups: ['broad_shell_search', 'unbounded_file_reads', 'unbounded_mcp_exploration'],
    nextAction: 'Retry codegraph_context with prUrl or baseRef/headRef; the review cannot be answered from zero patch input.',
    stopRule: 'answerable=false: resolve the review source before producing findings.',
    reviewMetrics: {
      changedFileCount: 0,
      reviewableFileCount: 0,
      graphResolvedFileCount: 0,
      reviewableHunkCount: 0,
      reviewedHunkCount: 0,
    },
  };
}

function reviewFollowupArgs(task: string, input: ReviewInput | undefined): Record<string, unknown> {
  return copyDefined({
    task,
    ...(input?.kind === 'pull_request' ? { prUrl: input.prUrl } : {}),
    ...(input?.kind === 'range' ? { baseRef: input.baseRef, headRef: input.headRef } : {}),
  });
}

export function routeCodeGraphContext(args: Record<string, unknown>): {
  toolName: string;
  args: Record<string, unknown>;
} {
  const task = String(args.task ?? args.target ?? '').trim();
  const target = typeof args.target === 'string' && args.target.trim().length > 0 ? args.target.trim() : task;
  const mode = inferCodeGraphContextMode(task, args);
  const fieldImpactSymbol = fieldImpactSymbolForTask(task, target);
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
    sessionId: args.sessionId,
    freshEvidence: args.freshEvidence,
    scopePlan: args.scopePlan,
    resumeTaskId: args.resumeTaskId,
  });

  if (mode === 'review') {
    return {
      toolName: 'review_patch',
      args: copyDefined({
        task,
        diff: args.diff,
        files: args.files,
        symbols: args.symbols,
        prUrl: args.prUrl,
        baseRef: args.baseRef,
        headRef: args.headRef,
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
        changeType: fieldImpactSymbol ? 'investigate' : undefined,
        diff: args.diff,
        files: args.files,
        symbols: args.symbols ?? (fieldImpactSymbol ? [fieldImpactSymbol] : undefined),
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
  const plannedIntent = isRecord(args.scopePlan) && typeof args.scopePlan.intent === 'string'
    ? args.scopePlan.intent
    : undefined;
  if (plannedIntent === 'research' || plannedIntent === 'flow' || plannedIntent === 'change' || plannedIntent === 'review' || plannedIntent === 'evidence') {
    return plannedIntent;
  }
  const text = `${task}\n${typeof args.diff === 'string' ? args.diff.slice(0, 2000) : ''}`.toLowerCase();
  if (typeof args.diff === 'string' && args.diff.trim().length > 0) return 'review';
  if (hasReviewIntent(text)) return 'review';
  if (hasChangeIntent(text)) return 'change';
  if (hasExplicitFlowIntent(text)) return 'flow';
  if (hasEvidenceIntent(text)) return 'evidence';
  return 'research';
}

function hasEvidenceIntent(text: string): boolean {
  if (/\b(pbi|ticket|user story|acceptance criteria)\b/.test(text)) return true;
  if (/\b(answerable|rubric|coverage)\b/.test(text)) return true;
  return /\b(compile|collect|prove|audit|evaluate|assess)\b[^\n]{0,80}\b(evidence|answerability|rubric|coverage)\b/.test(text);
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
  return /\b(implement|fix|debug|refactor|chang(?:e|es|ed|ing)|modif(?:y|ies|ied|ying|ication|ications)|test|add|remove|update|bug|regression|failure|failing|root cause)\b/.test(text)
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
  if (error instanceof CheckpointConflictError) {
    return {
      error: {
        code: 'checkpoint_version_conflict',
        message: error.message,
        taskId: error.taskId,
        expectedVersion: error.expectedVersion,
        actualVersion: error.actualVersion,
        next: 'Reload the explicit taskId and retry with expectedVersion equal to actualVersion.',
      },
    };
  }
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
  for (const key of ['target', 'symbol', 'source', 'module', 'file', 'query', 'task', 'taskType', 'tokenBudget', 'method', 'path', 'sessionId', 'taskId', 'action', 'version', 'expectedVersion', 'prUrl', 'baseRef', 'headRef']) {
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
    relevanceGate: isRecord(result.relevanceGate)
      ? copyDefined({
        status: stringOrUndefined(result.relevanceGate.status),
        targetMatched: booleanOrUndefined(result.relevanceGate.targetMatched),
        missingRequirements: Array.isArray(result.relevanceGate.missingRequirements)
          ? result.relevanceGate.missingRequirements.slice(0, 20)
          : undefined,
      })
      : undefined,
    recommendedNextAction: stringOrUndefined(result.recommendedNextAction),
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

/**
 * Stale-index banner, scoped to files this packet actually stands on.
 *
 * `isStale` is snapshot-wide: ANY uncommitted file marks it true, so during
 * normal development (a dirty tree is the normal state) the banner fired on
 * every packet, and it named unrelated files. Worse, it said "Read these files
 * directly if precision matters" — a broad-read instruction contradicting the
 * same packet's `answerable=true` stop rule, teaching exactly the double-spend
 * the tool exists to prevent.
 *
 * Now it fires only when a dirty path intersects the packet's own evidence, and
 * points at the bounded follow-up (codegraph_slice) instead of a file read.
 */
export function withFreshnessBanner(text: string, result: unknown): string {
  if (!isRecord(result)) return text;
  const freshness = result.indexFreshness;
  if (!isRecord(freshness) || freshness.isStale !== true) return text;
  const dirty = dirtyPathsFromFreshness(freshness);
  if (dirty.length === 0) return text;
  const relied = packetFilePaths(result);
  if (relied.size === 0) return text;
  const overlap = dirty.filter(entry => pathTouchesPacket(entry, relied)).slice(0, 5);
  if (overlap.length === 0) return text;
  return `⚠️ Uncommitted edits since indexing touch this packet's evidence: ${overlap.join(', ')}. `
    + `Everything else here is current. Re-fetch only those ranges with codegraph_slice if exact line numbers matter.\n\n${text}`;
}

function dirtyPathsFromFreshness(freshness: Record<string, unknown>): string[] {
  const dirtyFiles = freshness.dirtyFiles;
  const samples = isRecord(dirtyFiles) && isRecord(dirtyFiles.samples) ? dirtyFiles.samples : undefined;
  if (!samples) return [];
  return [
    ...(Array.isArray(samples.modified) ? samples.modified : []),
    ...(Array.isArray(samples.added) ? samples.added : []),
    ...(Array.isArray(samples.deleted) ? samples.deleted : []),
  ].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/** git status reports untracked directories as `docs/scan/` — match by prefix. */
function pathTouchesPacket(dirtyPath: string, relied: Set<string>): boolean {
  const normalized = dirtyPath.replace(/\\/g, '/');
  if (relied.has(normalized)) return true;
  if (!normalized.endsWith('/')) return false;
  for (const file of relied) {
    if (file.startsWith(normalized)) return true;
  }
  return false;
}

/** Every file path the packet presents as evidence, across pack shapes. */
function packetFilePaths(result: Record<string, unknown>): Set<string> {
  const paths = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) paths.add(value.replace(/\\/g, '/'));
  };
  for (const value of Object.values(result)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === 'string') add(entry);
      else if (isRecord(entry)) add(entry.file);
    }
  }
  return paths;
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

The workspace is pre-indexed into a code graph. codegraph_context returns bounded ranked files, graph edges, and line-numbered evidence for the task.

Session reuse first: pass the same sessionId on EVERY call. Reuse delivered evidence; fetch one missing range with codegraph_slice.

Routing:
- Any repository question, or before any edit -> codegraph_context with the user's task verbatim.
- PR review -> pass prUrl or baseRef/headRef; a URL/range in task is also parsed and reviewed in an immutable, batched range.
- Omit mode unless the user explicitly requests one; automatic routing uses the full task.
- answerable=true -> answer from the packet; do not re-search the same ground.
- answerable=false review input -> retry codegraph_context with the exact allowedFollowups; do not answer from zero metrics.
- Packet names an exact missing file/line/symbol -> codegraph_slice (batch via slices[]).
- Ambiguous work -> use the returned scopeRequest, fill scopePlan, then retry codegraph_context once.
- Multi-phase work -> save/load codegraph_checkpoint by explicit taskId; load may require fresh evidence after source drift.
- codegraph_status is diagnostic only.

Trust the packet and its followups; avoid broad search. Index errors name the exact codegraph index/setup retry. Do not set autoRefresh=true unless requested.`;

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

function dispatchCheckpoint(store: CheckpointStateStore, args: Record<string, unknown>): Record<string, unknown> {
  const action = String(args.action ?? '');
  if (action === 'list') return { action, checkpoints: store.list(numberOrUndefined(args.limit) ?? 20) };
  const taskId = typeof args.taskId === 'string' ? args.taskId : undefined;
  if (action === 'load') {
    if (!taskId) throw new Error('codegraph_checkpoint load requires taskId.');
    return { action, ...store.load(taskId, numberOrUndefined(args.version)) };
  }
  if (action === 'save') {
    const task = typeof args.task === 'string'
      ? args.task
      : taskId
        ? store.load(taskId).task
        : undefined;
    if (!task || typeof args.phase !== 'string' || !isRecord(args.state)) {
      throw new Error('codegraph_checkpoint save requires task, phase, and state.');
    }
    return { action, ...store.save({
      taskId,
      expectedVersion: numberOrUndefined(args.expectedVersion),
      task,
      phase: args.phase as CheckpointPhase,
      state: args.state as CheckpointState,
    }) };
  }
  if (action === 'complete') {
    if (!taskId || typeof args.expectedVersion !== 'number' || !isRecord(args.state)) {
      throw new Error('codegraph_checkpoint complete requires taskId, expectedVersion, and state.');
    }
    return { action, ...store.complete(taskId, args.expectedVersion, args.state as CheckpointState) };
  }
  throw new Error(`Unknown checkpoint action: ${action}.`);
}

function resumeContextArgs(store: CheckpointStateStore, args: Record<string, unknown>): Record<string, unknown> {
  const taskId = String(args.resumeTaskId ?? '').trim();
  if (!taskId) return args;
  const loaded = store.load(taskId);
  if (!loaded.resumeReady) {
    return {
      ...args,
      _resumeBlocked: {
        task: loaded.task,
        answerable: false,
        sufficientForAnswer: false,
        resumeReady: false,
        checkpoint: loaded,
        recommendedNextAction: 'refresh_checkpoint_evidence',
        allowedFollowups: loaded.nextActions,
        disallowedFollowups: ['broad_shell_search', 'unbounded_file_reads', 'unbounded_mcp_exploration'],
      },
    };
  }
  const scopePlan = isRecord(loaded.state.scopePlan) ? loaded.state.scopePlan : undefined;
  return copyDefined({
    ...args,
    task: args.task ?? loaded.task,
    target: args.target ?? (typeof scopePlan?.target === 'string' ? scopePlan.target : undefined),
    scopePlan,
    freshEvidence: true,
    resumeTaskId: taskId,
  });
}

export function applyContextScopeGate(args: Record<string, unknown>, rawResult: unknown): unknown {
  if (!isRecord(rawResult)) return rawResult;
  if (isRecord(args._resumeBlocked)) return rawResult;
  const task = String(args.task ?? '').trim();
  const scopePlan = isRecord(args.scopePlan) ? args.scopePlan : undefined;
  const gateMode = relevanceGateMode();
  if (!scopePlan && shouldRequireScopePlan(task, args)) {
    const discovery = buildScopeDiscoveryPacket(task, rawResult);
    return gateMode === 'shadow'
      ? { ...rawResult, relevanceGate: { status: 'shadow', wouldBlock: true, reason: 'ambiguous_task_requires_scopePlan' }, scopeDiscovery: discovery }
      : gateMode === 'off' ? rawResult : discovery;
  }

  const answerable = rawResult.answerable === true || rawResult.sufficientForAnswer === true;
  const taskType = String(rawResult.taskType ?? '');
  if (taskType === 'unknown') {
    const blocked = {
      ...rawResult,
      answerable: false,
      sufficientForAnswer: false,
      recommendedNextAction: 'refine_scope_with_luna',
      relevanceGate: { status: 'blocked', reason: 'unknown_task_type_requires_scopePlan' },
    };
    return gateMode === 'shadow' ? { ...rawResult, relevanceGate: { status: 'shadow', wouldBlock: true, reason: 'unknown_task_type_requires_scopePlan' } } : gateMode === 'off' ? rawResult : blocked;
  }
  if (!scopePlan || !answerable) return rawResult;
  const relevance = evaluateScopeRelevance(scopePlan, rawResult);
  if (relevance.targetMatched && relevance.missingRequirements.length === 0) {
    return { ...rawResult, relevanceGate: { status: 'passed', ...relevance } };
  }
  const blocked = {
    ...rawResult,
    answerable: false,
    sufficientForAnswer: false,
    missing: uniqueStrings([...(Array.isArray(rawResult.missing) ? rawResult.missing.map(String) : []), ...relevance.missingRequirements]),
    recommendedNextAction: Number(scopePlan.attempt ?? 1) >= 2 ? 'ask_for_exact_target' : 'refine_scope_with_luna',
    relevanceGate: { status: 'blocked', ...relevance },
    allowedFollowups: Number(scopePlan.attempt ?? 1) >= 2
      ? []
      : [{ tool: 'codegraph_context', args: { task, scopePlan: { ...scopePlan, attempt: 2 } }, reason: 'Target or requirement evidence is not source-relevant yet.' }],
  };
  return gateMode === 'shadow'
    ? { ...rawResult, relevanceGate: { status: 'shadow', wouldBlock: true, ...relevance } }
    : gateMode === 'off' ? rawResult : blocked;
}

function relevanceGateMode(): 'off' | 'shadow' | 'enforce' {
  const value = (process.env.CODEGRAPH_RELEVANCE_GATE ?? 'enforce').trim().toLowerCase();
  if (value === 'off' || value === 'shadow') return value;
  return 'enforce';
}

export function shouldRequireScopePlan(task: string, args: Record<string, unknown>): boolean {
  if (!task || args.target || args.files || args.symbols || args.diff) return false;
  if (/\b(checkpoint|persistent phase|context reset|resume task|long context|exact evidence)\b/i.test(task)) return true;
  const words = task.toLowerCase().replace(/[^a-z0-9_$./-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return words.length <= 2;
}

function buildScopeDiscoveryPacket(task: string, rawResult: Record<string, unknown>): Record<string, unknown> {
  const candidates = candidateRecords(rawResult.candidateFiles).concat(candidateRecords(rawResult.topFiles)).slice(0, 20);
  const symbols = candidateRecords(rawResult.relevantSymbols).concat(candidateRecords(rawResult.symbols)).slice(0, 20);
  return {
    task,
    answerable: false,
    sufficientForAnswer: false,
    confidence: 0.25,
    recommendedNextAction: 'refine_scope_with_luna',
    refinementAttempt: 1,
    scopeCandidates: {
      files: candidates.map(item => pickCandidate(item)),
      symbols: symbols.map(item => pickCandidate(item)),
      sourceTool: rawResult.sourceTool ?? rawResult.tool,
    },
    scopeRequest: {
      required: ['intent', 'target', 'requirements'],
      candidateFileLimit: 20,
      requirementLimit: 12,
      allowedKinds: ['source', 'definition', 'reference', 'dependency', 'endpoint', 'config', 'test', 'validation'],
      nextCall: 'Call codegraph_context again with scopePlan filled by Luna.',
    },
    missing: ['scopePlan.target', 'scopePlan.requirements'],
    allowedFollowups: [{ tool: 'codegraph_context', args: { task }, reason: 'Refine scope with Luna before retrieving answer-ready evidence.' }],
    disallowedFollowups: ['broad_shell_search', 'unbounded_file_reads', 'unbounded_mcp_exploration'],
  };
}

function evaluateScopeRelevance(scopePlan: Record<string, unknown>, result: Record<string, unknown>): { targetMatched: boolean; missingRequirements: string[]; evidenceIds: Record<string, string[]> } {
  const target = String(scopePlan.target ?? '').toLowerCase();
  const targetTokens = target.split(/[^a-z0-9_$./-]+/).filter(token => token.length >= 3);
  const searchable = JSON.stringify(result).toLowerCase();
  const targetMatched = targetTokens.length === 0 || targetTokens.some(token => searchable.includes(token));
  const requirements = Array.isArray(scopePlan.requirements) ? scopePlan.requirements.filter(isRecord) : [];
  const evidence = collectEvidenceRecords(result);
  const evidenceIds: Record<string, string[]> = {};
  const missingRequirements: string[] = [];
  for (const requirement of requirements) {
    const id = String(requirement.id ?? 'requirement');
    const kinds = Array.isArray(requirement.kinds) ? requirement.kinds.map(String) : [];
    const matches = evidence.filter(item => kinds.some(kind => evidenceKindMatches(kind, item)));
    evidenceIds[id] = matches.map(item => String(item.id ?? item.file ?? id)).slice(0, 8);
    if (matches.length === 0) missingRequirements.push(id);
  }
  return { targetMatched, missingRequirements, evidenceIds };
}

function collectEvidenceRecords(result: Record<string, unknown>): Array<Record<string, unknown>> {
  const keys = ['evidenceSlices', 'definitionCandidates', 'symbols', 'relevantSymbols', 'references', 'dependencies', 'callEdges', 'flowSteps', 'endpoints', 'testsLikelyRelevant', 'validation', 'files', 'candidateFiles', 'editRanges', 'reviewFindings'];
  return keys.flatMap(key => arrayRecords(result[key]).map(item => ({ ...item, __source: key })));
}

function evidenceKindMatches(kind: string, item: Record<string, unknown>): boolean {
  const source = String(item.__source ?? '').toLowerCase();
  const itemKind = String(item.kind ?? item.type ?? '').toLowerCase();
  if (kind === 'source') return source === 'evidenceslices' || itemKind.includes('source') || item.text !== undefined;
  if (kind === 'definition') return source.includes('definition') || itemKind.includes('definition') || itemKind === 'symbol';
  if (kind === 'reference') return source.includes('reference') || itemKind.includes('reference') || itemKind.includes('call');
  if (kind === 'dependency') return source.includes('depend') || source.includes('call') || itemKind.includes('depend') || itemKind.includes('call');
  if (kind === 'endpoint') return source.includes('endpoint') || itemKind.includes('endpoint') || source.includes('flow');
  if (kind === 'test') return source.includes('test') || itemKind.includes('test') || /test|spec/i.test(String(item.file ?? ''));
  if (kind === 'validation') return source.includes('validation') || itemKind.includes('validation') || item.command !== undefined;
  if (kind === 'config') return source.includes('config') || itemKind.includes('config') || /config|yaml|yml|properties|json/i.test(String(item.file ?? ''));
  return false;
}

function pickCandidate(item: Record<string, unknown>): Record<string, unknown> {
  return copyDefined({ file: item.file, symbol: item.symbol, name: item.name, score: item.score, reasons: item.reasons });
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function candidateRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => typeof item === 'string' ? [{ file: item }] : isRecord(item) ? [item] : []);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function fieldImpactSymbolForTask(task: string, target: string): string | undefined {
  const text = task.toLowerCase();
  if (!/\b(field|property|member)\b/.test(text)) return undefined;
  if (!/\b(impact|usage|usages|read|write|chang(?:e|es|ed|ing)|modif(?:y|ies|ied|ying|ication|ications))\b/.test(text)) return undefined;
  const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;
  const explicit = target.trim();
  if (identifier.test(explicit)) return explicit;
  return task.match(/\b[A-Z][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*\b/)?.[0];
}
