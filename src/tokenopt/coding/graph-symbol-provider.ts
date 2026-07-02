import type { CodingSymbol } from "../types.js";
import { languageForPath } from "./symbol-index.js";

/**
 * Optional accelerator for the regex-lite coding layer. When the fused MCP
 * server hosts CodeGraph's SQLite/tree-sitter symbol table in-process, these
 * methods answer from that graph instead of a fresh full-repo regex scan.
 * Every method resolves to `undefined` when the graph has no answer or the
 * provider is unavailable/erroring — callers must fall back to the existing
 * regex-lite path in that case, never treat undefined as "zero results".
 */
export interface GraphSymbolProvider {
  searchSymbols(input: { query: string; kind?: string; limit?: number }): Promise<CodingSymbol[] | undefined>;
  getCallers(input: { symbol: string }): Promise<Array<{ file: string; line: number; text: string }> | undefined>;
  getCallees(input: { symbol: string }): Promise<string[] | undefined>;
  findTestsFor(input: { target: string; files?: string[] }): Promise<string[] | undefined>;
}

export type GraphQueryFn = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

export function createGraphSymbolProvider(query: GraphQueryFn): GraphSymbolProvider {
  return {
    async searchSymbols({ query: text, kind, limit }) {
      if (!text.trim()) {
        return undefined;
      }
      try {
        const result = (await query("search_symbol", {
          query: text,
          kind: kind ?? "all",
          limit: limit ?? 20
        })) as { symbols?: unknown };
        const rows = Array.isArray(result?.symbols) ? (result.symbols as Record<string, unknown>[]) : [];
        const mapped = rows.map(mapSymbolRow).filter((symbol): symbol is CodingSymbol => symbol !== undefined);
        return mapped;
      } catch {
        return undefined;
      }
    },

    async getCallers({ symbol }) {
      try {
        const result = (await query("get_callers", { symbol, limit: 24 })) as { callers?: unknown };
        const rows = Array.isArray(result?.callers) ? (result.callers as Record<string, unknown>[]) : [];
        return rows
          .map((row) => ({
            file: String(row.file ?? ""),
            line: Number(row.line ?? 0),
            text: String(row.caller ?? "")
          }))
          .filter((entry) => entry.file.length > 0);
      } catch {
        return undefined;
      }
    },

    async getCallees({ symbol }) {
      try {
        const result = (await query("get_callees", { symbol, limit: 32 })) as { callees?: unknown };
        const rows = Array.isArray(result?.callees) ? (result.callees as Record<string, unknown>[]) : [];
        const names = rows.map((row) => simpleName(String(row.callee ?? ""))).filter((name) => name.length > 0);
        return [...new Set(names)];
      } catch {
        return undefined;
      }
    },

    async findTestsFor({ target, files }) {
      try {
        const result = (await query("find_tests_for", { symbol: target, files, limit: 24 })) as { tests?: unknown };
        const rows = Array.isArray(result?.tests) ? (result.tests as Record<string, unknown>[]) : [];
        const names = rows.map((row) => String(row.file ?? "")).filter((file) => file.length > 0);
        return [...new Set(names)];
      } catch {
        return undefined;
      }
    }
  };
}

function mapSymbolRow(row: Record<string, unknown>): CodingSymbol | undefined {
  const file = typeof row.file === "string" && row.file.length > 0 ? row.file : undefined;
  const line = typeof row.line === "number" && row.line > 0 ? row.line : undefined;
  const name = typeof row.name === "string" && row.name.length > 0 ? row.name : undefined;
  if (!file || !line || !name) {
    return undefined;
  }
  const kind = mapKind(String(row.kind ?? ""));
  const endLine = typeof row.endLine === "number" && row.endLine >= line ? row.endLine : undefined;
  const signature = typeof row.signature === "string" && row.signature.trim().length > 0 ? row.signature : name;
  return {
    id: `${file}:${line}:${kind}:${name}`,
    name,
    kind,
    language: languageForPath(file),
    file,
    line,
    endLine,
    source: "graph",
    signature,
    confidence: 0.95
  };
}

function mapKind(raw: string): CodingSymbol["kind"] {
  const value = raw.toLowerCase();
  if (value.includes("interface")) return "interface";
  if (value.includes("class") || value.includes("enum") || value.includes("record")) return "class";
  if (value.includes("method")) return "method";
  if (value.includes("function")) return "function";
  if (value.includes("type") || value.includes("alias")) return "type";
  if (value.includes("field") || value.includes("const") || value.includes("variable") || value.includes("property")) return "const";
  return "unknown";
}

function simpleName(fqName: string): string {
  const trimmed = fqName.trim();
  if (!trimmed) return "";
  const lastDot = trimmed.lastIndexOf(".");
  return lastDot >= 0 ? trimmed.slice(lastDot + 1) : trimmed;
}
