import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { TreeSitterAnalyzer } from '../../analyzers/tree-sitter-analyzer.js';
import { detectFrameworkRoles, synthesizeLombokSymbols } from '../../analyzers/java-framework-detector.js';
import type { ImportInfo, ParseResult, SymbolInfo } from '../../analyzers/base-analyzer.js';
import { parseConfigFile } from './config-parser.js';
import {
  addFactShardStats,
  emptyFactShardStats,
  factShardPathsForWorker,
  openFactShardWriter,
  writeParseResultFactRows,
  type FactShardConfig,
  type FactShardPaths,
  type FactShardStats,
  type FactShardWriter,
} from './fact-shards.js';

const analyzer = new TreeSitterAnalyzer();

export interface ParseWorkItem {
  key: string;
  absPath: string;
  rootDir: string;
  size?: number;
  blobHash?: string;
  language?: string;
  role?: string;
  cacheInsert?: boolean;
}

export interface ParseWorkResult {
  key: string;
  result: ParseResult;
}

export interface ParseSpool {
  shardPaths: string[];
  contextShardPaths: string[];
  factShardPaths: FactShardPaths[];
  factStatsPaths: string[];
  factStatsByShard: FactShardStats[];
  factStats: FactShardStats;
  workerCount: number;
  resultCount: number;
  elapsedMs: number;
  close(): void;
}

export interface ParseContextItem {
  key: string;
  parseStatus: 'ok' | 'error';
  fields: Array<[string, string]>;
  methods: string[];
  methodFiles?: Array<[string, string]>;
  implementations: Array<[string, string]>;
}

export interface ParseBatchOptions {
  workers?: number;
  progress?: (event: ParseBatchProgressEvent) => void;
  factShard?: FactShardConfig;
  spoolResults?: boolean;
}

export interface ParseBatchProgressEvent {
  phase: 'parse';
  status: 'start' | 'progress' | 'complete' | 'fallback';
  message?: string;
  completed: number;
  total: number;
  workers: number;
  elapsedMs: number;
}

interface ParseWorkerShardFiles {
  index: number;
  outputPath?: string;
  contextPath: string;
  factPaths?: FactShardPaths;
  factStatsPath?: string;
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
  const spool = parseFilesBatchToSpool(workItems, options);
  try {
    const results: ParseWorkResult[] = [];
    for (const shardPath of spool.shardPaths) {
      for (const result of readParseWorkResultsJsonl(shardPath)) {
        results.push(result);
      }
    }
    const order = new Map(workItems.map((item, index) => [item.key, index]));
    return results.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
  } finally {
    spool.close();
  }
}

