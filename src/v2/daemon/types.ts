export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  homeDir: string;
  startedAt: string;
}

export interface DaemonStartOptions {
  homeDir?: string;
  port?: number;
  workers?: number;
}
