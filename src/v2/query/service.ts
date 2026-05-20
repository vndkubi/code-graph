import type { Database as DatabaseType } from 'better-sqlite3';
import { V2Indexer } from '../index/indexer.js';
import { roleRank, type FileRole } from '../index/file-role.js';
import { scanManifest } from '../index/manifest.js';

export interface QueryEnvelope {
  workspaceId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export class V2QueryService {
  private readonly indexer: V2Indexer;

  constructor(private readonly db: DatabaseType) {
    this.indexer = new V2Indexer(db);
  }

  query(envelope: QueryEnvelope): unknown {
    const snapshotId = this.requireSnapshot(envelope.workspaceId);
    switch (envelope.toolName) {
      case 'search_symbol':
        return this.searchSymbol(snapshotId, envelope.args);
      case 'search_files':
        return this.searchFiles(snapshotId, envelope.args);
      case 'find_references':
        return this.findReferences(snapshotId, envelope.args);
      case 'get_file_summary':
        return this.getFileSummary(snapshotId, envelope.args);
      case 'get_dependencies':
        return this.getDependencies(snapshotId, envelope.args);
      case 'get_dependents':
        return this.getDependents(snapshotId, envelope.args);
      case 'get_callers':
        return this.getCallers(snapshotId, envelope.args);
      case 'get_callees':
        return this.getCallees(snapshotId, envelope.args);
      case 'find_endpoints':
        return this.findEndpoints(snapshotId, envelope.args);
      case 'get_impact_radius':
        return this.getImpactRadius(snapshotId, envelope.args);
      case 'trace_dependencies':
        return this.traceDependencies(snapshotId, envelope.args);
      case 'explain_endpoint':
        return this.explainEndpoint(snapshotId, envelope.args);
      case 'impact_of_symbol':
        return this.impactOfSymbol(snapshotId, envelope.args);
      case 'find_tests_for':
        return this.findTestsFor(snapshotId, envelope.args);
      case 'get_research_pack':
        return this.getResearchPack(snapshotId, envelope.args);
      case 'search_code':
        return this.searchCode(snapshotId, envelope.args);
      case 'get_index_stats':
        return this.getIndexStats(snapshotId);
      default:
        throw new Error(`Unknown v2 tool: ${envelope.toolName}`);
    }
  }

  ensureIndexed(root: string): ReturnType<V2Indexer['indexWorkspace']> {
    return this.indexer.indexWorkspace({ root });
  }

  private requireSnapshot(workspaceId: string): string {
    const row = this.db.prepare('SELECT current_snapshot_id FROM workspaces WHERE id = ?')
      .get(workspaceId) as { current_snapshot_id?: string } | undefined;
    if (!row?.current_snapshot_id) {
      throw new Error(`Workspace ${workspaceId} is not indexed yet`);
    }
    return row.current_snapshot_id;
  }

  private searchSymbol(snapshotId: string, args: Record<string, unknown>) {
    const query = String(args.query ?? '*').trim();
    const kind = String(args.kind ?? 'all');
    const limit = Math.min(Number(args.limit ?? 20), 200);
    const cursorOffset = parseCursor(args.cursor);
    const explainRank = Boolean(args.explainRank ?? false);
    const tokens = tokenizeSearchQuery(query);
    const phrasePattern = query === '*' ? '%' : `%${escapeLike(query)}%`;
    const compactQuery = compactSearchText(query);
    const kindFilter = kindFilterFor(kind);
    const intent = detectSearchIntent(query);
    const filters = searchFiltersFor(args, query);
    const baseClauses = [
      'snapshot_id = ?',
      kindFilter.sql,
      ...filters.sql,
    ];
    const baseParams: unknown[] = [snapshotId, ...kindFilter.params, ...filters.params];
    const baseWhere = baseClauses.map(clause => `(${clause})`).join(' AND ');

    if (query === '*' || tokens.length === 0) {
      const totalFound = scalar(this.db, `SELECT COUNT(*) FROM symbols WHERE ${baseWhere}`, ...baseParams);
      const rows = this.db.prepare(`
        SELECT fq_name, simple_name, kind, file, line, signature, visibility, parent,
               package_name, return_type, parameter_types_json, annotations_json,
               framework_role, framework_meta_json, file_role
        FROM symbols
        WHERE ${baseWhere}
        ORDER BY
          CASE file_role
            WHEN 'main_source' THEN 0
            WHEN 'resource_config' THEN 1
            WHEN 'build_config' THEN 2
            WHEN 'test_source' THEN 3
            WHEN 'mock_source' THEN 4
            WHEN 'generated' THEN 5
            ELSE 6
          END,
          simple_name
        LIMIT ?
        OFFSET ?
      `).all(...baseParams, limit, cursorOffset) as SymbolRow[];

      return {
        symbols: rows.map(symbolDto),
        totalFound,
        truncated: cursorOffset + rows.length < totalFound,
        nextCursor: cursorOffset + rows.length < totalFound ? String(cursorOffset + rows.length) : undefined,
        facets: buildFacets(rows),
        filters: filters.effective,
        queryTokens: [],
        searchMode: 'list',
        confidence: 0.8,
        confidenceNotes: ['SQLite-backed symbol lookup; exact Java semantic confidence is shown on graph edges.'],
      };
    }

    const tokenClauses = tokens.map(() => `
      simple_name LIKE ? ESCAPE '\\'
      OR fq_name LIKE ? ESCAPE '\\'
      OR file LIKE ? ESCAPE '\\'
      OR COALESCE(package_name, '') LIKE ? ESCAPE '\\'
      OR COALESCE(framework_role, '') LIKE ? ESCAPE '\\'
    `);
    const whereAnyToken = tokenClauses.map(clause => `(${clause})`).join(' OR ');
    const matchClauses = [`
      simple_name LIKE ? ESCAPE '\\'
      OR fq_name LIKE ? ESCAPE '\\'
      OR file LIKE ? ESCAPE '\\'
    `];
    const matchParams: unknown[] = [phrasePattern, phrasePattern, phrasePattern];
    for (const token of tokens) {
      const pattern = `%${escapeLike(token)}%`;
      matchParams.push(pattern, pattern, pattern, pattern, pattern);
    }
    matchClauses.push(whereAnyToken);
    if (intent.kind === 'entry_point') {
      matchClauses.push(`
        simple_name = 'main'
        OR annotations_json LIKE '%SpringBootApplication%'
        OR COALESCE(framework_role, '') = 'spring:application'
        OR signature LIKE '%CommandLineRunner%'
        OR simple_name LIKE '%Application%'
        OR fq_name LIKE '%Application%'
      `);
    }
    const candidateLimit = Math.min(Math.max((cursorOffset + limit) * 50, 500), 5000);

    const rows = this.db.prepare(`
      SELECT fq_name, simple_name, kind, file, line, signature, visibility, parent,
             package_name, return_type, parameter_types_json, annotations_json,
             framework_role, framework_meta_json, file_role
      FROM symbols
      WHERE ${baseWhere}
        AND (${matchClauses.map(clause => `(${clause})`).join(' OR ')})
      LIMIT ?
    `).all(...baseParams, ...matchParams, candidateLimit) as SymbolRow[];

    const ranked = rows
      .map(row => ({ row, score: scoreSymbolSearch(row, query, compactQuery, tokens, intent) }))
      .filter(candidate => candidate.score.matchedTokens.length > 0 || candidate.score.exactPhrase || candidate.score.intentMatch)
      .sort((a, b) => {
        if (b.score.score !== a.score.score) return b.score.score - a.score.score;
        const roleDelta = roleRank(b.row.file_role) - roleRank(a.row.file_role);
        if (roleDelta !== 0) return roleDelta;
        return a.row.simple_name.localeCompare(b.row.simple_name);
      });
    const selected = ranked.slice(cursorOffset, cursorOffset + limit);

    return {
      symbols: selected.map(candidate => ({
        ...symbolDto(candidate.row),
        searchScore: candidate.score.score,
        matchedTokens: candidate.score.matchedTokens,
        matchReason: candidate.score.reason,
        ...(explainRank ? { rankExplanation: candidate.score.factors } : {}),
      })),
      totalFound: ranked.length,
      truncated: cursorOffset + selected.length < ranked.length,
      nextCursor: cursorOffset + selected.length < ranked.length ? String(cursorOffset + selected.length) : undefined,
      facets: buildFacets(ranked.map(candidate => candidate.row)),
      filters: filters.effective,
      intent: intent.kind === 'none' ? undefined : intent.kind,
      queryTokens: tokens,
      searchMode: intent.kind !== 'none' ? 'intent-ranked' : tokens.length > 1 ? 'multi-token-ranked' : 'token-ranked',
      confidence: ranked.some(candidate => candidate.score.score >= 90) ? 0.85 : 0.65,
      confidenceNotes: [
        'Search ranks exact/phrase matches first, then intent-aware framework entry points, then compact/camel-case and multi-token matches.',
        'Lombok synthetic symbols, tests, generated files, and fixtures are hidden by default unless requested or implied by the query.',
        'For broad natural-language queries, inspect matchedTokens and matchReason before assuming a candidate is exact.',
      ],
    };
  }

  private searchFiles(snapshotId: string, args: Record<string, unknown>) {
    const query = String(args.query ?? '*').trim();
    const limit = Math.min(Number(args.limit ?? 20), 200);
    const cursorOffset = parseCursor(args.cursor);
    const explainRank = Boolean(args.explainRank ?? false);
    const tokens = tokenizeSearchQuery(query);
    const filters = fileFiltersFor(args, query);
    const baseClauses = ['f.snapshot_id = ?', ...filters.sql.map(sql => sql.replace(/\bfile_role\b/g, 'f.file_role'))];
    const baseParams: unknown[] = [snapshotId, ...filters.params];
    const baseWhere = baseClauses.map(clause => `(${clause})`).join(' AND ');

    if (query === '*' || tokens.length === 0) {
      const totalFound = scalar(this.db, `SELECT COUNT(*) FROM files f WHERE ${baseWhere}`, ...baseParams);
      const rows = this.db.prepare(`
        SELECT f.path, f.language, f.file_role, f.parse_status, f.size
        FROM files f
        WHERE ${baseWhere}
        ORDER BY
          CASE f.file_role
            WHEN 'main_source' THEN 0
            WHEN 'resource_config' THEN 1
            WHEN 'build_config' THEN 2
            WHEN 'test_source' THEN 3
            WHEN 'mock_source' THEN 4
            WHEN 'generated' THEN 5
            ELSE 6
          END,
          f.path
        LIMIT ?
        OFFSET ?
      `).all(...baseParams, limit, cursorOffset) as FileRow[];
      const evidence = this.fileEvidence(snapshotId, rows.map(row => row.path));
      return {
        files: rows.map(row => fileDto(row, evidence.get(row.path), undefined, explainRank)),
        totalFound,
        truncated: cursorOffset + rows.length < totalFound,
        nextCursor: cursorOffset + rows.length < totalFound ? String(cursorOffset + rows.length) : undefined,
        facets: buildFileFacets(rows),
        filters: filters.effective,
        queryTokens: [],
        searchMode: 'file-list',
        confidence: 0.8,
      };
    }

    const phrasePattern = `%${escapeLike(query)}%`;
    const matchClauses = [
      `f.path LIKE ? ESCAPE '\\'`,
      `COALESCE(f.language, '') LIKE ? ESCAPE '\\'`,
      `EXISTS (
        SELECT 1 FROM symbols s
        WHERE s.snapshot_id = f.snapshot_id
          AND s.file = f.path
          AND (
            s.simple_name LIKE ? ESCAPE '\\'
            OR s.fq_name LIKE ? ESCAPE '\\'
            OR COALESCE(s.package_name, '') LIKE ? ESCAPE '\\'
            OR COALESCE(s.framework_role, '') LIKE ? ESCAPE '\\'
            OR COALESCE(s.annotations_json, '') LIKE ? ESCAPE '\\'
          )
      )`,
      `EXISTS (
        SELECT 1 FROM endpoints e
        WHERE e.snapshot_id = f.snapshot_id
          AND e.file = f.path
          AND (
            e.path LIKE ? ESCAPE '\\'
            OR e.handler_symbol LIKE ? ESCAPE '\\'
            OR COALESCE(e.controller, '') LIKE ? ESCAPE '\\'
          )
      )`,
      `EXISTS (
        SELECT 1 FROM imports i
        WHERE i.snapshot_id = f.snapshot_id
          AND i.file = f.path
          AND i.source LIKE ? ESCAPE '\\'
      )`,
    ];
    const matchParams: unknown[] = [
      phrasePattern,
      phrasePattern,
      phrasePattern,
      phrasePattern,
      phrasePattern,
      phrasePattern,
      phrasePattern,
      phrasePattern,
      phrasePattern,
      phrasePattern,
      phrasePattern,
    ];

    for (const token of tokens) {
      const pattern = `%${escapeLike(token)}%`;
      matchClauses.push(`(
        f.path LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM symbols s
          WHERE s.snapshot_id = f.snapshot_id
            AND s.file = f.path
            AND (
              s.simple_name LIKE ? ESCAPE '\\'
              OR s.fq_name LIKE ? ESCAPE '\\'
              OR COALESCE(s.package_name, '') LIKE ? ESCAPE '\\'
              OR COALESCE(s.framework_role, '') LIKE ? ESCAPE '\\'
              OR COALESCE(s.annotations_json, '') LIKE ? ESCAPE '\\'
            )
        )
        OR EXISTS (
          SELECT 1 FROM endpoints e
          WHERE e.snapshot_id = f.snapshot_id
            AND e.file = f.path
            AND (
              e.path LIKE ? ESCAPE '\\'
              OR e.handler_symbol LIKE ? ESCAPE '\\'
              OR COALESCE(e.controller, '') LIKE ? ESCAPE '\\'
            )
        )
        OR EXISTS (
          SELECT 1 FROM imports i
          WHERE i.snapshot_id = f.snapshot_id
            AND i.file = f.path
            AND i.source LIKE ? ESCAPE '\\'
        )
      )`);
      matchParams.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
    }

    const candidateLimit = Math.min(Math.max((cursorOffset + limit) * 40, 500), 2000);
    const rows = this.db.prepare(`
      SELECT f.path, f.language, f.file_role, f.parse_status, f.size
      FROM files f
      WHERE ${baseWhere}
        AND (${matchClauses.map(clause => `(${clause})`).join(' OR ')})
      LIMIT ?
    `).all(...baseParams, ...matchParams, candidateLimit) as FileRow[];
    const evidence = this.fileEvidence(snapshotId, rows.map(row => row.path));
    const ranked = rows
      .map(row => ({ row, score: scoreFileSearch(row, evidence.get(row.path), query, tokens) }))
      .filter(candidate => candidate.score.matchedTokens.length > 0 || candidate.score.score > roleRank(candidate.row.file_role) / 10)
      .sort((a, b) => {
        if (b.score.score !== a.score.score) return b.score.score - a.score.score;
        const roleDelta = roleRank(b.row.file_role) - roleRank(a.row.file_role);
        if (roleDelta !== 0) return roleDelta;
        return a.row.path.localeCompare(b.row.path);
      });
    const selected = ranked.slice(cursorOffset, cursorOffset + limit);

    return {
      files: selected.map(candidate => fileDto(candidate.row, evidence.get(candidate.row.path), candidate.score, explainRank)),
      totalFound: ranked.length,
      truncated: cursorOffset + selected.length < ranked.length,
      nextCursor: cursorOffset + selected.length < ranked.length ? String(cursorOffset + selected.length) : undefined,
      facets: buildFileFacets(ranked.map(candidate => candidate.row)),
      filters: filters.effective,
      queryTokens: tokens,
      searchMode: 'file-ranked',
      confidence: ranked.some(candidate => candidate.score.score >= 80) ? 0.8 : 0.6,
      confidenceNotes: [
        'File search ranks path matches, symbols, endpoints, imports, dependency signal, and file role together.',
        'Tests, generated files, and fixtures are hidden by default unless requested or implied by the query.',
      ],
    };
  }

  private findReferences(snapshotId: string, args: Record<string, unknown>) {
    const symbol = String(args.symbol ?? '');
    const kind = String(args.kind ?? 'all');
    const limit = Math.min(Number(args.limit ?? 100), 500);
    const cursorOffset = parseCursor(args.cursor);
    const groupBy = String(args.groupBy ?? 'none');
    const like = `%${escapeLike(symbol)}%`;
    const filters = referenceFiltersFor(args, symbol);
    const branches: string[] = [];
    const params: unknown[] = [];
    const countQueries: Array<{ sql: string; params: unknown[] }> = [];

    if (kind === 'all' || kind === 'definition') {
      const where = [
        'snapshot_id = ?',
        "(simple_name LIKE ? ESCAPE '\\' OR fq_name LIKE ? ESCAPE '\\')",
        ...filters.symbolSql,
      ].join(' AND ');
      branches.push(`
        SELECT file, line, column, 'definition' AS kind, simple_name AS symbol_name,
               fq_name AS source, NULL AS caller, NULL AS callee, NULL AS confidence,
               NULL AS resolution_kind, file_role
        FROM symbols
        WHERE ${where}
      `);
      params.push(snapshotId, like, like, ...filters.symbolParams);
      countQueries.push({ sql: `SELECT COUNT(*) AS count FROM symbols WHERE ${where}`, params: [snapshotId, like, like, ...filters.symbolParams] });
    }

    if (kind === 'all' || kind === 'import') {
      const where = [
        'snapshot_id = ?',
        "source LIKE ? ESCAPE '\\'",
        ...filters.importSql,
      ].join(' AND ');
      branches.push(`
        SELECT file, line, 1 AS column, 'import' AS kind, source AS symbol_name,
               source, NULL AS caller, NULL AS callee, NULL AS confidence,
               NULL AS resolution_kind, file_role
        FROM imports
        WHERE ${where}
      `);
      params.push(snapshotId, like, ...filters.importParams);
      countQueries.push({ sql: `SELECT COUNT(*) AS count FROM imports WHERE ${where}`, params: [snapshotId, like, ...filters.importParams] });
    }

    if (kind === 'all' || kind === 'call') {
      const where = [
        'snapshot_id = ?',
        "callee LIKE ? ESCAPE '\\'",
        ...filters.callSql,
      ].join(' AND ');
      branches.push(`
        SELECT file, line, 1 AS column, 'call' AS kind, callee AS symbol_name,
               callee AS source, caller, callee, confidence, resolution_kind, file_role
        FROM call_edges
        WHERE ${where}
      `);
      params.push(snapshotId, like, ...filters.callParams);
      countQueries.push({ sql: `SELECT COUNT(*) AS count FROM call_edges WHERE ${where}`, params: [snapshotId, like, ...filters.callParams] });
    }

    if (branches.length === 0) {
      return {
        symbol,
        references: [],
        totalCount: 0,
        truncated: false,
        filters: filters.effective,
        confidence: 0.4,
      };
    }

    const referenceRows = this.db.prepare(`
      SELECT * FROM (
        ${branches.join('\nUNION ALL\n')}
      )
      ORDER BY file, line, kind
      LIMIT ?
      OFFSET ?
    `).all(...params, limit, cursorOffset) as Array<Record<string, unknown>>;
    const references = referenceRows.map(referenceDto);
    const totalCount = countQueries.reduce((sum, query) => sum + scalar(this.db, query.sql, ...query.params), 0);

    return {
      symbol,
      references,
      groups: groupBy === 'none' ? undefined : groupReferences(references, groupBy),
      groupBy,
      totalCount,
      truncated: cursorOffset + references.length < totalCount,
      nextCursor: cursorOffset + references.length < totalCount ? String(cursorOffset + references.length) : undefined,
      filters: filters.effective,
      confidence: 0.75,
    };
  }

  private getFileSummary(snapshotId: string, args: Record<string, unknown>) {
    const file = String(args.file ?? '');
    const resolved = this.resolveFile(snapshotId, file);
    if (!resolved) return { error: `File "${file}" not found in index.` };

    const symbols = this.db.prepare(`
      SELECT * FROM symbols WHERE snapshot_id = ? AND file = ? ORDER BY line
    `).all(snapshotId, resolved) as SymbolRow[];
    const imports = this.db.prepare(`
      SELECT source, imported_symbols_json, line, is_external FROM imports
      WHERE snapshot_id = ? AND file = ? ORDER BY line
    `).all(snapshotId, resolved) as Array<{ source: string; imported_symbols_json: string; line: number; is_external: number }>;
    const deps = this.dependencyRows(snapshotId, resolved, 'from_file');
    const dependents = this.dependencyRows(snapshotId, resolved, 'to_file');

    return {
      file: resolved,
      classes: symbols.filter(s => s.kind === 'class' || s.kind === 'interface').map(symbolDto),
      methods: symbols.filter(s => s.kind === 'method' || s.kind === 'function').map(symbolDto),
      fields: symbols.filter(s => s.kind === 'field' || s.kind === 'variable').map(symbolDto),
      imports: imports.map(row => ({
        source: row.source,
        symbols: parseJson<string[]>(row.imported_symbols_json, []),
        isExternal: Boolean(row.is_external),
        line: row.line,
      })),
      dependencies: deps,
      dependents,
      stats: {
        symbolCount: symbols.length,
        importCount: imports.length,
        dependencyCount: deps.length,
        dependentCount: dependents.length,
      },
    };
  }

  private getDependencies(snapshotId: string, args: Record<string, unknown>) {
    const file = this.resolveFile(snapshotId, String(args.module ?? args.file ?? ''));
    if (!file) return { module: args.module, dependencies: [], totalCount: 0 };
    const dependencies = this.dependencyRows(snapshotId, file, 'from_file');
    return { module: file, dependencies, totalCount: dependencies.length };
  }

  private getDependents(snapshotId: string, args: Record<string, unknown>) {
    const file = this.resolveFile(snapshotId, String(args.module ?? args.file ?? ''));
    if (!file) return { module: args.module, direct: [], directCount: 0 };
    const direct = this.dependencyRows(snapshotId, file, 'to_file');
    return { module: file, direct, directCount: direct.length };
  }

  private getCallers(snapshotId: string, args: Record<string, unknown>) {
    const symbol = String(args.symbol ?? args.target ?? '');
    const rows = this.db.prepare(`
      SELECT caller, callee, file, line, confidence, resolution_kind
      FROM call_edges
      WHERE snapshot_id = ? AND callee LIKE ? ESCAPE '\\'
      ORDER BY confidence DESC, file, line
      LIMIT ?
    `).all(snapshotId, `%${escapeLike(symbol)}%`, Number(args.limit ?? 100)) as CallEdgeRow[];
    return { symbol, callers: rows, totalCount: rows.length };
  }

  private getCallees(snapshotId: string, args: Record<string, unknown>) {
    const symbol = String(args.symbol ?? args.source ?? '');
    const rows = this.db.prepare(`
      SELECT caller, callee, file, line, confidence, resolution_kind
      FROM call_edges
      WHERE snapshot_id = ? AND caller LIKE ? ESCAPE '\\'
      ORDER BY confidence DESC, file, line
      LIMIT ?
    `).all(snapshotId, `%${escapeLike(symbol)}%`, Number(args.limit ?? 100)) as CallEdgeRow[];
    return { symbol, callees: rows, totalCount: rows.length };
  }

  private findEndpoints(snapshotId: string, args: Record<string, unknown>) {
    const method = String(args.method ?? 'all').toUpperCase();
    const pathPattern = args.path ? `%${escapeLike(String(args.path))}%` : '%';
    const limit = Math.min(Number(args.limit ?? 200), 500);
    const cursorOffset = parseCursor(args.cursor);
    const rows = this.db.prepare(`
      SELECT method, path, path_resolution, path_resolution_reason,
             handler_symbol, controller, file, line, framework, confidence, file_role
      FROM endpoints
      WHERE snapshot_id = ?
        AND (? = 'ALL' OR method = ?)
        AND path LIKE ? ESCAPE '\\'
      ORDER BY
        CASE file_role WHEN 'main_source' THEN 0 WHEN 'test_source' THEN 2 WHEN 'generated' THEN 3 ELSE 1 END,
        confidence DESC,
        path,
        method
      LIMIT ?
      OFFSET ?
    `).all(snapshotId, method, method, pathPattern, limit, cursorOffset) as EndpointRow[];
    const totalCount = scalar(this.db, `
      SELECT COUNT(*) FROM endpoints
      WHERE snapshot_id = ?
        AND (? = 'ALL' OR method = ?)
        AND path LIKE ? ESCAPE '\\'
    `, snapshotId, method, method, pathPattern);
    return {
      endpoints: rows.map(endpointDto),
      totalCount,
      truncated: cursorOffset + rows.length < totalCount,
      nextCursor: cursorOffset + rows.length < totalCount ? String(cursorOffset + rows.length) : undefined,
      facets: buildEndpointFacets(rows),
    };
  }

  private getImpactRadius(snapshotId: string, args: Record<string, unknown>) {
    const target = String(args.target ?? args.module ?? '');
    const file = this.resolveFile(snapshotId, target);
    const symbolLike = `%${escapeLike(target)}%`;
    const direct = file ? this.dependencyRows(snapshotId, file, 'to_file') : [];
    const callers = this.db.prepare(`
      SELECT caller, callee, file, line, confidence, resolution_kind
      FROM call_edges
      WHERE snapshot_id = ? AND callee LIKE ? ESCAPE '\\'
      ORDER BY confidence DESC
      LIMIT 100
    `).all(snapshotId, symbolLike) as CallEdgeRow[];
    const endpoints = this.impactedEndpoints(snapshotId, direct.map(row => String(row.modulePath ?? row.file ?? '')));
    const score = direct.length + callers.length + endpoints.length;
    return {
      target,
      blastRadius: score >= 10 ? 'high' : score >= 3 ? 'medium' : 'low',
      direct,
      keyCallers: callers,
      impactedEndpoints: endpoints,
      summary: `${direct.length} file dependents, ${callers.length} call sites, ${endpoints.length} endpoint candidates`,
      confidence: callers.some(c => c.confidence >= 0.8) ? 0.75 : 0.55,
    };
  }

  private traceDependencies(snapshotId: string, args: Record<string, unknown>) {
    const target = String(args.target ?? args.module ?? args.file ?? '');
    const direction = normalizeDependencyDirection(String(args.direction ?? 'both'));
    const maxDepth = Math.max(1, Math.min(Number(args.depth ?? 2), 5));
    const limit = Math.min(Number(args.limit ?? 200), 1000);
    const filters = fileFiltersFor(args, target);
    const fileRoles = this.fileRoleMap(snapshotId);
    const seedFiles = this.seedFilesForDependencyTrace(snapshotId, target, filters).filter(file => fileAllowedByRole(file, fileRoles, filters));
    const edges: DependencyTraceEdge[] = [];
    const cycleHints: DependencyTraceEdge[] = [];
    const visited = new Set(seedFiles);
    const queued = new Set(seedFiles);
    const queue = seedFiles.map(file => ({ file, depth: 0 }));

    while (queue.length > 0 && edges.length < limit) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;
      const nextEdges = this.dependencyTraceRows(snapshotId, current.file, direction);
      for (const edge of nextEdges) {
        if (edges.length >= limit) break;
        const neighbor = edge.fromFile === current.file ? edge.toFile : edge.fromFile;
        if (!fileAllowedByRole(neighbor, fileRoles, filters)) continue;
        const traceEdge = { ...edge, depth: current.depth + 1 };
        edges.push(traceEdge);
        if (visited.has(neighbor)) {
          cycleHints.push(traceEdge);
          continue;
        }
        visited.add(neighbor);
        if (!queued.has(neighbor)) {
          queued.add(neighbor);
          queue.push({ file: neighbor, depth: current.depth + 1 });
        }
      }
    }

    const transitiveFiles = [...visited].filter(file => !seedFiles.includes(file));
    const dependencies = edges.filter(edge => seedFiles.includes(edge.fromFile) || direction === 'dependencies');
    const dependents = edges.filter(edge => seedFiles.includes(edge.toFile) || direction === 'dependents');

    return {
      target,
      resolvedAs: seedFiles.length === 1 && this.resolveFile(snapshotId, target) ? 'file' : seedFiles.length > 0 ? 'file-pattern' : 'none',
      direction,
      depth: maxDepth,
      seedFiles,
      edges,
      dependencies,
      dependents,
      transitiveFiles,
      topFiles: rankFiles([
        ...edges.map(edge => edge.fromFile),
        ...edges.map(edge => edge.toFile),
      ]).slice(0, 50),
      impactedEndpoints: this.impactedEndpoints(snapshotId, [...seedFiles, ...transitiveFiles]),
      cycleHints,
      truncated: edges.length >= limit,
      filters: filters.effective,
      confidence: seedFiles.length > 0 ? 0.75 : 0.35,
      confidenceNotes: [
        'Dependency tracing follows indexed import/type-reference edges between files.',
        'Use depth 1 for direct dependencies/dependents and depth 2-5 for transitive impact.',
      ],
    };
  }

