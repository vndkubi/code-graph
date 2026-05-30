import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { TreeSitterAnalyzer } from '../../analyzers/tree-sitter-analyzer.js';
import { detectFrameworkRoles, synthesizeLombokSymbols } from '../../analyzers/java-framework-detector.js';
import type { ImportInfo, ParseResult, SymbolInfo } from '../../analyzers/base-analyzer.js';
import { parseConfigFile } from './config-parser.js';

const analyzer = new TreeSitterAnalyzer();

export interface ParseWorkItem {
  key: string;
  absPath: string;
  rootDir: string;
  size?: number;
}

export interface ParseWorkResult {
  key: string;
  result: ParseResult;
}

export interface ParseBatchOptions {
  workers?: number;
  progress?: (event: ParseBatchProgressEvent) => void;
}

export interface ParseBatchProgressEvent {
  phase: 'parse';
  status: 'start' | 'progress' | 'complete' | 'fallback';
  completed: number;
  total: number;
  workers: number;
  elapsedMs: number;
}

export function parseFile(absPath: string, rootDir: string): ParseResult {
  const content = fs.readFileSync(absPath, 'utf-8');
  const configResult = parseConfigFile(absPath, content, rootDir);
  if (configResult) return configResult;

  let result: ParseResult;
  try {
    result = analyzer.parse(absPath, content, rootDir);
  } catch {
    const fallback = fallbackParseSource(absPath, content, rootDir);
    if (fallback) return fallback;
    return {
      file: path.relative(rootDir, absPath).replace(/\\/g, '/'),
      symbols: [],
      imports: [],
      calls: [],
      references: [],
      hasParseErrors: true,
      parseConfidence: 0,
    };
  }

  if (absPath.endsWith('.java')) {
    detectFrameworkRoles(result.symbols, result.imports);
    result.symbols.push(...synthesizeLombokSymbols(result.symbols, result.file));
  }

  return result;
}

