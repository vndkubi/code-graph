/**
 * Repo-atlas construction and markdown rendering. Extracted from service.ts;
 * pure functions over already-queried rows.
 */
import path from 'node:path';
import {
  stringOrUndefined,
  stringArray,
  uniqueStrings,
  arrayRecords,
  isPlainObject,
  parseJson,
} from './util.js';

export interface RepoAtlasSnapshotRow {
  id: string;
  workspace_id: string;
  workspace_root: string;
  workspace_key?: string;
  branch?: string;
  head_commit?: string;
  created_at?: string;
  index_time_ms?: number | string;
  manifest_scan_ms?: number | string;
  files_total?: number | string;
  files_parsed?: number | string;
  parse_cache_hits?: number | string;
}

export interface RepoAtlasFileRow {
  path: string;
  language?: string;
  file_role: string;
  parse_status: string;
  size: number | string;
}

export interface RepoAtlasHotspotRow extends RepoAtlasFileRow {
  outgoing_deps: number | string;
  incoming_deps: number | string;
  call_edges: number | string;
  symbols: number | string;
  endpoints: number | string;
}

export interface RepoAtlasOverlayModuleRow {
  node_id: string;
  label: string;
  stats_json?: string;
  evidence_json?: string;
}

export interface RepoAtlasOverlayEdgeRow {
  from_node_id: string;
  to_node_id: string;
  edge_type: string;
  confidence: number | string;
  edge_count: number | string;
  from_label?: string;
  to_label?: string;
  evidence_json?: string;
}

export interface RepoAtlasModule {
  id: string;
  label: string;
  rootPrefix?: string;
  files: number;
  symbols: number;
  endpoints: number;
  topFiles: string[];
  evidence: string[];
  confidence: number;
}

export type RepoAtlasFormat = 'json' | 'markdown';

export function normalizeRepoAtlasFormat(value: unknown): RepoAtlasFormat {
  return String(value ?? '').trim().toLowerCase() === 'markdown' ? 'markdown' : 'json';
}

export function repoAtlasIncludesRole(
  fileRole: string | undefined,
  options: { includeTests: boolean; includeGenerated: boolean },
): boolean {
  const role = fileRole ?? '';
  if (!options.includeGenerated && role === 'generated') return false;
  if (!options.includeTests && (role === 'test_source' || role === 'mock_source')) return false;
  return true;
}

export function atlasNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function repoAtlasLanguageSummary(files: RepoAtlasFileRow[]): Array<{ language: string; files: number; bytes: number }> {
  const buckets = new Map<string, { language: string; files: number; bytes: number }>();
  for (const file of files) {
    const language = file.language || 'unknown';
    const current = buckets.get(language) ?? { language, files: 0, bytes: 0 };
    current.files++;
    current.bytes += atlasNumber(file.size);
    buckets.set(language, current);
  }
  return [...buckets.values()]
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language))
    .slice(0, 20);
}

export function buildRepoAtlasFileModuleMap(input: {
  workspaceLabel: string;
  files: RepoAtlasFileRow[];
  overlayFiles: Array<{ file: string; parent_node_id: string }>;
  overlayModules: RepoAtlasOverlayModuleRow[];
}): Map<string, string> {
  const moduleIds = new Set(input.overlayModules.map(row => row.node_id));
  const result = new Map<string, string>();
  if (moduleIds.size > 0) {
    for (const row of input.overlayFiles) {
      if (row.file && moduleIds.has(row.parent_node_id)) result.set(row.file, row.parent_node_id);
    }
  }
  for (const file of input.files) {
    if (result.has(file.path)) continue;
    const root = repoAtlasModuleRootForFile(file.path);
    result.set(file.path, repoAtlasModuleId(root || input.workspaceLabel));
  }
  return result;
}

