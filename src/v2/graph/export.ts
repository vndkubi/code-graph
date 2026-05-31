import path from 'node:path';
import type { CodeGraphDb } from '../storage/database.js';

export interface GraphExportMetadata {
  workspaceId: string;
  snapshotId: string;
  root: string;
  generatedAt: string;
  truncated: boolean;
}

export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  file?: string;
  line?: number;
  serviceId?: string;
  role?: string;
  meta?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  kind: string;
  from: string;
  to: string;
  confidence?: number;
  label?: string;
  meta?: Record<string, unknown>;
}

export interface GraphGroup {
  id: string;
  kind: 'service';
  label: string;
  evidence: string[];
  stats: {
    files: number;
    symbols: number;
    endpoints: number;
  };
}

export interface GraphExport {
  metadata: GraphExportMetadata;
  nodes: GraphNode[];
  edges: GraphEdge[];
  groups: GraphGroup[];
  stats: {
    files: number;
    symbols: number;
    endpoints: number;
    dependencyEdges: number;
    callEdges: number;
    hiddenNodes: number;
    hiddenEdges: number;
  };
}

export interface GraphExportOptions {
  workspaceId: string;
  snapshotId: string;
  root: string;
  maxNodes?: number;
  maxEdges?: number;
  includeTests?: boolean;
  includeGenerated?: boolean;
}

export interface GraphSnapshotRef {
  workspaceId: string;
  snapshotId: string;
  root: string;
}

interface FileRow {
  path: string;
  language?: string;
  file_role: string;
  size: number | string;
}

interface SymbolRow {
  fq_name: string;
  simple_name: string;
  kind: string;
  file: string;
  line: number | string;
  end_line?: number | string;
  signature: string;
  parent?: string;
  package_name?: string;
  framework_role?: string;
  framework_meta_json?: string;
  file_role: string;
}

interface EndpointRow {
  method: string;
  path: string;
  path_resolution: string;
  path_resolution_reason?: string;
  handler_symbol: string;
  controller?: string;
  file: string;
  line: number | string;
  framework: string;
  confidence: number | string;
  file_role: string;
}

interface DependencyEdgeRow {
  from_file: string;
  to_file: string;
  kind: string;
  confidence: number | string;
  resolution_kind: string;
}

interface CallEdgeRow {
  caller: string;
  callee: string;
  file: string;
  line: number | string;
  confidence: number | string;
  resolution_kind: string;
  signal_tier: string;
}

interface ServiceCandidate {
  id: string;
  label: string;
  rootPrefix?: string;
  evidence: Set<string>;
  stats: {
    files: number;
    symbols: number;
    endpoints: number;
  };
}

interface NodeCandidate {
  node: GraphNode;
  score: number;
}

interface EdgeCandidate {
  edge: GraphEdge;
  score: number;
}

const DEFAULT_MAX_NODES = 800;
const DEFAULT_MAX_EDGES = 2000;

export async function resolveCurrentGraphSnapshot(
  db: CodeGraphDb,
  root: string,
  workspaceKey?: string,
): Promise<GraphSnapshotRef | undefined> {
  const normalizedKey = normalizeWorkspaceKey(workspaceKey);
  const resolvedRoot = path.resolve(root);
  const row = normalizedKey
    ? await db.prepare(`
      SELECT id, root, current_snapshot_id
      FROM workspaces
      WHERE workspace_key = ?
      ORDER BY last_seen_at DESC
      LIMIT 1
    `).get(normalizedKey) as { id: string; root: string; current_snapshot_id?: string } | undefined
    : await db.prepare(`
      SELECT id, root, current_snapshot_id
      FROM workspaces
      WHERE root = ?
      ORDER BY last_seen_at DESC
      LIMIT 1
    `).get(resolvedRoot) as { id: string; root: string; current_snapshot_id?: string } | undefined;
  if (!row?.current_snapshot_id) return undefined;
  return {
    workspaceId: row.id,
    snapshotId: row.current_snapshot_id,
    root: row.root,
  };
}

