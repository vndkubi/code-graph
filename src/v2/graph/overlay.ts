import path from 'node:path';
import type { CodeGraphDb } from '../storage/database.js';

export interface GraphOverlayStats {
  nodes: number;
  edges: number;
  elapsedMs: number;
}

export interface GraphOverlayCallFileEdge {
  from_file: string;
  to_file: string;
  edge_count: number;
  confidence: number;
}

export interface GraphOverlayBuildOptions {
  callFileEdges?: GraphOverlayCallFileEdge[];
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
  framework_role?: string | null;
  file_role: string;
}

interface EndpointRow {
  method: string;
  path: string;
  handler_symbol: string;
  controller?: string | null;
  file: string;
  line: number | string;
  framework: string;
  confidence: number | string;
  file_role: string;
}

interface DependencyAggregateRow {
  from_file: string;
  to_file: string;
  kind: string;
  edge_count: number | string;
  confidence: number | string;
}

interface CallAggregateRow {
  from_file: string;
  to_file: string;
  edge_count: number | string;
  confidence: number | string;
}

interface FieldAggregateRow {
  from_file: string;
  to_file: string;
  access_kind: string;
  edge_count: number | string;
  confidence: number | string;
}

interface GraphNodeRow {
  nodeId: string;
  nodeType: string;
  label: string;
  file?: string;
  line?: number;
  role?: string;
  language?: string;
  fileRole?: string;
  parentNodeId?: string;
  stats: Record<string, unknown>;
  evidence: Array<Record<string, unknown>>;
}

interface GraphEdgeRow {
  fromNodeId: string;
  toNodeId: string;
  edgeType: string;
  confidence: number;
  edgeCount: number;
  evidence: Array<Record<string, unknown>>;
}

interface ModuleCandidate {
  nodeId: string;
  label: string;
  rootPrefix: string;
  evidence: Set<string>;
  stats: {
    files: number;
    symbols: number;
    endpoints: number;
  };
}

export interface ArchitectureContext {
  target?: string;
  modules: Array<Record<string, unknown>>;
  relatedModuleEdges: Array<Record<string, unknown>>;
  bridgeModules: Array<Record<string, unknown>>;
  files: Array<Record<string, unknown>>;
  available: boolean;
}

export interface DependencyTraceDiagnostics {
  modules: Array<Record<string, unknown>>;
  relatedModuleEdges: Array<Record<string, unknown>>;
  bridgeModules: Array<Record<string, unknown>>;
  siblingFiles: Array<Record<string, unknown>>;
  note: string;
}

const MAX_EVIDENCE_PER_EDGE = 8;

