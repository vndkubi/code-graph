/**
 * `codegraph adoption-report`: aggregate the per-workspace MCP query log
 * (.codegraph/logs/query.jsonl) into real-usage adoption numbers — the
 * dogfood-proof instrumentation from docs/mcp-adoption-plan.md.
 *
 * The query log is the call ledger: every MCP tool call appends
 * {ts, toolName, args:{sessionId?, task?...}, durationMs, result:{answerable?}}.
 * This report answers: how often is CodeGraph actually called, by which tools,
 * across how many conversations, and did conversations start with the gate?
 */

export interface AdoptionReportOptions {
  /** ISO date/time lower bound (inclusive). */
  since?: string;
  /** ISO date/time upper bound (exclusive). */
  until?: string;
}

export interface AdoptionReport {
  totalCalls: number;
  firstTs?: string;
  lastTs?: string;
  callsByTool: Record<string, number>;
  callsByDay: Record<string, number>;
  /** Conversations = distinct args.sessionId values (the evidence-ledger id). */
  sessions: number;
  callsWithSessionId: number;
  /** Sessions whose first logged call is the codegraph_context gate. */
  sessionsStartingWithGate: number;
  avgCallsPerSession?: number;
  /** answerable=true results / results that reported answerable at all. */
  answerableRate?: number;
  parseErrors: number;
}

interface LedgerEvent {
  ts: string;
  toolName: string;
  sessionId?: string;
  answerable?: boolean;
}

const GATE_TOOL = 'codegraph_context';

export function buildAdoptionReport(jsonlLines: Iterable<string>, options: AdoptionReportOptions = {}): AdoptionReport {
  const sinceMs = options.since ? Date.parse(options.since) : undefined;
  const untilMs = options.until ? Date.parse(options.until) : undefined;
  const events: LedgerEvent[] = [];
  let parseErrors = 0;
  for (const line of jsonlLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      parseErrors += 1;
      continue;
    }
    if (parsed.event !== 'query' || typeof parsed.toolName !== 'string' || typeof parsed.ts !== 'string') continue;
    const tsMs = Date.parse(parsed.ts);
    if (Number.isNaN(tsMs)) continue;
    if (sinceMs !== undefined && tsMs < sinceMs) continue;
    if (untilMs !== undefined && tsMs >= untilMs) continue;
    const args = parsed.args as Record<string, unknown> | undefined;
    const result = parsed.result as Record<string, unknown> | undefined;
    events.push({
      ts: parsed.ts,
      toolName: parsed.toolName,
      sessionId: typeof args?.sessionId === 'string' && args.sessionId.length > 0 ? args.sessionId : undefined,
      answerable: typeof result?.answerable === 'boolean' ? result.answerable : undefined,
    });
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts));

  const callsByTool: Record<string, number> = {};
  const callsByDay: Record<string, number> = {};
  const firstCallBySession = new Map<string, string>();
  const callsBySession = new Map<string, number>();
  let callsWithSessionId = 0;
  let answerableReported = 0;
  let answerableTrue = 0;
  for (const event of events) {
    callsByTool[event.toolName] = (callsByTool[event.toolName] ?? 0) + 1;
    const day = event.ts.slice(0, 10);
    callsByDay[day] = (callsByDay[day] ?? 0) + 1;
    if (event.sessionId) {
      callsWithSessionId += 1;
      callsBySession.set(event.sessionId, (callsBySession.get(event.sessionId) ?? 0) + 1);
      if (!firstCallBySession.has(event.sessionId)) firstCallBySession.set(event.sessionId, event.toolName);
    }
    if (event.answerable !== undefined) {
      answerableReported += 1;
      if (event.answerable) answerableTrue += 1;
    }
  }

  const sessions = callsBySession.size;
  const sessionsStartingWithGate = [...firstCallBySession.values()].filter(tool => tool === GATE_TOOL).length;
  return {
    totalCalls: events.length,
    firstTs: events[0]?.ts,
    lastTs: events[events.length - 1]?.ts,
    callsByTool,
    callsByDay,
    sessions,
    callsWithSessionId,
    sessionsStartingWithGate,
    avgCallsPerSession: sessions > 0 ? Math.round((callsWithSessionId / sessions) * 10) / 10 : undefined,
    answerableRate: answerableReported > 0 ? Math.round((answerableTrue / answerableReported) * 1000) / 10 : undefined,
    parseErrors,
  };
}

export function formatAdoptionReportText(report: AdoptionReport): string {
  const lines: string[] = [];
  lines.push(`Calls: ${report.totalCalls}${report.firstTs ? ` (${report.firstTs.slice(0, 10)} → ${report.lastTs?.slice(0, 10)})` : ''}`);
  const tools = Object.entries(report.callsByTool).sort((a, b) => b[1] - a[1]);
  for (const [tool, count] of tools) lines.push(`  ${tool}: ${count}`);
  lines.push(`Conversations with sessionId: ${report.sessions} (${report.callsWithSessionId}/${report.totalCalls} calls tagged)`);
  if (report.sessions > 0) {
    lines.push(`  starting with ${GATE_TOOL}: ${report.sessionsStartingWithGate}/${report.sessions}`);
    lines.push(`  avg calls/conversation: ${report.avgCallsPerSession}`);
  }
  if (report.answerableRate !== undefined) lines.push(`Answerable-rate of packets: ${report.answerableRate}%`);
  if (report.parseErrors > 0) lines.push(`Parse errors skipped: ${report.parseErrors}`);
  if (report.totalCalls === 0) lines.push('No MCP calls in window. Is the MCP server configured for this workspace?');
  return lines.join('\n');
}