  private explainEndpoint(snapshotId: string, args: Record<string, unknown>) {
    const path = String(args.path ?? '');
    const method = String(args.method ?? 'all').toUpperCase();
    const endpointRows = this.db.prepare(`
      SELECT method, path, path_resolution, path_resolution_reason,
             handler_symbol, controller, file, line, framework, confidence, file_role
      FROM endpoints
      WHERE snapshot_id = ?
        AND (? = 'ALL' OR method = ?)
        AND path LIKE ? ESCAPE '\\'
      ORDER BY confidence DESC, LENGTH(path), path
      LIMIT 5
    `).all(snapshotId, method, method, `%${escapeLike(path)}%`) as EndpointRow[];
    const endpoint = endpointRows[0];
    if (!endpoint) {
      return {
        path,
        method,
        error: 'No indexed endpoint matched the requested method/path.',
        suggestions: (this.findEndpoints(snapshotId, { path, limit: 10 }) as { endpoints: unknown[] }).endpoints,
      };
    }

    const callChain = this.traceCallees(snapshotId, endpoint.handler_symbol, Number(args.depth ?? 3));
    const graphFiles = rankFiles([endpoint.file, ...callChain.map(edge => edge.file)]).slice(0, 30);
    const relatedSymbols = this.symbolsForFiles(snapshotId, graphFiles);
    const tests = this.findRelevantTests(snapshotId, endpoint.handler_symbol, 20);

    return {
      endpoint: endpointDto(endpoint),
      controller: {
        symbol: endpoint.handler_symbol,
        className: endpoint.controller,
        file: endpoint.file,
        line: endpoint.line,
      },
      callChain,
      services: relatedSymbols.filter(isServiceLike).slice(0, 20),
      repositories: relatedSymbols.filter(isRepositoryLike).slice(0, 20),
      entities: relatedSymbols.filter(isEntityLike).slice(0, 20),
      dtos: relatedSymbols.filter(isDtoLike).slice(0, 20),
      testsLikelyRelevant: tests,
      topFiles: graphFiles,
      confidenceNotes: [
        'Endpoint path includes class-level and method-level mappings when they were resolved from literals or simple constants.',
        'Call chain follows indexed call edges and may include lower-confidence name-only calls.',
      ],
    };
  }

