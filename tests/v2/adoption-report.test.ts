import { describe, expect, it } from 'vitest';
import { buildAdoptionReport, formatAdoptionReportText } from '../../src/v2/query/adoption-report.js';

function line(event: Record<string, unknown>): string {
  return JSON.stringify(event);
}

const SAMPLE = [
  line({ ts: '2026-07-01T09:00:00.000Z', event: 'query', toolName: 'codegraph_context', args: { task: 'how does auth work', sessionId: 's1' }, result: { answerable: true } }),
  line({ ts: '2026-07-01T09:01:00.000Z', event: 'query', toolName: 'codegraph_slice', args: { file: 'a.java', sessionId: 's1' } }),
  line({ ts: '2026-07-02T10:00:00.000Z', event: 'query', toolName: 'codegraph_slice', args: { file: 'b.java', sessionId: 's2' } }),
  line({ ts: '2026-07-02T10:05:00.000Z', event: 'query', toolName: 'codegraph_context', args: { task: 'trace api', sessionId: 's2' }, result: { answerable: false } }),
  line({ ts: '2026-07-03T11:00:00.000Z', event: 'query', toolName: 'codegraph_status' }),
  line({ ts: '2026-07-03T11:00:01.000Z', event: 'watch.refresh.failed', error: 'x' }),
  'not-json at all',
  '',
];

describe('buildAdoptionReport', () => {
  it('aggregates calls, sessions, gate-first starts, and answerable rate', () => {
    const report = buildAdoptionReport(SAMPLE);
    expect(report.totalCalls).toBe(5);
    expect(report.callsByTool.codegraph_context).toBe(2);
    expect(report.callsByTool.codegraph_slice).toBe(2);
    expect(report.callsByDay['2026-07-01']).toBe(2);
    expect(report.sessions).toBe(2);
    expect(report.callsWithSessionId).toBe(4);
    // s1 starts with the gate, s2 starts with a slice.
    expect(report.sessionsStartingWithGate).toBe(1);
    expect(report.answerableRate).toBe(50);
    expect(report.parseErrors).toBe(1);
  });

  it('applies since/until window filters', () => {
    const report = buildAdoptionReport(SAMPLE, { since: '2026-07-02T00:00:00Z', until: '2026-07-03T00:00:00Z' });
    expect(report.totalCalls).toBe(2);
    expect(report.sessions).toBe(1);
    expect(report.firstTs).toBe('2026-07-02T10:00:00.000Z');
  });

  it('renders an empty-window hint', () => {
    const text = formatAdoptionReportText(buildAdoptionReport([]));
    expect(text).toContain('No MCP calls in window');
  });
});
