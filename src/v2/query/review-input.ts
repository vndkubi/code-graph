export type ReviewInput =
  | { kind: 'pull_request'; prUrl: string }
  | { kind: 'range'; baseRef: string; headRef: string };

const REVIEW_REF_PATTERN = /^[A-Za-z0-9._/@-]+$/;

/**
 * Extract the review source from the compact MCP facade arguments. The model
 * may send structured fields, but the common UX is a task containing either a
 * GitHub PR URL or “from <base> to <head>”.
 */
export function resolveReviewInput(task: string, args: Record<string, unknown>): ReviewInput | undefined {
  const explicitPr = firstString(args.prUrl, args.pr, args.pullRequestUrl);
  const prUrl = extractPullRequestUrl(explicitPr ?? task);
  if (prUrl) return { kind: 'pull_request', prUrl };

  const explicitBase = firstString(args.baseRef, args.fromRef, args.base);
  if (explicitBase) {
    const baseRef = validateReviewRef(explicitBase);
    const headRef = validateReviewRef(firstString(args.headRef, args.toRef, args.head) ?? 'HEAD');
    return { kind: 'range', baseRef, headRef };
  }

  const text = task.trim();
  const rangeMatch = /(?:from|base)\s+(?:branch\s+)?[`'\"]?([^\s`'\"<>]+)[`'\"]?\s+(?:to|head)\s+(?:branch\s+)?[`'\"]?([^\s`'\"<>]+)[`'\"]?/i.exec(text);
  if (!rangeMatch) return undefined;
  return {
    kind: 'range',
    baseRef: validateReviewRef(rangeMatch[1]),
    headRef: validateReviewRef(rangeMatch[2]),
  };
}

export function hasExplicitReviewPayload(args: Record<string, unknown>): boolean {
  return nonEmptyString(args.diff)
    || stringArray(args.files).length > 0
    || stringArray(args.symbols).length > 0;
}

export function extractPullRequestUrl(value: string): string | undefined {
  const match = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+(?:[/?#][^\s]*)?/i.exec(value);
  if (!match) return undefined;
  return match[0].replace(/[),.;]+$/g, '');
}

export function validateReviewRef(value: string): string {
  const ref = value.trim();
  if (!ref || !REVIEW_REF_PATTERN.test(ref) || ref.startsWith('-') || ref.includes('..')) {
    throw new Error(`Invalid review git ref: ${value}`);
  }
  return ref;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}
