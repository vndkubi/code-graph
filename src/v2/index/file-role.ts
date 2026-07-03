import path from 'node:path';
import { detectLanguage, type SupportedLanguage } from '../../analyzers/language-detector.js';

export type FileRole =
  | 'main_source'
  | 'test_source'
  | 'mock_source'
  | 'generated'
  | 'vendored'
  | 'build_config'
  | 'resource_config'
  | 'external_stub';

export interface FileClassification {
  role: FileRole;
  language?: SupportedLanguage;
  indexable: boolean;
  parseable: boolean;
}

const BUILD_CONFIG_FILES = new Set([
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'gradle.properties',
]);

const RESOURCE_EXTENSIONS = new Set(['.xml', '.yaml', '.yml', '.properties', '.json']);

export function classifyFile(relPath: string): FileClassification {
  const normalized = relPath.replace(/\\/g, '/');
  const lower = normalized.toLowerCase();
  const basename = path.posix.basename(lower);
  const ext = path.posix.extname(lower);
  const language = detectLanguage(normalized);

  if (isVendored(lower)) {
    return { role: 'vendored', language, indexable: false, parseable: false };
  }
  if (isGenerated(lower)) {
    return { role: 'generated', language, indexable: true, parseable: Boolean(language) };
  }
  if (BUILD_CONFIG_FILES.has(basename)) {
    return { role: 'build_config', language, indexable: true, parseable: Boolean(language) };
  }
  if (RESOURCE_EXTENSIONS.has(ext)) {
    return { role: 'resource_config', language, indexable: true, parseable: Boolean(language) };
  }
  if (!language) {
    return { role: 'resource_config', indexable: false, parseable: false };
  }
  if (isMock(lower)) {
    return { role: 'mock_source', language, indexable: true, parseable: true };
  }
  if (isTest(lower)) {
    return { role: 'test_source', language, indexable: true, parseable: true };
  }
  return { role: 'main_source', language, indexable: true, parseable: true };
}

export function roleRank(role: FileRole): number {
  switch (role) {
    case 'main_source': return 100;
    case 'resource_config': return 80;
    case 'build_config': return 75;
    case 'test_source': return 60;
    case 'mock_source': return 45;
    case 'generated': return 30;
    case 'external_stub': return 20;
    case 'vendored': return 5;
  }
}

function isVendored(lowerPath: string): boolean {
  return lowerPath.includes('/vendor/')
    || lowerPath.includes('/node_modules/')
    || lowerPath.includes('/third_party/')
    || lowerPath.includes('/.m2/')
    || lowerPath.includes('/target/')
    || lowerPath.includes('/build/')
    || lowerPath.includes('/dist/');
}

function isGenerated(lowerPath: string): boolean {
  // Segment-aware with optional prefix/suffix so machine-output trees like
  // `proto2-generated/`, `generated-sources/`, or `target_generated/` all
  // match. A separator is required before "generated" to avoid false hits on
  // words that merely contain it.
  return /(^|\/)([^/]*[-_.])?generated([-_.][^/]*)?(\/|$)/.test(lowerPath)
    || lowerPath.endsWith('.g.java');
}

function isTest(lowerPath: string): boolean {
  // Segment-aware so the JS `__tests__/` convention is caught — its surrounding
  // underscores mean a plain `.includes('/tests/')` misses it, which let a file
  // like `__tests__/evaluation/scoring.ts` masquerade as main_source and slip
  // past `includeTests:false`. The boundary `(^|/)...(/|$)` also avoids false
  // hits on segments like `latest/`.
  return /(^|\/)(__tests__|__test__|test|tests|spec|specs)(\/|$)/.test(lowerPath)
    || lowerPath.includes('/src/test/')
    // End-to-end / acceptance test conventions. These live OUTSIDE the unit-test
    // dirs above and use compound segment names that the strict-segment regex
    // misses (`e2e_test/`, not `test/`). Without this, an entire e2e tree of page
    // objects, step definitions, and fixtures (often hundreds of files in a
    // polyglot repo) is classified main_source — e2e helpers whose names
    // substring-match domain terms (assumeAssimilationPage) then flood research
    // seed selection and bury the real implementation.
    || /(^|\/)(e2e|e2e_test|e2e_tests|e2e-test|e2e-tests|e2etest|e2etests)(\/|$)/.test(lowerPath)
    || /(^|\/)(step_definitions|step-definitions|pageobjects|page_objects|page-objects)(\/|$)/.test(lowerPath)
    || /(^|\/)(cypress|playwright|integration_test|integration-tests?)(\/|$)/.test(lowerPath)
    || /test[-_]fixtures?(\/|$)/.test(lowerPath)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(lowerPath)
    || lowerPath.endsWith('test.java')
    || lowerPath.endsWith('tests.java')
    || lowerPath.endsWith('spec.ts')
    || lowerPath.endsWith('test.ts');
}

function isMock(lowerPath: string): boolean {
  return /(^|\/)(__mocks__|mock|mocks|fixtures|testdata|stub|stubs)(\/|$)/.test(lowerPath);
}
