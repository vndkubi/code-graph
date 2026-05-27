import fs from 'node:fs';
import { workerData } from 'node:worker_threads';
import type { ParseWorkItem, ParseWorkResult } from './parse.js';
import { parseFile } from './parse.js';

const data = workerData as {
  tasks: ParseWorkItem[];
  outputPath: string;
  shared: SharedArrayBuffer;
};

try {
  const counter = new Int32Array(data.shared);
  const results: ParseWorkResult[] = [];
  for (const task of data.tasks) {
    results.push({
      key: task.key,
      result: parseFile(task.absPath, task.rootDir),
    });
    Atomics.add(counter, 1, 1);
    Atomics.notify(counter, 1);
  }
  fs.writeFileSync(data.outputPath, JSON.stringify({ results }));
} catch (error) {
  fs.writeFileSync(data.outputPath, JSON.stringify({
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  }));
} finally {
  const counter = new Int32Array(data.shared);
  Atomics.sub(counter, 0, 1);
  Atomics.notify(counter, 0);
  Atomics.notify(counter, 1);
}
