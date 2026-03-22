/**
 * Module-level dependency graph using adjacency lists.
 * Nodes = modules/files, Edges = import/dependency relationships.
 */

export interface GraphNode {
  id: string;
  name: string;
  type: string;          // 'file' | 'module' | 'package'
  layer: string;         // Detected layer (e.g., 'service', 'controller', 'repository')
  path: string;          // Relative file/directory path
}

export interface GraphEdge {
  from: string;
  to: string;
  type: 'compile' | 'runtime' | 'test';
  weight: number;        // Number of imports/usages
}

export class DependencyGraph {
  private nodes = new Map<string, GraphNode>();
  private outEdges = new Map<string, Map<string, GraphEdge>>(); // from -> { to -> edge }
  private inEdges = new Map<string, Map<string, GraphEdge>>();  // to -> { from -> edge }
  private nodeLookup = new Map<string, GraphNode>();

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
    if (!this.outEdges.has(node.id)) this.outEdges.set(node.id, new Map());
    if (!this.inEdges.has(node.id)) this.inEdges.set(node.id, new Map());
    this.registerNodeLookups(node);
  }

  addEdge(edge: GraphEdge): void {
    // Ensure nodes exist
    if (!this.outEdges.has(edge.from)) this.outEdges.set(edge.from, new Map());
    if (!this.inEdges.has(edge.to)) this.inEdges.set(edge.to, new Map());

    const existing = this.outEdges.get(edge.from)!.get(edge.to);
    if (existing) {
      existing.weight += edge.weight;
    } else {
      this.outEdges.get(edge.from)!.set(edge.to, { ...edge });
      if (!this.inEdges.has(edge.to)) this.inEdges.set(edge.to, new Map());
      this.inEdges.get(edge.to)!.set(edge.from, { ...edge });
    }
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  /** Get direct dependencies OF a node (outgoing edges - what it imports) */
  getDependencies(nodeId: string): GraphEdge[] {
    return [...(this.outEdges.get(nodeId)?.values() ?? [])];
  }

  /** Get direct dependents ON a node (incoming edges - who imports it) */
  getDependents(nodeId: string): GraphEdge[] {
    return [...(this.inEdges.get(nodeId)?.values() ?? [])];
  }

  /** BFS to find all transitive dependents up to maxDepth */
  getTransitiveDependents(nodeId: string, maxDepth: number): Array<{ nodeId: string; via: string[]; depth: number }> {
    const results: Array<{ nodeId: string; via: string[]; depth: number }> = [];
    const visited = new Set<string>([nodeId]);
    const queue: Array<{ id: string; path: string[]; depth: number }> = [{ id: nodeId, path: [], depth: 0 }];
    let head = 0;

    while (head < queue.length) {
      const current = queue[head++]!;
      if (current.depth >= maxDepth) continue;

      const dependents = this.getDependents(current.id);
      for (const edge of dependents) {
        if (!visited.has(edge.from)) {
          visited.add(edge.from);
          const via = [...current.path, current.id];
          results.push({ nodeId: edge.from, via, depth: current.depth + 1 });
          queue.push({ id: edge.from, path: via, depth: current.depth + 1 });
        }
      }
    }

    return results;
  }

  /** BFS to find all transitive dependencies up to maxDepth */
  getTransitiveDependencies(nodeId: string, maxDepth: number): Array<{ nodeId: string; via: string[]; depth: number }> {
    const results: Array<{ nodeId: string; via: string[]; depth: number }> = [];
    const visited = new Set<string>([nodeId]);
    const queue: Array<{ id: string; path: string[]; depth: number }> = [{ id: nodeId, path: [], depth: 0 }];
    let head = 0;

    while (head < queue.length) {
      const current = queue[head++]!;
      if (current.depth >= maxDepth) continue;

      const deps = this.getDependencies(current.id);
      for (const edge of deps) {
        if (!visited.has(edge.to)) {
          visited.add(edge.to);
          const via = [...current.path, current.id];
          results.push({ nodeId: edge.to, via, depth: current.depth + 1 });
          queue.push({ id: edge.to, path: via, depth: current.depth + 1 });
        }
      }
    }

    return results;
  }

  getAllNodes(): GraphNode[] {
    return [...this.nodes.values()];
  }

  getAllEdges(): GraphEdge[] {
    const edges: GraphEdge[] = [];
    for (const edgeMap of this.outEdges.values()) {
      edges.push(...edgeMap.values());
    }
    return edges;
  }

  clear(): void {
    this.nodes.clear();
    this.outEdges.clear();
    this.inEdges.clear();
    this.nodeLookup.clear();
  }

  getInDegree(nodeId: string): number {
    return this.inEdges.get(nodeId)?.size ?? 0;
  }

  getOutDegree(nodeId: string): number {
    return this.outEdges.get(nodeId)?.size ?? 0;
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  get edgeCount(): number {
    let count = 0;
    for (const edgeMap of this.outEdges.values()) {
      count += edgeMap.size;
    }
    return count;
  }

  /** Find node by partial match on id, name, or path - handles backslashes and missing extensions */
  findNode(query: string): GraphNode | undefined {
    if (this.nodes.has(query)) return this.nodes.get(query);

    const normQuery = query.replace(/\\/g, '/');
    const indexed = this.nodeLookup.get(normQuery);
    if (indexed) return indexed;

    for (const node of this.nodes.values()) {
      const normId = node.id.replace(/\\/g, '/');
      const normPath = node.path.replace(/\\/g, '/');
      const basename = normId.split('/').pop() ?? '';

      if (normId === normQuery || normPath === normQuery) return node;
      if (basename === normQuery) return node;

      const baseSansExt = basename.replace(/\.[^.]+$/, '');
      if (baseSansExt === normQuery) return node;

      if (normId.endsWith('/' + normQuery) || normId.endsWith('/' + normQuery + '.java')
        || normId.endsWith('/' + normQuery + '.ts') || normId.endsWith('/' + normQuery + '.tsx')
        || normId.endsWith('/' + normQuery + '.py') || normId.endsWith('/' + normQuery + '.js')) {
        return node;
      }
      if (normPath.endsWith(normQuery)) return node;
    }
    return undefined;
  }

  private registerNodeLookups(node: GraphNode): void {
    const normalizedValues = new Set([
      node.id.replace(/\\/g, '/'),
      node.path.replace(/\\/g, '/'),
      node.name,
    ]);

    for (const value of normalizedValues) {
      this.registerNormalizedVariants(value, node);
    }
  }

  private registerNormalizedVariants(value: string, node: GraphNode): void {
    if (!value) return;

    this.registerLookup(value, node);

    const normalized = value.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    const maxSuffixSegments = Math.min(segments.length, 4);
    let suffix = '';
    for (let i = segments.length - 1; i >= segments.length - maxSuffixSegments; i--) {
      suffix = suffix ? `${segments[i]}/${suffix}` : segments[i];
      this.registerLookup(suffix, node);
      this.registerLookup(this.stripExtension(suffix), node);
    }

    const basename = segments[segments.length - 1] ?? normalized;
    this.registerLookup(basename, node);
    this.registerLookup(this.stripExtension(basename), node);
  }

  private registerLookup(query: string, node: GraphNode): void {
    if (!query || this.nodeLookup.has(query)) return;
    this.nodeLookup.set(query, node);
  }

  private stripExtension(value: string): string {
    return value.replace(/\.[^.\/]+$/, '');
  }
}
