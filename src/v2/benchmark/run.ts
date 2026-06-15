import { openCodeGraphDb } from '../storage/database.js';
import { V2Indexer, type IndexWorkspaceOptions } from '../index/indexer.js';

export interface BenchmarkIndexResult {
  result: Awaited<ReturnType<V2Indexer['indexWorkspace']>>;
  peakRssMb: number;
}

export async function runIndexBenchmark(
  root: string,
  options: Pick<IndexWorkspaceOptions, 'indexProviders' | 'scipIndexPath'> = {},
): Promise<BenchmarkIndexResult> {
  const { db } = await openCodeGraphDb(root);
  const indexer = new V2Indexer(db);
  try {
    const result = await indexer.indexWorkspace({ root, ...options });
    return {
      result,
      peakRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    };
  } finally {
    await db.close();
  }
}
