import fs from 'node:fs';
import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import { V2Indexer } from '../index/indexer.js';
import { roleRank, type FileRole } from '../index/file-role.js';
import { scanManifest } from '../index/manifest.js';
import { getGitInfo } from '../git.js';

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
    let snapshotId = this.requireSnapshot(envelope.workspaceId);
    if (envelope.args.autoRefresh === true) {
      const freshnessBeforeRefresh = this.indexFreshness(snapshotId);
      const workspace = this.workspaceInfo(envelope.workspaceId);
      if (freshnessBeforeRefresh?.isStale && workspace?.root) {
        snapshotId = this.indexer.indexWorkspace({
          root: workspace.root,
          workspaceKey: workspace.workspaceKey,
        }).snapshotId;
      }
    }
    const freshness = envelope.args.warnStale === false ? undefined : this.indexFreshness(snapshotId);
    const withFreshness = (result: unknown): unknown => {
      if (!freshness || !freshness.isStale || !isPlainObject(result)) return result;
      return {
        ...result,
        indexFreshness: freshness,
      };
    };
    switch (envelope.toolName) {
      case 'search_symbol':
        return withFreshness(this.searchSymbol(snapshotId, envelope.args));
      case 'search_files':
        return withFreshness(this.searchFiles(snapshotId, envelope.args));
      case 'find_references':
        return withFreshness(this.findReferences(snapshotId, envelope.args));
      case 'get_file_summary':
        return withFreshness(this.getFileSummary(snapshotId, envelope.args));
      case 'get_file_slice':
        return withFreshness(this.getFileSlice(snapshotId, envelope.args));
      case 'get_dependencies':
        return withFreshness(this.getDependencies(snapshotId, envelope.args));
      case 'get_dependents':
        return withFreshness(this.getDependents(snapshotId, envelope.args));
      case 'get_callers':
        return withFreshness(this.getCallers(snapshotId, envelope.args));
      case 'get_callees':
        return withFreshness(this.getCallees(snapshotId, envelope.args));
      case 'find_endpoints':
        return withFreshness(this.findEndpoints(snapshotId, envelope.args));
      case 'get_impact_radius':
        return withFreshness(this.getImpactRadius(snapshotId, envelope.args));
      case 'trace_dependencies':
        return withFreshness(this.traceDependencies(snapshotId, envelope.args));
      case 'explain_endpoint':
        return withFreshness(this.explainEndpoint(snapshotId, envelope.args));
      case 'impact_of_symbol':
        return withFreshness(this.impactOfSymbol(snapshotId, envelope.args));
      case 'simulate_patch_impact':
        return withFreshness(this.simulatePatchImpact(snapshotId, envelope.args));
      case 'review_patch':
        return withFreshness(this.reviewPatch(snapshotId, envelope.args));
      case 'find_tests_for':
        return withFreshness(this.findTestsFor(snapshotId, envelope.args));
      case 'get_research_pack':
        return withFreshness(this.getResearchPack(snapshotId, envelope.args));
      case 'get_context_packet':
        return withFreshness(this.getContextPacket(snapshotId, envelope.args));
      case 'search_code':
        return withFreshness(this.searchCode(snapshotId, envelope.args));
      case 'get_index_stats':
        return withFreshness(this.getIndexStats(snapshotId));
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

  private workspaceRoot(workspaceId: string): string | undefined {
    return this.workspaceInfo(workspaceId)?.root;
  }

  private workspaceInfo(workspaceId: string): { root?: string; workspaceKey?: string } | undefined {
    const row = this.db.prepare('SELECT root, workspace_key FROM workspaces WHERE id = ?')
      .get(workspaceId) as { root?: string; workspace_key?: string } | undefined;
    if (!row) return undefined;
    return { root: row.root, workspaceKey: row.workspace_key };
  }

  private workspaceRootForSnapshot(snapshotId: string): string | undefined {
    const row = this.db.prepare(`
      SELECT w.root
      FROM snapshots s
      JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.id = ?
    `).get(snapshotId) as { root?: string } | undefined;
    return row?.root;
  }

  private indexFreshness(snapshotId: string): Record<string, unknown> | undefined {
    const row = this.db.prepare(`
      SELECT s.created_at, s.head_commit, s.dirty_hash, w.root
      FROM snapshots s
      JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.id = ?
    `).get(snapshotId) as {
      created_at?: string;
      head_commit?: string;
      dirty_hash?: string;
      root?: string;
    } | undefined;
    if (!row?.root) return undefined;

    const git = getGitInfo(row.root);
    const gitDirty = git.available
      ? git.headCommit !== row.head_commit || git.dirtyHash !== row.dirty_hash
      : false;
    const dirtyFiles = !git.available || gitDirty ? this.computeDirtyFiles(snapshotId) : undefined;
    const dirtyCounts = (dirtyFiles ?? {}) as {
      addedCount?: number;
      modifiedCount?: number;
      deletedCount?: number;
    };
    const fileDirty = Number(dirtyCounts.addedCount ?? 0) > 0
      || Number(dirtyCounts.modifiedCount ?? 0) > 0
      || Number(dirtyCounts.deletedCount ?? 0) > 0;
    const isStale = fileDirty || gitDirty;

    return {
      isStale,
      snapshotCreatedAt: row.created_at,
      snapshotHeadCommit: row.head_commit,
      currentHeadCommit: git.headCommit,
      snapshotDirtyHash: row.dirty_hash,
      currentDirtyHash: git.dirtyHash,
      dirtyFiles,
      warning: isStale
        ? 'Index may be stale. Pass autoRefresh=true on the query or run codegraph index --root <workspace>.'
        : undefined,
    };
  }

  private snippetOptions(snapshotId: string, args: Record<string, unknown>): SnippetOptions | undefined {
    if (args.includeSnippets !== true) return undefined;
    const root = this.workspaceRootForSnapshot(snapshotId);
    if (!root) return undefined;
    const lines = clampInt(Number(args.snippetLines ?? 12), 3, 80);
    const tokenBudget = clampInt(Number(args.snippetTokenBudget ?? 1200), 100, 12000);
    return {
      root,
      lines,
      budgetChars: tokenBudget * 4,
      usedChars: 0,
    };
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
    const snippets = this.snippetOptions(snapshotId, args);
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
        SELECT fq_name, simple_name, kind, file, line, end_line, signature, visibility, parent,
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
        symbols: rows.map(row => symbolDto(row, snippets)),
        totalFound,
        truncated: cursorOffset + rows.length < totalFound,
        nextCursor: cursorOffset + rows.length < totalFound ? String(cursorOffset + rows.length) : undefined,
        facets: buildFacets(rows),
        filters: filters.effective,
        queryTokens: [],
        searchMode: 'list',
        ...(explainRank ? { debug: rankDebug('search_symbol', [
          'List mode: ordered by file role, then symbol name.',
          'No query tokens were supplied, so no per-result ranking score was computed.',
        ]) } : {}),
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
      SELECT fq_name, simple_name, kind, file, line, end_line, signature, visibility, parent,
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
        ...symbolDto(candidate.row, snippets),
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
      ...(explainRank ? { debug: rankDebug('search_symbol', [
        'Ranking order: exact/phrase/camel-case matches, intent boosts, file-role boost, synthetic/test/generated penalties from default filters.',
        `Candidate window: ${rows.length}; returned page offset ${cursorOffset}.`,
      ]) } : {}),
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
    const snippets = this.snippetOptions(snapshotId, args);
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
        files: rows.map(row => fileDto(row, evidence.get(row.path), undefined, explainRank, snippets)),
        totalFound,
        truncated: cursorOffset + rows.length < totalFound,
        nextCursor: cursorOffset + rows.length < totalFound ? String(cursorOffset + rows.length) : undefined,
        facets: buildFileFacets(rows),
        filters: filters.effective,
        queryTokens: [],
        searchMode: 'file-list',
        ...(explainRank ? { debug: rankDebug('search_files', [
          'List mode: ordered by file role, then file path.',
          'No query tokens were supplied, so no per-result ranking score was computed.',
        ]) } : {}),
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

    const broadConfigSearch = isApiSpecQuery(query) || /\b(config|yaml|json|xml|properties)\b/i.test(query);
    const candidateLimit = broadConfigSearch
      ? Math.min(Math.max((cursorOffset + limit) * 100, 1000), 5000)
      : Math.min(Math.max((cursorOffset + limit) * 40, 500), 2000);
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
      files: selected.map(candidate => fileDto(candidate.row, evidence.get(candidate.row.path), candidate.score, explainRank, snippets)),
      totalFound: ranked.length,
      truncated: cursorOffset + selected.length < ranked.length,
      nextCursor: cursorOffset + selected.length < ranked.length ? String(cursorOffset + selected.length) : undefined,
      facets: buildFileFacets(ranked.map(candidate => candidate.row)),
      filters: filters.effective,
      queryTokens: tokens,
      searchMode: 'file-ranked',
      ...(explainRank ? { debug: rankDebug('search_files', [
        'Ranking order: file path/name phrase, all-token path match, symbol evidence, endpoint evidence, dependency graph signal, file-role boost.',
        `Candidate window: ${rows.length}; returned page offset ${cursorOffset}.`,
      ]) } : {}),
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
    const snippets = this.snippetOptions(snapshotId, args);

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
      classes: symbols.filter(s => s.kind === 'class' || s.kind === 'interface').map(row => symbolDto(row, snippets)),
      methods: symbols.filter(s => s.kind === 'method' || s.kind === 'function').map(row => symbolDto(row, snippets)),
      fields: symbols.filter(s => s.kind === 'field' || s.kind === 'variable').map(row => symbolDto(row, snippets)),
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

  private getFileSlice(snapshotId: string, args: Record<string, unknown>) {
    const requestedFile = args.file ? String(args.file) : '';
    const requestedSymbol = args.symbol ? String(args.symbol) : '';
    const maxChars = clampInt(Number(args.maxChars ?? 8000), 200, 30000);
    let resolved = requestedFile ? this.resolveFile(snapshotId, requestedFile) : undefined;
    const symbol = requestedSymbol ? this.lookupBestSymbol(snapshotId, requestedSymbol, resolved) : undefined;
    if (symbol) resolved = symbol.file;
    if (!resolved) {
      return {
        error: requestedFile
          ? `File "${requestedFile}" not found in index.`
          : 'Provide a file path or a symbol that resolves to one indexed file.',
      };
    }

    const requestedRange = args.lines ? parseLineRange(String(args.lines)) : undefined;
    const symbolRange = symbol ? { start: symbol.line, end: symbol.end_line ?? symbol.line } : undefined;
    const range = requestedRange ?? symbolRange;
    if (!range) {
      return {
        file: resolved,
        error: 'Provide lines such as "42-118" or a symbol to select a bounded slice.',
      };
    }

    const root = this.workspaceRootForSnapshot(snapshotId);
    const absolutePath = root ? safeResolve(root, resolved) : undefined;
    if (!absolutePath) return { file: resolved, error: 'Could not safely resolve file under workspace root.' };

    let content: string;
    try {
      content = fs.readFileSync(absolutePath, 'utf-8');
    } catch (error) {
      return {
        file: resolved,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const sourceLines = content.split(/\r?\n/);
    const startLine = clampInt(range.start, 1, Math.max(sourceLines.length, 1));
    const endLine = clampInt(Math.max(range.end, startLine), startLine, Math.max(sourceLines.length, startLine));
    const rendered: string[] = [];
    let usedChars = 0;
    let truncated = false;
    for (let lineNo = startLine; lineNo <= endLine; lineNo++) {
      const line = `${lineNo}: ${sourceLines[lineNo - 1] ?? ''}`;
      const separator = rendered.length === 0 ? '' : '\n';
      const nextChars = separator.length + line.length;
      if (usedChars + nextChars > maxChars) {
        if (rendered.length === 0) rendered.push(line.slice(0, maxChars));
        truncated = true;
        break;
      }
      rendered.push(line);
      usedChars += nextChars;
    }

    const actualEndLine = rendered.length > 0 ? startLine + rendered.length - 1 : startLine;
    return {
      file: resolved,
      requested: {
        file: requestedFile || undefined,
        lines: args.lines,
        symbol: requestedSymbol || undefined,
      },
      resolvedSymbol: symbol ? compactSymbolCandidate(symbolDto(symbol), undefined) : undefined,
      startLine,
      endLine: actualEndLine,
      lines: lineRangeString(startLine, actualEndLine),
      maxChars,
      truncated,
      omittedLineCount: truncated ? Math.max(0, endLine - actualEndLine) : 0,
      text: rendered.join('\n'),
      confidence: symbol ? 0.9 : 0.85,
      confidenceNotes: [
        symbol
          ? 'Slice was resolved from an indexed symbol line range.'
          : 'Slice was resolved from an explicit file line range.',
      ],
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
    const explainRank = Boolean(args.explainRank ?? false);
    const snippets = this.snippetOptions(snapshotId, args);
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
      endpoints: rows.map(row => endpointDto(
        row,
        snippets,
        explainRank ? endpointRankExplanation(row, method, args.path ? String(args.path) : undefined) : undefined,
      )),
      totalCount,
      truncated: cursorOffset + rows.length < totalCount,
      nextCursor: cursorOffset + rows.length < totalCount ? String(cursorOffset + rows.length) : undefined,
      facets: buildEndpointFacets(rows),
      ...(explainRank ? { debug: rankDebug('find_endpoints', [
        'Ranking order: main-source endpoints, confidence, path, then HTTP method.',
        'Path search uses indexed composed paths; partial paths include pathResolutionReason.',
      ]) } : {}),
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
    const snippets = this.snippetOptions(snapshotId, args);
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
    const relatedSymbols = this.symbolsForFiles(snapshotId, graphFiles, snippets);
    const tests = this.findRelevantTests(snapshotId, endpoint.handler_symbol, 20);

    return {
      endpoint: endpointDto(endpoint, snippets),
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
      ...args,
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

  private simulatePatchImpact(snapshotId: string, args: Record<string, unknown>) {
    const limit = clampInt(Number(args.limit ?? 50), 1, 200);
    const requestedFiles = stringArray(args.files).map(normalizePatchPath).filter(Boolean);
    const diffFiles = parsePatchFilePaths(stringOrUndefined(args.diff) ?? '');
    const fileInputs = uniqueFilesInOrder([...requestedFiles, ...diffFiles]);
    const resolvedFileInputs: Array<{ input: string; file: string }> = [];
    const unresolvedFiles: string[] = [];
    for (const input of fileInputs) {
      const resolved = this.resolveFile(snapshotId, input);
      if (resolved) resolvedFileInputs.push({ input, file: resolved });
      else unresolvedFiles.push(input);
    }

    const requestedSymbols = stringArray(args.symbols);
    const resolvedSymbols: Array<Record<string, unknown>> = [];
    const symbolRows: SymbolRow[] = [];
    const unresolvedSymbols: string[] = [];
    for (const symbol of requestedSymbols) {
      const row = this.lookupBestSymbol(snapshotId, symbol);
      if (!row) {
        unresolvedSymbols.push(symbol);
        continue;
      }
      symbolRows.push(row);
      resolvedSymbols.push(compactSymbolCandidate(symbolDto(row), `explicit patch symbol input: ${symbol}`));
    }

    const changedFiles = uniqueFilesInOrder([
      ...resolvedFileInputs.map(input => input.file),
      ...symbolRows.map(row => row.file),
    ]).slice(0, limit);
    const touchedSymbols = uniqueSymbolCandidates(
      this.symbolsForFiles(snapshotId, changedFiles)
        .map(symbol => compactSymbolCandidate(symbol, 'symbol declared in a changed file')),
    ).slice(0, limit);
    const changedEndpoints = compactEndpointCandidates(this.impactedEndpoints(snapshotId, changedFiles));

    const dependencyRows = uniqueRecordsBy(
      changedFiles.flatMap(file => this.dependencyRows(snapshotId, file, 'from_file')),
      row => `${row.file}:${row.type}:${row.resolutionKind}`,
    );
    const dependentRows = uniqueRecordsBy(
      changedFiles.flatMap(file => this.dependencyRows(snapshotId, file, 'to_file')),
      row => `${row.file}:${row.type}:${row.resolutionKind}`,
    );

    const callSeedLimit = clampInt(Number(args.callSeedLimit ?? Math.min(12, limit)), 0, 30);
    const callSeeds = uniqueStrings([
      ...requestedSymbols,
      ...resolvedSymbols.flatMap(symbol => [String(symbol.symbol ?? ''), String(symbol.name ?? '')]),
      ...touchedSymbols.flatMap(symbol => [symbol.symbol, symbol.name]),
    ]).slice(0, callSeedLimit);
    const callers = uniqueCallEdges(
      callSeeds.flatMap(symbol => (this.getCallers(snapshotId, { symbol, limit: 25 }) as { callers: CallEdgeRow[] }).callers),
    ).slice(0, limit * 2);
    const callees = uniqueCallEdges(
      callSeeds.flatMap(symbol => (this.getCallees(snapshotId, { symbol, limit: 25 }) as { callees: CallEdgeRow[] }).callees),
    ).slice(0, limit * 2);

    const impactedFiles = rankFiles([
      ...changedFiles,
      ...dependentRows.map(row => String(row.file ?? row.modulePath ?? '')),
      ...dependencyRows.map(row => String(row.file ?? row.modulePath ?? '')),
      ...callers.map(call => call.file),
      ...callees.map(call => call.file),
    ]).slice(0, limit);
    const impactedEndpoints = compactEndpointCandidates(this.impactedEndpoints(snapshotId, impactedFiles)).slice(0, limit);
    const testSeeds = uniqueStrings([
      ...requestedSymbols,
      ...changedFiles.map(file => path.posix.basename(file, path.posix.extname(file))),
      ...touchedSymbols.flatMap(symbol => [symbol.symbol, symbol.name]),
    ]).slice(0, 32);
    const tests = args.skipLikelyTests === true ? [] : this.findRelevantTestsForSeeds(snapshotId, testSeeds, limit);
    const validation = this.validationHints(snapshotId, tests, impactedFiles.length > 0 ? impactedFiles : changedFiles);
    const riskFlags = patchRiskFlags({
      changedFiles,
      touchedSymbols,
      changedEndpoints,
      impactedEndpoints,
      directDependentCount: dependentRows.length,
      callerCount: callers.length,
      testsCount: tests.length,
      unresolvedInputCount: unresolvedFiles.length + unresolvedSymbols.length,
    });
    const blastRadius = patchBlastRadius({
      changedFiles,
      directDependentCount: dependentRows.length,
      callerCount: callers.length,
      changedEndpointCount: changedEndpoints.length,
      impactedEndpointCount: impactedEndpoints.length,
      testsCount: tests.length,
      riskFlags,
    });

    return {
      inputs: {
        files: requestedFiles,
        diffFiles,
        symbols: requestedSymbols,
        resolvedFileInputs,
        resolvedSymbols,
        unresolvedFiles,
        unresolvedSymbols,
      },
      changedFiles,
      touchedSymbols,
      changedEndpoints,
      dependencyImpact: {
        dependencies: dependencyRows.slice(0, limit),
        dependents: dependentRows.slice(0, limit),
        dependencyCount: dependencyRows.length,
        dependentCount: dependentRows.length,
      },
      callImpact: {
        queriedSymbols: callSeeds,
        callers,
        callees,
        callerCount: callers.length,
        calleeCount: callees.length,
      },
      impactedFiles,
      impactedEndpoints,
      testsLikelyRelevant: tests,
      validation,
      riskFlags,
      summary: {
        blastRadius,
        changedFileCount: changedFiles.length,
        touchedSymbolCount: touchedSymbols.length,
        directDependentCount: dependentRows.length,
        callerCount: callers.length,
        impactedEndpointCount: impactedEndpoints.length,
        likelyTestCount: tests.length,
        unresolvedInputCount: unresolvedFiles.length + unresolvedSymbols.length,
      },
      nextActions: patchNextActions(unresolvedFiles, unresolvedSymbols, validation, riskFlags, changedFiles),
      confidence: patchImpactConfidence(changedFiles.length, unresolvedFiles.length + unresolvedSymbols.length, tests.length),
      confidenceNotes: [
        'Patch impact is simulated from the current indexed snapshot; uncommitted edits are included only when autoRefresh=true refreshes the snapshot first.',
        'Dependency impact follows indexed file dependency edges; call impact follows indexed call edges and may include lower-confidence name-only matches.',
      ],
    };
  }

  private reviewPatch(snapshotId: string, args: Record<string, unknown>) {
    const limit = clampInt(Number(args.limit ?? 50), 1, 200);
    const focus = normalizeReviewFocus(String(args.focus ?? 'general'));
    const outputMode = normalizeReviewOutputMode(String(args.outputMode ?? 'compact'));
    const budget = reviewBudgetFor(outputMode, args, limit);
    const diff = stringOrUndefined(args.diff) ?? '';
    const allHunks = parsePatchHunks(diff);
    const diffStats = patchDiffStats(allHunks, diff);
    const impact = this.simulatePatchImpact(snapshotId, {
      ...args,
      limit,
      callSeedLimit: 0,
      skipLikelyTests: args.includeLikelyTests !== true,
    }) as Record<string, unknown>;
    const hunks = rankPatchHunks(allHunks).slice(0, Math.max(budget.maxLineFocus, budget.maxFindings));
    const lineMapping = this.patchLineMappings(snapshotId, hunks);
    const changedFiles = stringArray(impact.changedFiles);
    const tests = arrayRecords(impact.testsLikelyRelevant);
    const validation = isPlainObject(impact.validation) ? impact.validation : {};
    const riskFlags = arrayRecords(impact.riskFlags);
    const allFindings = reviewFindingsForPatch({
      focus,
      diff,
      hunks,
      changedFiles,
      riskFlags,
      testsCount: tests.length,
      summary: isPlainObject(impact.summary) ? impact.summary : {},
    });
    const findings = allFindings
      .slice(0, budget.maxFindings)
      .map(finding => compactReviewFinding(finding, budget.maxEvidencePerFinding));
    const lineFocus = hunks
      .slice(0, budget.maxLineFocus)
      .map(hunk => compactPatchHunk(hunk, lineMapping.get(hunk)))
      .map(hunk => compactReviewObject(hunk, budget.maxEvidencePerFinding, 2) as Record<string, unknown>);
    const priorityCounts = reviewPriorityCounts(findings);
    const cappedRiskFlags = riskFlags
      .slice(0, budget.maxRiskFlags)
      .map(flag => compactReviewObject(flag, budget.maxEvidencePerFinding, 2) as Record<string, unknown>);
    const cappedTests = tests
      .slice(0, budget.maxTests)
      .map(test => compactReviewObject(test, budget.maxEvidencePerFinding, 2) as Record<string, unknown>);

    return {
      outputMode,
      focus,
      reviewStatus: reviewStatusFor(findings, changedFiles),
      impactSummary: impact.summary,
      changedFiles,
      diffStats,
      reviewPlan: reviewPlanForPatch(diffStats, findings, impact),
      reviewFindings: findings,
      reviewFocus: reviewFocusForPatch(focus, impact, findings, budget.maxEvidencePerFinding),
      lineFocus,
      riskFlags: cappedRiskFlags,
      testsLikelyRelevant: cappedTests,
      validation: compactReviewObject(validation, budget.maxEvidencePerFinding, 2),
      requiredToolCalls: reviewToolCalls(changedFiles, lineFocus, findings, budget.maxRequiredToolCalls),
      reviewerQuestions: reviewQuestionsForPatch(findings, impact),
      metrics: {
        changedFileCount: changedFiles.length,
        diffHunkCount: allHunks.length,
        reportedLineFocusCount: lineFocus.length,
        findingCount: findings.length,
        totalFindingCount: allFindings.length,
        priorityCounts,
        likelyTestCount: tests.length,
        omittedFindings: Math.max(0, allFindings.length - findings.length),
        omittedHunks: Math.max(0, allHunks.length - lineFocus.length),
        omittedRiskFlags: Math.max(0, riskFlags.length - cappedRiskFlags.length),
        omittedTests: Math.max(0, tests.length - cappedTests.length),
      },
      confidence: reviewConfidence(changedFiles.length, hunks.length, findings, riskFlags),
      confidenceNotes: [
        'Review findings are deterministic risk hypotheses from the diff and graph impact, not proof of bugs.',
        'Default output is capped for large diffs; use outputMode=full only when expanded evidence is needed.',
        'Use requiredToolCalls for exact source slices before writing final review comments.',
      ],
    };
  }

  private patchLineMappings(snapshotId: string, hunks: PatchHunk[]): Map<PatchHunk, PatchLineMapping> {
    const result = new Map<PatchHunk, PatchLineMapping>();
    const root = this.workspaceRootForSnapshot(snapshotId);
    if (!root) {
      for (const hunk of hunks) {
        result.set(hunk, {
          confidence: 'low',
          exactSliceSafe: false,
          reason: 'workspace root is unavailable',
        });
      }
      return result;
    }

    const cache = new Map<string, string[] | undefined>();
    for (const hunk of hunks) {
      if (!hunk.file) {
        result.set(hunk, { confidence: 'low', exactSliceSafe: false, reason: 'diff hunk has no file path' });
        continue;
      }
      const resolved = this.resolveFile(snapshotId, hunk.file) ?? hunk.file;
      let sourceLines = cache.get(resolved);
      if (!cache.has(resolved)) {
        const absolutePath = safeResolve(root, resolved);
        try {
          sourceLines = absolutePath ? fs.readFileSync(absolutePath, 'utf-8').split(/\r?\n/) : undefined;
        } catch {
          sourceLines = undefined;
        }
        cache.set(resolved, sourceLines);
      }
      result.set(hunk, patchLineMappingFor(hunk, sourceLines));
    }
    return result;
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
    const definitions = (this.searchSymbol(snapshotId, { ...args, query: target, limit: 10 }) as { symbols: unknown[] }).symbols;
    const callers = (this.getCallers(snapshotId, { symbol: target, limit: 30 }) as { callers: CallEdgeRow[] }).callers;
    const callees = (this.getCallees(snapshotId, { symbol: target, limit: 30 }) as { callees: CallEdgeRow[] }).callees;
    const impact = this.getImpactRadius(snapshotId, { target }) as Record<string, unknown>;
    const endpoints = this.findEndpoints(snapshotId, { ...args, path: target }) as { endpoints: unknown[] };

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

  private getContextPacket(snapshotId: string, args: Record<string, unknown>) {
    const task = String(args.task ?? '').trim();
    if (!task) return { error: 'get_context_packet requires a non-empty task.' };

    const domain = args.domain ? String(args.domain).trim() : undefined;
    const tokenBudget = clampInt(Number(args.tokenBudget ?? 8000), 1000, 30000);
    const maxFiles = clampInt(Number(args.maxFiles ?? 8), 1, 20);
    const maxSymbols = clampInt(Number(args.maxSymbols ?? 12), 1, 50);
    const includeTests = args.includeTests !== false;
    const includeSnippets = args.includeSnippets !== false;
    const snippetLines = clampInt(Number(args.snippetLines ?? 12), 3, 40);
    const snippetTokenBudget = clampInt(
      Number(args.snippetTokenBudget ?? Math.min(6000, Math.max(800, Math.floor(tokenBudget * 0.45)))),
      100,
      12000,
    );
    const query = [domain, task].filter(Boolean).join(' ');
    const explicitContext = this.explicitContextMatches(snapshotId, task, domain, maxFiles);

    const files = this.searchFiles(snapshotId, {
      ...args,
      query,
      limit: maxFiles,
      includeTests: false,
      includeGenerated: false,
      includeFixtures: false,
      explainRank: true,
      includeSnippets,
      snippetLines,
      snippetTokenBudget,
    }) as { files: Array<Record<string, unknown>>; totalFound?: number };
    const symbols = this.searchSymbol(snapshotId, {
      ...args,
      query,
      limit: maxSymbols,
      includeTests: false,
      includeGenerated: false,
      includeFixtures: false,
      includeSynthetic: false,
      explainRank: true,
      includeSnippets: false,
    }) as { symbols: Array<Record<string, unknown>>; totalFound?: number };
    const endpointNeedle = endpointNeedleForTask(task, domain);
    const endpointSearch = endpointNeedle
      ? this.findEndpoints(snapshotId, {
        ...args,
        path: endpointNeedle,
        method: 'all',
        limit: Math.min(maxFiles, 10),
        explainRank: true,
        includeSnippets: false,
      }) as { endpoints: Array<Record<string, unknown>>; totalCount?: number }
      : { endpoints: [], totalCount: 0 };
    const myBatisContext = isMyBatisIntent(query)
      ? this.myBatisContext(snapshotId, query, maxFiles, maxSymbols)
      : { candidateFiles: [], relevantSymbols: [], topFiles: [] };
    const directEndpointCandidates = compactEndpointCandidates(endpointSearch.endpoints);
    const endpointFileCandidates = directEndpointCandidates.map(endpoint => ({
      file: endpoint.file,
      language: undefined,
      fileRole: undefined,
      lines: endpoint.lines,
      whyRelevant: endpoint.whyRelevant,
      confidence: endpoint.confidence,
      matchedTokens: [],
      snippet: undefined,
      topSymbols: [],
      endpoints: [endpoint],
    }));

    const fuzzyFileCandidates = files.files
      .map(row => compactFileCandidate(row))
      .filter(candidate => explicitContext.topFiles.length === 0
        || isCompatibleExplicitFileCandidate(candidate.file, explicitContext.topFiles));
    const candidateFiles = uniqueFileCandidates([
      ...explicitContext.candidateFiles,
      ...myBatisContext.candidateFiles,
      ...endpointFileCandidates,
      ...fuzzyFileCandidates,
    ]).slice(0, maxFiles);
    const relevantSymbols = uniqueSymbolCandidates([
      ...explicitContext.relevantSymbols,
      ...myBatisContext.relevantSymbols,
      ...symbols.symbols.map(row => compactSymbolCandidate(row)),
    ]).slice(0, maxSymbols);
    const endpointCandidates = compactEndpointCandidates([
      ...directEndpointCandidates,
      ...files.files.flatMap(row => Array.isArray(row.endpoints) ? row.endpoints as Array<Record<string, unknown>> : []),
    ]).slice(0, Math.min(maxFiles, 10));
    const topFiles = uniqueFilesInOrder([
      ...explicitContext.topFiles,
      ...candidateFiles.map(row => row.file),
      ...endpointCandidates.map(row => row.file),
      ...relevantSymbols.map(row => row.file),
      ...myBatisContext.topFiles,
    ].filter(Boolean)).slice(0, maxFiles);
    const testSeeds = [
      task,
      domain ?? '',
      ...relevantSymbols.slice(0, 8).flatMap(symbol => [symbol.symbol, symbol.name]),
      ...topFiles.slice(0, 5).map(file => path.basename(file, path.extname(file))),
    ].filter(seed => seed.length > 0);
    const testsLikelyRelevant = includeTests
      ? this.findRelevantTestsForSeeds(snapshotId, testSeeds, Math.max(10, maxFiles * 2))
      : [];
    const validation = this.validationHints(snapshotId, testsLikelyRelevant, topFiles);
    const inferredDomain = domain ?? inferDomain(task, topFiles);

    const result = {
      task,
      domain: inferredDomain,
      query,
      router: {
        strategy: isMyBatisIntent(query)
          ? 'mybatis-aware file/symbol/config retrieval over the persistent index'
          : 'hybrid file/symbol/endpoint retrieval over the persistent index',
        constraints: [
          'No full-file content is returned by default.',
          'Generated, fixture, and test files are excluded from implementation candidates by default.',
          'Use get_file_slice for the exact edit range before changing a file.',
        ],
      },
      myBatis: isMyBatisIntent(query) ? {
        mapperFiles: myBatisContext.topFiles.filter(file => file.endsWith('.xml')).slice(0, maxFiles),
        relatedJavaFiles: myBatisContext.topFiles.filter(file => file.endsWith('.java')).slice(0, maxFiles),
      } : undefined,
      candidateFiles,
      relevantSymbols,
      endpointCandidates,
      testsLikelyRelevant,
      validation,
      topFiles,
      omissions: {
        fileCandidates: Math.max(0, Number(files.totalFound ?? candidateFiles.length) - candidateFiles.length),
        symbolCandidates: Math.max(0, Number(symbols.totalFound ?? relevantSymbols.length) - relevantSymbols.length),
        endpointCandidates: Math.max(0, Number(endpointSearch.totalCount ?? endpointCandidates.length) - endpointSearch.endpoints.length),
      },
      nextAction: nextContextAction(candidateFiles, relevantSymbols),
      confidence: packetConfidence(candidateFiles, relevantSymbols, testsLikelyRelevant),
      confidenceNotes: [
        'Candidate ranking combines path, symbol, endpoint, file-role, and graph evidence available in the local index.',
        ...(explicitContext.topFiles.length > 0 ? ['Exact file/class path mentions in the task were promoted ahead of fuzzy matches.'] : []),
        'Confidence is lower for broad natural-language tasks without exact symbol, path, endpoint, or test matches.',
      ],
    };

    return {
      ...result,
      budget: {
        tokenBudget,
        maxFiles,
        maxSymbols,
        includeSnippets,
        snippetLines,
        snippetTokenBudget,
        estimatedResponseTokens: estimateTokens(JSON.stringify(result)),
      },
    };
  }

  private myBatisContext(
    snapshotId: string,
    query: string,
    maxFiles: number,
    maxSymbols: number,
  ): {
    candidateFiles: Array<ReturnType<typeof compactFileCandidate>>;
    relevantSymbols: Array<ReturnType<typeof compactSymbolCandidate>>;
    topFiles: string[];
  } {
    const xmlFiles = this.searchFiles(snapshotId, {
      query,
      limit: Math.max(maxFiles, 8),
      fileRole: 'resource_config',
      language: 'xml',
      explainRank: true,
      includeSnippets: false,
    }) as { files: Array<Record<string, unknown>> };

    const roles = [
      'mybatis:select',
      'mybatis:insert',
      'mybatis:update',
      'mybatis:delete',
      'mybatis:mapper-xml',
      'mybatis:resultMap',
      'mybatis:sql',
    ];
    const myBatisSymbols: Array<Record<string, unknown>> = [];
    for (const role of roles) {
      const result = this.searchSymbol(snapshotId, {
        query,
        frameworkRole: role,
        limit: Math.max(maxSymbols, 8),
        includeTests: false,
        includeGenerated: false,
        includeFixtures: false,
        explainRank: true,
        includeSnippets: false,
      }) as { symbols: Array<Record<string, unknown>> };
      myBatisSymbols.push(...result.symbols);
    }

    const seedFiles = [
      ...xmlFiles.files.map(file => String(file.path ?? '')),
      ...myBatisSymbols.map(symbol => String(symbol.file ?? '')),
    ].filter(Boolean);
    const primaryXmlFiles = xmlFiles.files
      .slice(0, 1)
      .map(file => String(file.path ?? ''))
      .filter(Boolean);
    const primaryRelatedFiles = this.relatedMyBatisFiles(snapshotId, primaryXmlFiles, Math.max(maxFiles * 2, 8));
    const relatedFiles = this.relatedMyBatisFiles(snapshotId, seedFiles, Math.max(maxFiles * 3, 12));
    const primaryRelatedCandidates = this.fileCandidatesForPaths(snapshotId, primaryRelatedFiles, query);
    const relatedCandidates = this.fileCandidatesForPaths(snapshotId, relatedFiles, query);
    const xmlCandidates = xmlFiles.files.map(row => compactFileCandidate(row));

    const candidateFiles = uniqueFileCandidates([
      ...xmlCandidates.slice(0, 1),
      ...primaryRelatedCandidates,
      ...xmlCandidates.slice(1, 2),
      ...relatedCandidates,
      ...xmlCandidates.slice(2),
    ]).slice(0, Math.max(maxFiles, 8));
    const relevantSymbols = uniqueSymbolCandidates(
      myBatisSymbols.map(row => compactSymbolCandidate(row, 'ranked MyBatis mapper XML evidence match')),
    ).slice(0, Math.max(maxSymbols, 8));

    return {
      candidateFiles,
      relevantSymbols,
      topFiles: rankFiles([
        ...candidateFiles.map(file => file.file),
        ...relevantSymbols.map(symbol => symbol.file),
        ...relatedFiles,
      ]).slice(0, Math.max(maxFiles * 2, 12)),
    };
  }

  private relatedMyBatisFiles(snapshotId: string, files: string[], limit: number): string[] {
    const unique = [...new Set(files.filter(Boolean))].slice(0, 50);
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(', ');
    const namespaceEdges = this.db.prepare(`
      SELECT from_file, to_file, resolution_kind
      FROM dependency_edges
      WHERE snapshot_id = ?
        AND (from_file IN (${placeholders}) OR to_file IN (${placeholders}))
        AND resolution_kind = 'mybatis-namespace'
      LIMIT ?
    `).all(snapshotId, ...unique, ...unique, limit * 2) as Array<{
      from_file: string;
      to_file: string;
      resolution_kind: string;
    }>;
    const neighbors = rankFiles([
      ...namespaceEdges.flatMap(edge => [edge.from_file, edge.to_file]),
    ]).filter(file => !unique.includes(file));

    const javaMapperFiles = neighbors.filter(file => file.endsWith('.java')).slice(0, limit);
    const targetFiles = [...new Set([...unique, ...javaMapperFiles])].slice(0, limit * 2);
    if (targetFiles.length === 0) return neighbors.slice(0, limit);
    const javaPlaceholders = targetFiles.map(() => '?').join(', ');
    const dependents = this.db.prepare(`
      SELECT from_file, to_file, resolution_kind
      FROM dependency_edges
      WHERE snapshot_id = ?
        AND to_file IN (${javaPlaceholders})
      LIMIT ?
    `).all(snapshotId, ...targetFiles, limit * 6) as Array<{
      from_file: string;
      to_file: string;
      resolution_kind: string;
    }>;

    return rankFiles([
      ...neighbors,
      ...dependents
        .map(edge => edge.from_file)
        .filter(file => file && !unique.includes(file)),
    ]).slice(0, limit);
  }

  private fileCandidatesForPaths(
    snapshotId: string,
    files: string[],
    query: string,
  ): Array<ReturnType<typeof compactFileCandidate>> {
    const unique = [...new Set(files.filter(Boolean))].slice(0, 100);
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT path, language, file_role, parse_status, size
      FROM files
      WHERE snapshot_id = ? AND path IN (${placeholders})
    `).all(snapshotId, ...unique) as FileRow[];
    const evidence = this.fileEvidence(snapshotId, rows.map(row => row.path));
    const tokens = tokenizeSearchQuery(query);
    return rows
      .map((row) => {
        const score = scoreFileSearch(row, evidence.get(row.path), query, tokens);
        return {
          candidate: compactFileCandidate(fileDto(row, evidence.get(row.path), score, false)),
          score: score.score,
        };
      })
      .sort((a, b) => b.score - a.score)
      .map(item => item.candidate);
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
      ...args,
      path: query,
      method: args.method ?? 'all',
      limit,
      explainRank: Boolean(args.explainRank ?? false),
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
      ...(Boolean(args.explainRank) ? { debug: rankDebug('search_code', [
        'Mixed search delegates ranking to search_files, search_symbol, find_endpoints, find_references, and trace_dependencies.',
        'Use the section-specific nextCursor values when one result type needs deeper pagination.',
      ]) } : {}),
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

  private symbolsForFiles(snapshotId: string, files: string[], snippets?: SnippetOptions): Array<Record<string, unknown>> {
    const unique = [...new Set(files.filter(Boolean))].slice(0, 200);
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT fq_name, simple_name, kind, file, line, end_line, signature, visibility, parent,
             package_name, return_type, parameter_types_json, annotations_json,
             framework_role, framework_meta_json, file_role
      FROM symbols
      WHERE snapshot_id = ? AND file IN (${placeholders})
      ORDER BY file, line
      LIMIT 1000
    `).all(snapshotId, ...unique) as SymbolRow[];
    return rows.map(row => symbolDto(row, snippets));
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
      SELECT fq_name, simple_name, kind, file, line, end_line, signature, visibility, parent,
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

  private explicitContextMatches(
    snapshotId: string,
    task: string,
    domain: string | undefined,
    limit: number,
  ): {
    candidateFiles: Array<ReturnType<typeof compactFileCandidate>>;
    relevantSymbols: Array<ReturnType<typeof compactSymbolCandidate>>;
    topFiles: string[];
  } {
    const resolvedFiles = uniqueFilesInOrder(
      explicitFileNeedles(task, domain)
        .map(needle => this.resolveFile(snapshotId, needle))
        .filter((file): file is string => Boolean(file)),
    ).slice(0, limit);
    if (resolvedFiles.length === 0) {
      return { candidateFiles: [], relevantSymbols: [], topFiles: [] };
    }

    const placeholders = resolvedFiles.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT path, language, file_role, parse_status, size
      FROM files
      WHERE snapshot_id = ? AND path IN (${placeholders})
    `).all(snapshotId, ...resolvedFiles) as FileRow[];
    const rowsByPath = new Map(rows.map(row => [row.path, row]));
    const symbolsByFile = new Map<string, Array<Record<string, unknown>>>();
    for (const symbol of this.symbolsForFiles(snapshotId, resolvedFiles)) {
      const file = String(symbol.file ?? '');
      const current = symbolsByFile.get(file) ?? [];
      current.push(symbol);
      symbolsByFile.set(file, current);
    }

    const candidateFiles: Array<ReturnType<typeof compactFileCandidate>> = [];
    const relevantSymbols: Array<ReturnType<typeof compactSymbolCandidate>> = [];
    for (const file of resolvedFiles) {
      const row = rowsByPath.get(file);
      if (!row) continue;
      const basename = path.basename(file, path.extname(file));
      const symbols = symbolsByFile.get(file) ?? [];
      const compactSymbols = symbols
        .map(symbol => compactSymbolCandidate(symbol, `explicit task/domain file match: ${file}`))
        .slice(0, 6);
      const primarySymbol = compactSymbols.find(symbol => symbol.name === basename) ?? compactSymbols[0];
      candidateFiles.push({
        file,
        language: row.language,
        fileRole: row.file_role,
        lines: primarySymbol?.lines ?? '1-80',
        whyRelevant: `explicit task/domain file match: ${file}`,
        confidence: 0.95,
        matchedTokens: [basename],
        snippet: undefined,
        topSymbols: compactSymbols,
        endpoints: [],
      });
      relevantSymbols.push(...compactSymbols.slice(0, 4));
    }

    return {
      candidateFiles,
      relevantSymbols: uniqueSymbolCandidates(relevantSymbols).slice(0, limit * 4),
      topFiles: resolvedFiles,
    };
  }

  private findRelevantTestsForSeeds(snapshotId: string, seeds: string[], limit: number): Array<Record<string, unknown>> {
    const merged = new Map<string, { file: string; score: number; reasons: Set<string> }>();
    for (const seed of [...new Set(seeds.map(item => item.trim()).filter(Boolean))].slice(0, 16)) {
      for (const test of this.findRelevantTests(snapshotId, seed, limit)) {
        const file = String(test.file ?? '');
        if (!file) continue;
        const existing = merged.get(file) ?? { file, score: 0, reasons: new Set<string>() };
        existing.score += Number(test.score ?? 0);
        for (const reason of (test.reasons as string[] | undefined) ?? []) existing.reasons.add(reason);
        merged.set(file, existing);
      }
    }
    return [...merged.values()]
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
      .slice(0, limit)
      .map(test => ({
        file: test.file,
        score: test.score,
        reasons: [...test.reasons].slice(0, 8),
      }));
  }

  private validationHints(
    snapshotId: string,
    tests: Array<Record<string, unknown>>,
    topFiles: string[],
  ): Record<string, unknown> {
    const root = this.workspaceRootForSnapshot(snapshotId);
    const testFiles = tests.map(test => String(test.file ?? '')).filter(Boolean).slice(0, 8);
    const commands: string[] = [];
    if (root) {
      const packageInfo = readPackageInfo(root);
      if (packageInfo) {
        const runner = packageManagerCommand(root);
        const scripts = packageInfo.scripts ?? {};
        if (testFiles.length > 0 && scripts.test) {
          commands.push(`${runner} test -- ${testFiles.map(quoteShellArg).join(' ')}`);
        } else if (scripts.test) {
          commands.push(`${runner} test`);
        }
        if (scripts.typecheck) commands.push(`${runner} run typecheck`);
        else if (scripts.lint) commands.push(`${runner} run lint`);
      }
    }
    return {
      targetedTestFiles: testFiles,
      changedFileHints: topFiles,
      suggestedCommands: [...new Set(commands)].slice(0, 4),
      notes: commands.length > 0
        ? ['Run targeted tests before broad validation; inspect clipped failure output only.']
        : ['No package-level validation command was inferred from the indexed workspace.'],
    };
  }

  private lookupBestSymbol(snapshotId: string, symbol: string, file?: string): SymbolRow | undefined {
    const query = symbol.trim();
    if (!query) return undefined;
    const pattern = `%${escapeLike(query)}%`;
    const fileClause = file ? 'AND file = ?' : '';
    const params: unknown[] = [snapshotId];
    if (file) params.push(file);
    params.push(query, query, pattern, pattern);
    return this.db.prepare(`
      SELECT fq_name, simple_name, kind, file, line, end_line, signature, visibility, parent,
             package_name, return_type, parameter_types_json, annotations_json,
             framework_role, framework_meta_json, file_role
      FROM symbols
      WHERE snapshot_id = ?
        ${fileClause}
        AND (
          fq_name = ?
          OR simple_name = ?
          OR fq_name LIKE ? ESCAPE '\\'
          OR simple_name LIKE ? ESCAPE '\\'
        )
      ORDER BY
        CASE
          WHEN fq_name = ? THEN 0
          WHEN simple_name = ? THEN 1
          WHEN fq_name LIKE ? ESCAPE '\\' THEN 2
          ELSE 3
        END,
        CASE file_role
          WHEN 'main_source' THEN 0
          WHEN 'resource_config' THEN 1
          WHEN 'build_config' THEN 2
          WHEN 'test_source' THEN 3
          WHEN 'mock_source' THEN 4
          WHEN 'generated' THEN 5
          ELSE 6
        END,
        line
      LIMIT 1
    `).get(...params, query, query, pattern) as SymbolRow | undefined;
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
    return rows.map(row => endpointDto(row));
  }
}

interface SymbolRow {
  fq_name: string;
  simple_name: string;
  kind: string;
  file: string;
  line: number;
  end_line?: number;
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

interface SnippetOptions {
  root: string;
  lines: number;
  budgetChars: number;
  usedChars: number;
}

function symbolDto(row: SymbolRow, snippets?: SnippetOptions): Record<string, unknown> {
  const frameworkMeta = parseJson<Record<string, string>>(row.framework_meta_json, {});
  return {
    name: row.simple_name,
    fqName: row.fq_name,
    kind: row.kind,
    file: row.file,
    line: row.line,
    endLine: row.end_line,
    lines: lineRangeString(row.line, row.end_line ?? row.line),
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
    snippet: sourceSnippet(row.file, row.line, snippets),
  };
}

function endpointDto(
  row: EndpointRow,
  snippets?: SnippetOptions,
  rankExplanation?: string[],
): Record<string, unknown> {
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
    rankExplanation,
    snippet: sourceSnippet(row.file, row.line, snippets),
  };
}

function fileDto(
  row: FileRow,
  evidence: FileEvidence | undefined,
  score: FileSearchScore | undefined,
  explainRank: boolean,
  snippets?: SnippetOptions,
): Record<string, unknown> {
  const topSymbols = (evidence?.symbols ?? [])
    .filter((symbol) => {
      const kind = String(symbol.kind ?? '');
      return kind === 'class'
        || kind === 'interface'
        || kind === 'method'
        || kind === 'function'
        || kind === 'type'
        || (row.file_role === 'resource_config' && kind === 'field');
    })
    .sort((a, b) => symbolDisplayPriority(b) - symbolDisplayPriority(a) || Number(a.line ?? 0) - Number(b.line ?? 0))
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
    snippet: fileEvidenceSnippet(row, evidence, snippets),
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

function fileEvidenceSnippet(
  row: FileRow,
  evidence: FileEvidence | undefined,
  snippets?: SnippetOptions,
): Record<string, unknown> | undefined {
  if (!snippets) return undefined;
  const endpoint = evidence?.endpoints.find(item => Number(item.line ?? 0) > 0);
  if (endpoint) return sourceSnippet(row.path, Number(endpoint.line), snippets);
  const symbol = evidence?.symbols.find(item => Number(item.line ?? 0) > 0);
  if (symbol) return sourceSnippet(row.path, Number(symbol.line), snippets);
  return sourceSnippet(row.path, 1, snippets);
}

function sourceSnippet(
  file: string | undefined,
  line: number | undefined,
  snippets?: SnippetOptions,
): Record<string, unknown> | undefined {
  if (!snippets || !file || !line || line < 1) return undefined;
  if (snippets.usedChars >= snippets.budgetChars) return undefined;

  const absolutePath = safeResolve(snippets.root, file);
  if (!absolutePath) return undefined;

  let content: string;
  try {
    content = fs.readFileSync(absolutePath, 'utf-8');
  } catch {
    return undefined;
  }

  const sourceLines = content.split(/\r?\n/);
  const target = Math.min(Math.max(line, 1), sourceLines.length);
  const before = Math.floor((snippets.lines - 1) / 2);
  let start = Math.max(1, target - before);
  let end = Math.min(sourceLines.length, start + snippets.lines - 1);
  start = Math.max(1, end - snippets.lines + 1);

  const text = sourceLines
    .slice(start - 1, end)
    .map((sourceLine, index) => `${start + index}: ${sourceLine}`)
    .join('\n');
  if (snippets.usedChars + text.length > snippets.budgetChars) return undefined;
  snippets.usedChars += text.length;

  return {
    startLine: start,
    endLine: end,
    highlightLine: target,
    text,
  };
}

function safeResolve(root: string, file: string): string | undefined {
  const normalizedRoot = path.resolve(root);
  const absolutePath = path.resolve(normalizedRoot, file.replace(/\\/g, '/'));
  const relative = path.relative(normalizedRoot, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return absolutePath;
}

function parseLineRange(value: string): { start: number; end: number } | undefined {
  const match = value.trim().match(/^(\d+)(?:\s*[-:]\s*(\d+))?$/);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < 1) return undefined;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function lineRangeString(start: number, end: number): string {
  return start === end ? String(start) : `${start}-${end}`;
}

function compactFileCandidate(row: Record<string, unknown>): {
  file: string;
  language?: string;
  fileRole?: string;
  lines?: string;
  whyRelevant: string;
  confidence: number;
  matchedTokens: string[];
  snippet?: unknown;
  topSymbols: Array<Record<string, unknown>>;
  endpoints: Array<Record<string, unknown>>;
} {
  const snippet = row.snippet as Record<string, unknown> | undefined;
  return {
    file: String(row.path ?? ''),
    language: stringOrUndefined(row.language),
    fileRole: stringOrUndefined(row.fileRole),
    lines: snippet ? lineRangeString(Number(snippet.startLine), Number(snippet.endLine)) : undefined,
    whyRelevant: truncateString(String(row.matchReason ?? 'ranked file/path/symbol evidence match'), 240),
    confidence: confidenceFromScore(row.searchScore),
    matchedTokens: stringArray(row.matchedTokens),
    snippet,
    topSymbols: compactSymbolList(row.topSymbols).slice(0, 6),
    endpoints: compactEndpointCandidates(Array.isArray(row.endpoints) ? row.endpoints as Array<Record<string, unknown>> : []).slice(0, 4),
  };
}

function compactSymbolCandidate(row: Record<string, unknown>, why?: string): {
  symbol: string;
  name: string;
  kind?: string;
  file: string;
  lines?: string;
  signature?: string;
  frameworkRole?: string;
  whyRelevant: string;
  confidence: number;
  matchedTokens: string[];
} {
  return {
    symbol: String(row.fqName ?? row.name ?? ''),
    name: String(row.name ?? row.fqName ?? ''),
    kind: stringOrUndefined(row.kind),
    file: String(row.file ?? ''),
    lines: String(row.lines ?? row.line ?? ''),
    signature: truncateOptional(row.signature, 240),
    frameworkRole: stringOrUndefined(row.frameworkRole),
    whyRelevant: truncateString(why ?? String(row.matchReason ?? 'ranked symbol/name evidence match'), 240),
    confidence: confidenceFromScore(row.searchScore),
    matchedTokens: stringArray(row.matchedTokens),
  };
}

function compactSymbolList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map(item => compactSymbolCandidate(item as Record<string, unknown>));
}

function uniqueFileCandidates<T extends { file: string }>(candidates: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const candidate of candidates) {
    if (!candidate.file || seen.has(candidate.file)) continue;
    seen.add(candidate.file);
    result.push(candidate);
  }
  return result;
}

function uniqueSymbolCandidates<T extends { symbol: string; file: string }>(candidates: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.symbol}\0${candidate.file}`;
    if (!candidate.symbol || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function compactEndpointCandidates(rows: Array<Record<string, unknown>>): Array<{
  method: string;
  path: string;
  handlerSymbol: string;
  file: string;
  line: number;
  lines: string;
  framework?: string;
  confidence: number;
  whyRelevant: string;
}> {
  const seen = new Set<string>();
  const result: Array<{
    method: string;
    path: string;
    handlerSymbol: string;
    file: string;
    line: number;
    lines: string;
    framework?: string;
    confidence: number;
    whyRelevant: string;
  }> = [];
  for (const row of rows) {
    const key = `${row.method}:${row.path}:${row.file}:${row.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const line = Number(row.line ?? 0);
    result.push({
      method: String(row.method ?? 'ALL'),
      path: String(row.path ?? ''),
      handlerSymbol: String(row.handlerSymbol ?? row.handler_symbol ?? ''),
      file: String(row.file ?? ''),
      line,
      lines: line > 0 ? String(line) : '',
      framework: stringOrUndefined(row.framework),
      confidence: typeof row.confidence === 'number' ? row.confidence : 0.65,
      whyRelevant: truncateString(
        Array.isArray(row.rankExplanation)
          ? (row.rankExplanation as string[]).join('; ')
          : 'indexed endpoint associated with candidate files',
        240,
      ),
    });
  }
  return result;
}

function endpointNeedleForTask(task: string, domain?: string): string {
  const explicitPath = task.match(/\/[A-Za-z0-9_{}:$.-][A-Za-z0-9_{}:$/.-]*/);
  if (explicitPath) return explicitPath[0];
  if (domain?.includes('/')) return domain;
  return '';
}

function explicitFileNeedles(task: string, domain?: string): string[] {
  const text = [task, domain ?? ''].join(' ');
  const needles = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+/g)) {
    const value = match[0]?.replace(/\\/g, '/').replace(/[),.;:]+$/g, '');
    if (value && value.includes('/')) needles.add(value);
  }
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9_$]{3,}\b/g)) {
    const name = match[0];
    if (!EXPLICIT_FILENAME_STOP_WORDS.has(name) && !/\.(java|ts|tsx|js|jsx|py|xml|json|ya?ml|properties)$/i.test(name)) {
      needles.add(`${name}.java`);
      needles.add(`${name}.ts`);
      needles.add(`${name}.py`);
    }
  }
  return [...needles].filter(needle => needle.length >= 4);
}

function isCompatibleExplicitFileCandidate(file: string, explicitFiles: string[]): boolean {
  const normalizedFile = file.replace(/\\/g, '/');
  const fileExt = path.posix.extname(normalizedFile).toLowerCase();
  return explicitFiles.some(explicitFile => {
    const normalizedExplicit = explicitFile.replace(/\\/g, '/');
    if (normalizedFile === normalizedExplicit) return true;
    const explicitExt = path.posix.extname(normalizedExplicit).toLowerCase();
    if (fileExt && explicitExt && fileExt !== explicitExt) return false;
    return sharedPrefixSegments(normalizedFile, normalizedExplicit) >= 4;
  });
}

function sharedPrefixSegments(left: string, right: string): number {
  const leftParts = left.split('/').filter(Boolean);
  const rightParts = right.split('/').filter(Boolean);
  const length = Math.min(leftParts.length, rightParts.length);
  let shared = 0;
  for (let index = 0; index < length; index++) {
    if (leftParts[index] !== rightParts[index]) break;
    shared++;
  }
  return shared;
}

const EXPLICIT_FILENAME_STOP_WORDS = new Set([
  'Find',
  'Implementation',
  'Context',
  'Callers',
  'Likely',
  'Tests',
  'Test',
  'The',
  'This',
  'That',
  'With',
]);

function inferDomain(task: string, files: string[]): string {
  if (files.length > 0) {
    const first = files[0].split(/[\\/]/).filter(Boolean);
    const srcIndex = first.findIndex(part => part === 'src');
    if (srcIndex > 0) return first[srcIndex - 1];
    if (first.length >= 2) return first.slice(0, 2).join('/');
    if (first.length === 1) return first[0];
  }
  const tokens = tokenizeSearchQuery(task);
  return tokens[0] ?? 'unknown';
}

function nextContextAction(
  files: Array<{ file: string; lines?: string }>,
  symbols: Array<{ symbol: string; file: string; lines?: string }>,
): string {
  const firstFile = files.find(file => file.file);
  if (firstFile?.lines) {
    return `Call get_file_slice with file="${firstFile.file}" lines="${firstFile.lines}" for exact edit context, then run the suggested targeted validation.`;
  }
  const firstSymbol = symbols.find(symbol => symbol.symbol);
  if (firstSymbol) {
    return `Call get_file_slice with symbol="${firstSymbol.symbol}" for exact edit context, then inspect related tests before editing.`;
  }
  return 'Broaden the task/domain query or call search_code with explainRank=true; current packet has no confident candidates.';
}

function packetConfidence(
  files: Array<{ confidence: number }>,
  symbols: Array<{ confidence: number }>,
  tests: Array<Record<string, unknown>>,
): number {
  const scores = [
    ...files.slice(0, 3).map(file => file.confidence),
    ...symbols.slice(0, 3).map(symbol => symbol.confidence),
  ].filter(score => Number.isFinite(score));
  if (scores.length === 0) return 0.3;
  const avg = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const testBoost = tests.length > 0 ? 0.05 : 0;
  return Math.min(0.95, Math.round((avg + testBoost) * 100) / 100);
}

function confidenceFromScore(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.65;
  if (value >= 100) return 0.9;
  if (value >= 80) return 0.8;
  if (value >= 60) return 0.7;
  if (value >= 40) return 0.6;
  return 0.45;
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function stringOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}

function truncateOptional(value: unknown, maxChars: number): string | undefined {
  const text = stringOrUndefined(value);
  return text ? truncateString(text, maxChars) : undefined;
}

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 13))}...<truncated>`;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item));
}

function readPackageInfo(root: string): { scripts?: Record<string, string> } | undefined {
  const packagePath = path.join(root, 'package.json');
  if (!fs.existsSync(packagePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(packagePath, 'utf-8')) as { scripts?: Record<string, string> };
  } catch {
    return undefined;
  }
}

function packageManagerCommand(root: string): string {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function rankDebug(tool: string, notes: string[]): Record<string, unknown> {
  return {
    tool,
    explainRank: true,
    notes,
  };
}

function endpointRankExplanation(row: EndpointRow, requestedMethod: string, requestedPath?: string): string[] {
  const factors = [
    `file role ${row.file_role} ordered before lower-priority roles`,
    `endpoint confidence ${row.confidence}`,
    `path resolution ${row.path_resolution}`,
  ];
  if (requestedMethod !== 'ALL' && row.method === requestedMethod) factors.push(`HTTP method matched ${requestedMethod}`);
  if (requestedPath && row.path.includes(requestedPath)) factors.push(`composed endpoint path matched "${requestedPath}"`);
  if (row.path_resolution !== 'exact' && row.path_resolution_reason) {
    factors.push(`partial path reason: ${row.path_resolution_reason}`);
  }
  return factors;
}

function parsePatchFilePaths(diff: string): string[] {
  if (!diff.trim()) return [];
  const files: string[] = [];
  for (const rawLine of diff.split(/\r?\n/)) {
    const line = rawLine.trim();
    const gitMatch = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
    if (gitMatch) {
      files.push(normalizePatchPath(gitMatch[1] ?? ''));
      files.push(normalizePatchPath(gitMatch[2] ?? ''));
      continue;
    }
    const markerMatch = /^(?:---|\+\+\+)\s+(.+?)(?:\t.*)?$/.exec(line);
    if (markerMatch) {
      files.push(normalizePatchPath(markerMatch[1] ?? ''));
      continue;
    }
    const renameMatch = /^(?:rename|copy) (?:from|to)\s+(.+)$/.exec(line);
    if (renameMatch) files.push(normalizePatchPath(renameMatch[1] ?? ''));
  }
  return uniqueFilesInOrder(files.filter(Boolean));
}

function normalizePatchPath(value: string): string {
  let normalized = value.trim().replace(/\\/g, '/');
  if (!normalized || normalized === '/dev/null') return '';
  normalized = normalized.replace(/^"|"$/g, '').replace(/^\.\/+/, '');
  if (normalized === '/dev/null') return '';
  if (normalized.startsWith('a/') || normalized.startsWith('b/')) normalized = normalized.slice(2);
  return normalized;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values.map(item => item.trim()).filter(Boolean)) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function uniqueRecordsBy<T>(rows: T[], keyFor: (row: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const row of rows) {
    const key = keyFor(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

function uniqueCallEdges(rows: CallEdgeRow[]): CallEdgeRow[] {
  return uniqueRecordsBy(rows, row => `${row.caller}:${row.callee}:${row.file}:${row.line}`);
}

function patchRiskFlags(input: {
  changedFiles: string[];
  touchedSymbols: Array<{ kind?: string; symbol: string; file: string; frameworkRole?: string }>;
  changedEndpoints: Array<{ method: string; path: string; file: string }>;
  impactedEndpoints: Array<{ method: string; path: string; file: string }>;
  directDependentCount: number;
  callerCount: number;
  testsCount: number;
  unresolvedInputCount: number;
}): Array<Record<string, unknown>> {
  const flags: Array<Record<string, unknown>> = [];
  const changedFileSet = new Set(input.changedFiles);
  const dependentEndpoints = input.impactedEndpoints.filter(endpoint => !changedFileSet.has(endpoint.file));
  if (input.changedEndpoints.length > 0) {
    flags.push({
      type: 'endpoint-change',
      severity: 'high',
      reason: 'Changed files expose indexed HTTP endpoints.',
      evidence: input.changedEndpoints.slice(0, 5),
    });
  }
  if (dependentEndpoints.length > 0) {
    flags.push({
      type: 'dependent-endpoint',
      severity: 'medium',
      reason: 'Dependent or caller files expose endpoints that may observe this change.',
      evidence: dependentEndpoints.slice(0, 5),
    });
  }
  const publicSymbols = input.touchedSymbols.filter(symbol => isPublicPatchSymbol(symbol));
  if (publicSymbols.length > 0) {
    flags.push({
      type: 'public-api-symbol',
      severity: input.changedEndpoints.length > 0 ? 'high' : 'medium',
      reason: 'Changed files declare public API-like symbols.',
      evidence: publicSymbols.slice(0, 8),
    });
  }
  const configFiles = input.changedFiles.filter(isConfigPatchFile);
  if (configFiles.length > 0) {
    flags.push({
      type: 'config-change',
      severity: 'medium',
      reason: 'Build, runtime, or deployment configuration appears in the patch.',
      evidence: configFiles.slice(0, 8),
    });
  }
  const fanout = input.directDependentCount + input.callerCount;
  if (fanout >= 10) {
    flags.push({
      type: 'high-fanout',
      severity: 'high',
      reason: `Patch has ${input.directDependentCount} direct dependents and ${input.callerCount} call sites.`,
    });
  } else if (fanout >= 5) {
    flags.push({
      type: 'moderate-fanout',
      severity: 'medium',
      reason: `Patch has ${input.directDependentCount} direct dependents and ${input.callerCount} call sites.`,
    });
  }
  if (input.changedFiles.length > 0 && input.changedFiles.every(isTestPatchFile)) {
    flags.push({
      type: 'test-only-change',
      severity: 'low',
      reason: 'All resolved changed files look like tests or fixtures.',
    });
  }
  if (input.changedFiles.length > 0 && input.testsCount === 0 && !input.changedFiles.every(isTestPatchFile)) {
    flags.push({
      type: 'no-tests-found',
      severity: 'medium',
      reason: 'No likely tests were found from file names, symbol names, or call edges.',
    });
  }
  if (input.unresolvedInputCount > 0) {
    flags.push({
      type: 'unresolved-inputs',
      severity: 'medium',
      reason: `${input.unresolvedInputCount} file or symbol inputs did not resolve in the current index.`,
    });
  }
  return flags;
}

function patchBlastRadius(input: {
  changedFiles: string[];
  directDependentCount: number;
  callerCount: number;
  changedEndpointCount: number;
  impactedEndpointCount: number;
  testsCount: number;
  riskFlags: Array<Record<string, unknown>>;
}): 'unknown' | 'low' | 'medium' | 'high' {
  if (input.changedFiles.length === 0) return 'unknown';
  if (input.riskFlags.some(flag => flag.type === 'endpoint-change' || flag.type === 'high-fanout')) return 'high';
  const score = input.changedFiles.length
    + (input.directDependentCount * 2)
    + input.callerCount
    + (input.changedEndpointCount * 5)
    + (input.impactedEndpointCount * 3)
    + Math.min(input.testsCount, 5);
  if (score >= 18) return 'high';
  if (score >= 5) return 'medium';
  return 'low';
}

function patchNextActions(
  unresolvedFiles: string[],
  unresolvedSymbols: string[],
  validation: Record<string, unknown>,
  riskFlags: Array<Record<string, unknown>>,
  changedFiles: string[],
): string[] {
  const actions: string[] = [];
  if (unresolvedFiles.length > 0 || unresolvedSymbols.length > 0) {
    actions.push('Resolve unresolved file/symbol inputs or rerun with autoRefresh=true before trusting the impact slice.');
  }
  const firstFile = changedFiles[0];
  if (firstFile) actions.push(`Call get_file_slice for "${firstFile}" before editing to keep context bounded.`);
  if (riskFlags.some(flag => flag.type === 'endpoint-change' || flag.type === 'dependent-endpoint')) {
    actions.push('Inspect changedEndpoints and impactedEndpoints before changing handler/service contracts.');
  }
  if (riskFlags.some(flag => flag.type === 'high-fanout' || flag.type === 'moderate-fanout')) {
    actions.push('Inspect dependencyImpact.dependents and callImpact.callers before patching shared behavior.');
  }
  const suggestedCommands = Array.isArray(validation.suggestedCommands) ? validation.suggestedCommands as string[] : [];
  if (suggestedCommands.length > 0) actions.push(`Run targeted validation first: ${suggestedCommands[0]}`);
  else actions.push('No validation command was inferred; identify a local targeted test or typecheck command before broad validation.');
  return actions;
}

function patchImpactConfidence(changedFileCount: number, unresolvedInputCount: number, testsCount: number): number {
  let confidence = changedFileCount > 0 ? 0.72 : 0.3;
  if (testsCount > 0) confidence += 0.06;
  if (unresolvedInputCount > 0) confidence -= Math.min(0.3, unresolvedInputCount * 0.08);
  return Math.round(Math.max(0.25, Math.min(0.9, confidence)) * 100) / 100;
}

function isPublicPatchSymbol(symbol: { kind?: string; symbol: string; frameworkRole?: string }): boolean {
  const kind = String(symbol.kind ?? '');
  const role = String(symbol.frameworkRole ?? '');
  return role.length > 0 || kind === 'class' || kind === 'interface' || kind === 'enum' || kind === 'method' || kind === 'function';
}

function isConfigPatchFile(file: string): boolean {
  return /(^|\/)(package\.json|pom\.xml|build\.gradle|settings\.gradle|gradle\.properties|Dockerfile|docker-compose\.ya?ml|application[-.\w]*\.(ya?ml|properties)|[^/]+\.(xml|ya?ml|toml|ini))$/i.test(file);
}

function isTestPatchFile(file: string): boolean {
  return /(^|\/)(test|tests|spec|__tests__|fixtures?)(\/|$)|(\.test|\.spec)\.[^.]+$/i.test(file);
}

type ReviewFocus = 'general' | 'bug-risk' | 'api-contract' | 'tests' | 'security';
type ReviewOutputMode = 'compact' | 'balanced' | 'full';

interface PatchLineChange {
  line: number;
  text: string;
}

interface PatchContextLine {
  oldLine: number;
  newLine: number;
  text: string;
}

interface PatchHunk {
  file: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  addedLines: PatchLineChange[];
  removedLines: PatchLineChange[];
  contextLines: PatchContextLine[];
  changeKinds: string[];
}

interface ReviewFinding {
  id: string;
  priority: 'P0' | 'P1' | 'P2';
  title: string;
  why: string;
  evidence?: unknown;
  suggestedCheck: string;
  confidence: number;
}

interface PatchLineMapping {
  confidence: 'high' | 'medium' | 'low';
  exactSliceSafe: boolean;
  reason: string;
  fileSliceLines?: string;
}

interface ReviewBudget {
  outputMode: ReviewOutputMode;
  maxFindings: number;
  maxLineFocus: number;
  maxRiskFlags: number;
  maxTests: number;
  maxEvidencePerFinding: number;
  maxRequiredToolCalls: number;
}

function normalizeReviewFocus(value: string): ReviewFocus {
  if (value === 'bug-risk' || value === 'api-contract' || value === 'tests' || value === 'security') return value;
  return 'general';
}

function normalizeReviewOutputMode(value: string): ReviewOutputMode {
  if (value === 'balanced' || value === 'full') return value;
  return 'compact';
}

function reviewBudgetFor(outputMode: ReviewOutputMode, args: Record<string, unknown>, limit: number): ReviewBudget {
  const defaults = outputMode === 'full'
    ? { maxFindings: limit, maxLineFocus: limit, maxRiskFlags: limit, maxTests: Math.min(limit, 50), maxEvidencePerFinding: 12, maxRequiredToolCalls: 8 }
    : outputMode === 'balanced'
      ? { maxFindings: 10, maxLineFocus: 20, maxRiskFlags: 12, maxTests: 8, maxEvidencePerFinding: 5, maxRequiredToolCalls: 4 }
      : { maxFindings: 6, maxLineFocus: 10, maxRiskFlags: 8, maxTests: 5, maxEvidencePerFinding: 3, maxRequiredToolCalls: 3 };
  return {
    outputMode,
    maxFindings: clampInt(Number(args.maxFindings ?? defaults.maxFindings), 1, limit),
    maxLineFocus: clampInt(Number(args.maxLineFocus ?? defaults.maxLineFocus), 1, limit),
    maxRiskFlags: clampInt(defaults.maxRiskFlags, 1, limit),
    maxTests: clampInt(defaults.maxTests, 0, limit),
    maxEvidencePerFinding: clampInt(Number(args.maxEvidencePerFinding ?? defaults.maxEvidencePerFinding), 1, 20),
    maxRequiredToolCalls: clampInt(Number(args.maxRequiredToolCalls ?? defaults.maxRequiredToolCalls), 1, 20),
  };
}

function parsePatchHunks(diff: string): PatchHunk[] {
  if (!diff.trim()) return [];
  const hunks: PatchHunk[] = [];
  let currentFile = '';
  let current: (PatchHunk & { oldLine: number; newLine: number }) | undefined;

  for (const rawLine of diff.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    const gitMatch = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line.trim());
    if (gitMatch) {
      currentFile = normalizePatchPath(gitMatch[2] ?? gitMatch[1] ?? '');
      current = undefined;
      continue;
    }
    const markerMatch = /^\+\+\+\s+(.+?)(?:\t.*)?$/.exec(line.trim());
    if (markerMatch) {
      const markerFile = normalizePatchPath(markerMatch[1] ?? '');
      if (markerFile) currentFile = markerFile;
      current = undefined;
      continue;
    }
    const hunkMatch = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?/.exec(line);
    if (hunkMatch) {
      const oldStart = Number(hunkMatch[1]);
      const newStart = Number(hunkMatch[3]);
      current = {
        file: currentFile,
        oldStart,
        oldLines: Number(hunkMatch[2] ?? 1),
        newStart,
        newLines: Number(hunkMatch[4] ?? 1),
        addedLines: [],
        removedLines: [],
        contextLines: [],
        changeKinds: [],
        oldLine: oldStart,
        newLine: newStart,
      };
      hunks.push(current);
      continue;
    }
    if (!current || line.startsWith('\\')) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.addedLines.push({ line: current.newLine, text: truncateString(line.slice(1), 240) });
      current.newLine++;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      current.removedLines.push({ line: current.oldLine, text: truncateString(line.slice(1), 240) });
      current.oldLine++;
      continue;
    }
    if (line.startsWith(' ')) {
      current.contextLines.push({
        oldLine: current.oldLine,
        newLine: current.newLine,
        text: truncateString(line.slice(1), 240),
      });
      current.oldLine++;
      current.newLine++;
    }
  }

  for (const hunk of hunks) {
    hunk.changeKinds = patchChangeKinds(hunk);
  }
  return hunks;
}

function compactPatchHunk(hunk: PatchHunk, mapping?: PatchLineMapping): Record<string, unknown> {
  const firstAdded = hunk.addedLines[0]?.line ?? hunk.newStart;
  const lastAdded = hunk.addedLines[hunk.addedLines.length - 1]?.line ?? Math.max(hunk.newStart, hunk.newStart + hunk.newLines - 1);
  const newLines = lineRangeString(firstAdded, lastAdded);
  return {
    file: hunk.file,
    newLines,
    fileSliceLines: mapping?.exactSliceSafe ? (mapping.fileSliceLines ?? newLines) : undefined,
    lineMappingConfidence: mapping?.confidence ?? 'medium',
    lineMappingReason: mapping?.reason ?? 'diff hunk line numbers are assumed to match the post-patch file',
    oldLines: lineRangeString(hunk.oldStart, Math.max(hunk.oldStart, hunk.oldStart + hunk.oldLines - 1)),
    addedLineCount: hunk.addedLines.length,
    removedLineCount: hunk.removedLines.length,
    changeKinds: hunk.changeKinds,
    addedPreview: hunk.addedLines.slice(0, 2),
    removedPreview: hunk.removedLines.slice(0, 2),
  };
}

function patchChangeKinds(hunk: PatchHunk): string[] {
  const file = hunk.file.toLowerCase();
  const added = hunk.addedLines.map(line => line.text).join('\n');
  const removed = hunk.removedLines.map(line => line.text).join('\n');
  const both = `${added}\n${removed}`;
  const kinds = new Set<string>();
  if (isConfigPatchFile(hunk.file)) kinds.add('config');
  if (isTestPatchFile(hunk.file) || /\b(assert|expect|verify|@Test|describe\(|it\()\b/.test(both)) kinds.add('test');
  if (/@(GET|POST|PUT|PATCH|DELETE|Path|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\b/.test(both)) kinds.add('endpoint');
  if (/\b(public|export|interface|class|enum|record)\b/.test(added)) kinds.add('contract');
  if (/\b(catch|throw|throws|Exception|Throwable|Error)\b/.test(both)) kinds.add('error-handling');
  if (/\b(select|insert|update|delete|where)\b/i.test(both)) kinds.add('sql');
  if (/\b(auth|permission|role|token|secret|password|credential|api[_-]?key)\b/i.test(both)) kinds.add('security');
  if (/\b(console\.log|System\.out|printStackTrace|debugger)\b/.test(added)) kinds.add('debug-output');
  if (file.includes('/test/') || file.includes('/tests/')) kinds.add('test');
  return [...kinds];
}

function reviewFindingsForPatch(input: {
  focus: ReviewFocus;
  diff: string;
  hunks: PatchHunk[];
  changedFiles: string[];
  riskFlags: Array<Record<string, unknown>>;
  testsCount: number;
  summary: Record<string, unknown>;
}): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const add = (finding: ReviewFinding) => {
    if (findings.some(existing => existing.id === finding.id)) return;
    findings.push(finding);
  };

  if (input.changedFiles.length === 0) {
    add({
      id: 'no-resolved-patch-input',
      priority: 'P1',
      title: 'Patch inputs did not resolve to indexed files',
      why: 'The review packet cannot connect the patch to graph evidence until at least one file or symbol resolves.',
      suggestedCheck: 'Refresh the index or pass explicit repo-relative files from the diff.',
      confidence: 0.85,
    });
  }

  for (const flag of input.riskFlags) {
    const type = String(flag.type ?? '');
    if (type === 'endpoint-change') {
      add({
        id: 'review-endpoint-contract',
        priority: 'P1',
        title: 'Endpoint contract changed or is directly touched',
        why: 'Endpoint changes are user-facing and often require request/response, auth, compatibility, and integration-test checks.',
        evidence: flag.evidence,
        suggestedCheck: 'Verify route compatibility, status codes, auth behavior, and endpoint-level tests.',
        confidence: 0.8,
      });
    } else if (type === 'dependent-endpoint') {
      add({
        id: 'review-dependent-endpoints',
        priority: input.focus === 'api-contract' ? 'P1' : 'P2',
        title: 'Dependent endpoint may observe the change',
        why: 'The changed files feed code that is associated with indexed endpoints.',
        evidence: flag.evidence,
        suggestedCheck: 'Trace the endpoint path and inspect whether behavior changes for callers.',
        confidence: 0.68,
      });
    } else if (type === 'high-fanout' || type === 'moderate-fanout') {
      add({
        id: 'review-fanout',
        priority: type === 'high-fanout' ? 'P1' : 'P2',
        title: 'Shared code has non-trivial fanout',
        why: String(flag.reason ?? 'Patch has multiple dependents or callers.'),
        suggestedCheck: 'Inspect callImpact.callers and dependencyImpact.dependents before approving behavior changes.',
        confidence: 0.75,
      });
    } else if (type === 'no-tests-found') {
      add({
        id: 'review-missing-tests',
        priority: 'P1',
        title: 'No likely tests were found',
        why: 'A production patch without nearby tests is higher risk, especially when graph impact is non-empty.',
        suggestedCheck: 'Ask for a targeted test or identify the closest existing test command before approval.',
        confidence: 0.72,
      });
    } else if (type === 'unresolved-inputs') {
      add({
        id: 'review-unresolved-inputs',
        priority: 'P1',
        title: 'Some review inputs did not resolve',
        why: String(flag.reason ?? 'Unresolved file or symbol input can hide affected code.'),
        suggestedCheck: 'Refresh the index and retry with exact repo-relative paths.',
        confidence: 0.78,
      });
    } else if (type === 'config-change') {
      add({
        id: 'review-config-change',
        priority: input.focus === 'security' ? 'P1' : 'P2',
        title: 'Configuration changed',
        why: 'Config changes can affect runtime behavior without direct call graph edges.',
        evidence: flag.evidence,
        suggestedCheck: 'Check environment defaults, deployment overrides, and rollback behavior.',
        confidence: 0.7,
      });
    } else if (type === 'public-api-symbol') {
      add({
        id: 'review-public-api',
        priority: input.focus === 'api-contract' ? 'P1' : 'P2',
        title: 'Public API-like symbols are touched',
        why: 'Public classes, methods, interfaces, or framework roles can affect consumers beyond local call sites.',
        evidence: flag.evidence,
        suggestedCheck: 'Check compatibility, overloads, serialization shape, and downstream callers.',
        confidence: 0.66,
      });
    }
  }

  for (const hunk of input.hunks) {
    const added = hunk.addedLines.map(line => line.text).join('\n');
    const removed = hunk.removedLines.map(line => line.text).join('\n');
    const lineEvidence = firstLineEvidence(hunk);
    if (containsSecretLikeAssignment(added)) {
      add({
        id: `review-secret-${hunk.file}`,
        priority: 'P0',
        title: 'Secret-like value appears in added lines',
        why: 'Hardcoded credentials or tokens should block approval until verified as non-secret test data.',
        evidence: lineEvidence,
        suggestedCheck: 'Remove the value, move it to secret management, or prove it is inert fixture data.',
        confidence: 0.82,
      });
    }
    if (/\b(Runtime\.getRuntime\(\)\.exec|new\s+ProcessBuilder|child_process\.exec|shell:\s*true)\b/.test(added)) {
      add({
        id: `review-command-exec-${hunk.file}`,
        priority: input.focus === 'security' ? 'P0' : 'P1',
        title: 'Command execution path added',
        why: 'Command execution requires input validation, escaping, least privilege, and failure-mode review.',
        evidence: lineEvidence,
        suggestedCheck: 'Verify all command arguments are trusted or safely escaped and covered by tests.',
        confidence: 0.76,
      });
    }
    if (/\bcatch\s*\(\s*(Exception|Throwable|Error)\b/.test(added)) {
      add({
        id: `review-broad-catch-${hunk.file}`,
        priority: 'P1',
        title: 'Broad exception handling added',
        why: 'Broad catches can hide failures or change retry/transaction semantics.',
        evidence: lineEvidence,
        suggestedCheck: 'Check whether the catch preserves error semantics, logging, and rollback behavior.',
        confidence: 0.68,
      });
    }
    if (hunk.changeKinds.includes('debug-output') || /\b(console\.log|System\.out\.print|printStackTrace|debugger)\b/.test(added)) {
      add({
        id: `review-debug-output-${hunk.file}`,
        priority: 'P2',
        title: 'Debug output appears in added lines',
        why: 'Debug output in production paths can leak data or create noisy logs.',
        evidence: lineEvidence,
        suggestedCheck: 'Replace with structured logging at the right level or remove before approval.',
        confidence: 0.78,
      });
    }
    if (/\b(assert|expect|verify|shouldThrow|assertThrows)\b/.test(removed) && !/\b(assert|expect|verify|shouldThrow|assertThrows)\b/.test(added)) {
      add({
        id: `review-removed-assertion-${hunk.file}`,
        priority: 'P1',
        title: 'Test assertion appears to be removed',
        why: 'Removing assertions can make tests pass while checking less behavior.',
        evidence: firstRemovedLineEvidence(hunk),
        suggestedCheck: 'Confirm an equivalent or stronger assertion was added elsewhere.',
        confidence: 0.72,
      });
    }
    if (looksLikeSqlStringConcatenation(added)) {
      add({
        id: `review-sql-concat-${hunk.file}`,
        priority: input.focus === 'security' ? 'P0' : 'P1',
        title: 'SQL string concatenation risk',
        why: 'String-built SQL can introduce injection or query escaping bugs.',
        evidence: lineEvidence,
        suggestedCheck: 'Verify parameter binding or safe query builder usage.',
        confidence: 0.7,
      });
    }
  }

  if ((input.focus === 'tests' || Number(input.summary.changedFileCount ?? 0) > 0) && input.testsCount === 0
    && !input.changedFiles.every(isTestPatchFile)) {
    add({
      id: 'review-targeted-validation-required',
      priority: 'P1',
      title: 'Targeted validation is not identified',
      why: 'The review packet could not map this patch to likely test files.',
      suggestedCheck: 'Ask for the smallest command that exercises the changed behavior.',
      confidence: 0.62,
    });
  }

  return findings.sort((a, b) => reviewPriorityRank(a.priority) - reviewPriorityRank(b.priority) || b.confidence - a.confidence);
}

function reviewFocusForPatch(
  focus: ReviewFocus,
  impact: Record<string, unknown>,
  findings: ReviewFinding[],
  maxEvidence = 5,
): Array<Record<string, unknown>> {
  const summary = isPlainObject(impact.summary) ? impact.summary : {};
  const impactedEndpoints = Array.isArray(impact.impactedEndpoints) ? impact.impactedEndpoints as unknown[] : [];
  const tests = Array.isArray(impact.testsLikelyRelevant) ? impact.testsLikelyRelevant as unknown[] : [];
  const focusItems: Array<Record<string, unknown>> = [];
  if (focus !== 'tests') {
    focusItems.push({
      area: 'behavior-impact',
      priority: findings.some(finding => finding.priority === 'P0' || finding.priority === 'P1') ? 'high' : 'normal',
      check: 'Review changed behavior against callers, dependents, and impacted endpoints before reading unrelated files.',
      evidence: compactReviewObject(summary, maxEvidence, 2),
    });
  }
  if (impactedEndpoints.length > 0 || focus === 'api-contract') {
    focusItems.push({
      area: 'api-contract',
      priority: impactedEndpoints.length > 0 ? 'high' : 'normal',
      check: 'Check endpoint compatibility, request/response shape, status codes, and auth assumptions.',
      evidence: compactReviewObject(impactedEndpoints, maxEvidence, 2),
    });
  }
  focusItems.push({
    area: 'tests',
    priority: tests.length > 0 ? 'normal' : 'high',
    check: tests.length > 0 ? 'Run or inspect likely targeted tests first.' : 'Find or request targeted tests before approval.',
    evidence: compactReviewObject(tests, maxEvidence, 2),
  });
  if (focus === 'security' || findings.some(finding => finding.id.includes('secret') || finding.id.includes('sql') || finding.id.includes('command'))) {
    focusItems.push({
      area: 'security',
      priority: 'high',
      check: 'Inspect secret handling, command execution, query construction, and auth-sensitive lines.',
    });
  }
  return focusItems;
}

function reviewToolCalls(
  changedFiles: string[],
  lineFocus: Array<Record<string, unknown>>,
  findings: ReviewFinding[],
  maxCalls = 6,
): Array<Record<string, unknown>> {
  const calls: Array<Record<string, unknown>> = [];
  for (const hunk of lineFocus) {
    if (calls.length >= maxCalls) break;
    const file = stringOrUndefined(hunk.file);
    const lines = stringOrUndefined(hunk.fileSliceLines);
    if (file && lines) calls.push({ tool: 'get_file_slice', args: { file, lines, maxChars: 4000 } });
  }
  if (calls.length === 0 && changedFiles[0]) calls.push({ tool: 'get_file_summary', args: { file: changedFiles[0] } });
  if (calls.length < maxCalls && findings.some(finding => finding.id === 'review-fanout') && changedFiles[0]) {
    calls.push({ tool: 'trace_dependencies', args: { target: changedFiles[0], direction: 'dependents', depth: 2, limit: 100 } });
  }
  return calls.slice(0, maxCalls);
}

function rankPatchHunks(hunks: PatchHunk[]): PatchHunk[] {
  return [...hunks].sort((a, b) => patchHunkRiskScore(b) - patchHunkRiskScore(a)
    || b.addedLines.length + b.removedLines.length - (a.addedLines.length + a.removedLines.length)
    || a.file.localeCompare(b.file)
    || a.newStart - b.newStart);
}

function patchHunkRiskScore(hunk: PatchHunk): number {
  let score = 0;
  const weights: Record<string, number> = {
    security: 100,
    sql: 85,
    endpoint: 75,
    contract: 65,
    'error-handling': 55,
    config: 45,
    'debug-output': 35,
    test: 10,
  };
  for (const kind of hunk.changeKinds) score += weights[kind] ?? 20;
  const added = hunk.addedLines.map(line => line.text).join('\n');
  if (containsSecretLikeAssignment(added)) score += 120;
  if (looksLikeSqlStringConcatenation(added)) score += 90;
  if (/\b(Runtime\.getRuntime\(\)\.exec|new\s+ProcessBuilder|child_process\.exec|shell:\s*true)\b/.test(added)) score += 100;
  score += Math.min(30, hunk.addedLines.length + hunk.removedLines.length);
  return score;
}

function patchDiffStats(hunks: PatchHunk[], diff: string): Record<string, unknown> {
  const files = new Set(hunks.map(hunk => hunk.file).filter(Boolean));
  const addedLineCount = hunks.reduce((sum, hunk) => sum + hunk.addedLines.length, 0);
  const removedLineCount = hunks.reduce((sum, hunk) => sum + hunk.removedLines.length, 0);
  const changedLineCount = addedLineCount + removedLineCount;
  return {
    fileCount: files.size,
    hunkCount: hunks.length,
    addedLineCount,
    removedLineCount,
    changedLineCount,
    diffChars: diff.length,
    scale: changedLineCount >= 100_000 ? 'huge'
      : changedLineCount >= 20_000 ? 'very-large'
        : changedLineCount >= 2_000 ? 'large'
          : changedLineCount >= 500 ? 'medium'
            : 'small',
  };
}

function compactReviewFinding(finding: ReviewFinding, maxEvidence: number): ReviewFinding {
  return {
    ...finding,
    evidence: finding.evidence === undefined ? undefined : compactReviewObject(finding.evidence, maxEvidence, 3),
    why: truncateString(finding.why, 420),
    suggestedCheck: truncateString(finding.suggestedCheck, 320),
  };
}

function compactReviewObject(value: unknown, maxArrayItems: number, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateString(value, 260);
  if (typeof value !== 'object') return value;
  if (depth <= 0) {
    if (Array.isArray(value)) return { omittedCount: value.length };
    return '[object omitted]';
  }
  if (Array.isArray(value)) {
    return value.slice(0, maxArrayItems).map(item => compactReviewObject(item, maxArrayItems, depth - 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(child)) {
      output[key] = child.slice(0, maxArrayItems).map(item => compactReviewObject(item, maxArrayItems, depth - 1));
      if (child.length > maxArrayItems) output[`${key}OmittedCount`] = child.length - maxArrayItems;
    } else {
      output[key] = compactReviewObject(child, maxArrayItems, depth - 1);
    }
  }
  return output;
}

function reviewPlanForPatch(
  diffStats: Record<string, unknown>,
  findings: ReviewFinding[],
  impact: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const scale = String(diffStats.scale ?? 'small');
  const summary = isPlainObject(impact.summary) ? impact.summary : {};
  const plan: Array<Record<string, unknown>> = [];
  plan.push({
    step: 'triage',
    action: 'Read reviewStatus, priorityCounts, changedFiles, and top P0/P1 findings before opening files.',
  });
  if (scale === 'large' || scale === 'very-large' || scale === 'huge') {
    plan.push({
      step: 'batch-by-risk',
      action: 'Review only risky hunks first; defer low-risk formatting/mechanical changes unless tests fail.',
      batchSize: scale === 'huge' ? '10-20 files per pass' : '20-50 files per pass',
    });
  }
  if (findings.some(finding => finding.priority === 'P0' || finding.priority === 'P1')) {
    plan.push({
      step: 'confirm-findings',
      action: 'For each top finding, call only the listed requiredToolCalls or exact file slices; do not scan the whole diff.',
    });
  }
  if (Number(summary.impactedEndpointCount ?? 0) > 0) {
    plan.push({
      step: 'api-contract',
      action: 'Check endpoint compatibility and representative request/response tests before implementation details.',
    });
  }
  plan.push({
    step: 'validation',
    action: 'Report missing targeted tests as a review finding; broad test suites are secondary evidence.',
  });
  return plan;
}

function patchLineMappingFor(hunk: PatchHunk, sourceLines: string[] | undefined): PatchLineMapping {
  if (!sourceLines) {
    return { confidence: 'low', exactSliceSafe: false, reason: 'file content could not be loaded for line mapping validation' };
  }
  const context = hunk.contextLines
    .filter(line => line.text.trim().length > 0)
    .slice(0, 4);
  if (context.length === 0) {
    return { confidence: 'medium', exactSliceSafe: true, reason: 'diff has no non-empty context lines; using hunk new-line numbers' };
  }
  let newMatched = 0;
  let oldMatched = 0;
  for (const line of context) {
    const expected = line.text.trim();
    const actualNew = sourceLines[line.newLine - 1]?.trim();
    const actualOld = sourceLines[line.oldLine - 1]?.trim();
    if (actualNew && actualNew === expected) newMatched++;
    if (actualOld && actualOld === expected) oldMatched++;
  }
  if (newMatched === context.length) {
    return {
      confidence: 'high',
      exactSliceSafe: true,
      reason: 'diff context matches current file at post-patch line numbers',
    };
  }
  if (oldMatched === context.length) {
    const start = Math.max(1, hunk.oldStart - 2);
    const end = Math.max(start, hunk.oldStart + Math.max(hunk.oldLines, 1) + 2);
    return {
      confidence: 'high',
      exactSliceSafe: true,
      fileSliceLines: lineRangeString(start, end),
      reason: 'diff context matches current file at pre-patch line numbers; slice shows surrounding existing code',
    };
  }
  const matched = Math.max(newMatched, oldMatched);
  if (matched > 0) {
    const start = Math.max(1, hunk.oldStart - 2);
    const end = Math.max(start, hunk.oldStart + Math.max(hunk.oldLines, 1) + 2);
    return {
      confidence: 'medium',
      exactSliceSafe: true,
      fileSliceLines: lineRangeString(start, end),
      reason: `partial diff context match (${matched}/${context.length}); verify slice before final review`,
    };
  }
  return {
    confidence: 'low',
    exactSliceSafe: false,
    reason: 'diff context does not match current file at hunk line numbers; use file summary or symbol lookup before exact line comments',
  };
}

function reviewQuestionsForPatch(findings: ReviewFinding[], impact: Record<string, unknown>): string[] {
  const questions: string[] = [];
  if (findings.some(finding => finding.id === 'review-endpoint-contract')) {
    questions.push('Does the patch preserve endpoint compatibility and documented response/error behavior?');
  }
  if (findings.some(finding => finding.id === 'review-missing-tests' || finding.id === 'review-targeted-validation-required')) {
    questions.push('What targeted test or command proves the changed behavior?');
  }
  if (findings.some(finding => finding.id.includes('secret') || finding.id.includes('sql') || finding.id.includes('command'))) {
    questions.push('Can the security-sensitive change be constrained, parameterized, or covered by a negative test?');
  }
  const summary = isPlainObject(impact.summary) ? impact.summary : {};
  if (Number(summary.directDependentCount ?? 0) > 0 || Number(summary.callerCount ?? 0) > 0) {
    questions.push('Have direct dependents and callers been checked for changed assumptions?');
  }
  return questions.slice(0, 6);
}

function reviewStatusFor(findings: ReviewFinding[], changedFiles: string[]): string {
  if (changedFiles.length === 0 || findings.some(finding => finding.priority === 'P0')) return 'blocked';
  if (findings.some(finding => finding.priority === 'P1')) return 'needs-attention';
  return 'ready-for-review';
}

function reviewPriorityCounts(findings: ReviewFinding[]): Record<string, number> {
  return {
    P0: findings.filter(finding => finding.priority === 'P0').length,
    P1: findings.filter(finding => finding.priority === 'P1').length,
    P2: findings.filter(finding => finding.priority === 'P2').length,
  };
}

function reviewConfidence(
  changedFileCount: number,
  hunkCount: number,
  findings: ReviewFinding[],
  riskFlags: Array<Record<string, unknown>>,
): number {
  let confidence = changedFileCount > 0 ? 0.68 : 0.28;
  if (hunkCount > 0) confidence += 0.08;
  if (riskFlags.length > 0) confidence += 0.04;
  if (findings.some(finding => finding.priority === 'P0')) confidence += 0.04;
  return Math.round(Math.max(0.25, Math.min(0.9, confidence)) * 100) / 100;
}

function reviewPriorityRank(priority: ReviewFinding['priority']): number {
  if (priority === 'P0') return 0;
  if (priority === 'P1') return 1;
  return 2;
}

function firstLineEvidence(hunk: PatchHunk): Record<string, unknown> | undefined {
  const line = hunk.addedLines[0];
  if (!line) return undefined;
  return { file: hunk.file, line: line.line, text: line.text };
}

function firstRemovedLineEvidence(hunk: PatchHunk): Record<string, unknown> | undefined {
  const line = hunk.removedLines[0];
  if (!line) return undefined;
  return { file: hunk.file, line: line.line, text: line.text };
}

function containsSecretLikeAssignment(value: string): boolean {
  return /\b(password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)\b\s*[:=]\s*["'][^"']{6,}["']/i.test(value);
}

function looksLikeSqlStringConcatenation(value: string): boolean {
  return /["'`]\s*(select|insert|update|delete)\b[\s\S]{0,160}\+\s*/i.test(value)
    || /\+\s*["'`][\s\S]{0,80}\b(where|and|or|from)\b/i.test(value);
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject);
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
  const basenameWithoutExt = basename.replace(/\.[^.]+$/, '');
  const queryLower = query.toLowerCase();
  const queryIdentifiers = identifierSearchTerms(queryLower);
  const symbols = evidence?.symbols ?? [];
  const endpoints = evidence?.endpoints ?? [];
  const symbolText = symbols.map(symbol => [
    symbol.name,
    symbol.fqName,
    symbol.kind,
    symbol.signature,
    symbol.frameworkRole,
    JSON.stringify(symbol.frameworkMeta ?? {}),
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
  const exactBasenameMatches = tokens.filter(token => token === basenameWithoutExt);
  if (exactBasenameMatches.length > 0) {
    score += 90;
    reason = 'query token exactly matched file basename';
    factors.push('query token exactly matched file basename');
  }
  const basenameParts = basenameWithoutExt.split(/[._-]+/g).filter(Boolean);
  const basenamePartMatches = tokens.filter(token => basenameParts.includes(token));
  if (basenamePartMatches.length > 0) {
    score += 45 * basenamePartMatches.length;
    factors.push(`${basenamePartMatches.length} query tokens matched file basename parts`);
  }
  const identifierPathMatches = queryIdentifiers.filter(identifier => pathLower.includes(identifier));
  if (identifierPathMatches.length > 0) {
    score += 70 * identifierPathMatches.length;
    reason = 'query identifier matched file path segment';
    factors.push(`${identifierPathMatches.length} dotted/dashed query identifiers matched file path`);
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
  if (isMyBatisIntent(query) && symbols.some(isMyBatisLike)) {
    score += 60;
    factors.push('MyBatis mapper/query intent matched MyBatis XML symbols');
  }
  if (isApiSpecQuery(query) && symbols.some(isApiSpecLike)) {
    score += 55;
    factors.push('API spec intent matched indexed API specification symbols');
  }
  if (/\b(docker|compose|container|port|service)\b/i.test(query) && symbols.some(isDockerConfigLike)) {
    score += 45;
    factors.push('Docker/config intent matched docker-compose YAML symbols');
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

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function identifierSearchTerms(query: string): string[] {
  return [...new Set((query.match(/[a-z0-9]+(?:[._-][a-z0-9]+)+/g) ?? [])
    .map(term => term.trim().toLowerCase())
    .filter(term => term.length >= 4))];
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

function isMyBatisIntent(query: string): boolean {
  return /\b(mybatis|mapper|sql|result\s*map|resultmap|mapper\s+xml|xml\s+mapper)\b/i.test(query);
}

function isMyBatisLike(symbol: Record<string, unknown>): boolean {
  return String(symbol.frameworkRole ?? '').startsWith('mybatis:');
}

function isApiSpecLike(symbol: Record<string, unknown>): boolean {
  const role = String(symbol.frameworkRole ?? '');
  return role === 'openapi:endpoint' || role === 'postman:request' || role.startsWith('elastic-rest:');
}

function isApiSpecQuery(query: string): boolean {
  return /\b(openapi|swagger|postman|api\s+doc|api\s+spec|rest\s+api|yaml\s+rest|endpoint)\b/i.test(query);
}

function isDockerConfigLike(symbol: Record<string, unknown>): boolean {
  return String(symbol.frameworkRole ?? '').startsWith('docker:');
}

function symbolDisplayPriority(symbol: Record<string, unknown>): number {
  const role = String(symbol.frameworkRole ?? '');
  const kind = String(symbol.kind ?? '');
  if (role === 'mybatis:mapper-xml') return 110;
  if (/^mybatis:(select|insert|update|delete)$/.test(role)) return 105;
  if (role === 'openapi:endpoint' || role === 'postman:request' || role === 'elastic-rest:endpoint') return 104;
  if (/^elastic-rest:(param|header|yaml-test|yaml-do|yaml-param)$/.test(role)) return 96;
  if (role.startsWith('docker:') || role.startsWith('spring:')) return 90;
  if (role === 'mybatis:resultMap' || role === 'mybatis:sql') return 80;
  if (kind === 'class' || kind === 'interface') return 70;
  if (kind === 'method' || kind === 'function') return 65;
  if (kind === 'type') return 55;
  return 30;
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

function uniqueFilesInOrder(files: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const file of files) {
    if (!file || seen.has(file)) continue;
    seen.add(file);
    result.push(file);
  }
  return result;
}