export async function rebuildGraphOverlay(
  db: CodeGraphDb,
  snapshotId: string,
  options: GraphOverlayBuildOptions = {},
): Promise<GraphOverlayStats> {
  const started = Date.now();
  await db.prepare('DELETE FROM graph_edges WHERE snapshot_id = ?').run(snapshotId);
  await db.prepare('DELETE FROM graph_nodes WHERE snapshot_id = ?').run(snapshotId);

  const workspace = await db.prepare(`
    SELECT w.root
    FROM snapshots s
    JOIN workspaces w ON w.id = s.workspace_id
    WHERE s.id = ?
  `).get(snapshotId) as { root?: string } | undefined;
  const workspaceLabel = path.basename(path.resolve(workspace?.root ?? 'workspace')) || 'workspace';

  const [files, importantSymbols, endpoints, symbolCounts] = await Promise.all([
    db.prepare(`
      SELECT path, language, file_role, size
      FROM files
      WHERE snapshot_id = ?
      ORDER BY path
    `).all(snapshotId) as Promise<FileRow[]>,
    db.prepare(`
      SELECT fq_name, simple_name, kind, file, line, framework_role, file_role
      FROM symbols
      WHERE snapshot_id = ?
        AND (
          framework_role IS NOT NULL
          OR kind IN ('class', 'interface')
        )
      ORDER BY file, line
      LIMIT 50000
    `).all(snapshotId) as Promise<SymbolRow[]>,
    db.prepare(`
      SELECT method, path, handler_symbol, controller, file, line, framework, confidence, file_role
      FROM endpoints
      WHERE snapshot_id = ?
      ORDER BY file, line
    `).all(snapshotId) as Promise<EndpointRow[]>,
    db.prepare(`
      SELECT file, COUNT(*)::integer AS count
      FROM symbols
      WHERE snapshot_id = ?
      GROUP BY file
    `).all(snapshotId) as Promise<Array<{ file: string; count: number | string }>>,
  ]);

  const symbolCountByFile = new Map(symbolCounts.map(row => [row.file, numberValue(row.count)]));
  const modules = inferModules(workspaceLabel, files, importantSymbols, endpoints);
  const fileToModule = assignFilesToModules(files, modules);
  const nodes = new Map<string, GraphNodeRow>();
  const edges = new Map<string, GraphEdgeRow>();

  addNode(nodes, {
    nodeId: 'workspace',
    nodeType: 'workspace',
    label: workspaceLabel,
    stats: { files: files.length, modules: modules.size, endpoints: endpoints.length },
    evidence: [{ reason: 'workspace root', root: workspace?.root ?? '' }],
  });

  for (const module of modules.values()) {
    addNode(nodes, {
      nodeId: module.nodeId,
      nodeType: 'module',
      label: module.label,
      role: 'module',
      parentNodeId: 'workspace',
      stats: module.stats,
      evidence: [...module.evidence].slice(0, 10).map(reason => ({ reason, rootPrefix: module.rootPrefix })),
    });
    addEdge(edges, {
      fromNodeId: 'workspace',
      toNodeId: module.nodeId,
      edgeType: 'contains',
      confidence: 1,
      edgeCount: module.stats.files,
      evidence: [{ reason: 'workspace contains module', rootPrefix: module.rootPrefix }],
    });
  }

  for (const file of files) {
    const moduleId = fileToModule.get(file.path) ?? defaultModuleId(workspaceLabel);
    const symbolCount = symbolCountByFile.get(file.path) ?? 0;
    const module = modules.get(moduleId);
    if (module) module.stats.symbols += symbolCount;
    addNode(nodes, {
      nodeId: fileNodeId(file.path),
      nodeType: 'file',
      label: path.posix.basename(file.path) || file.path,
      file: file.path,
      role: file.file_role,
      language: file.language,
      fileRole: file.file_role,
      parentNodeId: moduleId,
      stats: { size: numberValue(file.size), symbols: symbolCount },
      evidence: [{ path: file.path }],
    });
    addEdge(edges, {
      fromNodeId: moduleId,
      toNodeId: fileNodeId(file.path),
      edgeType: 'contains',
      confidence: 1,
      edgeCount: 1,
      evidence: [{ reason: 'module contains file', file: file.path }],
    });
  }

  const endpointHandlerSymbols = new Set(endpoints.map(endpoint => endpoint.handler_symbol).filter(Boolean));
  for (const symbol of importantSymbols) {
    if (symbol.framework_role || endpointHandlerSymbols.has(symbol.fq_name) || endpointHandlerSymbols.has(stripParams(symbol.fq_name))) {
      addSymbolNode(nodes, symbol, fileToModule.get(symbol.file));
      addEdge(edges, {
        fromNodeId: fileNodeId(symbol.file),
        toNodeId: symbolNodeId(symbol.fq_name, symbol.file),
        edgeType: 'defines',
        confidence: 1,
        edgeCount: 1,
        evidence: [{ symbol: symbol.fq_name, kind: symbol.kind }],
      });
    }
  }

  for (const endpoint of endpoints) {
    const moduleId = fileToModule.get(endpoint.file) ?? defaultModuleId(workspaceLabel);
    const endpointId = endpointNodeId(endpoint);
    const module = modules.get(moduleId);
    if (module) module.stats.endpoints++;
    const syntheticHandler = syntheticSymbolForEndpoint(endpoint, moduleId);
    addNode(nodes, {
      nodeId: endpointId,
      nodeType: 'endpoint',
      label: `${endpoint.method} ${endpoint.path}`,
      file: endpoint.file,
      line: numberValue(endpoint.line),
      role: endpoint.framework,
      fileRole: endpoint.file_role,
      parentNodeId: moduleId,
      stats: { confidence: numberValue(endpoint.confidence) },
      evidence: [{ handlerSymbol: endpoint.handler_symbol, controller: endpoint.controller ?? '' }],
    });
    addNode(nodes, syntheticHandler);
    addEdge(edges, {
      fromNodeId: fileNodeId(endpoint.file),
      toNodeId: endpointId,
      edgeType: 'defines_endpoint',
      confidence: numberValue(endpoint.confidence),
      edgeCount: 1,
      evidence: [{ method: endpoint.method, path: endpoint.path }],
    });
    addEdge(edges, {
      fromNodeId: endpointId,
      toNodeId: syntheticHandler.nodeId,
      edgeType: 'endpoint_handler',
      confidence: numberValue(endpoint.confidence),
      edgeCount: 1,
      evidence: [{ handlerSymbol: endpoint.handler_symbol, file: endpoint.file, line: numberValue(endpoint.line) }],
    });
  }

  await addAggregateEdges(db, snapshotId, fileToModule, edges, options);

  const nodeRows = [...nodes.values()].map(node => [
    snapshotId,
    node.nodeId,
    node.nodeType,
    node.label,
    node.file,
    node.line,
    node.role,
    node.language,
    node.fileRole,
    node.parentNodeId,
    JSON.stringify(node.stats ?? {}),
    JSON.stringify(node.evidence ?? []),
  ]);
  const edgeRows = [...edges.values()].map(edge => [
    snapshotId,
    edge.fromNodeId,
    edge.toNodeId,
    edge.edgeType,
    edge.confidence,
    edge.edgeCount,
    JSON.stringify(edge.evidence ?? []),
  ]);

  await db.copyFromRows('graph_nodes', [
    'snapshot_id',
    'node_id',
    'node_type',
    'label',
    'file',
    'line',
    'role',
    'language',
    'file_role',
    'parent_node_id',
    'stats_json',
    'evidence_json',
  ], nodeRows, { ignoreConflicts: true });
  await db.copyFromRows('graph_edges', [
    'snapshot_id',
    'from_node_id',
    'to_node_id',
    'edge_type',
    'confidence',
    'edge_count',
    'evidence_json',
  ], edgeRows, { ignoreConflicts: true });

  return {
    nodes: nodeRows.length,
    edges: edgeRows.length,
    elapsedMs: Date.now() - started,
  };
}

