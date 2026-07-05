import fs from 'node:fs';
import { workerData } from 'node:worker_threads';
import type { ParseWorkItem, ParseWorkResult } from './parse.js';
import { PARSE_WORKER_RECYCLE_EXIT_CODE, parseContextForResult, parseFile, writeFactShardResult } from './parse.js';
import { openFactShardWriter, type FactShardConfig, type FactShardPaths, type FactShardWriter } from './fact-shards.js';

const data = workerData as {
  tasks: ParseWorkItem[];
  dynamicTasks?: boolean;
  outputPath?: string;
  contextPath: string;
  errorPath: string;
  factShardConfig?: FactShardConfig;
  factShardPaths?: FactShardPaths;
  factStatsPath?: string;
  recycleStatsPath: string;
  shared: SharedArrayBuffer;
  recycleAfterFiles?: number;
  recycleAfterBytes?: number;
};

let currentTask: ParseWorkItem | undefined;
let output: number | undefined;
let contextOutput: number | undefined;
let factWriter: FactShardWriter | undefined;
try {
  const counter = new Int32Array(data.shared);
  if (data.outputPath) output = fs.openSync(data.outputPath, 'w');
  contextOutput = fs.openSync(data.contextPath, 'w');
  factWriter = data.factShardPaths ? openFactShardWriter(data.factShardPaths) : undefined;
  let parsedByThisWorker = 0;
  let bytesParsedByThisWorker = 0;
  while (true) {
    const taskIndex = data.dynamicTasks ? Atomics.add(counter, 2, 1) : undefined;
    if (taskIndex !== undefined && taskIndex >= data.tasks.length) break;
    const task = taskIndex === undefined
      ? data.tasks.shift()
      : data.tasks[taskIndex];
    if (!task) break;
    currentTask = task;
    const result: ParseWorkResult = {
      key: task.key,
      result: parseFile(task.absPath, task.rootDir),
    };
    if (output !== undefined) fs.writeSync(output, `${JSON.stringify(result)}\n`);
    fs.writeSync(contextOutput, `${JSON.stringify(parseContextForResult(result.key, result.result))}\n`);
    writeFactShardResult(factWriter, data.factShardConfig, task, result.result);
    parsedByThisWorker++;
    bytesParsedByThisWorker += task.size ?? 0;
    Atomics.add(counter, 1, 1);
    Atomics.notify(counter, 1);
    // Retire while the queue still has work: the tree-sitter binding leaks
    // native memory per parsed file, and only isolate teardown reclaims it.
    // The parent sees the recycle exit code and spawns a replacement that
    // resumes from the shared queue counter. Deliberately NOT decrementing
    // the active-worker counter here — the replacement inherits this slot.
    // The byte budget matters more than the file count: the leak scales with
    // source bytes and the dynamic queue serves the largest files first.
    if (data.dynamicTasks
      && ((data.recycleAfterFiles !== undefined && parsedByThisWorker >= data.recycleAfterFiles)
        || (data.recycleAfterBytes !== undefined && bytesParsedByThisWorker >= data.recycleAfterBytes))
      && Atomics.load(counter, 2) < data.tasks.length) {
      if (data.factStatsPath && factWriter) fs.writeFileSync(data.factStatsPath, JSON.stringify(factWriter.stats));
      fs.writeFileSync(data.recycleStatsPath, JSON.stringify({
        filesParsed: parsedByThisWorker,
        bytesParsed: bytesParsedByThisWorker,
        rss: process.memoryUsage().rss,
      }));
      if (output !== undefined) fs.closeSync(output);
      fs.closeSync(contextOutput);
      factWriter?.close();
      // process.exit() in a worker stops only this thread; finally blocks do
      // not run, so the cleanup above is the real cleanup.
      process.exit(PARSE_WORKER_RECYCLE_EXIT_CODE);
    }
  }
  if (data.factStatsPath && factWriter) fs.writeFileSync(data.factStatsPath, JSON.stringify(factWriter.stats));
} catch (error) {
  if (output !== undefined) {
    try {
      fs.closeSync(output);
    } catch {
      // Ignore close failures while preserving the original worker error.
    }
    output = undefined;
  }
  if (contextOutput !== undefined) {
    try {
      fs.closeSync(contextOutput);
    } catch {
      // Ignore close failures while preserving the original worker error.
    }
    contextOutput = undefined;
  }
  if (factWriter !== undefined) {
    try {
      factWriter.close();
    } catch {
      // Ignore close failures while preserving the original worker error.
    }
    factWriter = undefined;
  }
  fs.writeFileSync(data.errorPath, JSON.stringify({
    error: error instanceof Error ? error.stack ?? error.message : String(error),
    currentTask: currentTask?.key,
    taskCount: data.tasks.length,
  }));
} finally {
  if (output !== undefined) fs.closeSync(output);
  if (contextOutput !== undefined) fs.closeSync(contextOutput);
  factWriter?.close();
  const counter = new Int32Array(data.shared);
  Atomics.sub(counter, 0, 1);
  Atomics.notify(counter, 0);
  Atomics.notify(counter, 1);
}
