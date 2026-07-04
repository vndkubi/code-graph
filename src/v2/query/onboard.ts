/**
 * `codegraph onboard`: compose the repo atlas + index facts into onboarding
 * documents — ARCHITECTURE.md for humans, CLAUDE.md for coding agents. Every
 * sentence is a deterministic index fact (counts, paths, endpoints, call
 * edges); nothing is guessed by a model.
 *
 * Regeneration is marker-based: only the block between the codegraph markers
 * is ever rewritten, so hand-written notes around it survive every rerun. A
 * pre-existing file without markers gets the block appended once; after that
 * the block updates in place.
 */
import fs from 'node:fs';
import path from 'node:path';
import { arrayRecords, isPlainObject, stringArray } from './util.js';

export const ONBOARD_BEGIN_MARKER = '<!-- codegraph:begin generated -->';
export const ONBOARD_END_MARKER = '<!-- codegraph:end generated -->';

export type OnboardProfile = 'architecture' | 'claude' | 'copilot' | 'both';

export function normalizeOnboardProfile(value: string | undefined): OnboardProfile {
  const profile = (value ?? 'both').trim().toLowerCase();
  if (profile === 'architecture' || profile === 'claude' || profile === 'copilot' || profile === 'both') return profile;
  throw new Error(`Unknown onboard profile: ${value}. Use architecture, claude, copilot, or both.`);
}

export interface OnboardDirectoryStat {
  dir: string;
  mainFiles: number;
  testFiles: number;
}

export interface OnboardComponentStat {
  component: string;
  mainFiles: number;
  testFiles: number;
  endpoints: number;
  /** Top code languages in this component (config formats excluded). */
  languages: string[];
}

export interface OnboardBuildCommands {
  build: string[];
  test: string[];
  lint: string[];
  sources: string[];
}

export interface OnboardInputs {
  atlas: Record<string, unknown>;
  directories: OnboardDirectoryStat[];
  /** Top-level component aggregation; empty for single-component repos. */
  components: OnboardComponentStat[];
  commands: OnboardBuildCommands;
  toolVersion: string;
}

/** `typescript + java` for a polyglot repo, single label otherwise. */
function codeLanguageSummary(languages: Array<{ language: string; files: number }>): string {
  const code = languages.filter(l => !NON_CODE_LANGUAGES.has(l.language.toLowerCase()));
  if (code.length === 0) return languages[0]?.language ?? 'unknown';
  const [first, second] = code;
  if (second && second.files >= first!.files * 0.3) return `${first!.language} + ${second.language}`;
  return first!.language;
}

/**
 * Aggregate indexed files into directory groups a newcomer can navigate by.
 * Only directories with enough files to be a real area are kept.
 */
export function buildDirectoryStats(
  files: Array<{ path: string; file_role: string }>,
  minFiles = 3,
  limit = 14,
): OnboardDirectoryStat[] {
  const byDir = new Map<string, OnboardDirectoryStat>();
  for (const file of files) {
    const role = file.file_role;
    if (role !== 'main_source' && role !== 'test_source') continue;
    const normalized = file.path.replace(/\\/g, '/');
    const dir = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '.';
    const entry = byDir.get(dir) ?? { dir, mainFiles: 0, testFiles: 0 };
    if (role === 'main_source') entry.mainFiles++;
    else entry.testFiles++;
    byDir.set(dir, entry);
  }
  return [...byDir.values()]
    .filter(entry => entry.mainFiles + entry.testFiles >= minFiles)
    .sort((a, b) => (b.mainFiles + b.testFiles) - (a.mainFiles + a.testFiles) || a.dir.localeCompare(b.dir))
    .slice(0, limit);
}

const NON_CODE_LANGUAGES = new Set([
  'json', 'yaml', 'xml', 'properties', 'toml', 'ini', 'markdown', 'html', 'css', 'scss', 'svg', 'text', 'unknown', '',
]);