  private impactOfSymbol(snapshotId: string, args: Record<string, unknown>) {
    const target = String(args.symbol ?? args.target ?? '');
    const definitions = (this.searchSymbol(snapshotId, {
      query: target,
      limit: Number(args.limit ?? 10),
      includeTests: false,
      explainRank: true,
    }) as { symbols: unknown[] }).symbols;
    const callers = (this.getCallers(snapshotId, { symbol: target, limit: 100 }) as { callers: CallEdgeRow[] }).callers;
    const callees = (this.getCallees(snapshotId, { symbol: target, limit: 100 }) as { callees: CallEdgeRow[] }).callees;
    const impact = this.getImpactRadius(snapshotId, { target }) as Record<string, unknown>;

    return {
      target,
      definitions,
      callers,
      callees,
      endpointsAffected: impact.impactedEndpoints ?? [],
      testsLikelyRelevant: this.findRelevantTests(snapshotId, target, 30),
      topFiles: rankFiles([
        ...callers.map(call => call.file),
        ...callees.map(call => call.file),
        ...(((impact.direct as Array<Record<string, unknown>>) ?? []).map(row => String(row.file ?? row.modulePath ?? ''))),
      ]).slice(0, 30),
      blastRadius: impact.blastRadius,
      summary: impact.summary,
    };
  }