export async function architectureContextForFiles(
  db: CodeGraphDb,
  snapshotId: string,
  files: string[],
  target?: string,
  limit = 12,
): Promise<ArchitectureContext | undefined> {
  const uniqueFiles = [...new Set(files.filter(Boolean))].slice(0, 80);
  if (uniqueFiles.length === 0 && !target) return undefined;
  const modulesById = new Map<string, Record<string, unknown>>();
  const fileRows: Array<Record<string, unknown>> = [];

  if (uniqueFiles.length > 0) {
    const placeholders = uniqueFiles.map(() => '?').join(', ');
    const rows = await db.prepare(`
      SELECT f.node_id AS file_node_id, f.file, f.label AS file_label, f.parent_node_id,
             m.node_id AS module_id, m.label AS module_label, m.stats_json, m.evidence_json
      FROM graph_nodes f
      LEFT JOIN graph_nodes m
        ON m.snapshot_id = f.snapshot_id AND m.node_id = f.parent_node_id
      WHERE f.snapshot_id = ?
        AND f.node_type = 'file'
        AND f.file IN (${placeholders})
      ORDER BY f.file
      LIMIT ?
    `).all(snapshotId, ...uniqueFiles, limit * 4) as Array<{
      file_node_id: string;
      file: string;
      file_label: string;
      parent_node_id?: string;
      module_id?: string;
      module_label?: string;
      stats_json?: string;
      evidence_json?: string;
    }>;
    for (const row of rows) {
      fileRows.push({
        file: row.file,
        nodeId: row.file_node_id,
        moduleId: row.module_id ?? row.parent_node_id,
        module: row.module_label,
      });
      if (row.module_id) {
        modulesById.set(row.module_id, compactModuleRow({
          node_id: row.module_id,
          label: row.module_label ?? row.module_id,
          stats_json: row.stats_json,
          evidence_json: row.evidence_json,
        }));
      }
    }
  }

  if (target) {
    for (const module of await matchingModules(db, snapshotId, target, limit)) {
      modulesById.set(String(module.nodeId), module);
    }
  }

  const moduleIds = [...modulesById.keys()].slice(0, limit);
  const relatedModuleEdges = moduleIds.length > 0
    ? await moduleEdges(db, snapshotId, moduleIds, limit * 3)
    : [];
  const bridgeModules = await bridgeModulesForEdges(db, snapshotId, moduleIds, relatedModuleEdges, limit);
  const available = moduleIds.length > 0 || relatedModuleEdges.length > 0;
  if (!available) return undefined;
  return {
    target,
    modules: [...modulesById.values()].slice(0, limit),
    relatedModuleEdges,
    bridgeModules,
    files: fileRows.slice(0, limit * 2),
    available,
  };
}

