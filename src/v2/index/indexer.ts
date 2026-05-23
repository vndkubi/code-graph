import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { ParseResult, SymbolInfo } from '../../analyzers/base-analyzer.js';
import { getGitInfo, type GitInfo } from '../git.js';
import { sha256Json, stableId } from '../hash.js';
import { scanManifest, type ManifestFile } from './manifest.js';
import { parseFile, symbolFqName } from './parse.js';
import { roleRank } from './file-role.js';

export interface IndexWorkspaceOptions {
  root: string;
  workspaceKey?: string;
  maxFileSizeBytes?: number;
  force?: boolean;
}

export interface IndexWorkspaceResult {
  workspaceId: string;
  snapshotId: string;
  filesTotal: number;
  filesParsed: number;
  parseCacheHits: number;
  manifestScanMs: number;
  indexTimeMs: number;
}

interface WorkspaceRow {
  id: string;
  root: string;
  workspace_key?: string;
  current_snapshot_id?: string;
  last_indexed_head?: string;
}

interface ParseCacheRow {
  parse_json: string;
}

const HTTP_METHOD_ANNOTATIONS = new Map([
  ['GET', 'GET'],
  ['POST', 'POST'],
  ['PUT', 'PUT'],
  ['DELETE', 'DELETE'],
  ['PATCH', 'PATCH'],
  ['GetMapping', 'GET'],
  ['PostMapping', 'POST'],
  ['PutMapping', 'PUT'],
  ['DeleteMapping', 'DELETE'],
  ['PatchMapping', 'PATCH'],
  ['RequestMapping', 'REQUEST'],
]);

const BEAN_ANNOTATIONS = new Set([
  'Stateless',
  'Stateful',
  'Singleton',
  'ApplicationScoped',
  'RequestScoped',
  'SessionScoped',
  'Dependent',
  'Service',
  'Component',
  'Repository',
  'Controller',
  'RestController',
]);

export class V2Indexer {
  constructor(private readonly db: DatabaseType) {}

