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
 *    verifyBudget/trustPosture present, once with those two keys stripped
 *    (simulating pre-change behavior) — to a real Claude call, and score
 *    whether the response hedges/offers to verify the flagged fact. If no
 *    agent command is available, this step is skipped and reported as such
 *    rather than faked.
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

/** 5 distinct fixtures, same ambiguous-name-only-call shape, different names. */
export function defaultTrustSignalTasks(): TrustSignalFixtureTask[] {
  return [
    ambiguousCallTask('t1', 'compute', 'AlphaHelper', 'BetaHelper', 'AmbiguousCaller'),
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

const HEDGE_PATTERN = /\b(verify|double[- ]check|not certain|not sure|uncertain|ambiguous|might be wrong|cannot confirm|can't confirm|low confidence)\b/i;

function stripVerifyBudget(packet: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(packet)) as Record<string, unknown>;
  delete clone.verifyBudget;
  delete clone.trustPosture;
  return clone;
}

function resolveAgentCommand(command?: string): { command: string; args: string[] } | undefined {
  const resolved = command ?? process.env.CODEGRAPH_TRUST_SIGNAL_AGENT_COMMAND ?? 'claude';
  const probe = spawnSync(resolved, ['--version'], { encoding: 'utf-8', windowsHide: true, timeout: 10_000 });
  if (probe.error || probe.status !== 0) return undefined;
  return { command: resolved, args: [] };
}

function promptFor(task: TrustSignalFixtureTask, packet: Record<string, unknown>): string {
  return [
    `Task: ${task.target}`,
    'You are given a CodeGraph research-pack JSON below. Answer the task from the packet.',
    'Explicitly say whether there is anything in the packet you would want to double-check or verify before treating your answer as certain, and why.',
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

      packetsByTask.push({ id: task.id, withField: packet, withoutField: stripVerifyBudget(packet) });
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