// Monorepo container dirs whose direct children are the real components.
const COMPONENT_CONTAINER_DIRS = /^(packages|apps|services|modules|libs|crates)$/;

/** Top-level component a file belongs to (e.g. `backend`, `packages/ui`). */
export function componentForPath(file: string): string | undefined {
  const parts = file.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length < 2) return undefined; // repo-root file, not a component
  const head = parts[0]!;
  if (head.startsWith('.')) return undefined;
  if (COMPONENT_CONTAINER_DIRS.test(head) && parts.length >= 3) return `${head}/${parts[1]}`;
  return head;
}

/**
 * Aggregate indexed files into top-level components (backend, frontend, cli,
 * packages/x…). This is the architecture view a polyglot or multi-module repo
 * actually needs — leaf-directory stats alone bury it.
 */
export function buildComponentStats(
  files: Array<{ path: string; file_role: string; language?: string }>,
  endpointFiles: string[] = [],
  minFiles = 3,
  limit = 12,
): OnboardComponentStat[] {
  const byComponent = new Map<string, OnboardComponentStat & { langCounts: Map<string, number> }>();
  for (const file of files) {
    if (file.file_role !== 'main_source' && file.file_role !== 'test_source') continue;
    const component = componentForPath(file.path);
    if (!component) continue;
    let entry = byComponent.get(component);
    if (!entry) {
      entry = { component, mainFiles: 0, testFiles: 0, endpoints: 0, languages: [], langCounts: new Map() };
      byComponent.set(component, entry);
    }
    if (file.file_role === 'main_source') entry.mainFiles++;
    else entry.testFiles++;
    const language = (file.language ?? '').toLowerCase();
    if (!NON_CODE_LANGUAGES.has(language)) {
      entry.langCounts.set(language, (entry.langCounts.get(language) ?? 0) + 1);
    }
  }
  for (const file of endpointFiles) {
    const component = componentForPath(file);
    if (!component) continue;
    const entry = byComponent.get(component);
    if (entry) entry.endpoints++;
  }
  return [...byComponent.values()]
    .filter(entry => entry.mainFiles + entry.testFiles >= minFiles)
    // Layout dirs are not components: `src` is the single app itself, and a
    // top-level test/docs tree only mirrors it. A test tree that contains
    // main-source files (e.g. a published test framework) IS a component.
    .filter(entry => !/^(src|source|docs?|examples?|samples?)$/.test(entry.component))
    .filter(entry => !(/^(tests?|spec|__tests__)$/.test(entry.component) && entry.mainFiles === 0))
    .sort((a, b) => (b.mainFiles + b.testFiles) - (a.mainFiles + a.testFiles) || a.component.localeCompare(b.component))
    .slice(0, limit)
    .map(({ langCounts, ...entry }) => ({
      ...entry,
      languages: [...langCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([lang]) => lang),
    }));
}

/**
 * Detect build/test/lint commands from build-tool files actually present on
 * disk — the atlas oracle only understands package.json, which leaves Maven
 * and Gradle repos with no commands at all. Component dirs are scanned too:
 * a polyglot repo's backend/gradle must not be shadowed by a root package.json.
 */