export function buildRepoAtlasModules(input: {
  workspaceLabel: string;
  files: RepoAtlasFileRow[];
  symbolCountByFile: Map<string, number>;
  endpointCountByFile: Map<string, number>;
  fileToModule: Map<string, string>;
  overlayModules: RepoAtlasOverlayModuleRow[];
  limit: number;
}): RepoAtlasModule[] {
  const overlayById = new Map(input.overlayModules.map(row => [row.node_id, row]));
  const modules = new Map<string, RepoAtlasModule>();
  for (const file of input.files) {
    const id = input.fileToModule.get(file.path) ?? repoAtlasModuleId(input.workspaceLabel);
    let module = modules.get(id);
    if (!module) {
      const overlay = overlayById.get(id);
      const overlayEvidence = parseJson<Array<Record<string, unknown>>>(overlay?.evidence_json, []);
      const rootPrefix = stringOrUndefined(overlayEvidence.find(item => stringOrUndefined(item.rootPrefix))?.rootPrefix)
        ?? repoAtlasModuleRootForFile(file.path);
      module = {
        id,
        label: overlay?.label ?? repoAtlasModuleLabel(rootPrefix, input.workspaceLabel),
        rootPrefix,
        files: 0,
        symbols: 0,
        endpoints: 0,
        topFiles: [],
        evidence: overlayEvidence
          .map(item => stringOrUndefined(item.reason))
          .filter((item): item is string => Boolean(item))
          .slice(0, 4),
        confidence: overlay ? 0.9 : 0.65,
      };
      modules.set(id, module);
    }
    module.files++;
    module.symbols += input.symbolCountByFile.get(file.path) ?? 0;
    module.endpoints += input.endpointCountByFile.get(file.path) ?? 0;
    module.topFiles.push(file.path);
  }
  for (const module of modules.values()) {
    if (module.evidence.length === 0) {
      module.evidence = module.rootPrefix
        ? [`path prefix ${module.rootPrefix}`]
        : ['workspace root fallback'];
    }
    module.topFiles = module.topFiles
      .sort((a, b) => {
        const aScore = (input.endpointCountByFile.get(a) ?? 0) * 100 + (input.symbolCountByFile.get(a) ?? 0);
        const bScore = (input.endpointCountByFile.get(b) ?? 0) * 100 + (input.symbolCountByFile.get(b) ?? 0);
        return bScore - aScore || a.localeCompare(b);
      })
      .slice(0, 6);
  }
  return [...modules.values()]
    .sort((a, b) => b.endpoints - a.endpoints || b.files - a.files || a.label.localeCompare(b.label))
    .slice(0, input.limit);
}

export function buildRepoAtlasModuleDependencies(input: {
  dependencyPairs: Array<{ from_file: string; to_file: string; count: number | string; confidence: number | string }>;
  overlayEdges: RepoAtlasOverlayEdgeRow[];
  moduleById: Map<string, RepoAtlasModule>;
  fileToModule: Map<string, string>;
  limit: number;
}): Array<Record<string, unknown>> {
  if (input.overlayEdges.length > 0) {
    return input.overlayEdges
      .filter(edge => input.moduleById.has(edge.from_node_id) && input.moduleById.has(edge.to_node_id))
      .slice(0, input.limit)
      .map(edge => ({
        from: edge.from_node_id,
        to: edge.to_node_id,
        fromLabel: edge.from_label ?? input.moduleById.get(edge.from_node_id)?.label,
        toLabel: edge.to_label ?? input.moduleById.get(edge.to_node_id)?.label,
        kind: edge.edge_type,
        count: atlasNumber(edge.edge_count),
        confidence: atlasNumber(edge.confidence),
        evidence: parseJson<Array<Record<string, unknown>>>(edge.evidence_json, []).slice(0, 3),
      }));
  }
  const aggregates = new Map<string, { from: string; to: string; count: number; confidence: number }>();
  for (const pair of input.dependencyPairs) {
    const from = input.fileToModule.get(pair.from_file);
    const to = input.fileToModule.get(pair.to_file);
    if (!from || !to || from === to) continue;
    if (!input.moduleById.has(from) || !input.moduleById.has(to)) continue;
    const key = `${from}\0${to}`;
    const current = aggregates.get(key) ?? { from, to, count: 0, confidence: 0 };
    current.count += atlasNumber(pair.count);
    current.confidence = Math.max(current.confidence, atlasNumber(pair.confidence));
    aggregates.set(key, current);
  }
  return [...aggregates.values()]
    .sort((a, b) => b.count - a.count || b.confidence - a.confidence)
    .slice(0, input.limit)
    .map(edge => ({
      from: edge.from,
      to: edge.to,
      fromLabel: input.moduleById.get(edge.from)?.label,
      toLabel: input.moduleById.get(edge.to)?.label,
      kind: 'module_dependency',
      count: edge.count,
      confidence: edge.confidence,
      evidence: [],
    }));
}

