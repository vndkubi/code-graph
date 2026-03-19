import type { FileIndexer } from '../index/file-indexer.js';

export interface ConfidenceResult {
  confidence: number;
  confidenceNotes: string[];
}

/**
 * Compute overall index-level confidence from IndexState.
 * Factors:
 *  - Parse error rate (files with syntax errors parsed less reliably)
 *  - Import resolution rate (unresolved imports = dependency graph may be incomplete)
 */
export function computeIndexConfidence(indexer: FileIndexer): ConfidenceResult {
  const state = indexer.getState();
  const notes: string[] = [];
  let confidence = 1.0;

  if (state.filesIndexed > 0 && state.parseErrorCount > 0) {
    const errorRate = state.parseErrorCount / state.filesIndexed;
    confidence -= errorRate * 0.3;
    notes.push(
      `${state.parseErrorCount} of ${state.filesIndexed} file(s) had parse errors — symbol extraction may be incomplete`,
    );
  }

  const unresolved = 1 - state.importResolutionRate;
  if (unresolved > 0.05) {
    confidence -= unresolved * 0.2;
    notes.push(
      `${(unresolved * 100).toFixed(0)}% of imports could not be resolved to local files — dependency graph may be incomplete`,
    );
  }

  return { confidence: Math.max(0.1, Math.min(1.0, confidence)), confidenceNotes: notes };
}

/** Clamp and round confidence to 2 decimal places. */
export function roundConfidence(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}