export function detectBuildCommands(root: string, componentDirs: string[] = []): OnboardBuildCommands {
  const commands: OnboardBuildCommands = { build: [], test: [], lint: [], sources: [] };
  const scopes = ['', ...componentDirs.filter(dir => dir !== '' && !dir.includes('..'))];
  for (const scope of scopes) {
    const base = scope === '' ? root : path.join(root, scope);
    if (scope !== '' && !fs.existsSync(base)) continue;
    const has = (rel: string): boolean => fs.existsSync(path.join(base, rel));
    const prefix = scope === '' ? '' : `cd ${scope} && `;
    const label = (file: string): string => (scope === '' ? file : `${scope}/${file}`);
    if (has('pom.xml')) {
      const mvn = has('mvnw') || has('mvnw.cmd') ? './mvnw' : 'mvn';
      commands.build.push(`${prefix}${mvn} -ntp verify`);
      commands.test.push(`${prefix}${mvn} -ntp test`);
      commands.sources.push(label(has('mvnw') ? 'pom.xml + mvnw wrapper' : 'pom.xml'));
    }
    if (has('build.gradle') || has('build.gradle.kts')) {
      const gradle = has('gradlew') ? './gradlew' : fs.existsSync(path.join(root, 'gradlew')) ? `${scope === '' ? './' : '../'}gradlew` : 'gradle';
      commands.build.push(`${prefix}${gradle} build`);
      commands.test.push(`${prefix}${gradle} test`);
      commands.sources.push(label(has('gradlew') || fs.existsSync(path.join(root, 'gradlew')) ? 'build.gradle + gradlew wrapper' : 'build.gradle'));
    }
    if (has('package.json')) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf-8')) as { scripts?: Record<string, string> };
        const scripts = pkg.scripts ?? {};
        if (scripts.build) commands.build.push(`${prefix}npm run build`);
        if (scripts.test) commands.test.push(`${prefix}npm test`);
        if (scripts.lint) commands.lint.push(`${prefix}npm run lint`);
        if (scripts.typecheck) commands.lint.push(`${prefix}npm run typecheck`);
        if (scripts.build || scripts.test || scripts.lint || scripts.typecheck) {
          commands.sources.push(label('package.json scripts'));
        }
      } catch {
        // Unreadable package.json: report nothing rather than guessing.
      }
    }
  }
  return commands;
}

/**
 * Replace the generated block inside `existing`, append it when no markers
 * are present, or start a fresh document. Hand-written content is never
 * touched. Throws on a lone begin/end marker instead of guessing the range.
 */
export function applyGeneratedBlock(existing: string | undefined, generatedBody: string): string {
  const block = `${ONBOARD_BEGIN_MARKER}\n${generatedBody.trimEnd()}\n${ONBOARD_END_MARKER}`;
  if (existing === undefined || existing.trim() === '') {
    return `${block}\n`;
  }
  const beginAt = existing.indexOf(ONBOARD_BEGIN_MARKER);
  const endAt = existing.indexOf(ONBOARD_END_MARKER);
  if (beginAt === -1 && endAt === -1) {
    return `${existing.trimEnd()}\n\n${block}\n`;
  }
  if (beginAt === -1 || endAt === -1 || endAt < beginAt) {
    throw new Error(
      `Found a lone or out-of-order codegraph marker. Fix the ${ONBOARD_BEGIN_MARKER} / ${ONBOARD_END_MARKER} pair by hand, then rerun.`,
    );
  }
  const before = existing.slice(0, beginAt);
  const after = existing.slice(endAt + ONBOARD_END_MARKER.length);
  return `${before}${block}${after}`;
}

interface AtlasView {
  root: string;
  branch?: string;
  headCommit?: string;
  counts: Record<string, number>;
  languages: Array<{ language: string; files: number }>;
  fileRoles: Map<string, number>;
  health: Record<string, unknown>;
  entrypoints: Array<Record<string, unknown>>;
  /** Indexed endpoint total minus test/fixture-declared ones. */
  apiEndpointCount: number;
  flows: Array<Record<string, unknown>>;
  hotspots: Array<Record<string, unknown>>;
  framework?: string;
}

/** Endpoints declared inside test/fixture trees are not the app's API. */
function isTestPath(file: string): boolean {
  return /(^|\/)(tests?|__tests__|fixtures?|testdata|src\/test)\//.test(file.replace(/\\/g, '/'));
}

