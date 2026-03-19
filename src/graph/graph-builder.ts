import type { ParseResult, ImportInfo, TypeRefInfo } from '../analyzers/base-analyzer.js';
import { DependencyGraph, type GraphNode } from './dependency-graph.js';
import { CallGraph } from './call-graph.js';

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

  /** Add parsed file results to both graphs */
  addParseResult(result: ParseResult): void {
    // Register file as a node in dependency graph
    const fileNode: GraphNode = {
      id: result.file,
      name: this.extractFileName(result.file),
      type: 'file',
      layer: this.detectLayer(result.file),
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
        if (className !== '*' && className.length > 0 && this.findNodeByClassName(className)) {
          localCandidateCount++;
        }
      }
    }

    this.totalImportCount = localCandidateCount;
    this.pendingImports = [];

    // Supplement with type-reference edges (field/param/return types).
    // These cover same-package usage and wildcard imports that couldn't be resolved above.
    for (const { from, ref, edgeType } of this.pendingTypeRefs) {
      const targetId = this.findNodeByClassName(ref.referencedType);
      if (targetId && targetId !== from && !resolvedEdges.has(`${from}→${targetId}`)) {
        this.depGraph.addEdge({ from, to: targetId, type: edgeType, weight: 1 });
        resolvedEdges.add(`${from}→${targetId}`);
      }
    }
    this.pendingTypeRefs = [];
  }

  /**
   * Find a node whose file name (without extension) matches the given class name.
   * Used to resolve same-package / wildcard-import type references.
   */
  private findNodeByClassName(className: string): string | undefined {
    for (const node of this.depGraph.getAllNodes()) {
      const normId = node.id.replace(/\\/g, '/');
      const fileName = normId.substring(normId.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
      if (fileName === className) return node.id;
    }
    return undefined;
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

  /** Find a node whose normalized ID ends with the given suffix. */
  private matchNodeBySuffix(suffix: string): string | undefined {
    const normSuffix = suffix.replace(/\\/g, '/');
    for (const node of this.depGraph.getAllNodes()) {
      const normId = node.id.replace(/\\/g, '/');
      if (normId === normSuffix || normId.endsWith('/' + normSuffix)) {
        return node.id;
      }
    }
    return undefined;
  }

  private extractFileName(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1];
  }

  private detectLayer(filePath: string): string {
    const lower = filePath.toLowerCase();
    if (lower.includes('controller') || lower.includes('resource') || lower.includes('route')) return 'api';
    if (lower.includes('service') || lower.includes('usecase')) return 'service';
    if (lower.includes('repository') || lower.includes('dao')) return 'repository';
    if (lower.includes('model') || lower.includes('entity') || lower.includes('domain')) return 'domain';
    if (lower.includes('dto') || lower.includes('schema') || lower.includes('request') || lower.includes('response')) return 'dto';
    if (lower.includes('util') || lower.includes('helper') || lower.includes('common')) return 'utility';
    if (lower.includes('config') || lower.includes('setting')) return 'config';
    if (lower.includes('test') || lower.includes('spec')) return 'test';
    return 'other';
  }

  private isTestFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.includes('test') || lower.includes('spec') || lower.includes('__tests__');
  }
}
