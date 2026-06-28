import { describe, expect, it } from 'vitest';
import { rightSizeCandidates } from '../../src/v2/query/ranking.js';

describe('rightSizeCandidates (Phase A relevance-cliff trimming)', () => {
  it('keeps all candidates when all scores are within the ratio', () => {
    const rows = [
      { searchScore: 100, file: 'a.ts' },
      { searchScore: 85, file: 'b.ts' },
      { searchScore: 80, file: 'c.ts' },
    ];
    // keepRatio=0.8: cutoff=80. All pass.
    expect(rightSizeCandidates(rows, { keepRatio: 0.8 })).toHaveLength(3);
  });

  it('trims the tail when scores fall below topScore * keepRatio', () => {
    const rows = [
      { searchScore: 200, file: 'top.ts' },
      { searchScore: 160, file: 'middle.ts' },  // 160/200=0.80 — exactly on cutoff
      { searchScore: 50, file: 'noise.ts' },     // 50/200=0.25 — below 0.8
    ];
    const result = rightSizeCandidates(rows, { keepRatio: 0.8 });
    expect(result.map(r => r.file)).toEqual(['top.ts', 'middle.ts']);
  });

  it('always keeps minKeep candidates even when all scores are low', () => {
    const rows = [
      { searchScore: 10, file: 'a.ts' },
      { searchScore: 1, file: 'b.ts' },
    ];
    // topScore=10, cutoff=9 (keepRatio=0.9). b.ts (score 1) fails — but minKeep=1 so a.ts kept.
    const result = rightSizeCandidates(rows, { keepRatio: 0.9, minKeep: 1 });
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('a.ts');
  });

  it('returns all candidates when topScore is zero (no trimming)', () => {
    const rows = [
      { searchScore: 0, file: 'a.ts' },
      { searchScore: 0, file: 'b.ts' },
    ];
    expect(rightSizeCandidates(rows, { keepRatio: 0.9 })).toHaveLength(2);
  });

  it('returns all candidates when there are no searchScore fields', () => {
    const rows = [{ file: 'a.ts' }, { file: 'b.ts' }, { file: 'c.ts' }];
    expect(rightSizeCandidates(rows as Record<string, unknown>[], { keepRatio: 0.9 })).toHaveLength(3);
  });

  it('uses default keepRatio=0.8 when not specified', () => {
    const rows = [
      { searchScore: 100, file: 'a.ts' },
      { searchScore: 79, file: 'b.ts' },  // 79/100 = 0.79 — just below default 0.8
    ];
    const result = rightSizeCandidates(rows);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('a.ts');
  });
});
