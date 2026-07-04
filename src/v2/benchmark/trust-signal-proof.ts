import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { openCodeGraphDb, type CodeGraphDb } from '../storage/database.js';
import { V2Indexer } from '../index/indexer.js';
import { V2QueryService } from '../query/service.js';

/**
 * One-off effectiveness proof for the verifyBudget/trustPosture fields added
 * to get_research_pack/get_flow_pack (src/v2/query/evidence.ts). This is
 * deliberately NOT a permanent CI gate: it is a throwaway harness to answer
 * "does telling the agent exactly which fact is low-confidence actually
 * change its hedging behavior", referenced once from a PR description.
 *
 * Two independent things are checked, and the second requires a real LLM:
 *
 * 1. Harness/base-rate check (no LLM needed): for each fixture task, does the
 *    packet really carry a non-empty verifyBudget pointing at the deliberately
 *    ambiguous call edge? This proves the signal fires on real indexed code,
 *    not just the single hand-written unit-test fixture.
 * 2. Live agent-behavior check (needs `claude` CLI + ANTHROPIC_API_KEY or a
 *    logged-in session): feed the SAME packet twice — once with
 *    verifyBudget/trustPosture present, once with BOTH those fields AND the
 *    underlying per-edge confidence/resolutionKind/signalTier/signalReasons
 *    stripped (stripTrustSignals) — to a real Claude call, and score whether
 *    the response hedges unprompted (the prompt itself never asks the model
 *    to comment on certainty; asking directly turned out to saturate hedging
 *    in both arms in an earlier run and made the A/B undetectable). If no
 *    agent command is available, this step is skipped and reported as such
 *    rather than faked.
 *
 * Earlier version of this harness only deleted verifyBudget/trustPosture for
 * the "without" arm and asked the model directly "would you double-check
 * anything" — that confounded the comparison two ways: the leading question
 * primed hedging regardless of packet content (86.7% in both arms), and the
 * raw per-edge confidence/resolutionKind was still present either way (a
 * capable model reads it directly and hedges from that alone). Both are
 * fixed here.
 *
 * A second, subtler leak surfaced after that fix: the shallow stripTrustSignals
 * only cleared callers[]/callees[]/flowSteps(kind=call), but the real packet
 * duplicates confidence into definitionCandidates[], evidenceSlices[],
 * flowSteps entries of kind 'definition'/'file', compressedEvidence.factCards[],
 * and the packet's own top-level confidence/confidenceNotes (which spelled out
 * "ambiguous Java call edges remain confidence-scored" in plain English). A
 * transcript audit caught the model citing "confidence 0.4" verbatim in the
 * "without_field" arm, proving the leak. stripTrustSignals now recurses over
 * every key at every depth instead of enumerating containers by hand.
 */

export interface TrustSignalFixtureTask {
  id: string;
  /** relPath -> file content, written under a fresh temp repo root. */
  files: Record<string, string>;
  /** get_research_pack `target` string. */
  target: string;
  /** substring expected to appear in the flagged verifyBudget entry's file. */
  expectedFlaggedFileContains: string;
}

function ambiguousCallTask(id: string, methodName: string, classAName: string, classBName: string, callerName: string): TrustSignalFixtureTask {
  const pkg = `com.example.trustsignal.${id}`;
  return {
    id,
    target: `How does ${callerName} run call ${methodName}?`,
    expectedFlaggedFileContains: `${callerName}.java`,
    files: {
      [`src/main/java/${pkg.replace(/\./g, '/')}/${classAName}.java`]: `package ${pkg};

public class ${classAName} {
    int ${methodName}(int x) {
        return x + 1;
    }
}
`,
      [`src/main/java/${pkg.replace(/\./g, '/')}/${classBName}.java`]: `package ${pkg};

public class ${classBName} {
    int ${methodName}(int x) {
        return x * 2;
    }
}
`,
      [`src/main/java/${pkg.replace(/\./g, '/')}/${callerName}.java`]: `package ${pkg};

public class ${callerName} {
    int run(int x) {
        return ${methodName}(x);
    }
}
`,
    },
  };
}

/**
 * 5 distinct fixtures, same ambiguous-name-only-call shape, different names.
 * Caller class names deliberately avoid any substring the HEDGE_PATTERN below
 * matches (e.g. NOT "AmbiguousCaller" — that leaked into the prompt/output
 * verbatim as a quoted identifier and made HEDGE_PATTERN's `ambiguous\w*` false
 * -positive-match "AmbiguousCaller" via the camelCase run-on, with no word
 * boundary between "Ambiguous" and "Caller" for \w purposes. That inflated
 * the "without_field" hedge rate with zero actual hedging in the response.
 */