export async function dependencyTraceDiagnostics(
  db: CodeGraphDb,
  snapshotId: string,
  seedFiles: string[],
  limit = 12,
): Promise<DependencyTraceDiagnostics | undefined> {
  const context = await architectureContextForFiles(db, snapshotId, seedFiles, undefined, limit);
  if (!context) return undefined;
  const moduleIds = context.modules.map(module => String(module.nodeId ?? '')).filter(Boolean);
  const siblingFiles = moduleIds.length > 0
    ? await siblingFilesForModules(db, snapshotId, moduleIds, seedFiles, limit)
    : [];
  return {
    modules: context.modules,
    relatedModuleEdges: context.relatedModuleEdges,
    bridgeModules: context.bridgeModules,
    siblingFiles,
    note: 'No direct file dependency edge matched the trace request; this diagnostic uses the persisted architecture overlay.',
  };
}

async function addAggregateEdges(
  db: CodeGraphDb,
  snapshotId: string,
  fileToModule: Map<string, string>,
  edges: Map<string, GraphEdgeRow>,
  options: GraphOverlayBuildOptions,
): Promise<void> {
  const dependencyRows = await db.prepare(`
    SELECT from_file, to_file, kind, COUNT(*)::integer AS edge_count, MAX(confidence) AS confidence
    FROM dependency_edges
    WHERE snapshot_id = ?
    GROUP BY from_file, to_file, kind
  `).all(snapshotId) as DependencyAggregateRow[];
  for (const row of dependencyRows) {
    addModuleAggregateEdge(edges, fileToModule, row.from_file, row.to_file, 'module_dependency', row.kind, numberValue(row.edge_count), numberValue(row.confidence), {
      fromFile: row.from_file,
      toFile: row.to_file,
      kind: row.kind,
    });
  }

  const callRows = options.callFileEdges ?? (
    envFlag(process.env.CODEGRAPH_GRAPH_OVERLAY_DB_CALL_AGGREGATE)
      ? await db.prepare(`
        WITH symbol_targets AS (
          SELECT fq_name, MIN(file) AS file
          FROM symbols
          WHERE snapshot_id = ?
            AND fq_name IS NOT NULL
            AND file IS NOT NULL
          GROUP BY fq_name
        ),
        call_sources AS (
          SELECT file AS from_file, callee, COUNT(*)::integer AS edge_count, MAX(confidence) AS confidence
          FROM call_edges
          WHERE snapshot_id = ?
            AND signal_tier IN ('primary', 'provider')
            AND file IS NOT NULL
            AND callee IS NOT NULL
          GROUP BY file, callee
        )
        SELECT cs.from_file,
               st.file AS to_file,
               SUM(cs.edge_count)::integer AS edge_count,
               MAX(cs.confidence) AS confidence
        FROM call_sources cs
        JOIN symbol_targets st ON st.fq_name = cs.callee
        WHERE st.file <> cs.from_file
        GROUP BY cs.from_file, st.file
      `).all(snapshotId, snapshotId) as CallAggregateRow[]
      : []
  );
  for (const row of callRows) {
    addModuleAggregateEdge(edges, fileToModule, row.from_file, row.to_file, 'module_call', 'calls', numberValue(row.edge_count), numberValue(row.confidence), {
      fromFile: row.from_file,
      toFile: row.to_file,
    });
  }

  const fieldRows = await db.prepare(`
    WITH field_targets AS (
      SELECT fq_name, MIN(file) AS file
      FROM symbols
      WHERE snapshot_id = ?
        AND kind = 'field'
        AND fq_name IS NOT NULL
        AND file IS NOT NULL
      GROUP BY fq_name
    ),
    field_sources AS (
      SELECT file AS from_file, field_fq_name, access_kind, COUNT(*)::integer AS edge_count, MAX(confidence) AS confidence
      FROM field_usages
      WHERE snapshot_id = ?
        AND file IS NOT NULL
        AND field_fq_name IS NOT NULL
      GROUP BY file, field_fq_name, access_kind
    )
    SELECT fs.from_file,
           ft.file AS to_file,
           fs.access_kind,
           SUM(fs.edge_count)::integer AS edge_count,
           MAX(fs.confidence) AS confidence
    FROM field_sources fs
    JOIN field_targets ft ON ft.fq_name = fs.field_fq_name
    WHERE ft.file <> fs.from_file
    GROUP BY fs.from_file, ft.file, fs.access_kind
  `).all(snapshotId, snapshotId) as FieldAggregateRow[];
  for (const row of fieldRows) {
    addModuleAggregateEdge(edges, fileToModule, row.from_file, row.to_file, 'module_field_usage', row.access_kind, numberValue(row.edge_count), numberValue(row.confidence), {
      fromFile: row.from_file,
      toFile: row.to_file,
      accessKind: row.access_kind,
    });
  }
}

