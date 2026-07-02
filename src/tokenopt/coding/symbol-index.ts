import fs from "node:fs";
import path from "node:path";
import type { CodingSymbol, SymbolPacket } from "../types.js";
import { findTestNeighbors } from "./test-neighbors.js";
import { loadOrBuildSymbolIndex, type SymbolIndexSnapshot } from "./symbol-index-persistent.js";

export interface SymbolSearchInput {
  repoRoot: string;
  query?: string;
  language?: CodingSymbol["language"];
  kind?: CodingSymbol["kind"];
  limit?: number;
}

export interface SymbolPacketInput {
  repoRoot: string;
  symbolId?: string;
  query?: string;
}

export interface CodingSymbolIndexStats {
  cacheHit: boolean;
  cachePath: string;
  fileCount: number;
  symbolCount: number;
}

export interface CodingSymbolSearchResult {
  symbols: CodingSymbol[];
  indexStats: CodingSymbolIndexStats;
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".java", ".py"]);
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  ".next",
  ".nuxt",
  ".cache",
  ".venv",
  "venv",
  "__pycache__"
]);

const CONTROL_WORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "new",
  "function",
  "class",
  "interface",
  "try",
  "else",
  "do"
]);

export function findCodingSymbols(input: SymbolSearchInput): CodingSymbol[] {
  return findCodingSymbolsWithStats(input).symbols;
}

export function findCodingSymbolsWithStats(input: SymbolSearchInput): CodingSymbolSearchResult {
  const query = input.query?.trim() ?? "";
  const queryTokens = tokenizeQuery(query);
  const indexResult = loadCodingSymbolIndexResult(input.repoRoot);
  const symbols = indexResult.snapshot.symbols
    .filter((symbol) => !input.language || symbol.language === input.language)
    .filter((symbol) => !input.kind || symbol.kind === input.kind)
    .map((symbol) => ({ symbol, score: scoreSymbol(symbol, query, queryTokens) }))
    .filter((entry) => queryTokens.length === 0 || entry.score > 0)
    .sort((a, b) => b.score - a.score || a.symbol.file.localeCompare(b.symbol.file) || a.symbol.line - b.symbol.line)
    .slice(0, input.limit ?? 20);

  return {
    symbols: symbols.map(({ symbol, score }) => ({
      ...symbol,
      confidence: Math.max(symbol.confidence, Math.min(0.96, 0.35 + score / 10))
    })),
    indexStats: {
      cacheHit: indexResult.cacheHit,
      cachePath: indexResult.cachePath,
      fileCount: indexResult.snapshot.files.length,
      symbolCount: indexResult.snapshot.symbols.length
    }
  };
}

export function loadCodingSymbolIndex(repoRoot: string): SymbolIndexSnapshot {
  return loadCodingSymbolIndexResult(repoRoot).snapshot;
}

export function getCodingSymbolIndexStats(repoRoot: string, options: { forceRebuild?: boolean } = {}): CodingSymbolIndexStats {
  const result = loadCodingSymbolIndexResult(repoRoot, options);
  return {
    cacheHit: result.cacheHit,
    cachePath: result.cachePath,
    fileCount: result.snapshot.files.length,
    symbolCount: result.snapshot.symbols.length
  };
}

export function buildSymbolPacket(input: SymbolPacketInput): SymbolPacket | undefined {
  const symbol = resolveSymbol(input);
  if (!symbol) {
    return undefined;
  }

  const absolute = path.join(input.repoRoot, symbol.file);
  const lines = safeReadLines(absolute);
  const startLine = Math.max(1, symbol.line - 12);
  const endLine = Math.min(lines.length, symbol.line + 80);
  const selected = lines.slice(startLine - 1, endLine);
  const sliceText = selected.join("\n");
  const imports = extractImports(lines, symbol.language);
  const dependencies = extractDependencies(symbol, imports, sliceText);
  const callers = findSymbolReferences(input.repoRoot, symbol).slice(0, 24);
  const callees = extractCallees(sliceText).filter((name) => name !== symbol.name).slice(0, 32);
  const neighbors = findTestNeighbors({ repoRoot: input.repoRoot, target: symbol.file, symbolName: symbol.name });

  return {
    symbol,
    definition_slice: {
      file: symbol.file,
      startLine,
      endLine,
      text: sliceText
    },
    imports,
    dependencies,
    callers,
    callees,
    nearby_tests: neighbors.test_files,
    coverage: {
      target_symbol: "covered",
      signature: symbol.signature ? "covered" : "missing",
      imports_or_dependencies: imports.length > 0 || dependencies.length > 0 ? "covered" : "partial",
      callers_or_references: callers.length > 0 ? "covered" : "partial",
      callees_or_used_functions: callees.length > 0 ? "covered" : "partial",
      nearby_tests: neighbors.test_files.length > 0 ? "covered" : "missing"
    }
  };
}

