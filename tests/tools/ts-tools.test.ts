import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileIndexer } from '../../src/index/file-indexer.js';
import { findReferences } from '../../src/tools/find-references.js';
import { searchSymbol } from '../../src/tools/search-symbol.js';
import { getModuleGraph } from '../../src/tools/get-module-graph.js';
import { getDependencies } from '../../src/tools/get-dependencies.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TS_FIXTURE = path.resolve(__dirname, '../fixtures/ts-project');

describe('Tools — TypeScript Project', () => {
  let indexer: FileIndexer;

  beforeAll(async () => {
    indexer = new FileIndexer({ rootDir: TS_FIXTURE, cacheTtlMs: 60_000 });
    await indexer.ensureIndexed();
  });

  describe('search_symbol', () => {
    it('should find OrderController class', async () => {
      const result = await searchSymbol({ query: 'OrderController', kind: 'class', limit: 20 }, indexer);
      expect(result.symbols.length).toBeGreaterThan(0);
      expect(result.symbols[0].name).toBe('OrderController');
    });

    it('should find functions and methods', async () => {
      const result = await searchSymbol({ query: 'create.*', kind: 'all', limit: 20 }, indexer);
      expect(result.symbols.length).toBeGreaterThan(0);
    });

    it('should find interfaces', async () => {
      const result = await searchSymbol({ query: 'CreateOrderRequest', kind: 'interface', limit: 20 }, indexer);
      expect(result.symbols.length).toBeGreaterThan(0);
    });
  });

  describe('find_references', () => {
    it('should find references to PaymentService', async () => {
      const result = await findReferences({ symbol: 'PaymentService', kind: 'all', contextLines: 1 }, indexer);
      expect(result.references.length).toBeGreaterThan(0);
    });

    it('should find import references', async () => {
      const result = await findReferences({ symbol: 'payment-service', kind: 'import', contextLines: 0 }, indexer);
      expect(result.references.length).toBeGreaterThan(0);
    });
  });

  describe('get_module_graph', () => {
    it('should return graph with nodes', async () => {
      const result = await getModuleGraph({ format: 'json', includeExternal: false }, indexer);
      const json = result as { nodes: unknown[]; metadata: { totalNodes: number } };
      expect(json.nodes.length).toBeGreaterThan(0);
      expect(json.metadata.totalNodes).toBeGreaterThan(0);
    });
  });

  describe('get_dependencies', () => {
    it('should find dependencies', async () => {
      const graph = indexer.getDependencyGraph();
      const nodes = graph.getAllNodes();
      if (nodes.length > 0) {
        const result = await getDependencies({ module: nodes[0].id, transitive: false, typeFilter: 'all' }, indexer);
        expect(result).toHaveProperty('totalCount');
      }
    });
  });
});