  private findTestsFor(snapshotId: string, args: Record<string, unknown>) {
    const target = String(args.symbol ?? args.target ?? '');
    const limit = Math.min(Number(args.limit ?? 50), 200);
    const tests = this.findRelevantTests(snapshotId, target, limit);
    return {
      target,
      tests,
      totalCount: tests.length,
      confidence: tests.length > 0 ? 0.7 : 0.35,
      confidenceNotes: [
        'Tests are ranked by file/name proximity and indexed call edges mentioning the target.',
      ],
    };
  }

  private getResearchPack(snapshotId: string, args: Record<string, unknown>) {
    const target = String(args.target ?? '');
    const tokenBudget = Math.max(1000, Math.min(Number(args.tokenBudget ?? 4000), 12000));
    const definitions = (this.searchSymbol(snapshotId, { query: target, limit: 10 }) as { symbols: unknown[] }).symbols;
    const callers = (this.getCallers(snapshotId, { symbol: target, limit: 30 }) as { callers: CallEdgeRow[] }).callers;
    const callees = (this.getCallees(snapshotId, { symbol: target, limit: 30 }) as { callees: CallEdgeRow[] }).callees;
    const impact = this.getImpactRadius(snapshotId, { target }) as Record<string, unknown>;
    const endpoints = this.findEndpoints(snapshotId, { path: target }) as { endpoints: unknown[] };

    return {
      target,
      taskType: args.taskType ?? 'research',
      tokenBudget,
      definitionCandidates: definitions,
      callers: callers.slice(0, 20),
      callees: callees.slice(0, 20),
      impactedEndpoints: (impact.impactedEndpoints as unknown[]) ?? endpoints.endpoints.slice(0, 20),
      topFiles: rankFiles([
        ...callers.map(c => c.file),
        ...callees.map(c => c.file),
        ...(((impact.direct as Array<Record<string, unknown>>) ?? []).map(d => String(d.file ?? d.modulePath ?? ''))),
      ]).slice(0, 20),
      confidenceNotes: [
        'Definitions and graph edges are ranked by semantic confidence and file role.',
        'Fuzzy/name-only call edges are included with lower confidence until Java receiver resolution is exact.',
      ],
    };
  }

  private searchCode(snapshotId: string, args: Record<string, unknown>) {
    const query = String(args.query ?? '').trim();
    const limit = Math.min(Number(args.limit ?? 10), 50);
    const includeReferences = Boolean(args.includeReferences ?? true);
    const includeDependencies = Boolean(args.includeDependencies ?? true);
    const symbolResults = this.searchSymbol(snapshotId, {
      ...args,
      query,
      limit,
      explainRank: Boolean(args.explainRank ?? false),
    }) as Record<string, unknown>;
    const fileResults = this.searchFiles(snapshotId, {
      ...args,
      query,
      limit,
      explainRank: Boolean(args.explainRank ?? false),
    }) as Record<string, unknown>;
    const endpointResults = this.findEndpoints(snapshotId, {
      path: query,
      method: args.method ?? 'all',
      limit,
    }) as Record<string, unknown>;
    const references = includeReferences && query
      ? this.findReferences(snapshotId, {
        ...args,
        symbol: query,
        limit,
        groupBy: args.groupBy ?? 'file',
      }) as Record<string, unknown>
      : undefined;
    const dependencies = includeDependencies && query
      ? this.traceDependencies(snapshotId, {
        ...args,
        target: query,
        depth: args.depth ?? 1,
        limit: Math.max(limit * 5, 50),
      }) as Record<string, unknown>
      : undefined;

    return {
      query,
      sections: {
        files: fileResults,
        symbols: symbolResults,
        endpoints: endpointResults,
        references,
        dependencies,
      },
      summary: {
        fileMatches: Number(fileResults.totalFound ?? 0),
        symbolMatches: Number(symbolResults.totalFound ?? 0),
        endpointMatches: Number(endpointResults.totalCount ?? 0),
        referenceMatches: references ? Number(references.totalCount ?? 0) : undefined,
        dependencyEdges: dependencies ? ((dependencies.edges as unknown[]) ?? []).length : undefined,
      },
      confidenceNotes: [
        'search_code is a mixed retrieval view; use the section-specific tools when you need deeper pagination or fewer result types.',
      ],
    };
  }

  private getIndexStats(snapshotId: string) {
    const snapshot = this.db.prepare(`
      SELECT s.*, w.root AS workspace_root
      FROM snapshots s
      JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.id = ?
    `).get(snapshotId);
    const counts = {
      files: scalar(this.db, 'SELECT COUNT(*) FROM files WHERE snapshot_id = ?', snapshotId),
      symbols: scalar(this.db, 'SELECT COUNT(*) FROM symbols WHERE snapshot_id = ?', snapshotId),
      imports: scalar(this.db, 'SELECT COUNT(*) FROM imports WHERE snapshot_id = ?', snapshotId),
      callEdges: scalar(this.db, 'SELECT COUNT(*) FROM call_edges WHERE snapshot_id = ?', snapshotId),
      dependencyEdges: scalar(this.db, 'SELECT COUNT(*) FROM dependency_edges WHERE snapshot_id = ?', snapshotId),
      endpoints: scalar(this.db, 'SELECT COUNT(*) FROM endpoints WHERE snapshot_id = ?', snapshotId),
      beans: scalar(this.db, 'SELECT COUNT(*) FROM beans WHERE snapshot_id = ?', snapshotId),
    };
    const fileRoles = this.db.prepare(`
      SELECT file_role, COUNT(*) AS count FROM files WHERE snapshot_id = ? GROUP BY file_role
    `).all(snapshotId);
    const parseFailures = this.db.prepare(`
      SELECT path, language, parse_status FROM files
      WHERE snapshot_id = ? AND parse_status = 'error'
      ORDER BY path
      LIMIT 50
    `).all(snapshotId);
    const endpointWarnings = this.db.prepare(`
      SELECT method, path, path_resolution, path_resolution_reason, handler_symbol, file, line
      FROM endpoints
      WHERE snapshot_id = ? AND path_resolution != 'exact'
      ORDER BY file, line
      LIMIT 50
    `).all(snapshotId);

    return {
      snapshot,
      counts,
      fileRoles,
      diagnostics: {
        parseFailures,
        staleFiles: this.computeDirtyFiles(snapshotId),
        topUnresolvedImports: this.topUnresolvedImports(snapshotId),
        topUnresolvedCalls: this.db.prepare(`
          SELECT callee, COUNT(*) AS count, MAX(confidence) AS maxConfidence
          FROM call_edges
          WHERE snapshot_id = ? AND resolution_kind = 'name-only'
          GROUP BY callee
          ORDER BY count DESC, callee
          LIMIT 20
        `).all(snapshotId),
        frameworkWarnings: {
          endpointPathUnresolved: endpointWarnings,
          endpointPathUnresolvedCount: scalar(this.db, `
            SELECT COUNT(*) FROM endpoints WHERE snapshot_id = ? AND path_resolution != 'exact'
          `, snapshotId),
        },
      },
    };
  }