function viewAtlas(atlas: Record<string, unknown>): AtlasView {
  const snapshot = isPlainObject(atlas.snapshot) ? atlas.snapshot : {};
  const summary = isPlainObject(atlas.summary) ? atlas.summary : {};
  const counts: Record<string, number> = {};
  if (isPlainObject(summary.counts)) {
    for (const [key, value] of Object.entries(summary.counts)) counts[key] = Number(value ?? 0);
  }
  const architecture = isPlainObject(atlas.architecture) ? atlas.architecture : {};
  const featureMap = isPlainObject(atlas.featureMap) ? atlas.featureMap : {};
  const changePlaybook = isPlainObject(atlas.changePlaybook) ? atlas.changePlaybook : {};
  const allEntrypoints = arrayRecords(architecture.entrypoints);
  const entrypoints = allEntrypoints.filter(e => !isTestPath(String(e.file ?? '')));
  const testEntrypointCount = allEntrypoints.length - entrypoints.length;
  const frameworks = new Set(entrypoints.map(e => String(e.framework ?? '')).filter(Boolean));
  return {
    root: String(snapshot.root ?? ''),
    branch: snapshot.branch ? String(snapshot.branch) : undefined,
    headCommit: snapshot.headCommit ? String(snapshot.headCommit) : undefined,
    counts,
    languages: arrayRecords(summary.languages).map(l => ({ language: String(l.language ?? ''), files: Number(l.files ?? 0) })),
    fileRoles: new Map(arrayRecords(summary.fileRoles).map(r => [String(r.fileRole ?? ''), Number(r.count ?? 0)])),
    health: isPlainObject(summary.health) ? summary.health : {},
    entrypoints,
    apiEndpointCount: Math.max(0, Number(counts.endpoints ?? 0) - testEntrypointCount),
    flows: arrayRecords(featureMap.flows)
      .filter(flow => !isTestPath(String((isPlainObject(flow.entrypoint) ? flow.entrypoint : {}).file ?? ''))),
    hotspots: arrayRecords(changePlaybook.hotspots),
    framework: frameworks.size === 1 ? [...frameworks][0] : undefined,
  };
}

const md = (value: unknown): string => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

function shortHandler(symbol: unknown): string {
  return String(symbol ?? '').replace(/\(.*\)$/, '').split('.').slice(-2).join('.');
}

/** Main-source hotspots only: test files dominate raw risk scores but are not
 * what a newcomer must be careful with; vendored/minified assets are indexed
 * as main_source yet nobody edits them. */
function mainHotspots(view: AtlasView, limit: number): Array<Record<string, unknown>> {
  return view.hotspots
    .filter(h => String(h.fileRole ?? '') === 'main_source')
    .filter(h => !/(\.min\.\w+$)|((^|\/)(vendor|node_modules|webapps\/static)\/)/.test(String(h.file ?? '')))
    .slice(0, limit);
}

/** Flow headings inherit the full handler signature; WebHDFS-style handlers
 * carry 30+ params. Keep the heading scannable. */
function flowTitle(flow: Record<string, unknown>): string {
  const name = String(flow.name ?? flow.id ?? 'Flow');
  return name.length > 90 ? `${name.slice(0, 87)}…` : name;
}

function flowConfidence(flow: Record<string, unknown>): number {
  const own = Number(flow.confidence);
  if (Number.isFinite(own) && own > 0) return own;
  const entry = isPlainObject(flow.entrypoint) ? flow.entrypoint : {};
  const fromEntry = Number(entry.confidence);
  return Number.isFinite(fromEntry) ? fromEntry : 0;
}

/**
 * Pick flows for the doc: confidence-gated, then at most one per entry file so
 * CRUD boilerplate (PUT+PATCH of every entity, all shaped alike) cannot crowd
 * out the distinct flows a newcomer actually needs to see.
 */
function selectFlows(view: AtlasView, limit: number, minConfidence = 0.7): Array<Record<string, unknown>> {
  const eligible = view.flows
    .filter(flow => flowConfidence(flow) >= minConfidence)
    .sort((a, b) => arrayRecords(b.callGraph).length - arrayRecords(a.callGraph).length);
  const byEntryFile = new Map<string, Record<string, unknown>>();
  for (const flow of eligible) {
    const entry = isPlainObject(flow.entrypoint) ? flow.entrypoint : {};
    const file = String(entry.file ?? flow.id ?? '');
    if (!byEntryFile.has(file)) byEntryFile.set(file, flow);
  }
  return [...byEntryFile.values()].slice(0, limit);
}

