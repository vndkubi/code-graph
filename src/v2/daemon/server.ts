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
  const { db } = openCodeGraphDb(options.homeDir);
  const indexer = new V2Indexer(db);
  const queries = new V2QueryService(db);
  const token = crypto.randomBytes(24).toString('hex');
  const watchers = new Map<string, WorkspaceWatchHandle>();

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
          dbPath: paths.dbPath,
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
        const workspace = indexer.registerWorkspace(root, workspaceKey);
        if (!watchers.has(workspace.root)) {
          try {
            watchers.set(workspace.root, watchWorkspace(workspace.root, () => {
              try {
                indexer.indexWorkspace({ root: workspace.root, workspaceKey });
              } catch (error) {
                process.stderr.write(`[codegraph] watcher refresh failed: ${error instanceof Error ? error.message : String(error)}\n`);
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
        const result = indexer.indexWorkspace({ root, workspaceKey });
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
        const result = queries.query({
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
    db.close();
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
