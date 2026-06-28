/**
 * Pack candidate compaction/dedup helpers — turn raw query rows into the
 * compact file/symbol/endpoint candidate shapes that packs return, and dedup
 * them. Extracted from service.ts as part of breaking up the monolith; pure
 * functions only.
 */
import {
  stringOrUndefined,
  truncateString,
  truncateOptional,
  stringArray,
  confidenceFromScore,
} from './util.js';

export function lineRangeString(start: number, end: number): string {
  return start === end ? String(start) : `${start}-${end}`;
}

export function compactFileCandidate(row: Record<string, unknown>): {
  file: string;
  language?: string;
  fileRole?: string;
  lines?: string;
  whyRelevant: string;
  confidence: number;
  matchedTokens: string[];
  snippet?: unknown;
  topSymbols: Array<Record<string, unknown>>;
  endpoints: Array<Record<string, unknown>>;
} {
  const snippet = row.snippet as Record<string, unknown> | undefined;
  return {
    file: String(row.path ?? ''),
    language: stringOrUndefined(row.language),
    fileRole: stringOrUndefined(row.fileRole),
    lines: snippet ? lineRangeString(Number(snippet.startLine), Number(snippet.endLine)) : undefined,
    whyRelevant: truncateString(String(row.matchReason ?? 'ranked file/path/symbol evidence match'), 240),
    confidence: confidenceFromScore(row.searchScore),
    matchedTokens: stringArray(row.matchedTokens),
    snippet,
    topSymbols: compactSymbolList(row.topSymbols).slice(0, 6),
    endpoints: compactEndpointCandidates(Array.isArray(row.endpoints) ? row.endpoints as Array<Record<string, unknown>> : []).slice(0, 4),
  };
}

export function compactSymbolCandidate(row: Record<string, unknown>, why?: string): {
  symbol: string;
  name: string;
  kind?: string;
  file: string;
  lines?: string;
  signature?: string;
  frameworkRole?: string;
  whyRelevant: string;
  confidence: number;
  matchedTokens: string[];
} {
  return {
    symbol: String(row.fqName ?? row.name ?? ''),
    name: String(row.name ?? row.fqName ?? ''),
    kind: stringOrUndefined(row.kind),
    file: String(row.file ?? ''),
    lines: String(row.lines ?? row.line ?? ''),
    signature: truncateOptional(row.signature, 240),
    frameworkRole: stringOrUndefined(row.frameworkRole),
    whyRelevant: truncateString(why ?? String(row.matchReason ?? 'ranked symbol/name evidence match'), 240),
    confidence: confidenceFromScore(row.searchScore),
    matchedTokens: stringArray(row.matchedTokens),
  };
}

export function compactSymbolList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map(item => compactSymbolCandidate(item as Record<string, unknown>));
}

export function uniqueFileCandidates<T extends { file: string }>(candidates: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const candidate of candidates) {
    if (!candidate.file || seen.has(candidate.file)) continue;
    seen.add(candidate.file);
    result.push(candidate);
  }
  return result;
}

export function uniqueSymbolCandidates<T extends { symbol: string; file: string }>(candidates: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.symbol}\0${candidate.file}`;
    if (!candidate.symbol || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

export function compactEndpointCandidates(rows: Array<Record<string, unknown>>): Array<{
  method: string;
  path: string;
  handlerSymbol: string;
  file: string;
  line: number;
  lines: string;
  framework?: string;
  confidence: number;
  whyRelevant: string;
}> {
  const seen = new Set<string>();
  const result: Array<{
    method: string;
    path: string;
    handlerSymbol: string;
    file: string;
    line: number;
    lines: string;
    framework?: string;
    confidence: number;
    whyRelevant: string;
  }> = [];
  for (const row of rows) {
    const key = `${row.method}:${row.path}:${row.file}:${row.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const line = Number(row.line ?? 0);
    result.push({
      method: String(row.method ?? 'ALL'),
      path: String(row.path ?? ''),
      handlerSymbol: String(row.handlerSymbol ?? row.handler_symbol ?? ''),
      file: String(row.file ?? ''),
      line,
      lines: line > 0 ? String(line) : '',
      framework: stringOrUndefined(row.framework),
      confidence: typeof row.confidence === 'number' ? row.confidence : 0.65,
      whyRelevant: truncateString(
        Array.isArray(row.rankExplanation)
          ? (row.rankExplanation as string[]).join('; ')
          : 'indexed endpoint associated with candidate files',
        240,
      ),
    });
  }
  return result;
}

export function uniqueEndpointCandidates<T extends { method: string; path: string; handlerSymbol: string; file: string; line: number }>(candidates: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.method}\0${candidate.path}\0${candidate.handlerSymbol}\0${candidate.file}\0${candidate.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}