  private dependencyRows(snapshotId: string, file: string, direction: 'from_file' | 'to_file') {
    const selectTarget = direction === 'from_file' ? 'to_file' : 'from_file';
    const rows = this.db.prepare(`
      SELECT ${selectTarget} AS file, kind, confidence, resolution_kind
      FROM dependency_edges
      WHERE snapshot_id = ? AND ${direction} = ?
      ORDER BY confidence DESC, file
      LIMIT 500
    `).all(snapshotId, file) as Array<{ file: string; kind: string; confidence: number; resolution_kind: string }>;
    return rows.map(row => ({
      file: row.file,
      moduleId: row.file,
      modulePath: row.file,
      type: row.kind,
      confidence: row.confidence,
      resolutionKind: row.resolution_kind,
    }));
  }

  private seedFilesForDependencyTrace(
    snapshotId: string,
    target: string,
    filters: ReturnType<typeof fileFiltersFor>,
  ): string[] {
    const resolved = this.resolveFile(snapshotId, target);
    if (resolved) return [resolved];
    if (!target) return [];
    const normalized = target.replace(/\\/g, '/');
    const pattern = `%${escapeLike(normalized)}%`;
    const filterSql = filters.sql.length > 0
      ? `AND ${filters.sql.map(sql => `(${sql.replace(/\bfile_role\b/g, 'f.file_role')})`).join(' AND ')}`
      : '';
    const rows = this.db.prepare(`
      SELECT f.path
      FROM files f
      WHERE f.snapshot_id = ?
        AND f.path LIKE ? ESCAPE '\\'
        ${filterSql}
      ORDER BY
        CASE f.file_role WHEN 'main_source' THEN 0 WHEN 'test_source' THEN 2 WHEN 'generated' THEN 3 ELSE 1 END,
        LENGTH(f.path),
        f.path
      LIMIT 100
    `).all(snapshotId, pattern, ...filters.params) as Array<{ path: string }>;
    return rows.map(row => row.path);
  }

  private dependencyTraceRows(
    snapshotId: string,
    file: string,
    direction: 'dependencies' | 'dependents' | 'both',
  ): DependencyTraceEdge[] {
    const clauses: string[] = [];
    const params: unknown[] = [snapshotId];
    if (direction === 'dependencies' || direction === 'both') {
      clauses.push('from_file = ?');
      params.push(file);
    }
    if (direction === 'dependents' || direction === 'both') {
      clauses.push('to_file = ?');
      params.push(file);
    }
    if (clauses.length === 0) return [];
    const rows = this.db.prepare(`
      SELECT from_file, to_file, kind, confidence, resolution_kind
      FROM dependency_edges
      WHERE snapshot_id = ? AND (${clauses.join(' OR ')})
      ORDER BY confidence DESC, from_file, to_file
      LIMIT 500
    `).all(...params) as Array<{
      from_file: string;
      to_file: string;
      kind: string;
      confidence: number;
      resolution_kind: string;
    }>;
    return rows.map(row => ({
      fromFile: row.from_file,
      toFile: row.to_file,
      kind: row.kind,
      confidence: row.confidence,
      resolutionKind: row.resolution_kind,
      depth: 1,
    }));
  }

  private fileRoleMap(snapshotId: string): Map<string, string> {
    const rows = this.db.prepare(`
      SELECT path, file_role FROM files WHERE snapshot_id = ?
    `).all(snapshotId) as Array<{ path: string; file_role: string }>;
    return new Map(rows.map(row => [row.path, row.file_role]));
  }

  private resolveFile(snapshotId: string, query: string): string | undefined {
    if (!query) return undefined;
    const normalized = query.replace(/\\/g, '/');
    const exact = this.db.prepare('SELECT path FROM files WHERE snapshot_id = ? AND path = ?')
      .get(snapshotId, normalized) as { path: string } | undefined;
    if (exact) return exact.path;
    const basename = normalized.includes('/') ? normalized.substring(normalized.lastIndexOf('/') + 1) : normalized;
    const row = this.db.prepare(`
      SELECT path FROM files
      WHERE snapshot_id = ?
        AND (path LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')
      ORDER BY LENGTH(path)
      LIMIT 1
    `).get(snapshotId, `%/${escapeLike(normalized)}`, `%/${escapeLike(basename)}`) as { path: string } | undefined;
    return row?.path;
  }

  private traceCallees(snapshotId: string, handlerSymbol: string, depth: number): CallEdgeRow[] {
    const maxDepth = Math.max(1, Math.min(depth, 5));
    const start = callGraphName(handlerSymbol);
    const queue: Array<{ caller: string; depth: number }> = [{ caller: start, depth: 0 }];
    const seenCallers = new Set<string>();
    const edges: CallEdgeRow[] = [];

    while (queue.length > 0 && edges.length < 100) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth || seenCallers.has(current.caller)) continue;
      seenCallers.add(current.caller);
      const rows = this.db.prepare(`
        SELECT caller, callee, file, line, confidence, resolution_kind
        FROM call_edges
        WHERE snapshot_id = ? AND caller LIKE ? ESCAPE '\\'
        ORDER BY confidence DESC, line
        LIMIT 25
      `).all(snapshotId, `%${escapeLike(current.caller)}%`) as CallEdgeRow[];
      for (const row of rows) {
        edges.push(row);
        const next = callGraphName(row.callee);
        if (next && !seenCallers.has(next)) queue.push({ caller: next, depth: current.depth + 1 });
      }
    }
    return edges;
  }

  private symbolsForFiles(snapshotId: string, files: string[]): Array<Record<string, unknown>> {
    const unique = [...new Set(files.filter(Boolean))].slice(0, 200);
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT fq_name, simple_name, kind, file, line, signature, visibility, parent,
             package_name, return_type, parameter_types_json, annotations_json,
             framework_role, framework_meta_json, file_role
      FROM symbols
      WHERE snapshot_id = ? AND file IN (${placeholders})
      ORDER BY file, line
      LIMIT 1000
    `).all(snapshotId, ...unique) as SymbolRow[];
    return rows.map(symbolDto);
  }

  private fileEvidence(snapshotId: string, files: string[]): Map<string, FileEvidence> {
    const unique = [...new Set(files.filter(Boolean))].slice(0, 2000);
    const evidence = new Map<string, FileEvidence>();
    for (const file of unique) {
      evidence.set(file, {
        symbols: [],
        endpoints: [],
        dependencyCounts: { outgoing: 0, incoming: 0 },
        importCount: 0,
      });
    }
    if (unique.length === 0) return evidence;
    const placeholders = unique.map(() => '?').join(', ');

    const symbols = this.db.prepare(`
      SELECT fq_name, simple_name, kind, file, line, signature, visibility, parent,
             package_name, return_type, parameter_types_json, annotations_json,
             framework_role, framework_meta_json, file_role
      FROM symbols
      WHERE snapshot_id = ? AND file IN (${placeholders})
      ORDER BY file, line
      LIMIT 10000
    `).all(snapshotId, ...unique) as SymbolRow[];
    for (const row of symbols) {
      const current = evidence.get(row.file);
      if (!current) continue;
      current.symbols.push(symbolDto(row));
    }

    const endpoints = this.db.prepare(`
      SELECT method, path, path_resolution, path_resolution_reason,
             handler_symbol, controller, file, line, framework, confidence, file_role
      FROM endpoints
      WHERE snapshot_id = ? AND file IN (${placeholders})
      ORDER BY file, line
      LIMIT 5000
    `).all(snapshotId, ...unique) as EndpointRow[];
    for (const row of endpoints) {
      const current = evidence.get(row.file);
      if (!current) continue;
      current.endpoints.push(endpointDto(row));
    }

    const outgoing = this.db.prepare(`
      SELECT from_file AS file, COUNT(*) AS count
      FROM dependency_edges
      WHERE snapshot_id = ? AND from_file IN (${placeholders})
      GROUP BY from_file
    `).all(snapshotId, ...unique) as Array<{ file: string; count: number }>;
    for (const row of outgoing) {
      const current = evidence.get(row.file);
      if (current) current.dependencyCounts.outgoing = row.count;
    }

    const incoming = this.db.prepare(`
      SELECT to_file AS file, COUNT(*) AS count
      FROM dependency_edges
      WHERE snapshot_id = ? AND to_file IN (${placeholders})
      GROUP BY to_file
    `).all(snapshotId, ...unique) as Array<{ file: string; count: number }>;
    for (const row of incoming) {
      const current = evidence.get(row.file);
      if (current) current.dependencyCounts.incoming = row.count;
    }

    const imports = this.db.prepare(`
      SELECT file, COUNT(*) AS count
      FROM imports
      WHERE snapshot_id = ? AND file IN (${placeholders})
      GROUP BY file
    `).all(snapshotId, ...unique) as Array<{ file: string; count: number }>;
    for (const row of imports) {
      const current = evidence.get(row.file);
      if (current) current.importCount = row.count;
    }

    return evidence;
  }

  private findRelevantTests(snapshotId: string, target: string, limit: number): Array<Record<string, unknown>> {
    const terms = searchTermsForTarget(target);
    if (terms.length === 0) return [];
    const candidates = new Map<string, { file: string; score: number; reasons: Set<string> }>();
    const add = (file: string, score: number, reason: string) => {
      if (!file) return;
      const existing = candidates.get(file) ?? { file, score: 0, reasons: new Set<string>() };
      existing.score += score;
      existing.reasons.add(reason);
      candidates.set(file, existing);
    };

    for (const term of terms) {
      const pattern = `%${escapeLike(term)}%`;
      const files = this.db.prepare(`
        SELECT path AS file
        FROM files
        WHERE snapshot_id = ?
          AND file_role IN ('test_source', 'mock_source')
          AND path LIKE ? ESCAPE '\\'
        LIMIT 100
      `).all(snapshotId, pattern) as Array<{ file: string }>;
      for (const row of files) add(row.file, 4, `test file path matches "${term}"`);

      const symbols = this.db.prepare(`
        SELECT DISTINCT file
        FROM symbols
        WHERE snapshot_id = ?
          AND file_role IN ('test_source', 'mock_source')
          AND (simple_name LIKE ? ESCAPE '\\' OR fq_name LIKE ? ESCAPE '\\')
        LIMIT 100
      `).all(snapshotId, pattern, pattern) as Array<{ file: string }>;
      for (const row of symbols) add(row.file, 3, `test symbol matches "${term}"`);

      const calls = this.db.prepare(`
        SELECT DISTINCT file
        FROM call_edges
        WHERE snapshot_id = ?
          AND file_role IN ('test_source', 'mock_source')
          AND (caller LIKE ? ESCAPE '\\' OR callee LIKE ? ESCAPE '\\')
        LIMIT 100
      `).all(snapshotId, pattern, pattern) as Array<{ file: string }>;
      for (const row of calls) add(row.file, 6, `test call edge mentions "${term}"`);
    }

    return [...candidates.values()]
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
      .slice(0, limit)
      .map(candidate => ({
        file: candidate.file,
        score: candidate.score,
        reasons: [...candidate.reasons],
      }));
  }

  private computeDirtyFiles(snapshotId: string): Record<string, unknown> {
    const snapshot = this.db.prepare(`
      SELECT w.root AS root
      FROM snapshots s
      JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.id = ?
    `).get(snapshotId) as { root?: string } | undefined;
    if (!snapshot?.root) return { error: 'Workspace root not found for snapshot.' };

    try {
      const manifest = scanManifest(snapshot.root);
      const current = new Map(manifest.files.map(file => [file.relPath, file.blobHash]));
      const indexedRows = this.db.prepare(`
        SELECT path, blob_hash FROM files WHERE snapshot_id = ?
      `).all(snapshotId) as Array<{ path: string; blob_hash: string }>;
      const indexed = new Map(indexedRows.map(row => [row.path, row.blob_hash]));
      const added: string[] = [];
      const modified: string[] = [];
      const deleted: string[] = [];
      for (const [file, hash] of current.entries()) {
        const previous = indexed.get(file);
        if (!previous) added.push(file);
        else if (previous !== hash) modified.push(file);
      }
      for (const file of indexed.keys()) {
        if (!current.has(file)) deleted.push(file);
      }
      return {
        addedCount: added.length,
        modifiedCount: modified.length,
        deletedCount: deleted.length,
        scanTimeMs: manifest.scanTimeMs,
        samples: {
          added: added.slice(0, 20),
          modified: modified.slice(0, 20),
          deleted: deleted.slice(0, 20),
        },
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private topUnresolvedImports(snapshotId: string): Array<Record<string, unknown>> {
    const symbols = this.db.prepare(`
      SELECT fq_name, simple_name FROM symbols WHERE snapshot_id = ? AND kind IN ('class', 'interface', 'enum', 'type')
    `).all(snapshotId) as Array<{ fq_name: string; simple_name: string }>;
    const known = new Set<string>();
    for (const symbol of symbols) {
      known.add(symbol.fq_name);
      known.add(symbol.simple_name);
    }
    const imports = this.db.prepare(`
      SELECT source FROM imports WHERE snapshot_id = ?
    `).all(snapshotId) as Array<{ source: string }>;
    const counts = new Map<string, number>();
    for (const imp of imports) {
      if (isCommonExternalImport(imp.source)) continue;
      const simple = imp.source.substring(imp.source.lastIndexOf('.') + 1);
      if (known.has(imp.source) || known.has(simple)) continue;
      counts.set(imp.source, (counts.get(imp.source) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 20)
      .map(([source, count]) => ({ source, count }));
  }

  private impactedEndpoints(snapshotId: string, files: string[]): Array<Record<string, unknown>> {
    const unique = [...new Set(files.filter(Boolean))].slice(0, 200);
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT method, path, path_resolution, path_resolution_reason,
             handler_symbol, controller, file, line, framework, confidence, file_role
      FROM endpoints
      WHERE snapshot_id = ? AND file IN (${placeholders})
      ORDER BY confidence DESC, path
      LIMIT 100
    `).all(snapshotId, ...unique) as EndpointRow[];
    return rows.map(endpointDto);
  }
}

