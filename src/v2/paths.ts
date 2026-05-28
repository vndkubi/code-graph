import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CodeGraphPaths {
  homeDir: string;
  daemonInfoPath: string;
  logDir: string;
  daemonLogPath: string;
}

export function getCodeGraphPaths(homeOverride?: string): CodeGraphPaths {
  const homeDir = path.resolve(homeOverride ?? process.env.CODEGRAPH_HOME ?? defaultHomeDir());
  return {
    homeDir,
    daemonInfoPath: path.join(homeDir, daemonInfoFileName()),
    logDir: path.join(homeDir, 'logs'),
    daemonLogPath: path.join(homeDir, 'logs', 'daemon.jsonl'),
  };
}

export function ensureCodeGraphDirs(paths: CodeGraphPaths): void {
  fs.mkdirSync(paths.homeDir, { recursive: true });
  fs.mkdirSync(paths.logDir, { recursive: true });
}

function defaultHomeDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'codegraph');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'codegraph');
  }
  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'codegraph');
}

function daemonInfoFileName(): string {
  const configured = safeIdentifier(process.env.CODEGRAPH_DAEMON_ID);
  if (configured) return `daemon.${configured}.json`;
  if (isContainerRuntime()) return `daemon.${safeIdentifier(os.hostname()) ?? 'container'}.json`;
  return 'daemon.json';
}

function isContainerRuntime(): boolean {
  if (process.env.CODEGRAPH_DAEMON_SCOPE === 'host') return false;
  if (process.env.CODEGRAPH_DAEMON_SCOPE === 'container') return true;
  return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv') || Boolean(process.env.KUBERNETES_SERVICE_HOST);
}

function safeIdentifier(value: string | undefined): string | undefined {
  const safe = value?.trim().replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe && safe.length > 0 ? safe.slice(0, 120) : undefined;
}