export function collectCodingFiles(repoRoot: string, options: { maxFiles?: number; maxDepth?: number } = {}): string[] {
  const maxFiles = options.maxFiles ?? 20_000;
  const maxDepth = options.maxDepth ?? 30;
  const files: string[] = [];
  const stack: Array<{ absolute: string; relative: string; depth: number }> = [{ absolute: repoRoot, relative: "", depth: 0 }];

  while (stack.length > 0 && files.length < maxFiles) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      const relative = current.relative ? path.join(current.relative, entry.name) : entry.name;
      const normalized = relative.replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (current.depth >= maxDepth || SKIP_DIRS.has(entry.name.toLowerCase())) {
          continue;
        }
        stack.push({ absolute: path.join(current.absolute, entry.name), relative, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || isMinifiedOrGenerated(normalized)) {
        continue;
      }
      files.push(normalized);
      if (files.length >= maxFiles) {
        break;
      }
    }
  }

  return files.sort();
}

export function languageForPath(filePath: string): CodingSymbol["language"] {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".ts" || extension === ".tsx") {
    return "typescript";
  }
  if (extension === ".js" || extension === ".jsx") {
    return "javascript";
  }
  if (extension === ".java") {
    return "java";
  }
  if (extension === ".py") {
    return "python";
  }
  return "unknown";
}

export function isTestPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = path.basename(normalized);
  return /(^|\/)(test|tests|__tests__|spec|src\/test|qa)(\/|$)/i.test(normalized) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(base) || /Test\.(java|kt)$/i.test(base) || /^test_.*\.py$/i.test(base);
}

function loadCodingSymbolIndexResult(repoRoot: string, options: { forceRebuild?: boolean } = {}) {
  return loadOrBuildSymbolIndex(repoRoot, () => buildCodingSymbolIndex(repoRoot), options);
}

function buildCodingSymbolIndex(repoRoot: string): Omit<SymbolIndexSnapshot, "version" | "repoFingerprint" | "createdAt"> {
  const files = collectCodingFiles(repoRoot);
  const indexedFiles = files.map((file) => {
    const symbols = extractSymbolsFromFile(repoRoot, file);
    const stat = safeStat(path.join(repoRoot, file));
    return {
      file,
      symbols,
      indexed: {
        path: file,
        size: stat?.size ?? 0,
        mtimeMs: stat?.mtimeMs ?? 0,
        language: languageForPath(file),
        symbolCount: symbols.length
      }
    };
  });
  return {
    files: indexedFiles.map((entry) => entry.indexed),
    symbols: indexedFiles.flatMap((entry) => entry.symbols)
  };
}

export function tokenizeQuery(query: string): string[] {
  const tokens = new Set<string>();
  for (const part of query.match(/[A-Za-z][A-Za-z0-9_./:-]*/g) ?? []) {
    const cleaned = part.replace(/^.*[\\/]/, "").replace(/\.(?:ts|tsx|js|jsx|java|py)$/i, "");
    for (const token of splitIdentifier(cleaned)) {
      if (token.length >= 3 && !CONTROL_WORDS.has(token.toLowerCase())) {
        tokens.add(token.toLowerCase());
      }
    }
    if (cleaned.length >= 3) {
      tokens.add(cleaned.toLowerCase());
    }
  }
  return [...tokens].slice(0, 12);
}

function resolveSymbol(input: SymbolPacketInput): CodingSymbol | undefined {
  if (input.symbolId) {
    const parsed = parseSymbolId(input.symbolId);
    if (parsed) {
      const symbols = extractSymbolsFromFile(input.repoRoot, parsed.file);
      const exact = symbols.find((symbol) => symbol.id === input.symbolId || (symbol.line === parsed.line && symbol.name === parsed.name));
      if (exact) {
        return exact;
      }
    }
  }
  return findCodingSymbols({ repoRoot: input.repoRoot, query: input.query ?? input.symbolId ?? "", limit: 1 })[0];
}

