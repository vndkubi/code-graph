import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { getCodeGraphPaths } from '../paths.js';
import type { DaemonInfo } from './types.js';

export class DaemonClient {
  constructor(private readonly info: DaemonInfo) {}

  static readInfo(homeDir?: string): DaemonInfo | undefined {
    const paths = getCodeGraphPaths(homeDir);
    try {
      return JSON.parse(fs.readFileSync(paths.daemonInfoPath, 'utf-8')) as DaemonInfo;
    } catch {
      return undefined;
    }
  }

  static async ensure(homeDir?: string): Promise<DaemonClient> {
    const existing = DaemonClient.readInfo(homeDir);
    if (existing) {
      const client = new DaemonClient(existing);
      if (await client.isAlive()) return client;
      removeStaleDaemonInfo(homeDir, existing);
    }

    await startDaemonProcess(homeDir);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await sleep(150);
      const info = DaemonClient.readInfo(homeDir);
      if (!info) continue;
      const client = new DaemonClient(info);
      if (await client.isAlive()) return client;
    }
    throw new Error('Timed out waiting for codegraph daemon to start');
  }

  async isAlive(): Promise<boolean> {
    try {
      const response = await this.request('/status', 'GET');
      return Boolean((response as { ok?: boolean }).ok);
    } catch {
      return false;
    }
  }

  async registerWorkspace(
    root: string,
    workspaceKey?: string,
    options: { watch?: boolean } = {},
  ): Promise<{ workspaceId: string; root: string; workspaceKey?: string; currentSnapshotId?: string }> {
    return this.request('/workspaces/register', 'POST', {
      root,
      workspaceKey,
      watch: options.watch === true,
    }) as Promise<{
      workspaceId: string;
      root: string;
      workspaceKey?: string;
      currentSnapshotId?: string;
    }>;
  }

  async refreshWorkspace(root: string, workspaceKey?: string, options: { background?: boolean } = {}): Promise<unknown> {
    return this.request('/workspaces/refresh', 'POST', {
      root,
      workspaceKey,
      background: options.background === true,
    });
  }

  async query(workspaceId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request('/query', 'POST', { workspaceId, toolName, args });
  }

  async status(): Promise<unknown> {
    return this.request('/status', 'GET');
  }

  private async request(path: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${this.info.port}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-codegraph-token': this.info.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json() as unknown;
    if (!response.ok) {
      const message = typeof json === 'object' && json && 'error' in json
        ? String((json as { error: unknown }).error)
        : `Daemon request failed with status ${response.status}`;
      throw new Error(message);
    }
    return json;
  }
}

export async function stopDaemon(homeDir?: string): Promise<boolean> {
  const info = DaemonClient.readInfo(homeDir);
  if (!info) return false;
  try {
    process.kill(info.pid);
  } catch {
    return false;
  }
  return true;
}

function startDaemonProcess(homeDir?: string): Promise<void> {
  const paths = getCodeGraphPaths(homeDir);
  fs.mkdirSync(paths.logDir, { recursive: true });
  const bootstrapLogPath = `${paths.daemonLogPath}.bootstrap.log`;
  const stdout = fs.openSync(bootstrapLogPath, 'a');
  const stderr = fs.openSync(bootstrapLogPath, 'a');
  const cliPath = process.argv[1];
  const args = [cliPath, 'daemon', 'run'];
  if (homeDir) args.push('--home', homeDir);
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', stdout, stderr],
      windowsHide: true,
    });
    child.unref();
    return Promise.resolve();
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
}

function removeStaleDaemonInfo(homeDir: string | undefined, existing: DaemonInfo): void {
  const paths = getCodeGraphPaths(homeDir);
  try {
    const current = DaemonClient.readInfo(homeDir);
    if (current?.pid === existing.pid && current?.port === existing.port && current?.token === existing.token) {
      fs.unlinkSync(paths.daemonInfoPath);
    }
  } catch {
    // Stale daemon metadata is best-effort cleanup only.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