export function parseFilesBatchToSpool(workItems: ParseWorkItem[], options: ParseBatchOptions = {}): ParseSpool {
  const start = Date.now();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-parse-'));
  const close = () => fs.rmSync(tmpDir, { recursive: true, force: true });
  if (workItems.length === 0) {
    return {
      shardPaths: [],
      contextShardPaths: [],
      factShardPaths: [],
      factStatsPaths: [],
      factStatsByShard: [],
      factStats: emptyFactShardStats(),
      workerCount: 0,
      resultCount: 0,
      elapsedMs: 0,
      close,
    };
  }

  const workerCount = parseWorkerCount(workItems.length, options.workers);
  options.progress?.({
    phase: 'parse',
    status: 'start',
    completed: 0,
    total: workItems.length,
    workers: workerCount,
    elapsedMs: 0,
  });
  if (workerCount <= 1) {
    return parseFilesSequentialToSpool(workItems, tmpDir, start, options.progress, close, options);
  }

  const workerRuntime = resolveParseWorkerRuntime();
  if (!workerRuntime) {
    return parseFilesSequentialToSpool(workItems, tmpDir, start, options.progress, close, options);
  }

  const useDynamicQueue = !envFlag(process.env.CODEGRAPH_DISABLE_DYNAMIC_PARSE_QUEUE);
  const scheduledWorkItems = [...workItems].sort((a, b) => (b.size ?? 1) - (a.size ?? 1));
  const workerTaskGroups = useDynamicQueue
    ? Array.from({ length: workerCount }, () => scheduledWorkItems)
    : chunkWorkItems(workItems, workerCount);
  const activeWorkerCount = workerTaskGroups.length;
  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
  const counter = new Int32Array(shared);
  counter[0] = activeWorkerCount;
  counter[1] = 0;
  counter[2] = 0;
  const workers: Worker[] = [];
  const workerErrors: string[] = [];
  const workerExitedEarly = Array.from({ length: activeWorkerCount }, () => false);
  const markWorkerExitedEarly = (index: number, reason: string): void => {
    if (workerExitedEarly[index]) return;
    workerExitedEarly[index] = true;
    workerErrors.push(reason);
    Atomics.sub(counter, 0, 1);
    Atomics.notify(counter, 0);
    Atomics.notify(counter, 1);
  };

  try {
    const spoolResults = options.spoolResults !== false;
    const shardPaths: string[] = [];
    const contextShardPaths: string[] = [];
    const factShardPaths: FactShardPaths[] = [];
    const factStatsPaths: string[] = [];
    const workerShardFiles: ParseWorkerShardFiles[] = [];
    for (let index = 0; index < activeWorkerCount; index++) {
      const outputPath = path.join(tmpDir, `${index}.json`);
      const contextPath = path.join(tmpDir, `${index}.context.json`);
      const factPaths = options.factShard ? factShardPathsForWorker(tmpDir, index) : undefined;
      const factStatsPath = options.factShard ? path.join(tmpDir, `${index}.fact.stats.json`) : undefined;
      if (spoolResults) shardPaths.push(outputPath);
      contextShardPaths.push(contextPath);
      if (factPaths) factShardPaths.push(factPaths);
      if (factStatsPath) factStatsPaths.push(factStatsPath);
      workerShardFiles.push({
        index,
        outputPath: spoolResults ? outputPath : undefined,
        contextPath,
        factPaths,
        factStatsPath,
      });
    }

    for (let index = 0; index < activeWorkerCount; index++) {
      const outputPath = path.join(tmpDir, `${index}.json`);
      const contextPath = path.join(tmpDir, `${index}.context.json`);
      const errorPath = path.join(tmpDir, `${index}.error.json`);
      const factPaths = options.factShard ? factShardPathsForWorker(tmpDir, index) : undefined;
      const factStatsPath = options.factShard ? path.join(tmpDir, `${index}.fact.stats.json`) : undefined;
      const tasks = workerTaskGroups[index] ?? [];
      const worker = new Worker(workerRuntime.workerPath, {
        execArgv: workerRuntime.execArgv,
        workerData: {
          tasks,
          dynamicTasks: useDynamicQueue,
          outputPath: spoolResults ? outputPath : undefined,
          contextPath,
          errorPath,
          factShardConfig: options.factShard,
          factShardPaths: factPaths,
          factStatsPath,
          shared,
        },
      });
      worker.once('error', error => {
        markWorkerExitedEarly(index, `worker ${index} error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      });
      worker.once('exit', code => {
        if (code !== 0) markWorkerExitedEarly(index, `worker ${index} exited with code ${code}`);
      });
      workers.push(worker);
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
          workers: activeWorkerCount,
          elapsedMs: now - start,
        });
      }
      Atomics.wait(counter, 1, completed, 1000);
    }

    for (let index = 0; index < activeWorkerCount; index++) {
      const errorPath = path.join(tmpDir, `${index}.error.json`);
      if (fs.existsSync(errorPath)) {
        const payload = JSON.parse(fs.readFileSync(errorPath, 'utf-8')) as {
          error?: string;
          currentTask?: string;
          taskCount?: number;
        };
        const task = payload.currentTask ? ` currentTask=${payload.currentTask}` : '';
        const taskCount = payload.taskCount === undefined ? '' : ` taskCount=${payload.taskCount}`;
        throw new Error(`${payload.error}${task}${taskCount}`);
      }
    }
    if (workerErrors.length > 0) {
      throw new Error(workerErrors.join('\n'));
    }
    const completed = Atomics.load(counter, 1);
    validateParseWorkerShardFiles(workerShardFiles, {
      completed,
      total: workItems.length,
      scheduler: useDynamicQueue ? 'dynamic' : 'static',
    });
    const factStats = emptyFactShardStats();
    const factStatsByShard: FactShardStats[] = [];
    for (const workerShard of workerShardFiles) {
      if (!workerShard.factStatsPath) continue;
      const shardStats = JSON.parse(fs.readFileSync(workerShard.factStatsPath, 'utf-8')) as FactShardStats;
      factStatsByShard.push(shardStats);
      addFactShardStats(factStats, shardStats);
    }
    options.progress?.({
      phase: 'parse',
      status: 'complete',
      completed,
      total: workItems.length,
      workers: activeWorkerCount,
      elapsedMs: Date.now() - start,
    });
    return {
      shardPaths,
      contextShardPaths,
      factShardPaths,
      factStatsPaths,
      factStatsByShard,
      factStats,
      workerCount: activeWorkerCount,
      resultCount: completed,
      elapsedMs: Date.now() - start,
      close,
    };
  } catch (error) {
    for (const worker of workers) worker.terminate().catch(() => undefined);
    options.progress?.({
      phase: 'parse',
      status: 'fallback',
      completed: 0,
      total: workItems.length,
      workers: 1,
      elapsedMs: Date.now() - start,
      message: error instanceof Error ? error.message : String(error),
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-parse-'));
    const fallbackClose = () => fs.rmSync(fallbackDir, { recursive: true, force: true });
    return parseFilesSequentialToSpool(workItems, fallbackDir, Date.now(), options.progress, fallbackClose, options);
  }
}

function validateParseWorkerShardFiles(
  shards: ParseWorkerShardFiles[],
  details: { completed: number; total: number; scheduler: 'dynamic' | 'static' },
): void {
  for (const shard of shards) {
    if (shard.outputPath) assertParseWorkerShardExists(shard, 'parse result', shard.outputPath, details);
    assertParseWorkerShardExists(shard, 'parse context', shard.contextPath, details);
    if (shard.factStatsPath) assertParseWorkerShardExists(shard, 'fact stats', shard.factStatsPath, details);
    if (shard.factPaths) {
      for (const [name, filePath] of Object.entries(shard.factPaths) as Array<[keyof FactShardPaths, string]>) {
        assertParseWorkerShardExists(shard, `fact ${String(name)}`, filePath, details);
      }
    }
  }
}

function assertParseWorkerShardExists(
  shard: ParseWorkerShardFiles,
  label: string,
  filePath: string,
  details: { completed: number; total: number; scheduler: 'dynamic' | 'static' },
): void {
  if (fs.existsSync(filePath)) return;
  throw new Error(
    `Parse worker ${shard.index} did not produce ${label} shard at ${filePath} `
    + `(scheduler=${details.scheduler}, completed=${details.completed}/${details.total}).`,
  );
}

export function* readParseWorkResultsJsonl(filePath: string): Iterable<ParseWorkResult> {
  if (!fs.existsSync(filePath)) throw new Error(`Missing parse result shard: ${filePath}`);
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const decoder = new StringDecoder('utf-8');
  let pending = '';

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = pending + decoder.write(buffer.subarray(0, bytesRead));
      const lines = chunk.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line) yield JSON.parse(line) as ParseWorkResult;
      }
    }
    pending += decoder.end();
    if (pending) yield JSON.parse(pending) as ParseWorkResult;
  } finally {
    fs.closeSync(fd);
  }
}

export function* readParseContextItemsJsonl(filePath: string): Iterable<ParseContextItem> {
  if (!fs.existsSync(filePath)) throw new Error(`Missing parse context shard: ${filePath}`);
  for (const item of readJsonlFile<ParseContextItem>(filePath)) {
    yield item;
  }
}

export function parseContextForResult(key: string, result: ParseResult): ParseContextItem {
  const fields: Array<[string, string]> = [];
  const methods: string[] = [];
  const methodFiles: Array<[string, string]> = [];
  const implementations: Array<[string, string]> = [];
  for (const sym of result.symbols) {
    if (sym.kind === 'field' && sym.returnType) {
      fields.push([sym.name, sym.returnType]);
    }
    if (sym.kind === 'method' && sym.parent) {
      const method = `${sym.parent}.${sym.name}`;
      methods.push(method);
      methodFiles.push([method, key]);
    }
    if ((sym.kind === 'class' || sym.kind === 'interface') && sym.implements?.length) {
      const child = simpleTypeName(symbolFqName(sym).replace(/\([^)]*\)$/, ''));
      for (const parent of sym.implements) {
        implementations.push([simpleTypeName(parent), child]);
      }
    }
  }
  return {
    key,
    parseStatus: result.hasParseErrors ? 'error' : 'ok',
    fields,
    methods,
    methodFiles,
    implementations,
  };
}

function* readJsonlFile<T>(filePath: string): Iterable<T> {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const decoder = new StringDecoder('utf-8');
  let pending = '';

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = pending + decoder.write(buffer.subarray(0, bytesRead));
      const lines = chunk.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line) yield JSON.parse(line) as T;
      }
    }
    pending += decoder.end();
    if (pending) yield JSON.parse(pending) as T;
  } finally {
    fs.closeSync(fd);
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

function parseFilesSequentialToSpool(
  workItems: ParseWorkItem[],
  tmpDir: string,
  start: number,
  progress: ((event: ParseBatchProgressEvent) => void) | undefined,
  close: () => void,
  options: ParseBatchOptions = {},
): ParseSpool {
  const spoolResults = options.spoolResults !== false;
  const shardPath = path.join(tmpDir, '0.json');
  const contextShardPath = path.join(tmpDir, '0.context.json');
  const fd = spoolResults ? fs.openSync(shardPath, 'w') : undefined;
  const contextFd = fs.openSync(contextShardPath, 'w');
  const factShardPaths = options.factShard ? factShardPathsForWorker(tmpDir, 0) : undefined;
  const factStatsPath = options.factShard ? path.join(tmpDir, '0.fact.stats.json') : undefined;
  const factWriter = factShardPaths ? openFactShardWriter(factShardPaths) : undefined;
  let lastProgressAt = 0;
  let reportedComplete = false;
  let failed = false;
  try {
    for (let index = 0; index < workItems.length; index++) {
      const item = workItems[index]!;
      const result: ParseWorkResult = {
        key: item.key,
        result: parseFile(item.absPath, item.rootDir),
      };
      if (fd !== undefined) fs.writeSync(fd, `${JSON.stringify(result)}\n`);
      fs.writeSync(contextFd, `${JSON.stringify(parseContextForResult(result.key, result.result))}\n`);
      writeFactShardResult(factWriter, options.factShard, item, result.result);
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
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.closeSync(contextFd);
    factWriter?.close();
    if (factStatsPath && factWriter && !failed) fs.writeFileSync(factStatsPath, JSON.stringify(factWriter.stats));
    if (failed) close();
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

  return {
    shardPaths: spoolResults ? [shardPath] : [],
    contextShardPaths: [contextShardPath],
    factShardPaths: factShardPaths ? [factShardPaths] : [],
    factStatsPaths: factStatsPath ? [factStatsPath] : [],
    factStatsByShard: factWriter ? [factWriter.stats] : [],
    factStats: factWriter?.stats ?? emptyFactShardStats(),
    workerCount: workItems.length <= 1 ? 0 : 1,
    resultCount: workItems.length,
    elapsedMs: Date.now() - start,
    close,
  };
}

export function writeFactShardResult(
  writer: FactShardWriter | undefined,
  config: FactShardConfig | undefined,
  item: ParseWorkItem,
  result: ParseResult,
): void {
  if (!writer || !config || !item.blobHash || !item.language) return;
  writeParseResultFactRows(writer, config, {
    relPath: item.key,
    blobHash: item.blobHash,
    language: item.language,
    role: item.role ?? 'main_source',
    cacheInsert: item.cacheInsert !== false,
  }, result);
}

function simpleTypeName(typeName: string): string {
  const withoutParams = typeName.replace(/\([^)]*\)$/, '');
  const parts = withoutParams.split('.').filter(Boolean);
  return parts[parts.length - 1] ?? withoutParams;
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

function resolveParseWorkerRuntime(): { workerPath: string; execArgv: string[] } | undefined {
  const jsWorkerPath = fileURLToPath(new URL('./parse-worker.js', import.meta.url));
  if (fs.existsSync(jsWorkerPath)) return { workerPath: jsWorkerPath, execArgv: [] };

  const tsWorkerPath = fileURLToPath(new URL('./parse-worker.ts', import.meta.url));
  if (!fs.existsSync(tsWorkerPath)) return undefined;
  if (!envFlag(process.env.CODEGRAPH_ENABLE_TSX_PARSE_WORKERS)) return undefined;
  if (!process.execArgv.some(arg => arg.includes('tsx'))) return undefined;
  return { workerPath: tsWorkerPath, execArgv: workerExecArgvForTsx() };
}

function workerExecArgvForTsx(): string[] {
  const args: string[] = [];
  for (let index = 0; index < process.execArgv.length; index++) {
    const arg = process.execArgv[index] ?? '';
    if (arg === '--eval' || arg === '-e') {
      index++;
      continue;
    }
    args.push(arg);
  }
  return args;
}

function envFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
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