export function repoAtlasHotspot(
  row: RepoAtlasHotspotRow,
  symbolCountByFile: Map<string, number>,
  endpointCountByFile: Map<string, number>,
): Record<string, unknown> {
  const outgoingDependencies = atlasNumber(row.outgoing_deps);
  const incomingDependents = atlasNumber(row.incoming_deps);
  const callEdges = atlasNumber(row.call_edges);
  const symbols = Math.max(atlasNumber(row.symbols), symbolCountByFile.get(row.path) ?? 0);
  const endpoints = Math.max(atlasNumber(row.endpoints), endpointCountByFile.get(row.path) ?? 0);
  const riskScore = Math.round(
    endpoints * 25
    + incomingDependents * 3
    + outgoingDependencies * 2
    + callEdges * 2
    + Math.min(symbols, 100),
  );
  const why: string[] = [];
  if (endpoints > 0) why.push(`${endpoints} indexed endpoint(s)`);
  if (incomingDependents > 0) why.push(`${incomingDependents} dependent file edge(s)`);
  if (outgoingDependencies > 0) why.push(`${outgoingDependencies} dependency edge(s)`);
  if (callEdges > 0) why.push(`${callEdges} primary/provider call edge(s)`);
  if (symbols > 20) why.push(`${symbols} declared symbol(s)`);
  return {
    file: row.path,
    language: row.language,
    fileRole: row.file_role,
    size: atlasNumber(row.size),
    metrics: {
      endpoints,
      symbols,
      callEdges,
      outgoingDependencies,
      incomingDependents,
    },
    riskScore,
    riskLevel: riskScore >= 80 ? 'high' : riskScore >= 25 ? 'medium' : 'low',
    why: why.length > 0 ? why : ['ranked by graph connectivity'],
  };
}

