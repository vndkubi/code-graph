import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ONBOARD_BEGIN_MARKER,
  ONBOARD_END_MARKER,
  applyGeneratedBlock,
  buildComponentStats,
  buildDirectoryStats,
  componentForPath,
  composeArchitectureMarkdown,
  composeClaudeMarkdown,
  composeCopilotMarkdown,
  detectBuildCommands,
  normalizeOnboardProfile,
} from '../../src/v2/query/onboard.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-onboard-'));
  tempDirs.push(dir);
  return dir;
}

describe('applyGeneratedBlock', () => {
  it('creates a fresh document from just the block', () => {
    const result = applyGeneratedBlock(undefined, 'BODY');
    expect(result).toBe(`${ONBOARD_BEGIN_MARKER}\nBODY\n${ONBOARD_END_MARKER}\n`);
  });

  it('appends the block once to a file without markers', () => {
    const result = applyGeneratedBlock('# Hand notes\n', 'BODY');
    expect(result.startsWith('# Hand notes')).toBe(true);
    expect(result).toContain(`${ONBOARD_BEGIN_MARKER}\nBODY\n${ONBOARD_END_MARKER}`);
  });

  it('replaces only the marked block and preserves surrounding content', () => {
    const existing = `above\n${ONBOARD_BEGIN_MARKER}\nOLD\n${ONBOARD_END_MARKER}\nbelow\n`;
    const result = applyGeneratedBlock(existing, 'NEW');
    expect(result).toContain('above');
    expect(result).toContain('below');
    expect(result).toContain('NEW');
    expect(result).not.toContain('OLD');
    expect((result.match(/codegraph:begin/g) ?? []).length).toBe(1);
  });

  it('is idempotent: applying the same body twice yields the same document', () => {
    const once = applyGeneratedBlock('# notes\n', 'BODY');
    const twice = applyGeneratedBlock(once, 'BODY');
    expect(twice).toBe(once);
  });

  it('throws on a lone marker instead of guessing', () => {
    expect(() => applyGeneratedBlock(`x\n${ONBOARD_BEGIN_MARKER}\ny`, 'BODY')).toThrow(/lone or out-of-order/);
    expect(() => applyGeneratedBlock(`${ONBOARD_END_MARKER}\n${ONBOARD_BEGIN_MARKER}`, 'BODY')).toThrow(/lone or out-of-order/);
  });
});

describe('buildDirectoryStats', () => {
  it('groups main/test files by directory and drops tiny groups', () => {
    const files = [
      { path: 'src/service/A.java', file_role: 'main_source' },
      { path: 'src/service/B.java', file_role: 'main_source' },
      { path: 'src/service/C.java', file_role: 'main_source' },
      { path: 'src/test/ATest.java', file_role: 'test_source' },
      { path: 'src/lonely/X.java', file_role: 'main_source' },
      { path: 'pom.xml', file_role: 'build_config' },
    ];
    const stats = buildDirectoryStats(files, 3);
    expect(stats).toEqual([{ dir: 'src/service', mainFiles: 3, testFiles: 0 }]);
  });
});