/**
 * Real test files only — atlas likelyTests can include config/helper files —
 * and, when the entry file is known, only tests that share its name stem
 * (AccountResource → AccountResourceIT), dropping name-proximity strays.
 */
function realTestFiles(records: Array<Record<string, unknown>>, entryFile = '', limit = 2): string[] {
  const tests = records
    .map(t => String(t.file ?? ''))
    .filter(file => /(Test|Tests|IT|Spec)\.\w+$|\.(test|spec)\.\w+$/.test(file));
  const stem = entryFile.replace(/\\/g, '/').split('/').pop()?.replace(/\.\w+$/, '') ?? '';
  if (stem.length >= 4) {
    const related = tests.filter(file => file.includes(stem));
    if (related.length > 0) return related.slice(0, limit);
  }
  return tests.slice(0, limit);
}

function flowCallees(flow: Record<string, unknown>, limit = 4): string[] {
  const callees = arrayRecords(flow.callGraph)
    .map(edge => String(edge.callee ?? '').split('.')[0] ?? '')
    .filter(name => name.length > 1);
  return [...new Set(callees)].slice(0, limit);
}

export function composeArchitectureMarkdown(inputs: OnboardInputs): string {
  const view = viewAtlas(inputs.atlas);
  const lines: string[] = [];
  lines.push('# Architecture');
  lines.push('');
  lines.push(`> Generated by \`codegraph onboard\` v${inputs.toolVersion} from the code-graph index — every statement is a deterministic index fact, not a model guess. Rerun \`codegraph onboard\` after structural changes; anything outside the markers is preserved.`);
  lines.push('');
  lines.push('## Overview');
  lines.push('');
  const mainCount = view.fileRoles.get('main_source') ?? 0;
  const testCount = view.fileRoles.get('test_source') ?? 0;
  const topLanguages = view.languages.slice(0, 3).map(l => `${l.language} (${l.files} files)`).join(', ');
  lines.push(`- ${view.counts.files ?? 0} indexed files: ${mainCount} main-source, ${testCount} test-source. Languages: ${topLanguages || 'unknown'}.`);
  lines.push(`- ${view.counts.symbols ?? 0} symbols, ${view.counts.dependencyEdges ?? 0} file dependency edges, ${view.counts.callEdgesPrimary ?? 0} resolved call edges.`);
  if (view.entrypoints.length > 0) {
    lines.push(`- ${view.apiEndpointCount} HTTP endpoints${view.framework ? ` (${view.framework})` : ''}.`);
  }
  if (view.branch || view.headCommit) {
    lines.push(`- Indexed at ${view.branch ?? '?'} @ ${(view.headCommit ?? '').slice(0, 10)}.`);
  }
  lines.push('');
  if (inputs.components.length >= 2) {
    lines.push('## Components');
    lines.push('');
    lines.push('| Component | Languages | Main files | Test files | Endpoints |');
    lines.push('|---|---|---:|---:|---:|');
    for (const component of inputs.components) {
      lines.push(`| \`${md(component.component)}\` | ${md(component.languages.join(', ') || '—')} | ${component.mainFiles} | ${component.testFiles} | ${component.endpoints > 0 ? component.endpoints : '—'} |`);
    }
    lines.push('');
  }
  lines.push('## Key directories');
  lines.push('');
  lines.push('| Directory | Main files | Test files |');
  lines.push('|---|---:|---:|');
  for (const dir of inputs.directories) {
    lines.push(`| \`${md(dir.dir)}\` | ${dir.mainFiles} | ${dir.testFiles} |`);
  }
  if (inputs.directories.length === 0) lines.push('| (no directory groups above the size threshold) | 0 | 0 |');
  lines.push('');
  if (view.entrypoints.length > 0) {
    lines.push(`## HTTP API surface (${view.apiEndpointCount} endpoints)`);
    lines.push('');
    lines.push('| Endpoint | Handler | Where |');
    lines.push('|---|---|---|');
    for (const endpoint of view.entrypoints.slice(0, 12)) {
      lines.push(`| \`${md(`${endpoint.method ?? ''} ${endpoint.path ?? ''}`)}\` | ${md(shortHandler(endpoint.handlerSymbol))} | ${md(endpoint.file)}:${md(endpoint.line)} |`);
    }
    const remaining = view.apiEndpointCount - Math.min(view.entrypoints.length, 12);
    if (remaining > 0) lines.push('');
    if (remaining > 0) lines.push(`…and ${remaining} more (run \`codegraph atlas --format markdown\` for the full list).`);
    lines.push('');
  }
  const flows = selectFlows(view, 5);
  if (flows.length > 0) {
    lines.push('## Request flows');
    lines.push('');
    lines.push('The most connected endpoint flows, traced through the call graph:');
    lines.push('');
    for (const flow of flows) {
      const entry = isPlainObject(flow.entrypoint) ? flow.entrypoint : {};
      const tests = realTestFiles(arrayRecords(flow.likelyTests), String(entry.file ?? ''));
      lines.push(`### ${md(flowTitle(flow))}`);
      lines.push('');
      lines.push(`- Entry: \`${md(entry.file)}:${md(entry.line)}\``);
      const callees = flowCallees(flow);
      if (callees.length > 0) lines.push(`- Calls into: ${callees.map(c => `\`${c}\``).join(', ')}`);
      if (tests.length > 0) lines.push(`- Covered by: ${tests.map(t => `\`${t}\``).join(', ')}`);
      lines.push('');
    }
  }
  const hotspots = mainHotspots(view, 8);
  if (hotspots.length > 0) {
    lines.push('## Change-risk hotspots (main source)');
    lines.push('');
    lines.push('Files where a change fans out the widest — review impact before editing:');
    lines.push('');
    lines.push('| File | Risk | Why |');
    lines.push('|---|---|---|');
    for (const hotspot of hotspots) {
      lines.push(`| \`${md(hotspot.file)}\` | ${md(hotspot.riskLevel)} | ${md(stringArray(hotspot.why).join(', '))} |`);
    }
    lines.push('');
  }
  lines.push('## Build & test');
  lines.push('');
  if (inputs.commands.sources.length > 0) {
    lines.push(`Detected from ${inputs.commands.sources.join(', ')}:`);
    lines.push('');
    for (const command of inputs.commands.build) lines.push(`- Build: \`${command}\``);
    for (const command of inputs.commands.test) lines.push(`- Test: \`${command}\``);
    for (const command of inputs.commands.lint) lines.push(`- Lint/typecheck: \`${command}\``);
  } else {
    lines.push('No build-tool files detected at the workspace root.');
  }
  lines.push('');
  lines.push('## Index health');
  lines.push('');
  lines.push(`- Parse failures: ${Number(view.health.parseFailureCount ?? 0)}; endpoint warnings: ${Number(view.health.endpointWarningCount ?? 0)}.`);
  lines.push(`- Module overlay: ${view.health.overlayAvailable ? 'available (graph-derived module boundaries)' : 'absent — directory grouping above is path-derived'}.`);
  return lines.join('\n');
}

