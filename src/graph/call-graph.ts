/**
 * Function-level call graph for tracing call chains.
 * Nodes = "ClassName.methodName" or "functionName"
 * Edges = "caller calls callee"
 */

export type SymbolMatchType = 'exact' | 'suffix' | 'method-part' | 'contains';

/** Confidence score for a symbol resolution: exact=1.0, suffix=0.85, method-part=0.65, contains=0.5 */
export const MATCH_CONFIDENCE: Record<SymbolMatchType, number> = {
  exact: 1.0,
  suffix: 0.85,
  'method-part': 0.65,
  contains: 0.5,
};

export interface ResolvedSymbol {
  symbol: string;
  matchType: SymbolMatchType;
  confidence: number;
}

export interface CallGraphNode {
  symbol: string;   // "ClassName.methodName"
  file: string;     // Relative path
  line: number;
}

export interface CallGraphEdge {
  from: string;     // Caller symbol
  to: string;       // Callee symbol
  file: string;     // File where the call occurs
  line: number;
}

/** True if "ClassName.ClassName" — i.e. a constructor entry in the call graph. */
function isConstructorSymbol(symbol: string): boolean {
  const dot = symbol.lastIndexOf('.');
  if (dot === -1) return false;
  return symbol.substring(dot + 1) === symbol.substring(0, dot).split('.').pop();
}

export class CallGraph {
  private nodes = new Map<string, CallGraphNode>();
  private outEdges = new Map<string, CallGraphEdge[]>();  // caller → [callees]
  private inEdges = new Map<string, CallGraphEdge[]>();   // callee → [callers]

  addNode(node: CallGraphNode): void {
    this.nodes.set(node.symbol, node);
  }

  addEdge(edge: CallGraphEdge): void {
    if (!this.outEdges.has(edge.from)) this.outEdges.set(edge.from, []);
    if (!this.inEdges.has(edge.to)) this.inEdges.set(edge.to, []);
    this.outEdges.get(edge.from)!.push(edge);
    this.inEdges.get(edge.to)!.push(edge);
  }

  getNode(symbol: string): CallGraphNode | undefined {
    return this.nodes.get(symbol);
  }

  /** Who does this function call? */
  getCallees(symbol: string): CallGraphEdge[] {
    return this.outEdges.get(symbol) ?? [];
  }

  /** Who calls this function? */
  getCallers(symbol: string): CallGraphEdge[] {
    return this.inEdges.get(symbol) ?? [];
  }

  /**
   * BFS to find shortest call chain from → to.
   * Returns all paths if allPaths=true, up to maxDepth.
   * Each result includes a `confidence` score (0–1) reflecting how reliable
   * the symbol resolutions are (exact matches score higher than fuzzy).
   */
  findCallChain(
    from: string,
    to: string,
    maxDepth: number,
    allPaths: boolean,
  ): Array<{ path: CallGraphNode[]; depth: number; isShortest: boolean; confidence: number; resolutionNotes: string[] }> {
    const startMatches = this.resolveAllMatchesWithConfidence(from);
    const targetMatches = this.resolveAllMatchesWithConfidence(to);
    const targetSet = new Map(targetMatches.map(m => [m.symbol, m]));

    if (startMatches.length === 0 || targetSet.size === 0) return [];

    // Track min confidence of start/end resolution to propagate into chain confidence
    const startConfidence = Math.min(...startMatches.map(m => m.confidence));
    const targetConfidence = Math.min(...targetMatches.map(m => m.confidence));

    const resolutionNotes: string[] = [];
    if (startMatches[0].matchType !== 'exact') {
      resolutionNotes.push(`"${from}" resolved via ${startMatches[0].matchType} match to "${startMatches[0].symbol}"`);
    }
    if (targetMatches[0].matchType !== 'exact') {
      resolutionNotes.push(`"${to}" resolved via ${targetMatches[0].matchType} match to "${targetMatches[0].symbol}"`);
    }

    const results: Array<{ path: CallGraphNode[]; depth: number; isShortest: boolean; confidence: number; resolutionNotes: string[] }> = [];
    let shortestDepth = Infinity;

    // BFS from all start nodes simultaneously
    const queue: Array<{ symbol: string; path: string[] }> = startMatches.map(m => ({ symbol: m.symbol, path: [m.symbol] }));
    const visited = allPaths ? undefined : new Set<string>(startMatches.map(m => m.symbol));

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.path.length - 1 > maxDepth) continue;