describe('componentForPath / buildComponentStats', () => {
  it('maps paths to top-level components, expanding monorepo containers', () => {
    expect(componentForPath('backend/src/main/java/A.java')).toBe('backend');
    expect(componentForPath('packages/ui/src/index.ts')).toBe('packages/ui');
    expect(componentForPath('.github/workflows/ci.yml')).toBeUndefined();
    expect(componentForPath('README.md')).toBeUndefined();
  });

  it('drops layout dirs (src, test-only trees) but keeps test trees with main sources', () => {
    const files = [
      { path: 'src/a.ts', file_role: 'main_source', language: 'typescript' },
      { path: 'src/b.ts', file_role: 'main_source', language: 'typescript' },
      { path: 'src/c.ts', file_role: 'main_source', language: 'typescript' },
      { path: 'tests/a.test.ts', file_role: 'test_source', language: 'typescript' },
      { path: 'tests/b.test.ts', file_role: 'test_source', language: 'typescript' },
      { path: 'tests/c.test.ts', file_role: 'test_source', language: 'typescript' },
      { path: 'test/framework/F.java', file_role: 'main_source', language: 'java' },
      { path: 'test/framework/G.java', file_role: 'main_source', language: 'java' },
      { path: 'test/framework/H.java', file_role: 'main_source', language: 'java' },
    ];
    const stats = buildComponentStats(files, [], 3);
    expect(stats.map(s => s.component)).toEqual(['test']);
  });

  it('aggregates components with language mix and endpoint counts', () => {
    const files = [
      { path: 'backend/src/A.java', file_role: 'main_source', language: 'java' },
      { path: 'backend/src/B.java', file_role: 'main_source', language: 'java' },
      { path: 'backend/src/ATest.java', file_role: 'test_source', language: 'java' },
      { path: 'backend/config.yaml', file_role: 'main_source', language: 'yaml' },
      { path: 'frontend/src/a.ts', file_role: 'main_source', language: 'typescript' },
      { path: 'frontend/src/b.ts', file_role: 'main_source', language: 'typescript' },
      { path: 'frontend/src/a.spec.ts', file_role: 'test_source', language: 'typescript' },
    ];
    const stats = buildComponentStats(files, ['backend/src/A.java'], 3);
    expect(stats).toEqual([
      { component: 'backend', mainFiles: 3, testFiles: 1, endpoints: 1, languages: ['java'] },
      { component: 'frontend', mainFiles: 2, testFiles: 1, endpoints: 0, languages: ['typescript'] },
    ]);
  });
});

describe('component-aware composers', () => {
  const componentInputs = {
    ...FIXTURE_INPUTS,
    components: [
      { component: 'backend', mainFiles: 10, testFiles: 5, endpoints: 2, languages: ['java'] },
      { component: 'frontend', mainFiles: 8, testFiles: 3, endpoints: 0, languages: ['typescript'] },
    ],
  };

  it('renders a Components table in ARCHITECTURE.md for multi-component repos', () => {
    const doc = composeArchitectureMarkdown(componentInputs);
    expect(doc).toContain('## Components');
    expect(doc).toContain('| `backend` | java | 10 | 5 | 2 |');
    expect(doc).toContain('| `frontend` | typescript | 8 | 3 | — |');
  });

  it('omits the Components section for single-component repos', () => {
    expect(composeArchitectureMarkdown(FIXTURE_INPUTS)).not.toContain('## Components');
  });

  it('attributes endpoints to their component in the CLAUDE.md one-liner', () => {
    const doc = composeClaudeMarkdown(componentInputs);
    expect(doc).toContain('2 spring endpoints (in `backend`)');
    expect(doc).toContain('- `backend` — java, 10 main / 5 test files, 2 endpoints');
  });

  it('labels a polyglot repo with both top code languages', () => {
    const atlas = JSON.parse(JSON.stringify(FIXTURE_ATLAS)) as Record<string, any>;
    atlas.summary.languages = [
      { language: 'typescript', files: 616 },
      { language: 'java', files: 531 },
      { language: 'json', files: 900 },
    ];
    const doc = composeClaudeMarkdown({ ...componentInputs, atlas });
    expect(doc).toContain('typescript + java codebase');
  });
});

describe('detectBuildCommands', () => {
  it('detects maven with wrapper', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'pom.xml'), '<project/>');
    fs.writeFileSync(path.join(root, 'mvnw'), '#!/bin/sh');
    const commands = detectBuildCommands(root);
    expect(commands.build).toContain('./mvnw -ntp verify');
    expect(commands.test).toContain('./mvnw -ntp test');
    expect(commands.sources[0]).toContain('mvnw wrapper');
  });

  it('scans component dirs so a backend gradle is not shadowed by a root package.json', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    fs.mkdirSync(path.join(root, 'backend'));
    fs.writeFileSync(path.join(root, 'backend', 'build.gradle'), '');
    fs.writeFileSync(path.join(root, 'backend', 'gradlew'), '#!/bin/sh');
    const commands = detectBuildCommands(root, ['backend', 'missing-dir']);
    expect(commands.test).toContain('npm test');
    expect(commands.test).toContain('cd backend && ./gradlew test');
    expect(commands.sources).toContain('backend/build.gradle + gradlew wrapper');
  });

  it('detects npm scripts', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', test: 'vitest', lint: 'eslint .' } }));
    const commands = detectBuildCommands(root);
    expect(commands.build).toContain('npm run build');
    expect(commands.test).toContain('npm test');
    expect(commands.lint).toContain('npm run lint');
  });

  it('returns empty commands when nothing is detected', () => {
    const commands = detectBuildCommands(tempDir());
    expect(commands.sources).toHaveLength(0);
  });
});