function addModuleAggregateEdge(
  edges: Map<string, GraphEdgeRow>,
  fileToModule: Map<string, string>,
  fromFile: string,
  toFile: string,
  edgeType: string,
  evidenceKind: string,
  count: number,
  confidence: number,
  evidence: Record<string, unknown>,
): void {
  const fromModule = fileToModule.get(fromFile);
  const toModule = fileToModule.get(toFile);
  if (!fromModule || !toModule || fromModule === toModule) return;
  addEdge(edges, {
    fromNodeId: fromModule,
    toNodeId: toModule,
    edgeType,
    confidence,
    edgeCount: count,
    evidence: [{ ...evidence, kind: evidenceKind, count }],
  });
}

function inferModules(
  workspaceLabel: string,
  files: FileRow[],
  symbols: SymbolRow[],
  endpoints: EndpointRow[],
): Map<string, ModuleCandidate> {
  const modules = new Map<string, ModuleCandidate>();
  ensureModule(modules, workspaceLabel, '', 'workspace root');

  for (const file of files) {
    const basename = path.posix.basename(file.path);
    if (isBuildMarker(basename)) {
      const rootPrefix = path.posix.dirname(file.path) === '.' ? '' : path.posix.dirname(file.path);
      ensureModule(modules, labelForModuleRoot(rootPrefix, workspaceLabel), rootPrefix, `${basename} marker`);
    }
  }

  for (const symbol of symbols) {
    if (symbol.framework_role === 'spring:application') {
      const rootPrefix = moduleRootForFile(symbol.file);
      ensureModule(modules, labelForModuleRoot(rootPrefix, workspaceLabel), rootPrefix, 'spring application');
    }
  }

  for (const endpoint of endpoints) {
    const rootPrefix = moduleRootForFile(endpoint.file);
    ensureModule(modules, labelForModuleRoot(rootPrefix, workspaceLabel), rootPrefix, `${endpoint.framework} endpoint`);
  }

  if (modules.size <= 1) {
    for (const root of topLevelRoots(files.map(file => file.path))) {
      ensureModule(modules, labelForModuleRoot(root, workspaceLabel), root, 'top-level directory fallback');
    }
  }

  return modules;
}

