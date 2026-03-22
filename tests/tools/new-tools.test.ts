import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileIndexer } from '../../src/index/file-indexer.js';
import { getCallers } from '../../src/tools/get-callers.js';
import { getCallees } from '../../src/tools/get-callees.js';
import { findEndpoints } from '../../src/tools/find-endpoints.js';
import { getFileSummary } from '../../src/tools/get-file-summary.js';
import { findDeadCode } from '../../src/tools/find-dead-code.js';
import { checkLayerViolations } from '../../src/tools/check-layer-violations.js';
import { getTypeUsage } from '../../src/tools/get-type-usage.js';
import { getIndexStats } from '../../src/tools/get-index-stats.js';
import { findSimilarClasses } from '../../src/tools/find-similar-classes.js';
import { findFieldShadows } from '../../src/tools/find-field-shadows.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JAVA_FIXTURE = path.resolve(__dirname, '../fixtures/java-project');

describe('New Tools — Java Project', () => {
  let indexer: FileIndexer;

  beforeAll(async () => {
    indexer = new FileIndexer({ rootDir: JAVA_FIXTURE, cacheTtlMs: 60_000 });
    await indexer.ensureIndexed();
  });

  describe('get_callers', () => {
    it('should find callers of a method', async () => {
      const result = await getCallers({ symbol: 'createOrder', maxDepth: 1, limit: 50 }, indexer);
      expect(result.found).toBe(true);
    });

    it('should return not found for non-existent symbol', async () => {
      const result = await getCallers({ symbol: 'nonExistentMethod12345', maxDepth: 1, limit: 50 }, indexer);
      expect(result.found).toBe(false);
    });
  });

  describe('get_callees', () => {
    it('should find callees of a method', async () => {
      const result = await getCallees({ symbol: 'createOrder', maxDepth: 1, limit: 50 }, indexer);
      expect(result.found).toBe(true);
    });

    it('should return not found for non-existent symbol', async () => {
      const result = await getCallees({ symbol: 'nonExistentMethod12345', maxDepth: 1, limit: 50 }, indexer);
      expect(result.found).toBe(false);
    });
  });

  describe('find_endpoints', () => {
    it('should return empty when no annotated endpoints exist', async () => {
      // Fixture has no @RestController/@RequestMapping annotations
      const result = await findEndpoints({ method: 'all', limit: 100 }, indexer);
      expect(result).toHaveProperty('endpoints');
      expect(result).toHaveProperty('totalCount');
    });

    it('should not crash when filtering by HTTP method', async () => {
      const result = await findEndpoints({ method: 'POST', limit: 100 }, indexer);
      expect(result).toHaveProperty('endpoints');
    });
  });

  describe('get_file_summary', () => {
    it('should return file summary for OrderService', async () => {
      const result = await getFileSummary({ file: 'OrderService.java' }, indexer);
      expect(result).not.toHaveProperty('error');
      expect((result as any).classes?.length).toBeGreaterThan(0);
      expect((result as any).methods?.length).toBeGreaterThan(0);
    });

    it('should return error for non-existent file', async () => {
      const result = await getFileSummary({ file: 'NonExistent.java' }, indexer);
      expect(result).toHaveProperty('error');
    });
  });

  describe('find_dead_code', () => {
    it('should return results without crashing', async () => {
      const result = await findDeadCode({ kind: 'all', includeTests: false, limit: 100 }, indexer);
      expect(result).toHaveProperty('deadCode');
      expect(result).toHaveProperty('confidence');
    });
  });

  describe('check_layer_violations', () => {
    it('should check default layer rules', async () => {
      const result = await checkLayerViolations({}, indexer);
      expect(result).toHaveProperty('violations');
      expect(result).toHaveProperty('rulesChecked');
      expect(result.rulesChecked).toBeGreaterThan(0);
    });

    it('should accept custom rules', async () => {
      const result = await checkLayerViolations({
        customRules: [{ from: 'domain', forbiddenDeps: ['api'] }],
      }, indexer);
      expect(result.rulesChecked).toBe(1);
    });
  });

  describe('get_type_usage', () => {
    it('should find usage of PaymentService type', async () => {
      const result = await getTypeUsage({ typeName: 'PaymentService', context: 'all', limit: 50 }, indexer);
      expect(result).toHaveProperty('usages');
      expect(result).toHaveProperty('byContext');
    });
  });

  describe('get_index_stats', () => {
    it('should return index statistics', async () => {
      const result = await getIndexStats({ topN: 5 }, indexer);
      expect(result.index.filesIndexed).toBeGreaterThan(0);
      expect(result.index.symbolCount).toBeGreaterThan(0);
      expect(result).toHaveProperty('topDependedOn');
      expect(result).toHaveProperty('layerDistribution');
    });
  });

  describe('find_similar_classes', () => {
    it('should find classes similar to OrderService', async () => {
      const result = await findSimilarClasses({ className: 'OrderService', limit: 20 }, indexer);
      expect(result).not.toHaveProperty('error');
      expect(result).toHaveProperty('reference');
      expect(result).toHaveProperty('similar');
    });

    it('should return error for non-existent class', async () => {
      const result = await findSimilarClasses({ className: 'NonExistentClass', limit: 20 }, indexer);
      expect(result).toHaveProperty('error');
    });
  });

  describe('find_field_shadows', () => {
    it('should detect field shadowing in UserEntity extending BaseEntity', async () => {
      const result = await findFieldShadows({ includeTests: false, limit: 100 }, indexer);
      expect(result.totalFound).toBeGreaterThan(0);

      // Should find "name" field shadow
      const nameShadow = result.shadows.find(s =>
        s.className === 'UserEntity' && s.fieldName === 'name'
      );
      expect(nameShadow).toBeDefined();
      expect(nameShadow!.shadowedFrom).toBe('BaseEntity');
      expect(nameShadow!.severity).toBe('high'); // abstract parent + serialization annotations
    });

    it('should NOT flag AdminEntity (no shadowing)', async () => {
      const result = await findFieldShadows({ className: 'AdminEntity', includeTests: false, limit: 100 }, indexer);
      expect(result.totalFound).toBe(0);
    });

    it('should filter by specific class', async () => {
      const result = await findFieldShadows({ className: 'UserEntity', includeTests: false, limit: 100 }, indexer);
      expect(result.totalFound).toBeGreaterThan(0);
      expect(result.shadows.every(s => s.className === 'UserEntity')).toBe(true);
    });
  });
});
