import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendQualityTrend, formatQualityTrendRow, type QualityTrendRow } from '../../src/v2/benchmark/quality-trend.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ROW: QualityTrendRow = {
  timestamp: '2026-06-27T00:00:00.000Z',
  golden: { correct: 4, tasks: 4, tokenSavingPct: 0.978 },
  context: { correct: 5, tasks: 5, qualityMaintained: true, inputTokenSavingPct: 0.843 },
  review: { correct: 5, tasks: 5, qualityMaintained: true, inputTokenSavingPct: 0.865 },
  routeGate: { passed: 5, tasks: 5 },
};

describe('quality-trend telemetry', () => {
  it('formats a markdown row with fractions, quality flag, and percentages', () => {
    const line = formatQualityTrendRow(ROW);
    expect(line).toContain('| 4/4 |');
    expect(line).toContain('| 5/5 |');
    expect(line).toContain('ok');
    expect(line).toContain('84.3%');
    expect(line.startsWith('| ') && line.endsWith(' |')).toBe(true);
  });

  it('flags a quality drop', () => {
    const dropped = { ...ROW, context: { ...ROW.context, qualityMaintained: false } };
    expect(formatQualityTrendRow(dropped)).toContain('DROP');
  });

  it('creates the report with a header then appends subsequent rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-trend-'));
    tempDirs.push(dir);
    const report = path.join(dir, 'nested', 'quality-trend.md');

    appendQualityTrend(report, ROW);
    const first = fs.readFileSync(report, 'utf-8');
    expect(first).toContain('# CodeGraph retrieval-quality trend');
    expect(first).toContain('| Timestamp |');
    expect((first.match(/2026-06-27/g) ?? []).length).toBe(1);

    appendQualityTrend(report, { ...ROW, timestamp: '2026-06-28T00:00:00.000Z' });
    const second = fs.readFileSync(report, 'utf-8');
    // Header written once; two data rows now present.
    expect((second.match(/# CodeGraph retrieval-quality trend/g) ?? []).length).toBe(1);
    expect(second).toContain('2026-06-27');
    expect(second).toContain('2026-06-28');
  });
});