function assignFilesToModules(files: FileRow[], modules: Map<string, ModuleCandidate>): Map<string, string> {
  const roots = [...modules.values()].sort((a, b) => b.rootPrefix.length - a.rootPrefix.length);
  const fallback = roots.find(module => module.rootPrefix === '') ?? roots[roots.length - 1];
  const result = new Map<string, string>();
  for (const file of files) {
    const module = roots.find(candidate => candidate.rootPrefix && (file.path === candidate.rootPrefix || file.path.startsWith(`${candidate.rootPrefix}/`))) ?? fallback;
    if (!module) continue;
    result.set(file.path, module.nodeId);
    module.stats.files++;
  }
  return result;
}

function ensureModule(
  modules: Map<string, ModuleCandidate>,
  label: string,
  rootPrefix: string,
  evidence: string,
): ModuleCandidate {
  const nodeId = moduleNodeId(rootPrefix || label);
  const existing = modules.get(nodeId);
  if (existing) {
    existing.evidence.add(evidence);
    return existing;
  }
  const module = {
    nodeId,
    label,
    rootPrefix,
    evidence: new Set([evidence]),
    stats: { files: 0, symbols: 0, endpoints: 0 },
  };
  modules.set(nodeId, module);
  return module;
}

function addSymbolNode(nodes: Map<string, GraphNodeRow>, symbol: SymbolRow, moduleId?: string): void {
  addNode(nodes, {
    nodeId: symbolNodeId(symbol.fq_name, symbol.file),
    nodeType: 'symbol',
    label: symbol.simple_name,
    file: symbol.file,
    line: numberValue(symbol.line),
    role: symbol.framework_role ?? symbol.kind,
    fileRole: symbol.file_role,
    parentNodeId: moduleId,
    stats: { kind: symbol.kind },
    evidence: [{ fqName: symbol.fq_name, frameworkRole: symbol.framework_role ?? '' }],
  });
}

function syntheticSymbolForEndpoint(endpoint: EndpointRow, moduleId: string): GraphNodeRow {
  return {
    nodeId: symbolNodeId(endpoint.handler_symbol, endpoint.file),
    nodeType: 'symbol',
    label: endpoint.handler_symbol.split('.').slice(-2).join('.') || endpoint.handler_symbol,
    file: endpoint.file,
    line: numberValue(endpoint.line),
    role: 'endpoint-handler',
    fileRole: endpoint.file_role,
    parentNodeId: moduleId,
    stats: { framework: endpoint.framework },
    evidence: [{ handlerSymbol: endpoint.handler_symbol, method: endpoint.method, path: endpoint.path }],
  };
}

function addNode(nodes: Map<string, GraphNodeRow>, node: GraphNodeRow): void {
  const existing = nodes.get(node.nodeId);
  if (!existing) {
    nodes.set(node.nodeId, node);
    return;
  }
  existing.stats = { ...existing.stats, ...node.stats };
  existing.evidence = [...existing.evidence, ...node.evidence].slice(0, 10);
  existing.parentNodeId ??= node.parentNodeId;
  existing.file ??= node.file;
  existing.line ??= node.line;
  existing.role ??= node.role;
  existing.language ??= node.language;
  existing.fileRole ??= node.fileRole;
}