export async function buildGraphExport(db: CodeGraphDb, options: GraphExportOptions): Promise<GraphExport> {
  const maxNodes = clampInt(options.maxNodes ?? DEFAULT_MAX_NODES, 1, 10_000);
  const maxEdges = clampInt(options.maxEdges ?? DEFAULT_MAX_EDGES, 0, 50_000);
  const roleFilter = graphRoleFilter(options);
  const candidateLimit = Math.max(500, Math.min(20_000, maxNodes * 8));
  const edgeCandidateLimit = Math.max(1000, Math.min(50_000, Math.max(maxEdges, 1) * 5));

  const [files, symbols, endpoints, dependencyEdges, callEdges] = await Promise.all([
    db.prepare(`
      SELECT path, language, file_role, size
      FROM files
      WHERE snapshot_id = ?
        ${roleFilter.sql('file_role')}
      ORDER BY
        CASE file_role WHEN 'main_source' THEN 0 WHEN 'resource_config' THEN 1 WHEN 'build_config' THEN 2 WHEN 'test_source' THEN 3 WHEN 'mock_source' THEN 4 WHEN 'generated' THEN 5 ELSE 6 END,
        path
      LIMIT ?
    `).all(options.snapshotId, ...roleFilter.params, candidateLimit) as Promise<FileRow[]>,
    db.prepare(`
      SELECT fq_name, simple_name, kind, file, line, end_line, signature, parent,
             package_name, framework_role, framework_meta_json, file_role
      FROM symbols
      WHERE snapshot_id = ?
        ${roleFilter.sql('file_role')}
      ORDER BY
        CASE
          WHEN COALESCE(framework_role, '') = 'spring:application' THEN 0
          WHEN COALESCE(framework_role, '') LIKE '%endpoint%' THEN 1
          WHEN COALESCE(framework_role, '') IN ('spring:rest-controller', 'spring:controller', 'mvc:controller') THEN 2
          WHEN COALESCE(framework_role, '') IN ('spring:service', 'spring:repository', 'jakarta:entity') THEN 3
          WHEN kind IN ('class', 'interface', 'type') THEN 4
          ELSE 5
        END,
        file,
        line
      LIMIT ?
    `).all(options.snapshotId, ...roleFilter.params, candidateLimit) as Promise<SymbolRow[]>,
    db.prepare(`
      SELECT method, path, path_resolution, path_resolution_reason,
             handler_symbol, controller, file, line, framework, confidence, file_role
      FROM endpoints
      WHERE snapshot_id = ?
        ${roleFilter.sql('file_role')}
      ORDER BY confidence DESC, file, line
      LIMIT ?
    `).all(options.snapshotId, ...roleFilter.params, candidateLimit) as Promise<EndpointRow[]>,
    db.prepare(`
      SELECT from_file, to_file, kind, confidence, resolution_kind
      FROM dependency_edges
      WHERE snapshot_id = ?
      ORDER BY confidence DESC, from_file, to_file
      LIMIT ?
    `).all(options.snapshotId, edgeCandidateLimit) as Promise<DependencyEdgeRow[]>,
    db.prepare(`
      SELECT caller, callee, file, line, confidence, resolution_kind, signal_tier
      FROM call_edges
      WHERE snapshot_id = ?
        AND signal_tier IN ('primary', 'provider')
      ORDER BY confidence DESC, file, line
      LIMIT ?
    `).all(options.snapshotId, edgeCandidateLimit) as Promise<CallEdgeRow[]>,
  ]);

  const includedFiles = new Set(files.map(file => file.path));
  const filteredDependencyEdges = dependencyEdges
    .filter(edge => includedFiles.has(edge.from_file) && includedFiles.has(edge.to_file));
  const filteredCallEdges = callEdges
    .filter(edge => includedFiles.has(edge.file));
  const fileDegree = fileDegreeMap(filteredDependencyEdges, filteredCallEdges);
  const services = inferServices(options.root, files, symbols, endpoints);
  const fileServiceIds = assignFilesToServices(files, services);
  const symbolServiceIds = new Map(symbols.map(symbol => [symbol.fq_name, fileServiceIds.get(symbol.file) ?? defaultServiceId(options.root)]));
  const endpointServiceIds = new Map(endpoints.map(endpoint => [endpointKey(endpoint), fileServiceIds.get(endpoint.file) ?? defaultServiceId(options.root)]));
  for (const serviceId of symbolServiceIds.values()) {
    const service = services.get(serviceId);
    if (service) service.stats.symbols++;
  }
  for (const serviceId of endpointServiceIds.values()) {
    const service = services.get(serviceId);
    if (service) service.stats.endpoints++;
  }
  const symbolIndex = buildSymbolIndex(symbols);

  const nodeCandidates: NodeCandidate[] = [];
  const pushSymbolCandidate = (symbol: SymbolRow, score: number): void => {
    nodeCandidates.push({
      node: {
        id: symbolNodeId(symbol),
        kind: 'symbol',
        label: symbolLabel(symbol),
        file: symbol.file,
        line: numberValue(symbol.line),
        serviceId: symbolServiceIds.get(symbol.fq_name),
        role: symbol.framework_role ?? symbol.kind,
        meta: {
          fqName: symbol.fq_name,
          kind: symbol.kind,
          signature: symbol.signature,
          parent: symbol.parent,
          packageName: symbol.package_name,
          frameworkRole: symbol.framework_role,
        },
      },
      score,
    });
  };
  for (const service of services.values()) {
    nodeCandidates.push({
      node: {
        id: service.id,
        kind: 'service',
        label: service.label,
        role: 'service',
        meta: {
          evidence: [...service.evidence],
          stats: service.stats,
        },
      },
      score: 10_000,
    });
  }

  for (const endpoint of endpoints) {
    const id = endpointNodeId(endpoint);
    nodeCandidates.push({
      node: {
        id,
        kind: 'endpoint',
        label: `${endpoint.method} ${endpoint.path}`,
        file: endpoint.file,
        line: numberValue(endpoint.line),
        serviceId: endpointServiceIds.get(endpointKey(endpoint)),
        role: endpoint.framework,
        meta: {
          handlerSymbol: endpoint.handler_symbol,
          controller: endpoint.controller,
          confidence: numberValue(endpoint.confidence),
          pathResolution: endpoint.path_resolution,
          pathResolutionReason: endpoint.path_resolution_reason,
        },
      },
      score: 5000 + numberValue(endpoint.confidence) * 100,
    });
  }

  for (const symbol of symbols) pushSymbolCandidate(symbol, scoreSymbol(symbol));

  const endpointHandlerSymbols = new Set<string>();
  for (const endpoint of endpoints) {
    const handler = resolveCallSymbolRow(symbolIndex, endpoint.handler_symbol);
    if (handler) endpointHandlerSymbols.add(handler.fq_name);
  }
  const callBoostLimit = Math.max(200, Math.min(filteredCallEdges.length, maxNodes * 4));
  for (const edge of filteredCallEdges.slice(0, callBoostLimit)) {
    const caller = resolveCallSymbolRow(symbolIndex, edge.caller);
    const callee = resolveCallSymbolRow(symbolIndex, edge.callee);
    const handlerAdjacent = (caller && endpointHandlerSymbols.has(caller.fq_name)) || (callee && endpointHandlerSymbols.has(callee.fq_name));
    const boost = (handlerAdjacent ? 4650 : 3950) + numberValue(edge.confidence) * 100;
    if (caller) pushSymbolCandidate(caller, boost);
    if (callee) pushSymbolCandidate(callee, boost - 25);
  }

  for (const file of files) {
    nodeCandidates.push({
      node: {
        id: fileNodeId(file.path),
        kind: 'file',
        label: fileLabel(file.path),
        file: file.path,
        serviceId: fileServiceIds.get(file.path),
        role: file.file_role,
        meta: {
          path: file.path,
          language: file.language,
          fileRole: file.file_role,
          size: numberValue(file.size),
          degree: fileDegree.get(file.path) ?? 0,
        },
      },
      score: scoreFile(file, fileDegree.get(file.path) ?? 0),
    });
  }

  const selectedNodes = selectNodes(nodeCandidates, maxNodes);
  const edgeCandidates = buildEdgeCandidates({
    selectedNodes,
    files,
    symbols,
    endpoints,
    dependencyEdges: filteredDependencyEdges,
    callEdges: filteredCallEdges,
    fileServiceIds,
    symbolIndex,
  });
  const selectedEdges = selectEdges(edgeCandidates, maxEdges);
  const hiddenNodes = Math.max(0, nodeCandidates.length - selectedNodes.size);
  const hiddenEdges = Math.max(0, edgeCandidates.length - selectedEdges.length);
  const groups = [...services.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(service => ({
      id: service.id,
      kind: 'service' as const,
      label: service.label,
      evidence: [...service.evidence],
      stats: service.stats,
    }));

  return {
    metadata: {
      workspaceId: options.workspaceId,
      snapshotId: options.snapshotId,
      root: path.resolve(options.root),
      generatedAt: new Date().toISOString(),
      truncated: hiddenNodes > 0 || hiddenEdges > 0,
    },
    nodes: [...selectedNodes.values()],
    edges: selectedEdges,
    groups,
    stats: {
      files: files.length,
      symbols: symbols.length,
      endpoints: endpoints.length,
      dependencyEdges: filteredDependencyEdges.length,
      callEdges: filteredCallEdges.length,
      hiddenNodes,
      hiddenEdges,
    },
  };
}

export function renderGraphHtml(graph: GraphExport): string {
  const graphJson = safeJsonForHtml(graph);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CodeGraph Static View</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --surface: #ffffff;
      --surface-2: #eef2f6;
      --text: #20242c;
      --muted: #657080;
      --border: #d9e0e8;
      --accent: #0f766e;
      --endpoint: #b83280;
      --symbol: #5b5fc7;
      --file: #3c7a2a;
      --service: #c2410c;
      --edge: #9aa5b1;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
    }
    .app {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .global-header {
      height: 54px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 0 18px;
      background: rgba(255,255,255,.94);
      border-bottom: 1px solid var(--border);
      backdrop-filter: blur(12px);
    }
    .global-brand {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      min-width: 250px;
    }
    .brand-icon {
      width: 26px;
      height: 26px;
      color: var(--accent);
    }
    .global-title {
      font-size: 16px;
      font-weight: 780;
      line-height: 1;
    }
    .offline {
      margin-left: 6px;
      border: 1px solid rgba(15, 118, 110, .22);
      border-radius: 6px;
      padding: 3px 7px;
      color: var(--accent);
      background: rgba(15, 118, 110, .08);
      font-size: 11px;
      font-weight: 650;
    }
    .global-meta {
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 16px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .global-path {
      max-width: 460px;
      overflow: hidden;
      text-overflow: ellipsis;
      color: #344054;
    }
    .shell {
      display: grid;
      grid-template-columns: 300px 1fr 340px;
      min-height: 0;
      flex: 1;
    }
    .panel {
      background: var(--surface);
      border-right: 1px solid var(--border);
      padding: 18px;
      overflow: auto;
    }
    .detail {
      border-right: 0;
      border-left: 1px solid var(--border);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 18px;
    }
    .workspace-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      display: flex;
      align-items: center;
      gap: 11px;
      margin-bottom: 14px;
      background: #fbfcfd;
    }
    .workspace-icon {
      width: 34px;
      height: 34px;
      border: 1px solid var(--border);
      border-radius: 7px;
      display: grid;
      place-items: center;
      color: var(--muted);
      background: #fff;
      flex: 0 0 auto;
    }
    .workspace-name {
      font-size: 13px;
      font-weight: 760;
      line-height: 1.2;
    }
    .workspace-label {
      margin-top: 2px;
      color: var(--muted);
      font-size: 12px;
    }
    .mark {
      width: 30px;
      height: 30px;
      border-radius: 8px;
      background: conic-gradient(from 180deg, #0f766e, #5b5fc7, #b83280, #c2410c, #0f766e);
    }
    h1 {
      margin: 0;
      font-size: 18px;
      line-height: 1.2;
      font-weight: 750;
      letter-spacing: 0;
    }
    h2 {
      margin: 22px 0 10px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .08em;
      color: var(--muted);
    }
    .meta {
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
      word-break: break-word;
    }
    input[type="search"] {
      width: 100%;
      height: 38px;
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 0 11px;
      color: var(--text);
      background: var(--surface);
      font-size: 14px;
      outline: none;
    }
    input[type="search"]:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(15, 118, 110, .14);
    }
    .check-row {
      display: flex;
      align-items: center;
      gap: 9px;
      margin: 8px 0;
      font-size: 13px;
      color: var(--text);
    }
    input[type="checkbox"] {
      appearance: none;
      width: 15px;
      height: 15px;
      border: 1px solid #aab7c6;
      border-radius: 4px;
      background: #fff;
      display: inline-grid;
      place-content: center;
      flex: 0 0 auto;
      margin: 0;
    }
    input[type="checkbox"]::before {
      content: "";
      width: 7px;
      height: 4px;
      border-left: 2px solid #ffffff;
      border-bottom: 2px solid #ffffff;
      background: transparent;
      transform: rotate(-45deg) scale(0);
      transform-origin: center;
    }
    input[type="checkbox"]:checked {
      border-color: var(--accent);
      background: var(--accent);
    }
    input[type="checkbox"]:checked::before {
      transform: rotate(-45deg) scale(1);
    }
    .check-row input { margin-top: 1px; }
    .canvas-wrap {
      min-width: 0;
      position: relative;
      display: flex;
      flex-direction: column;
    }
    .topbar {
      min-height: 58px;
      background: rgba(255, 255, 255, .88);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 16px;
      backdrop-filter: blur(10px);
    }
    .toolbar {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .segmented {
      display: inline-flex;
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      background: var(--surface);
    }
    .segmented button {
      border: 0;
      border-radius: 0;
      border-right: 1px solid var(--border);
      background: transparent;
      min-width: 64px;
    }
    .segmented button:last-child { border-right: 0; }
    .segmented button.active {
      background: var(--accent);
      color: #ffffff;
    }
    button {
      height: 32px;
      border: 1px solid var(--border);
      border-radius: 7px;
      background: var(--surface);
      color: var(--text);
      padding: 0 10px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    button:hover {
      border-color: #9fb2c7;
      background: #fbfcfd;
    }
    .toggle {
      min-height: 32px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--border);
      border-radius: 7px;
      background: var(--surface);
      padding: 0 9px;
      font-size: 12px;
      color: var(--text);
    }
    .stats {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .stat {
      border: 1px solid var(--border);
      background: var(--surface);
      border-radius: 7px;
      padding: 5px 8px;
      white-space: nowrap;
    }
    .warning {
      color: #8a3b12;
      border-color: #f0c492;
      background: #fff7ed;
    }
    .graph-stage {
      flex: 1;
      min-height: 0;
      position: relative;
      overflow: hidden;
    }
    .overview {
      position: absolute;
      inset: 0;
      overflow: auto;
      padding: 18px;
      background: var(--bg);
    }
    .overview.hidden { display: none; }
    .overview-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 14px;
    }
    .overview-title {
      margin: 0;
      font-size: 18px;
      line-height: 1.25;
      font-weight: 750;
    }
    .overview-subtitle {
      margin-top: 4px;
      color: var(--muted);
      font-size: 13px;
    }
    .overview-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .service-card, .result-row, .relation-row {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: 0 1px 2px rgba(24, 34, 48, .04);
    }
    .service-card {
      padding: 12px;
      cursor: pointer;
      min-height: 112px;
    }
    .service-card:hover, .result-row:hover {
      border-color: #9fb2c7;
      background: #fbfcfd;
    }
    .service-card.active {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(15, 118, 110, .12);
    }
    .service-card-title {
      font-size: 14px;
      line-height: 1.25;
      font-weight: 750;
      word-break: break-word;
    }
    .service-card-meta {
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .mini-bars {
      display: grid;
      gap: 5px;
      margin-top: 10px;
    }
    .mini-bar {
      height: 5px;
      border-radius: 999px;
      background: var(--surface-2);
      overflow: hidden;
    }
    .mini-bar span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: var(--accent);
    }
    .map-panel {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: 0 1px 2px rgba(24, 34, 48, .04);
      overflow: hidden;
      margin-bottom: 14px;
    }
    .map-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 14px;
      padding: 14px 16px 10px;
      border-bottom: 1px solid var(--border);
    }
    .map-title {
      margin: 0;
      font-size: 14px;
      font-weight: 780;
    }
    .map-subtitle {
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
    }
    .map-body {
      display: grid;
      grid-template-columns: minmax(270px, 38%) minmax(0, 1fr);
      min-height: 430px;
    }
    .service-rank {
      border-right: 1px solid var(--border);
      padding: 10px 0;
      background: linear-gradient(180deg, #fff, #fbfcfd);
    }
    .rank-row {
      display: grid;
      grid-template-columns: 26px 1fr 76px;
      gap: 8px;
      align-items: center;
      min-height: 36px;
      padding: 7px 14px;
      border-bottom: 1px solid #eef2f6;
      cursor: pointer;
    }
    .rank-row:hover, .rank-row.active {
      background: rgba(15, 118, 110, .07);
    }
    .rank-num {
      color: var(--muted);
      font-size: 11px;
      text-align: right;
    }
    .rank-name {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 720;
    }
    .dot {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      flex: 0 0 auto;
      background: var(--accent);
    }
    .rank-name span:last-child {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rank-meta {
      grid-column: 2 / 4;
      color: var(--muted);
      font-size: 11px;
      margin-top: -3px;
    }
    .activity {
      height: 18px;
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: 3px;
      justify-content: end;
      gap: 2px;
      align-items: end;
    }
    .activity span {
      display: block;
      width: 3px;
      border-radius: 99px;
      background: currentColor;
      opacity: .28;
    }
    .activity span.hot { opacity: .9; }
    .sankey-wrap {
      position: relative;
      padding: 14px 16px;
      min-height: 430px;
      overflow: hidden;
    }
    .sankey-title {
      position: absolute;
      top: 12px;
      left: 16px;
      color: var(--muted);
      font-size: 12px;
    }
    .sankey {
      width: 100%;
      height: 390px;
      display: block;
    }
    .sankey-node {
      fill: #fbfcfd;
      stroke: var(--border);
      stroke-width: 1;
      rx: 6;
      filter: drop-shadow(0 1px 2px rgba(24, 34, 48, .05));
    }
    .sankey-node.active {
      stroke: var(--accent);
      stroke-width: 2;
    }
    .sankey-strip {
      rx: 4;
    }
    .sankey-label {
      fill: #344054;
      font-size: 11px;
      font-weight: 700;
      pointer-events: none;
    }
    .sankey-link {
      fill: none;
      stroke-linecap: round;
      opacity: .3;
    }
    .sankey-link.active {
      opacity: .75;
      stroke-width: 3.5;
    }
    .overview-columns {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(280px, 420px);
      gap: 14px;
      align-items: start;
    }
    .data-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: 0 1px 2px rgba(24, 34, 48, .04);
      overflow: hidden;
    }
    .data-card-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      padding: 12px 14px 8px;
    }
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .data-table th {
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: .06em;
      font-weight: 750;
      text-align: left;
      padding: 8px 14px;
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      background: #fbfcfd;
    }
    .data-table td {
      padding: 9px 14px;
      border-bottom: 1px solid #eef2f6;
      vertical-align: middle;
    }
    .data-table tr {
      cursor: pointer;
    }
    .data-table tr:hover {
      background: rgba(15, 118, 110, .05);
    }
    .focus-shell {
      display: grid;
      grid-template-rows: auto minmax(430px, 1fr);
      gap: 14px;
      min-height: 100%;
    }
    .focus-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
    }
    .focus-title {
      margin: 0;
      font-size: 18px;
      font-weight: 780;
      line-height: 1.25;
    }
    .focus-subtitle {
      margin-top: 4px;
      color: var(--muted);
      font-size: 13px;
    }
    .edge-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: flex-end;
    }
    .edge-chip {
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 4px 8px;
      background: var(--surface);
      color: var(--muted);
      font-size: 11px;
      white-space: nowrap;
    }
    .focus-map-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      overflow: hidden;
      min-height: 480px;
      box-shadow: 0 1px 2px rgba(24, 34, 48, .04);
    }
    .dependency-map {
      width: 100%;
      height: 560px;
      min-height: 480px;
      display: block;
      background:
        linear-gradient(90deg, rgba(15, 118, 110, .045) 1px, transparent 1px),
        linear-gradient(rgba(15, 118, 110, .045) 1px, transparent 1px);
      background-size: 32px 32px;
    }
    .map-section-label {
      fill: var(--muted);
      font-size: 11px;
      font-weight: 760;
      text-transform: uppercase;
      letter-spacing: .06em;
    }
    .map-card {
      fill: #ffffff;
      stroke: #d9e0e8;
      stroke-width: 1;
      rx: 8;
      filter: drop-shadow(0 2px 5px rgba(24, 34, 48, .08));
      cursor: pointer;
    }
    g[data-node-id]:hover .map-card {
      stroke: #0f766e;
      stroke-width: 1.8;
    }
    .map-card.selected {
      stroke: var(--accent);
      stroke-width: 2.2;
      fill: rgba(15, 118, 110, .045);
    }
    .map-kind-strip {
      rx: 8;
    }
    .map-node-title {
      fill: #20242c;
      font-size: 12px;
      font-weight: 760;
    }
    .map-node-meta {
      fill: #657080;
      font-size: 10px;
    }
    .map-link {
      fill: none;
      stroke: #94a3b8;
      stroke-width: 1.5;
      opacity: .65;
    }
    .map-link.endpoint_handler { stroke: var(--endpoint); }
    .map-link.defined_in { stroke: var(--file); }
    .map-link.dependency { stroke: #3c7a2a; }
    .map-link.call { stroke: var(--symbol); stroke-dasharray: 4 4; }
    .map-link.cross_service { stroke: var(--service); stroke-width: 2.4; }
    .focus-lists {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
    }
    .mono-cell {
      color: #344054;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .section-title {
      margin: 0 0 9px;
      font-size: 13px;
      font-weight: 750;
      color: #344054;
    }
    .relation-list, .result-list {
      display: grid;
      gap: 8px;
    }
    .relation-row, .result-row {
      padding: 10px;
      font-size: 12px;
      line-height: 1.4;
    }
    .result-row {
      cursor: pointer;
    }
    .result-main {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .result-label {
      font-weight: 700;
      word-break: break-word;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 2px 7px;
      color: var(--muted);
      background: #fbfcfd;
      white-space: nowrap;
    }
    .result-file, .relation-meta {
      margin-top: 5px;
      color: var(--muted);
      word-break: break-word;
    }
    .empty-state {
      border: 1px dashed var(--border);
      border-radius: 8px;
      padding: 16px;
      color: var(--muted);
      background: rgba(255,255,255,.6);
      font-size: 13px;
    }
    #graph {
      width: 100%;
      height: 100%;
      min-height: 520px;
      display: block;
      background:
        linear-gradient(90deg, rgba(15, 118, 110, .05) 1px, transparent 1px),
        linear-gradient(rgba(15, 118, 110, .05) 1px, transparent 1px);
      background-size: 32px 32px;
    }
    .service-hull {
      fill: rgba(255,255,255,.42);
      stroke: #d9e0e8;
      stroke-width: 1.2;
      rx: 14;
    }
    .service-hull.active {
      fill: rgba(15, 118, 110, .07);
      stroke: var(--accent);
      stroke-width: 2;
    }
    .edge {
      stroke: var(--edge);
      stroke-width: 1.5;
      fill: none;
      opacity: .42;
      }
    .edge.cross_service { stroke: #c2410c; stroke-width: 2.7; opacity: .72; }
    .edge.endpoint_handler { stroke: #b83280; stroke-width: 2; }
    .edge.call { stroke: #5b5fc7; }
    .edge.dependency { stroke: #3c7a2a; }
    .node circle, .node rect {
      stroke: #ffffff;
      stroke-width: 2;
      filter: drop-shadow(0 3px 9px rgba(24, 34, 48, .18));
      cursor: pointer;
    }
    .node.service rect { fill: var(--service); }
    .node.endpoint circle { fill: var(--endpoint); }
    .node.symbol circle { fill: var(--symbol); }
    .node.file circle { fill: var(--file); }
    .node text {
      fill: #1f2933;
      font-size: 11px;
      paint-order: stroke;
      stroke: rgba(255,255,255,.92);
      stroke-width: 4px;
      stroke-linejoin: round;
      pointer-events: none;
      display: none;
    }
    .node.service text,
    .node.selected text,
    .node.match text,
    #graph.show-labels .node text {
      display: block;
    }
    .node.match circle, .node.match rect {
      stroke: #111827;
      stroke-width: 3;
    }
    .node.selected circle, .node.selected rect {
      stroke: #111827;
      stroke-width: 3;
    }
    .edge.selected {
      stroke: #111827;
      opacity: 1;
      stroke-width: 3;
    }
    .legend {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 10px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 7px;
      color: var(--muted);
      font-size: 12px;
    }
    .swatch {
      width: 11px;
      height: 11px;
      border-radius: 999px;
      background: var(--accent);
    }
    .group-list {
      display: grid;
      gap: 8px;
    }
    .group-item {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 9px;
      cursor: pointer;
      background: #fbfcfd;
    }
    .group-item:hover { border-color: #9fb2c7; }
    .group-item.active {
      border-color: var(--accent);
      background: rgba(15, 118, 110, .07);
    }
    .group-name {
      font-size: 13px;
      font-weight: 700;
    }
    .group-stats {
      margin-top: 5px;
      color: var(--muted);
      font-size: 12px;
    }
    .empty {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    .detail-title {
      margin: 0;
      font-size: 17px;
      line-height: 1.25;
      font-weight: 750;
      word-break: break-word;
    }
    .detail-kind {
      margin-top: 7px;
      display: inline-flex;
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 4px 7px;
      color: var(--muted);
      font-size: 12px;
    }
    .inspector-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 18px;
    }
    .inspector-title-row {
      display: flex;
      align-items: center;
      gap: 9px;
      min-width: 0;
    }
    .inspector-summary {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
      margin-top: 8px;
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      margin: 16px 0;
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      padding: 12px 0;
    }
    .metric {
      min-width: 0;
      color: var(--muted);
      font-size: 10px;
      text-align: center;
    }
    .metric strong {
      display: block;
      margin-top: 4px;
      color: var(--text);
      font-size: 14px;
      font-weight: 760;
    }
    .inspector-tabs {
      display: flex;
      gap: 18px;
      border-bottom: 1px solid var(--border);
      margin: 8px -18px 14px;
      padding: 0 18px;
    }
    .inspector-tabs button {
      border: 0;
      height: 34px;
      border-radius: 0;
      padding: 0;
      background: transparent;
      color: var(--muted);
      font-size: 12px;
    }
    .inspector-tabs button.active {
      color: var(--accent);
      box-shadow: inset 0 -2px 0 var(--accent);
    }
    .mini-list {
      display: grid;
      gap: 6px;
      margin-bottom: 16px;
    }
    .mini-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      align-items: center;
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 8px 9px;
      font-size: 12px;
      background: #fbfcfd;
    }
    .mini-row-main {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      color: #344054;
    }
    .primary-action {
      width: 100%;
      height: 36px;
      border-color: transparent;
      background: var(--accent);
      color: #fff;
      font-weight: 720;
      margin-top: 4px;
    }
    .secondary-action {
      width: 100%;
      height: 34px;
      margin-top: 8px;
      font-weight: 650;
    }
    dl {
      display: grid;
      grid-template-columns: 86px 1fr;
      gap: 8px 10px;
      margin: 18px 0;
      font-size: 13px;
    }
    dt { color: var(--muted); }
    dd { margin: 0; word-break: break-word; }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
      font-size: 12px;
      line-height: 1.45;
      max-height: 280px;
      overflow: auto;
    }
    @media (max-width: 1250px) {
      .shell { grid-template-columns: 260px 1fr; }
      .detail { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--border); }
      .overview-columns { grid-template-columns: 1fr; }
      .map-body { grid-template-columns: 1fr; }
      .service-rank { border-right: 0; border-bottom: 1px solid var(--border); }
      .sankey-wrap { min-height: 360px; }
    }
    @media (max-width: 760px) {
      .global-header {
        height: auto;
        min-height: 0;
        flex-direction: column;
        align-items: flex-start;
        justify-content: flex-start;
        gap: 6px;
        padding: 10px 14px;
      }
      .global-brand {
        min-width: 0;
        width: 100%;
        flex: 0 0 auto;
      }
      .global-meta {
        width: 100%;
        justify-content: flex-start;
        gap: 8px;
        flex-wrap: wrap;
        white-space: normal;
        font-size: 11px;
      }
      .global-path {
        max-width: 100%;
      }
      .shell { display: block; }
      .panel, .detail { border: 0; border-bottom: 1px solid var(--border); }
      .canvas-wrap { height: 70vh; }
      .topbar { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="app">
  <header class="global-header">
    <div class="global-brand">
      <svg class="brand-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3v5m0 0L6 13m6-5 6 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="12" cy="3" r="2" fill="currentColor"/>
        <circle cx="6" cy="13" r="2" fill="currentColor"/>
        <circle cx="18" cy="13" r="2" fill="currentColor"/>
        <path d="M6 15v4h12v-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <div><span class="global-title">CodeGraph Explorer</span><span class="offline">Offline</span></div>
    </div>
    <div class="global-meta">
      <span class="global-path" id="globalPath"></span>
      <span id="globalCounts"></span>
    </div>
  </header>
  <div class="shell">
    <aside class="panel">
      <div class="workspace-card">
        <div class="workspace-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H10l2 2h5.5A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-10Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
        </div>
        <div>
          <div class="workspace-name" id="workspaceName"></div>
          <div class="workspace-label">Workspace</div>
          <div class="meta" id="rootMeta"></div>
        </div>
      </div>
      <input id="search" type="search" placeholder="Search API, method, class">
      <h2>Node Kinds</h2>
      <div id="nodeFilters"></div>
      <h2>Edge Kinds</h2>
      <div id="edgeFilters"></div>
      <h2>Legend</h2>
      <div class="legend">
        <div class="legend-item"><span class="swatch" style="background: var(--service)"></span>Service</div>
        <div class="legend-item"><span class="swatch" style="background: var(--endpoint)"></span>Endpoint</div>
        <div class="legend-item"><span class="swatch" style="background: var(--symbol)"></span>Symbol</div>
        <div class="legend-item"><span class="swatch" style="background: var(--file)"></span>File</div>
      </div>
      <h2>Services</h2>
      <div id="groups" class="group-list"></div>
    </aside>
    <main class="canvas-wrap">
      <div class="topbar">
        <div class="stats" id="stats"></div>
        <div class="toolbar">
          <div class="stats" id="visibleStats"></div>
          <div class="segmented" aria-label="View mode">
            <button id="overviewModeBtn" type="button">Overview</button>
            <button id="focusModeBtn" type="button">Map</button>
            <button id="graphModeBtn" type="button">Search</button>
          </div>
          <button id="fitBtn" type="button">Fit</button>
          <button id="allServicesBtn" type="button">All Services</button>
          <label class="toggle"><input id="labelToggle" type="checkbox"> Labels</label>
        </div>
      </div>
      <div class="graph-stage">
        <div id="overview" class="overview"></div>
        <svg id="graph" viewBox="0 0 1600 1000" preserveAspectRatio="xMinYMin meet" role="img" aria-label="Code graph visualization"></svg>
      </div>
    </main>
    <aside class="panel detail">
      <div id="detail" class="empty">Select a node or edge to inspect indexed metadata.</div>
    </aside>
  </div>
  </div>
  <script type="application/json" id="graph-data">${graphJson}</script>
  <script>
    const graph = JSON.parse(document.getElementById('graph-data').textContent);
    const svg = document.getElementById('graph');
    const overview = document.getElementById('overview');
    const search = document.getElementById('search');
    const detail = document.getElementById('detail');
    const fitBtn = document.getElementById('fitBtn');
    const allServicesBtn = document.getElementById('allServicesBtn');
    const labelToggle = document.getElementById('labelToggle');
    const overviewModeBtn = document.getElementById('overviewModeBtn');
    const focusModeBtn = document.getElementById('focusModeBtn');
    const graphModeBtn = document.getElementById('graphModeBtn');
    const allNodeKinds = graph.nodes.map(node => node.kind);
    const allEdgeKinds = graph.edges.map(edge => edge.kind);
    const defaultNodeKinds = new Set(allNodeKinds);
    const defaultEdgeKinds = new Set(allEdgeKinds);
    if (graph.nodes.length > 450) defaultNodeKinds.delete('symbol');
    if (graph.edges.length > 250) {
      defaultEdgeKinds.delete('defined_in');
      defaultEdgeKinds.delete('call');
    }
    const defaultServiceId = [...graph.groups]
      .sort((a, b) => groupWeight(b) - groupWeight(a) || a.label.localeCompare(b.label))[0]?.id || '';
    const state = {
      query: '',
      nodeKinds: defaultNodeKinds,
      edgeKinds: defaultEdgeKinds,
      selectedId: defaultServiceId,
      activeServiceId: defaultServiceId,
      mode: 'overview',
      showLabels: false,
    };
    const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
    const edgeById = new Map(graph.edges.map(edge => [edge.id, edge]));
    const adjacency = new Map();
    const incomingByNode = new Map();
    const outgoingByNode = new Map();
    for (const edge of graph.edges) {
      if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
      if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set());
      adjacency.get(edge.from).add(edge.to);
      adjacency.get(edge.to).add(edge.from);
      addToMapList(outgoingByNode, edge.from, edge);
      addToMapList(incomingByNode, edge.to, edge);
    }
    const nodesByService = new Map();
    const nodesByFile = new Map();
    for (const node of graph.nodes) {
      if (node.serviceId) addToMapList(nodesByService, node.serviceId, node);
      if (node.file) addToMapList(nodesByFile, node.file, node);
    }
    const layout = layoutGraph(graph);
    const positions = layout.positions;
    let view = { x: -40, y: -40, width: layout.width + 80, height: layout.height + 80 };
    let isPanning = false;
    let panStart = { x: 0, y: 0, viewX: 0, viewY: 0 };

    document.getElementById('rootMeta').textContent = compactPath(graph.metadata.root);
    document.getElementById('workspaceName').textContent = workspaceName(graph.metadata.root);
    document.getElementById('globalPath').textContent = graph.metadata.root;
    document.getElementById('globalCounts').textContent = graph.stats.files + ' files / ' + graph.stats.symbols + ' symbols / ' + graph.stats.endpoints + ' endpoints';
    search.value = state.query;
    renderFilters('nodeFilters', uniqueSorted(allNodeKinds), 'nodeKinds');
    renderFilters('edgeFilters', uniqueSorted(allEdgeKinds), 'edgeKinds');
    renderGroups();
    renderStats();
    fitActiveView();
    render();

    search.addEventListener('input', event => {
      state.query = event.target.value.trim().toLowerCase();
      if (state.query) {
        state.mode = 'overview';
        state.selectedId = '';
      }
      render();
    });
    search.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || !state.query) return;
      const first = searchResults()[0];
      if (first) openNode(first.id);
    });
    fitBtn.addEventListener('click', () => fitActiveView());
    allServicesBtn.addEventListener('click', () => {
      state.activeServiceId = '';
      state.selectedId = '';
      state.mode = 'overview';
      renderGroups();
      fitActiveView();
      render();
    });
    overviewModeBtn.addEventListener('click', () => {
      state.mode = 'overview';
      render();
    });
    focusModeBtn.addEventListener('click', () => {
      state.mode = state.activeServiceId ? 'focus' : 'overview';
      fitActiveView();
      render();
    });
    graphModeBtn.addEventListener('click', () => {
      state.mode = 'overview';
      state.selectedId = '';
      render();
      search.focus();
    });
    labelToggle.addEventListener('change', event => {
      state.showLabels = event.target.checked;
      render();
    });
    overview.addEventListener('click', event => {
      const target = event.target;
      const edgeTarget = target.closest ? target.closest('[data-edge-id]') : null;
      if (edgeTarget && overview.contains(edgeTarget)) {
        const edge = edgeById.get(edgeTarget.getAttribute('data-edge-id'));
        if (!edge) return;
        state.selectedId = edge.id;
        showDetail(edge);
        return;
      }
      const serviceTarget = target.closest ? target.closest('[data-service-id]') : null;
      if (serviceTarget && overview.contains(serviceTarget)) {
        openService(serviceTarget.getAttribute('data-service-id'));
        return;
      }
      const nodeTarget = target.closest ? target.closest('[data-node-id]') : null;
      if (nodeTarget && overview.contains(nodeTarget)) {
        openNode(nodeTarget.getAttribute('data-node-id'));
      }
    });
    svg.addEventListener('wheel', event => {
      event.preventDefault();
      const point = svgPoint(event);
      const scale = event.deltaY < 0 ? 0.86 : 1.16;
      const nextWidth = clamp(view.width * scale, 180, layout.width + 220);
      const nextHeight = clamp(view.height * scale, 120, layout.height + 220);
      const ratioX = (point.x - view.x) / view.width;
      const ratioY = (point.y - view.y) / view.height;
      view = {
        x: point.x - nextWidth * ratioX,
        y: point.y - nextHeight * ratioY,
        width: nextWidth,
        height: nextHeight,
      };
      setViewBox(view);
    }, { passive: false });
    svg.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      isPanning = true;
      panStart = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y };
      svg.setPointerCapture(event.pointerId);
    });
    svg.addEventListener('pointermove', event => {
      if (!isPanning) return;
      const rect = svg.getBoundingClientRect();
      const dx = (event.clientX - panStart.x) / rect.width * view.width;
      const dy = (event.clientY - panStart.y) / rect.height * view.height;
      view = { ...view, x: panStart.viewX - dx, y: panStart.viewY - dy };
      setViewBox(view);
    });
    svg.addEventListener('pointerup', () => { isPanning = false; });
    svg.addEventListener('pointerleave', () => { isPanning = false; });

    function renderFilters(targetId, values, stateKey) {
      const target = document.getElementById(targetId);
      target.innerHTML = '';
      for (const value of values) {
        const id = targetId + '-' + value;
        const row = document.createElement('label');
        row.className = 'check-row';
        row.innerHTML = '<input id="' + escapeAttr(id) + '" type="checkbox"' + (state[stateKey].has(value) ? ' checked' : '') + '> <span>' + escapeHtml(value) + '</span>';
        target.appendChild(row);
        row.querySelector('input').addEventListener('change', event => {
          if (event.target.checked) state[stateKey].add(value);
          else state[stateKey].delete(value);
          render();
        });
      }
    }

    function renderGroups() {
      const target = document.getElementById('groups');
      target.innerHTML = '';
      for (const group of graph.groups) {
        const item = document.createElement('div');
        item.className = 'group-item' + (state.activeServiceId === group.id ? ' active' : '');
        item.innerHTML = '<div class="group-name">' + escapeHtml(group.label) + '</div>'
          + '<div class="group-stats">' + group.stats.files + ' files &middot; ' + group.stats.symbols + ' symbols &middot; ' + group.stats.endpoints + ' endpoints</div>';
        item.addEventListener('click', () => {
          state.activeServiceId = state.activeServiceId === group.id ? '' : group.id;
          state.selectedId = group.id;
          state.mode = state.activeServiceId ? 'focus' : 'overview';
          renderGroups();
          fitActiveView();
          render();
          showDetail(nodeById.get(group.id) || { id: group.id, kind: 'service', label: group.label, meta: group });
        });
        target.appendChild(item);
      }
    }

    function renderStats() {
      const stats = document.getElementById('stats');
      stats.innerHTML = [
        stat('nodes', graph.nodes.length),
        stat('edges', graph.edges.length),
        stat('files', graph.stats.files),
        stat('symbols', graph.stats.symbols),
        stat('endpoints', graph.stats.endpoints),
        graph.metadata.truncated ? stat('truncated', graph.stats.hiddenNodes + ' nodes, ' + graph.stats.hiddenEdges + ' edges hidden', 'warning') : ''
      ].join('');
    }

    function stat(label, value, extra) {
      return '<span class="stat ' + (extra || '') + '">' + escapeHtml(label) + ': ' + escapeHtml(String(value)) + '</span>';
    }

    function render() {
      renderModeButtons();
      if (state.mode === 'overview') {
        overview.classList.remove('hidden');
        svg.style.display = 'none';
        renderOverview();
        document.getElementById('visibleStats').innerHTML = stat('visible', visibleNodes().size + ' nodes / overview');
        return;
      }
      if (state.mode === 'focus') {
        overview.classList.remove('hidden');
        svg.style.display = 'none';
        renderFocusMap();
        return;
      }
      overview.classList.add('hidden');
      svg.style.display = 'block';
      const visibleNodeIds = visibleNodes();
      const visibleEdges = graph.edges.filter(edge =>
        state.edgeKinds.has(edge.kind) && visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to)
      );
      document.getElementById('visibleStats').innerHTML = stat('visible', visibleNodeIds.size + ' nodes / ' + visibleEdges.length + ' edges');
      svg.classList.toggle('show-labels', state.showLabels);
      svg.innerHTML = '<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#9aa5b1"></path></marker></defs>';
      const hullLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      const edgeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      const nodeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      svg.appendChild(hullLayer);
      svg.appendChild(edgeLayer);
      svg.appendChild(nodeLayer);
      for (const [serviceId, bounds] of layout.serviceBounds) {
        const serviceNode = nodeById.get(serviceId);
        if (!serviceNode || !visibleNodeIds.has(serviceId)) continue;
        const hull = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        hull.setAttribute('x', String(bounds.x));
        hull.setAttribute('y', String(bounds.y));
        hull.setAttribute('width', String(bounds.width));
        hull.setAttribute('height', String(bounds.height));
        hull.setAttribute('rx', '14');
        hull.setAttribute('class', 'service-hull' + (state.activeServiceId === serviceId ? ' active' : ''));
        hullLayer.appendChild(hull);
      }
      for (const edge of visibleEdges) {
        const from = positions.get(edge.from);
        const to = positions.get(edge.to);
        if (!from || !to) continue;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', from.x);
        line.setAttribute('y1', from.y);
        line.setAttribute('x2', to.x);
        line.setAttribute('y2', to.y);
        line.setAttribute('class', 'edge ' + edge.kind + (state.selectedId === edge.id ? ' selected' : ''));
        line.setAttribute('marker-end', 'url(#arrow)');
        line.addEventListener('click', () => {
          state.selectedId = edge.id;
          showDetail(edge);
          render();
        });
        edgeLayer.appendChild(line);
      }
      for (const node of graph.nodes) {
        if (!visibleNodeIds.has(node.id)) continue;
        const pos = positions.get(node.id);
        if (!pos) continue;
        const isMatch = state.query && nodeMatchesQuery(node);
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('class', 'node ' + node.kind + (state.selectedId === node.id ? ' selected' : '') + (isMatch ? ' match' : ''));
        group.setAttribute('transform', 'translate(' + pos.x + ' ' + pos.y + ')');
        if (node.kind === 'service') {
          const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          rect.setAttribute('x', '-14');
          rect.setAttribute('y', '-14');
          rect.setAttribute('width', '28');
          rect.setAttribute('height', '28');
          rect.setAttribute('rx', '7');
          group.appendChild(rect);
        } else {
          const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          circle.setAttribute('r', node.kind === 'endpoint' ? '10' : node.kind === 'symbol' ? '8' : '7');
          group.appendChild(circle);
        }
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', '13');
        label.setAttribute('y', '4');
        label.textContent = shorten(node.label, node.kind === 'service' ? 28 : 34);
        group.appendChild(label);
        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.textContent = node.label + (node.file ? '\\n' + node.file : '');
        group.appendChild(title);
        group.addEventListener('click', () => {
          state.selectedId = node.id;
          if (node.kind === 'service') {
            state.activeServiceId = state.activeServiceId === node.id ? '' : node.id;
            renderGroups();
            fitActiveView();
          }
          showDetail(node);
          render();
        });
        nodeLayer.appendChild(group);
      }
      if (state.selectedId && nodeById.has(state.selectedId)) showDetail(nodeById.get(state.selectedId));
      if (state.selectedId && edgeById.has(state.selectedId)) showDetail(edgeById.get(state.selectedId));
    }

    function renderModeButtons() {
      overviewModeBtn.classList.toggle('active', state.mode === 'overview');
      focusModeBtn.classList.toggle('active', state.mode === 'focus');
      graphModeBtn.classList.toggle('active', Boolean(state.query) && state.mode === 'overview');
    }

    function renderFocusMap() {
      const selected = nodeById.get(state.selectedId)
        || nodeById.get(state.activeServiceId)
        || graph.nodes.find(node => state.query && nodeMatchesQuery(node))
        || graph.nodes.find(node => node.kind === 'endpoint')
        || graph.nodes[0];
      if (!selected) {
        overview.innerHTML = '<div class="empty-state">No node is available in this export.</div>';
        return;
      }
      state.selectedId = selected.id;
      if (selected.serviceId || selected.kind === 'service') {
        state.activeServiceId = selected.kind === 'service' ? selected.id : selected.serviceId;
      }
      const relation = relationForNode(selected);
      const chips = relation.allKinds.map(kind => '<span class="edge-chip">' + escapeHtml(kind) + ' / ' + relation.edges.filter(edge => edge.kind === kind).length + '</span>').join('');
      overview.innerHTML = '<div class="focus-shell">'
        + '<div class="focus-head"><div><h1 class="focus-title">Dependency Map</h1>'
        + '<div class="focus-subtitle">' + escapeHtml(selected.label) + ' / ' + relation.edges.length + ' linked edge' + (relation.edges.length === 1 ? '' : 's') + '</div></div>'
        + '<div class="edge-chips">' + chips + '</div></div>'
        + '<section class="focus-map-card">' + renderDependencyMap(selected, relation) + '</section>'
        + '<div class="focus-lists">'
        + renderRelatedList('Incoming', relation.incoming, edge => edge.from)
        + renderRelatedList('Outgoing', relation.outgoing, edge => edge.to)
        + renderNodeList('Under Nodes', relation.underNodes)
        + '</div>'
        + '</div>';
      document.getElementById('visibleStats').innerHTML = stat('visible', relation.nodes.length + ' nodes / ' + relation.edges.length + ' edges');
      showDetail(selected);
    }

    function relationForNode(selected) {
      const incident = uniqueEdges([...(incomingByNode.get(selected.id) || []), ...(outgoingByNode.get(selected.id) || [])]);
      const serviceIncident = selected.kind === 'service'
        ? graph.edges.filter(edge => edge.kind === 'cross_service' && (edge.from === selected.id || edge.to === selected.id))
        : [];
      const underNodes = underNodesForNode(selected);
      const underNodeIds = new Set(underNodes.map(node => node.id));
      const underEdges = graph.edges.filter(edge =>
        (underNodeIds.has(edge.from) && (underNodeIds.has(edge.to) || edge.to === selected.id))
        || (underNodeIds.has(edge.to) && (underNodeIds.has(edge.from) || edge.from === selected.id))
      );
      const handlerCallEdges = handlerNodesFor(selected).flatMap(node =>
        [...(incomingByNode.get(node.id) || []), ...(outgoingByNode.get(node.id) || [])]
          .filter(edge => edge.kind === 'call' || edge.kind === 'dependency')
      );
      const fileDependencyEdges = selected.kind === 'file'
        ? graph.edges.filter(edge => edge.kind === 'dependency' && (edge.from === selected.id || edge.to === selected.id))
        : [];
      const fileContext = selected.file
        ? graph.edges.filter(edge => {
          const from = nodeById.get(edge.from);
          const to = nodeById.get(edge.to);
          return from?.file === selected.file || to?.file === selected.file;
        })
        : [];
      const serviceContext = selected.serviceId
        ? graph.edges.filter(edge => {
          const from = nodeById.get(edge.from);
          const to = nodeById.get(edge.to);
          return (from?.serviceId === selected.serviceId || to?.serviceId === selected.serviceId)
            && edge.kind !== 'defined_in';
        })
        : [];
      const edges = rankRelationEdges(
        uniqueEdges([...incident, ...serviceIncident, ...handlerCallEdges, ...fileDependencyEdges, ...underEdges, ...fileContext, ...serviceContext]),
        selected,
        underNodeIds,
      ).slice(0, 96);
      const incoming = edges.filter(edge => edge.to === selected.id || (selected.kind === 'service' && edge.to === selected.id));
      const outgoing = edges.filter(edge => edge.from === selected.id || (selected.kind === 'service' && edge.from === selected.id));
      const contextEdges = edges.filter(edge => !incoming.includes(edge) && !outgoing.includes(edge)).slice(0, 24);
      const nodeIds = new Set([selected.id]);
      for (const node of underNodes) nodeIds.add(node.id);
      for (const edge of edges) {
        nodeIds.add(edge.from);
        nodeIds.add(edge.to);
      }
      const nodes = [...nodeIds].map(id => nodeById.get(id)).filter(Boolean);
      const allKinds = uniqueSorted(edges.map(edge => edge.kind));
      return { edges, incoming, outgoing, contextEdges, underNodes, nodes, allKinds };
    }

    function handlerNodesFor(selected) {
      if (selected.kind === 'endpoint') {
        return (outgoingByNode.get(selected.id) || [])
          .filter(edge => edge.kind === 'endpoint_handler')
          .map(edge => nodeById.get(edge.to))
          .filter(Boolean);
      }
      if (selected.kind === 'symbol') return [selected];
      return [];
    }

    function underNodesForNode(selected) {
      if (selected.kind === 'service') {
        return childRank((nodesByService.get(selected.id) || []).filter(node => node.id !== selected.id)).slice(0, 18);
      }
      if (selected.kind === 'file') {
        const fromDefinedIn = (incomingByNode.get(selected.id) || [])
          .filter(edge => edge.kind === 'defined_in')
          .map(edge => nodeById.get(edge.from))
          .filter(Boolean);
        return childRank(uniqueNodes([...(nodesByFile.get(selected.file) || []), ...fromDefinedIn]).filter(node => node.id !== selected.id)).slice(0, 24);
      }
      if (selected.kind === 'endpoint') {
        const handlers = handlerNodesFor(selected);
        const files = (outgoingByNode.get(selected.id) || [])
          .filter(edge => edge.kind === 'defined_in')
          .map(edge => nodeById.get(edge.to))
          .filter(Boolean);
        const calls = handlers.flatMap(node => callNeighbors(node.id));
        return childRank(uniqueNodes([...handlers, ...calls, ...files])).slice(0, 18);
      }
      if (selected.kind === 'symbol') {
        const endpoints = (incomingByNode.get(selected.id) || [])
          .filter(edge => edge.kind === 'endpoint_handler')
          .map(edge => nodeById.get(edge.from))
          .filter(Boolean);
        const files = (outgoingByNode.get(selected.id) || [])
          .filter(edge => edge.kind === 'defined_in')
          .map(edge => nodeById.get(edge.to))
          .filter(Boolean);
        const calls = callNeighbors(selected.id);
        const sameFile = selected.file ? (nodesByFile.get(selected.file) || []).filter(node => node.id !== selected.id).slice(0, 8) : [];
        return childRank(uniqueNodes([...endpoints, ...calls, ...files, ...sameFile])).slice(0, 18);
      }
      return [];
    }

    function callNeighbors(nodeId) {
      return uniqueNodes([...(incomingByNode.get(nodeId) || []), ...(outgoingByNode.get(nodeId) || [])]
        .filter(edge => edge.kind === 'call')
        .map(edge => nodeById.get(edge.from === nodeId ? edge.to : edge.from))
        .filter(Boolean));
    }

    function rankRelationEdges(edges, selected, underNodeIds) {
      return [...edges].sort((a, b) => relationEdgeScore(b, selected, underNodeIds) - relationEdgeScore(a, selected, underNodeIds) || a.id.localeCompare(b.id));
    }

    function relationEdgeScore(edge, selected, underNodeIds) {
      let score = 0;
      if (edge.from === selected.id || edge.to === selected.id) score += 10000;
      if (underNodeIds.has(edge.from) || underNodeIds.has(edge.to)) score += 2200;
      if (edge.kind === 'endpoint_handler') score += 7000;
      else if (edge.kind === 'call') score += 6200;
      else if (edge.kind === 'dependency') score += 5200;
      else if (edge.kind === 'cross_service') score += 4300;
      else if (edge.kind === 'defined_in') score += 3400;
      score += Math.round(Number(edge.confidence || 0) * 100);
      return score;
    }

    function childRank(nodes) {
      return [...nodes].sort((a, b) => childScore(b) - childScore(a) || a.label.localeCompare(b.label));
    }

    function childScore(node) {
      let score = 0;
      if (node.kind === 'endpoint') score += 5000;
      else if (node.kind === 'symbol') score += 4000;
      else if (node.kind === 'file') score += 3000;
      else if (node.kind === 'service') score += 2000;
      const role = String(node.role || '').toLowerCase();
      if (role.includes('controller') || role.includes('resource')) score += 900;
      if (role.includes('service')) score += 700;
      if (role.includes('repository') || role.includes('dao')) score += 500;
      if (role.includes('entity') || role.includes('model')) score += 350;
      score += (incomingByNode.get(node.id) || []).length + (outgoingByNode.get(node.id) || []).length;
      return score;
    }

    function renderDependencyMap(selected, relation) {
      const incoming = relation.incoming.slice(0, 9);
      const outgoing = relation.outgoing.slice(0, 9);
      const context = relation.contextEdges.slice(0, 8);
      const leftNodes = incoming.map(edge => nodeById.get(edge.from)).filter(Boolean);
      const rightNodes = outgoing.map(edge => nodeById.get(edge.to)).filter(Boolean);
      const sideNodeIds = new Set([...leftNodes, ...rightNodes].map(node => node.id));
      const bottomNodes = childRank(uniqueNodes([
        ...relation.underNodes,
        ...context.flatMap(edge => [nodeById.get(edge.from), nodeById.get(edge.to)]),
      ]))
        .filter(node => node.id !== selected.id && !sideNodeIds.has(node.id));
      const center = { x: 405, y: 205, width: 210, height: 72 };
      const left = placeMapNodes(leftNodes, 36, 76, 210, 56, 42);
      const right = placeMapNodes(rightNodes, 664, 76, 210, 56, 42);
      const bottom = placeMapGridNodes(bottomNodes, 160, 360, 186, 46, 16, 10, 3, 12);
      const nodePos = new Map([[selected.id, center]]);
      for (const item of [...left, ...right, ...bottom]) nodePos.set(item.node.id, item.box);
      const links = relation.edges.slice(0, 72).map(edge => {
        const from = nodePos.get(edge.from);
        const to = nodePos.get(edge.to);
        if (!from || !to) return '';
        const start = anchor(from, edge.from === selected.id ? 'right' : from.x < center.x ? 'right' : 'left');
        const end = anchor(to, edge.to === selected.id ? 'left' : to.x > center.x ? 'left' : 'right');
        const c1 = start.x + (end.x - start.x) * .45;
        const c2 = start.x + (end.x - start.x) * .55;
        return '<path class="map-link ' + edge.kind + '" data-edge-id="' + escapeAttr(edge.id) + '" d="M ' + start.x + ' ' + start.y + ' C ' + c1 + ' ' + start.y + ', ' + c2 + ' ' + end.y + ', ' + end.x + ' ' + end.y + '"></path>';
      }).join('');
      return '<svg class="dependency-map" viewBox="0 0 920 600" preserveAspectRatio="xMidYMid meet">'
        + '<text class="map-section-label" x="36" y="36">Incoming</text>'
        + '<text class="map-section-label" x="405" y="36">Selected Node</text>'
        + '<text class="map-section-label" x="664" y="36">Outgoing</text>'
        + '<text class="map-section-label" x="160" y="342">Under Nodes / Related Calls</text>'
        + links
        + left.map(item => mapNode(item.node, item.box)).join('')
        + mapNode(selected, center, true)
        + right.map(item => mapNode(item.node, item.box)).join('')
        + bottom.map(item => mapNode(item.node, item.box)).join('')
        + '</svg>';
    }

    function placeMapNodes(nodes, x, y, width, height, gap) {
      return uniqueNodes(nodes).slice(0, 9).map((node, index) => ({
        node,
        box: { x, y: y + index * (height + gap), width, height },
      }));
    }

    function placeMapGridNodes(nodes, x, y, width, height, colGap, rowGap, columns, maxItems) {
      return uniqueNodes(nodes).slice(0, maxItems).map((node, index) => ({
        node,
        box: {
          x: x + (index % columns) * (width + colGap),
          y: y + Math.floor(index / columns) * (height + rowGap),
          width,
          height,
        },
      }));
    }

    function mapNode(node, box, selected) {
      const color = nodeColor(node);
      return '<g data-node-id="' + escapeAttr(node.id) + '">'
        + '<rect class="map-card' + (selected ? ' selected' : '') + '" x="' + box.x + '" y="' + box.y + '" width="' + box.width + '" height="' + box.height + '" rx="8"></rect>'
        + '<rect class="map-kind-strip" x="' + box.x + '" y="' + box.y + '" width="6" height="' + box.height + '" fill="' + color + '"></rect>'
        + '<text class="map-node-title" x="' + (box.x + 16) + '" y="' + (box.y + 23) + '">' + escapeHtml(shorten(node.label, selected ? 28 : 24)) + '</text>'
        + '<text class="map-node-meta" x="' + (box.x + 16) + '" y="' + (box.y + 43) + '">' + escapeHtml(shorten(node.kind + (node.file ? ' / ' + node.file : ''), selected ? 36 : 30)) + '</text>'
        + '</g>';
    }

    function renderRelatedList(title, edges, nodeIdForEdge) {
      const rows = edges.slice(0, 8).map(edge => {
        const node = nodeById.get(nodeIdForEdge(edge));
        return '<div class="result-row" data-node-id="' + escapeAttr(node?.id || '') + '">'
          + '<div class="result-main"><div class="result-label">' + escapeHtml(node?.label || 'Unknown') + '</div><span class="pill">' + escapeHtml(edge.kind) + '</span></div>'
          + '<div class="result-file">' + escapeHtml(node?.file || serviceLabel(node?.serviceId) || '') + '</div>'
          + '</div>';
      }).join('');
      return '<section class="data-card"><div class="data-card-head"><h2 class="section-title">' + escapeHtml(title) + '</h2></div>'
        + (rows ? '<div class="result-list" style="padding: 0 12px 12px">' + rows + '</div>' : '<div class="empty-state">No linked nodes in this capped export.</div>')
        + '</section>';
    }

    function renderNodeList(title, nodes) {
      const rows = nodes.slice(0, 10).map(node => {
        return '<div class="result-row" data-node-id="' + escapeAttr(node.id) + '">'
          + '<div class="result-main"><div class="result-label">' + escapeHtml(node.label) + '</div><span class="pill">' + escapeHtml(node.kind) + '</span></div>'
          + '<div class="result-file">' + escapeHtml(node.file || serviceLabel(node.serviceId) || '') + '</div>'
          + '</div>';
      }).join('');
      return '<section class="data-card"><div class="data-card-head"><h2 class="section-title">' + escapeHtml(title) + '</h2></div>'
        + (rows ? '<div class="result-list" style="padding: 0 12px 12px">' + rows + '</div>' : '<div class="empty-state">No child nodes in this capped export.</div>')
        + '</section>';
    }

    function anchor(box, side) {
      return {
        x: side === 'left' ? box.x : box.x + box.width,
        y: box.y + box.height / 2,
      };
    }

    function renderOverview() {
      const groups = [...graph.groups].sort((a, b) => groupWeight(b) - groupWeight(a) || a.label.localeCompare(b.label));
      const body = state.query
        ? renderSearchResults()
        : renderServiceMap(groups)
          + '<div class="overview-columns">'
          + renderEndpointHotspots()
          + renderRelations()
          + '</div>';
      overview.innerHTML = '<div class="overview-head">'
        + '<div><h1 class="overview-title">' + (state.query ? 'Search Results' : 'Service Overview') + '</h1>'
        + '<div class="overview-subtitle">' + graph.groups.length + ' services &middot; ' + graph.nodes.length + ' exported nodes &middot; ' + graph.edges.length + ' exported edges</div></div>'
        + '</div>' + body;
      if (nodeById.has(state.selectedId)) showDetail(nodeById.get(state.selectedId));
      else if (nodeById.has(state.activeServiceId)) showDetail(nodeById.get(state.activeServiceId));
    }

    function renderServiceMap(groups) {
      const top = groups.slice(0, 12);
      return '<section class="map-panel">'
        + '<div class="map-head"><div><h2 class="map-title">Service Map</h2><div class="map-subtitle">High-level service boundaries and cross-service dependencies</div></div>'
        + '<button type="button">Top ' + top.length + ' services</button></div>'
        + '<div class="map-body"><div class="service-rank">' + renderServiceRank(top) + '</div>'
        + '<div class="sankey-wrap"><div class="sankey-title">Dependencies (line weight = exported edges)</div>' + renderSankey(top) + '</div></div>'
        + '</section>';
    }

    function renderServiceRank(groups) {
      const maxWeight = Math.max(1, ...groups.map(groupWeight));
      return groups.map((group, index) => {
        const color = serviceColor(group.id);
        const activity = activityBars(groupWeight(group), maxWeight, color);
        return '<div class="rank-row' + (state.activeServiceId === group.id ? ' active' : '') + '" data-service-id="' + escapeAttr(group.id) + '">'
          + '<div class="rank-num">' + (index + 1) + '</div>'
          + '<div class="rank-name"><span class="dot" style="background:' + color + '"></span><span>' + escapeHtml(group.label) + '</span></div>'
          + '<div class="activity" style="color:' + color + '">' + activity + '</div>'
          + '<div class="rank-meta">' + Number(group.stats.files || 0) + ' files / ' + Number(group.stats.endpoints || 0) + ' endpoints</div>'
          + '</div>';
      }).join('');
    }

    function renderSankey(groups) {
      const groupIds = new Set(groups.map(group => group.id));
      const relations = graph.edges
        .filter(edge => edge.kind === 'cross_service' && groupIds.has(edge.from) && groupIds.has(edge.to))
        .sort((a, b) => Number(b.meta?.count || 0) - Number(a.meta?.count || 0))
        .slice(0, 28);
      const left = groups.slice(0, 7);
      const rightIds = new Set(relations.map(edge => edge.to));
      const right = groups.filter(group => rightIds.has(group.id)).slice(0, 7);
      while (right.length < Math.min(7, groups.length)) {
        const next = groups.find(group => !right.some(item => item.id === group.id));
        if (!next) break;
        right.push(next);
      }
      const leftY = new Map(left.map((group, index) => [group.id, 62 + index * 48]));
      const rightY = new Map(right.map((group, index) => [group.id, 62 + index * 48]));
      const links = relations
        .filter(edge => leftY.has(edge.from) && rightY.has(edge.to))
        .map(edge => {
          const count = Number(edge.meta?.count || 1);
          const width = Math.max(1.2, Math.min(8, 1 + Math.log2(count + 1)));
          const color = serviceColor(edge.from);
          const y1 = leftY.get(edge.from) + 15;
          const y2 = rightY.get(edge.to) + 15;
          return '<path class="sankey-link' + (state.selectedId === edge.id ? ' active' : '') + '" data-edge-id="' + escapeAttr(edge.id) + '" d="M 180 ' + y1 + ' C 300 ' + y1 + ', 390 ' + y2 + ', 510 ' + y2 + '" stroke="' + color + '" stroke-width="' + width + '"></path>';
        }).join('');
      const leftNodes = left.map(group => sankeyNode(group, 32, leftY.get(group.id) || 0)).join('');
      const rightNodes = right.map(group => sankeyNode(group, 510, rightY.get(group.id) || 0)).join('');
      return '<svg class="sankey" viewBox="0 0 700 390" preserveAspectRatio="xMidYMid meet">'
        + links + leftNodes + rightNodes + '</svg>';
    }

    function sankeyNode(group, x, y) {
      const color = serviceColor(group.id);
      return '<g data-service-id="' + escapeAttr(group.id) + '">'
        + '<rect class="sankey-node' + (state.activeServiceId === group.id ? ' active' : '') + '" x="' + x + '" y="' + y + '" width="150" height="32" rx="6"></rect>'
        + '<rect class="sankey-strip" x="' + x + '" y="' + y + '" width="6" height="32" fill="' + color + '"></rect>'
        + '<text class="sankey-label" x="' + (x + 16) + '" y="' + (y + 21) + '">' + escapeHtml(shorten(group.label, 22)) + '</text>'
        + '</g>';
    }

    function renderSearchResults() {
      const results = searchResults();
      if (!results.length) return '<div class="empty-state">No indexed node matched this search.</div>';
      return '<div class="data-card"><div class="data-card-head"><div><h2 class="section-title">Search Results</h2><div class="map-subtitle">Click a result to open its dependency map. Press Enter to open the first result.</div></div><span class="pill">' + results.length + ' results</span></div>'
        + '<div class="result-list" style="padding: 0 12px 12px">' + results.map(node => {
        const service = serviceLabel(node.serviceId || (node.kind === 'service' ? node.id : ''));
        return '<div class="result-row" data-node-id="' + escapeAttr(node.id) + '">'
          + '<div class="result-main"><div class="result-label">' + escapeHtml(node.label) + '</div><span class="pill">' + escapeHtml(node.kind) + '</span></div>'
          + '<div class="result-file">' + escapeHtml([service, node.file].filter(Boolean).join(' / ')) + '</div>'
          + '</div>';
      }).join('') + '</div></div>';
    }

    function searchResults() {
      if (!state.query) return [];
      return graph.nodes
        .filter(node => nodeMatchesQuery(node))
        .sort(nodeSort)
        .slice(0, 120);
    }

    function renderRelations() {
      const relations = graph.edges
        .filter(edge => edge.kind === 'cross_service')
        .sort((a, b) => Number(b.meta?.count || 0) - Number(a.meta?.count || 0) || serviceLabel(a.from).localeCompare(serviceLabel(b.from)))
        .slice(0, 8);
      if (!relations.length) return '<section class="data-card"><div class="data-card-head"><h2 class="section-title">Cross-Service Dependencies</h2></div><div class="empty-state">No cross-service edges in this capped export.</div></section>';
      return '<section class="data-card"><div class="data-card-head"><div><h2 class="section-title">Cross-Service Dependencies</h2><div class="map-subtitle">Top exported cross-service edges</div></div></div>'
        + '<table class="data-table"><thead><tr><th>From</th><th>To</th><th>Edges</th></tr></thead><tbody>' + relations.map(edge => {
        const count = Number(edge.meta?.count || 0);
        return '<tr data-edge-id="' + escapeAttr(edge.id) + '"><td>' + escapeHtml(serviceLabel(edge.from)) + '</td><td>' + escapeHtml(serviceLabel(edge.to)) + '</td><td>' + count + '</td></tr>';
      }).join('') + '</tbody></table></section>';
    }

    function renderEndpointHotspots() {
      const endpoints = graph.nodes
        .filter(node => node.kind === 'endpoint')
        .sort((a, b) => serviceLabel(a.serviceId).localeCompare(serviceLabel(b.serviceId)) || a.label.localeCompare(b.label))
        .slice(0, 8);
      if (!endpoints.length) return '<section class="data-card"><div class="data-card-head"><h2 class="section-title">Endpoint Hotspots</h2></div><div class="empty-state">No endpoints in this capped export.</div></section>';
      return '<section class="data-card"><div class="data-card-head"><div><h2 class="section-title">Endpoint Hotspots</h2><div class="map-subtitle">Most visible HTTP endpoints in this export</div></div></div>'
        + '<table class="data-table"><thead><tr><th>Endpoint</th><th>Service</th><th>File</th></tr></thead><tbody>' + endpoints.map(node => {
        return '<tr data-node-id="' + escapeAttr(node.id) + '"><td><span class="mono-cell">' + escapeHtml(node.label) + '</span></td><td>' + escapeHtml(serviceLabel(node.serviceId)) + '</td><td><span class="mono-cell">' + escapeHtml(node.file || '') + '</span></td></tr>';
      }).join('') + '</tbody></table></section>';
    }

    function openService(serviceId) {
      if (!serviceId) return;
      state.activeServiceId = serviceId;
      state.selectedId = serviceId;
      renderGroups();
      render();
      const service = nodeById.get(serviceId);
      if (service) showDetail(service);
    }

    function openNode(nodeId) {
      const node = nodeById.get(nodeId);
      if (!node) return;
      state.selectedId = node.id;
      state.activeServiceId = node.kind === 'service' ? node.id : (node.serviceId || state.activeServiceId);
      state.mode = 'focus';
      renderGroups();
      render();
      fitActiveView();
      showDetail(node);
    }

    function miniBar(value, max, color) {
      const width = Math.max(3, Math.round(Number(value || 0) / max * 100));
      return '<div class="mini-bar"><span style="width:' + width + '%; background:' + color + '"></span></div>';
    }

    function activityBars(value, max, color) {
      const hot = Math.max(1, Math.round(Number(value || 0) / max * 18));
      let html = '';
      for (let i = 0; i < 18; i++) {
        const height = 5 + ((i * 7) % 13);
        html += '<span class="' + (i < hot ? 'hot' : '') + '" style="height:' + height + 'px; background:' + color + '"></span>';
      }
      return html;
    }

    function groupWeight(group) {
      return (Number(group.stats.files || 0) * 2) + Number(group.stats.symbols || 0) + (Number(group.stats.endpoints || 0) * 8);
    }

    function serviceColor(serviceId) {
      const palette = ['#0f766e', '#2563eb', '#7c3aed', '#ea580c', '#db2777', '#65a30d', '#d97706', '#0891b2'];
      const groups = [...graph.groups].sort((a, b) => groupWeight(b) - groupWeight(a) || a.label.localeCompare(b.label));
      const index = Math.max(0, groups.findIndex(group => group.id === serviceId));
      return palette[index % palette.length];
    }

    function nodeColor(node) {
      if (node.kind === 'service') return 'var(--service)';
      if (node.kind === 'endpoint') return 'var(--endpoint)';
      if (node.kind === 'file') return 'var(--file)';
      return 'var(--symbol)';
    }

    function uniqueEdges(edges) {
      const seen = new Set();
      const result = [];
      for (const edge of edges) {
        if (!edge || seen.has(edge.id)) continue;
        seen.add(edge.id);
        result.push(edge);
      }
      return result;
    }

    function uniqueNodes(nodes) {
      const seen = new Set();
      const result = [];
      for (const node of nodes) {
        if (!node || seen.has(node.id)) continue;
        seen.add(node.id);
        result.push(node);
      }
      return result;
    }

    function addToMapList(map, key, value) {
      if (!key) return;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(value);
    }

    function serviceLabel(serviceId) {
      if (!serviceId) return '';
      const group = graph.groups.find(item => item.id === serviceId);
      const node = nodeById.get(serviceId);
      return group?.label || node?.label || serviceId;
    }

    function visibleNodes() {
      const base = new Set();
      const matches = new Set();
      for (const node of graph.nodes) {
        if (!nodeWithinActiveService(node)) continue;
        const queryMatch = nodeMatchesQuery(node);
        const kindVisible = state.nodeKinds.has(node.kind) || Boolean(state.query && queryMatch);
        if (!kindVisible) continue;
        if (!state.query || queryMatch) {
          base.add(node.id);
          matches.add(node.id);
        }
      }
      if (!state.query) return base;
      for (const id of matches) {
        for (const neighbor of adjacency.get(id) || []) {
          const node = nodeById.get(neighbor);
          if (node && nodeWithinActiveService(node) && state.nodeKinds.has(node.kind)) base.add(neighbor);
        }
      }
      return base;
    }

    function nodeWithinActiveService(node) {
      if (state.mode !== 'focus') return true;
      return !state.activeServiceId || node.id === state.activeServiceId || node.serviceId === state.activeServiceId;
    }

    function nodeMatchesQuery(node) {
      if (!state.query) return true;
      const query = String(state.query || '').toLowerCase();
      return [node.label, node.file, node.role, JSON.stringify(node.meta || {})].join(' ').toLowerCase().includes(query);
    }

    function showDetail(item) {
      if (item.kind === 'service') {
        showServiceDetail(item);
        return;
      }
      const rows = [];
      for (const key of ['kind', 'role', 'file', 'line', 'serviceId', 'from', 'to', 'confidence', 'label']) {
        if (item[key] !== undefined) rows.push('<dt>' + escapeHtml(key) + '</dt><dd>' + escapeHtml(String(item[key])) + '</dd>');
      }
      detail.className = '';
      detail.innerHTML = '<h1 class="detail-title">' + escapeHtml(item.label || item.id) + '</h1>'
        + '<div class="detail-kind">' + escapeHtml(item.kind || 'item') + '</div>'
        + '<dl>' + rows.join('') + '</dl>'
        + '<h2>Metadata</h2><pre>' + escapeHtml(JSON.stringify(item.meta || item, null, 2)) + '</pre>';
    }

    function showServiceDetail(service) {
      const serviceId = service.id;
      const group = graph.groups.find(item => item.id === serviceId);
      const stats = group?.stats || service.meta?.stats || {};
      const files = graph.nodes.filter(node => node.kind === 'file' && node.serviceId === serviceId).slice(0, 5);
      const endpoints = graph.nodes.filter(node => node.kind === 'endpoint' && node.serviceId === serviceId).slice(0, 5);
      const deps = graph.edges.filter(edge => edge.kind === 'cross_service' && (edge.from === serviceId || edge.to === serviceId)).slice(0, 5);
      detail.className = '';
      detail.innerHTML = '<div class="inspector-head"><div><div class="inspector-title-row"><span class="dot" style="background:' + serviceColor(serviceId) + '"></span><h1 class="detail-title">' + escapeHtml(service.label) + '</h1></div>'
        + '<div class="inspector-summary">Service boundary inferred from indexed files, symbols, endpoints, and build/config evidence.</div></div></div>'
        + '<div class="metric-grid">'
        + metric('Files', stats.files)
        + metric('Symbols', stats.symbols)
        + metric('Endpoints', stats.endpoints)
        + metric('Deps', deps.length)
        + '</div>'
        + '<div class="inspector-tabs"><button class="active" type="button">Overview</button><button type="button">Files</button><button type="button">Endpoints</button><button type="button">Dependencies</button></div>'
        + '<h2>Top Files</h2><div class="mini-list">' + miniRows(files, node => node.file || node.label, node => node.role || node.kind) + '</div>'
        + '<h2>Sample Endpoints</h2><div class="mini-list">' + miniRows(endpoints, node => node.label, node => node.file || '') + '</div>'
        + '<h2>Dependencies</h2><div class="mini-list">' + deps.map(edge => '<div class="mini-row"><div class="mini-row-main">' + escapeHtml(serviceLabel(edge.from)) + ' -> ' + escapeHtml(serviceLabel(edge.to)) + '</div><span class="pill">' + escapeHtml(String(edge.meta?.count || 1)) + '</span></div>').join('') + '</div>'
        + '<button id="focusGraphAction" class="primary-action" type="button">Open Dependency Map</button>'
        + '<button id="incomingOutgoingAction" class="secondary-action" type="button">Show Incoming / Outgoing</button>';
      document.getElementById('focusGraphAction')?.addEventListener('click', () => {
        state.mode = 'focus';
        render();
        fitActiveView();
      });
      document.getElementById('incomingOutgoingAction')?.addEventListener('click', () => {
        state.mode = 'focus';
        render();
        fitActiveView();
      });
    }

    function metric(label, value) {
      return '<div class="metric">' + escapeHtml(label) + '<strong>' + escapeHtml(String(value ?? 0)) + '</strong></div>';
    }

    function miniRows(items, labelFn, metaFn) {
      if (!items.length) return '<div class="empty-state">No rows in this capped export.</div>';
      return items.map(item => '<div class="mini-row" data-node-id="' + escapeAttr(item.id) + '"><div class="mini-row-main">' + escapeHtml(labelFn(item)) + '</div><span class="pill">' + escapeHtml(metaFn(item)) + '</span></div>').join('');
    }

    function layoutGraph(input) {
      const positions = new Map();
      const serviceBounds = new Map();
      const services = input.nodes
        .filter(node => node.kind === 'service')
        .sort((a, b) => serviceWeight(b) - serviceWeight(a) || a.label.localeCompare(b.label));
      const serviceIds = new Set(services.map(node => node.id));
      const byService = new Map();
      const ungrouped = [];
      for (const node of input.nodes) {
        if (node.kind === 'service') continue;
        if (node.serviceId && serviceIds.has(node.serviceId)) {
          const bucket = byService.get(node.serviceId) || [];
          bucket.push(node);
          byService.set(node.serviceId, bucket);
        } else {
          ungrouped.push(node);
        }
      }
      const margin = 70;
      const gutter = 70;
      const columnCount = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(Math.max(services.length, 1)))));
      const columnWidth = 1060;
      const columnY = new Array(columnCount).fill(margin);
      let maxX = margin + columnWidth;
      let maxY = margin;
      for (const service of services) {
        const bucket = (byService.get(service.id) || []).sort(nodeSort);
        const bucketCols = Math.max(5, Math.min(22, Math.ceil(Math.sqrt(Math.max(bucket.length, 1) * 1.35))));
        const bucketRows = Math.max(1, Math.ceil(bucket.length / bucketCols));
        const cellWidth = Math.max(360, 130 + bucketCols * 42);
        const cellHeight = Math.max(170, 118 + bucketRows * 34);
        let column = 0;
        for (let i = 1; i < columnY.length; i++) {
          if (columnY[i] < columnY[column]) column = i;
        }
        const x = margin + column * (columnWidth + gutter);
        const y = columnY[column];
        const bounds = { x, y, width: cellWidth, height: cellHeight };
        serviceBounds.set(service.id, bounds);
        positions.set(service.id, { x: x + 26, y: y + 28 });
        bucket.forEach((node, index) => {
          const col = index % bucketCols;
          const row = Math.floor(index / bucketCols);
          const stagger = row % 2 ? 14 : 0;
          positions.set(node.id, {
            x: Math.round(x + 82 + col * 42 + stagger),
            y: Math.round(y + 82 + row * 34),
          });
        });
        columnY[column] += cellHeight + gutter;
        maxX = Math.max(maxX, x + cellWidth);
        maxY = Math.max(maxY, columnY[column]);
      }
      if (ungrouped.length) {
        const columns = Math.max(6, Math.min(20, Math.ceil(Math.sqrt(ungrouped.length))));
        const x = margin;
        const y = maxY + gutter;
        ungrouped.sort(nodeSort).forEach((node, index) => {
          positions.set(node.id, {
            x: x + 30 + (index % columns) * 48,
            y: y + 35 + Math.floor(index / columns) * 36,
          });
        });
        maxY = y + 90 + Math.ceil(ungrouped.length / columns) * 36;
        maxX = Math.max(maxX, x + columns * 48 + 80);
      }
      return {
        positions,
        serviceBounds,
        width: Math.max(900, maxX + margin),
        height: Math.max(640, maxY + margin),
      };
    }

    function serviceWeight(node) {
      const stats = node.meta && node.meta.stats ? node.meta.stats : {};
      return (Number(stats.files || 0) * 2) + Number(stats.symbols || 0) + (Number(stats.endpoints || 0) * 8);
    }

    function fitActiveView() {
      const bounds = boundsForNodes(visibleNodes());
      view = bounds ? paddedView(bounds, 90) : { x: -40, y: -40, width: layout.width + 80, height: layout.height + 80 };
      setViewBox(view);
    }

    function paddedView(bounds, padding) {
      return {
        x: bounds.x - padding,
        y: bounds.y - padding,
        width: bounds.width + padding * 2,
        height: bounds.height + padding * 2,
      };
    }

    function boundsForNodes(nodeIds) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const id of nodeIds) {
        const pos = positions.get(id);
        if (!pos) continue;
        minX = Math.min(minX, pos.x - 20);
        minY = Math.min(minY, pos.y - 20);
        maxX = Math.max(maxX, pos.x + 140);
        maxY = Math.max(maxY, pos.y + 24);
      }
      if (!Number.isFinite(minX)) return undefined;
      return { x: minX, y: minY, width: Math.max(220, maxX - minX), height: Math.max(160, maxY - minY) };
    }

    function setViewBox(next) {
      svg.setAttribute('viewBox', [next.x, next.y, next.width, next.height].map(value => Math.round(value * 100) / 100).join(' '));
    }

    function svgPoint(event) {
      const rect = svg.getBoundingClientRect();
      return {
        x: view.x + ((event.clientX - rect.left) / rect.width) * view.width,
        y: view.y + ((event.clientY - rect.top) / rect.height) * view.height,
      };
    }

    function uniqueSorted(values) {
      return [...new Set(values)].sort();
    }

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }

    function workspaceName(root) {
      const parts = String(root || '').split(/[\\\\/]+/).filter(Boolean);
      return parts[parts.length - 1] || 'workspace';
    }

    function compactPath(root) {
      const text = String(root || '');
      if (text.length <= 34) return text;
      const parts = text.split(/[\\\\/]+/).filter(Boolean);
      if (parts.length <= 2) return text.slice(0, 31) + '...';
      return parts[0] + '/.../' + parts.slice(-2).join('/');
    }

    function nodeSort(a, b) {
      const rank = { endpoint: 0, symbol: 1, file: 2, service: 3 };
      return (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || a.label.localeCompare(b.label);
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/\\s+/g, '-');
    }

    function shorten(value, max) {
      const text = String(value || '');
      return text.length <= max ? text : text.slice(0, max - 1) + '...';
    }
  </script>