const FIXTURE_ATLAS: Record<string, unknown> = {
  snapshot: { root: 'D:/repo', branch: 'main', headCommit: 'abc1234567890' },
  summary: {
    counts: { files: 20, symbols: 300, dependencyEdges: 40, callEdgesPrimary: 500, endpoints: 2 },
    languages: [{ language: 'java', files: 18 }, { language: 'yaml', files: 2 }],
    fileRoles: [
      { fileRole: 'main_source', count: 12 },
      { fileRole: 'test_source', count: 6 },
    ],
    health: { parseFailureCount: 0, endpointWarningCount: 0, overlayAvailable: false },
  },
  architecture: {
    entrypoints: [
      { method: 'POST', path: '/api/orders', handlerSymbol: 'com.x.OrderResource.create(OrderDTO)', file: 'src/OrderResource.java', line: 10, framework: 'spring', confidence: 0.85 },
      { method: 'GET', path: '/api/orders', handlerSymbol: 'com.x.OrderResource.list()', file: 'src/OrderResource.java', line: 20, framework: 'spring', confidence: 0.85 },
    ],
  },
  featureMap: {
    flows: [
      {
        id: 'POST /api/orders',
        name: 'POST /orders via OrderResource.create(OrderDTO)',
        entrypoint: { file: 'src/OrderResource.java', line: 10, confidence: 0.85 },
        callGraph: [{ callee: 'OrderService.place' }, { callee: 'OrderRepository.save' }],
        likelyTests: [
          { file: 'src/test/HelperConfig.java' },
          { file: 'src/test/OrderResourceIT.java' },
          { file: 'src/test/UnrelatedThingTest.java' },
        ],
      },
      {
        id: 'GET /api/orders',
        name: 'GET /orders via OrderResource.list()',
        entrypoint: { file: 'src/OrderResource.java', line: 20, confidence: 0.85 },
        callGraph: [{ callee: 'OrderService.list' }],
        likelyTests: [],
      },
      {
        id: 'low',
        name: 'low-confidence flow',
        entrypoint: { file: 'src/Other.java', line: 1, confidence: 0.4 },
        callGraph: [],
        likelyTests: [],
      },
    ],
  },
  changePlaybook: {
    hotspots: [
      { file: 'src/test/BigIT.java', fileRole: 'test_source', riskLevel: 'high', why: ['500 call edges'] },
      { file: 'src/OrderService.java', fileRole: 'main_source', riskLevel: 'high', why: ['8 dependent file edge(s)'] },
    ],
  },
};

const FIXTURE_INPUTS = {
  atlas: FIXTURE_ATLAS,
  directories: [{ dir: 'src', mainFiles: 12, testFiles: 0 }],
  components: [],
  commands: { build: ['./mvnw -ntp verify'], test: ['./mvnw -ntp test'], lint: [], sources: ['pom.xml + mvnw wrapper'] },
  toolVersion: '9.9.9',
};