export function repoAtlasFlowName(endpoint: Record<string, unknown>): string {
  const method = String(endpoint.method ?? '').toUpperCase() || 'REQUEST';
  const route = String(endpoint.path ?? '').replace(/^\/api\//, '/').replace(/[{}]/g, '').replace(/\/+/g, '/');
  const handler = String(endpoint.handlerSymbol ?? '').split('.').slice(-2).join('.');
  return handler ? `${method} ${route} via ${handler}` : `${method} ${route}`;
}

export function repoAtlasFlowTestSeeds(endpoint: Record<string, unknown>, callGraph: Array<Record<string, unknown>>): string[] {
  return uniqueStrings([
    String(endpoint.handlerSymbol ?? ''),
    String(endpoint.controller ?? ''),
    String(endpoint.path ?? '').split(/[/?#]/)[1] ?? '',
    ...callGraph.flatMap(edge => [String(edge.callee ?? ''), String(edge.caller ?? '')]),
  ].flatMap(value => value.split(/[/:{}._\-\s]+/).concat(value)).filter(value => value.length >= 3));
}

export function repoAtlasFlowConfidence(
  endpoint: Record<string, unknown>,
  callGraph: Array<Record<string, unknown>>,
  tests: Array<Record<string, unknown>>,
): number {
  const endpointConfidence = atlasNumber(endpoint.confidence) || 0.65;
  const callBoost = callGraph.length > 0 ? 0.08 : 0;
  const testBoost = tests.length > 0 ? 0.05 : 0;
  return Math.min(0.95, Math.round((endpointConfidence + callBoost + testBoost) * 100) / 100);
}

export function repoAtlasModuleRootForFile(file: string): string {
  const normalized = file.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length >= 2 && /^(apps|packages|services|modules|crates)$/.test(parts[0] ?? '')) {
    return parts.slice(0, 2).join('/');
  }
  const srcIndex = normalized.indexOf('/src/');
  if (srcIndex > 0) return normalized.slice(0, srcIndex);
  if (normalized.startsWith('src/')) return '';
  return parts.length > 2 ? parts[0] ?? '' : '';
}

export function repoAtlasModuleLabel(rootPrefix: string | undefined, fallback: string): string {
  if (!rootPrefix) return fallback;
  return path.posix.basename(rootPrefix) || rootPrefix;
}

export function repoAtlasModuleId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/[^a-z0-9/._-]+/g, '-')
    .replace(/[/.]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `module:${normalized || 'workspace'}`;
}

export function renderRepoAtlasMarkdown(atlas: Record<string, unknown>): string {
  const snapshot = isPlainObject(atlas.snapshot) ? atlas.snapshot : {};
  const summary = isPlainObject(atlas.summary) ? atlas.summary : {};
  const architecture = isPlainObject(atlas.architecture) ? atlas.architecture : {};
  const featureMap = isPlainObject(atlas.featureMap) ? atlas.featureMap : {};
  const changePlaybook = isPlainObject(atlas.changePlaybook) ? atlas.changePlaybook : {};
  const diagnostics = isPlainObject(atlas.diagnostics) ? atlas.diagnostics : {};
  const counts = isPlainObject(summary.counts) ? summary.counts : {};
  const modules = arrayRecords(architecture.modules);
  const moduleDependencies = arrayRecords(architecture.moduleDependencies);
  const entrypoints = arrayRecords(architecture.entrypoints);
  const flows = arrayRecords(featureMap.flows);
  const hotspots = arrayRecords(changePlaybook.hotspots);
  const likelyTests = arrayRecords(changePlaybook.likelyTests);
  const lines: string[] = [];
  lines.push('# CodeGraph Repo Atlas', '');
  lines.push(`Generated: ${String(atlas.generatedAt ?? '')}`);
  lines.push(`Workspace: ${String(snapshot.root ?? '')}`);
  lines.push(`Snapshot: ${String(snapshot.snapshotId ?? '')}`);
  lines.push('');
  lines.push('## System Mental Model', '');
  for (const item of stringArray(atlas.systemMentalModel)) lines.push(`- ${item}`);
  lines.push('');
  lines.push('## Index Summary', '');
  lines.push('| Metric | Value |');
  lines.push('|---|---:|');
  for (const key of ['files', 'symbols', 'dependencyEdges', 'callEdgesPrimary', 'endpoints', 'graphNodes', 'graphEdges']) {
    lines.push(`| ${repoAtlasMd(key)} | ${repoAtlasMd(String(counts[key] ?? 0))} |`);
  }
  lines.push('');
  lines.push('## Modules', '');
  lines.push('| Module | Files | Symbols | Endpoints | Evidence |');
  lines.push('|---|---:|---:|---:|---|');
  for (const module of modules.slice(0, 20)) {
    lines.push(`| ${repoAtlasMd(module.label)} | ${repoAtlasMd(module.files)} | ${repoAtlasMd(module.symbols)} | ${repoAtlasMd(module.endpoints)} | ${repoAtlasMd(stringArray(module.evidence).join(', '))} |`);
  }
  if (modules.length === 0) lines.push('| none | 0 | 0 | 0 | no module facts |');
  lines.push('');
  lines.push('## Module Dependencies', '');
  lines.push('| From | To | Kind | Count |');
  lines.push('|---|---|---|---:|');
  for (const edge of moduleDependencies.slice(0, 20)) {
    lines.push(`| ${repoAtlasMd(edge.fromLabel ?? edge.from)} | ${repoAtlasMd(edge.toLabel ?? edge.to)} | ${repoAtlasMd(edge.kind)} | ${repoAtlasMd(edge.count)} |`);
  }
  if (moduleDependencies.length === 0) lines.push('| none | none | none | 0 |');
  lines.push('');
  lines.push('## Entrypoints', '');
  lines.push('| Endpoint | Handler | File | Line |');
  lines.push('|---|---|---|---:|');
  for (const endpoint of entrypoints.slice(0, 30)) {
    lines.push(`| ${repoAtlasMd(`${endpoint.method ?? ''} ${endpoint.path ?? ''}`)} | ${repoAtlasMd(endpoint.handlerSymbol)} | ${repoAtlasMd(endpoint.file)} | ${repoAtlasMd(endpoint.line)} |`);
  }
  if (entrypoints.length === 0) lines.push('| none | none | none | 0 |');
  lines.push('');
  lines.push('## Feature Flows', '');
  for (const flow of flows.slice(0, 12)) {
    lines.push(`### ${String(flow.name ?? flow.id ?? 'Flow')}`, '');
    lines.push(`- Handler: ${String(flow.handler ?? '')}`);
    lines.push(`- Primary files: ${stringArray(flow.primaryFiles).join(', ') || 'none'}`);
    lines.push(`- Likely tests: ${arrayRecords(flow.likelyTests).map(test => String(test.file ?? '')).filter(Boolean).join(', ') || 'none'}`);
    lines.push(`- Confidence: ${String(flow.confidence ?? '')}`);
    lines.push('');
  }
  lines.push('## Change Impact Hotspots', '');
  lines.push('| File | Risk | Score | Why |');
  lines.push('|---|---|---:|---|');
  for (const hotspot of hotspots.slice(0, 30)) {
    lines.push(`| ${repoAtlasMd(hotspot.file)} | ${repoAtlasMd(hotspot.riskLevel)} | ${repoAtlasMd(hotspot.riskScore)} | ${repoAtlasMd(stringArray(hotspot.why).join(', '))} |`);
  }
  if (hotspots.length === 0) lines.push('| none | low | 0 | no graph hotspots |');
  lines.push('');
  lines.push('## Validation', '');
  lines.push(`Likely tests: ${likelyTests.map(test => String(test.file ?? '')).filter(Boolean).join(', ') || 'none'}`);
  const validation = isPlainObject(changePlaybook.validation) ? changePlaybook.validation : {};
  const commands = stringArray(validation.suggestedCommands);
  if (commands.length > 0) {
    lines.push('');
    lines.push('Suggested commands:');
    for (const command of commands) lines.push(`- \`${command}\``);
  }
  lines.push('');
  lines.push('## Diagnostics', '');
  lines.push(`Parse failures: ${arrayRecords(diagnostics.parseFailures).length}`);
  lines.push(`Unresolved imports: ${arrayRecords(diagnostics.topUnresolvedImports).length}`);
  lines.push(`Unresolved calls: ${arrayRecords(diagnostics.topUnresolvedCalls).length}`);
  lines.push('');
  lines.push('## Recommended Priority Order', '');
  lines.push('1. Use the top entrypoint flow for feature/API research.');
  lines.push('2. Use the highest-risk hotspot with simulate_patch_impact before editing.');
  lines.push('3. Use get_index_stats if diagnostics show parse, endpoint, or unresolved-call gaps.');
  lines.push('');
  return lines.join('\n');
}

export function repoAtlasMd(value: unknown): string {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}
