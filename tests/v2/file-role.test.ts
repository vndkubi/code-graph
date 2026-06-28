import { describe, expect, it } from 'vitest';
import { classifyFile } from '../../src/v2/index/file-role.js';

describe('classifyFile role detection', () => {
  it('classifies the JS __tests__/ convention as test_source', () => {
    // Regression: nested `__tests__/` paths were misread as main_source because
    // the surrounding underscores defeat a `.includes('/tests/')` check, letting
    // a test file outrank real implementation and slip past includeTests:false.
    expect(classifyFile('__tests__/evaluation/scoring.ts').role).toBe('test_source');
    expect(classifyFile('src/__tests__/foo.ts').role).toBe('test_source');
    expect(classifyFile('packages/a/__test__/bar.ts').role).toBe('test_source');
  });

  it('classifies conventional test paths and suffixes', () => {
    expect(classifyFile('src/test/Foo.java').role).toBe('test_source');
    expect(classifyFile('tests/foo.ts').role).toBe('test_source');
    expect(classifyFile('src/foo.test.ts').role).toBe('test_source');
    expect(classifyFile('src/foo.spec.ts').role).toBe('test_source');
  });

  it('does not misclassify main source with test-like substrings', () => {
    expect(classifyFile('src/latest/loader.ts').role).toBe('main_source');
    expect(classifyFile('src/contest/engine.ts').role).toBe('main_source');
    expect(classifyFile('src/v2/index/indexer.ts').role).toBe('main_source');
  });

  it('classifies mock/fixture conventions (mock takes precedence over test)', () => {
    expect(classifyFile('src/__mocks__/fs.ts').role).toBe('mock_source');
    expect(classifyFile('test/fixtures/sample.ts').role).toBe('mock_source');
  });
});
