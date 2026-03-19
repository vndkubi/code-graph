import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileIndexer } from '../../src/index/file-indexer.js';
import { findReferences } from '../../src/tools/find-references.js';
import { getDependents } from '../../src/tools/get-dependents.js';
import { getDependencies } from '../../src/tools/get-dependencies.js';
import { getCallChain } from '../../src/tools/get-call-chain.js';
import { getImpactRadius } from '../../src/tools/get-impact-radius.js';
import { findCircularDependencies } from '../../src/tools/find-cycles.js';
import { getModuleGraph } from '../../src/tools/get-module-graph.js';
import { searchSymbol } from '../../src/tools/search-symbol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JAVA_FIXTURE = path.resolve(__dirname, '../fixtures/java-project');

describe('Tools — Java Project', () => {
  let indexer: FileIndexer;

  beforeAll(async () => {
    indexer = new FileIndexer({ rootDir: JAVA_FIXTURE, cacheTtlMs: 60_000 });
    await indexer.ensureIndexed();
  });

  describe('find_references', () => {
    it('should find references to PaymentService', async () => {
      const result = await findReferences({ symbol: 'PaymentService', kind: 'all', contextLines: 2 }, indexer);
      expect(result.references.length).toBeGreaterThan(0);
      expect(result.truncated).toBe(false);
    });

    it('should find import references', async () => {
      const result = await findReferences({ symbol: 'PaymentService', kind: 'import', contextLines: 0 }, indexer);
      expect(result.references.length).toBeGreaterThan(0);
      expect(result.references.every(r => r.kind === 'import')).toBe(true);
    });

    it('should return empty array for non-existent symbol', async () => {
      const result = await findReferences({ symbol: 'NonExistentClass', kind: 'all', contextLines: 0 }, indexer);
      expect(result.references).toEqual([]);
      expect(result.totalCount).toBe(0);
    });

    it('should find definition references', async () => {
      const result = await findReferences({ symbol: 'OrderService', kind: 'definition', contextLines: 0 }, indexer);
      expect(result.references.length).toBeGreaterThan(0);
      expect(result.references.some(r => r.kind === 'definition')).toBe(true);
    });
  });

  describe('search_symbol', () => {
    it('should find OrderService class', async () => {
      const result = await searchSymbol({ query: 'OrderService', kind: 'class', limit: 20 }, indexer);
      expect(result.symbols.length).toBeGreaterThan(0);
      expect(result.symbols[0].name).toBe('OrderService');
      expect(result.symbols[0].kind).toBe('class');
    });

    it('should find methods by regex', async () => {
      const result = await searchSymbol({ query: 'create.*', kind: 'method', limit: 20 }, indexer);
      expect(result.symbols.length).toBeGreaterThan(0);
      expect(result.symbols[0].kind).toBe('method');
    });

    it('should find all symbol kinds', async () => {
      const result = await searchSymbol({ query: '.*', kind: 'all', limit: 100 }, indexer);
      expect(result.symbols.length).toBeGreaterThan(0);
    });

    it('should respect limit', async () => {
      const result = await searchSymbol({ query: '.*', kind: 'all', limit: 2 }, indexer);
      expect(result.symbols.length).toBeLessThanOrEqual(2);
    });

    it('should find interfaces', async () => {
      const result = await searchSymbol({ query: 'PaymentGateway', kind: 'interface', limit: 20 }, indexer);
      expect(result.symbols.length).toBeGreaterThan(0);
      expect(result.symbols[0].kind).toBe('interface');
    });
  });

  describe('get_module_graph', () => {
    it('should return JSON graph', async () => {
      const result = await getModuleGraph({ format: 'json', includeExternal: false }, indexer);
      expect(result).toHaveProperty('nodes');
      expect(result).toHaveProperty('edges');
      expect(result).toHaveProperty('metadata');
      const json = result as { nodes: unknown[]; edges: unknown[]; metadata: { totalNodes: number } };
      expect(json.nodes.length).toBeGreaterThan(0);
    });

    it('should return Mermaid format', async () => {
      const result = await getModuleGraph({ format: 'mermaid', includeExternal: false }, indexer);
      const mermaid = result as { content: string };
      expect(mermaid.content).toContain('graph TD');
    });

    it('should return DOT format', async () => {
      const result = await getModuleGraph({ format: 'dot', includeExternal: false }, indexer);
      const dot = result as { content: string };
      expect(dot.content).toContain('digraph');
    });
  });

  describe('find_circular_dependencies', () => {
    it('should detect cycles or report clean', async () => {
      const result = await findCircularDependencies({ scope: 'files', minCycleLength: 2 }, indexer);
      expect(result).toHaveProperty('totalCycles');
      expect(result).toHaveProperty('clean');
      expect(typeof result.clean).toBe('boolean');
    });
  });

  describe('get_dependents', () => {
    it('should find dependents of a file', async () => {
      const result = await getDependents({ module: 'PaymentService', recursive: false, maxDepth: 3 }, indexer);
      expect(result).toHaveProperty('module');
      expect(result).toHaveProperty('directCount');
    });
  });

  describe('get_dependencies', () => {
    it('should find dependencies of a file', async () => {
      const state = indexer.getState();
      expect(state.ready).toBe(true);
      const result = await getDependencies({ module: 'OrderService', transitive: false, typeFilter: 'all' }, indexer);
      expect(result).toHaveProperty('module');
      expect(result).toHaveProperty('totalCount');
    });
  });

  describe('get_impact_radius', () => {
    it('should compute impact radius', async () => {
      const result = await getImpactRadius({ target: 'PaymentService', changeType: 'any' }, indexer);
      expect(result).toHaveProperty('blastRadius');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('recommendations');
      expect(['high', 'medium', 'low']).toContain(result.blastRadius);
    });
  });

  describe('get_call_chain', () => {
    it('should handle no-path case gracefully', async () => {
      const result = await getCallChain({ from: 'NonExistent', to: 'AlsoNonExistent', maxDepth: 5, allPaths: false }, indexer);
      expect(result.found).toBe(false);
      expect(result.chains).toEqual([]);
      expect(result.message).toBeDefined();
    });
  });
});