function addEdge(edges: Map<string, GraphEdgeRow>, edge: GraphEdgeRow): void {
  if (!edge.fromNodeId || !edge.toNodeId || edge.fromNodeId === edge.toNodeId) return;
  const key = `${edge.fromNodeId}\0${edge.toNodeId}\0${edge.edgeType}`;
  const existing = edges.get(key);
  if (!existing) {
    edges.set(key, {
      ...edge,
      evidence: edge.evidence.slice(0, MAX_EVIDENCE_PER_EDGE),
    });
    return;
  }
  existing.edgeCount += edge.edgeCount;
  existing.confidence = Math.max(existing.confidence, edge.confidence);
  existing.evidence = [...existing.evidence, ...edge.evidence].slice(0, MAX_EVIDENCE_PER_EDGE);
}

async function matchingModules(
  db: CodeGraphDb,
  snapshotId: string,
  target: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const pattern = `%${escapeLike(target)}%`;
  const rows = await db.prepare(`
    SELECT node_id, label, stats_json, evidence_json
    FROM graph_nodes
    WHERE snapshot_id = ?
      AND node_type = 'module'
      AND (
        label ILIKE ? ESCAPE '\\'
        OR node_id ILIKE ? ESCAPE '\\'
        OR evidence_json ILIKE ? ESCAPE '\\'
      )
    ORDER BY label
    LIMIT ?
  `).all(snapshotId, pattern, pattern, pattern, limit) as Array<{
    node_id: string;
    label: string;
    stats_json?: string;
    evidence_json?: string;
  }>;
  return rows.map(compactModuleRow);
}

async function moduleEdges(
  db: CodeGraphDb,
  snapshotId: string,
  moduleIds: string[],
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const placeholders = moduleIds.map(() => '?').join(', ');
  const rows = await db.prepare(`
    SELECT e.from_node_id, e.to_node_id, e.edge_type, e.confidence, e.edge_count, e.evidence_json,
           src.label AS from_label, dst.label AS to_label
    FROM graph_edges e
    LEFT JOIN graph_nodes src ON src.snapshot_id = e.snapshot_id AND src.node_id = e.from_node_id
    LEFT JOIN graph_nodes dst ON dst.snapshot_id = e.snapshot_id AND dst.node_id = e.to_node_id
    WHERE e.snapshot_id = ?
      AND e.edge_type LIKE 'module_%'
      AND (e.from_node_id IN (${placeholders}) OR e.to_node_id IN (${placeholders}))
    ORDER BY e.edge_count DESC, e.confidence DESC
    LIMIT ?
  `).all(snapshotId, ...moduleIds, ...moduleIds, limit) as Array<{
    from_node_id: string;
    to_node_id: string;
    edge_type: string;
    confidence: number | string;
    edge_count: number | string;
    evidence_json?: string;
    from_label?: string;
    to_label?: string;
  }>;
  return rows.map(row => ({
    fromModuleId: row.from_node_id,
    fromModule: row.from_label ?? row.from_node_id,
    toModuleId: row.to_node_id,
    toModule: row.to_label ?? row.to_node_id,
    edgeType: row.edge_type,
    confidence: numberValue(row.confidence),
    edgeCount: numberValue(row.edge_count),
    evidence: parseJsonArray(row.evidence_json).slice(0, 4),
  }));
}

