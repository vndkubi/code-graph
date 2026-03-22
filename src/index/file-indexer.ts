import fs from 'node:fs';
import fsp from 'node:fs/promises';
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

interface IndexedFile {
  path: string;
  mtimeMs: number;
  size: number;
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

    this.indexed = false;
    this.graphBuilder.clear();
    this.symbolIndex.clear();
    this.importIndex.clear();
    this.allReferences = [];
    this.filesIndexed = 0;
    this.parseErrorCount = 0;

    const files = this.walkDirectory(this.rootDir);

    // Read files in parallel batches, parse sequentially (tree-sitter is not thread-safe)
    const BATCH_SIZE = 50;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      const uncached: IndexedFile[] = [];
      const now = Date.now();

      for (const file of batch) {
        const cached = this.cache.getIfCurrent(file.path, file.mtimeMs, file.size, now);
        if (cached) {
          if (cached.hasParseErrors) this.parseErrorCount++;
          this.addToIndexes(cached);
          this.filesIndexed++;
        } else {
          uncached.push(file);
        }
      }

      const contents = await Promise.all(
        uncached.map(async (file) => {
          try {
            const content = await fsp.readFile(file.path, 'utf-8');
            return { file, content };
          } catch {
            return { file, content: null };
          }
        })
      );

      for (const { file, content } of contents) {
        if (content === null) continue;
        try {
          this.indexFileFromContent(file.path, content, file.mtimeMs, file.size);
        } catch (err) {
          console.warn(`[mcp-code-graph] Failed to parse ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Resolve import sources to node IDs now that all files are registered
    this.graphBuilder.resolveEdges();

    this.indexed = true;
    this.indexTimeMs = Date.now() - start;
  }

  /** Index a file with content already loaded into memory */
  private indexFileFromContent(absolutePath: string, content: string, mtimeMs: number, sizeBytes: number): void {
    const result = this.analyzer.parse(absolutePath, content, this.rootDir);

    // Apply framework role detection + Lombok synthesis for Java files
    if (absolutePath.endsWith('.java')) {
      detectFrameworkRoles(result.symbols);
      const synthetic = synthesizeLombokSymbols(result.symbols, result.file);
      result.symbols.push(...synthetic);
    }

    if (result.hasParseErrors) this.parseErrorCount++;
    this.cache.set(absolutePath, result, mtimeMs, sizeBytes);
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
  private walkDirectory(dir: string): IndexedFile[] {
    const results: IndexedFile[] = [];
    // Pre-compile exclude patterns for faster matching
    const excludeMatchers = this.excludePatterns.map(
      (pattern) => (relPath: string) => minimatch(relPath, pattern, { dot: true })
    );
    this.walkRecursive(dir, results, excludeMatchers);
    return results;
  }

  private walkRecursive(dir: string, results: IndexedFile[], excludeMatchers: Array<(relPath: string) => boolean>): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Permission denied or other error
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(this.rootDir, fullPath).replace(/\\/g, '/');

      // Inline exclude check to avoid function call overhead
      let excluded = false;
      for (const matcher of excludeMatchers) {
        if (matcher(relPath)) { excluded = true; break; }
      }
      if (excluded) continue;

      if (entry.isDirectory()) {
        this.walkRecursive(fullPath, results, excludeMatchers);
      } else if (entry.isFile() && isSourceFile(entry.name)) {
        // Use stat only when needed for size check
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size <= this.maxFileSizeBytes) {
            results.push({ path: fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
          }
        } catch {
          // Skip inaccessible files
        }
      }
    }
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
