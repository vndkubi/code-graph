import { spawn } from 'node:child_process';

export interface ProcessRunnerOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
  /** Optional bounded stream consumer. The process pauses while each chunk is handled. */
  onStdoutChunk?: (chunk: string) => void | Promise<void>;
  onStderrChunk?: (chunk: string) => void | Promise<void>;
  /** Disable accumulation when a caller consumes output through a chunk handler. */
  captureStdout?: boolean;
  captureStderr?: boolean;
}

export interface ProcessResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut?: boolean;
  aborted?: boolean;
}

export class ProcessRunnerError extends Error {
  constructor(
    message: string,
    readonly result?: ProcessResult,
    readonly timedOut = false,
    readonly aborted = false,
  ) {
    super(message);
    this.name = 'ProcessRunnerError';
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Run a child process without blocking the Node event loop.
 *
 * The runner deliberately returns non-zero results; callers choose whether a
 * command is optional or checked. `runCheckedProcess` supplies the common
 * fail-closed behavior used by Git/worktree operations.
 */
export function runProcess(
  command: string,
  args: string[] = [],
  options: ProcessRunnerOptions = {},
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const append = (kind: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      const text = chunk.toString();
      if (kind === 'stdout' && options.captureStdout !== false) stdout += text;
      if (kind === 'stderr' && options.captureStderr !== false) stderr += text;
      const size = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
      if (size > maxBuffer) {
        child.kill();
        fail(new ProcessRunnerError(`Process output exceeded maxBuffer (${maxBuffer} bytes).`, {
          command,
          args,
          stdout,
          stderr,
          exitCode: null,
          signal: null,
          timedOut,
          aborted,
        }));
      }
    };
    let stdoutWork = Promise.resolve();
    let stderrWork = Promise.resolve();
    const consume = (kind: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      const text = chunk.toString();
      append(kind, text);
      const callback = kind === 'stdout' ? options.onStdoutChunk : options.onStderrChunk;
      if (!callback) return;
      const stream = kind === 'stdout' ? child.stdout : child.stderr;
      stream.pause();
      const previous = kind === 'stdout' ? stdoutWork : stderrWork;
      const next = previous
        .then(() => callback(text))
        .finally(() => stream.resume());
      if (kind === 'stdout') stdoutWork = next;
      else stderrWork = next;
      next.catch(error => {
        child.kill();
        fail(error);
      });
    };
    const abort = (): void => {
      if (settled) return;
      aborted = true;
      child.kill();
    };

    if (options.signal?.aborted) {
      aborted = true;
      child.kill();
    } else {
      options.signal?.addEventListener('abort', abort, { once: true });
    }
    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', chunk => consume('stdout', chunk));
    child.stderr.on('data', chunk => consume('stderr', chunk));
    child.once('error', error => fail(error));
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      Promise.all([stdoutWork, stderrWork]).then(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ command, args, stdout, stderr, exitCode, signal, timedOut, aborted });
      }).catch(fail);
    });

    // An already-aborted signal can race with spawn's close event; the close
    // handler still owns final settlement, preserving captured diagnostics.
    if (aborted && !child.killed) child.kill();
  });
}

export async function runCheckedProcess(
  command: string,
  args: string[] = [],
  options: ProcessRunnerOptions = {},
): Promise<ProcessResult> {
  const result = await runProcess(command, args, options);
  if (result.exitCode === 0) return result;
  const detail = result.stderr.trim().replace(/\s+/g, ' ').slice(0, 500);
  const reason = result.aborted
    ? 'aborted'
    : result.timedOut
      ? 'timed out'
      : result.exitCode === null
      ? 'terminated'
      : `exit code ${result.exitCode}`;
  throw new ProcessRunnerError(
    `${command} ${args.join(' ')} failed (${reason})${detail ? `: ${detail}` : '.'}`,
    result,
    result.timedOut === true,
    result.aborted === true,
  );
}
