import { getEncoding } from 'js-tiktoken';

export const TEXT_TOKEN_ESTIMATOR = 'cl100k_base/js-tiktoken';

let encoder: ReturnType<typeof getEncoding> | undefined;

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  encoder ??= getEncoding('cl100k_base');
  return encoder.encode(text).length;
}