describe('composeArchitectureMarkdown', () => {
  const doc = composeArchitectureMarkdown(FIXTURE_INPUTS);

  it('states only index facts in the overview', () => {
    expect(doc).toContain('20 indexed files: 12 main-source, 6 test-source');
    expect(doc).toContain('2 HTTP endpoints (spring)');
    expect(doc).toContain('main @ abc1234567');
  });

  it('deduplicates flows per entry file and gates on confidence', () => {
    const flowHeaders = [...doc.matchAll(/^### (.+)$/gm)].map(m => m[1]);
    expect(flowHeaders).toEqual(['POST /orders via OrderResource.create(OrderDTO)']);
    expect(doc).not.toContain('low-confidence flow');
  });

  it('keeps only name-related real test files for a flow', () => {
    expect(doc).toContain('OrderResourceIT.java');
    expect(doc).not.toContain('HelperConfig.java');
    expect(doc).not.toContain('UnrelatedThingTest.java');
  });

  it('filters hotspots to main source', () => {
    expect(doc).toContain('src/OrderService.java');
    expect(doc).not.toContain('BigIT.java');
  });

  it('renders detected build commands and overlay honesty note', () => {
    expect(doc).toContain('./mvnw -ntp verify');
    expect(doc).toContain('path-derived');
  });
});

describe('composeClaudeMarkdown', () => {
  const doc = composeClaudeMarkdown(FIXTURE_INPUTS);

  it('leads with the one-line fact summary', () => {
    expect(doc).toContain('java codebase: 12 main-source files, 6 test files, 2 spring endpoints.');
  });

  it('lists commands, layout, entrypoints, and guardrails', () => {
    expect(doc).toContain('Run tests: `./mvnw -ntp test`');
    expect(doc).toContain('`src` — 12 main / 0 test files');
    expect(doc).toContain('`POST /api/orders` → OrderResource.create');
    expect(doc).toContain('src/OrderService.java');
  });

  it('includes the MCP routing policy near the top, before project sections', () => {
    expect(doc).toContain('## Repo context: use the codegraph MCP first');
    expect(doc).toContain('call `codegraph_context` with the task verbatim');
    expect(doc).toContain('`answerable=true`');
    expect(doc).toContain('`sessionId`');
    expect(doc).toContain('`codegraph_slice`');
    expect(doc.indexOf('## Repo context')).toBeLessThan(doc.indexOf('## Commands'));
    // Hedged on availability: must not read as an instruction to call a tool
    // that does not exist in the session.
    expect(doc).toContain('When the codegraph MCP tools are available');
  });

  it('keeps the routing block within its 10-line budget', () => {
    const start = doc.indexOf('## Repo context: use the codegraph MCP first');
    const section = doc.slice(start, doc.indexOf('## ', start + 10));
    const contentLines = section.split('\n').filter(line => line.trim().length > 0);
    expect(contentLines.length).toBeLessThanOrEqual(10);
  });
});

describe('composeCopilotMarkdown', () => {
  it('mirrors the CLAUDE.md facts + routing policy for .github/copilot-instructions.md', () => {
    const doc = composeCopilotMarkdown(FIXTURE_INPUTS);
    expect(doc).toContain('## Repo context: use the codegraph MCP first');
    expect(doc).toContain('java codebase: 12 main-source files');
  });
});

describe('test-fixture endpoint filtering', () => {
  it('drops endpoints and flows declared under test/fixture trees', () => {
    const atlas = JSON.parse(JSON.stringify(FIXTURE_ATLAS)) as Record<string, any>;
    atlas.architecture.entrypoints = [
      { method: 'POST', path: '/fake', handlerSymbol: 'F.x()', file: 'tests/fixtures/app/F.java', line: 1, framework: 'spring' },
    ];
    atlas.featureMap.flows = [{
      id: 'POST /fake',
      name: 'fixture flow',
      entrypoint: { file: 'tests/fixtures/app/F.java', line: 1, confidence: 0.9 },
      callGraph: [],
      likelyTests: [],
    }];
    atlas.summary.counts.endpoints = 1;
    const doc = composeArchitectureMarkdown({ ...FIXTURE_INPUTS, atlas });
    expect(doc).not.toContain('HTTP API surface');
    expect(doc).not.toContain('fixture flow');
    expect(doc).not.toContain('HTTP endpoints');
    const claude = composeClaudeMarkdown({ ...FIXTURE_INPUTS, atlas });
    expect(claude).not.toContain('endpoints.');
    expect(claude).not.toContain('API entrypoints');
  });
});

describe('normalizeOnboardProfile', () => {
  it('accepts the three profiles and defaults to both', () => {
    expect(normalizeOnboardProfile(undefined)).toBe('both');
    expect(normalizeOnboardProfile('claude')).toBe('claude');
    expect(() => normalizeOnboardProfile('everything')).toThrow(/Unknown onboard profile/);
  });
});