      if (targetSet.has(current.symbol) && current.path.length > 1) {
        const depth = current.path.length - 1;
        const isShortest = depth <= shortestDepth;
        if (isShortest) shortestDepth = depth;

        // Chain confidence = endpoint resolutions × small depth penalty
        const depthPenalty = depth > 3 ? 0.05 * (depth - 3) : 0;
        const chainConfidence = Math.max(0.1, startConfidence * targetConfidence - depthPenalty);

        results.push({
          path: current.path.map(s => this.nodes.get(s) ?? { symbol: s, file: '', line: 0 }),
          depth,
          isShortest,
          confidence: chainConfidence,
          resolutionNotes: [...resolutionNotes],
        });

        if (!allPaths) return results; // Only need shortest
        continue;
      }

      const callees = this.getCallees(current.symbol);
      for (const edge of callees) {
        // Resolve raw callee (may be "methodName" or "var.methodName") to registered symbol
        const resolved = this.resolveSymbol(edge.to) ?? edge.to;

        if (!allPaths && visited?.has(resolved)) continue;
        if (current.path.includes(resolved)) continue; // Prevent cycles

        if (!allPaths) visited?.add(resolved);
        queue.push({ symbol: resolved, path: [...current.path, resolved] });
      }
    }

    return results;
  }

  /** Resolve all registered symbols matching name, with confidence scores */
  resolveAllMatchesWithConfidence(name: string): ResolvedSymbol[] {
    if (this.nodes.has(name)) {
      return [{ symbol: name, matchType: 'exact', confidence: MATCH_CONFIDENCE.exact }];
    }

    const results: ResolvedSymbol[] = [];

    // Suffix match: class prefix "OrderController" → "OrderController.create"
    // or method suffix "createOrder" → "OrderService.createOrder"
    for (const key of this.nodes.keys()) {
      if (key.startsWith(name + '.') || key.endsWith('.' + name)) {
        results.push({ symbol: key, matchType: 'suffix', confidence: MATCH_CONFIDENCE.suffix });
      }
    }
    if (results.length > 0) {
      // De-prioritize constructor matches (ClassName.ClassName) — put real methods first
      // so resolution notes and BFS start nodes favour actual behaviour over boilerplate.
      return results.sort((a, b) => {
        const aIsConstructor = isConstructorSymbol(a.symbol);
        const bIsConstructor = isConstructorSymbol(b.symbol);
        if (aIsConstructor === bIsConstructor) return 0;
        return aIsConstructor ? 1 : -1;  // constructors go last
      });
    }

    // Method-part match: "var.save" → try just "save" part
    if (name.includes('.')) {
      const methodPart = name.substring(name.lastIndexOf('.') + 1);
      for (const key of this.nodes.keys()) {
        if (key.endsWith('.' + methodPart)) {
          results.push({ symbol: key, matchType: 'method-part', confidence: MATCH_CONFIDENCE['method-part'] });
        }
      }
      if (results.length > 0) return results;
    }

    // Contains fallback
    for (const key of this.nodes.keys()) {
      if (key.includes(name)) {
        results.push({ symbol: key, matchType: 'contains', confidence: MATCH_CONFIDENCE.contains });
      }
    }
    return results;
  }

  /** Resolve all registered symbols matching name (exact, suffix, or contains) */
  resolveAllMatches(name: string): string[] {
    return this.resolveAllMatchesWithConfidence(name).map((r: ResolvedSymbol) => r.symbol);
  }

  /** Resolve partial symbol name to the FIRST matching registered key */
  resolveSymbol(name: string): string | undefined {
    if (this.nodes.has(name)) return name;

    // Exact suffix match: "createOrder" → "OrderService.createOrder"
    for (const key of this.nodes.keys()) {
      if (key.endsWith('.' + name) || key === name) return key;
    }

    // If "var.method", try just the method part
    if (name.includes('.')) {
      const methodPart = name.substring(name.lastIndexOf('.') + 1);
      for (const key of this.nodes.keys()) {
        if (key.endsWith('.' + methodPart)) return key;
      }
    }

    // Contains fallback
    for (const key of this.nodes.keys()) {
      if (key.includes(name)) return key;
    }

    return undefined;
  }

  getAllNodes(): CallGraphNode[] {
    return [...this.nodes.values()];
  }

  get nodeCount(): number {
    return this.nodes.size;
  }
}
