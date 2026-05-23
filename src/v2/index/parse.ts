import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { TreeSitterAnalyzer } from '../../analyzers/tree-sitter-analyzer.js';
import { detectFrameworkRoles, synthesizeLombokSymbols } from '../../analyzers/java-framework-detector.js';
import type { ParseResult } from '../../analyzers/base-analyzer.js';
import { parseConfigFile } from './config-parser.js';

const analyzer = new TreeSitterAnalyzer();

export interface ParseWorkItem {
  key: string;
  absPath: string;
  rootDir: string;
}

export interface ParseWorkResult {
  key: string;
  result: ParseResult;
}

export interface ParseBatchOptions {
  workers?: number;
}

export function parseFile(absPath: string, rootDir: string): ParseResult {
  const content = fs.readFileSync(absPath, 'utf-8');
  const configResult = parseConfigFile(absPath, content, rootDir);
  if (configResult) return configResult;

  let result: ParseResult;
  try {
    result = analyzer.parse(absPath, content, rootDir);
  } catch {
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
    detectFrameworkRoles(result.symbols);
    result.symbols.push(...synthesizeLombokSymbols(result.symbols, result.file));
  }

  return result;
}

export function parseFilesBatch(workItems: ParseWorkItem[], options: ParseBatchOptions = {}): ParseWorkResult[] {
  if (workItems.length === 0) return [];
  const workerCount = parseWorkerCount(workItems.length, options.workers);
  if (workerCount <= 1) return parseFilesSequential(workItems);

  const workerPath = fileURLToPath(new URL('./parse-worker.js', import.meta.url));
  if (!fs.existsSync(workerPath)) return parseFilesSequential(workItems);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-parse-'));
  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const counter = new Int32Array(shared);
  const chunks = chunkWorkItems(workItems, workerCount);
  counter[0] = chunks.length;
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
    while (Atomics.load(counter, 0) > 0) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for parse workers.');
      Atomics.wait(counter, 0, Atomics.load(counter, 0), 1000);
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
    const order = new Map(workItems.map((item, index) => [item.key, index]));
    return results.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
  } catch {
    for (const worker of workers) worker.terminate().catch(() => undefined);
    return parseFilesSequential(workItems);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function parseFilesSequential(workItems: ParseWorkItem[]): ParseWorkResult[] {
  return workItems.map(item => ({
    key: item.key,
    result: parseFile(item.absPath, item.rootDir),
  }));
}

function parseWorkerCount(itemCount: number, requested: number | undefined): number {
  const cpuCount = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  const defaultWorkers = Math.max(1, Math.min(4, cpuCount - 1, itemCount));
  if (requested === undefined || !Number.isFinite(requested)) return defaultWorkers;
  return Math.max(1, Math.min(Math.floor(requested), 16, itemCount));
}

function chunkWorkItems<T>(items: T[], chunkCount: number): T[][] {
  const chunks = Array.from({ length: chunkCount }, () => [] as T[]);
  items.forEach((item, index) => {
    chunks[index % chunkCount]?.push(item);
  });
  return chunks.filter(chunk => chunk.length > 0);
}

export function symbolFqName(symbol: {
  packageName?: string;
  parent?: string;
  name: string;
  kind: string;
  parameterTypes?: string[];
}): string {
  const owner = symbol.parent ? `${symbol.parent}.` : '';
  const params = symbol.kind === 'method' || symbol.kind === 'function'
    ? `(${(symbol.parameterTypes ?? []).join(',')})`
    : '';
  const packagePrefix = symbol.packageName ? `${symbol.packageName}.` : '';
  return `${packagePrefix}${owner}${symbol.name}${params}`;
}
