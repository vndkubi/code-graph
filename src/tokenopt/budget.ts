import type { CompressionResult, TaskClass } from "./types.js";

export type BudgetReason =
  | "config-default"
  | "task-class"
  | "output-kind"
  | "explicit-argument"
  | "safety-margin";

export interface ContextBudgetInput {
  configuredMaxChars: number;
  taskClass?: TaskClass;
  outputKind?: CompressionResult["kind"];
  requestedMaxChars?: number;
  budgetTokens?: number;
}

export interface AdaptiveCharBudget {
  maxChars: number;
  reason: BudgetReason;
  ceilingChars: number;
  floorChars: number;
}

const DEFAULT_FLOOR_CHARS = 1_200;

export function computeAdaptiveOutputBudget(input: ContextBudgetInput): AdaptiveCharBudget {
  const ceilingChars = Math.max(1, input.configuredMaxChars);
  const explicitCeiling = input.requestedMaxChars ? Math.min(ceilingChars, Math.max(1, input.requestedMaxChars)) : ceilingChars;
  const tokenCeiling = input.budgetTokens ? Math.max(DEFAULT_FLOOR_CHARS, Math.floor(input.budgetTokens * 4 * 0.7)) : explicitCeiling;
  const hardCeiling = Math.min(explicitCeiling, tokenCeiling);
  const byKind = outputKindBudget(input.outputKind);
  const byTask = taskClassBudget(input.taskClass);
  const desired = byKind.maxChars ?? byTask.maxChars ?? hardCeiling;
  const reason = input.requestedMaxChars
    ? "explicit-argument"
    : input.budgetTokens && tokenCeiling < explicitCeiling
      ? "safety-margin"
      : byKind.reason ?? byTask.reason ?? "config-default";
  const floorChars = Math.min(DEFAULT_FLOOR_CHARS, hardCeiling);
  return {
    maxChars: clamp(desired, floorChars, hardCeiling),
    reason,
    ceilingChars,
    floorChars
  };
}

export function computeAdaptiveReadBudget(input: ContextBudgetInput): AdaptiveCharBudget {
  const base = computeAdaptiveOutputBudget(input);
  if (input.taskClass === "exact_symbol") {
    return { ...base, maxChars: Math.min(base.maxChars, 12_000), reason: "task-class" };
  }
  return base;
}

function outputKindBudget(kind: CompressionResult["kind"] | undefined): { maxChars?: number; reason?: BudgetReason } {
  switch (kind) {
    case "review-findings":
    case "json-result":
      return { maxChars: 6_000, reason: "output-kind" };
    case "java-trace":
    case "build-log":
    case "error-summary":
      return { maxChars: 8_000, reason: "output-kind" };
    case "generic":
      return { maxChars: 10_000, reason: "output-kind" };
    default:
      return {};
  }
}

function taskClassBudget(taskClass: TaskClass | undefined): { maxChars?: number; reason?: BudgetReason } {
  switch (taskClass) {
    case "review_diff":
    case "security_audit":
      return { maxChars: 6_000, reason: "task-class" };
    case "debug_runtime":
      return { maxChars: 8_000, reason: "task-class" };
    case "exact_symbol":
      return { maxChars: 12_000, reason: "task-class" };
    default:
      return {};
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
