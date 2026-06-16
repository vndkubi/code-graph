import fs from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { V2Indexer } from '../index/indexer.js';
import { watchWorkspace, type WorkspaceWatchHandle } from '../index/watcher.js';
import { V2QueryService } from '../query/service.js';
import { openCodeGraphDb, type CodeGraphDb } from '../storage/database.js';
import { isWorkspaceIndexed } from '../storage/sqlite-backend.js';
import { localArtifactStatus } from './local-artifact.js';
import { isLocalMcpFallbackTool, runLocalMcpFallback } from './local-fallback.js';
import { V2_TOOL_DEFINITIONS, mcpToolNamesForProfile, parseToolArgs } from './tools.js';

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
  const allowedToolNames = mcpToolNamesForProfile(options.mcpProfile);
  const toolDefinitions = allowedToolNames
    ? V2_TOOL_DEFINITIONS.filter(tool => allowedToolNames.has(tool.name))
    : V2_TOOL_DEFINITIONS;
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

  const server = new Server(
    { name: 'codegraph', version: '2.1.0' },
    {
      capabilities: { tools: {} },
      instructions: MCP_SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    let args: Record<string, unknown> | undefined;
    const startedAt = Date.now();
    try {
      if (allowedToolNames && !allowedToolNames.has(request.params.name)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: {
                code: 'tool_not_available_in_profile',
                message: `Tool ${request.params.name} is not available in MCP profile ${options.mcpProfile}. Use codegraph_context or codegraph_slice, or run with --mcp-profile full.`,
              },
            }),
          }],
          isError: true,
        };
      }
      args = parseToolArgs(request.params.name, request.params.arguments);
      if (request.params.name === 'codegraph_status') {
        const result = await codegraphStatus(options.root, args, runtimeValue);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }
      if (isAnswerPackTool(request.params.name) && options.autoRefresh !== true) {
        args.autoRefresh = false;
      } else if (options.autoRefresh && args.autoRefresh === undefined) {
        args.autoRefresh = true;
      }
      if (options.warnStale !== true && args.warnStale === undefined) {
        args.warnStale = false;
      }
      const embedded = await embeddedArtifactResult(options.root, request.params.name, args);
      if (embedded) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(embedded, null, 2) }],
        };
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
      logQueryEvent(current.logPath, {
        event: 'query',
        toolName: request.params.name,
        routedToolName: routed.toolName,
        workspaceId: current.workspace.workspaceId,
        durationMs: Date.now() - startedAt,
        responseChars: JSON.stringify(result).length,
        args: summarizeArgs(args),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
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

async function embeddedArtifactResult(
  root: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  if (!isLocalMcpFallbackTool(toolName)) return undefined;
  const artifact = localArtifactStatus(root);
  if (!artifact.ok) return undefined;
  const result = await runLocalMcpFallback(root, toolName, args, {
    error: {
      code: 'embedded_artifact_default',
      message: 'Using the embedded artifact index for this facade tool.',
    },
  });
  return result as Record<string, unknown> | undefined;
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
    autoRefresh: args.autoRefresh,
    warnStale: args.warnStale,
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
        responseMode: 'agent',
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
      responseMode: 'agent',
      ...common,
    }),
  };
}

export function inferCodeGraphContextMode(task: string, args: Record<string, unknown>): 'research' | 'flow' | 'change' | 'review' | 'evidence' {
  const explicit = typeof args.mode === 'string' ? args.mode : 'auto';
  if (explicit === 'research' || explicit === 'flow' || explicit === 'change' || explicit === 'review' || explicit === 'evidence') {
    return explicit;
  }
  const text = `${task}\n${typeof args.diff === 'string' ? args.diff.slice(0, 2000) : ''}`.toLowerCase();
  if (typeof args.diff === 'string' && args.diff.trim().length > 0) return 'review';
  if (/\b(review|patch|diff|pr|regression|risk|finding)\b/.test(text)) return 'review';
  if (/\b(get|post|put|delete|patch)\s+\/|\b(endpoint|api|route|request flow|trace|flow)\b/.test(text)) return 'flow';
  if (/\b(implement|fix|debug|refactor|change|modify|test|add|remove|update)\b/.test(text)) return 'change';
  if (/\b(evidence|answerable|rubric|coverage)\b/.test(text)) return 'evidence';
  return 'research';
}

async function codegraphStatus(
  root: string,
  args: Record<string, unknown>,
  runtime: McpRuntime | undefined,
): Promise<Record<string, unknown>> {
  const artifact = localArtifactStatus(root);
  const indexed = runtime?.workspace.currentSnapshotId ? true : isWorkspaceIndexed(root);
  const database = {
    ok: indexed,
    state: indexed ? 'ready' : 'missing_or_unindexed',
    dbPath: runtime?.dbPath,
    workspaceId: runtime?.workspace.workspaceId,
    snapshotId: runtime?.workspace.currentSnapshotId,
  };
  if (args.includeDiagnostics !== true) {
    return {
      ok: indexed || artifact.ok,
      database,
      artifact,
    };
  }
  return {
    ok: indexed || artifact.ok,
    artifact,
    database,
  };
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
  return { error: { code: 'tool_failed', message } };
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
  for (const key of ['target', 'symbol', 'source', 'module', 'file', 'query', 'task', 'taskType', 'tokenBudget', 'method', 'path']) {
    const value = args[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      summary[key] = typeof value === 'string' && value.length > 240 ? `${value.slice(0, 237)}...` : value;
    }
  }
  return summary;
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

const MCP_SERVER_INSTRUCTIONS = `# CodeGraph usage

CodeGraph is a pre-indexed local code graph. For architecture, "how does X work",
request-flow, or codebase-research questions, use CodeGraph directly and answer
from its returned evidence instead of starting a grep/read exploration loop.

Primary flow:
- Endpoint/API/request-flow/investigation questions: call get_flow_pack first.
- Spec, implementation-plan, debug, refactor, or "what should I change" tasks:
  call get_change_pack first, even when the user asks for read-only planning.
- Code review tasks with a unified diff: call review_patch first. Code review
  tasks without a concrete diff should use get_flow_pack or get_change_pack
  for the mentioned endpoint/symbol before answering.
- Use the user's full task text as the pack target/task. Do not strip HTTP
  methods or endpoint paths such as "GET /ws/v1/cluster/apps".
- Do not set autoRefresh=true for these pack tools unless the user explicitly
  asks for a fresh index; they are optimized for a prewarmed index.
- Do not set warnStale=true for these pack tools during exploration benchmarks;
  stale checks can be more expensive than answering from the existing pack.
- Treat evidenceSlices in that response as already-read source. They contain
  file paths, line ranges, and capped source text.
- Answer directly when sufficientForAnswer is true.
- Use search_code/search_symbol/get_file_slice only for a specific missing fact
  named in missingFacts, not as a broad follow-up search.

Anti-patterns:
- Do not call many small slice/search tools after an answer-ready pack.
- Do not use shell grep/read to rediscover files already listed in evidenceSlices.
- Prefer one large, bounded context pack over dozens of tiny retrieval calls.`;

function isAnswerPackTool(name: string): boolean {
  return name === 'get_flow_pack' || name === 'get_research_pack';
}