function parseSymbolId(symbolId: string): { file: string; line: number; kind: string; name: string } | undefined {
  const match = symbolId.match(/^(.+):(\d+):([^:]+):(.+)$/);
  if (!match) {
    return undefined;
  }
  return {
    file: match[1]!,
    line: Number.parseInt(match[2]!, 10),
    kind: match[3]!,
    name: match[4]!
  };
}

function extractSymbolsFromFile(repoRoot: string, relativeFile: string): CodingSymbol[] {
  const absolute = path.join(repoRoot, relativeFile);
  const lines = safeReadLines(absolute);
  const language = languageForPath(relativeFile);
  const symbols: CodingSymbol[] = [];

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    for (const parsed of parseSymbolLine(line, language)) {
      symbols.push({
        id: `${relativeFile}:${lineNumber}:${parsed.kind}:${parsed.name}`,
        name: parsed.name,
        kind: parsed.kind,
        language,
        file: relativeFile,
        line: lineNumber,
        signature: parsed.signature,
        confidence: parsed.confidence
      });
    }
  });

  return dedupeSymbols(symbols);
}

function parseSymbolLine(
  line: string,
  language: CodingSymbol["language"]
): Array<{ name: string; kind: CodingSymbol["kind"]; signature: string; confidence: number }> {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("#")) {
    return [];
  }
  if (language === "java") {
    return parseJavaSymbolLine(trimmed);
  }
  if (language === "python") {
    return parsePythonSymbolLine(trimmed);
  }
  if (language === "typescript" || language === "javascript") {
    return parseJsSymbolLine(trimmed);
  }
  return [];
}

function parseJsSymbolLine(line: string): Array<{ name: string; kind: CodingSymbol["kind"]; signature: string; confidence: number }> {
  const matches: Array<{ name: string; kind: CodingSymbol["kind"]; signature: string; confidence: number }> = [];
  const classMatch = line.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
  if (classMatch) {
    matches.push({ name: classMatch[1]!, kind: "class", signature: line, confidence: 0.9 });
  }
  const interfaceMatch = line.match(/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/);
  if (interfaceMatch) {
    matches.push({ name: interfaceMatch[1]!, kind: "interface", signature: line, confidence: 0.88 });
  }
  const typeMatch = line.match(/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/);
  if (typeMatch) {
    matches.push({ name: typeMatch[1]!, kind: "type", signature: line, confidence: 0.82 });
  }
  const functionMatch = line.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (functionMatch) {
    matches.push({ name: functionMatch[1]!, kind: "function", signature: line, confidence: 0.9 });
  }
  const constMatch = line.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
  if (constMatch) {
    matches.push({ name: constMatch[1]!, kind: "function", signature: line, confidence: 0.84 });
  }
  const methodMatch = line.match(/^(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+|override\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^={;]+)?\s*(?:[{;]|=>)/);
  if (methodMatch && !CONTROL_WORDS.has(methodMatch[1]!.toLowerCase())) {
    matches.push({ name: methodMatch[1]!, kind: "method", signature: line, confidence: 0.68 });
  }
  return matches;
}

function parseJavaSymbolLine(line: string): Array<{ name: string; kind: CodingSymbol["kind"]; signature: string; confidence: number }> {
  const matches: Array<{ name: string; kind: CodingSymbol["kind"]; signature: string; confidence: number }> = [];
  const typeMatch = line.match(/\b(?:class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  if (typeMatch) {
    matches.push({ name: typeMatch[1]!, kind: typeMatch[0].includes("interface") ? "interface" : "class", signature: line, confidence: 0.9 });
  }
  const methodMatch = line.match(/^(?:@\w+(?:\([^)]*\))?\s*)*(?:public|protected|private|static|final|synchronized|abstract|native|\s)+[\w<>\[\],.?]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?:throws\s+[^{]+)?[{;]/);
  if (methodMatch && !CONTROL_WORDS.has(methodMatch[1]!.toLowerCase())) {
    matches.push({ name: methodMatch[1]!, kind: "method", signature: line, confidence: 0.78 });
  }
  return matches;
}

function parsePythonSymbolLine(line: string): Array<{ name: string; kind: CodingSymbol["kind"]; signature: string; confidence: number }> {
  const classMatch = line.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)/);
  if (classMatch) {
    return [{ name: classMatch[1]!, kind: "class", signature: line, confidence: 0.9 }];
  }
  const functionMatch = line.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (functionMatch) {
    return [{ name: functionMatch[1]!, kind: "function", signature: line, confidence: 0.9 }];
  }
  return [];
}

function scoreSymbol(symbol: CodingSymbol, query: string, queryTokens: string[]): number {
  if (!query.trim()) {
    return symbol.kind === "class" || symbol.kind === "interface" ? 4 : 2;
  }
  const haystack = `${symbol.name} ${symbol.file} ${symbol.signature}`.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (symbol.name.toLowerCase() === token) {
      score += 8;
    } else if (symbol.name.toLowerCase().includes(token)) {
      score += 5;
    } else if (symbol.file.toLowerCase().includes(token)) {
      score += 3;
    } else if (haystack.includes(token)) {
      score += 1;
    }
  }
  if (query.toLowerCase().includes(symbol.file.toLowerCase())) {
    score += 5;
  }
  if (symbol.kind === "class" || symbol.kind === "interface") {
    score += 1;
  }
  return score;
}

