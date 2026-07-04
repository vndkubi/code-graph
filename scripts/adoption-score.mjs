#!/usr/bin/env node
/**
 * Adoption scorer for the MCP adoption plan (docs/mcp-adoption-plan.md).
 *
 * Parses tool-call sequences out of agent transcripts and emits the four
 * adoption metrics the proof protocol needs:
 *   - adoption rate        (% sessions with >=1 codegraph MCP call)
 *   - turns to first call  (1-based index of the first codegraph call)
 *   - stop-rule compliance (% answerable=true packets followed by zero
 *                           further search/read tool calls)
 *   - double-spend rate    (% sessions that re-grep/re-read a file the packet
 *                           already delivered as evidence)
 *
 * Inputs:
 *   --copilot-run-dir <dir>   a copilot-e2e-quality-bench.ps1 run directory
 *                             (reads quality-report.json + per-task
 *                             copilot.stdout.jsonl, plus the Copilot
 *                             session-state events.jsonl when present)
 *   --claude-jsonl <file>     a Claude Code session transcript (repeatable)
 *   --claude-dir <dir>        scan a directory for *.jsonl Claude transcripts
 *   --json                    machine-readable output only
 *
 * No dependencies; Node >= 18.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CODEGRAPH_TOOL_RE = /codegraph|contextgate|tokenopt/i;
// Builtin exploration tools across clients (Claude Code, Copilot CLI, VS Code).
const SEARCH_READ_RE = /^(grep|glob|read|bash|powershell|shell|view|cat|str_replace_editor|list_dir|file_search|read_file|run_in_terminal|terminal|semantic_search|text_search|search|find|grep_search|get_file|open_file)$/i;
const ANSWERABLE_RE = /"(answerable|sufficientForAnswer)"\s*:\s*true/;
const EVIDENCE_FILE_RE = /"file"\s*:\s*"([^"\\]{2,260})"/g;

function parseArgs(argv) {
  const options = { copilotRunDirs: [], claudeJsonl: [], claudeDirs: [], json: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--copilot-run-dir') options.copilotRunDirs.push(argv[++i]);
    else if (arg === '--claude-jsonl') options.claudeJsonl.push(argv[++i]);
    else if (arg === '--claude-dir') options.claudeDirs.push(argv[++i]);
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') { printUsage(); process.exit(0); }
    else { console.error(`Unknown argument: ${arg}`); printUsage(); process.exit(1); }
  }
  return options;
}

function printUsage() {
  console.error('Usage: node scripts/adoption-score.mjs [--copilot-run-dir <dir>] [--claude-jsonl <file>]... [--claude-dir <dir>] [--json]');
}

function readJsonlLines(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { events.push(JSON.parse(trimmed)); } catch { /* partial line */ }
  }
  return events;
}

function normalizePath(value) {
  return String(value).replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase();
}

/**
 * A session reduces to an ordered list of steps:
 *   { kind: 'call', name, inputText } | { kind: 'result', name, text }
 */
function scoreSession(steps) {
  const calls = steps.filter(step => step.kind === 'call');
  const cgCallIndexes = [];
  calls.forEach((call, index) => {
    if (CODEGRAPH_TOOL_RE.test(call.name)) cgCallIndexes.push(index);
  });
  const adopted = cgCallIndexes.length > 0;
  const turnsToFirst = adopted ? cgCallIndexes[0] + 1 : null;

  // Walk in event order for answerable packets and what follows them.
  let sawAnswerable = false;
  let violationsAfterAnswerable = 0;
  let doubleSpend = false;
  const evidenceFiles = new Set();
  for (const step of steps) {
    if (step.kind === 'result' && CODEGRAPH_TOOL_RE.test(step.name ?? '') && typeof step.text === 'string') {
      if (ANSWERABLE_RE.test(step.text)) sawAnswerable = true;
      for (const match of step.text.matchAll(EVIDENCE_FILE_RE)) {
        const file = normalizePath(match[1]);
        if (file.includes('.') || file.includes('/')) evidenceFiles.add(file);
      }
      continue;
    }
    if (step.kind !== 'call' || CODEGRAPH_TOOL_RE.test(step.name)) continue;
    const isExplore = SEARCH_READ_RE.test(step.name);
    if (!isExplore) continue;
    if (sawAnswerable) violationsAfterAnswerable += 1;
    if (evidenceFiles.size > 0 && typeof step.inputText === 'string') {
      const input = normalizePath(step.inputText);
      for (const file of evidenceFiles) {
        const suffix = file.split('/').slice(-2).join('/');
        if (suffix.length >= 5 && input.includes(suffix)) { doubleSpend = true; break; }
      }
    }
  }

  return {
    toolCalls: calls.length,
    codegraphCalls: cgCallIndexes.length,
    adopted,
    turnsToFirst,
    sawAnswerable,
    stopRuleCompliant: sawAnswerable ? violationsAfterAnswerable === 0 : null,
    doubleSpend: evidenceFiles.size > 0 ? doubleSpend : null,
  };
}

