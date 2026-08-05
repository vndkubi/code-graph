import { runCheckedProcess, type ProcessResult } from './process-runner.js';

const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const DEFAULT_GIT_MAX_BUFFER = 16 * 1024 * 1024;

/** Async, bounded Git adapter used by review/application request paths. */
export class GitClient {
  constructor(
    private readonly timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
    private readonly maxBuffer = DEFAULT_GIT_MAX_BUFFER,
  ) {}

  async run(root: string, args: string[]): Promise<string> {
    const result = await this.runRaw(root, args);
    return result.stdout.trim();
  }

  async runRaw(root: string, args: string[]): Promise<ProcessResult> {
    return runCheckedProcess('git', args, {
      cwd: root,
      timeoutMs: this.timeoutMs,
      maxBuffer: this.maxBuffer,
    });
  }

  async commit(root: string, ref: string): Promise<string> {
    return (await this.run(root, ['rev-parse', '--verify', `${ref}^{commit}`])).toLowerCase();
  }
}
