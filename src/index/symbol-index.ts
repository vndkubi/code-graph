import type { SymbolInfo, SymbolKind } from '../analyzers/base-analyzer.js';

/**
 * In-memory index: symbol name → locations.
 * Supports exact and regex lookup.
 */
export class SymbolIndex {
  private byName = new Map<string, SymbolInfo[]>();
  private byFile = new Map<string, SymbolInfo[]>();
  private allSymbols: SymbolInfo[] = [];

  add(symbol: SymbolInfo): void {
    this.allSymbols.push(symbol);

    if (!this.byName.has(symbol.name)) this.byName.set(symbol.name, []);
    this.byName.get(symbol.name)!.push(symbol);

    if (!this.byFile.has(symbol.file)) this.byFile.set(symbol.file, []);
    this.byFile.get(symbol.file)!.push(symbol);
  }

  /** Find by exact name */
  findByName(name: string): SymbolInfo[] {
    return this.byName.get(name) ?? [];
  }

  /** Find by regex pattern */
  findByPattern(pattern: string, kind?: SymbolKind, limit: number = 20): SymbolInfo[] {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'i');
    } catch {
      // If invalid regex, treat as literal
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    const results: SymbolInfo[] = [];
    for (const sym of this.allSymbols) {
      if (results.length >= limit) break;
      if (!regex.test(sym.name)) continue;
      if (kind && kind !== 'all' as string && sym.kind !== kind) continue;
      results.push(sym);
    }
    return results;
  }

  /** Get all symbols in a file */
  getByFile(file: string): SymbolInfo[] {
    return this.byFile.get(file) ?? [];
  }

  getAllSymbols(): readonly SymbolInfo[] {
    return this.allSymbols;
  }

  /** Find symbols that carry a specific annotation (e.g. "Service", "Transactional") */
  findByAnnotation(annotation: string, limit = 100): SymbolInfo[] {
    const results: SymbolInfo[] = [];
    const lower = annotation.toLowerCase();
    for (const sym of this.allSymbols) {
      if (results.length >= limit) break;
      if (sym.annotations?.some(a => a.toLowerCase() === lower)) results.push(sym);
    }
    return results;
  }

  /** Find symbols that have a specific framework role (e.g. "spring:service", "test:test") */
  findByFrameworkRole(role: string, limit = 100): SymbolInfo[] {
    const results: SymbolInfo[] = [];
    const lower = role.toLowerCase();
    for (const sym of this.allSymbols) {
      if (results.length >= limit) break;
      if (sym.frameworkRole?.toLowerCase().startsWith(lower)) results.push(sym);
    }
    return results;
  }

  /** Get all symbols in a module (prefix match on file path) */
  getByModule(module: string): SymbolInfo[] {
    const results: SymbolInfo[] = [];
    for (const [file, symbols] of this.byFile) {
      if (file.startsWith(module) || symbols.some(s => s.module === module)) {
        results.push(...symbols);
      }
    }
    return results;
  }

  clear(): void {
    this.byName.clear();
    this.byFile.clear();
    this.allSymbols = [];
  }

  get size(): number {
    return this.allSymbols.length;
  }
}
