import { describe, it, expect } from 'vitest';
import { CallGraph } from '../../src/graph/call-graph.js';

describe('CallGraph', () => {
  it('should resolve owner and method suffixes via indexes', () => {
    const graph = new CallGraph();
    graph.addNode({ symbol: 'OrderService.createOrder', file: 'order-service.ts', line: 10 });
    graph.addNode({ symbol: 'OrderController.createOrder', file: 'order-controller.ts', line: 20 });
    graph.addNode({ symbol: 'OrderService.OrderService', file: 'order-service.ts', line: 1 });

    const ownerMatches = graph.resolveAllMatchesWithConfidence('OrderService');
    expect(ownerMatches[0]?.symbol).toBe('OrderService.createOrder');
    expect(ownerMatches.some(match => match.symbol === 'OrderService.OrderService')).toBe(true);

    expect(graph.resolveSymbol('service.createOrder')).toBe('OrderService.createOrder');
    expect(graph.resolveSymbol('createOrder')).toBe('OrderService.createOrder');
  });

  it('should clear nodes and lookup indexes together', () => {
    const graph = new CallGraph();
    graph.addNode({ symbol: 'OrderService.createOrder', file: 'order-service.ts', line: 10 });

    graph.clear();

    expect(graph.nodeCount).toBe(0);
    expect(graph.resolveSymbol('createOrder')).toBeUndefined();
  });
});
