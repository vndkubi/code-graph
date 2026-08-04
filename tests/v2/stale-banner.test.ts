import { describe, expect, it } from 'vitest';
import { withFreshnessBanner } from '../../src/v2/mcp/proxy.js';

// `isStale` is snapshot-wide: any uncommitted file anywhere sets it. The banner
// used to fire on EVERY packet during normal development, name unrelated files,
// and instruct "Read these files directly" — a broad-read order contradicting
// the same packet's answerable=true stop rule.
function packet(files: string[], dirty: { modified?: string[]; added?: string[]; deleted?: string[] }): Record<string, unknown> {
  return {
    answerable: true,
    topFiles: files,
    evidenceSlices: files.map(file => ({ file, lines: '1-10', text: '1: x' })),
    indexFreshness: {
      isStale: true,
      warning: 'Index may be stale.',
      dirtyFiles: {
        modifiedCount: dirty.modified?.length ?? 0,
        addedCount: dirty.added?.length ?? 0,
        deletedCount: dirty.deleted?.length ?? 0,
        samples: { modified: dirty.modified ?? [], added: dirty.added ?? [], deleted: dirty.deleted ?? [] },
      },
    },
  };
}

const AUTH = 'backend/src/main/java/com/odde/doughnut/configs/ProductionConfiguration.java';
const UNRELATED = 'backend/src/test/java/com/odde/doughnut/testability/builders/NotebookBuilder.java';

describe('stale-index banner scoping', () => {
  it('stays silent when the dirty files are unrelated to the packet evidence', () => {
    const result = packet([AUTH], { modified: [UNRELATED], added: ['docs/scan/'] });

    expect(withFreshnessBanner('PACKET', result)).toBe('PACKET');
  });

  it('warns when a dirty file is one the packet stands on', () => {
    const banner = withFreshnessBanner('PACKET', packet([AUTH], { modified: [AUTH] }));

    expect(banner).toContain(AUTH);
    expect(banner).toContain('PACKET');
  });

  it('never tells the agent to read files directly', () => {
    const banner = withFreshnessBanner('PACKET', packet([AUTH], { modified: [AUTH] }));

    expect(banner).not.toMatch(/read these files directly/i);
    expect(banner).toContain('codegraph_slice');
  });

  it('matches untracked directory entries by prefix', () => {
    const result = packet(['docs/scan/report.md'], { added: ['docs/scan/'] });

    expect(withFreshnessBanner('PACKET', result)).toContain('docs/scan/');
  });

  it('leaves fresh-index packets untouched', () => {
    expect(withFreshnessBanner('PACKET', { topFiles: [AUTH] })).toBe('PACKET');
  });
});
