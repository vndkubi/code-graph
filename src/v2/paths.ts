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
    daemonInfoPath: path.join(homeDir, 'daemon.json'),
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