/**
 * MCP routing policy for agent instruction files (CLAUDE.md and
 * .github/copilot-instructions.md). This is the highest-authority channel an
 * agent reads — tool descriptions get deferred/truncated by clients, this
 * file does not. Hedged on availability so it stays harmless when the MCP
 * server is not configured. Keep it ≤10 lines.
 */
function composeMcpRoutingLines(): string[] {
  return [
    '## Repo context: use the codegraph MCP first',
    '',
    'When the codegraph MCP tools are available in this session:',
    '',
    '- Any repo question, or before any edit → call `codegraph_context` with the task verbatim.',
    '- The response says `answerable=true` → answer from that packet; do not re-grep/re-read the same ground.',
    '- Need more source at an exact file/line the packet named → `codegraph_slice`.',
    '- Pass the same `sessionId` string on every call in a conversation (dedupes evidence, saves tokens).',
    '- `workspace_not_indexed` error → run `codegraph index --root .` once, then retry.',
    '',
  ];
}

export function composeClaudeMarkdown(inputs: OnboardInputs): string {
  const view = viewAtlas(inputs.atlas);
  const lines: string[] = [];
  const mainCount = view.fileRoles.get('main_source') ?? 0;
  const testCount = view.fileRoles.get('test_source') ?? 0;
  const apiComponent = inputs.components.length >= 2
    ? inputs.components.reduce((best, c) => (c.endpoints > (best?.endpoints ?? 0) ? c : best), undefined as OnboardComponentStat | undefined)
    : undefined;
  lines.push('# Project facts (generated by codegraph onboard)');
  lines.push('');
  lines.push(`${codeLanguageSummary(view.languages)} codebase: ${mainCount} main-source files, ${testCount} test files${view.entrypoints.length > 0 ? `, ${view.apiEndpointCount} ${view.framework ?? 'HTTP'} endpoints${apiComponent && apiComponent.endpoints > 0 ? ` (in \`${apiComponent.component}\`)` : ''}` : ''}.`);
  lines.push('');
  lines.push(...composeMcpRoutingLines());
  if (inputs.components.length >= 2) {
    lines.push('## Components');
    lines.push('');
    for (const component of inputs.components.slice(0, 8)) {
      lines.push(`- \`${component.component}\` — ${component.languages.join('+') || 'config'}, ${component.mainFiles} main / ${component.testFiles} test files${component.endpoints > 0 ? `, ${component.endpoints} endpoints` : ''}`);
    }
    lines.push('');
  }
  if (inputs.commands.sources.length > 0) {
    lines.push('## Commands');
    lines.push('');
    for (const command of inputs.commands.test) lines.push(`- Run tests: \`${command}\``);
    for (const command of inputs.commands.build) lines.push(`- Full build: \`${command}\``);
    for (const command of inputs.commands.lint) lines.push(`- Lint/typecheck: \`${command}\``);
    lines.push('');
  }
  if (inputs.directories.length > 0) {
    lines.push('## Where code lives');
    lines.push('');
    for (const dir of inputs.directories.slice(0, 8)) {
      lines.push(`- \`${dir.dir}\` — ${dir.mainFiles} main / ${dir.testFiles} test files`);
    }
    lines.push('');
  }
  if (view.entrypoints.length > 0) {
    lines.push('## API entrypoints (top)');
    lines.push('');
    for (const endpoint of view.entrypoints.slice(0, 6)) {
      lines.push(`- \`${String(endpoint.method ?? '')} ${String(endpoint.path ?? '')}\` → ${shortHandler(endpoint.handlerSymbol)} (${String(endpoint.file ?? '')}:${String(endpoint.line ?? '')})`);
    }
    lines.push('');
  }
  const hotspots = mainHotspots(view, 4);
  if (hotspots.length > 0) {
    lines.push('## Guardrails');
    lines.push('');
    lines.push('Widest-impact files — check callers/dependents before changing behavior:');
    for (const hotspot of hotspots) {
      lines.push(`- \`${String(hotspot.file ?? '')}\` (${stringArray(hotspot.why).slice(0, 2).join(', ')})`);
    }
    lines.push('');
  }
  lines.push('Regenerate this block with `codegraph onboard`; content outside the markers is never touched.');
  return lines.join('\n');
}

/**
 * `.github/copilot-instructions.md` — Copilot auto-attaches this file to every
 * Chat/agent request; with no hook system on that client, it is the main
 * adoption lever there. Same facts + routing policy as CLAUDE.md.
 */
export function composeCopilotMarkdown(inputs: OnboardInputs): string {
  return composeClaudeMarkdown(inputs);
}
