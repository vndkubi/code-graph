/**
 * Generic leaf value helpers shared across the query layer. Extracted from
 * service.ts as part of breaking up the monolith; pure functions only.
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function stringOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}

export function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 13))}...<truncated>`;
}

export function truncateOptional(value: unknown, maxChars: number): string | undefined {
  const text = stringOrUndefined(value);
  return text ? truncateString(text, maxChars) : undefined;
}

export function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values.map(item => item.trim()).filter(Boolean)) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject);
}

export function parseCursor(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item));
}

export function confidenceFromScore(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.65;
  if (value >= 100) return 0.9;
  if (value >= 80) return 0.8;
  if (value >= 60) return 0.7;
  if (value >= 40) return 0.6;
  return 0.45;
}
