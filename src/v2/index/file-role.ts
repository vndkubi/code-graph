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
  return lowerPath.includes('/generated/')
    || lowerPath.includes('/generated-sources/')
    || lowerPath.includes('/build/generated/')
    || lowerPath.endsWith('.g.java');
}

function isTest(lowerPath: string): boolean {
  return lowerPath.includes('/src/test/')
    || lowerPath.includes('/test/')
    || lowerPath.includes('/tests/')
    || lowerPath.endsWith('test.java')
    || lowerPath.endsWith('tests.java')
    || lowerPath.endsWith('spec.ts')
    || lowerPath.endsWith('test.ts');
}

function isMock(lowerPath: string): boolean {
  return lowerPath.includes('/mock/')
    || lowerPath.includes('/mocks/')
    || lowerPath.includes('/fixtures/')
    || lowerPath.includes('/testdata/')
    || lowerPath.includes('/stub/')
    || lowerPath.includes('/stubs/');
}
