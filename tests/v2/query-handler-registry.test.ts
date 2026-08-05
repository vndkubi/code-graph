import { describe, expect, it } from 'vitest';
import { QueryHandlerRegistry } from '../../src/v2/query/handler-registry.js';

describe('QueryHandlerRegistry', () => {
  it('dispatches a handler with the resolved snapshot and arguments', async () => {
    const calls: Array<{ snapshotId: string; args: Record<string, unknown> }> = [];
    const registry = new QueryHandlerRegistry([
      ['get_file_slice', async (snapshotId, args) => {
        calls.push({ snapshotId, args });
        return { ok: true };
      }],
    ]);

    await expect(registry.execute('get_file_slice', 'snapshot-1', { file: 'src/app.ts' }))
      .resolves.toEqual({ ok: true });
    expect(calls).toEqual([{ snapshotId: 'snapshot-1', args: { file: 'src/app.ts' } }]);
    expect(registry.has('get_file_slice')).toBe(true);
  });

  it('fails closed for an unknown tool instead of silently falling through', async () => {
    const registry = new QueryHandlerRegistry();
    await expect(registry.execute('missing_tool', 'snapshot-1', {}))
      .rejects.toThrow('Unknown v2 tool: missing_tool');
    expect(registry.has('missing_tool')).toBe(false);
  });

  it('rejects blank handler names', () => {
    expect(() => new QueryHandlerRegistry([['  ', async () => undefined]]))
      .toThrow('Query handler name must be non-empty.');
  });
});
