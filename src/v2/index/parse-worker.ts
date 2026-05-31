import fs from 'node:fs';
import { workerData } from 'node:worker_threads';
import type { ParseWorkItem, ParseWorkResult } from './parse.js';
import { parseContextForResult, parseFile, writeFactShardResult } from './parse.js';
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
  shared: SharedArrayBuffer;
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
    Atomics.add(counter, 1, 1);
    Atomics.notify(counter, 1);
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