interface SymbolRow {
  fq_name: string;
  simple_name: string;
  kind: string;
  file: string;
  line: number;
  signature: string;
  visibility: string;
  parent?: string;
  package_name?: string;
  return_type?: string;
  parameter_types_json?: string;
  annotations_json?: string;
  framework_role?: string;
  framework_meta_json?: string;
  file_role: FileRole;
}

interface CallEdgeRow {
  caller: string;
  callee: string;
  file: string;
  line: number;
  confidence: number;
  resolution_kind: string;
}

interface EndpointRow {
  method: string;
  path: string;
  path_resolution: string;
  path_resolution_reason?: string;
  handler_symbol: string;
  controller?: string;
  file: string;
  line: number;
  framework: string;
  confidence: number;
  file_role: string;
}

interface FileRow {
  path: string;
  language?: string;
  file_role: FileRole;
  parse_status: string;
  size: number;
}

interface FileEvidence {
  symbols: Array<Record<string, unknown>>;
  endpoints: Array<Record<string, unknown>>;
  dependencyCounts: {
    outgoing: number;
    incoming: number;
  };
  importCount: number;
}

interface FileSearchScore {
  score: number;
  matchedTokens: string[];
  reason: string;
  factors: string[];
}

interface DependencyTraceEdge {
  fromFile: string;
  toFile: string;
  kind: string;
  confidence: number;
  resolutionKind: string;
  depth: number;
}

interface SearchScore {
  score: number;
  matchedTokens: string[];
  reason: string;
  exactPhrase: boolean;
  intentMatch: boolean;
  factors: string[];
}

function symbolDto(row: SymbolRow): Record<string, unknown> {
  const frameworkMeta = parseJson<Record<string, string>>(row.framework_meta_json, {});
  return {
    name: row.simple_name,
    fqName: row.fq_name,
    kind: row.kind,
    file: row.file,
    line: row.line,
    signature: row.signature,
    visibility: row.visibility,
    parent: row.parent,
    packageName: row.package_name,
    returnType: row.return_type,
    parameterTypes: parseJson<string[]>(row.parameter_types_json, []),
    annotations: parseJson<string[]>(row.annotations_json, []),
    frameworkRole: row.framework_role,
    frameworkMeta,
    synthetic: frameworkMeta.synthetic === 'true',
    fileRole: row.file_role,
    rank: roleRank(row.file_role),
  };
}

function endpointDto(row: EndpointRow): Record<string, unknown> {
  return {
    method: row.method,
    path: row.path,
    pathResolution: row.path_resolution,
    pathResolutionReason: row.path_resolution_reason,
    handlerSymbol: row.handler_symbol,
    controller: row.controller,
    file: row.file,
    line: row.line,
    framework: row.framework,
    confidence: row.confidence,
    fileRole: row.file_role,
  };
}

function fileDto(
  row: FileRow,
  evidence: FileEvidence | undefined,
  score: FileSearchScore | undefined,
  explainRank: boolean,
): Record<string, unknown> {
  const topSymbols = (evidence?.symbols ?? [])
    .filter(symbol => symbol.kind === 'class' || symbol.kind === 'interface' || symbol.kind === 'method' || symbol.kind === 'function')
    .slice(0, 12);
  return {
    path: row.path,
    language: row.language,
    fileRole: row.file_role,
    parseStatus: row.parse_status,
    size: row.size,
    searchScore: score?.score,
    matchedTokens: score?.matchedTokens,
    matchReason: score?.reason,
    ...(explainRank && score ? { rankExplanation: score.factors } : {}),
    topSymbols,
    endpoints: (evidence?.endpoints ?? []).slice(0, 12),
    dependencyCounts: evidence?.dependencyCounts ?? { outgoing: 0, incoming: 0 },
    stats: {
      symbolCount: evidence?.symbols.length ?? 0,
      endpointCount: evidence?.endpoints.length ?? 0,
      importCount: evidence?.importCount ?? 0,
    },
  };
}

function referenceDto(row: Record<string, unknown>): Record<string, unknown> {
  return {
    file: row.file,
    line: row.line,
    column: row.column,
    kind: row.kind,
    symbolName: row.symbol_name,
    source: row.source,
    caller: row.caller,
    callee: row.callee,
    confidence: row.confidence,
    resolutionKind: row.resolution_kind,
    fileRole: row.file_role,
  };
}

interface SearchIntent {
  kind: 'none' | 'entry_point';
}

