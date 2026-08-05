import { describe, expect, it } from 'vitest';
import { ProcessRunnerError, runCheckedProcess, runProcess } from '../../src/v2/infrastructure/process-runner.js';

const node = process.execPath;

describe('async ProcessRunner', () => {
  it('captures stdout/stderr and preserves non-zero exit codes for unchecked runs', async () => {
    const result = await runProcess(node, ['-e', "process.stdout.write('ok'); process.stderr.write('warning'); process.exit(4)"]);
    expect(result).toMatchObject({ stdout: 'ok', stderr: 'warning', exitCode: 4 });
  });

  it('throws a checked error with bounded diagnostics on non-zero exit', async () => {
    await expect(runCheckedProcess(node, ['-e', "process.stderr.write('failure detail'); process.exit(7)"]))
      .rejects.toMatchObject({
        name: 'ProcessRunnerError',
        message: expect.stringContaining('exit code 7'),
      });
  });

  it('terminates a process on timeout and exposes the timeout classification', async () => {
    const error = await runCheckedProcess(node, ['-e', 'setTimeout(() => {}, 1000)'], { timeoutMs: 25 })
      .catch(value => value as ProcessRunnerError);
    expect(error).toBeInstanceOf(ProcessRunnerError);
    expect(error.timedOut).toBe(true);
  });

  it('honors AbortSignal cancellation', async () => {
    const controller = new AbortController();
    const pending = runCheckedProcess(node, ['-e', 'setTimeout(() => {}, 1000)'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 25);
    const error = await pending.catch(value => value as ProcessRunnerError);
    expect(error).toBeInstanceOf(ProcessRunnerError);
    expect(error.aborted).toBe(true);
  });

  it('rejects output beyond maxBuffer instead of retaining it unbounded', async () => {
    const error = await runProcess(node, ['-e', "process.stdout.write('x'.repeat(10000))"], { maxBuffer: 128 })
      .catch(value => value as ProcessRunnerError);
    expect(error).toBeInstanceOf(ProcessRunnerError);
    expect(error.message).toContain('maxBuffer');
  });
});
