import type { ParseResult, ImportInfo, TypeRefInfo } from '../analyzers/base-analyzer.js';
import { DependencyGraph, type GraphNode } from './dependency-graph.js';
import { CallGraph } from './call-graph.js';
import { detectLayer } from '../utils/layer-detection.js';

interface PendingImport {
  from: string;
  imp: ImportInfo;
  edgeType: 'compile' | 'test';
}

interface PendingTypeRef {
  from: string;
  ref: TypeRefInfo;
  edgeType: 'compile' | 'test';
}

/**
 * Builds dependency graph and call graph from parsed results.
 * Edge resolution is deferred until resolveEdges() is called so that
 * all nodes exist before we attempt to match import sources to node IDs.
 */
export class GraphBuilder {
  private depGraph = new DependencyGraph();
  private callGraph = new CallGraph();
  private pendingImports: PendingImport[] = [];
  private pendingTypeRefs: PendingTypeRef[] = [];
  private resolvedImportCount = 0;
  private totalImportCount = 0;

  // ─── Lookup indexes built once in resolveEdges() ──────────
  /** Map from normalized suffix segments to node IDs for O(1) suffix matching */
  private suffixIndex = new Map<string, string>();
  /** Map from className (file basename without extension) to node ID */
  private classNameIndex = new Map<string, string>();

  /** Add parsed file results to both graphs */
  addParseResult(result: ParseResult): void {
    // Register file as a node in dependency graph
    const fileNode: GraphNode = {
      id: result.file,
      name: this.extractFileName(result.file),
      type: 'file',
      layer: detectLayer(result.file),
      path: result.file,
    };
    this.depGraph.addNode(fileNode);

    // Add symbol definitions to call graph
    for (const sym of result.symbols) {
      if (sym.kind === 'method' || sym.kind === 'function') {
        const symbolName = sym.parent ? `${sym.parent}.${sym.name}` : sym.name;
        this.callGraph.addNode({
          symbol: symbolName,
          file: result.file,
          line: sym.line,
        });
      }
    }

    // Defer import resolution until all nodes are registered
    const edgeType = this.isTestFile(result.file) ? 'test' : 'compile';
    for (const imp of result.imports) {
      this.pendingImports.push({ from: result.file, imp, edgeType });
    }

    // Defer type-reference resolution (supplements imports for wildcard/same-package cases)
    if (result.typeReferences) {
      for (const ref of result.typeReferences) {
        this.pendingTypeRefs.push({ from: result.file, ref, edgeType });
      }
    }

    // Add call edges
    for (const call of result.calls) {
      this.callGraph.addEdge({
        from: call.caller,
        to: call.callee,
        file: call.file,
        line: call.line,
      });
    }
  }

  /**
   * Must be called after ALL files have been added via addParseResult().
   * Resolves import sources to node IDs and adds dependency edges.
   */
  resolveEdges(): void {
    // Build lookup indexes once — turns O(M×N) resolution into O(M)
    this.buildLookupIndexes();

    this.resolvedImportCount = 0;
    let localCandidateCount = 0;

    // Resolve import-based edges first (primary source of truth)
    const resolvedEdges = new Set<string>();  // "from→to" to avoid duplicates
    for (const { from, imp, edgeType } of this.pendingImports) {
      const targetId = this.findImportTarget(imp.source, from);
      if (targetId) {
        this.depGraph.addEdge({ from, to: targetId, type: edgeType, weight: 1 });
        resolvedEdges.add(`${from}→${targetId}`);
        this.resolvedImportCount++;
        localCandidateCount++;
      } else {
        // Only count as "unresolved local" if the imported class name exists somewhere in the graph.
        // Imports to stdlib/third-party (java.util.*, org.springframework.*) won't match any node
        // and should not penalise the resolution rate.
        const className = imp.source.split('.').pop() ?? '';
        if (className !== '*' && className.length > 0 && this.classNameIndex.has(className)) {
          localCandidateCount++;
        }
      }
    }

    this.totalImportCount = localCandidateCount;
    this.pendingImports = [];

    // Supplement with type-reference edges (field/param/return types).
    // These cover same-package usage and wildcard imports that couldn't be resolved above.
    for (const { from, ref, edgeType } of this.pendingTypeRefs) {
      const targetId = this.classNameIndex.get(ref.referencedType);
      if (targetId && targetId !== from && !resolvedEdges.has(`${from}→${targetId}`)) {
        this.depGraph.addEdge({ from, to: targetId, type: edgeType, weight: 1 });
        resolvedEdges.add(`${from}→${targetId}`);
      }
    }
    this.pendingTypeRefs = [];
  }

