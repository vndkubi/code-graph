/**
 * Task-oracle construction and pack-time slimming. Builds the "golden facts /
 * success criteria / guardrails" oracle that packs attach so an agent knows what
 * a correct answer looks like. Extracted from service.ts; pure functions.
 */
import { stringOrUndefined, stringArray, isPlainObject, arrayRecords, uniqueStrings, truncateString } from './util.js';
import { PackProfile } from './pack-profile.js';

export function slimTestsForPack(tests: Array<Record<string, unknown>>, profile: PackProfile): Array<Record<string, unknown>> {
  if (profile === 'full') return tests;
  const limit = profile === 'micro' ? 4 : 6;
  return tests.slice(0, limit).map(test => ({
    file: String(test.file ?? ''),
    symbol: stringOrUndefined(test.symbol),
    score: typeof test.score === 'number' ? test.score : undefined,
    reasons: stringArray(test.reasons).slice(0, profile === 'micro' ? 1 : 2),
  })).filter(test => test.file);
}

export function slimValidationForPack(validation: Record<string, unknown>, profile: PackProfile): Record<string, unknown> {
  if (profile === 'full') return validation;
  return {
    targetedTestFiles: stringArray(validation.targetedTestFiles).slice(0, profile === 'micro' ? 4 : 6),
    suggestedCommands: stringArray(validation.suggestedCommands).slice(0, profile === 'micro' ? 2 : 3),
    packageManager: stringOrUndefined(validation.packageManager),
  };
}

export function slimTaskOracleForPack(taskOracle: Record<string, unknown>, profile: PackProfile): Record<string, unknown> {
  if (profile === 'full') return taskOracle;
  const factLimit = profile === 'micro' ? 5 : 8;
  return {
    taskType: stringOrUndefined(taskOracle.taskType),
    successCriteria: stringArray(taskOracle.successCriteria).slice(0, profile === 'micro' ? 3 : 5),
    expectedVerification: isPlainObject(taskOracle.expectedVerification)
      ? {
        commands: stringArray(taskOracle.expectedVerification.commands).slice(0, profile === 'micro' ? 2 : 3),
        targetedTestFiles: stringArray(taskOracle.expectedVerification.targetedTestFiles).slice(0, profile === 'micro' ? 4 : 6),
        fallback: stringOrUndefined(taskOracle.expectedVerification.fallback),
        redGreenRequired: taskOracle.expectedVerification.redGreenRequired,
      }
      : undefined,
    likelyTests: slimTestsForPack(arrayRecords(taskOracle.likelyTests), profile),
    goldenFacts: arrayRecords(taskOracle.goldenFacts).slice(0, factLimit),
    editGuardrails: stringArray(taskOracle.editGuardrails).slice(0, profile === 'micro' ? 2 : 4),
    passSignal: stringOrUndefined(taskOracle.passSignal),
  };
}

export interface TaskOracleInput {
  task: string;
  taskType: string;
  candidateFiles: Array<{ file: string; lines?: string; whyRelevant?: string; confidence?: number }>;
  relevantSymbols: Array<{ symbol: string; name?: string; file: string; lines?: string; confidence?: number }>;
  testsLikelyRelevant: Array<Record<string, unknown>>;
  validation: Record<string, unknown>;
  flowSteps: Array<Record<string, unknown>>;
  evidenceSlices: Array<Record<string, unknown>>;
}

export function taskOracleFor(input: TaskOracleInput): Record<string, unknown> {
  const taskType = normalizeOracleTaskType(input.taskType);
  const topFiles = uniqueStrings(input.candidateFiles.map(file => file.file).filter(Boolean)).slice(0, 6);
  const topSymbols = uniqueStrings(input.relevantSymbols.map(symbol => symbol.symbol || symbol.name || '').filter(Boolean)).slice(0, 8);
  const likelyTests = input.testsLikelyRelevant
    .slice(0, 8)
    .map(test => ({
      file: String(test.file ?? ''),
      why: Array.isArray(test.reasons) ? (test.reasons as unknown[]).map(String).slice(0, 3) : undefined,
      score: typeof test.score === 'number' ? test.score : undefined,
    }))
    .filter(test => test.file);
  const suggestedCommands = stringArray(input.validation.suggestedCommands).slice(0, 4);
  const targetedTestFiles = stringArray(input.validation.targetedTestFiles).slice(0, 8);

  return {
    taskType,
    successCriteria: oracleSuccessCriteria(taskType, topFiles, topSymbols),
    expectedVerification: {
      commands: suggestedCommands,
      targetedTestFiles,
      fallback: suggestedCommands.length > 0
        ? 'Run the first targeted command before broader validation.'
        : 'Identify the smallest compile/test/lint command for the top candidate file before finalizing.',
      redGreenRequired: taskType === 'debug' || taskType === 'create-testcase',
    },
    likelyTests,
    goldenFacts: oracleGoldenFacts(input, topFiles, topSymbols),
    editGuardrails: oracleEditGuardrails(taskType, topFiles),
    passSignal: oraclePassSignal(taskType),
  };
}

