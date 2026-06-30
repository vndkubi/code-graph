export type TokenTextKind =
  | "generic"
  | "code"
  | "typescript"
  | "javascript"
  | "java"
  | "python"
  | "json"
  | "yaml"
  | "markdown"
  | "english"
  | "vietnamese";

export interface TokenEstimateOptions {
  kind?: TokenTextKind;
  modelFamily?: "openai" | "anthropic" | "google" | "unknown";
  minTokens?: number;
}

export interface TokenEstimate {
  tokens: number;
  chars: number;
  ratio: number;
  estimator: "ratio-v1";
  kind: TokenTextKind;
}

export interface BenchmarkUsageTokens {
  input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  cached_input_tokens?: number;
}

export const TOKEN_ESTIMATOR_VERSION = "ratio-v1";

const DEFAULT_MIN_TOKENS = 1;
const TOKEN_RATIOS: Record<TokenTextKind, number> = {
  generic: 4.0,
  code: 3.8,
  typescript: 3.7,
  javascript: 3.7,
  java: 4.2,
  python: 4.0,
  json: 5.2,
  yaml: 4.5,
  markdown: 3.6,
  english: 4.0,
  vietnamese: 1.8
};

export function estimateTokens(value: string | number, options: TokenEstimateOptions = {}): number {
  return estimateTokenDetails(value, options).tokens;
}

export function estimateTokenDetails(value: string | number, options: TokenEstimateOptions = {}): TokenEstimate {
  const chars = typeof value === "number" ? Math.max(0, value) : value.length;
  const kind = options.kind ?? "generic";
  const ratio = TOKEN_RATIOS[kind] ?? TOKEN_RATIOS.generic;
  const minTokens = options.minTokens ?? DEFAULT_MIN_TOKENS;
  return {
    tokens: Math.max(minTokens, Math.ceil(chars / ratio)),
    chars,
    ratio,
    estimator: TOKEN_ESTIMATOR_VERSION,
    kind
  };
}

export function estimateTokensSaved(
  originalChars: number,
  compressedChars: number,
  options: TokenEstimateOptions = {}
): number {
  return estimateTokens(Math.max(0, originalChars - compressedChars), {
    ...options,
    minTokens: 0
  });
}

export function totalUsageTokens(usage: BenchmarkUsageTokens): number {
  return usage.input_tokens + usage.output_tokens + usage.reasoning_output_tokens;
}

export function freshUsageTokens(usage: BenchmarkUsageTokens): number {
  const cached = usage.cached_input_tokens ?? 0;
  return Math.max(0, usage.input_tokens - cached) + usage.output_tokens + usage.reasoning_output_tokens;
}