function scoreSymbolSearch(
  row: SymbolRow,
  query: string,
  compactQuery: string,
  tokens: string[],
  intent: SearchIntent,
): SearchScore {
  const queryLower = query.toLowerCase();
  const simpleLower = row.simple_name.toLowerCase();
  const fqLower = row.fq_name.toLowerCase();
  const fileLower = row.file.toLowerCase();
  const packageLower = (row.package_name ?? '').toLowerCase();
  const frameworkLower = (row.framework_role ?? '').toLowerCase();
  const signatureLower = row.signature.toLowerCase();
  const annotations = parseJson<string[]>(row.annotations_json, []);
  const annotationLower = annotations.join(' ').toLowerCase();
  const simpleCompact = compactSearchText(row.simple_name);
  const fqCompact = compactSearchText(row.fq_name);
  const fileCompact = compactSearchText(row.file);
  const haystack = `${simpleLower} ${fqLower} ${fileLower} ${packageLower} ${frameworkLower} ${signatureLower} ${annotationLower}`;
  const haystackCompact = `${simpleCompact} ${fqCompact} ${fileCompact}`;
  const matchedTokens = tokens.filter(token => haystack.includes(token) || haystackCompact.includes(compactSearchText(token)));
  const allTokensMatched = matchedTokens.length === tokens.length;
  const matchedInSimple = tokens.filter(token => simpleLower.includes(token) || simpleCompact.includes(compactSearchText(token)));
  const exactPhrase = simpleLower === queryLower || fqLower === queryLower
    || simpleLower.includes(queryLower)
    || fqLower.includes(queryLower);

  let score = 0;
  let reason = 'partial token match';
  const factors: string[] = [];

  if (simpleLower === queryLower || fqLower === queryLower) {
    score = 120;
    reason = 'exact symbol/FQCN match';
    factors.push('exact symbol or FQCN equals query');
  } else if (compactQuery && (simpleCompact === compactQuery || fqCompact.endsWith(compactQuery))) {
    score = 112;
    reason = 'exact compact/camel-case match';
    factors.push('compact/camel-case form equals query');
  } else if (exactPhrase) {
    score = 98;
    reason = 'exact phrase contained in symbol/FQCN';
    factors.push('query phrase appears in symbol or FQCN');
  } else if (allTokensMatched && matchedInSimple.length === tokens.length) {
    score = 88;
    reason = 'all query tokens matched symbol name';
    factors.push('all query tokens matched the simple symbol name');
  } else if (allTokensMatched) {
    score = 74;
    reason = 'all query tokens matched symbol/FQCN/file metadata';
    factors.push('all query tokens matched symbol metadata');
  } else if (matchedTokens.length > 0) {
    score = 40 + Math.round((matchedTokens.length / tokens.length) * 30);
    if (matchedInSimple.length > 0) score += 8;
    factors.push(`matched ${matchedTokens.length}/${tokens.length} query tokens`);
  }

  const intentScore = scoreSearchIntent(row, intent, annotations);
  if (intentScore.score > 0) {
    score += intentScore.score;
    reason = intentScore.reason;
    factors.push(...intentScore.factors);
  } else if (intent.kind === 'entry_point' && matchedTokens.length === 1 && matchedTokens[0] === 'point') {
    score -= 35;
    factors.push('penalized lone "point" token match for entry-point intent');
  }

  const syntheticPenalty = isSyntheticSymbol(row) ? -60 : 0;
  if (syntheticPenalty) {
    score += syntheticPenalty;
    factors.push('lombok synthetic symbol penalty');
  }
  const fileRoleBoost = Math.round(roleRank(row.file_role) / 10);
  score += fileRoleBoost;
  factors.push(`file role ${row.file_role} contributed ${fileRoleBoost} points`);

  return {
    score,
    matchedTokens,
    reason,
    exactPhrase,
    intentMatch: intentScore.score > 0,
    factors,
  };
}

function detectSearchIntent(query: string): SearchIntent {
  const lower = query.toLowerCase();
  if (/\bentry\s*point\b/.test(lower) || /\bmain\s+application\b/.test(lower) || /\bapplication\s+entry\b/.test(lower)) {
    return { kind: 'entry_point' };
  }
  return { kind: 'none' };
}

function scoreSearchIntent(row: SymbolRow, intent: SearchIntent, annotations: string[]): { score: number; reason: string; factors: string[] } {
  if (intent.kind !== 'entry_point') return { score: 0, reason: '', factors: [] };
  const factors: string[] = [];
  let score = 0;
  const simple = row.simple_name.toLowerCase();
  const fq = row.fq_name.toLowerCase();
  const signature = row.signature.toLowerCase();

  if (row.kind === 'method' && simple === 'main') {
    score += 125;
    factors.push('entry-point intent matched main() method');
  }
  if (annotations.includes('SpringBootApplication') || row.framework_role === 'spring:application') {
    score += 86;
    factors.push('entry-point intent matched @SpringBootApplication');
  }
  if (signature.includes('commandlinerunner') || fq.includes('commandlinerunner')) {
    score += 74;
    factors.push('entry-point intent matched CommandLineRunner');
  }
  if ((row.kind === 'class' || row.kind === 'interface') && simple.endsWith('application')) {
    score += 42;
    factors.push('entry-point intent matched Application class name');
  }
  return {
    score,
    reason: score > 0 ? 'entry-point intent match' : '',
    factors,
  };
}

function isSyntheticSymbol(row: SymbolRow): boolean {
  return parseJson<Record<string, string>>(row.framework_meta_json, {}).synthetic === 'true';
}

