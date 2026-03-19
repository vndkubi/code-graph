import fs from 'node:fs';
import path from 'node:path';
import { TreeSitterAnalyzer } from '../analyzers/tree-sitter-analyzer.js';
import { detectFrameworkRoles, synthesizeLombokSymbols } from '../analyzers/java-framework-detector.js';
import { isSourceFile, DEFAULT_EXCLUDES } from '../analyzers/language-detector.js';
import { GraphBuilder } from '../graph/graph-builder.js';
import { SymbolIndex } from './symbol-index.js';
import { ImportIndex } from './import-index.js';
import { LruCache } from '../cache/lru-cache.js';
import { guardPath } from '../utils/path-guard.js';
import type { DependencyGraph } from '../graph/dependency-graph.js';
import type { CallGraph } from '../graph/call-graph.js';
import type { ParseResult, ReferenceInfo } from '../analyzers/base-analyzer.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { minimatch } = require('minimatch') as { minimatch: (p: string, pattern: string, opts?: { dot?: boolean }) => boolean };

export interface IndexOptions {
  rootDir: string;
  excludePatterns?: string[];
  maxFileSizeKb?: number;
  cacheTtlMs?: number;
}

export interface IndexState {
  ready: boolean;
  filesIndexed: number;
  symbolCount: number;
  importCount: number;
  indexTimeMs: number;
  parseErrorCount: number;
  importResolutionRate: number;
}

/**
 * Central indexer: walks repo, parses files, populates all indexes.
 * Lazy — only indexes on first query, then caches.
 */
export class FileIndexer {
  private readonly rootDir: string;
  private readonly excludePatterns: string[];
  private readonly maxFileSizeBytes: number;
  private readonly analyzer = new TreeSitterAnalyzer();
  private readonly graphBuilder = new GraphBuilder();
  private readonly symbolIndex = new SymbolIndex();
  private readonly importIndex = new ImportIndex();
  private readonly cache: LruCache<ParseResult>;
  private allReferences: ReferenceInfo[] = [];
  private indexed = false;
  private indexTimeMs = 0;
  private filesIndexed = 0;
  private parseErrorCount = 0;

  constructor(options: IndexOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.excludePatterns = options.excludePatterns ?? DEFAULT_EXCLUDES;
    this.maxFileSizeBytes = (options.maxFileSizeKb ?? 500) * 1024;
    this.cache = new LruCache(2000, options.cacheTtlMs ?? 300_000);
  }

  /** Ensure index is built (lazy initialization) */
  async ensureIndexed(): Promise<void> {
    if (this.indexed) return;
    await this.buildIndex();
  }

  /** Force rebuild the entire index */
  async buildIndex(): Promise<void> {
    const start = Date.now();

    this.symbolIndex.clear();
    this.importIndex.clear();
    this.allReferences = [];
    this.filesIndexed = 0;

    const files = this.walkDirectory(this.rootDir);

    for (const filePath of files) {
      try {
        this.indexFile(filePath);
      } catch (err) {
        // Graceful degradation: skip files that fail to parse
        console.warn(`[mcp-code-graph] Failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Resolve import sources to node IDs now that all files are registered
    this.graphBuilder.resolveEdges();

    this.indexed = true;
    this.indexTimeMs = Date.now() - start;
  }

  private indexFile(absolutePath: string): void {
    const cached = this.cache.get(absolutePath);
    if (cached) {
      if (cached.hasParseErrors) this.parseErrorCount++;
      this.addToIndexes(cached);
      this.filesIndexed++;
      return;
    }

    const content = fs.readFileSync(absolutePath, 'utf-8');
    const result = this.analyzer.parse(absolutePath, content, this.rootDir);

    // Apply framework role detection + Lombok synthesis for Java files
    if (absolutePath.endsWith('.java')) {
      detectFrameworkRoles(result.symbols);
      const synthetic = synthesizeLombokSymbols(result.symbols, result.file);
      result.symbols.push(...synthetic);
    }

    if (result.hasParseErrors) this.parseErrorCount++;
    this.cache.set(absolutePath, result);
    this.addToIndexes(result);
    this.filesIndexed++;
  }

  private addToIndexes(result: ParseResult): void {
    this.graphBuilder.addParseResult(result);

    for (const sym of result.symbols) {
      this.symbolIndex.add(sym);
    }

    for (const imp of result.imports) {
      this.importIndex.add(imp);
    }

    this.allReferences.push(...result.references);
  }

  /** Recursively walk directory, filtering by extensions and exclude patterns */
  private walkDirectory(dir: string): string[] {
    const results: string[] = [];
    this.walkRecursive(dir, results);
    return results;
  }

  private walkRecursive(dir: string, results: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Permission denied or other error
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(this.rootDir, fullPath).replace(/\\/g, '/');

      if (this.isExcluded(relPath)) continue;

      if (entry.isDirectory()) {
        this.walkRecursive(fullPath, results);
      } else if (entry.isFile() && isSourceFile(entry.name)) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size <= this.maxFileSizeBytes) {
            results.push(fullPath);
          }
        } catch {
          // Skip inaccessible files
        }
      }
    }
  }

  private isExcluded(relPath: string): boolean {
    for (const pattern of this.excludePatterns) {
      if (minimatch(relPath, pattern, { dot: true })) return true;
    }
    return false;
  }

  // ─── Accessors ──────────────────────────────────────────

  getDependencyGraph(): DependencyGraph {
    return this.graphBuilder.getDependencyGraph();
  }

  getCallGraph(): CallGraph {
    return this.graphBuilder.getCallGraph();
  }

  getSymbolIndex(): SymbolIndex {
    return this.symbolIndex;
  }

  getImportIndex(): ImportIndex {
    return this.importIndex;
  }

  getAllReferences(): ReferenceInfo[] {
    return this.allReferences;
  }

  getState(): IndexState {
    return {
      ready: this.indexed,
      filesIndexed: this.filesIndexed,
      symbolCount: this.symbolIndex.size,
      importCount: this.importIndex.size,
      indexTimeMs: this.indexTimeMs,
      parseErrorCount: this.parseErrorCount,
      importResolutionRate: this.graphBuilder.getImportResolutionRate(),
    };
  }

  getRootDir(): string {
    return this.rootDir;
  }
}
