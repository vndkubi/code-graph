import fs from 'node:fs';
import path from 'node:path';
import { inspectCodeGraphRoute, type CodeGraphContextMode } from '../mcp/proxy.js';

export interface RouteGateTask {
  id: string;
  task?: string;
  prompt?: string;
  mode?: CodeGraphContextMode;
  expectedMode?: CodeGraphContextMode;
  expectedTool?: string;
  expectedMaxAdditionalCalls?: number;
  diff?: string;
  files?: string[];
  symbols?: string[];
}

export interface RouteGateSuite {
  name?: string;
  tasks: RouteGateTask[];
}

export interface RouteGateTaskResult {
  id: string;
  task: string;
  expectedMode: CodeGraphContextMode;
  actualMode: string;
  expectedTool: string;
  actualTool: string;
  expectedMaxAdditionalCalls: number;
  actualMaxAdditionalCalls: number;
  passed: boolean;
  failures: string[];
  route: Record<string, unknown>;
}

export interface RouteGateReport {
  suite: string;
  tasks: RouteGateTaskResult[];
  totals: {
    tasks: number;
    passed: number;
    failed: number;
    passRate: number;
  };
  gate: {
    denyBroadShellAfterAnswerable: true;
    requireCodeGraphContextFirst: true;
    requireExactFollowupsOnly: true;
  };
}

export function loadRouteGateSuite(suitePath?: string): RouteGateSuite {
  if (!suitePath) return defaultRouteGateSuite();
  const resolved = path.resolve(suitePath);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf-8')) as RouteGateSuite;
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error(`Route gate suite has no tasks: ${resolved}`);
  }
  return parsed;
}

export function runRouteGateBenchmark(suitePath?: string): RouteGateReport {
  const suite = loadRouteGateSuite(suitePath);
  const tasks = suite.tasks.map(evaluateRouteGateTask);
  const passed = tasks.filter(task => task.passed).length;
  return {
    suite: suite.name ?? path.basename(suitePath ?? 'default-route-gate-suite'),
    tasks,
    totals: {
      tasks: tasks.length,
      passed,
      failed: tasks.length - passed,
      passRate: tasks.length === 0 ? 0 : Number((passed / tasks.length).toFixed(3)),
    },
    gate: {
      denyBroadShellAfterAnswerable: true,
      requireCodeGraphContextFirst: true,
      requireExactFollowupsOnly: true,
    },
  };
}

function evaluateRouteGateTask(task: RouteGateTask): RouteGateTaskResult {
  const taskText = String(task.task ?? task.prompt ?? '').trim();
  if (!taskText) throw new Error(`Route gate task ${task.id} has no task or prompt text.`);
  const route = inspectCodeGraphRoute({
    task: taskText,
    mode: task.mode ?? 'auto',
    diff: task.diff,
    files: task.files,
    symbols: task.symbols,
  });
  const actualMode = String(route.inferredMode ?? 'unknown');
  const actualTool = String(route.routedTool ?? 'unknown');
  const expectedMode = task.expectedMode ?? inferExpectedModeForRouteGate(taskText, task);
  const expectedTool = task.expectedTool ?? expectedToolForMode(expectedMode);
  const expectedMaxAdditionalCalls = task.expectedMaxAdditionalCalls ?? (expectedTool === 'get_change_pack' ? 1 : 0);
  const actualMaxAdditionalCalls = Number(route.expectedMaxAdditionalCalls ?? 0);
  const failures: string[] = [];
  if (actualMode !== expectedMode) failures.push(`expected mode ${expectedMode}, got ${actualMode}`);
  if (actualTool !== expectedTool) failures.push(`expected tool ${expectedTool}, got ${actualTool}`);
  if (actualMaxAdditionalCalls > expectedMaxAdditionalCalls) {
    failures.push(`expected <= ${expectedMaxAdditionalCalls} additional calls, got ${actualMaxAdditionalCalls}`);
  }
  return {
    id: task.id,
    task: taskText,
    expectedMode,
    actualMode,
    expectedTool,
    actualTool,
    expectedMaxAdditionalCalls,
    actualMaxAdditionalCalls,
    passed: failures.length === 0,
    failures,
    route,
  };
}

function inferExpectedModeForRouteGate(task: string, input: RouteGateTask): CodeGraphContextMode {
  if (input.expectedMode) return input.expectedMode;
  if (input.diff) return 'review';
  const text = task.toLowerCase();
  if (/\b(review|diff|pr|risk|finding)\b|\bpatch\b(?!\s*\/)/.test(text)) return 'review';
  if (/\b(evidence|answerable|rubric|coverage|pbi|ticket|story|acceptance criteria)\b/.test(text)) return 'evidence';
  if (hasExpectedChangeIntent(text)) return 'change';
  if (hasExpectedFlowIntent(text)) return 'flow';
  return 'research';
}

function hasExpectedChangeIntent(text: string): boolean {
  return /\b(implement|fix|debug|refactor|change|modify|test|add|remove|update|bug|regression|failure|failing|root cause)\b/.test(text)
    || /\binvestigate\b.*\b(bug|issue|error|failure|failing|regression|timeout|wrong|slow|root cause)\b/.test(text)
    || /\bwhy\b.*\b(fail|fails|failing|error|timeout|wrong|slow|happen|happens)\b/.test(text);
}

function hasExpectedFlowIntent(text: string): boolean {
  return /\b(get|post|put|delete|patch)\s+\//.test(text)
    || /\b(endpoint|api|route|request flow|startup flow|method flow|handler flow|rpc)\b/.test(text)
    || /\btrace\b.*\b(flow|route|endpoint|api|handler|request)\b/.test(text);
}

function expectedToolForMode(mode: CodeGraphContextMode): string {
  switch (mode) {
    case 'review':
      return 'review_patch';
    case 'flow':
      return 'get_flow_pack';
    case 'change':
      return 'get_change_pack';
    case 'evidence':
      return 'compile_evidence';
    case 'research':
      return 'get_research_pack';
  }
}

function defaultRouteGateSuite(): RouteGateSuite {
  return {
    name: 'default-route-gate',
    tasks: [
      {
        id: 'pbi-evidence',
        task: 'Analyze PBI acceptance criteria against current code and return answerable coverage.',
        expectedMode: 'evidence',
        expectedTool: 'compile_evidence',
      },
      {
        id: 'change-implementation',
        task: 'Implement a validation change in OrderService without broad repo search.',
        expectedMode: 'change',
        expectedTool: 'get_change_pack',
        expectedMaxAdditionalCalls: 1,
      },
      {
        id: 'api-flow',
        task: 'Trace GET /api/orders request flow from handler to service and tests.',
        expectedMode: 'flow',
        expectedTool: 'get_flow_pack',
      },
      {
        id: 'patch-review',
        task: 'Review this diff for correctness and missing tests.',
        diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts',
        expectedMode: 'review',
        expectedTool: 'review_patch',
      },
      {
        id: 'architecture-research',
        task: 'Explain the repository architecture and main modules.',
        expectedMode: 'research',
        expectedTool: 'get_research_pack',
      },
    ],
  };
}