function searchFiltersFor(args: Record<string, unknown>, query: string): {
  sql: string[];
  params: unknown[];
  effective: Record<string, unknown>;
} {
  const includeTests = typeof args.includeTests === 'boolean' ? args.includeTests : hasTestIntent(query);
  const includeGenerated = typeof args.includeGenerated === 'boolean' ? args.includeGenerated : hasGeneratedIntent(query);
  const includeFixtures = typeof args.includeFixtures === 'boolean' ? args.includeFixtures : includeTests || hasFixtureIntent(query);
  const includeSynthetic = typeof args.includeSynthetic === 'boolean' ? args.includeSynthetic : hasSyntheticIntent(query);
  const sql: string[] = [];
  const params: unknown[] = [];

  if (!includeTests) sql.push("file_role != 'test_source'");
  if (!includeGenerated) sql.push("file_role != 'generated'");
  if (!includeFixtures) sql.push("file_role != 'mock_source'");
  if (!includeSynthetic) sql.push("COALESCE(framework_meta_json, '') NOT LIKE '%\"synthetic\":\"true\"%'");

  const frameworkRole = args.frameworkRole ? String(args.frameworkRole) : '';
  if (frameworkRole) {
    sql.push("COALESCE(framework_role, '') = ?");
    params.push(frameworkRole);
  }
  const annotation = args.annotation ? String(args.annotation) : '';
  if (annotation) {
    sql.push("COALESCE(annotations_json, '') LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(annotation)}%`);
  }

  return {
    sql,
    params,
    effective: {
      includeSynthetic,
      includeTests,
      includeGenerated,
      includeFixtures,
      frameworkRole: frameworkRole || undefined,
      annotation: annotation || undefined,
    },
  };
}

function fileFiltersFor(args: Record<string, unknown>, query: string): {
  sql: string[];
  params: unknown[];
  effective: Record<string, unknown>;
} {
  const includeTests = typeof args.includeTests === 'boolean' ? args.includeTests : hasTestIntent(query);
  const includeGenerated = typeof args.includeGenerated === 'boolean' ? args.includeGenerated : hasGeneratedIntent(query);
  const includeFixtures = typeof args.includeFixtures === 'boolean' ? args.includeFixtures : includeTests || hasFixtureIntent(query);
  const sql: string[] = [];
  const params: unknown[] = [];

  if (!includeTests) sql.push("file_role != 'test_source'");
  if (!includeGenerated) sql.push("file_role != 'generated'");
  if (!includeFixtures) sql.push("file_role != 'mock_source'");

  const fileRole = args.fileRole ? String(args.fileRole) : '';
  if (fileRole) {
    sql.push('file_role = ?');
    params.push(fileRole);
  }
  const language = args.language ? String(args.language) : '';
  if (language) {
    sql.push('language = ?');
    params.push(language);
  }

  return {
    sql,
    params,
    effective: {
      includeTests,
      includeGenerated,
      includeFixtures,
      fileRole: fileRole || undefined,
      language: language || undefined,
    },
  };
}

function referenceFiltersFor(args: Record<string, unknown>, query: string): {
  symbolSql: string[];
  symbolParams: unknown[];
  importSql: string[];
  importParams: unknown[];
  callSql: string[];
  callParams: unknown[];
  effective: Record<string, unknown>;
} {
  const fileFilters = fileFiltersFor(args, query);
  const includeSynthetic = typeof args.includeSynthetic === 'boolean' ? args.includeSynthetic : hasSyntheticIntent(query);
  const symbolSql = [...fileFilters.sql];
  const symbolParams = [...fileFilters.params];
  if (!includeSynthetic) symbolSql.push("COALESCE(framework_meta_json, '') NOT LIKE '%\"synthetic\":\"true\"%'");
  return {
    symbolSql,
    symbolParams,
    importSql: [...fileFilters.sql],
    importParams: [...fileFilters.params],
    callSql: [...fileFilters.sql],
    callParams: [...fileFilters.params],
    effective: {
      ...fileFilters.effective,
      includeSynthetic,
    },
  };
}

function scoreFileSearch(row: FileRow, evidence: FileEvidence | undefined, query: string, tokens: string[]): FileSearchScore {
  const pathLower = row.path.toLowerCase();
  const basename = pathLower.substring(pathLower.lastIndexOf('/') + 1);
  const queryLower = query.toLowerCase();
  const symbols = evidence?.symbols ?? [];
  const endpoints = evidence?.endpoints ?? [];
  const symbolText = symbols.map(symbol => [
    symbol.name,
    symbol.fqName,
    symbol.kind,
    symbol.frameworkRole,
    (symbol.annotations as string[] | undefined)?.join(' '),
  ].filter(Boolean).join(' ')).join(' ').toLowerCase();
  const endpointText = endpoints.map(endpoint => [
    endpoint.method,
    endpoint.path,
    endpoint.handlerSymbol,
    endpoint.controller,
    endpoint.framework,
  ].filter(Boolean).join(' ')).join(' ').toLowerCase();
  const haystack = `${pathLower} ${symbolText} ${endpointText} ${row.language ?? ''} ${row.file_role}`;
  const matchedTokens = tokens.filter(token => haystack.includes(token) || compactSearchText(haystack).includes(compactSearchText(token)));
  const factors: string[] = [];
  let score = 0;
  let reason = 'partial file evidence match';

  if (pathLower === queryLower || basename === queryLower) {
    score += 120;
    reason = 'exact file path/name match';
    factors.push('exact file path or basename equals query');
  } else if (queryLower && pathLower.includes(queryLower)) {
    score += 90;
    reason = 'query phrase matched file path';
    factors.push('query phrase appears in file path');
  }

  const pathMatches = tokens.filter(token => pathLower.includes(token));
  if (tokens.length > 0 && pathMatches.length === tokens.length) {
    score += 70;
    reason = 'all query tokens matched file path';
    factors.push('all query tokens matched file path');
  } else if (pathMatches.length > 0) {
    score += 18 * pathMatches.length;
    factors.push(`${pathMatches.length} query tokens matched file path`);
  }

  const symbolMatches = tokens.filter(token => symbolText.includes(token));
  if (symbolMatches.length > 0) {
    score += 20 * symbolMatches.length;
    factors.push(`${symbolMatches.length} query tokens matched symbols in file`);
  }
  if (endpointText.includes(queryLower) && queryLower) {
    score += 55;
    reason = 'query phrase matched endpoint metadata';
    factors.push('query phrase appears in endpoint metadata');
  } else {
    const endpointMatches = tokens.filter(token => endpointText.includes(token));
    if (endpointMatches.length > 0) {
      score += 24 * endpointMatches.length;
      factors.push(`${endpointMatches.length} query tokens matched endpoint metadata`);
    }
  }

  if (/\bendpoint|route|controller\b/i.test(query) && endpoints.length > 0) {
    score += 40;
    factors.push('endpoint/controller intent matched indexed endpoint file');
  }
  if (/\bservice\b/i.test(query) && symbols.some(isServiceLike)) {
    score += 32;
    factors.push('service intent matched service-like symbol');
  }
  if (/\brepository|repo|dao\b/i.test(query) && symbols.some(isRepositoryLike)) {
    score += 32;
    factors.push('repository intent matched repository-like symbol');
  }
  if (/\bentity|model\b/i.test(query) && symbols.some(isEntityLike)) {
    score += 32;
    factors.push('entity/model intent matched entity-like symbol');
  }
  if (evidence) {
    const graphSignal = Math.min(evidence.dependencyCounts.incoming + evidence.dependencyCounts.outgoing, 10);
    if (graphSignal > 0) {
      score += graphSignal;
      factors.push(`dependency graph signal contributed ${graphSignal} points`);
    }
  }

  const fileRoleBoost = Math.round(roleRank(row.file_role) / 10);
  score += fileRoleBoost;
  factors.push(`file role ${row.file_role} contributed ${fileRoleBoost} points`);

  return {
    score,
    matchedTokens,
    reason,
    factors,
  };
}

function hasTestIntent(query: string): boolean {
  return /\b(test|tests|spec|behavior|behaviour|should|fixture|fixtures|mock|mocks)\b/i.test(query);
}

function hasGeneratedIntent(query: string): boolean {
  return /\b(generated|gen|synthetic)\b/i.test(query);
}

function hasFixtureIntent(query: string): boolean {
  return /\b(fixture|fixtures|mock|mocks|stub|stubs|testdata)\b/i.test(query);
}

function hasSyntheticIntent(query: string): boolean {
  return /\b(lombok|synthetic|generated getter|generated setter)\b/i.test(query);
}

function parseCursor(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function buildFacets(rows: SymbolRow[]): Record<string, Record<string, number>> {
  const facets = {
    fileRole: {} as Record<string, number>,
    kind: {} as Record<string, number>,
    frameworkRole: {} as Record<string, number>,
    synthetic: {} as Record<string, number>,
  };
  for (const row of rows) {
    incrementFacet(facets.fileRole, row.file_role);
    incrementFacet(facets.kind, row.kind);
    incrementFacet(facets.frameworkRole, row.framework_role ?? 'none');
    incrementFacet(facets.synthetic, isSyntheticSymbol(row) ? 'true' : 'false');
  }
  return facets;
}

function buildFileFacets(rows: FileRow[]): Record<string, Record<string, number>> {
  const facets = {
    fileRole: {} as Record<string, number>,
    language: {} as Record<string, number>,
    parseStatus: {} as Record<string, number>,
  };
  for (const row of rows) {
    incrementFacet(facets.fileRole, row.file_role);
    incrementFacet(facets.language, row.language ?? 'unknown');
    incrementFacet(facets.parseStatus, row.parse_status);
  }
  return facets;
}

function buildEndpointFacets(rows: EndpointRow[]): Record<string, Record<string, number>> {
  const facets = {
    method: {} as Record<string, number>,
    framework: {} as Record<string, number>,
    fileRole: {} as Record<string, number>,
    pathResolution: {} as Record<string, number>,
  };
  for (const row of rows) {
    incrementFacet(facets.method, row.method);
    incrementFacet(facets.framework, row.framework);
    incrementFacet(facets.fileRole, row.file_role);
    incrementFacet(facets.pathResolution, row.path_resolution);
  }
  return facets;
}

function incrementFacet(facet: Record<string, number>, key: string): void {
  facet[key] = (facet[key] ?? 0) + 1;
}

function groupReferences(references: Array<Record<string, unknown>>, groupBy: string): Array<Record<string, unknown>> {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const reference of references) {
    const key = referenceGroupKey(reference, groupBy);
    const bucket = groups.get(key) ?? [];
    bucket.push(reference);
    groups.set(key, bucket);
  }
  return [...groups.entries()]
    .map(([key, rows]) => ({
      key,
      count: rows.length,
      kinds: [...new Set(rows.map(row => String(row.kind ?? 'unknown')))],
      references: rows.slice(0, 10),
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function referenceGroupKey(reference: Record<string, unknown>, groupBy: string): string {
  switch (groupBy) {
    case 'file':
      return String(reference.file ?? 'unknown');
    case 'kind':
      return String(reference.kind ?? 'unknown');
    case 'caller':
      return String(reference.caller ?? reference.file ?? 'unknown');
    default:
      return 'all';
  }
}

function normalizeDependencyDirection(value: string): 'dependencies' | 'dependents' | 'both' {
  if (value === 'dependencies' || value === 'dependency' || value === 'outgoing') return 'dependencies';
  if (value === 'dependents' || value === 'dependent' || value === 'incoming') return 'dependents';
  return 'both';
}

function fileAllowedByRole(
  file: string,
  fileRoles: Map<string, string>,
  filters: ReturnType<typeof fileFiltersFor>,
): boolean {
  const role = fileRoles.get(file);
  if (!role) return true;
  const effective = filters.effective as {
    includeTests?: boolean;
    includeGenerated?: boolean;
    includeFixtures?: boolean;
    fileRole?: string;
  };
  if (effective.fileRole && role !== effective.fileRole) return false;
  if (!effective.includeTests && role === 'test_source') return false;
  if (!effective.includeGenerated && role === 'generated') return false;
  if (!effective.includeFixtures && role === 'mock_source') return false;
  return true;
}

function tokenizeSearchQuery(query: string): string[] {
  if (!query || query === '*') return [];
  const withCamelBoundaries = query
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const tokens = withCamelBoundaries
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map(token => token.trim())
    .filter(token => token.length >= 2 && !SEARCH_STOP_WORDS.has(token));
  return [...new Set(tokens)];
}

function compactSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function kindFilterFor(kind: string): { sql: string; params: unknown[] } {
  if (kind === 'all') return { sql: '1 = 1', params: [] };
  if (kind === 'class') return { sql: "kind IN ('class', 'interface', 'enum', 'type')", params: [] };
  return { sql: 'kind = ?', params: [kind] };
}

const SEARCH_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'by',
  'class',
  'code',
  'for',
  'from',
  'in',
  'java',
  'jakarta',
  'method',
  'of',
  'or',
  'service',
  'spring',
  'the',
  'to',
  'with',
]);

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function scalar(db: DatabaseType, sql: string, ...args: unknown[]): number {
  const row = db.prepare(sql).get(...args) as Record<string, number> | undefined;
  return row ? Number(Object.values(row)[0] ?? 0) : 0;
}

function callGraphName(symbol: string): string {
  const withoutParams = symbol.replace(/\([^)]*\)$/, '');
  const parts = withoutParams.split('.').filter(Boolean);
  if (parts.length >= 2) return `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  return withoutParams;
}

function searchTermsForTarget(target: string): string[] {
  const withoutParams = target.replace(/\([^)]*\)$/, '');
  const parts = withoutParams.split(/[.#]/g).filter(Boolean);
  const terms = [
    target,
    withoutParams,
    parts.length >= 2 ? `${parts[parts.length - 2]}.${parts[parts.length - 1]}` : '',
    parts[parts.length - 2] ?? '',
    parts[parts.length - 1] ?? '',
  ].map(term => term.trim()).filter(term => term.length >= 2);
  return [...new Set(terms)];
}

function isServiceLike(symbol: Record<string, unknown>): boolean {
  return String(symbol.frameworkRole ?? '').includes('service') || String(symbol.name ?? '').endsWith('Service');
}

function isRepositoryLike(symbol: Record<string, unknown>): boolean {
  const role = String(symbol.frameworkRole ?? '');
  const name = String(symbol.name ?? '');
  return role.includes('repository') || name.endsWith('Repository') || name.endsWith('Dao');
}

function isEntityLike(symbol: Record<string, unknown>): boolean {
  const role = String(symbol.frameworkRole ?? '');
  const name = String(symbol.name ?? '');
  return role.includes('entity') || name.endsWith('Entity');
}

function isDtoLike(symbol: Record<string, unknown>): boolean {
  const name = String(symbol.name ?? '');
  return /(Dto|DTO|Request|Response|Command|Payload)$/.test(name);
}

function isCommonExternalImport(source: string): boolean {
  return /^(java|javax|jakarta|org\.springframework|lombok|org\.junit|org\.mockito|com\.fasterxml|org\.slf4j)\./.test(source);
}

function rankFiles(files: string[]): string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    if (!file) continue;
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([file]) => file);
}
