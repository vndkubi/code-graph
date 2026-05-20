import { openCodeGraphDb } from '../storage/database.js';
import { V2Indexer } from '../index/indexer.js';

export interface BenchmarkIndexResult {
  result: ReturnType<V2Indexer['indexWorkspace']>;
  peakRssMb: number;
}

export function runIndexBenchmark(root: string, homeDir?: string): BenchmarkIndexResult {
  const { db } = openCodeGraphDb(homeDir);
  const indexer = new V2Indexer(db);
  const result = indexer.indexWorkspace({ root });
  return {
    result,
    peakRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
}