async function bridgeModulesForEdges(
  db: CodeGraphDb,
  snapshotId: string,
  moduleIds: string[],
  relatedEdges: Array<Record<string, unknown>>,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const relatedIds = new Set<string>();
  for (const edge of relatedEdges) {
    for (const key of ['fromModuleId', 'toModuleId']) {
      const value = String(edge[key] ?? '');
      if (value && !moduleIds.includes(value)) relatedIds.add(value);
    }
  }
  if (relatedIds.size === 0) return [];
  const ids = [...relatedIds].slice(0, limit);
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await db.prepare(`
    SELECT node_id, label, stats_json, evidence_json
    FROM graph_nodes
    WHERE snapshot_id = ?
      AND node_id IN (${placeholders})
    ORDER BY label
  `).all(snapshotId, ...ids) as Array<{
    node_id: string;
    label: string;
    stats_json?: string;
    evidence_json?: string;
  }>;
  return rows.map(compactModuleRow);
}

async function siblingFilesForModules(
  db: CodeGraphDb,
  snapshotId: string,
  moduleIds: string[],
  seedFiles: string[],
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const placeholders = moduleIds.map(() => '?').join(', ');
  const rows = await db.prepare(`
    SELECT file, label, parent_node_id
    FROM graph_nodes
    WHERE snapshot_id = ?
      AND node_type = 'file'
      AND parent_node_id IN (${placeholders})
      AND file IS NOT NULL
    ORDER BY file
    LIMIT ?
  `).all(snapshotId, ...moduleIds, limit + seedFiles.length) as Array<{
    file: string;
    label: string;
    parent_node_id?: string;
  }>;
  const seedSet = new Set(seedFiles);
  return rows
    .filter(row => !seedSet.has(row.file))
    .slice(0, limit)
    .map(row => ({ file: row.file, label: row.label, moduleId: row.parent_node_id }));
}

function compactModuleRow(row: { node_id: string; label: string; stats_json?: string; evidence_json?: string }): Record<string, unknown> {
  return {
    nodeId: row.node_id,
    label: row.label,
    stats: parseJsonObject(row.stats_json),
    evidence: parseJsonArray(row.evidence_json).slice(0, 4),
  };
}

function topLevelRoots(paths: string[]): string[] {
  const roots = new Set<string>();
  for (const item of paths) {
    const parts = item.split('/').filter(Boolean);
    roots.add(parts.length > 1 ? parts[0] ?? '' : '');
  }
  return [...roots].sort();
}

function moduleRootForFile(file: string): string {
  const srcIndex = file.indexOf('/src/');
  if (srcIndex > 0) return file.slice(0, srcIndex);
  if (file.startsWith('src/')) return '';
  const parts = file.split('/').filter(Boolean);
  return parts.length > 2 ? parts[0] ?? '' : '';
}

function labelForModuleRoot(rootPrefix: string, fallback: string): string {
  if (!rootPrefix) return fallback;
  return path.posix.basename(rootPrefix) || rootPrefix;
}

function moduleNodeId(value: string): string {
  return `module:${normalizeId(value || 'workspace')}`;
}

function defaultModuleId(workspaceLabel: string): string {
  return moduleNodeId(workspaceLabel || 'workspace');
}

function fileNodeId(file: string): string {
  return `file:${file}`;
}

function endpointNodeId(endpoint: EndpointRow): string {
  return `endpoint:${endpoint.method}:${endpoint.path}:${endpoint.file}:${endpoint.line}`;
}

function symbolNodeId(symbol: string, file: string): string {
  return `symbol:${stripParams(symbol)}:${file}`;
}

function stripParams(value: string): string {
  return value.replace(/\([^)]*\)\s*$/, '');
}

function normalizeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/[^a-z0-9/._-]+/g, '-')
    .replace(/[/.]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workspace';
}

function isBuildMarker(value: string): boolean {
  return /^(pom\.xml|build\.gradle|settings\.gradle|package\.json|go\.mod|Dockerfile|docker-compose\.ya?ml)$/i.test(value);
}

function numberValue(value: number | string | undefined | null): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: string | undefined): Array<Record<string, unknown>> {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>> : [];
  } catch {
    return [];
  }
}

function envFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`);
}