export function normalizeOracleTaskType(value: string): string {
  const lower = value.toLowerCase();
  if (/debug|bug|fix|failing/.test(lower)) return 'debug';
  if (/test|case|coverage/.test(lower)) return 'create-testcase';
  if (/review/.test(lower)) return 'codereview';
  if (/break|plan|task/.test(lower)) return 'break-task';
  if (/refactor/.test(lower)) return 'refactor';
  if (/implement|change|edit|feature/.test(lower)) return 'implement';
  return lower || 'investigate';
}

export function taskKindForOracle(task: string): string {
  return normalizeOracleTaskType(task);
}

function oracleSuccessCriteria(taskType: string, topFiles: string[], topSymbols: string[]): string[] {
  const criteria = [
    topFiles[0] ? `Use ${topFiles[0]} as the first source-of-truth file.` : 'Resolve at least one concrete source file before editing or answering.',
    topSymbols[0] ? `Anchor reasoning on ${topSymbols[0]}.` : 'Anchor reasoning on concrete symbols or line-numbered source evidence.',
  ];
  if (taskType === 'implement' || taskType === 'debug' || taskType === 'refactor') {
    criteria.push('Keep the diff scoped to the files needed for the requested behavior.');
    criteria.push('Run targeted validation and report the command result.');
  } else if (taskType === 'create-testcase') {
    criteria.push('The new test must fail against the seeded buggy behavior and pass after the implementation is correct.');
    criteria.push('Avoid changing production files unless the task explicitly asks for a fix.');
  } else if (taskType === 'codereview') {
    criteria.push('Report only findings with file/line evidence or a concrete validation gap.');
    criteria.push('Separate deterministic blockers from hypotheses that require follow-up slices/tests.');
  } else {
    criteria.push('Cite file and line evidence for each important claim.');
    criteria.push('List missing facts instead of guessing beyond the indexed evidence.');
  }
  return criteria;
}

function oracleGoldenFacts(input: TaskOracleInput, topFiles: string[], topSymbols: string[]): Array<Record<string, unknown>> {
  const facts: Array<Record<string, unknown>> = [];
  for (const file of topFiles.slice(0, 4)) facts.push({ kind: 'file', value: file });
  for (const symbol of topSymbols.slice(0, 4)) facts.push({ kind: 'symbol', value: symbol });
  for (const step of input.flowSteps.slice(0, 4)) {
    facts.push({
      kind: String(step.kind ?? 'flow'),
      value: String(step.summary ?? step.symbol ?? step.file ?? ''),
      file: stringOrUndefined(step.file),
      lines: stringOrUndefined(step.lines) ?? (typeof step.line === 'number' ? String(step.line) : undefined),
    });
  }
  for (const slice of input.evidenceSlices.slice(0, 3)) {
    facts.push({
      kind: 'evidence',
      file: stringOrUndefined(slice.file),
      lines: stringOrUndefined(slice.lines),
      value: truncateString(String(slice.why ?? slice.symbol ?? slice.file ?? ''), 180),
    });
  }
  return facts.filter(fact => String(fact.value ?? fact.file ?? '').length > 0).slice(0, 12);
}

function oracleEditGuardrails(taskType: string, topFiles: string[]): string[] {
  const guardrails = [
    'Open exact slices before editing; avoid broad repo reads once the oracle has top files.',
  ];
  if (topFiles.length > 0) guardrails.push(`Prefer editing only: ${topFiles.slice(0, 4).join(', ')}.`);
  if (taskType === 'refactor') guardrails.push('Preserve public API signatures unless the prompt explicitly asks for an API change.');
  if (taskType === 'debug') guardrails.push('Keep the failing test red before the fix when the suite defines a before-command.');
  if (taskType === 'create-testcase') guardrails.push('Do not make the test pass by weakening assertions or deleting existing tests.');
  return guardrails;
}

function oraclePassSignal(taskType: string): string {
  if (taskType === 'codereview') return 'Golden findings are covered with file/line/severity and no unsupported blockers.';
  if (taskType === 'investigate') return 'Golden facts are covered with file/line evidence and no unsupported claims.';
  if (taskType === 'break-task') return 'Task DAG includes dependencies, order, risks, validation milestones, and definition of done.';
  return 'Diff, compile/tests, and requested file/API assertions pass.';
}