function findSymbolReferences(repoRoot: string, symbol: CodingSymbol): Array<{ file: string; line: number; text: string }> {
  const references: Array<{ file: string; line: number; text: string }> = [];
  const matcher = new RegExp(`\\b${escapeRegExp(symbol.name)}\\b`);
  for (const file of collectCodingFiles(repoRoot, { maxFiles: 12_000 })) {
    const lines = safeReadLines(path.join(repoRoot, file));
    for (let index = 0; index < lines.length; index += 1) {
      if (file === symbol.file && index + 1 === symbol.line) {
        continue;
      }
      const line = lines[index]!;
      if (matcher.test(line)) {
        references.push({ file, line: index + 1, text: line.trim().slice(0, 220) });
        if (references.length >= 80) {
          return references;
        }
      }
    }
  }
  return references;
}

function extractImports(lines: string[], language: CodingSymbol["language"]): string[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => {
      if (language === "java") {
        return /^import\s+[\w.*]+;/.test(line) || /^package\s+[\w.]+;/.test(line);
      }
      if (language === "python") {
        return /^(?:from\s+[\w.]+\s+import\s+|import\s+[\w.]+)/.test(line);
      }
      return /^(?:import\s+.+\s+from\s+['"].+['"];?|import\s+['"].+['"];?|const\s+\w+\s*=\s*require\()/.test(line);
    })
    .slice(0, 60);
}

function extractDependencies(symbol: CodingSymbol, imports: string[], sliceText: string): string[] {
  const deps = new Set<string>();
  for (const imported of imports) {
    for (const token of imported.match(/\b[A-Z][A-Za-z0-9_]+\b/g) ?? []) {
      if (token !== symbol.name) {
        deps.add(token);
      }
    }
  }
  for (const token of sliceText.match(/\b[A-Z][A-Za-z0-9_]+\b/g) ?? []) {
    if (token !== symbol.name && token.length > 2) {
      deps.add(token);
    }
  }
  return [...deps].slice(0, 40);
}

function extractCallees(sliceText: string): string[] {
  const callees = new Set<string>();
  for (const match of sliceText.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1]!;
    if (!CONTROL_WORDS.has(name.toLowerCase())) {
      callees.add(name);
    }
  }
  return [...callees];
}

function safeReadLines(filePath: string): string[] {
  try {
    return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n").split("\n");
  } catch {
    return [];
  }
}

function safeStat(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch {
    return undefined;
  }
}

function dedupeSymbols(symbols: CodingSymbol[]): CodingSymbol[] {
  const seen = new Set<string>();
  const result: CodingSymbol[] = [];
  for (const symbol of symbols) {
    const key = `${symbol.file}:${symbol.line}:${symbol.name}:${symbol.kind}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(symbol);
  }
  return result;
}

function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter(Boolean);
}

function isMinifiedOrGenerated(filePath: string): boolean {
  return /\.min\.[cm]?[jt]sx?$/i.test(filePath) || /(^|\/)(generated|dist|build|coverage|target)\//i.test(filePath);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