</body>
</html>`;
}

function buildEdgeCandidates(input: {
  selectedNodes: Map<string, GraphNode>;
  files: FileRow[];
  symbols: SymbolRow[];
  endpoints: EndpointRow[];
  dependencyEdges: DependencyEdgeRow[];
  callEdges: CallEdgeRow[];
  fileServiceIds: Map<string, string>;
  symbolIndex: Map<string, SymbolRow>;
}): EdgeCandidate[] {
  const edgeCandidates: EdgeCandidate[] = [];
  const selected = input.selectedNodes;
  const selectedSymbols = new Map<string, string>();
  for (const symbol of input.symbols) {
    const id = symbolNodeId(symbol);
    if (selected.has(id)) addSymbolAliases(selectedSymbols, symbol, id);
  }

  const addEdge = (edge: GraphEdge, score: number): void => {
    if (!selected.has(edge.from) || !selected.has(edge.to) || edge.from === edge.to) return;
    edgeCandidates.push({ edge, score });
  };

  for (const endpoint of input.endpoints) {
    const endpointId = endpointNodeId(endpoint);
    const handler = resolveCallSymbolNode(selectedSymbols, endpoint.handler_symbol);
    addEdge({
      id: `endpoint-handler:${endpointId}:${handler ?? fileNodeId(endpoint.file)}`,
      kind: 'endpoint_handler',
      from: endpointId,
      to: handler ?? fileNodeId(endpoint.file),
      confidence: numberValue(endpoint.confidence),
      label: 'handler',
      meta: {
        handlerSymbol: endpoint.handler_symbol,
        framework: endpoint.framework,
      },
    }, 5000);
    addEdge({
      id: `endpoint-file:${endpointId}:${fileNodeId(endpoint.file)}`,
      kind: 'defined_in',
      from: endpointId,
      to: fileNodeId(endpoint.file),
      label: 'defined in',
    }, 1200);
  }

  for (const symbol of input.symbols) {
    addEdge({
      id: `symbol-file:${symbolNodeId(symbol)}:${fileNodeId(symbol.file)}`,
      kind: 'defined_in',
      from: symbolNodeId(symbol),
      to: fileNodeId(symbol.file),
      label: 'defined in',
    }, scoreSymbol(symbol) > 1000 ? 900 : 350);
  }

  for (const edge of input.dependencyEdges) {
    addEdge({
      id: `dependency:${edge.from_file}:${edge.to_file}:${edge.kind}:${edge.resolution_kind}`,
      kind: 'dependency',
      from: fileNodeId(edge.from_file),
      to: fileNodeId(edge.to_file),
      confidence: numberValue(edge.confidence),
      label: edge.kind,
      meta: {
        resolutionKind: edge.resolution_kind,
      },
    }, 1600 + numberValue(edge.confidence) * 100);
  }

  for (const edge of input.callEdges) {
    const from = resolveCallSymbolNode(selectedSymbols, edge.caller);
    const to = resolveCallSymbolNode(selectedSymbols, edge.callee);
    if (!from || !to) continue;
    addEdge({
      id: `call:${edge.file}:${edge.line}:${edge.caller}:${edge.callee}`,
      kind: 'call',
      from,
      to,
      confidence: numberValue(edge.confidence),
      label: 'calls',
      meta: {
        file: edge.file,
        line: numberValue(edge.line),
        resolutionKind: edge.resolution_kind,
        signalTier: edge.signal_tier,
      },
    }, 1400 + numberValue(edge.confidence) * 100);
  }

  for (const aggregate of crossServiceEdges(input)) {
    addEdge(aggregate.edge, aggregate.score);
  }

  return dedupeEdges(edgeCandidates);
}

function crossServiceEdges(input: {
  dependencyEdges: DependencyEdgeRow[];
  callEdges: CallEdgeRow[];
  fileServiceIds: Map<string, string>;
  symbolIndex: Map<string, SymbolRow>;
}): EdgeCandidate[] {
  const aggregates = new Map<string, { from: string; to: string; dependencyCount: number; callCount: number; confidence: number }>();
  const add = (from: string | undefined, to: string | undefined, kind: 'dependency' | 'call', confidence: number): void => {
    if (!from || !to || from === to) return;
    const key = `${from}\0${to}`;
    const current = aggregates.get(key) ?? { from, to, dependencyCount: 0, callCount: 0, confidence: 0 };
    if (kind === 'dependency') current.dependencyCount++;
    else current.callCount++;
    current.confidence = Math.max(current.confidence, confidence);
    aggregates.set(key, current);
  };

  for (const edge of input.dependencyEdges) {
    add(input.fileServiceIds.get(edge.from_file), input.fileServiceIds.get(edge.to_file), 'dependency', numberValue(edge.confidence));
  }

  for (const edge of input.callEdges) {
    const callee = resolveCallSymbolRow(input.symbolIndex, edge.callee);
    add(input.fileServiceIds.get(edge.file), callee ? input.fileServiceIds.get(callee.file) : undefined, 'call', numberValue(edge.confidence));
  }

  return [...aggregates.values()].map(row => {
    const total = row.dependencyCount + row.callCount;
    return {
      edge: {
        id: `cross-service:${row.from}:${row.to}`,
        kind: 'cross_service',
        from: row.from,
        to: row.to,
        confidence: row.confidence,
        label: `${total} cross-service`,
        meta: {
          dependencyCount: row.dependencyCount,
          callCount: row.callCount,
        },
      },
      score: 7000 + total,
    };
  });
}

function inferServices(
  root: string,
  files: FileRow[],
  symbols: SymbolRow[],
  endpoints: EndpointRow[],
): Map<string, ServiceCandidate> {
  const services = new Map<string, ServiceCandidate>();
  const defaultId = defaultServiceId(root);
  const defaultLabel = path.basename(path.resolve(root)) || 'workspace';
  ensureService(services, defaultId, defaultLabel, '', 'workspace root');

  for (const file of files) {
    const basename = path.posix.basename(file.path);
    if (isBuildMarker(basename)) {
      const rootPrefix = path.posix.dirname(file.path) === '.' ? '' : path.posix.dirname(file.path);
      ensureService(services, serviceIdFor(rootPrefix || defaultLabel), labelForServiceRoot(rootPrefix, defaultLabel), rootPrefix, `${basename} marker`);
    }
  }

  for (const symbol of symbols) {
    if (symbol.framework_role === 'spring:application') {
      const rootPrefix = moduleRootForFile(symbol.file);
      ensureService(services, serviceIdFor(rootPrefix || defaultLabel), labelForServiceRoot(rootPrefix, defaultLabel), rootPrefix, 'spring application');
    }
    if (symbol.framework_role === 'docker:service') {
      const label = dockerServiceLabel(symbol.simple_name);
      const rootPrefix = rootForServiceLabel(files, label);
      ensureService(services, serviceIdFor(rootPrefix ?? label), label, rootPrefix, 'docker compose service');
    }
  }

  for (const endpoint of endpoints) {
    const rootPrefix = moduleRootForFile(endpoint.file);
    ensureService(services, serviceIdFor(rootPrefix || defaultLabel), labelForServiceRoot(rootPrefix, defaultLabel), rootPrefix, `${endpoint.framework} endpoint`);
  }

  return services;
}

function assignFilesToServices(files: FileRow[], services: Map<string, ServiceCandidate>): Map<string, string> {
  const roots = [...services.values()]
    .filter(service => service.rootPrefix !== undefined)
    .sort((a, b) => (b.rootPrefix?.length ?? 0) - (a.rootPrefix?.length ?? 0));
  const fallback = roots.find(service => service.rootPrefix === '') ?? [...services.values()][0];
  const result = new Map<string, string>();
  for (const file of files) {
    const service = roots.find(candidate => {
      const prefix = candidate.rootPrefix ?? '';
      return prefix === '' ? false : file.path === prefix || file.path.startsWith(`${prefix}/`);
    }) ?? fallback;
    if (service) {
      result.set(file.path, service.id);
      service.stats.files++;
    }
  }
  return result;
}

function selectNodes(candidates: NodeCandidate[], maxNodes: number): Map<string, GraphNode> {
  const selected = new Map<string, GraphNode>();
  for (const candidate of dedupeNodes(candidates)
    .sort((a, b) => b.score - a.score || a.node.kind.localeCompare(b.node.kind) || a.node.label.localeCompare(b.node.label))) {
    if (selected.size >= maxNodes) break;
    selected.set(candidate.node.id, candidate.node);
  }
  return selected;
}

function selectEdges(candidates: EdgeCandidate[], maxEdges: number): GraphEdge[] {
  return candidates
    .sort((a, b) => b.score - a.score || a.edge.kind.localeCompare(b.edge.kind) || a.edge.id.localeCompare(b.edge.id))
    .slice(0, maxEdges)
    .map(candidate => candidate.edge);
}

function dedupeNodes(candidates: NodeCandidate[]): NodeCandidate[] {
  const byId = new Map<string, NodeCandidate>();
  for (const candidate of candidates) {
    const current = byId.get(candidate.node.id);
    if (!current || candidate.score > current.score) byId.set(candidate.node.id, candidate);
  }
  return [...byId.values()];
}

function dedupeEdges(candidates: EdgeCandidate[]): EdgeCandidate[] {
  const byId = new Map<string, EdgeCandidate>();
  for (const candidate of candidates) {
    const current = byId.get(candidate.edge.id);
    if (!current || candidate.score > current.score) byId.set(candidate.edge.id, candidate);
  }
  return [...byId.values()];
}

function ensureService(
  services: Map<string, ServiceCandidate>,
  id: string,
  label: string,
  rootPrefix: string | undefined,
  evidence: string,
): ServiceCandidate {
  const existing = services.get(id);
  if (existing) {
    existing.evidence.add(evidence);
    if (existing.rootPrefix === undefined && rootPrefix !== undefined) existing.rootPrefix = rootPrefix;
    return existing;
  }
  const service = {
    id,
    label,
    rootPrefix,
    evidence: new Set([evidence]),
    stats: {
      files: 0,
      symbols: 0,
      endpoints: 0,
    },
  };
  services.set(id, service);
  return service;
}

function buildSymbolIndex(symbols: SymbolRow[]): Map<string, SymbolRow> {
  const index = new Map<string, SymbolRow>();
  for (const symbol of symbols) {
    addSymbolAliases(index, symbol, symbol);
  }
  return index;
}

function addSymbolAliases<T>(index: Map<string, T>, symbol: SymbolRow, value: T): void {
  const aliases = symbolAliases(symbol);
  for (const alias of aliases) {
    if (!index.has(alias)) index.set(alias, value);
  }
}

function symbolAliases(symbol: SymbolRow): string[] {
  const fqNoParams = stripParams(symbol.fq_name);
  const parts = fqNoParams.split('.').filter(Boolean);
  const compact = parts.length >= 2 ? `${parts[parts.length - 2]}.${parts[parts.length - 1]}` : fqNoParams;
  return uniqueStrings([
    symbol.fq_name,
    fqNoParams,
    symbol.simple_name,
    symbol.parent ? `${symbol.parent}.${symbol.simple_name}` : '',
    compact,
  ].filter(Boolean));
}

function resolveCallSymbolNode(index: Map<string, string>, value: string): string | undefined {
  const key = normalizeCallKey(value);
  return index.get(value)
    ?? index.get(key)
    ?? index.get(callGraphName(key))
    ?? index.get(key.split('.').slice(-1)[0] ?? '');
}

function resolveCallSymbolRow(index: Map<string, SymbolRow>, value: string): SymbolRow | undefined {
  const key = normalizeCallKey(value);
  return index.get(value)
    ?? index.get(key)
    ?? index.get(callGraphName(key))
    ?? index.get(key.split('.').slice(-1)[0] ?? '');
}

function fileDegreeMap(dependencyEdges: DependencyEdgeRow[], callEdges: CallEdgeRow[]): Map<string, number> {
  const degree = new Map<string, number>();
  const inc = (file: string, amount = 1): void => {
    degree.set(file, (degree.get(file) ?? 0) + amount);
  };
  for (const edge of dependencyEdges) {
    inc(edge.from_file);
    inc(edge.to_file);
  }
  for (const edge of callEdges) {
    inc(edge.file);
  }
  return degree;
}

function graphRoleFilter(options: Pick<GraphExportOptions, 'includeTests' | 'includeGenerated'>): {
  sql: (column: string) => string;
  params: string[];
} {
  const excluded = new Set<string>();
  if (!options.includeTests) {
    excluded.add('test_source');
    excluded.add('mock_source');
  }
  if (!options.includeGenerated) excluded.add('generated');
  const values = [...excluded];
  return {
    sql: (column: string) => values.length === 0 ? '' : `AND ${column} NOT IN (${values.map(() => '?').join(', ')})`,
    params: values,
  };
}

function scoreSymbol(symbol: SymbolRow): number {
  const role = symbol.framework_role ?? '';
  let score = 1000;
  if (role === 'spring:application') score += 2600;
  if (role.includes('endpoint') || role.includes('controller')) score += 2400;
  if (role.includes('service')) score += 2100;
  if (role.includes('repository')) score += 1900;
  if (role.includes('entity') || role.includes('model')) score += 1700;
  if (role.startsWith('docker:')) score += 1600;
  if (symbol.kind === 'class' || symbol.kind === 'interface' || symbol.kind === 'type') score += 700;
  if (symbol.kind === 'method' || symbol.kind === 'function') score += 300;
  score += fileRoleScore(symbol.file_role);
  return score;
}

function scoreFile(file: FileRow, degree: number): number {
  const basename = path.posix.basename(file.path);
  let score = 700 + Math.min(degree, 100) * 25 + fileRoleScore(file.file_role);
  if (isBuildMarker(basename) || /docker-compose\.ya?ml$/i.test(basename)) score += 800;
  if (/Controller|Service|Repository|Application/.test(basename)) score += 450;
  return score;
}

function fileRoleScore(role: string): number {
  switch (role) {
    case 'main_source': return 500;
    case 'resource_config': return 420;
    case 'build_config': return 380;
    case 'test_source': return 150;
    case 'mock_source': return 110;
    case 'generated': return 20;
    default: return 220;
  }
}

function moduleRootForFile(file: string): string {
  const srcIndex = file.indexOf('/src/');
  if (srcIndex > 0) return file.slice(0, srcIndex);
  if (file.startsWith('src/')) return '';
  const parts = file.split('/').filter(Boolean);
  return parts.length > 2 ? parts[0] ?? '' : '';
}

function rootForServiceLabel(files: FileRow[], label: string): string | undefined {
  const normalizedLabel = normalizeServiceLabel(label);
  const roots = new Set(files.map(file => moduleRootForFile(file.path)).filter(Boolean));
  for (const root of roots) {
    if (normalizeServiceLabel(path.posix.basename(root)) === normalizedLabel) return root;
  }
  for (const root of roots) {
    if (normalizeServiceLabel(root).includes(normalizedLabel) || normalizedLabel.includes(normalizeServiceLabel(root))) return root;
  }
  return undefined;
}

function labelForServiceRoot(rootPrefix: string, fallback: string): string {
  if (!rootPrefix) return fallback;
  return path.posix.basename(rootPrefix) || rootPrefix;
}

function serviceIdFor(value: string): string {
  const slug = normalizeServiceLabel(value) || 'workspace';
  return `service:${slug}`;
}

function defaultServiceId(root: string): string {
  return serviceIdFor(path.basename(path.resolve(root)) || 'workspace');
}

function normalizeServiceLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^services[.]/, '')
    .replace(/\\/g, '/')
    .replace(/[^a-z0-9/._-]+/g, '-')
    .replace(/[/.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function dockerServiceLabel(value: string): string {
  return value.replace(/^services[.]/, '') || value;
}

function isBuildMarker(value: string): boolean {
  return /^(pom\.xml|build\.gradle|settings\.gradle|package\.json|go\.mod|Dockerfile|docker-compose\.ya?ml)$/i.test(value);
}

function endpointKey(endpoint: EndpointRow): string {
  return `${endpoint.method}\0${endpoint.path}\0${endpoint.file}\0${endpoint.line}`;
}

function endpointNodeId(endpoint: EndpointRow): string {
  return `endpoint:${endpoint.method}:${endpoint.path}:${endpoint.file}:${endpoint.line}`;
}

function symbolNodeId(symbol: SymbolRow): string {
  return `symbol:${symbol.fq_name}:${symbol.file}:${symbol.line}`;
}

function fileNodeId(file: string): string {
  return `file:${file}`;
}

function symbolLabel(symbol: SymbolRow): string {
  if (symbol.parent && symbol.kind !== 'class' && symbol.kind !== 'interface') return `${symbol.parent}.${symbol.simple_name}`;
  return symbol.simple_name;
}

function fileLabel(file: string): string {
  return path.posix.basename(file) || file;
}

function normalizeWorkspaceKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase().replace(/\\/g, '/') : undefined;
}

function normalizeCallKey(value: string): string {
  return stripParams(value.trim());
}

function stripParams(value: string): string {
  return value.replace(/\([^)]*\)$/, '');
}

function callGraphName(symbol: string): string {
  const parts = stripParams(symbol).split('.').filter(Boolean);
  if (parts.length >= 2) return `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  return stripParams(symbol);
}

function numberValue(value: number | string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