/** Claude Code session JSONL -> ordered steps. */
function stepsFromClaudeJsonl(filePath) {
  const steps = [];
  const callNamesById = new Map();
  for (const entry of readJsonlLines(filePath)) {
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item?.type === 'tool_use' && typeof item.name === 'string') {
        callNamesById.set(item.id, item.name);
        steps.push({ kind: 'call', name: item.name, inputText: safeStringify(item.input) });
      } else if (item?.type === 'tool_result') {
        const name = callNamesById.get(item.tool_use_id) ?? '';
        steps.push({ kind: 'result', name, text: toolResultText(item) });
      }
    }
  }
  return steps;
}

function toolResultText(item) {
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) {
    return item.content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('\n');
  }
  return '';
}

function safeStringify(value) {
  try { return JSON.stringify(value) ?? ''; } catch { return ''; }
}

/**
 * Copilot CLI JSONL -> ordered steps. Event shapes differ across CLI versions,
 * so this matches defensively: any event whose type mentions "tool" yields a
 * call/result step when a tool name can be extracted.
 */
function stepsFromCopilotJsonl(filePath) {
  const steps = [];
  for (const event of readJsonlLines(filePath)) {
    const type = String(event?.type ?? '');
    if (!/tool/i.test(type)) continue;
    const data = event.data ?? event;
    const name = firstString(data.name, data.toolName, data.tool_name, data.tool, event.name);
    if (!name) continue;
    const resultText = firstString(
      typeof data.result === 'string' ? data.result : safeStringify(data.result),
      typeof data.output === 'string' ? data.output : safeStringify(data.output),
      typeof data.content === 'string' ? data.content : undefined,
    );
    const isCallish = /call|start|invoke|begin|request/i.test(type);
    if (isCallish) {
      steps.push({ kind: 'call', name, inputText: safeStringify(data.arguments ?? data.input ?? data.args) });
      if (resultText && resultText.length > 2) steps.push({ kind: 'result', name, text: resultText });
    } else {
      steps.push({ kind: 'result', name, text: resultText ?? '' });
    }
  }
  // If no explicit call events were found (result-only logs), synthesize calls
  // from results so adoption/turn metrics still work.
  if (!steps.some(step => step.kind === 'call')) {
    return steps.flatMap(step => [{ kind: 'call', name: step.name, inputText: '' }, step]);
  }
  return steps;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0 && value !== '{}' && value !== 'null') return value;
  }
  return undefined;
}

function collectCopilotSessions(runDir) {
  const sessions = [];
  const reportPath = path.join(runDir, 'quality-report.json');
  let runs = [];
  if (fs.existsSync(reportPath)) {
    // PowerShell 5.1 writes UTF-8 with BOM; strip it or JSON.parse throws.
    try { runs = JSON.parse(fs.readFileSync(reportPath, 'utf-8').replace(/^﻿/, '')).runs ?? []; } catch { runs = []; }
  }
  const runByDir = new Map();
  for (const run of runs) {
    const safeName = `${run.id}__${run.model}__${run.mode}`.replace(/[^A-Za-z0-9_.-]/g, '_');
    runByDir.set(safeName, run);
  }
  let entries = [];
  try { entries = fs.readdirSync(runDir, { withFileTypes: true }); } catch { return sessions; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const stdoutPath = path.join(runDir, entry.name, 'copilot.stdout.jsonl');
    if (!fs.existsSync(stdoutPath)) continue;
    const run = runByDir.get(entry.name);
    let steps = stepsFromCopilotJsonl(stdoutPath);
    // The session-state events file usually has richer tool events.
    if (run?.sessionId) {
      const eventsPath = path.join(os.homedir(), '.copilot', 'session-state', run.sessionId, 'events.jsonl');
      if (fs.existsSync(eventsPath)) {
        const eventSteps = stepsFromCopilotJsonl(eventsPath);
        if (eventSteps.filter(step => step.kind === 'call').length > steps.filter(step => step.kind === 'call').length) {
          steps = eventSteps;
        }
      }
    }
    const parts = entry.name.split('__');
    sessions.push({
      client: 'copilot',
      label: entry.name,
      mode: run?.mode ?? parts[2] ?? 'unknown',
      model: run?.model ?? parts[1] ?? 'unknown',
      quality: run?.quality,
      totalTokens: run?.totalTokens,
      score: scoreSession(steps),
    });
  }
  return sessions;
}

