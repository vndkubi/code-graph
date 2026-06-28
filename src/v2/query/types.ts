/**
 * Shared row/score/intent types for the query layer. Extracted from service.ts
 * so ranking and search helpers can live in their own modules without importing
 * the whole service.
 */
import type { FileRole } from '../index/file-role.js';

export interface SymbolRow {
  fq_name: string;
  simple_name: string;
  kind: string;
  file: string;
  line: number;
  end_line?: number;
  signature: string;
  visibility: string;
  parent?: string;
  package_name?: string;
  return_type?: string;
  parameter_types_json?: string;
  annotations_json?: string;
  framework_role?: string;
  framework_meta_json?: string;
  file_role: FileRole;
}

export interface FileRow {
  path: string;
  language?: string;
  file_role: FileRole;
  parse_status: string;
  size: number;
}

export interface FileEvidence {
  symbols: Array<Record<string, unknown>>;
  endpoints: Array<Record<string, unknown>>;
  dependencyCounts: {
    outgoing: number;
    incoming: number;
  };
  importCount: number;
}

export interface FileSearchScore {
  score: number;
  matchedTokens: string[];
  reason: string;
  factors: string[];
}

export interface SearchScore {
  score: number;
  matchedTokens: string[];
  reason: string;
  exactPhrase: boolean;
  intentMatch: boolean;
  factors: string[];
}

export interface SearchIntent {
  kind: 'none' | 'entry_point';
}

export interface EndpointRow {
  method: string;
  path: string;
  path_resolution: string;
  path_resolution_reason?: string;
  handler_symbol: string;
  controller?: string;
  file: string;
  line: number;
  framework: string;
  confidence: number;
  file_role: string;
}

export interface DependencyTraceEdge {
  fromFile: string;
  toFile: string;
  kind: string;
  confidence: number;
  resolutionKind: string;
  depth: number;
}
