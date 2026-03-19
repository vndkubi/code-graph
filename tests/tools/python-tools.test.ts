import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileIndexer } from '../../src/index/file-indexer.js';
import { findReferences } from '../../src/tools/find-references.js';
import { searchSymbol } from '../../src/tools/search-symbol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_FIXTURE = path.resolve(__dirname, '../fixtures/python-project');

describe('Tools — Python Project', () => {
  let indexer: FileIndexer;

  beforeAll(async () => {
    indexer = new FileIndexer({ rootDir: PYTHON_FIXTURE, cacheTtlMs: 60_000 });
    await indexer.ensureIndexed();
  });

  describe('search_symbol', () => {
    it('should find OrderService class', async () => {
      const result = await searchSymbol({ query: 'OrderService', kind: 'class', limit: 20 }, indexer);
      expect(result.symbols.length).toBeGreaterThan(0);
      expect(result.symbols[0].name).toBe('OrderService');
    });

    it('should find Python functions', async () => {
      const result = await searchSymbol({ query: 'create_order', kind: 'all', limit: 20 }, indexer);
      expect(result.symbols.length).toBeGreaterThan(0);
    });

    it('should find classes across files', async () => {
      const result = await searchSymbol({ query: '.*Service', kind: 'class', limit: 20 }, indexer);
      expect(result.symbols.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('find_references', () => {
    it('should find references to PaymentService', async () => {
      const result = await findReferences({ symbol: 'PaymentService', kind: 'all', contextLines: 1 }, indexer);
      expect(result.references.length).toBeGreaterThan(0);
    });

    it('should return empty for non-existent symbol', async () => {
      const result = await findReferences({ symbol: 'DoesNotExist', kind: 'all', contextLines: 0 }, indexer);
      expect(result.references).toEqual([]);
    });
  });

  describe('index state', () => {
    it('should have indexed all Python files', () => {
      const state = indexer.getState();
      expect(state.ready).toBe(true);
      expect(state.filesIndexed).toBe(4);
      expect(state.symbolCount).toBeGreaterThan(0);
    });
  });
});