  registerWorkspace(root: string, workspaceKey?: string): { workspaceId: string; root: string; workspaceKey?: string; currentSnapshotId?: string } {
    const realRoot = path.resolve(root);
    const git = getGitInfo(realRoot);
    const resolvedWorkspaceKey = normalizeWorkspaceKey(workspaceKey ?? process.env.CODEGRAPH_WORKSPACE_KEY);
    const workspaceId = stableId(workspaceIdentityParts(realRoot, git, resolvedWorkspaceKey));
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO workspaces (id, root, workspace_key, git_remote, git_common_dir, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        root = excluded.root,
        workspace_key = excluded.workspace_key,
        git_remote = excluded.git_remote,
        git_common_dir = excluded.git_common_dir,
        last_seen_at = excluded.last_seen_at
    `).run(workspaceId, realRoot, resolvedWorkspaceKey, git.remoteUrl, git.gitCommonDir, now, now);

    const row = this.db.prepare('SELECT current_snapshot_id FROM workspaces WHERE id = ?')
      .get(workspaceId) as { current_snapshot_id?: string } | undefined;

    return { workspaceId, root: realRoot, workspaceKey: resolvedWorkspaceKey, currentSnapshotId: row?.current_snapshot_id };
  }

  indexWorkspace(options: IndexWorkspaceOptions): IndexWorkspaceResult {
    const start = Date.now();
    const workspace = this.registerWorkspace(options.root, options.workspaceKey);
    const git = getGitInfo(workspace.root);
    const manifest = scanManifest(workspace.root, { maxFileSizeBytes: options.maxFileSizeBytes });
    const snapshotId = stableId([
      workspace.workspaceId,
      git.headCommit,
      git.treeHash,
      git.dirtyHash,
      sha256Json(manifest.files.map(f => [f.relPath, f.blobHash])),
      String(Date.now()),
    ]);
    const now = new Date().toISOString();

    let filesParsed = 0;
    let parseCacheHits = 0;
    const latestSnapshotId = this.getWorkspace(workspace.workspaceId)?.current_snapshot_id;

    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO snapshots (
          id, workspace_id, branch, head_commit, tree_hash, dirty_hash, created_at, status,
          manifest_scan_ms, files_total
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'indexing', ?, ?)
      `).run(
        snapshotId,
        workspace.workspaceId,
        git.branch,
        git.headCommit,
        git.treeHash,
        git.dirtyHash,
        now,
        manifest.scanTimeMs,
        manifest.files.length,
      );

      for (const file of manifest.files) {
        const copied = latestSnapshotId ? this.copyUnchangedFile(latestSnapshotId, snapshotId, file) : false;
        if (copied) {
          parseCacheHits++;
          continue;
        }

        this.insertFile(snapshotId, file, file.parseable ? 'pending' : 'skipped');
        if (!file.parseable || !file.language) continue;

        const cached = this.db.prepare('SELECT parse_json FROM parse_cache WHERE blob_hash = ?')
          .get(file.blobHash) as ParseCacheRow | undefined;
        const parseResult = cached
          ? JSON.parse(cached.parse_json) as ParseResult
          : parseFile(file.absPath, workspace.root);

        if (cached) {
          parseCacheHits++;
        } else {
          filesParsed++;
          this.db.prepare(`
            INSERT INTO parse_cache (
              blob_hash, language, parse_json, has_parse_errors, parse_confidence, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            file.blobHash,
            file.language,
            JSON.stringify(parseResult),
            parseResult.hasParseErrors ? 1 : 0,
            parseResult.parseConfidence,
            now,
          );
        }

        this.materializeParseResult(snapshotId, file, parseResult);
        this.db.prepare(`
          UPDATE files SET parse_status = ? WHERE snapshot_id = ? AND path = ?
        `).run(parseResult.hasParseErrors ? 'error' : 'ok', snapshotId, file.relPath);
      }

      if (latestSnapshotId) {
        this.copyUnchangedRows(latestSnapshotId, snapshotId);
      }
      this.resolveCallEdges(snapshotId);
      this.rebuildDependencyEdges(snapshotId);
      this.db.prepare(`
        UPDATE snapshots
        SET status = 'ready',
            index_time_ms = ?,
            files_parsed = ?,
            parse_cache_hits = ?
        WHERE id = ?
      `).run(Date.now() - start, filesParsed, parseCacheHits, snapshotId);
      this.db.prepare(`
        UPDATE workspaces
        SET current_snapshot_id = ?, last_indexed_head = ?, last_seen_at = ?
        WHERE id = ?
      `).run(snapshotId, git.headCommit, now, workspace.workspaceId);
    });

    tx();

    return {
      workspaceId: workspace.workspaceId,
      snapshotId,
      filesTotal: manifest.files.length,
      filesParsed,
      parseCacheHits,
      manifestScanMs: manifest.scanTimeMs,
      indexTimeMs: Date.now() - start,
    };
  }

  private getWorkspace(workspaceId: string): WorkspaceRow | undefined {
    return this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as WorkspaceRow | undefined;
  }

  private insertFile(snapshotId: string, file: ManifestFile, parseStatus: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO files (
        snapshot_id, path, blob_hash, mtime_ms, size, language, file_role, parse_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(snapshotId, file.relPath, file.blobHash, file.mtimeMs, file.size, file.language, file.role, parseStatus);
  }

  private copyUnchangedFile(fromSnapshotId: string, toSnapshotId: string, file: ManifestFile): boolean {
    const oldFile = this.db.prepare(`
      SELECT blob_hash, parse_status FROM files WHERE snapshot_id = ? AND path = ?
    `).get(fromSnapshotId, file.relPath) as { blob_hash: string; parse_status: string } | undefined;
    if (!oldFile || oldFile.blob_hash !== file.blobHash) return false;

    this.insertFile(toSnapshotId, file, oldFile.parse_status);
    return true;
  }

  private copyUnchangedRows(fromSnapshotId: string, toSnapshotId: string): void {
    for (const table of ['symbols', 'imports', 'type_refs', 'call_edges', 'annotations', 'endpoints', 'beans', 'inheritance']) {
      this.copyRowsForUnchangedFiles(table, fromSnapshotId, toSnapshotId);
    }
  }

  private copyRowsForUnchangedFiles(table: string, fromSnapshotId: string, toSnapshotId: string): void {
    const fileColumn = 'file';
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const selectCols = cols.map(col => col.name === 'snapshot_id' ? '? AS snapshot_id' : `src.${col.name}`).join(', ');
    const insertCols = cols.map(col => col.name).join(', ');
    this.db.prepare(`
      INSERT INTO ${table} (${insertCols})
      SELECT ${selectCols}
      FROM ${table} src
      JOIN files old_file
        ON old_file.snapshot_id = ?
       AND old_file.path = src.${fileColumn}
      JOIN files new_file
        ON new_file.snapshot_id = ?
       AND new_file.path = src.${fileColumn}
       AND new_file.blob_hash = old_file.blob_hash
      WHERE src.snapshot_id = ?
    `).run(toSnapshotId, fromSnapshotId, toSnapshotId, fromSnapshotId);
  }

  private materializeParseResult(snapshotId: string, file: ManifestFile, result: ParseResult): void {
    const classesByName = new Map<string, SymbolInfo>();
    for (const sym of result.symbols) {
      if ((sym.kind === 'class' || sym.kind === 'interface') && sym.name) {
        classesByName.set(sym.name, sym);
      }
    }

    for (const sym of result.symbols) {
      const fqName = symbolFqName(sym);
      this.db.prepare(`
        INSERT OR IGNORE INTO symbols (
          snapshot_id, fq_name, simple_name, kind, file, line, column, end_line, signature,
          visibility, parent, package_name, return_type, parameter_types_json, annotations_json,
          framework_role, framework_meta_json, file_role
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshotId,
        fqName,
        sym.name,
        sym.kind,
        file.relPath,
        sym.line,
        sym.column,
        sym.endLine,
        sym.signature,
        sym.visibility,
        sym.parent,
        sym.packageName,
        sym.returnType,
        JSON.stringify(sym.parameterTypes ?? []),
        JSON.stringify(sym.annotations ?? []),
        sym.frameworkRole,
        JSON.stringify(sym.frameworkMeta ?? {}),
        file.role,
      );

      for (const annotation of sym.annotations ?? []) {
        this.db.prepare(`
          INSERT INTO annotations (snapshot_id, symbol_fq_name, annotation, file, line)
          VALUES (?, ?, ?, ?, ?)
        `).run(snapshotId, fqName, annotation, file.relPath, sym.line);
      }

      this.materializeInheritance(snapshotId, file, sym);
      this.materializeBean(snapshotId, file, sym, fqName);
      this.materializeEndpoint(snapshotId, file, sym, fqName, classesByName);
    }

    for (const imp of result.imports) {
      this.db.prepare(`
        INSERT INTO imports (
          snapshot_id, file, source, imported_symbols_json, line, is_external, file_role
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(snapshotId, file.relPath, imp.source, JSON.stringify(imp.symbols), imp.line, imp.isExternal ? 1 : 0, file.role);
    }

    for (const ref of result.typeReferences ?? []) {
      this.db.prepare(`
        INSERT INTO type_refs (snapshot_id, file, referenced_type, context, line, file_role)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(snapshotId, file.relPath, ref.referencedType, ref.context, ref.line, file.role);
    }

    for (const call of result.calls) {
      this.db.prepare(`
        INSERT INTO call_edges (
          snapshot_id, caller, callee, file, line, confidence, resolution_kind, file_role
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(snapshotId, call.caller, call.callee, file.relPath, call.line, 0.4, 'name-only', file.role);
    }
  }

  private materializeInheritance(snapshotId: string, file: ManifestFile, sym: SymbolInfo): void {
    const child = symbolFqName(sym).replace(/\([^)]*\)$/, '');
    if (sym.extends) {
      this.db.prepare(`
        INSERT INTO inheritance (snapshot_id, child_type, parent_type, kind, file, line, confidence)
        VALUES (?, ?, ?, 'extends', ?, ?, 0.8)
      `).run(snapshotId, child, sym.extends, file.relPath, sym.line);
    }
    for (const parent of sym.implements ?? []) {
      this.db.prepare(`
        INSERT INTO inheritance (snapshot_id, child_type, parent_type, kind, file, line, confidence)
        VALUES (?, ?, ?, 'implements', ?, ?, 0.8)
      `).run(snapshotId, child, parent, file.relPath, sym.line);
    }
  }

  private materializeBean(snapshotId: string, file: ManifestFile, sym: SymbolInfo, fqName: string): void {
    if (sym.kind !== 'class' && sym.kind !== 'interface') return;
    const annotations = sym.annotations ?? [];
    const beanAnnotation = annotations.find(a => BEAN_ANNOTATIONS.has(a));
    if (!beanAnnotation) return;

    this.db.prepare(`
      INSERT INTO beans (
        snapshot_id, bean_type, implementation, scope, qualifiers_json, source, file, line, confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshotId,
      sym.name,
      fqName,
      beanAnnotation,
      JSON.stringify(annotations.filter(a => a.endsWith('Qualifier'))),
      'annotation',
      file.relPath,
      sym.line,
      0.8,
    );
  }

  private materializeEndpoint(
    snapshotId: string,
    file: ManifestFile,
    sym: SymbolInfo,
    fqName: string,
    classesByName: Map<string, SymbolInfo>,
  ): void {
    if (sym.kind !== 'method') return;

    if (
      sym.frameworkRole === 'openapi:endpoint'
      || sym.frameworkRole === 'postman:request'
      || sym.frameworkRole === 'elastic-rest:endpoint'
    ) {
      const method = String(sym.frameworkMeta?.httpMethod ?? 'GET').toUpperCase();
      const endpointPath = String(sym.frameworkMeta?.path ?? '/');
      const framework = sym.frameworkRole === 'elastic-rest:endpoint'
        ? 'elastic-rest'
        : sym.frameworkRole.startsWith('openapi') ? 'openapi' : 'postman';
      this.db.prepare(`
        INSERT INTO endpoints (
          snapshot_id, method, path, path_resolution, path_resolution_reason,
          handler_symbol, controller, file, line, framework, confidence, file_role
        ) VALUES (?, ?, ?, 'exact', NULL, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshotId,
        method,
        endpointPath,
        fqName,
        sym.parent,
        file.relPath,
        sym.line,
        framework,
        0.75,
        file.role,
      );
      return;
    }

    const annotations = sym.annotations ?? [];
    const methodAnnotation = annotations.find(a => HTTP_METHOD_ANNOTATIONS.has(a));
    if (!methodAnnotation) return;

    const httpMethod = sym.frameworkMeta?.httpMethod ?? HTTP_METHOD_ANNOTATIONS.get(methodAnnotation) ?? 'REQUEST';
    const endpointPath = resolveEndpointPath(sym, classesByName.get(sym.parent ?? ''));
    this.db.prepare(`
      INSERT INTO endpoints (
        snapshot_id, method, path, path_resolution, path_resolution_reason,
        handler_symbol, controller, file, line, framework, confidence, file_role
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshotId,
      httpMethod,
      endpointPath.path,
      endpointPath.resolution,
      endpointPath.reason,
      fqName,
      sym.parent,
      file.relPath,
      sym.line,
      methodAnnotation.includes('Mapping') ? 'spring' : 'jakarta',
      endpointPath.resolution === 'exact' ? 0.85 : 0.55,
      file.role,
    );
  }

  private rebuildDependencyEdges(snapshotId: string): void {
    this.db.prepare('DELETE FROM dependency_edges WHERE snapshot_id = ?').run(snapshotId);

    const imports = this.db.prepare(`
      SELECT file, source FROM imports WHERE snapshot_id = ? AND is_external = 0
    `).all(snapshotId) as Array<{ file: string; source: string }>;
    const typeRefs = this.db.prepare(`
      SELECT file, referenced_type FROM type_refs WHERE snapshot_id = ?
    `).all(snapshotId) as Array<{ file: string; referenced_type: string }>;

    const classToFile = new Map<string, string>();
    const symbols = this.db.prepare(`
      SELECT simple_name, fq_name, file FROM symbols
      WHERE snapshot_id = ? AND kind IN ('class', 'interface', 'enum', 'type')
    `).all(snapshotId) as Array<{ simple_name: string; fq_name: string; file: string }>;
    for (const sym of symbols) {
      if (!classToFile.has(sym.simple_name)) classToFile.set(sym.simple_name, sym.file);
      if (!classToFile.has(sym.fq_name)) classToFile.set(sym.fq_name, sym.file);
    }

    const insert = this.db.prepare(`
      INSERT INTO dependency_edges (
        snapshot_id, from_file, to_file, kind, confidence, resolution_kind
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const seen = new Set<string>();
    const addEdge = (from: string, to: string | undefined, kind: string, confidence: number, resolutionKind: string) => {
      if (!to || to === from) return;
      const key = `${from}\0${to}\0${kind}`;
      if (seen.has(key)) return;
      seen.add(key);
      insert.run(snapshotId, from, to, kind, confidence, resolutionKind);
    };

    for (const imp of imports) {
      const simple = imp.source.split('.').pop() ?? imp.source;
      addEdge(imp.file, classToFile.get(imp.source) ?? classToFile.get(simple), 'compile', 0.8, 'import');
    }
    for (const ref of typeRefs) {
      addEdge(ref.file, classToFile.get(ref.referenced_type), 'compile', 0.6, 'type-ref');
    }

    const javaTypesByFqName = new Map<string, string[]>();
    const javaTypes = this.db.prepare(`
      SELECT fq_name, file
      FROM symbols
      WHERE snapshot_id = ?
        AND kind IN ('class', 'interface')
        AND file_role IN ('main_source', 'generated')
    `).all(snapshotId) as Array<{ fq_name: string; file: string }>;
    for (const row of javaTypes) {
      const files = javaTypesByFqName.get(row.fq_name) ?? [];
      files.push(row.file);
      javaTypesByFqName.set(row.fq_name, files);
    }

    const mybatisXmlMappers = this.db.prepare(`
      SELECT fq_name, file, framework_meta_json
      FROM symbols
      WHERE snapshot_id = ?
        AND framework_role = 'mybatis:mapper-xml'
    `).all(snapshotId) as Array<{ fq_name: string; file: string; framework_meta_json?: string }>;
    for (const mapper of mybatisXmlMappers) {
      const meta = parseJsonObject(mapper.framework_meta_json);
      const namespace = typeof meta.namespace === 'string' && meta.namespace ? meta.namespace : mapper.fq_name;
      for (const javaFile of javaTypesByFqName.get(namespace) ?? []) {
        addEdge(mapper.file, javaFile, 'config', 0.95, 'mybatis-namespace');
        addEdge(javaFile, mapper.file, 'config', 0.95, 'mybatis-namespace');
      }
    }
  }

  private resolveCallEdges(snapshotId: string): void {
    const rows = this.db.prepare(`
      SELECT rowid AS row_id, caller, callee, file, line, file_role
      FROM call_edges
      WHERE snapshot_id = ? AND resolution_kind = 'name-only' AND callee LIKE '%.%'
    `).all(snapshotId) as Array<{
      row_id: number;
      caller: string;
      callee: string;
      file: string;
      line: number;
      file_role: string;
    }>;

    const fieldsByFile = new Map<string, Map<string, string>>();
    const fields = this.db.prepare(`
      SELECT file, simple_name, return_type
      FROM symbols
      WHERE snapshot_id = ? AND kind = 'field' AND return_type IS NOT NULL
    `).all(snapshotId) as Array<{ file: string; simple_name: string; return_type: string }>;
    for (const field of fields) {
      let byName = fieldsByFile.get(field.file);
      if (!byName) {
        byName = new Map();
        fieldsByFile.set(field.file, byName);
      }
      byName.set(field.simple_name, field.return_type);
    }

    const implementationsByInterface = new Map<string, string[]>();
    const implementations = this.db.prepare(`
      SELECT parent_type, child_type
      FROM inheritance
      WHERE snapshot_id = ? AND kind = 'implements'
    `).all(snapshotId) as Array<{ parent_type: string; child_type: string }>;
    for (const impl of implementations) {
      const parent = simpleTypeName(impl.parent_type);
      const child = simpleTypeName(impl.child_type);
      const current = implementationsByInterface.get(parent) ?? [];
      current.push(child);
      implementationsByInterface.set(parent, current);
    }

    const methodOwners = new Set(
      (this.db.prepare(`
        SELECT parent, simple_name
        FROM symbols
        WHERE snapshot_id = ? AND kind = 'method' AND parent IS NOT NULL
      `).all(snapshotId) as Array<{ parent: string; simple_name: string }>)
        .map(row => `${row.parent}.${row.simple_name}`),
    );

    const update = this.db.prepare(`
      UPDATE call_edges
      SET callee = ?, confidence = ?, resolution_kind = ?
      WHERE rowid = ?
    `);
    const insert = this.db.prepare(`
      INSERT INTO call_edges (
        snapshot_id, caller, callee, file, line, confidence, resolution_kind, file_role
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertedImplementationEdges = new Set<string>();
    const insertImplementationEdges = (
      row: typeof rows[number],
      receiverType: string,
      method: string,
    ): void => {
      const implementations = implementationsByInterface.get(simpleTypeName(receiverType)) ?? [];
      for (const implementation of implementations) {
        if (!methodOwners.has(`${implementation}.${method}`)) continue;
        const callee = `${implementation}.${method}`;
        const key = `${row.caller}\0${callee}\0${row.file}\0${row.line}`;
        if (insertedImplementationEdges.has(key)) continue;
        insertedImplementationEdges.add(key);
        insert.run(snapshotId, row.caller, callee, row.file, row.line, 0.65, 'interface-implementation', row.file_role);
      }
    };

    for (const row of rows) {
      const dot = row.callee.lastIndexOf('.');
      if (dot <= 0) continue;
      const receiver = row.callee.substring(0, dot);
      const normalizedReceiver = receiver.startsWith('this.') ? receiver.substring('this.'.length) : receiver;
      const method = row.callee.substring(dot + 1);
      const fieldType = fieldsByFile.get(row.file)?.get(normalizedReceiver);
      if (fieldType) {
        update.run(`${fieldType}.${method}`, 0.8, 'receiver-field', row.row_id);
        insertImplementationEdges(row, fieldType, method);
        continue;
      }
      if (/^[A-Z]/.test(receiver)) {
        update.run(row.callee, 0.8, 'static-or-type-receiver', row.row_id);
        insertImplementationEdges(row, receiver, method);
      }
    }
  }
}

export function scoreFileRole(role: string): number {
  return roleRank(role as never);
}

interface EndpointPathResolution {
  path: string;
  resolution: 'exact' | 'partial';
  reason?: string;
}

function resolveEndpointPath(methodSym: SymbolInfo, classSym: SymbolInfo | undefined): EndpointPathResolution {
  const classMeta = classSym?.frameworkMeta ?? {};
  const methodMeta = methodSym.frameworkMeta ?? {};
  const classPath = classMeta.path;
  const methodPath = methodMeta.path;
  const path = composeEndpointPath(classPath, methodPath);
  const reasons = [
    classMeta.pathResolution === 'partial' ? classMeta.pathResolutionReason : undefined,
    methodMeta.pathResolution === 'partial' ? methodMeta.pathResolutionReason : undefined,
  ].filter((reason): reason is string => Boolean(reason));

  if (reasons.length > 0) {
    return { path, resolution: 'partial', reason: reasons.join('; ') };
  }
  if (classPath === undefined && methodPath === undefined) {
    return {
      path,
      resolution: 'partial',
      reason: 'No class-level or method-level path literal/constant was found; using root fallback.',
    };
  }
  return { path, resolution: 'exact' };
}

function composeEndpointPath(classPath: string | undefined, methodPath: string | undefined): string {
  const parts = [classPath, methodPath]
    .filter((part): part is string => part !== undefined)
    .map(part => part.trim())
    .filter(part => part.length > 0 && part !== '/');
  if (parts.length === 0) return '/';
  const joined = parts
    .map((part, index) => index === 0 ? part.replace(/\/+$/g, '') : part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

function simpleTypeName(typeName: string): string {
  const withoutParams = typeName.replace(/\([^)]*\)$/, '');
  const parts = withoutParams.split('.').filter(Boolean);
  return parts[parts.length - 1] ?? withoutParams;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeWorkspaceKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase().replace(/\\/g, '/') : undefined;
}

function workspaceIdentityParts(realRoot: string, git: GitInfo, workspaceKey: string | undefined): Array<string | undefined> {
  if (workspaceKey) return ['workspace-key', workspaceKey];
  return [
    'workspace-path',
    realRoot.toLowerCase().replace(/\\/g, '/'),
    git.remoteUrl,
    git.gitCommonDir,
  ];
}
