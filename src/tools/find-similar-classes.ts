import { z } from 'zod';
import type { FileIndexer } from '../index/file-indexer.js';
import type { SymbolInfo } from '../analyzers/base-analyzer.js';

export const FindSimilarClassesSchema = z.object({
  className: z.string().describe('Reference class name to find similar classes for.'),
  limit: z.number().min(1).max(100).default(20).describe('Max results.'),
});

export type FindSimilarClassesInput = z.infer<typeof FindSimilarClassesSchema>;

export async function findSimilarClasses(input: FindSimilarClassesInput, indexer: FileIndexer) {
  await indexer.ensureIndexed();

  const symbolIndex = indexer.getSymbolIndex();

  // Find the reference class
  const matches = symbolIndex.findByName(input.className);
  const refClass = matches.find(s => s.kind === 'class' || s.kind === 'interface');
  if (!refClass) {
    return { error: `Class "${input.className}" not found.`, similar: [] };
  }

  const allClasses = symbolIndex.getAllSymbols()
    .filter(s => s.kind === 'class' || s.kind === 'interface');

  const scored: Array<{
    name: string;
    file: string;
    line: number;
    kind: string;
    score: number;
    reasons: string[];
  }> = [];

  for (const cls of allClasses) {
    if (cls.name === refClass.name && cls.file === refClass.file) continue;

    let score = 0;
    const reasons: string[] = [];

    // Same parent class
    if (refClass.extends && cls.extends === refClass.extends) {
      score += 40;
      reasons.push(`extends same class: ${refClass.extends}`);
    }

    // Shared interfaces
    if (refClass.implements && cls.implements) {
      const shared = refClass.implements.filter(i => cls.implements!.includes(i));
      if (shared.length > 0) {
        score += 30 * shared.length;
        reasons.push(`implements same interface(s): ${shared.join(', ')}`);
      }
    }

    // Same framework role
    if (refClass.frameworkRole && cls.frameworkRole === refClass.frameworkRole) {
      score += 20;
      reasons.push(`same framework role: ${refClass.frameworkRole}`);
    }

    // Shared annotations
    if (refClass.annotations && cls.annotations) {
      const shared = refClass.annotations.filter(a => cls.annotations!.includes(a));
      if (shared.length > 0) {
        score += 10 * shared.length;
        reasons.push(`shared annotations: ${shared.join(', ')}`);
      }
    }

    // Same layer (based on file path)
    const graph = indexer.getDependencyGraph();
    const refNode = graph.findNode(refClass.file);
    const clsNode = graph.findNode(cls.file);
    if (refNode && clsNode && refNode.layer === clsNode.layer && refNode.layer !== 'other') {
      score += 5;
      reasons.push(`same layer: ${refNode.layer}`);
    }

    // Same package
    if (refClass.packageName && cls.packageName === refClass.packageName) {
      score += 5;
      reasons.push(`same package: ${refClass.packageName}`);
    }

    // Compare method signatures
    if (score > 0) {
      const refMethods = getMethodNames(symbolIndex, refClass);
      const clsMethods = getMethodNames(symbolIndex, cls);
      const sharedMethods = refMethods.filter(m => clsMethods.includes(m));
      if (sharedMethods.length > 0) {
        score += 5 * Math.min(sharedMethods.length, 5);
        reasons.push(`shared method names (${sharedMethods.length}): ${sharedMethods.slice(0, 5).join(', ')}`);
      }
    }

    if (score > 0) {
      scored.push({ name: cls.name, file: cls.file, line: cls.line, kind: cls.kind, score, reasons });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return {
    reference: {
      name: refClass.name,
      file: refClass.file,
      extends: refClass.extends,
      implements: refClass.implements,
      annotations: refClass.annotations,
      frameworkRole: refClass.frameworkRole,
    },
    similar: scored.slice(0, input.limit),
    totalFound: scored.length,
  };
}

function getMethodNames(symbolIndex: ReturnType<FileIndexer['getSymbolIndex']>, cls: SymbolInfo): string[] {
  const symbols = symbolIndex.getByFile(cls.file);
  return symbols
    .filter(s => s.kind === 'method' && s.parent === cls.name)
    .map(s => s.name);
}
