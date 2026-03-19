import { describe, it, expect } from 'vitest';
import { DependencyGraph } from '../../src/graph/dependency-graph.js';

describe('DependencyGraph', () => {
  it('should add and retrieve nodes', () => {
    const graph = new DependencyGraph();
    graph.addNode({ id: 'a', name: 'A', type: 'file', layer: 'service', path: 'a.ts' });
    expect(graph.getNode('a')).toBeDefined();
    expect(graph.nodeCount).toBe(1);
  });

  it('should add edges and track in/out degree', () => {
    const graph = new DependencyGraph();
    graph.addNode({ id: 'a', name: 'A', type: 'file', layer: 'service', path: 'a.ts' });
    graph.addNode({ id: 'b', name: 'B', type: 'file', layer: 'service', path: 'b.ts' });
    graph.addEdge({ from: 'a', to: 'b', type: 'compile', weight: 1 });

    expect(graph.getOutDegree('a')).toBe(1);
    expect(graph.getInDegree('b')).toBe(1);
    expect(graph.edgeCount).toBe(1);
  });

  it('should merge duplicate edges by adding weight', () => {
    const graph = new DependencyGraph();
    graph.addNode({ id: 'a', name: 'A', type: 'file', layer: 'service', path: 'a.ts' });
    graph.addNode({ id: 'b', name: 'B', type: 'file', layer: 'service', path: 'b.ts' });
    graph.addEdge({ from: 'a', to: 'b', type: 'compile', weight: 1 });
    graph.addEdge({ from: 'a', to: 'b', type: 'compile', weight: 2 });

    const deps = graph.getDependencies('a');
    expect(deps.length).toBe(1);
    expect(deps[0].weight).toBe(3);
  });

  it('should find transitive dependents via BFS', () => {
    const graph = new DependencyGraph();
    graph.addNode({ id: 'a', name: 'A', type: 'file', layer: 'service', path: 'a.ts' });
    graph.addNode({ id: 'b', name: 'B', type: 'file', layer: 'service', path: 'b.ts' });
    graph.addNode({ id: 'c', name: 'C', type: 'file', layer: 'api', path: 'c.ts' });
    graph.addEdge({ from: 'b', to: 'a', type: 'compile', weight: 1 });
    graph.addEdge({ from: 'c', to: 'b', type: 'compile', weight: 1 });

    const transitive = graph.getTransitiveDependents('a', 5);
    expect(transitive.length).toBe(2);
    expect(transitive.map(t => t.nodeId)).toContain('b');
    expect(transitive.map(t => t.nodeId)).toContain('c');
  });

  it('should respect maxDepth in BFS', () => {
    const graph = new DependencyGraph();
    graph.addNode({ id: 'a', name: 'A', type: 'file', layer: 'service', path: 'a.ts' });
    graph.addNode({ id: 'b', name: 'B', type: 'file', layer: 'service', path: 'b.ts' });
    graph.addNode({ id: 'c', name: 'C', type: 'file', layer: 'api', path: 'c.ts' });
    graph.addEdge({ from: 'b', to: 'a', type: 'compile', weight: 1 });
    graph.addEdge({ from: 'c', to: 'b', type: 'compile', weight: 1 });

    const transitive = graph.getTransitiveDependents('a', 1);
    expect(transitive.length).toBe(1);
    expect(transitive[0].nodeId).toBe('b');
  });

  it('should find node by partial match', () => {
    const graph = new DependencyGraph();
    graph.addNode({ id: 'src/services/order.ts', name: 'order.ts', type: 'file', layer: 'service', path: 'src/services/order.ts' });

    expect(graph.findNode('order.ts')).toBeDefined();
    expect(graph.findNode('src/services/order.ts')).toBeDefined();
  });
});
