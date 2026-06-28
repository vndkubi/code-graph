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

  it('classifies e2e / acceptance test trees as test_source', () => {
    // Regression: e2e helpers (page objects, step definitions) whose names
    // substring-match domain terms (assumeAssimilationPage) were main_source and
    // flooded research seed selection, burying the real implementation.
    expect(classifyFile('e2e_test/start/pageObjects/assimilationPage.ts').role).toBe('test_source');
    expect(classifyFile('e2e_test/start/questionGenerationService.ts').role).toBe('test_source');
    expect(classifyFile('e2e/specs/login.ts').role).toBe('test_source');
    expect(classifyFile('app/step_definitions/recall.ts').role).toBe('test_source');
    expect(classifyFile('cypress/integration/note.ts').role).toBe('test_source');
    expect(classifyFile('packages/doughnut-test-fixtures/builder.ts').role).toBe('test_source');
  });

  it('does not misclassify main source with e2e-like substrings', () => {
    // "core2e" / "page" alone must not trip the e2e/page-object patterns.
    expect(classifyFile('src/core2e/runner.ts').role).toBe('main_source');
    expect(classifyFile('frontend/src/components/NotePage.ts').role).toBe('main_source');
  });

  it('classifies mock/fixture conventions (mock takes precedence over test)', () => {
    expect(classifyFile('src/__mocks__/fs.ts').role).toBe('mock_source');
    expect(classifyFile('test/fixtures/sample.ts').role).toBe('mock_source');
  });
});