export function defaultTrustSignalTasks(): TrustSignalFixtureTask[] {
  return [
    ambiguousCallTask('t1', 'compute', 'AlphaHelper', 'BetaHelper', 'DualPathCaller'),
    ambiguousCallTask('t2', 'transform', 'ShapeA', 'ShapeB', 'TransformRunner'),
    ambiguousCallTask('t3', 'normalize', 'FormatterOne', 'FormatterTwo', 'NormalizeInvoker'),
    ambiguousCallTask('t4', 'resolve', 'ResolverX', 'ResolverY', 'ResolveDispatcher'),
    ambiguousCallTask('t5', 'apply', 'RuleA', 'RuleB', 'RuleApplier'),
  ];
}

export interface TrustSignalHarnessRow {
  id: string;
  sufficientForAnswer: boolean;
  verifyBudgetLength: number;
  trustPosture: string | undefined;
  flaggedFileMatches: boolean;
  harnessOk: boolean;
}

export interface TrustSignalAgentRow {
  id: string;
  condition: 'with_field' | 'without_field';
  repeat: number;
  hedged: boolean;
  exitStatus: number | null;
  outputPath: string;
}

export interface TrustSignalProofOptions {
  tasks?: TrustSignalFixtureTask[];
  repeats?: number;
  agentCommand?: string;
  agentCommandArgs?: string[];
  timeoutSeconds?: number;
  runDir?: string;
  /** Skip the live-agent step entirely even if a command is configured. */
  dryRun?: boolean;
}

export interface TrustSignalProofResult {
  harness: TrustSignalHarnessRow[];
  harnessPassRate: number;
  liveScoring: {
    ran: boolean;
    skippedReason?: string;
    rows: TrustSignalAgentRow[];
    hedgeRateWithField: number | null;
    hedgeRateWithoutField: number | null;
  };
}

// Broadened to catch inflected forms (double-checking, verifying, confirmed)
// that the original pattern's trailing \b missed after a "-check"/"-firm" stem.
const HEDGE_PATTERN = /\b(verif\w*|double[- ]?check\w*|not (?:certain|100% sure|fully sure|sure)|uncertain\w*|ambiguous\w*|might be wrong|cannot confirm|can'?t confirm|low[- ]confidence|name-only|worth (?:a )?(?:double[- ]?check|verif\w*)|would (?:want|need) to (?:verify|confirm|check)|not (?:completely |fully )?confident)\b/i;

/**
 * Removes every trust/confidence-carrying key anywhere in the packet tree,
 * not just on callers/callees edges. A first version of this function only
 * touched callers[], callees[], and flowSteps entries with kind === 'call' —
 * but the real get_research_pack output duplicates the same confidence
 * number and "ambiguous" framing into at least six other places:
 * definitionCandidates[].confidence, evidenceSlices[].confidence,
 * flowSteps[] entries of kind 'definition'/'file' (not just 'call'),
 * compressedEvidence.factCards[].confidence, and — the biggest leak — the
 * packet's own top-level confidence/confidenceNotes, where confidenceNotes
 * literally states in English that "ambiguous Java call edges remain
 * confidence-scored". Deleting only the first location left the other five
 * intact, so the "without_field" arm was never actually signal-free: a
 * transcript audit showed the model citing "confidence 0.4" verbatim in
 * that arm. Recursing over every key at every depth (rather than
 * enumerating known containers by hand) is the only way to be sure nothing
 * new added to the packet shape re-opens this leak.
 */
const TRUST_SIGNAL_KEYS = new Set(['verifyBudget', 'trustPosture', 'confidence', 'confidenceNotes', 'resolutionKind', 'signalTier', 'signalReasons']);

function stripTrustSignalsDeep(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(stripTrustSignalsDeep);
    return;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (TRUST_SIGNAL_KEYS.has(key)) {
        delete obj[key];
      } else {
        stripTrustSignalsDeep(obj[key]);
      }
    }
  }
}

function stripTrustSignals(packet: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(packet)) as Record<string, unknown>;
  stripTrustSignalsDeep(clone);
  return clone;
}

function resolveAgentCommand(command?: string): { command: string; args: string[] } | undefined {
  const resolved = command ?? process.env.CODEGRAPH_TRUST_SIGNAL_AGENT_COMMAND ?? 'claude';
  const probe = spawnSync(resolved, ['--version'], { encoding: 'utf-8', windowsHide: true, timeout: 10_000 });
  if (probe.error || probe.status !== 0) return undefined;
  return { command: resolved, args: [] };
}

function promptFor(task: TrustSignalFixtureTask, packet: Record<string, unknown>): string {
  // Deliberately does NOT ask "would you want to verify/double-check anything" —
  // that framing is a leading question that elicits hedging regardless of
  // packet content (confirmed empirically: it saturated both A/B arms at the
  // same rate). Ask only for a direct final answer; hedging is scored only
  // if the model volunteers it unprompted.
  return [
    `Task: ${task.target}`,
    'You are given a CodeGraph research-pack JSON below. Give a direct, final answer to the task, based only on the packet.',
    '',
    'Packet:',
    JSON.stringify(packet, null, 2),
  ].join('\n');
}

