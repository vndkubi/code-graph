import type { DependencyGraph } from './dependency-graph.js';

export interface Cycle {
  id: string;
  modules: string[];
  chain: string;
  severity: 'high' | 'medium' | 'low';
  suggestion: string;
}

/**
 * Detects circular dependencies using Tarjan's SCC algorithm
 * adapted for finding actual cycles in the dependency graph.
 */
export class CycleDetector {
  /**
   * Find all cycles in the graph.
   * Uses DFS-based cycle detection with coloring.
   */
  detectCycles(graph: DependencyGraph, scope: 'modules' | 'files' | 'all' = 'modules', minLength: number = 2): Cycle[] {
    const nodes = graph.getAllNodes().map(n => n.id);
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const stack: string[] = [];

    for (const node of nodes) {
      if (!visited.has(node)) {
        this.dfs(node, graph, visited, inStack, stack, cycles, minLength);
      }
    }

    // Deduplicate cycles (same cycle can be found starting from different nodes)
    const unique = this.deduplicateCycles(cycles);

    return unique.map((cycle, idx) => ({
      id: `cycle-${idx + 1}`,
      modules: cycle,
      chain: cycle.join(' → ') + ' → ' + cycle[0],
      severity: this.assessSeverity(cycle),
      suggestion: this.generateSuggestion(cycle),
    }));
  }

  private dfs(
    node: string,
    graph: DependencyGraph,
    visited: Set<string>,
    inStack: Set<string>,
    stack: string[],
    cycles: string[][],
    minLength: number,
  ): void {
    visited.add(node);
    inStack.add(node);
    stack.push(node);

    const deps = graph.getDependencies(node);
    for (const edge of deps) {
      if (!visited.has(edge.to)) {
        this.dfs(edge.to, graph, visited, inStack, stack, cycles, minLength);
      } else if (inStack.has(edge.to)) {
        // Found a cycle — extract it from stack
        const cycleStart = stack.indexOf(edge.to);
        if (cycleStart >= 0) {
          const cycle = stack.slice(cycleStart);
          if (cycle.length >= minLength) {
            cycles.push([...cycle]);
          }
        }
      }
    }

    stack.pop();
    inStack.delete(node);
  }

  private deduplicateCycles(cycles: string[][]): string[][] {
    const seen = new Set<string>();
    const unique: string[][] = [];

    for (const cycle of cycles) {
      // Normalize: rotate so smallest ID is first
      const minIdx = cycle.indexOf(cycle.reduce((a, b) => a < b ? a : b));
      const normalized = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
      const key = normalized.join('|');

      if (!seen.has(key)) {
        seen.add(key);
        unique.push(normalized);
      }
    }

    return unique;
  }

  private assessSeverity(cycle: string[]): 'high' | 'medium' | 'low' {
    // High: involves shared/domain/core modules
    for (const mod of cycle) {
      const lower = mod.toLowerCase();
      if (lower.includes('shared') || lower.includes('domain') || lower.includes('core') || lower.includes('common')) {
        return 'high';
      }
    }
    // Medium: short cycles
    if (cycle.length <= 3) return 'medium';
    // Low: long or test-only cycles
    return 'low';
  }

  private generateSuggestion(cycle: string[]): string {
    if (cycle.length === 2) {
      return `Extract shared interface between ${cycle[0]} and ${cycle[1]} to break the cycle`;
    }
    if (cycle.length <= 3) {
      return `Consider introducing a mediator or event bus to decouple ${cycle.join(', ')}`;
    }
    return `Long dependency cycle detected. Consider restructuring module boundaries or using dependency inversion`;
  }
}
