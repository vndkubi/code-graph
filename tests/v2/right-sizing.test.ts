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

  it('enforces the minKeep floor when the cut would drop below it', () => {
    const rows = [
      { searchScore: 100, file: 'a.ts' },
      { searchScore: 12, file: 'b.ts' },   // 12/100=0.12 — below cutoff 80
      { searchScore: 5, file: 'c.ts' },
    ];
    // keepRatio=0.8 → cutoff 80. Only a.ts clears it, but minKeep=2 keeps b.ts too.
    const result = rightSizeCandidates(rows, { keepRatio: 0.8, minKeep: 2 });
    expect(result.map(r => r.file)).toEqual(['a.ts', 'b.ts']);
  });

  it('anchors the cutoff to rank-2 when rank-1 is a spurious outlier', () => {
    const rows = [
      { searchScore: 288, file: 'spurious-top.ts' },  // 288/95 = 3.0x — outlier
      { searchScore: 95, file: 'cluster-head.ts' },
      { searchScore: 93, file: 'real-answer.ts' },    // would die if anchored to 288
      { searchScore: 40, file: 'noise.ts' },
    ];
    // Outlier guard anchors to 95, cutoff = 95*0.8 = 76. The real answer at 93
    // survives; only the genuine low tail (40) is trimmed.
    const result = rightSizeCandidates(rows, { keepRatio: 0.8 });
    expect(result.map(r => r.file)).toEqual(['spurious-top.ts', 'cluster-head.ts', 'real-answer.ts']);
  });

  it('does not relax the cut when rank-1 is a genuine clear winner', () => {
    const rows = [
      { searchScore: 271, file: 'winner.ts' },
      { searchScore: 225, file: 'close-second.ts' },  // 271/225 = 1.2x — not an outlier
      { searchScore: 130, file: 'tail.ts' },          // 130 < 271*0.8=216.8 — trimmed
    ];
    const result = rightSizeCandidates(rows, { keepRatio: 0.8 });
    expect(result.map(r => r.file)).toEqual(['winner.ts', 'close-second.ts']);
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