export async function runTrustSignalProof(options: TrustSignalProofOptions = {}): Promise<TrustSignalProofResult> {
  const tasks = options.tasks ?? defaultTrustSignalTasks();
  const repeats = options.repeats ?? 3;
  const timeoutSeconds = options.timeoutSeconds ?? 60;
  const runDir = options.runDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-trust-signal-'));
  fs.mkdirSync(runDir, { recursive: true });

  const harness: TrustSignalHarnessRow[] = [];
  const packetsByTask: Array<{ id: string; withField: Record<string, unknown>; withoutField: Record<string, unknown> }> = [];

  for (const task of tasks) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-trust-signal-repo-${task.id}-`));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-trust-signal-home-${task.id}-`));
    for (const [relPath, content] of Object.entries(task.files)) {
      const absPath = path.join(repoRoot, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content, 'utf-8');
    }
    let db: CodeGraphDb | undefined;
    try {
      const opened = await openCodeGraphDb(home);
      db = opened.db;
      const indexer = new V2Indexer(db);
      const result = await indexer.indexWorkspace({ root: repoRoot });
      const queries = new V2QueryService(db);
      const packet = await queries.query({
        workspaceId: result.workspaceId,
        toolName: 'get_research_pack',
        args: { target: task.target, taskType: 'architecture', tokenBudget: 5000 },
      }) as Record<string, unknown>;

      const verifyBudget = Array.isArray(packet.verifyBudget) ? packet.verifyBudget as Array<Record<string, unknown>> : [];
      const completeness = packet.completeness as { sufficientForAnswer?: boolean } | undefined;
      const flaggedFileMatches = verifyBudget.some(item => String(item.file ?? '').includes(task.expectedFlaggedFileContains));
      const sufficientForAnswer = Boolean(completeness?.sufficientForAnswer);

      harness.push({
        id: task.id,
        sufficientForAnswer,
        verifyBudgetLength: verifyBudget.length,
        trustPosture: typeof packet.trustPosture === 'string' ? packet.trustPosture : undefined,
        flaggedFileMatches,
        harnessOk: sufficientForAnswer && verifyBudget.length > 0 && flaggedFileMatches,
      });

      packetsByTask.push({ id: task.id, withField: packet, withoutField: stripTrustSignals(packet) });
    } finally {
      if (db) await db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  const harnessPassRate = harness.length > 0 ? harness.filter(r => r.harnessOk).length / harness.length : 0;

  if (options.dryRun) {
    return {
      harness,
      harnessPassRate,
      liveScoring: { ran: false, skippedReason: 'dryRun=true: live agent scoring not attempted.', rows: [], hedgeRateWithField: null, hedgeRateWithoutField: null },
    };
  }

  const agent = resolveAgentCommand(options.agentCommand);
  if (!agent) {
    return {
      harness,
      harnessPassRate,
      liveScoring: {
        ran: false,
        skippedReason: 'No usable agent command found (checked `claude --version` / CODEGRAPH_TRUST_SIGNAL_AGENT_COMMAND). '
          + 'Set ANTHROPIC_API_KEY or run `claude /login`, then re-run without dryRun to get live hedge-rate numbers.',
        rows: [],
        hedgeRateWithField: null,
        hedgeRateWithoutField: null,
      },
    };
  }

  const rows: TrustSignalAgentRow[] = [];
  for (const { id, withField, withoutField } of packetsByTask) {
    const task = tasks.find(t => t.id === id)!;
    for (const [condition, packet] of [['with_field', withField], ['without_field', withoutField]] as const) {
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        const prompt = promptFor(task, packet);
        const outputPath = path.join(runDir, `${id}-${condition}-${repeat}.txt`);
        const result = spawnSync(agent.command, [...agent.args, '-p', prompt], {
          encoding: 'utf-8',
          timeout: timeoutSeconds * 1000,
          windowsHide: true,
          maxBuffer: 64 * 1024 * 1024,
        });
        const stdout = result.stdout ?? '';
        fs.writeFileSync(outputPath, stdout || String(result.error ?? ''), 'utf-8');
        rows.push({
          id,
          condition,
          repeat,
          hedged: HEDGE_PATTERN.test(stdout),
          exitStatus: result.status,
          outputPath,
        });
      }
    }
  }

  const withFieldRows = rows.filter(r => r.condition === 'with_field');
  const withoutFieldRows = rows.filter(r => r.condition === 'without_field');
  const hedgeRateWithField = withFieldRows.length > 0 ? withFieldRows.filter(r => r.hedged).length / withFieldRows.length : null;
  const hedgeRateWithoutField = withoutFieldRows.length > 0 ? withoutFieldRows.filter(r => r.hedged).length / withoutFieldRows.length : null;

  return {
    harness,
    harnessPassRate,
    liveScoring: { ran: true, rows, hedgeRateWithField, hedgeRateWithoutField },
  };
}
