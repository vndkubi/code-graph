import { z } from 'zod';
import type { FileIndexer } from '../index/file-indexer.js';
import fs from 'node:fs';
import path from 'node:path';
import { computeIndexConfidence, roundConfidence } from '../utils/confidence.js';

export const FindReferencesSchema = z.object({
  symbol: z.string().describe('Class/function/variable name. Exact or regex.'),
  file: z.string().optional().describe('Restrict to a single file path (relative to root).'),
  kind: z.enum(['call', 'import', 'definition', 'all']).default('all').describe('Filter by reference kind.'),
  contextLines: z.number().min(0).max(5).default(2).describe('Lines of surrounding code.'),
});

export type FindReferencesInput = z.infer<typeof FindReferencesSchema>;

const MAX_RESULTS = 100;

export async function findReferences(input: FindReferencesInput, indexer: FileIndexer) {
  await indexer.ensureIndexed();

  let regex: RegExp;
  try {
    regex = new RegExp(input.symbol, 'i');
  } catch {
    regex = new RegExp(input.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  const references: Array<{
    file: string;
    line: number;
    column: number;
    kind: string;
    context: string;
    symbolName: string;
  }> = [];

  const symbolIndex = indexer.getSymbolIndex();
  const importIndex = indexer.getImportIndex();
  const allRefs = indexer.getAllReferences();
  let filesScanned = 0;

  // 1. Find definitions
  if (input.kind === 'all' || input.kind === 'definition') {
    const symbols = symbolIndex.findByPattern(input.symbol, undefined, MAX_RESULTS);
    for (const sym of symbols) {
      if (input.file && sym.file !== input.file) continue;
      references.push({
        file: sym.file,
        line: sym.line,
        column: sym.column,
        kind: 'definition',
        context: getContext(sym.file, sym.line, input.contextLines, indexer.getRootDir()),
        symbolName: sym.name,
      });
    }
  }

  // 2. Find imports
  if (input.kind === 'all' || input.kind === 'import') {
    const allSources = importIndex.getAllSources();
    for (const source of allSources) {
      if (!regex.test(source)) continue;
      const importers = importIndex.getImporters(source);
      for (const imp of importers) {
        if (input.file && imp.file !== input.file) continue;
        references.push({
          file: imp.file,
          line: imp.line,
          column: 1,
          kind: 'import',
          context: getContext(imp.file, imp.line, input.contextLines, indexer.getRootDir()),
          symbolName: source,
        });
      }
    }
  }

  // 3. Find call references
  if (input.kind === 'all' || input.kind === 'call') {
    for (const ref of allRefs) {
      if (references.length >= MAX_RESULTS) break;
      if (!regex.test(ref.symbolName)) continue;
      if (input.file && ref.file !== input.file) continue;
      if (ref.kind !== 'call') continue;
      references.push({
        file: ref.file,
        line: ref.line,
        column: ref.column,
        kind: ref.kind,
        context: getContext(ref.file, ref.line, input.contextLines, indexer.getRootDir()),
        symbolName: ref.symbolName,
      });
    }
  }

  const truncated = references.length > MAX_RESULTS;
  const finalRefs = references.slice(0, MAX_RESULTS);

  const { confidence: indexConfidence, confidenceNotes } = computeIndexConfidence(indexer);
  const notes = [...confidenceNotes];
  if (truncated) notes.push(`Results truncated at ${MAX_RESULTS} — use a more specific symbol name`);

  return {
    references: finalRefs,
    totalCount: finalRefs.length,
    filesScanned: indexer.getState().filesIndexed,
    truncated,
    confidence: roundConfidence(indexConfidence),
    confidenceNotes: notes,
  };
}

function getContext(relFile: string, line: number, contextLines: number, rootDir: string): string {
  try {
    const absPath = path.resolve(rootDir, relFile);
    const content = fs.readFileSync(absPath, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, line - 1 - contextLines);
    const end = Math.min(lines.length, line + contextLines);
    return lines.slice(start, end).join('\n');
  } catch {
    return '';
  }
}