  clear(): void {
    this.depGraph.clear();
    this.callGraph.clear();
    this.pendingImports = [];
    this.pendingTypeRefs = [];
    this.resolvedImportCount = 0;
    this.totalImportCount = 0;
    this.suffixIndex.clear();
    this.classNameIndex.clear();
  }

  /**
   * Build suffix and className lookup indexes from all registered nodes.
   * Called once before edge resolution.
   */
  private buildLookupIndexes(): void {
    this.suffixIndex.clear();
    this.classNameIndex.clear();

    for (const node of this.depGraph.getAllNodes()) {
      const normId = node.id.replace(/\\/g, '/');

      // Build className index: basename without extension → node.id
      const lastSlash = normId.lastIndexOf('/');
      const basename = normId.substring(lastSlash + 1);
      const basenameNoExt = basename.replace(/\.[^.]+$/, '');
      // First registration wins (consistent with previous linear scan behavior)
      if (!this.classNameIndex.has(basenameNoExt)) {
        this.classNameIndex.set(basenameNoExt, node.id);
      }

      // Build suffix index: progressively longer suffixes from path segments
      // e.g., "src/com/example/Foo.java" registers:
      //   "Foo.java", "example/Foo.java", "com/example/Foo.java", "src/com/example/Foo.java"
      const segments = normId.split('/');
      let suffix = '';
      for (let i = segments.length - 1; i >= 0; i--) {
        suffix = suffix ? segments[i] + '/' + suffix : segments[i];
        if (!this.suffixIndex.has(suffix)) {
          this.suffixIndex.set(suffix, node.id);
        }
      }
    }
  }

  /**
   * Find a node whose file name (without extension) matches the given class name.
   * Uses pre-built className index for O(1) lookup.
   */
  private findNodeByClassName(className: string): string | undefined {
    return this.classNameIndex.get(className);
  }

  /** Fraction of local imports that could be resolved to a known file (0–1). */
  getImportResolutionRate(): number {
    if (this.totalImportCount === 0) return 1;
    return this.resolvedImportCount / this.totalImportCount;
  }

  getDependencyGraph(): DependencyGraph {
    return this.depGraph;
  }

  getCallGraph(): CallGraph {
    return this.callGraph;
  }

  /**
   * Try to match an import source to an existing node ID.
   * Handles relative imports (TS), dotted Java/Python package names,
   * and normalizes Windows backslashes.
   */
  private findImportTarget(source: string, fromFile: string): string | undefined {
    // Normalize to forward slashes for comparison
    const fromNorm = fromFile.replace(/\\/g, '/');

    // Relative import: ./foo, ../bar
    if (source.startsWith('.')) {
      const dir = fromNorm.substring(0, fromNorm.lastIndexOf('/'));
      const parts = source.split('/');
      let resolved = dir;
      for (const part of parts) {
        if (part === '.' || part === '') continue;
        if (part === '..') {
          resolved = resolved.substring(0, resolved.lastIndexOf('/'));
        } else {
          resolved = resolved ? `${resolved}/${part}` : part;
        }
      }
      // Try exact match first, then with common extensions
      return this.matchNodeBySuffix(resolved) ?? this.matchNodeBySuffix(resolved + '.ts')
        ?? this.matchNodeBySuffix(resolved + '.tsx') ?? this.matchNodeBySuffix(resolved + '.js');
    }

    // Java/Python dotted package: com.example.payment.PaymentService
    if (source.includes('.')) {
      const slashPath = source.replace(/\./g, '/');
      return this.matchNodeBySuffix(slashPath + '.java')
        ?? this.matchNodeBySuffix(slashPath + '.py')
        ?? this.matchNodeBySuffix(slashPath);
    }

    return this.matchNodeBySuffix(source);
  }

  /** Find a node whose normalized ID ends with the given suffix. Uses pre-built suffix index for O(1) lookup. */
  private matchNodeBySuffix(suffix: string): string | undefined {
    const normSuffix = suffix.replace(/\\/g, '/');
    // Direct lookup in suffix index
    return this.suffixIndex.get(normSuffix);
  }

  private extractFileName(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1];
  }

  private isTestFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.includes('test') || lower.includes('spec') || lower.includes('__tests__');
  }
}
