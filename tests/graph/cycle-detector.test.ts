import { describe, it, expect } from 'vitest';
import { DependencyGraph } from '../../src/graph/dependency-graph.js';
import { CycleDetector } from '../../src/graph/cycle-detector.js';

describe('CycleDetector', () => {
  it('should detect simple 2-node cycle', () => {
    const graph = new DependencyGraph();
    graph.addNode({ id: 'A', name: 'A', type: 'file', layer: 'service', path: 'A' });
    graph.addNode({ id: 'B', name: 'B', type: 'file', layer: 'service', path: 'B' });
    graph.addEdge({ from: 'A', to: 'B', type: 'compile', weight: 1 });
    graph.addEdge({ from: 'B', to: 'A', type: 'compile', weight: 1 });

    const detector = new CycleDetector();
    const cycles = detector.detectCycles(graph);

    expect(cycles.length).toBe(1);
    expect(cycles[0].modules).toContain('A');
    expect(cycles[0].modules).toContain('B');
    expect(cycles[0].chain).toContain('→');
  });

  it('should detect 3-node cycle', () => {
    const graph = new DependencyGraph();
    graph.addNode({ id: 'A', name: 'A', type: 'file', layer: 'service', path: 'A' });
    graph.addNode({ id: 'B', name: 'B', type: 'file', layer: 'service', path: 'B' });
    graph.addNode({ id: 'C', name: 'C', type: 'file', layer: 'service', path: 'C' });
    graph.addEdge({ from: 'A', to: 'B', type: 'compile', weight: 1 });
    graph.addEdge({ from: 'B', to: 'C', type: 'compile', weight: 1 });
    graph.addEdge({ from: 'C', to: 'A', type: 'compile', weight: 1 });

    const detector = new CycleDetector();
    const cycles = detector.detectCycles(graph);

    expect(cycles.length).toBe(1);
    expect(cycles[0].modules.length).toBe(3);
  });

  it('should report clean when no cycles', () => {
    const graph = new DependencyGraph();
    graph.addNode({ id: 'A', name: 'A', type: 'file', layer: 'service', path: 'A' });
    graph.addNode({ id: 'B', name: 'B', type: 'file', layer: 'service', path: 'B' });
    graph.addEdge({ from: 'A', to: 'B', type: 'compile', weight: 1 });

    const detector = new CycleDetector();
    const cycles = detector.detectCycles(graph);

    expect(cycles.length).toBe(0);
  });

  it('should assign high severity for shared module cycles', () => {
    const graph = new DependencyGraph();
    graph.addNode({ id: 'shared/utils', name: 'utils', type: 'file', layer: 'utility', path: 'shared/utils' });
    graph.addNode({ id: 'service/order', name: 'order', type: 'file', layer: 'service', path: 'service/order' });
    graph.addEdge({ from: 'shared/utils', to: 'service/order', type: 'compile', weight: 1 });
    graph.addEdge({ from: 'service/order', to: 'shared/utils', type: 'compile', weight: 1 });

    const detector = new CycleDetector();
    const cycles = detector.detectCycles(graph);

    expect(cycles.length).toBe(1);
    expect(cycles[0].severity).toBe('high');
  });

  it('should respect minCycleLength', () => {
    const graph = new DependencyGraph();
    graph.addNode({ id: 'A', name: 'A', type: 'file', layer: 'service', path: 'A' });
    graph.addNode({ id: 'B', name: 'B', type: 'file', layer: 'service', path: 'B' });
    graph.addEdge({ from: 'A', to: 'B', type: 'compile', weight: 1 });
    graph.addEdge({ from: 'B', to: 'A', type: 'compile', weight: 1 });

    const detector = new CycleDetector();
    const cycles = detector.detectCycles(graph, 'modules', 3);

    // 2-node cycle should be filtered out when minLength=3
    expect(cycles.length).toBe(0);
  });
});