function fallbackParseSource(absPath: string, content: string, rootDir: string): ParseResult | undefined {
  const ext = path.extname(absPath).toLowerCase();
  if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return undefined;

  const file = path.relative(rootDir, absPath).replace(/\\/g, '/');
  const lines = content.split(/\r?\n/);
  const symbols: SymbolInfo[] = [];
  const imports: ImportInfo[] = [];
  let currentClass: { name: string; depth: number } | undefined;
  let objectParent: { name: string; depth: number } | undefined;
  let braceDepth = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const lineNumber = index + 1;
    const trimmed = line.trim();

    const importMatch = trimmed.match(/^import\s+(?:type\s+)?(.+?)\s+from\s+['"]([^'"]+)['"]/);
    if (importMatch) {
      imports.push({
        source: importMatch[2] ?? '',
        symbols: importedNamesFromText(importMatch[1] ?? ''),
        file,
        line: lineNumber,
        isExternal: !String(importMatch[2] ?? '').startsWith('.'),
      });
    }

    const classMatch = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (classMatch) {
      const name = classMatch[1] ?? '';
      symbols.push(fallbackSymbol(name, 'class', file, lineNumber, line, undefined));
      currentClass = { name, depth: braceDepth + countBraceDelta(line) };
    }

    const functionMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (functionMatch) {
      symbols.push(fallbackSymbol(functionMatch[1] ?? '', 'function', file, lineNumber, line, undefined));
    }

    const variableMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (variableMatch) {
      const name = variableMatch[1] ?? '';
      const isArrowFunction = /=>/.test(line);
      symbols.push(fallbackSymbol(name, isArrowFunction ? 'function' : 'variable', file, lineNumber, line, undefined));
      if (/[{]\s*$/.test(trimmed) || /=\s*[{]/.test(trimmed)) {
        objectParent = { name, depth: braceDepth + countBraceDelta(line) };
      }
    }

    if (currentClass && trimmed && !/^(if|for|while|switch|catch)\b/.test(trimmed)) {
      const methodMatch = trimmed.match(/^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?[{;]/);
      if (methodMatch && !['constructor'].includes(methodMatch[1] ?? '')) {
        symbols.push(fallbackSymbol(methodMatch[1] ?? '', 'method', file, lineNumber, line, currentClass.name));
      }
    }

    if (objectParent && objectParent.name && braceDepth <= objectParent.depth) {
      const propertyMatch = trimmed.match(/^['"]?([A-Za-z_$][\w$-]*)['"]?\s*:/);
      if (propertyMatch) {
        symbols.push(fallbackSymbol(propertyMatch[1] ?? '', 'field', file, lineNumber, line, objectParent.name));
      }
    }

    braceDepth += countBraceDelta(line);
    if (currentClass && braceDepth < currentClass.depth) currentClass = undefined;
    if (objectParent && braceDepth < objectParent.depth) objectParent = undefined;
  }

  return {
    file,
    symbols,
    imports,
    calls: [],
    references: [],
    hasParseErrors: true,
    parseConfidence: symbols.length > 0 ? 0.35 : 0,
  };
}

function fallbackSymbol(
  name: string,
  kind: SymbolInfo['kind'],
  file: string,
  line: number,
  signature: string,
  parent: string | undefined,
): SymbolInfo {
  return {
    name,
    kind,
    file,
    line,
    column: Math.max(1, signature.indexOf(name) + 1),
    endLine: line,
    signature: signature.trim(),
    visibility: signature.includes('private ') ? 'private' : signature.includes('protected ') ? 'protected' : 'public',
    module: path.posix.dirname(file),
    parent,
  };
}

function importedNamesFromText(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
    const value = match[1] ?? '';
    if (!['type', 'as', 'from'].includes(value)) names.add(value);
  }
  return [...names];
}

function countBraceDelta(line: string): number {
  const withoutStrings = line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '');
  return (withoutStrings.match(/{/g)?.length ?? 0) - (withoutStrings.match(/}/g)?.length ?? 0);
}

export function parseFilesBatch(workItems: ParseWorkItem[], options: ParseBatchOptions = {}): ParseWorkResult[] {
  if (workItems.length === 0) return [];
  const start = Date.now();
  const workerCount = parseWorkerCount(workItems.length, options.workers);
  options.progress?.({
    phase: 'parse',
    status: 'start',
    completed: 0,
    total: workItems.length,
    workers: workerCount,
    elapsedMs: 0,
  });
  if (workerCount <= 1) return parseFilesSequential(workItems, start, options.progress);

  const workerPath = fileURLToPath(new URL('./parse-worker.js', import.meta.url));
  if (!fs.existsSync(workerPath)) return parseFilesSequential(workItems, start, options.progress);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-parse-'));
  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const counter = new Int32Array(shared);
  const chunks = chunkWorkItems(workItems, workerCount);
  counter[0] = chunks.length;
  counter[1] = 0;
  const workers: Worker[] = [];

  try {
    for (let index = 0; index < chunks.length; index++) {
      const outputPath = path.join(tmpDir, `${index}.json`);
      workers.push(new Worker(workerPath, {
        execArgv: [],
        workerData: {
          tasks: chunks[index],
          outputPath,
          shared,
        },
      }));
    }

    const deadline = Date.now() + Math.max(30_000, workItems.length * 15_000);
    let lastProgressAt = 0;
    while (Atomics.load(counter, 0) > 0) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for parse workers.');
      const completed = Atomics.load(counter, 1);
      const now = Date.now();
      if (now - lastProgressAt >= 5_000) {
        lastProgressAt = now;
        options.progress?.({
          phase: 'parse',
          status: 'progress',
          completed,
          total: workItems.length,
          workers: chunks.length,
          elapsedMs: now - start,
        });
      }
      Atomics.wait(counter, 1, completed, 1000);
    }

    const results: ParseWorkResult[] = [];
    for (let index = 0; index < chunks.length; index++) {
      const payload = JSON.parse(fs.readFileSync(path.join(tmpDir, `${index}.json`), 'utf-8')) as {
        results?: ParseWorkResult[];
        error?: string;
      };
      if (payload.error) throw new Error(payload.error);
      results.push(...(payload.results ?? []));
    }
    options.progress?.({
      phase: 'parse',
      status: 'complete',
      completed: results.length,
      total: workItems.length,
      workers: chunks.length,
      elapsedMs: Date.now() - start,
    });
    const order = new Map(workItems.map((item, index) => [item.key, index]));
    return results.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
  } catch {
    for (const worker of workers) worker.terminate().catch(() => undefined);
    options.progress?.({
      phase: 'parse',
      status: 'fallback',
      completed: 0,
      total: workItems.length,
      workers: 1,
      elapsedMs: Date.now() - start,
    });
    return parseFilesSequential(workItems, start, options.progress);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function parseFilesSequential(
  workItems: ParseWorkItem[],
  start: number = Date.now(),
  progress?: (event: ParseBatchProgressEvent) => void,
): ParseWorkResult[] {
  let lastProgressAt = 0;
  let reportedComplete = false;
  const results: ParseWorkResult[] = [];
  for (let index = 0; index < workItems.length; index++) {
    const item = workItems[index]!;
    results.push({
      key: item.key,
      result: parseFile(item.absPath, item.rootDir),
    });
    const completed = index + 1;
    const now = Date.now();
    if (progress && (completed % 100 === 0 || now - lastProgressAt >= 5_000)) {
      lastProgressAt = now;
      reportedComplete = completed === workItems.length;
      progress({
        phase: 'parse',
        status: completed === workItems.length ? 'complete' : 'progress',
        completed,
        total: workItems.length,
        workers: 1,
        elapsedMs: now - start,
      });
    }
  }
  if (!reportedComplete) {
    progress?.({
      phase: 'parse',
      status: 'complete',
      completed: workItems.length,
      total: workItems.length,
      workers: 1,
      elapsedMs: Date.now() - start,
    });
  }
  return results;
}

function parseWorkerCount(itemCount: number, requested: number | undefined): number {
  const cpuCount = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  const configuredDefault = Number(process.env.CODEGRAPH_PARSE_WORKERS);
  const defaultWorkerLimit = Number.isFinite(configuredDefault) && configuredDefault > 0
    ? Math.floor(configuredDefault)
    : 8;
  const defaultWorkers = Math.max(1, Math.min(defaultWorkerLimit, cpuCount - 1, itemCount));
  if (requested === undefined || !Number.isFinite(requested)) return defaultWorkers;
  return Math.max(1, Math.min(Math.floor(requested), 16, itemCount));
}

function chunkWorkItems(items: ParseWorkItem[], chunkCount: number): ParseWorkItem[][] {
  const chunks = Array.from({ length: chunkCount }, () => [] as ParseWorkItem[]);
  const weights = Array.from({ length: chunkCount }, () => 0);
  const weightedItems = [...items].sort((a, b) => (b.size ?? 1) - (a.size ?? 1));
  for (const item of weightedItems) {
    let target = 0;
    for (let index = 1; index < weights.length; index++) {
      if ((weights[index] ?? 0) < (weights[target] ?? 0)) target = index;
    }
    chunks[target]?.push(item);
    weights[target] = (weights[target] ?? 0) + (item.size ?? 1);
  }
  return chunks.filter(chunk => chunk.length > 0);
}

export function symbolFqName(symbol: {
  fqName?: string;
  packageName?: string;
  parent?: string;
  name: string;
  kind: string;
  parameterTypes?: string[];
}): string {
  if (symbol.fqName) return symbol.fqName;
  const owner = symbol.parent ? `${symbol.parent}.` : '';
  const params = symbol.kind === 'method' || symbol.kind === 'function'
    ? `(${(symbol.parameterTypes ?? []).join(',')})`
    : '';
  const packagePrefix = symbol.packageName ? `${symbol.packageName}.` : '';
  return `${packagePrefix}${owner}${symbol.name}${params}`;
}