function collectClaudeSessions(options) {
  const files = [...options.claudeJsonl];
  for (const dir of options.claudeDirs) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.jsonl')) files.push(path.join(dir, name));
      }
    } catch { /* unreadable dir */ }
  }
  return files.map(file => ({
    client: 'claude',
    label: path.basename(file, '.jsonl'),
    mode: 'organic',
    model: 'claude',
    score: scoreSession(stepsFromClaudeJsonl(file)),
  }));
}

function aggregate(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const key = `${session.client}|${session.mode}|${session.model}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(session);
  }
  const rows = [];
  for (const [key, group] of groups) {
    const [client, mode, model] = key.split('|');
    const scores = group.map(session => session.score);
    const adopted = scores.filter(score => score.adopted);
    const withAnswerable = scores.filter(score => score.sawAnswerable);
    const withEvidence = scores.filter(score => score.doubleSpend !== null);
    rows.push({
      client,
      mode,
      model,
      sessions: scores.length,
      adopted: adopted.length,
      adoptionPct: pct(adopted.length, scores.length),
      medianTurnsToFirst: median(adopted.map(score => score.turnsToFirst)),
      stopRuleCompliantPct: pct(withAnswerable.filter(score => score.stopRuleCompliant).length, withAnswerable.length),
      doubleSpendPct: pct(withEvidence.filter(score => score.doubleSpend).length, withEvidence.length),
      answerablePackets: withAnswerable.length,
      avgToolCalls: avg(scores.map(score => score.toolCalls)),
      avgCodegraphCalls: avg(scores.map(score => score.codegraphCalls)),
    });
  }
  return rows.sort((a, b) => a.client.localeCompare(b.client) || a.mode.localeCompare(b.mode) || a.model.localeCompare(b.model));
}

function pct(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
}

function median(values) {
  const nums = values.filter(value => typeof value === 'number').sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
}

function avg(values) {
  const nums = values.filter(value => typeof value === 'number');
  if (nums.length === 0) return null;
  return Math.round((nums.reduce((sum, value) => sum + value, 0) / nums.length) * 10) / 10;
}

function formatValue(value, suffix = '') {
  return value === null || value === undefined ? '—' : `${value}${suffix}`;
}

function main() {
  const options = parseArgs(process.argv);
  const sessions = [];
  for (const runDir of options.copilotRunDirs) sessions.push(...collectCopilotSessions(runDir));
  sessions.push(...collectClaudeSessions(options));
  if (sessions.length === 0) {
    console.error('No sessions found. Pass --copilot-run-dir and/or --claude-jsonl/--claude-dir.');
    process.exit(1);
  }
  const rows = aggregate(sessions);
  const output = { generatedAt: new Date().toISOString(), groups: rows, sessions };
  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  console.log(JSON.stringify(output, null, 2));
  console.log('\nResults-log rows (docs/mcp-adoption-plan.md):\n');
  const date = new Date().toISOString().slice(0, 10);
  for (const row of rows) {
    console.log(
      `| ${date} | <checkpoint> | ${row.client} ${row.mode}/${row.model} ` +
      `| ${formatValue(row.adoptionPct, '%')} (${row.adopted}/${row.sessions}) ` +
      `| ${formatValue(row.medianTurnsToFirst)} ` +
      `| ${formatValue(row.doubleSpendPct, '%')} ` +
      `| ${formatValue(row.stopRuleCompliantPct, '%')} | — | — |`,
    );
  }
}

main();
