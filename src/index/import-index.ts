import type { ImportInfo } from '../analyzers/base-analyzer.js';

/**
 * Reverse import map: module → files that import it.
 */
export class ImportIndex {
  // source module → importing files
  private importedBy = new Map<string, ImportInfo[]>();
  // file → its imports
  private fileImports = new Map<string, ImportInfo[]>();

  add(importInfo: ImportInfo): void {
    if (!this.importedBy.has(importInfo.source)) {
      this.importedBy.set(importInfo.source, []);
    }
    this.importedBy.get(importInfo.source)!.push(importInfo);

    if (!this.fileImports.has(importInfo.file)) {
      this.fileImports.set(importInfo.file, []);
    }
    this.fileImports.get(importInfo.file)!.push(importInfo);
  }

  /** Who imports this module? */
  getImporters(source: string): ImportInfo[] {
    // Exact match
    const exact = this.importedBy.get(source);
    if (exact && exact.length > 0) return exact;

    // Partial match: find keys that end with the source
    const results: ImportInfo[] = [];
    for (const [key, imports] of this.importedBy) {
      if (key.endsWith(source) || key.endsWith('/' + source) || source.endsWith(key)) {
        results.push(...imports);
      }
    }
    return results;
  }

  /** What does this file import? */
  getImportsOf(file: string): ImportInfo[] {
    return this.fileImports.get(file) ?? [];
  }

  /** Get all unique import sources */
  getAllSources(): string[] {
    return [...this.importedBy.keys()];
  }

  get size(): number {
    let count = 0;
    for (const imports of this.fileImports.values()) count += imports.length;
    return count;
  }

  clear(): void {
    this.importedBy.clear();
    this.fileImports.clear();
  }
}
