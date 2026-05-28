import crypto from 'node:crypto';
import fs from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { openCodeGraphDb } from '../storage/database.js';
import { V2Indexer } from '../index/indexer.js';
import { V2QueryService } from '../query/service.js';
import { ensureCodeGraphDirs, getCodeGraphPaths } from '../paths.js';
import type { DaemonInfo, DaemonStartOptions } from './types.js';
import { watchWorkspace, type WorkspaceWatchHandle } from '../index/watcher.js';

export async function runDaemon(options: DaemonStartOptions = {}): Promise<void> {
  const paths = getCodeGraphPaths(options.homeDir);
  ensureCodeGraphDirs(paths);
  const { db, connectionString } = await openCodeGraphDb(options.homeDir);
  const indexer = new V2Indexer(db);
  const queries = new V2QueryService(db);
  const token = crypto.randomBytes(24).toString('hex');
  const watchers = new Map<string, WorkspaceWatchHandle>();
  const workspaceKeysByRoot = new Map<string, Set<string>>();
  const refreshJobs = new Map<string, {
    root: string;
    workspaceKey?: string;
    running: boolean;
    pending: boolean;
    reason: string;
    timer?: NodeJS.Timeout;
  }>();
  const refreshDelayMs = refreshDebounceMs();

  const scheduleWorkspaceRefresh = (root: string, workspaceKey: string | undefined, reason: string) => {
    const key = refreshJobKey(root, workspaceKey);
    let job = refreshJobs.get(key);
    if (!job) {
      job = {
        root,
        workspaceKey,
        running: false,
        pending: false,
        reason,
      };
      refreshJobs.set(key, job);
    }
    job.pending = true;
    job.reason = reason;
    if (job.running) return;
    if (job.timer) clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      job!.timer = undefined;
      void runScheduledRefresh(job!);
    }, refreshDelayMs);
  };

  const runScheduledRefresh = async (job: {
    root: string;
    workspaceKey?: string;
    running: boolean;
    pending: boolean;
    reason: string;
    timer?: NodeJS.Timeout;
  }) => {
    if (job.running || !job.pending) return;
    job.running = true;
    job.pending = false;
    const reason = job.reason;
    const startedAt = Date.now();
    try {
      const result = await indexer.indexWorkspace({ root: job.root, workspaceKey: job.workspaceKey });
      logEvent(paths.daemonLogPath, {
        event: 'workspace.refresh',
        mode: 'background',
        reason,
        root: job.root,
        workspaceKey: job.workspaceKey,
        workspaceId: result.workspaceId,
        snapshotId: result.snapshotId,
        filesTotal: result.filesTotal,
        filesParsed: result.filesParsed,
        parseCacheHits: result.parseCacheHits,
        indexTimeMs: result.indexTimeMs,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      process.stderr.write(`[codegraph] background refresh failed: ${error instanceof Error ? error.message : String(error)}\n`);
      logEvent(paths.daemonLogPath, {
        event: 'workspace.refresh.failed',
        mode: 'background',
        reason,
        root: job.root,
        workspaceKey: job.workspaceKey,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      job.running = false;
      if (job.pending) {
        if (job.timer) clearTimeout(job.timer);
        job.timer = setTimeout(() => {
          job.timer = undefined;
          void runScheduledRefresh(job);
        }, refreshDelayMs);
      }
    }
  };

  const server = createServer(async (req, res) => {
    try {
      if (!isAuthorized(req, token)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/status') {
        sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          backend: 'postgres',
          databaseUrl: redactDatabaseUrl(connectionString),
          logPath: paths.daemonLogPath,
          uptimeSeconds: Math.round(process.uptime()),
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/workspaces/register') {
        const startedAt = Date.now();
        const body = await readJson(req);
        const root = requireString(body.root, 'root');
        const workspaceKey = optionalString(body.workspaceKey);
        const watch = body.watch === true;
        const workspace = await indexer.registerWorkspace(root, workspaceKey);
        const rootKeys = workspaceKeysByRoot.get(workspace.root) ?? new Set<string>();
        rootKeys.add(workspaceKeyValue(workspaceKey));
        workspaceKeysByRoot.set(workspace.root, rootKeys);
        if (watch && !watchers.has(workspace.root)) {
          try {
            watchers.set(workspace.root, watchWorkspace(workspace.root, () => {
              const keys = workspaceKeysByRoot.get(workspace.root) ?? new Set([workspaceKeyValue(workspaceKey)]);
              for (const key of keys) {
                scheduleWorkspaceRefresh(workspace.root, workspaceKeyFromValue(key), 'watch');
              }
            }));
          } catch (error) {
            process.stderr.write(`[codegraph] workspace watcher disabled: ${error instanceof Error ? error.message : String(error)}\n`);
            logEvent(paths.daemonLogPath, {
              event: 'workspace.watch.failed',
              root: workspace.root,
              workspaceKey,
              workspaceId: workspace.workspaceId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        logEvent(paths.daemonLogPath, {
          event: 'workspace.register',
          root: workspace.root,
          workspaceKey,
          workspaceId: workspace.workspaceId,
          hasSnapshot: Boolean(workspace.currentSnapshotId),
          watch,
          durationMs: Date.now() - startedAt,
        });
        sendJson(res, 200, workspace);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/workspaces/refresh') {
        const startedAt = Date.now();
        const body = await readJson(req);
        const root = requireString(body.root, 'root');
        const workspaceKey = optionalString(body.workspaceKey);
        if (body.background === true) {
          scheduleWorkspaceRefresh(root, workspaceKey, 'startup');
          sendJson(res, 202, { queued: true, root, workspaceKey });
          return;
        }
        const result = await indexer.indexWorkspace({ root, workspaceKey });
        logEvent(paths.daemonLogPath, {
          event: 'workspace.refresh',
          root,
          workspaceKey,
          workspaceId: result.workspaceId,
          snapshotId: result.snapshotId,
          filesTotal: result.filesTotal,
          filesParsed: result.filesParsed,
          parseCacheHits: result.parseCacheHits,
          indexTimeMs: result.indexTimeMs,
          durationMs: Date.now() - startedAt,
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/query') {
        const startedAt = Date.now();
        const body = await readJson(req);
        const workspaceId = requireString(body.workspaceId, 'workspaceId');
        const toolName = requireString(body.toolName, 'toolName');
        const args = isRecord(body.args) ? body.args : {};
        const result = await queries.query({
          workspaceId,
          toolName,
          args,
        });
        logEvent(paths.daemonLogPath, {
          event: 'query',
          workspaceId,
          toolName,
          args: summarizeArgs(args),
          durationMs: Date.now() - startedAt,
          responseChars: JSON.stringify(result).length,
        });
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Daemon failed to bind to a TCP port');
  }

  const info: DaemonInfo = {
    pid: process.pid,
    port: address.port,
    token,
    homeDir: paths.homeDir,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(paths.daemonInfoPath, JSON.stringify(info, null, 2));
  process.stderr.write(`[codegraph] daemon listening on 127.0.0.1:${address.port}\n`);

  const close = async () => {
    await Promise.all([...watchers.values()].map(watcher => watcher.close().catch(() => undefined)));
    await db.close();
    removeDaemonInfo(paths.daemonInfoPath, info);
  };
  process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  return req.headers['x-codegraph-token'] === token;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf-8');
  return JSON.parse(text) as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required field: ${name}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function refreshJobKey(root: string, workspaceKey: string | undefined): string {
  return `${root}\0${workspaceKey ?? ''}`;
}

function workspaceKeyValue(workspaceKey: string | undefined): string {
  return workspaceKey ?? '';
}

function workspaceKeyFromValue(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

function refreshDebounceMs(): number {
  const raw = Number(process.env.CODEGRAPH_REFRESH_DEBOUNCE_MS ?? 750);
  if (!Number.isFinite(raw) || raw < 0) return 750;
  return Math.min(Math.floor(raw), 60_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function logEvent(logPath: string, event: Record<string, unknown>): void {
  try {
    fs.appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
  } catch {
    // Logging must never break daemon query handling.
  }
}

function removeDaemonInfo(infoPath: string, info: DaemonInfo): void {
  try {
    const current = JSON.parse(fs.readFileSync(infoPath, 'utf-8')) as DaemonInfo;
    if (current.pid === info.pid && current.port === info.port && current.token === info.token) {
      fs.unlinkSync(infoPath);
    }
  } catch {
    // Shutdown cleanup is best-effort; startup validates stale metadata.
  }
}

function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of ['target', 'symbol', 'source', 'module', 'file', 'query', 'taskType', 'tokenBudget', 'method', 'path']) {
    const value = args[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      summary[key] = value;
    }
  }
  return summary;
}

function redactDatabaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return value.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
  }
}
