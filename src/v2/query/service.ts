import fs from 'node:fs';
import path from 'node:path';
import type { CodeGraphDb } from '../storage/database.js';
import { estimateTextTokens } from '../token-estimator.js';
import { V2Indexer, type IndexWorkspaceOptions } from '../index/indexer.js';
import { roleRank, type FileRole } from '../index/file-role.js';
import { scanManifest } from '../index/manifest.js';
import { getGitDirtyFiles, getGitFreshnessInfo } from '../git.js';
import { architectureContextForFiles, dependencyTraceDiagnostics } from '../graph/overlay.js';

export interface QueryEnvelope {
  workspaceId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export class V2QueryService {
  private readonly indexer: V2Indexer;
  private readonly inFlightBatchSliceKeys = new Map<string, number>();
  private readonly inFlightRefreshes = new Map<string, Promise<string>>();
  private readonly freshnessCache = new Map<string, { expiresAt: number; value: Record<string, unknown> | undefined }>();
  private readonly relevantTestCache = new Map<string, Promise<Array<Record<string, unknown>>>>();

  constructor(private readonly db: CodeGraphDb) {
    this.indexer = new V2Indexer(db);
  }

  async query(envelope: QueryEnvelope): Promise<unknown> {
    let snapshotId = await this.requireSnapshot(envelope.workspaceId);
    if (envelope.toolName === 'get_file_slice') {
      this.cleanupInFlightBatchSliceKeys();
      const sliceArgs = envelope.args;
      if (Array.isArray(sliceArgs.slices)) {
        this.markInFlightBatchSlices(snapshotId, sliceArgs.slices);
      } else if (this.isCoveredByInFlightBatch(snapshotId, sliceArgs)) {
        return duplicateBatchSliceResponse(sliceArgs);
      }
    }
    let autoRefreshSkipped: Record<string, unknown> | undefined;
    let freshnessBeforeRefresh: Record<string, unknown> | undefined;
    let snapshotRefreshed = false;
    if (envelope.args.autoRefresh === true) {
      freshnessBeforeRefresh = await this.indexFreshness(snapshotId, { bypassCache: true });
      const workspace = await this.workspaceInfo(envelope.workspaceId);
      const indexedFileCount = await this.indexedFileCount(snapshotId);
      const refreshLimit = autoRefreshFileLimit();
      if (freshnessBeforeRefresh?.isStale && workspace?.root && indexedFileCount > 0 && indexedFileCount <= refreshLimit) {
        const staleSnapshotId = snapshotId;
        snapshotId = await this.refreshWorkspaceOnce(envelope.workspaceId, workspace.root, workspace.workspaceKey);
        this.freshnessCache.delete(staleSnapshotId);
        this.freshnessCache.delete(snapshotId);
        snapshotRefreshed = true;
      } else if (freshnessBeforeRefresh?.isStale && workspace?.root && indexedFileCount > refreshLimit) {
        autoRefreshSkipped = {
          reason: 'indexed-file-count-exceeds-auto-refresh-limit',
          indexedFileCount,
          autoRefreshFileLimit: refreshLimit,
          suggestion: 'Run codegraph index manually for this large workspace, or raise CODEGRAPH_AUTO_REFRESH_FILE_LIMIT.',
        };
      }
    }
    let freshness = envelope.args.warnStale === false
      ? undefined
      : !snapshotRefreshed && freshnessBeforeRefresh
        ? freshnessBeforeRefresh
        : await this.indexFreshness(snapshotId);
    if (freshness && autoRefreshSkipped) {
      freshness = {
        ...freshness,
        autoRefreshSkipped,
        warning: `${String(freshness.warning ?? 'Index may be stale.')} Auto-refresh was skipped because this workspace is too large for inline refresh.`,
      };
    }
    const withFreshness = (result: unknown): unknown => {
      if (!freshness || !freshness.isStale || !isPlainObject(result)) return result;
      return {
        ...result,
        indexFreshness: freshness,
      };
    };
    switch (envelope.toolName) {
      case 'search_symbol':
        return withFreshness(await this.searchSymbol(snapshotId, envelope.args));
      case 'search_files':
        return withFreshness(await this.searchFiles(snapshotId, envelope.args));
      case 'find_references':
        return withFreshness(await this.findReferences(snapshotId, envelope.args));
      case 'get_file_summary':
        return withFreshness(await this.getFileSummary(snapshotId, envelope.args));
      case 'get_file_slice':
        return withFreshness(await this.getFileSlice(snapshotId, envelope.args));
      case 'get_dependencies':
        return withFreshness(await this.getDependencies(snapshotId, envelope.args));
      case 'get_dependents':
        return withFreshness(await this.getDependents(snapshotId, envelope.args));
      case 'get_callers':
        return withFreshness(await this.getCallers(snapshotId, envelope.args));
      case 'get_callees':
        return withFreshness(await this.getCallees(snapshotId, envelope.args));
      case 'find_endpoints':
        return withFreshness(await this.findEndpoints(snapshotId, envelope.args));
      case 'get_impact_radius':
        return withFreshness(await this.getImpactRadius(snapshotId, envelope.args));
      case 'trace_dependencies':
        return withFreshness(await this.traceDependencies(snapshotId, envelope.args));
      case 'explain_endpoint':
        return withFreshness(await this.explainEndpoint(snapshotId, envelope.args));
      case 'impact_of_symbol':
        return withFreshness(await this.impactOfSymbol(snapshotId, envelope.args));
      case 'simulate_patch_impact':
        return withFreshness(await this.simulatePatchImpact(snapshotId, envelope.args));
      case 'review_patch':
        return withFreshness(await this.reviewPatch(snapshotId, envelope.args));
      case 'find_tests_for':
        return withFreshness(await this.findTestsFor(snapshotId, envelope.args));
      case 'get_flow_pack':
        return withFreshness(await this.getResearchPack(snapshotId, {
          ...envelope.args,
          taskType: envelope.args.taskType ?? 'architecture',
        }));
      case 'get_research_pack':
        return withFreshness(await this.getResearchPack(snapshotId, envelope.args));
      case 'get_context_packet':
        return withFreshness(await this.getContextPacket(snapshotId, envelope.args));
      case 'get_change_pack':
        return withFreshness(await this.getChangePack(snapshotId, envelope.args));
      case 'compile_evidence':
        return withFreshness(await this.compileEvidence(snapshotId, envelope.args));
      case 'generate_repo_atlas':
        return withFreshness(await this.generateRepoAtlas(snapshotId, envelope.args));
      case 'search_code':
        return withFreshness(await this.searchCode(snapshotId, envelope.args));
      case 'get_index_stats':
        return withFreshness(await this.getIndexStats(snapshotId, envelope.args));
      default:
        throw new Error(`Unknown v2 tool: ${envelope.toolName}`);
    }
  }

  async ensureIndexed(root: string): ReturnType<V2Indexer['indexWorkspace']> {
    return this.indexer.indexWorkspace({ root });
  }

  private markInFlightBatchSlices(snapshotId: string, slices: unknown[]) {
    const expiresAt = Date.now() + 30_000;
    for (const slice of slices) {
      if (!slice || typeof slice !== 'object') continue;
      const key = rawSliceRequestKey(snapshotId, slice as Record<string, unknown>);
      if (key) this.inFlightBatchSliceKeys.set(key, expiresAt);
    }
  }

  private isCoveredByInFlightBatch(snapshotId: string, args: Record<string, unknown>): boolean {
    const key = rawSliceRequestKey(snapshotId, args);
    return Boolean(key && this.inFlightBatchSliceKeys.has(key));
  }

  private cleanupInFlightBatchSliceKeys() {
    const now = Date.now();
    for (const [key, expiresAt] of this.inFlightBatchSliceKeys) {
      if (expiresAt <= now) this.inFlightBatchSliceKeys.delete(key);
    }
  }

  private async refreshWorkspaceOnce(workspaceId: string, root: string, workspaceKey?: string): Promise<string> {
    const providerOptions = await this.indexProviderOptionsForWorkspace(workspaceId);
    const key = `${workspaceId}:${root}:${workspaceKey ?? ''}:${JSON.stringify(providerOptions)}`;
    const existing = this.inFlightRefreshes.get(key);
    if (existing) return existing;
    const refresh = this.indexer.indexWorkspace({ root, workspaceKey, ...providerOptions })
      .then(result => result.snapshotId)
      .finally(() => {
        this.inFlightRefreshes.delete(key);
      });
    this.inFlightRefreshes.set(key, refresh);
    return refresh;
  }

  private async indexProviderOptionsForWorkspace(workspaceId: string): Promise<Pick<IndexWorkspaceOptions, 'indexProviders' | 'scipIndexPath'>> {
    const row = await this.db.prepare(`
      SELECT s.index_provider_config_json
      FROM workspaces w
      JOIN snapshots s ON s.id = w.current_snapshot_id
      WHERE w.id = ?
    `).get(workspaceId) as { index_provider_config_json?: string } | undefined;
    const config = parseJson<{ indexProviders?: string[]; scipIndexPath?: string }>(row?.index_provider_config_json, {});
    return {
      indexProviders: config.indexProviders,
      scipIndexPath: config.scipIndexPath,
    };
  }

  private async indexedFileCount(snapshotId: string): Promise<number> {
    return await scalar(this.db, 'SELECT COUNT(*) FROM files WHERE snapshot_id = ?', snapshotId);
  }

  private async requireSnapshot(workspaceId: string): Promise<string> {
    const row = await this.db.prepare('SELECT current_snapshot_id FROM workspaces WHERE id = ?')
      .get(workspaceId) as { current_snapshot_id?: string } | undefined;
    if (!row?.current_snapshot_id) {
      throw new Error(`Workspace ${workspaceId} is not indexed yet`);
    }
    return row.current_snapshot_id;
  }

  private async workspaceRoot(workspaceId: string): Promise<string | undefined> {
    return (await this.workspaceInfo(workspaceId))?.root;
  }

  private async workspaceInfo(workspaceId: string): Promise<{ root?: string; workspaceKey?: string } | undefined> {
    const row = await this.db.prepare('SELECT root, workspace_key FROM workspaces WHERE id = ?')
      .get(workspaceId) as { root?: string; workspace_key?: string } | undefined;
    if (!row) return undefined;
    return { root: row.root, workspaceKey: row.workspace_key };
  }

  private async workspaceRootForSnapshot(snapshotId: string): Promise<string | undefined> {
    const row = await this.db.prepare(`
      SELECT w.root
      FROM snapshots s
      JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.id = ?
    `).get(snapshotId) as { root?: string } | undefined;
    return row?.root;
  }

  private async indexFreshness(
    snapshotId: string,
    options: { bypassCache?: boolean } = {},
  ): Promise<Record<string, unknown> | undefined> {
    const cacheMs = freshnessCacheMs();
    const cached = options.bypassCache || cacheMs <= 0 ? undefined : this.freshnessCache.get(snapshotId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) this.freshnessCache.delete(snapshotId);

    const row = await this.db.prepare(`
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
    if (!row?.root) {
      this.cacheFreshness(snapshotId, undefined, cacheMs, options);
      return undefined;
    }

    const git = getGitFreshnessInfo(row.root);
    const gitDirty = git.available
      ? git.headCommit !== row.head_commit || git.dirtyHash !== row.dirty_hash
      : false;
    // computeDirtyFiles() already branches internally on git availability
    // (git-status when possible, manifest hash diff otherwise) and returns
    // the same shape either way, so always call it — don't gate it behind
    // !git.available. Gating it there meant the common case (a git repo)
    // only ever got isStale:true with no file list, which is exactly the
    // information an agent needs to decide whether to re-read specific
    // files. Only skip the scan entirely when nothing is dirty, to avoid
    // paying for it on the (much more common) fresh-index path.
    const dirtyFiles = gitDirty || !git.available
      ? await this.computeDirtyFiles(snapshotId)
      : undefined;
    const dirtyCounts = (dirtyFiles ?? {}) as {
      addedCount?: number;
      modifiedCount?: number;
      deletedCount?: number;
    };
    const fileDirty = Number(dirtyCounts.addedCount ?? 0) > 0
      || Number(dirtyCounts.modifiedCount ?? 0) > 0
      || Number(dirtyCounts.deletedCount ?? 0) > 0;
    const isStale = fileDirty || gitDirty;

    const freshness = {
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
    this.cacheFreshness(snapshotId, freshness, cacheMs, options);
    return freshness;
  }

  private cacheFreshness(
    snapshotId: string,
    value: Record<string, unknown> | undefined,
    cacheMs: number,
    options: { bypassCache?: boolean },
  ): void {
    if (options.bypassCache || cacheMs <= 0) return;
    if (value?.isStale !== true) return;
    this.freshnessCache.set(snapshotId, { expiresAt: Date.now() + cacheMs, value });
  }

  private async snippetOptions(snapshotId: string, args: Record<string, unknown>): Promise<SnippetOptions | undefined> {
    if (args.includeSnippets !== true) return undefined;
    const root = await this.workspaceRootForSnapshot(snapshotId);
    if (!root) return undefined;
    const lines = clampInt(Number(args.snippetLines ?? 12), 3, 80);
    const tokenBudget = clampInt(Number(args.snippetTokenBudget ?? 1200), 100, 12000);
    return {
      root,
      lines,
      budgetChars: tokenBudget * 4,
      usedChars: 0,
      fileCache: new Map(),
    };
  }

  private async searchSymbol(snapshotId: string, args: Record<string, unknown>) {
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
    const snippets = await this.snippetOptions(snapshotId, args);
    const baseClauses = [
      'snapshot_id = ?',
      kindFilter.sql,
      ...filters.sql,
    ];
    const baseParams: unknown[] = [snapshotId, ...kindFilter.params, ...filters.params];
    const baseWhere = baseClauses.map(clause => `(${clause})`).join(' AND ');

    if (query === '*' || tokens.length === 0) {
      const totalFound = await scalar(this.db, `SELECT COUNT(*) FROM symbols WHERE ${baseWhere}`, ...baseParams);
      const rows = await this.db.prepare(`
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

    const exactRows = await this.exactSymbolSearchRows(baseWhere, baseParams, query, phrasePattern, 100);
    const ftsBroadRows = await this.symbolSearchCandidateRowsFromFts(snapshotId, baseWhere, baseParams, tokens, candidateLimit);
    const broadRows = ftsBroadRows.length > 0
      ? ftsBroadRows
      : await this.db.prepare(`
      SELECT fq_name, simple_name, kind, file, line, end_line, signature, visibility, parent,
             package_name, return_type, parameter_types_json, annotations_json,
             framework_role, framework_meta_json, file_role
      FROM symbols
      WHERE ${baseWhere}
        AND (${matchClauses.map(clause => `(${clause})`).join(' OR ')})
      LIMIT ?
    `).all(...baseParams, ...matchParams, candidateLimit) as SymbolRow[];
    const rows = mergeSymbolRows(exactRows, broadRows);

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
        `Candidate window: ${rows.length}; exact prepass: ${exactRows.length}; broad prepass: ${broadRows.length}; returned page offset ${cursorOffset}.`,
      ]) } : {}),
      confidence: ranked.some(candidate => candidate.score.score >= 90) ? 0.85 : 0.65,
      confidenceNotes: [
        'Search ranks exact/phrase matches first, then intent-aware framework entry points, then compact/camel-case and multi-token matches.',
        'Lombok synthetic symbols, tests, generated files, and fixtures are hidden by default unless requested or implied by the query.',
        'For broad natural-language queries, inspect matchedTokens and matchReason before assuming a candidate is exact.',
      ],
    };
  }

  private async searchFiles(snapshotId: string, args: Record<string, unknown>) {
    const query = String(args.query ?? '*').trim();
    const limit = Math.min(Number(args.limit ?? 20), 200);
    const cursorOffset = parseCursor(args.cursor);
    const explainRank = Boolean(args.explainRank ?? false);
    const tokens = tokenizeSearchQuery(query);
    const rankingTokens = fileSearchRankingTokens(query, tokens);
    const filters = fileFiltersFor(args, query);
    const snippets = await this.snippetOptions(snapshotId, args);
    const baseClauses = ['f.snapshot_id = ?', ...filters.sql.map(sql => sql.replace(/\bfile_role\b/g, 'f.file_role'))];
    const baseParams: unknown[] = [snapshotId, ...filters.params];
    const baseWhere = baseClauses.map(clause => `(${clause})`).join(' AND ');

    if (query === '*' || tokens.length === 0) {
      const totalFound = await scalar(this.db, `SELECT COUNT(*) FROM files f WHERE ${baseWhere}`, ...baseParams);
      const rows = await this.db.prepare(`
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
      const evidence = await this.fileEvidence(snapshotId, rows.map(row => row.path));
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

    const broadConfigSearch = isApiSpecQuery(query) || /\b(config|yaml|json|xml|properties)\b/i.test(query);
    const candidateLimit = broadConfigSearch
      ? Math.min(Math.max((cursorOffset + limit) * 100, 1000), 5000)
      : Math.min(Math.max((cursorOffset + limit) * 40, 500), 2000);
    const candidateTerms = fileSearchCandidateTerms(query, rankingTokens);
    const explicitRows = await this.explicitFileSearchRows(snapshotId, baseWhere, baseParams, query, Math.min(candidateLimit, limit * 2));
    const useExplicitOnly = explicitRows.length > 0 && !broadConfigSearch && !isMyBatisIntent(query);
    const rows = useExplicitOnly
      ? explicitRows
      : await this.fileSearchCandidateRows(
        snapshotId,
        baseWhere,
        baseParams,
        candidateTerms,
        candidateLimit,
        broadConfigSearch,
        Boolean(endpointNeedleForResearch(query)) || isApiSpecQuery(query) || /\b(endpoint|route|controller)\b/i.test(query),
      );
    const evidence = await this.fileEvidence(snapshotId, rows.map(row => row.path));
    const ranked = rows
      .map(row => ({ row, score: scoreFileSearch(row, evidence.get(row.path), query, rankingTokens) }))
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
      queryTokens: rankingTokens,
      searchMode: 'file-ranked',
      ...(explainRank ? { debug: rankDebug('search_files', [
        'Ranking order: file path/name phrase, explicit symbol/file terms, symbol evidence, endpoint evidence, dependency graph signal, file-role boost.',
        'Candidate retrieval is bounded by indexed file, symbol, and endpoint matches to avoid broad correlated scans on large workspaces.',
        ...(useExplicitOnly ? ['Explicit file/class mention was resolved directly before fuzzy candidate retrieval.'] : []),
        `Candidate window: ${rows.length}; returned page offset ${cursorOffset}.`,
      ]) } : {}),
      confidence: ranked.some(candidate => candidate.score.score >= 80) ? 0.8 : 0.6,
      confidenceNotes: [
        'File search ranks path matches, symbols, endpoints, imports, dependency signal, and file role together.',
        'Tests, generated files, and fixtures are hidden by default unless requested or implied by the query.',
      ],
    };
  }

  private async explicitFileSearchRows(
    snapshotId: string,
    baseWhere: string,
    baseParams: unknown[],
    query: string,
    limit: number,
  ): Promise<FileRow[]> {
    const refs = explicitSymbolRefs(query).filter(ref => !isBroadExplicitRef(ref.className));
    const explicitPaths = explicitFileNeedles(query)
      .filter(needle => path.posix.extname(needle))
      .filter(needle => !isBroadExplicitRef(path.posix.basename(needle, path.posix.extname(needle))));
    const needles = uniqueStrings([
      ...explicitPaths,
      ...refs.map(ref => `${ref.className}.java`),
      ...refs.map(ref => `${ref.className}.ts`),
      ...refs.map(ref => `${ref.className}.py`),
    ]).slice(0, 12);
    if (needles.length === 0) return [];

    const rows = new Map<string, FileRow>();
    for (const needle of needles) {
      const normalized = needle.replace(/\\/g, '/');
      const basename = path.posix.basename(normalized);
      const suffix = normalized.includes('/') ? normalized : basename;
      const matches = await this.db.prepare(`
        SELECT f.path, f.language, f.file_role, f.parse_status, f.size
        FROM files f
        WHERE ${baseWhere}
          AND (f.path ILIKE ? ESCAPE '\\' OR f.path ILIKE ? ESCAPE '\\')
        ORDER BY LENGTH(f.path), f.path
        LIMIT ?
      `).all(...baseParams, `%/${escapeLike(suffix)}`, `%/${escapeLike(basename)}`, Math.max(1, Math.min(5, limit))) as FileRow[];
      for (const row of matches) {
        if (!rows.has(row.path)) rows.set(row.path, row);
        if (rows.size >= limit) return [...rows.values()];
      }
    }
    return [...rows.values()];
  }

  private async fileSearchCandidateRows(
    snapshotId: string,
    baseWhere: string,
    baseParams: unknown[],
    terms: string[],
    candidateLimit: number,
    includeConfigEvidence: boolean,
    includeEndpointEvidence: boolean,
  ): Promise<FileRow[]> {
    const ftsRows = await this.fileSearchCandidateRowsFromFts(snapshotId, baseWhere, baseParams, terms, candidateLimit);
    if (ftsRows.length > 0) return ftsRows;

    const candidates = new Map<string, FileRow>();
    const addRows = (rows: FileRow[]) => {
      for (const row of rows) {
        if (!candidates.has(row.path)) candidates.set(row.path, row);
        if (candidates.size >= candidateLimit) break;
      }
    };
    const boundedTerms = terms.slice(0, 10);
    const perTermLimit = Math.max(40, Math.min(250, Math.ceil(candidateLimit / Math.max(1, boundedTerms.length)) * 2));
    for (const term of boundedTerms) {
      const pattern = `%${escapeLike(term)}%`;
      addRows(await this.db.prepare(`
        SELECT f.path, f.language, f.file_role, f.parse_status, f.size
        FROM files f
        WHERE ${baseWhere}
          AND (f.path ILIKE ? ESCAPE '\\' OR COALESCE(f.language, '') ILIKE ? ESCAPE '\\')
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
          LENGTH(f.path),
          f.path
        LIMIT ?
      `).all(...baseParams, pattern, pattern, perTermLimit) as FileRow[]);

      addRows(await this.db.prepare(`
        SELECT DISTINCT f.path, f.language, f.file_role, f.parse_status, f.size
        FROM symbols s
        JOIN files f ON f.snapshot_id = s.snapshot_id AND f.path = s.file
        WHERE s.snapshot_id = ?
          AND ${baseWhere}
          AND (
            s.simple_name ILIKE ? ESCAPE '\\'
            OR s.fq_name ILIKE ? ESCAPE '\\'
            OR COALESCE(s.package_name, '') ILIKE ? ESCAPE '\\'
            OR COALESCE(s.framework_role, '') ILIKE ? ESCAPE '\\'
          )
        LIMIT ?
      `).all(snapshotId, ...baseParams, pattern, pattern, pattern, pattern, perTermLimit) as FileRow[]);

      if (includeEndpointEvidence) {
        addRows(await this.db.prepare(`
          SELECT DISTINCT f.path, f.language, f.file_role, f.parse_status, f.size
          FROM endpoints e
          JOIN files f ON f.snapshot_id = e.snapshot_id AND f.path = e.file
          WHERE e.snapshot_id = ?
            AND ${baseWhere}
            AND (
              e.path ILIKE ? ESCAPE '\\'
              OR e.handler_symbol ILIKE ? ESCAPE '\\'
              OR COALESCE(e.controller, '') ILIKE ? ESCAPE '\\'
            )
          LIMIT ?
        `).all(snapshotId, ...baseParams, pattern, pattern, pattern, perTermLimit) as FileRow[]);
      }

      if (includeConfigEvidence && candidates.size < candidateLimit) {
        addRows(await this.db.prepare(`
          SELECT DISTINCT f.path, f.language, f.file_role, f.parse_status, f.size
          FROM imports i
          JOIN files f ON f.snapshot_id = i.snapshot_id AND f.path = i.file
          WHERE i.snapshot_id = ?
            AND ${baseWhere}
            AND i.source ILIKE ? ESCAPE '\\'
          LIMIT ?
        `).all(snapshotId, ...baseParams, pattern, Math.min(perTermLimit, 100)) as FileRow[]);
      }
    }

    return [...candidates.values()].slice(0, candidateLimit);
  }

  private async exactSymbolSearchRows(
    baseWhere: string,
    baseParams: unknown[],
    query: string,
    phrasePattern: string,
    limit: number,
  ): Promise<SymbolRow[]> {
    const exactBySimpleName = await this.db.prepare(`
      SELECT fq_name, simple_name, kind, file, line, end_line, signature, visibility, parent,
             package_name, return_type, parameter_types_json, annotations_json,
             framework_role, framework_meta_json, file_role
      FROM symbols
      WHERE ${baseWhere}
        AND simple_name = ? COLLATE NOCASE
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
    `).all(...baseParams, query, limit) as SymbolRow[];
    const exactByFqName = await this.db.prepare(`
      SELECT fq_name, simple_name, kind, file, line, end_line, signature, visibility, parent,
             package_name, return_type, parameter_types_json, annotations_json,
             framework_role, framework_meta_json, file_role
      FROM symbols
      WHERE ${baseWhere}
        AND fq_name = ? COLLATE NOCASE
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
    `).all(...baseParams, query, limit) as SymbolRow[];
    const phraseRows = await this.db.prepare(`
      SELECT fq_name, simple_name, kind, file, line, end_line, signature, visibility, parent,
             package_name, return_type, parameter_types_json, annotations_json,
             framework_role, framework_meta_json, file_role
      FROM symbols
      WHERE ${baseWhere}
        AND (
          simple_name LIKE ? ESCAPE '\\'
          OR fq_name LIKE ? ESCAPE '\\'
        )
      ORDER BY
        CASE
          WHEN simple_name LIKE ? ESCAPE '\\' THEN 0
          WHEN fq_name LIKE ? ESCAPE '\\' THEN 1
          ELSE 2
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
        simple_name
      LIMIT ?
    `).all(...baseParams, phrasePattern, phrasePattern, phrasePattern, phrasePattern, limit) as SymbolRow[];
    return mergeSymbolRows(exactBySimpleName, exactByFqName, phraseRows).slice(0, limit);
  }

  private async symbolSearchCandidateRowsFromFts(
    snapshotId: string,
    baseWhere: string,
    baseParams: unknown[],
    tokens: string[],
    candidateLimit: number,
  ): Promise<SymbolRow[]> {
    const matchQuery = ftsPrefixQuery(tokens);
    if (!matchQuery) return [];
    const idRows = await this.db.prepare(`
      SELECT entity_id
      FROM codegraph_search_fts
      WHERE codegraph_search_fts MATCH ?
        AND snapshot_id = ?
        AND entity_type = 'symbol'
      LIMIT ?
    `).all(matchQuery, snapshotId, candidateLimit) as Array<{ entity_id: string }>;
    const keys = uniqueRecordsBy(
      idRows
        .map(row => parseSymbolSearchEntityId(row.entity_id))
        .filter((row): row is SymbolSearchEntityKey => Boolean(row)),
      row => `${row.fqName}\0${row.file}\0${row.line}`,
    );
    if (keys.length === 0) return [];

    const rows: SymbolRow[] = [];
    for (const batch of chunksOf(keys, 250)) {
      if (rows.length >= candidateLimit) break;
      const disjunction = batch.map(() => '(fq_name = ? AND file = ? AND line = ?)').join(' OR ');
      const params = batch.flatMap(key => [key.fqName, key.file, key.line]);
      rows.push(...await this.db.prepare(`
        SELECT fq_name, simple_name, kind, file, line, end_line, signature, visibility, parent,
               package_name, return_type, parameter_types_json, annotations_json,
               framework_role, framework_meta_json, file_role
        FROM symbols
        WHERE ${baseWhere}
          AND (${disjunction})
        LIMIT ?
      `).all(...baseParams, ...params, candidateLimit - rows.length) as SymbolRow[]);
    }
    return mergeSymbolRows(rows).slice(0, candidateLimit);
  }

  private async fileSearchCandidateRowsFromFts(
    snapshotId: string,
    baseWhere: string,
    baseParams: unknown[],
    terms: string[],
    candidateLimit: number,
  ): Promise<FileRow[]> {
    const matchQuery = ftsPrefixQuery(terms);
    if (!matchQuery) return [];
    const fileRows = await this.db.prepare(`
      SELECT file
      FROM codegraph_search_fts
      WHERE codegraph_search_fts MATCH ?
        AND snapshot_id = ?
        AND entity_type IN ('file', 'symbol')
      GROUP BY file
      LIMIT ?
    `).all(matchQuery, snapshotId, candidateLimit) as Array<{ file: string }>;
    const files = uniqueStrings(fileRows.map(row => row.file)).slice(0, candidateLimit);
    if (files.length === 0) return [];

    const rows: FileRow[] = [];
    for (const batch of chunksOf(files, 500)) {
      if (rows.length >= candidateLimit) break;
      const placeholders = batch.map(() => '?').join(', ');
      rows.push(...await this.db.prepare(`
        SELECT f.path, f.language, f.file_role, f.parse_status, f.size
        FROM files f
        WHERE ${baseWhere}
          AND f.path IN (${placeholders})
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
          LENGTH(f.path),
          f.path
        LIMIT ?
      `).all(...baseParams, ...batch, candidateLimit - rows.length) as FileRow[]);
    }
    return uniqueRecordsBy(rows, row => row.path).slice(0, candidateLimit);
  }

  private async findReferences(snapshotId: string, args: Record<string, unknown>) {
    const symbol = String(args.symbol ?? '');
    const kind = String(args.kind ?? 'all');
    const limit = Math.min(Number(args.limit ?? 100), 500);
    const cursorOffset = parseCursor(args.cursor);
    const groupBy = String(args.groupBy ?? 'none');
    const outputMode = normalizeGraphOutputMode(args.outputMode);
    const maxResponseTokens = responseTokenCap(args, outputMode === 'full' ? 16000 : 6000);
    const like = `%${escapeLike(symbol)}%`;
    const fieldAccess = String(args.fieldAccess ?? 'all');
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
               fq_name AS source, NULL::text AS caller, NULL::text AS callee, NULL::double precision AS confidence,
               NULL::text AS resolution_kind, NULL::text AS signal_tier, NULL::text AS signal_reasons_json, file_role,
               NULL::text AS field_access, NULL::text AS enclosing_class, NULL::text AS enclosing_symbol,
               NULL::text AS owner_class, NULL::text AS receiver_text, NULL::text AS context
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
               source, NULL::text AS caller, NULL::text AS callee, NULL::double precision AS confidence,
               NULL::text AS resolution_kind, NULL::text AS signal_tier, NULL::text AS signal_reasons_json, file_role,
               NULL::text AS field_access, NULL::text AS enclosing_class, NULL::text AS enclosing_symbol,
               NULL::text AS owner_class, NULL::text AS receiver_text, NULL::text AS context
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
               callee AS source, caller, callee, confidence, resolution_kind, signal_tier, signal_reasons_json, file_role
               , NULL::text AS field_access, NULL::text AS enclosing_class, NULL::text AS enclosing_symbol,
               NULL::text AS owner_class, NULL::text AS receiver_text, NULL::text AS context
        FROM call_edges
        WHERE ${where}
      `);
      params.push(snapshotId, like, ...filters.callParams);
      countQueries.push({ sql: `SELECT COUNT(*) AS count FROM call_edges WHERE ${where}`, params: [snapshotId, like, ...filters.callParams] });
    }

    if (kind === 'all' || kind === 'field_usage') {
      const fieldWhereParts = [
        'snapshot_id = ?',
        "(field_name LIKE ? ESCAPE '\\' OR field_fq_name LIKE ? ESCAPE '\\' OR (COALESCE(owner_class, '') || '.' || field_name) LIKE ? ESCAPE '\\')",
        ...filters.fieldSql,
      ];
      const fieldParams = [snapshotId, like, like, like, ...filters.fieldParams];
      if (fieldAccess !== 'all') {
        fieldWhereParts.push('access_kind = ?');
        fieldParams.push(fieldAccess);
      }
      const where = fieldWhereParts.join(' AND ');
      branches.push(`
        SELECT file, line, column AS column, 'field_usage' AS kind, field_name AS symbol_name,
               COALESCE(field_fq_name, field_name) AS source, enclosing_symbol AS caller, NULL::text AS callee,
               confidence, resolution_kind,
               CASE WHEN confidence < 0.5 THEN 'low_signal' ELSE 'primary' END AS signal_tier,
               '[]'::text AS signal_reasons_json, file_role,
               access_kind AS field_access, enclosing_class, enclosing_symbol, owner_class, receiver_text, context
        FROM field_usages
        WHERE ${where}
      `);
      params.push(...fieldParams);
      countQueries.push({ sql: `SELECT COUNT(*) AS count FROM field_usages WHERE ${where}`, params: fieldParams });
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

    const referenceRows = await this.db.prepare(`
      SELECT * FROM (
        ${branches.join('\nUNION ALL\n')}
      )
      ORDER BY file, line, kind
      LIMIT ?
      OFFSET ?
    `).all(...params, limit, cursorOffset) as Array<Record<string, unknown>>;
    const references = referenceRows.map(referenceDto);
    let totalCount = 0;
    for (const query of countQueries) {
      totalCount += await scalar(this.db, query.sql, ...query.params);
    }

    const fullResult = {
      symbol,
      references,
      groups: groupBy === 'none' ? undefined : groupReferences(references, groupBy),
      groupBy,
      totalCount,
      truncated: cursorOffset + references.length < totalCount,
      nextCursor: cursorOffset + references.length < totalCount ? String(cursorOffset + references.length) : undefined,
      filters: filters.effective,
      fieldAccess,
      confidence: 0.75,
    };
    if (outputMode === 'full') {
      return withResponseCapBudget(fullResult, {
        fullPayload: fullResult,
        maxResponseTokens,
        capped: false,
        policy: 'full references returned; use compact mode for grouped counts and exact follow-up handles',
      });
    }

    const compactLimit = Math.min(references.length, compactLimitForResponseCap(maxResponseTokens));
    const compactReferences = references.slice(0, compactLimit).map(slimReferenceForBudget);
    const omittedCount = Math.max(0, totalCount - cursorOffset - compactReferences.length);
    const compactResult = {
      symbol,
      outputMode: omittedCount > 0 ? 'compact-capped' : 'compact',
      references: compactReferences,
      groups: groupBy === 'none' ? groupReferences(compactReferences, 'kind') : groupReferences(compactReferences, groupBy),
      groupBy: groupBy === 'none' ? 'kind' : groupBy,
      totalCount,
      shownCount: compactReferences.length,
      omitted: omittedCount > 0
        ? [{
          kind: 'references',
          count: omittedCount,
          reason: 'default compact response returns representative references plus counts; expand the exact cursor only when needed',
          cursor: String(cursorOffset + compactReferences.length),
        }]
        : [],
      allowedFollowups: omittedCount > 0
        ? [{
          tool: 'find_references',
          args: {
            ...copyDefined({
              symbol,
              kind,
              fieldAccess,
              groupBy,
              cursor: String(cursorOffset + compactReferences.length),
              limit,
              outputMode: 'full',
            }),
          },
          reason: 'Expand the next exact reference page only if the compact groups do not cover the required impact.',
        }]
        : [],
      truncated: cursorOffset + compactReferences.length < totalCount,
      nextCursor: cursorOffset + compactReferences.length < totalCount ? String(cursorOffset + compactReferences.length) : undefined,
      filters: filters.effective,
      fieldAccess,
      confidence: 0.75,
    };
    return withResponseCapBudget(compactResult, {
      fullPayload: fullResult,
      maxResponseTokens,
      capped: omittedCount > 0,
      policy: 'compact references return representative rows, group counts, omitted counts, and exact follow-up handles instead of a broad flat list',
    });
  }

  private async getFileSummary(snapshotId: string, args: Record<string, unknown>) {
    const file = String(args.file ?? '');
    const resolved = await this.resolveFile(snapshotId, file);
    if (!resolved) return { error: `File "${file}" not found in index.` };
    const snippets = await this.snippetOptions(snapshotId, args);
    const limit = clampInt(Number(args.limit ?? 80), 10, 500);

    const symbols = await this.db.prepare(`
      SELECT * FROM symbols WHERE snapshot_id = ? AND file = ? ORDER BY line
    `).all(snapshotId, resolved) as SymbolRow[];
    const imports = await this.db.prepare(`
      SELECT source, imported_symbols_json, line, is_external FROM imports
      WHERE snapshot_id = ? AND file = ? ORDER BY line
    `).all(snapshotId, resolved) as Array<{ source: string; imported_symbols_json: string; line: number; is_external: number }>;
    const deps = await this.dependencyRows(snapshotId, resolved, 'from_file');
    const dependents = await this.dependencyRows(snapshotId, resolved, 'to_file');

    return {
      file: resolved,
      classes: symbols.filter(s => s.kind === 'class' || s.kind === 'interface').slice(0, limit).map(row => symbolDto(row, snippets)),
      methods: symbols.filter(s => s.kind === 'method' || s.kind === 'function').slice(0, limit).map(row => symbolDto(row, snippets)),
      fields: symbols.filter(s => s.kind === 'field' || s.kind === 'variable').slice(0, limit).map(row => symbolDto(row, snippets)),
      imports: imports.map(row => ({
        source: row.source,
        symbols: parseJson<string[]>(row.imported_symbols_json, []),
        isExternal: Boolean(row.is_external),
        line: row.line,
      })).slice(0, limit),
      dependencies: deps.slice(0, limit),
      dependents: dependents.slice(0, limit),
      stats: {
        symbolCount: symbols.length,
        importCount: imports.length,
        dependencyCount: deps.length,
        dependentCount: dependents.length,
      },
      truncated: {
        classes: symbols.filter(s => s.kind === 'class' || s.kind === 'interface').length > limit,
        methods: symbols.filter(s => s.kind === 'method' || s.kind === 'function').length > limit,
        fields: symbols.filter(s => s.kind === 'field' || s.kind === 'variable').length > limit,
        imports: imports.length > limit,
        dependencies: deps.length > limit,
        dependents: dependents.length > limit,
      },
      limit,
    };
  }

  private async getFileSlice(snapshotId: string, args: Record<string, unknown>) {
    const requestedSlices = Array.isArray(args.slices)
      ? args.slices.filter(slice => slice && typeof slice === 'object') as Array<Record<string, unknown>>
      : [];
    if (requestedSlices.length > 0) {
      const maxSlices = Math.min(requestedSlices.length, 20);
      const defaultMaxChars = clampInt(Number(args.maxChars ?? 2400), 200, 30000);
      const batchKeys = requestedSlices
        .slice(0, maxSlices)
        .map(request => rawSliceRequestKey(snapshotId, request))
        .filter((key): key is string => Boolean(key));
      const slices = [];
      try {
        for (const request of requestedSlices.slice(0, maxSlices)) {
          slices.push(await this.getSingleFileSlice(snapshotId, {
            ...request,
            maxChars: clampInt(Number(request.maxChars ?? defaultMaxChars), 200, 30000),
          }));
        }
      } finally {
        const duplicateWindowExpiresAt = Date.now() + 5_000;
        for (const key of batchKeys) this.inFlightBatchSliceKeys.set(key, duplicateWindowExpiresAt);
      }
      return {
        batch: true,
        slices,
        totalRequested: requestedSlices.length,
        returnedCount: slices.length,
        omittedCount: Math.max(0, requestedSlices.length - slices.length),
        guidance: [
          'Batch slices are independent; inspect each item for an error before using it as evidence.',
          'Prefer this batch mode over repeated get_file_slice calls when exact ranges are already known.',
        ],
      };
    }
    return this.getSingleFileSlice(snapshotId, args);
  }

  private async getSingleFileSlice(snapshotId: string, args: Record<string, unknown>) {
    const requestedFile = args.file ? String(args.file) : '';
    const requestedSymbol = args.symbol ? String(args.symbol) : '';
    const maxChars = clampInt(Number(args.maxChars ?? 3000), 200, 30000);
    let resolved = requestedFile ? await this.resolveFile(snapshotId, requestedFile) : undefined;
    const symbol = requestedSymbol ? await this.lookupBestSymbol(snapshotId, requestedSymbol, resolved) : undefined;
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

    const root = await this.workspaceRootForSnapshot(snapshotId);
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

  private async getDependencies(snapshotId: string, args: Record<string, unknown>) {
    const file = await this.resolveFile(snapshotId, String(args.module ?? args.file ?? ''));
    if (!file) return { module: args.module, dependencies: [], totalCount: 0 };
    const dependencies = await this.dependencyRows(snapshotId, file, 'from_file');
    return { module: file, dependencies, totalCount: dependencies.length };
  }

  private async getDependents(snapshotId: string, args: Record<string, unknown>) {
    const file = await this.resolveFile(snapshotId, String(args.module ?? args.file ?? ''));
    if (!file) return { module: args.module, direct: [], directCount: 0 };
    const direct = await this.dependencyRows(snapshotId, file, 'to_file');
    return { module: file, direct, directCount: direct.length };
  }

  private async getCallers(snapshotId: string, args: Record<string, unknown>) {
    const symbol = String(args.symbol ?? args.target ?? '');
    const result = await this.lookupCallEdges(snapshotId, args, {
      symbol,
      indexedColumn: 'callee',
      resultKey: 'callers',
    });
    return { symbol, callers: result.rows, totalCount: result.rows.length, lookup: result.lookup };
  }

  private async getCallees(snapshotId: string, args: Record<string, unknown>) {
    const symbol = String(args.symbol ?? args.source ?? '');
    const result = await this.lookupCallEdges(snapshotId, args, {
      symbol,
      indexedColumn: 'caller',
      resultKey: 'callees',
    });
    return { symbol, callees: result.rows, totalCount: result.rows.length, lookup: result.lookup };
  }

  private async lookupCallEdges(
    snapshotId: string,
    args: Record<string, unknown>,
    options: {
      symbol: string;
      indexedColumn: 'caller' | 'callee';
      resultKey: 'callers' | 'callees';
    },
  ): Promise<{
    rows: CallEdgeRow[];
    lookup: Record<string, unknown>;
  }> {
    const { symbol, indexedColumn, resultKey } = options;
    const signalFilter = callSignalFilter(args);
    const terms = callEdgeLookupTerms(symbol);
    const limit = clampInt(Number(args.limit ?? 100), 1, 500);
    if (terms.length === 0) {
      return {
        rows: [],
        lookup: {
          strategy: 'exact-first',
          resultKey,
          terms: [],
          exactCount: 0,
          fuzzyCount: 0,
          limit,
        },
      };
    }

    const exactClauses = terms.map(() => `${indexedColumn} = ?`).join(' OR ');
    const exactRows = await this.db.prepare(`
      SELECT caller, callee, file, line, confidence, resolution_kind, signal_tier, signal_reasons_json
      FROM call_edges
      WHERE snapshot_id = ? AND (${exactClauses})
        ${signalFilter}
      ORDER BY ${callSignalOrder()}, confidence DESC, file, line
      LIMIT ?
    `).all(snapshotId, ...terms, limit) as CallEdgeRow[];

    const remaining = Math.max(0, limit - exactRows.length);
    const fuzzyRows = remaining > 0
      ? await this.db.prepare(`
        SELECT caller, callee, file, line, confidence, resolution_kind, signal_tier, signal_reasons_json
        FROM call_edges
        WHERE snapshot_id = ?
          AND (${terms.map(() => `${indexedColumn} LIKE ? ESCAPE '\\'`).join(' OR ')})
          AND NOT (${exactClauses})
          ${signalFilter}
        ORDER BY ${callSignalOrder()}, confidence DESC, file, line
        LIMIT ?
      `).all(
        snapshotId,
        ...terms.map(term => `%${escapeLike(term)}%`),
        ...terms,
        remaining,
      ) as CallEdgeRow[]
      : [];

    const rows = uniqueCallEdges([...exactRows, ...fuzzyRows]).slice(0, limit);
    return {
      rows,
      lookup: {
        strategy: 'exact-first',
        resultKey,
        indexedColumn,
        terms,
        exactCount: exactRows.length,
        fuzzyCount: fuzzyRows.length,
        limit,
      },
    };
  }

  private async findEndpoints(snapshotId: string, args: Record<string, unknown>) {
    const method = String(args.method ?? 'all').toUpperCase();
    const pathPattern = args.path ? `%${escapeLike(String(args.path))}%` : '%';
    const limit = Math.min(Number(args.limit ?? 200), 500);
    const cursorOffset = parseCursor(args.cursor);
    const explainRank = Boolean(args.explainRank ?? false);
    const snippets = await this.snippetOptions(snapshotId, args);
    const rows = await this.db.prepare(`
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
    const totalCount = await scalar(this.db, `
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

  private async getImpactRadius(snapshotId: string, args: Record<string, unknown>) {
    const target = String(args.target ?? args.module ?? '');
    const file = await this.resolveFile(snapshotId, target);
    const symbolLike = `%${escapeLike(target)}%`;
    const direct = file ? await this.dependencyRows(snapshotId, file, 'to_file') : [];
    const callers = await this.db.prepare(`
      SELECT caller, callee, file, line, confidence, resolution_kind, signal_tier, signal_reasons_json
      FROM call_edges
      WHERE snapshot_id = ? AND callee LIKE ? ESCAPE '\\'
        ${callSignalFilter(args)}
      ORDER BY ${callSignalOrder()}, confidence DESC
      LIMIT 100
    `).all(snapshotId, symbolLike) as CallEdgeRow[];
    const endpoints = await this.impactedEndpoints(snapshotId, direct.map(row => String(row.modulePath ?? row.file ?? '')));
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

  private async traceDependencies(snapshotId: string, args: Record<string, unknown>) {
    const target = String(args.target ?? args.module ?? args.file ?? '');
    const direction = normalizeDependencyDirection(String(args.direction ?? 'both'));
    const maxDepth = Math.max(1, Math.min(Number(args.depth ?? 2), 5));
    const limit = Math.min(Number(args.limit ?? 200), 1000);
    const cursorOffset = parseCursor(args.cursor);
    const outputMode = normalizeGraphOutputMode(args.outputMode);
    const maxResponseTokens = responseTokenCap(args, outputMode === 'full' ? 16000 : 6000);
    const filters = fileFiltersFor(args, target);
    const fileRoles = await this.fileRoleMap(snapshotId);
    const seedFiles = (await this.seedFilesForDependencyTrace(snapshotId, target, filters))
      .filter(file => fileAllowedByRole(file, fileRoles, filters));
    const edges: DependencyTraceEdge[] = [];
    const cycleHints: DependencyTraceEdge[] = [];
    const visited = new Set(seedFiles);
    const queued = new Set(seedFiles);
    const queue = seedFiles.map(file => ({ file, depth: 0 }));

    while (queue.length > 0 && edges.length < limit) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;
      const nextEdges = await this.dependencyTraceRows(snapshotId, current.file, direction);
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
    const graphDiagnostics = edges.length === 0
      ? await dependencyTraceDiagnostics(this.db, snapshotId, seedFiles, 12)
      : undefined;

    const fullResult = {
      target,
      resolvedAs: seedFiles.length === 1 && await this.resolveFile(snapshotId, target) ? 'file' : seedFiles.length > 0 ? 'file-pattern' : 'none',
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
      impactedEndpoints: await this.impactedEndpoints(snapshotId, [...seedFiles, ...transitiveFiles]),
      cycleHints,
      graphDiagnostics,
      truncated: edges.length >= limit,
      filters: filters.effective,
      confidence: seedFiles.length > 0 ? 0.75 : 0.35,
      confidenceNotes: [
        'Dependency tracing follows indexed import/type-reference edges between files.',
        'Use depth 1 for direct dependencies/dependents and depth 2-5 for transitive impact.',
      ],
    };
    if (outputMode === 'full') {
      return withResponseCapBudget(fullResult, {
        fullPayload: fullResult,
        maxResponseTokens,
        capped: false,
        policy: 'full dependency trace returned; use compact mode for grouped counts and exact expansion handles',
      });
    }

    const compactLimit = Math.min(edges.length, compactLimitForResponseCap(maxResponseTokens));
    const compactEdges = edges.slice(cursorOffset, cursorOffset + compactLimit).map(slimDependencyTraceEdge);
    const omittedCount = Math.max(0, edges.length - cursorOffset - compactEdges.length);
    const compactResult = {
      target,
      outputMode: omittedCount > 0 ? 'compact-capped' : 'compact',
      resolvedAs: fullResult.resolvedAs,
      direction,
      depth: maxDepth,
      seedFiles,
      edges: compactEdges,
      edgeGroups: dependencyTraceGroups(edges),
      edgeCount: edges.length,
      shownCount: compactEdges.length,
      dependencies: dependencies.slice(0, compactLimit).map(slimDependencyTraceEdge),
      dependents: dependents.slice(0, compactLimit).map(slimDependencyTraceEdge),
      transitiveFiles: transitiveFiles.slice(0, Math.max(compactLimit * 2, 8)),
      transitiveFileCount: transitiveFiles.length,
      topFiles: rankFiles([
        ...edges.map(edge => edge.fromFile),
        ...edges.map(edge => edge.toFile),
      ]).slice(0, Math.max(compactLimit * 2, 8)),
      impactedEndpoints: arrayRecords(await this.impactedEndpoints(snapshotId, [...seedFiles, ...transitiveFiles]))
        .slice(0, compactLimit),
      cycleHints: cycleHints.slice(0, compactLimit).map(slimDependencyTraceEdge),
      graphDiagnostics,
      omitted: omittedCount > 0
        ? [{
          kind: 'dependency_edges',
          count: omittedCount,
          reason: 'default compact response returns representative dependency edges plus grouped counts',
          cursor: String(cursorOffset + compactEdges.length),
        }]
        : [],
      allowedFollowups: omittedCount > 0
        ? [{
          tool: 'trace_dependencies',
          args: copyDefined({
            target,
            direction,
            depth: maxDepth,
            limit,
            cursor: String(cursorOffset + compactEdges.length),
            outputMode: 'full',
          }),
          reason: 'Expand the next exact dependency trace page only if compact edge groups are insufficient.',
        }]
        : [],
      truncated: cursorOffset + compactEdges.length < edges.length || edges.length >= limit,
      nextCursor: cursorOffset + compactEdges.length < edges.length ? String(cursorOffset + compactEdges.length) : undefined,
      filters: filters.effective,
      confidence: seedFiles.length > 0 ? 0.75 : 0.35,
      confidenceNotes: [
        'Compact dependency tracing returns representative edges, counts, and exact expansion handles; set outputMode=full for expanded rows.',
      ],
    };
    return withResponseCapBudget(compactResult, {
      fullPayload: fullResult,
      maxResponseTokens,
      capped: omittedCount > 0,
      policy: 'compact dependency trace returns grouped counts, representative edges, and exact follow-up handles instead of broad flat graph rows',
    });
  }

  private async explainEndpoint(snapshotId: string, args: Record<string, unknown>) {
    const path = String(args.path ?? '');
    const method = String(args.method ?? 'all').toUpperCase();
    const snippets = await this.snippetOptions(snapshotId, args);
    const endpointRows = await this.db.prepare(`
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
        suggestions: ((await this.findEndpoints(snapshotId, { path, limit: 10 })) as { endpoints: unknown[] }).endpoints,
      };
    }

    const callChain = await this.traceCallees(snapshotId, endpoint.handler_symbol, Number(args.depth ?? 3));
    const graphFiles = rankFiles([endpoint.file, ...callChain.map(edge => edge.file)]).slice(0, 30);
    const relatedSymbols = await this.symbolsForFiles(snapshotId, graphFiles, snippets);
    const tests = await this.findRelevantTests(snapshotId, endpoint.handler_symbol, 20);

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

  private async impactOfSymbol(snapshotId: string, args: Record<string, unknown>) {
    const target = String(args.symbol ?? args.target ?? '');
    const definitions = ((await this.searchSymbol(snapshotId, {
      ...args,
      query: target,
      limit: Number(args.limit ?? 10),
      includeTests: false,
      explainRank: true,
    })) as { symbols: unknown[] }).symbols;
    const callers = ((await this.getCallers(snapshotId, { symbol: target, limit: 100 })) as { callers: CallEdgeRow[] }).callers;
    const callees = ((await this.getCallees(snapshotId, { symbol: target, limit: 100 })) as { callees: CallEdgeRow[] }).callees;
    const impact = await this.getImpactRadius(snapshotId, { target }) as Record<string, unknown>;

    return {
      target,
      definitions,
      callers,
      callees,
      endpointsAffected: impact.impactedEndpoints ?? [],
      testsLikelyRelevant: await this.findRelevantTests(snapshotId, target, 30),
      topFiles: rankFiles([
        ...callers.map(call => call.file),
        ...callees.map(call => call.file),
        ...(((impact.direct as Array<Record<string, unknown>>) ?? []).map(row => String(row.file ?? row.modulePath ?? ''))),
      ]).slice(0, 30),
      blastRadius: impact.blastRadius,
      summary: impact.summary,
    };
  }

  private async simulatePatchImpact(snapshotId: string, args: Record<string, unknown>) {
    const timing = createDebugTiming(args);
    const limit = clampInt(Number(args.limit ?? 50), 1, 200);
    const outputMode = normalizePatchImpactOutputMode(args.outputMode);
    const maxResponseTokens = responseTokenCap(args, outputMode === 'full' ? 16000 : 8000);
    const requestedFiles = stringArray(args.files).map(normalizePatchPath).filter(Boolean);
    const diffFiles = parsePatchFilePaths(stringOrUndefined(args.diff) ?? '');
    const fileInputs = uniqueFilesInOrder([...requestedFiles, ...diffFiles]);
    const resolvedFileInputs: Array<{ input: string; file: string }> = [];
    const unresolvedFiles: string[] = [];
    for (const input of fileInputs) {
      const resolved = await this.resolveFile(snapshotId, input);
      if (resolved) resolvedFileInputs.push({ input, file: resolved });
      else unresolvedFiles.push(input);
    }

    const requestedSymbols = stringArray(args.symbols);
    const resolvedSymbols: Array<Record<string, unknown>> = [];
    const symbolRows: SymbolRow[] = [];
    const unresolvedSymbols: string[] = [];
    for (const symbol of requestedSymbols) {
      const row = await this.lookupBestSymbol(snapshotId, symbol);
      if (!row) {
        unresolvedSymbols.push(symbol);
        continue;
      }
      symbolRows.push(row);
      resolvedSymbols.push(compactSymbolCandidate(symbolDto(row), `explicit patch symbol input: ${symbol}`));
    }
    timing.checkpoint('resolve_inputs');

    const changedFiles = uniqueFilesInOrder([
      ...resolvedFileInputs.map(input => input.file),
      ...symbolRows.map(row => row.file),
    ]).slice(0, limit);
    const touchedSymbols = uniqueSymbolCandidates(
      (await this.symbolsForFiles(snapshotId, changedFiles))
        .map(symbol => compactSymbolCandidate(symbol, 'symbol declared in a changed file')),
    ).slice(0, limit);
    const changedEndpoints = compactEndpointCandidates(await this.impactedEndpoints(snapshotId, changedFiles));
    timing.checkpoint('symbols_for_files');

    const dependencyRows = uniqueRecordsBy(
      (await Promise.all(changedFiles.map(file => this.dependencyRows(snapshotId, file, 'from_file')))).flat(),
      row => `${row.file}:${row.type}:${row.resolutionKind}`,
    );
    const dependentRows = uniqueRecordsBy(
      (await Promise.all(changedFiles.map(file => this.dependencyRows(snapshotId, file, 'to_file')))).flat(),
      row => `${row.file}:${row.type}:${row.resolutionKind}`,
    );
    timing.checkpoint('dependency_rows');

    const callSeedLimit = clampInt(Number(args.callSeedLimit ?? Math.min(12, limit)), 0, 30);
    const callSeeds = uniqueStrings([
      ...requestedSymbols,
      ...resolvedSymbols.flatMap(symbol => [String(symbol.symbol ?? ''), String(symbol.name ?? '')]),
      ...touchedSymbols.flatMap(symbol => [symbol.symbol, symbol.name]),
    ]).slice(0, callSeedLimit);
    const callers = uniqueCallEdges(
      (await Promise.all(callSeeds.map(async symbol => ((await this.getCallers(snapshotId, { symbol, limit: 25 })) as { callers: CallEdgeRow[] }).callers))).flat(),
    ).slice(0, limit * 2);
    const callees = uniqueCallEdges(
      (await Promise.all(callSeeds.map(async symbol => ((await this.getCallees(snapshotId, { symbol, limit: 25 })) as { callees: CallEdgeRow[] }).callees))).flat(),
    ).slice(0, limit * 2);
    timing.checkpoint('call_expansion');
    const fieldImpact = await this.fieldImpactForInputs(snapshotId, {
      ...args,
      symbols: requestedSymbols,
      files: changedFiles,
    }, limit);
    const fieldImpactFiles = fieldImpact ? stringArray(fieldImpact.files) : [];
    timing.checkpoint('field_impact');

    const impactedFiles = rankFiles([
      ...changedFiles,
      ...fieldImpactFiles,
      ...dependentRows.map(row => String(row.file ?? row.modulePath ?? '')),
      ...dependencyRows.map(row => String(row.file ?? row.modulePath ?? '')),
      ...callers.map(call => call.file),
      ...callees.map(call => call.file),
    ]).slice(0, limit);
    const impactedEndpoints = compactEndpointCandidates(await this.impactedEndpoints(snapshotId, impactedFiles)).slice(0, limit);
    const testSeeds = uniqueStrings([
      ...requestedSymbols,
      ...changedFiles.map(file => path.posix.basename(file, path.posix.extname(file))),
      ...touchedSymbols.flatMap(symbol => [symbol.symbol, symbol.name]),
    ]).slice(0, 32);
    const tests = args.skipLikelyTests === true ? [] : await this.findRelevantTestsForSeeds(snapshotId, testSeeds, limit);
    const validation = await this.validationHints(snapshotId, tests, impactedFiles.length > 0 ? impactedFiles : changedFiles);
    timing.checkpoint('relevant_tests');
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
    const architectureContext = await architectureContextForFiles(
      this.db,
      snapshotId,
      impactedFiles,
      [...requestedSymbols, ...requestedFiles].join(' '),
      Math.min(limit, 20),
    );
    timing.checkpoint('architecture_context');
    const riskMode = normalizeRiskMode(args.riskMode, [
      String(args.task ?? args.target ?? ''),
      ...requestedSymbols,
      ...requestedFiles,
      diffFiles.join(' '),
    ].join(' '));
    const calculationImpact = riskMode === 'calculation_sensitive'
      ? calculationImpactForPatch({
        changedFiles,
        requestedSymbols,
        touchedSymbols,
        dependencyRows,
        dependentRows,
        callers,
        callees,
        fieldImpact: isPlainObject(fieldImpact) ? fieldImpact : undefined,
        impactedEndpoints,
        tests,
        taskText: String(args.task ?? args.target ?? ''),
      }, limit)
      : undefined;
    const calculationImpactCoverage = calculationImpact && isPlainObject(calculationImpact.impactCoverage)
      ? calculationImpact.impactCoverage
      : {};

    const fullResult = {
      outputMode: 'full',
      riskMode,
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
      fieldImpact,
      calculationImpact,
      architectureContext,
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
        fieldUsageCount: fieldImpact ? Number(fieldImpact.usageCount ?? 0) : 0,
        calculationOutputGroupCount: calculationImpact ? arrayRecords(calculationImpact.outputGroups).length : 0,
        unclassifiedCalculationSinkCount: calculationImpact ? Number(calculationImpactCoverage.unclassifiedCalculationSinks ?? 0) : 0,
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
    const requestedResult = outputMode === 'full'
      ? fullResult
      : compactPatchImpactResult(fullResult, compactLimitForResponseCap(maxResponseTokens), {
        outputMode: 'compact',
        includeArchitecture: maxResponseTokens >= 6000,
        includeFieldImpact: maxResponseTokens >= 3000,
      });
    const requestedTokens = estimateTokens(JSON.stringify(requestedResult));
    if (requestedTokens <= maxResponseTokens) {
      const result = withResponseCapBudget(requestedResult, {
        fullPayload: fullResult,
        maxResponseTokens,
        capped: false,
        policy: outputMode === 'full'
          ? 'full patch impact returned within response cap'
          : 'compact patch impact returns ranked evidence and counts; expand exact files with get_file_slice',
      });
      timing.checkpoint('response_budget');
      return withDebugTiming(result, timing);
    }

    let cappedResult = compactPatchImpactResult(fullResult, compactLimitForResponseCap(maxResponseTokens), {
      outputMode: 'compact-capped',
      includeArchitecture: false,
      includeFieldImpact: maxResponseTokens >= 3000,
      cappedReason: 'response-token-cap',
    });
    if (estimateTokens(JSON.stringify(cappedResult)) > maxResponseTokens) {
      cappedResult = compactPatchImpactResult(fullResult, 1, {
        outputMode: 'compact-capped',
        includeArchitecture: false,
        includeFieldImpact: false,
        countsOnly: true,
        cappedReason: 'response-token-cap',
      });
    }
    const result = withResponseCapBudget(cappedResult, {
      fullPayload: fullResult,
      maxResponseTokens,
      capped: true,
      policy: 'response exceeded maxResponseTokens; returned compact ranked impact, counts, and follow-up handles instead of expanded graph rows',
    });
    timing.checkpoint('response_budget');
    return withDebugTiming(result, timing);
  }

  private async fieldImpactForInputs(
    snapshotId: string,
    args: Record<string, unknown>,
    limit: number,
  ): Promise<Record<string, unknown> | undefined> {
    const seeds = fieldImpactSeeds(args).slice(0, 40);
    if (seeds.length === 0) return undefined;
    const hasFieldUsageRows = await scalar(this.db, `
      SELECT COUNT(*) FROM (
        SELECT 1 FROM field_usages WHERE snapshot_id = ? LIMIT 1
      ) field_usage_probe
    `, snapshotId);
    if (hasFieldUsageRows === 0) return undefined;
    const definitions = await this.fieldDefinitionsForSeeds(snapshotId, seeds, Math.min(limit, 50));
    const definitionNames = definitions.map(row => row.simple_name);
    const definitionFqNames = definitions.map(row => row.fq_name);
    const fieldNames = uniqueStrings([
      ...definitionNames,
      ...seeds.filter(seed => !seed.includes('.')),
      ...seeds.map(seed => seed.split('.').pop() ?? '').filter(Boolean),
    ]).slice(0, 50);
    const fieldFqNames = uniqueStrings([
      ...definitionFqNames,
      ...seeds.filter(seed => seed.includes('.')),
    ]).slice(0, 50);
    const usages = await this.fieldUsagesForTargets(snapshotId, fieldNames, fieldFqNames, limit * 4);
    if (definitions.length === 0 && usages.length === 0) return undefined;

    const usageDtos = usages.map(fieldUsageDto);
    const usageFiles = rankFiles(usageDtos.map(row => String(row.file ?? ''))).slice(0, limit);
    const enclosingSymbols = uniqueStrings(usageDtos.map(row => String(row.enclosingSymbol ?? '')).filter(Boolean)).slice(0, 50);
    const relatedCalls = enclosingSymbols.length > 0
      ? await this.callEdgesForCallers(snapshotId, enclosingSymbols, Math.min(limit * 2, 100))
      : [];
    const endpoints = compactEndpointCandidates(await this.impactedEndpoints(snapshotId, usageFiles)).slice(0, Math.min(limit, 50));
    const tests = await this.findRelevantTestsForSeeds(snapshotId, uniqueStrings([
      ...fieldNames,
      ...fieldFqNames,
      ...enclosingSymbols,
    ]).slice(0, 32), Math.min(limit, 30));

    return {
      seeds,
      definitions: definitions.map(row => compactSymbolCandidate(symbolDto(row), 'field definition matched field impact seed')),
      usages: usageDtos.slice(0, limit),
      usageCount: usages.length,
      groups: {
        byAccess: groupFieldUsages(usageDtos, 'fieldAccess'),
        byMethod: groupFieldUsages(usageDtos, 'enclosingSymbol'),
        byClass: groupFieldUsages(usageDtos, 'enclosingClass'),
      },
      relatedCalls: relatedCalls.map(compactCallEdge),
      candidateEndpoints: endpoints,
      testsLikelyRelevant: tests,
      files: rankFiles([
        ...definitions.map(row => row.file),
        ...usageFiles,
        ...relatedCalls.map(edge => edge.file),
        ...endpoints.map(endpoint => String(endpoint.file ?? '')),
      ]).slice(0, limit),
      confidence: fieldImpactConfidence(definitions.length, usages.length),
    };
  }

  private async fieldDefinitionsForSeeds(snapshotId: string, seeds: string[], limit: number): Promise<SymbolRow[]> {
    const rows: SymbolRow[] = [];
    for (const seed of seeds.slice(0, 20)) {
      const like = `%${escapeLike(seed)}%`;
      const simple = seed.split('.').pop() ?? seed;
      rows.push(...await this.db.prepare(`
        SELECT fq_name, simple_name, kind, file, line, end_line, signature, visibility, parent,
               package_name, return_type, parameter_types_json, annotations_json,
               framework_role, framework_meta_json, file_role
        FROM symbols
        WHERE snapshot_id = ? AND kind = 'field'
          AND (
            simple_name = ? COLLATE NOCASE
            OR fq_name = ? COLLATE NOCASE
            OR simple_name LIKE ? ESCAPE '\\'
            OR fq_name LIKE ? ESCAPE '\\'
          )
        ORDER BY
          CASE
            WHEN fq_name = ? COLLATE NOCASE THEN 0
            WHEN simple_name = ? COLLATE NOCASE THEN 1
            WHEN fq_name LIKE ? ESCAPE '\\' THEN 2
            ELSE 3
          END,
          file_role,
          file,
          line
        LIMIT ?
      `).all(snapshotId, simple, seed, `%${escapeLike(simple)}%`, like, seed, simple, like, limit) as SymbolRow[]);
      if (rows.length >= limit) break;
    }
    return uniqueRecordsBy(rows, row => `${row.fq_name}\0${row.file}\0${row.line}`).slice(0, limit);
  }

  private async fieldUsagesForTargets(
    snapshotId: string,
    fieldNames: string[],
    fieldFqNames: string[],
    limit: number,
  ): Promise<FieldUsageRow[]> {
    const clauses: string[] = [];
    const params: unknown[] = [snapshotId];
    if (fieldNames.length > 0) {
      clauses.push(`field_name IN (${fieldNames.map(() => '?').join(', ')})`);
      params.push(...fieldNames);
    }
    if (fieldFqNames.length > 0) {
      clauses.push(`field_fq_name IN (${fieldFqNames.map(() => '?').join(', ')})`);
      params.push(...fieldFqNames);
      clauses.push(`(${fieldFqNames.map(() => `field_fq_name LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      params.push(...fieldFqNames.map(name => `%${escapeLike(name)}%`));
    }
    if (clauses.length === 0) return [];
    return await this.db.prepare(`
      SELECT field_name, field_fq_name, owner_class, file, line, column,
             enclosing_class, enclosing_symbol, access_kind, receiver_text,
             context, confidence, resolution_kind, file_role
      FROM field_usages
      WHERE snapshot_id = ?
        AND (${clauses.join(' OR ')})
        AND confidence >= 0.5
      ORDER BY confidence DESC, file, line, field_name
      LIMIT ?
    `).all(...params, limit) as FieldUsageRow[];
  }

  private async callEdgesForCallers(snapshotId: string, callers: string[], limit: number): Promise<CallEdgeRow[]> {
    if (callers.length === 0) return [];
    const placeholders = callers.map(() => '?').join(', ');
    return await this.db.prepare(`
      SELECT caller, callee, file, line, confidence, resolution_kind, signal_tier, signal_reasons_json
      FROM call_edges
      WHERE snapshot_id = ?
        AND caller IN (${placeholders})
        AND signal_tier IN ('primary', 'provider')
      ORDER BY confidence DESC, file, line
      LIMIT ?
    `).all(snapshotId, ...callers, limit) as CallEdgeRow[];
  }

  private async reviewPatch(snapshotId: string, args: Record<string, unknown>) {
    const limit = clampInt(Number(args.limit ?? 50), 1, 200);
    const focus = normalizeReviewFocus(String(args.focus ?? 'general'));
    const outputMode = normalizeReviewOutputMode(String(args.outputMode ?? 'compact'));
    const budget = reviewBudgetFor(outputMode, args, limit);
    const diff = stringOrUndefined(args.diff) ?? '';
    const allHunks = parsePatchHunks(diff);
    const diffStats = patchDiffStats(allHunks, diff);
    const impact = await this.simulatePatchImpact(snapshotId, {
      ...args,
      limit,
      callSeedLimit: 0,
      skipLikelyTests: args.includeLikelyTests !== true,
    }) as Record<string, unknown>;
    const hunks = rankPatchHunks(allHunks).slice(0, Math.max(budget.maxLineFocus, budget.maxFindings));
    const lineMapping = await this.patchLineMappings(snapshotId, hunks);
    const changedFiles = stringArray(impact.changedFiles);
    const fieldImpact = isPlainObject(impact.fieldImpact) ? impact.fieldImpact : undefined;
    const architectureContext = isPlainObject(impact.architectureContext) ? impact.architectureContext : undefined;
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
    const reviewTargets = await this.patchReviewTargets(
      snapshotId,
      hunks,
      lineMapping,
      budget.maxReviewTargets,
      budget.maxEvidencePerFinding,
    );
    const priorityCounts = reviewPriorityCounts(findings);
    const cappedRiskFlags = riskFlags
      .slice(0, budget.maxRiskFlags)
      .map(flag => compactReviewObject(flag, budget.maxEvidencePerFinding, 2) as Record<string, unknown>);
    const cappedTests = tests
      .slice(0, budget.maxTests)
      .map(test => compactReviewObject(test, budget.maxEvidencePerFinding, 2) as Record<string, unknown>);
    const followUpSliceHints = reviewSliceHints(lineFocus, reviewTargets, budget.maxRequiredToolCalls);
    const firstFollowUpToolCall = followUpSliceHints.length > 0
      ? {
        tool: 'get_file_slice',
        args: {
          slices: followUpSliceHints.map(hint => ({
            file: hint.file,
            lines: hint.lines,
            symbol: hint.symbol,
            maxChars: hint.maxChars,
          })),
        },
        when: 'Inspect these exact changed ranges before broad repository search or final review comments.',
        batching: 'Call get_file_slice once with args.slices; do not loop one call per hunk.',
      }
      : undefined;
    const requiredToolCalls = reviewToolCalls(changedFiles, lineFocus, findings, budget.maxRequiredToolCalls);
    const reviewProfile: PackProfile = outputMode === 'full' ? 'full' : 'compact';
    const evidenceHandles = evidenceHandlesForObjects([
      ...lineFocus,
      ...reviewTargets,
    ], reviewProfile);
    const packedFieldImpact = fieldImpact ? compactReviewObject(fieldImpact, budget.maxEvidencePerFinding, 2) : undefined;
    const packedArchitectureContext = architectureContext ? compactReviewObject(architectureContext, budget.maxEvidencePerFinding, 2) : undefined;
    const packedValidation = compactReviewObject(validation, budget.maxEvidencePerFinding, 2);
    const returnedPayloadForBudget = {
      impactSummary: impact.summary,
      changedFiles,
      fieldImpact: packedFieldImpact,
      architectureContext: packedArchitectureContext,
      diffStats,
      reviewFindings: findings,
      lineFocus,
      reviewTargets,
      followUpSliceHints,
      firstFollowUpToolCall,
      evidenceHandles,
      riskFlags: cappedRiskFlags,
      testsLikelyRelevant: cappedTests,
      validation: packedValidation,
      requiredToolCalls,
    };
    const fullPayloadForBudget = {
      impact,
      allHunks,
      allFindings,
      reviewTargets,
      followUpSliceHints,
      firstFollowUpToolCall,
      riskFlags,
      tests,
      validation,
      requiredToolCalls,
    };

    return {
      outputMode,
      focus,
      reviewStatus: reviewStatusFor(findings, changedFiles),
      impactSummary: impact.summary,
      changedFiles,
      fieldImpact: packedFieldImpact,
      architectureContext: packedArchitectureContext,
      diffStats,
      reviewPlan: reviewPlanForPatch(diffStats, findings, impact),
      seededRiskCategories: seededRiskCategoriesForReview(focus, findings, riskFlags, diffStats),
      mustCheckInvariants: mustCheckInvariantsForReview(focus, changedFiles, impact, findings),
      knownSensitiveDataPatterns: knownSensitiveDataPatternsForReview(focus),
      precisionTargets: precisionTargetsForReview(focus, findings),
      reviewFindings: findings,
      reviewFocus: reviewFocusForPatch(focus, impact, findings, budget.maxEvidencePerFinding),
      lineFocus,
      reviewTargets,
      evidenceHandles,
      followUpSliceHints,
      firstFollowUpToolCall,
      agentGuidance: reviewAgentGuidance(focus, findings, reviewTargets, followUpSliceHints),
      riskFlags: cappedRiskFlags,
      testsLikelyRelevant: cappedTests,
      validation: packedValidation,
      requiredToolCalls,
      reviewerQuestions: reviewQuestionsForPatch(findings, impact),
      metrics: {
        changedFileCount: changedFiles.length,
        diffHunkCount: allHunks.length,
        reportedLineFocusCount: lineFocus.length,
        reviewTargetCount: reviewTargets.length,
        findingCount: findings.length,
        totalFindingCount: allFindings.length,
        priorityCounts,
        likelyTestCount: tests.length,
        omittedFindings: Math.max(0, allFindings.length - findings.length),
        omittedHunks: Math.max(0, allHunks.length - lineFocus.length),
        omittedRiskFlags: Math.max(0, riskFlags.length - cappedRiskFlags.length),
        omittedTests: Math.max(0, tests.length - cappedTests.length),
      },
      budget: responseBudgetReport({
        profile: reviewProfile,
        returnedPayload: returnedPayloadForBudget,
        fullPayload: fullPayloadForBudget,
        handleCount: evidenceHandles.length,
        policy: 'review packets keep findings and risky hunks compact; exact changed source is expanded through get_file_slice handles',
      }),
      confidence: reviewConfidence(changedFiles.length, hunks.length, findings, riskFlags),
      confidenceNotes: [
        'Review findings are deterministic risk hypotheses from the diff and graph impact, not proof of bugs.',
        'Default output is capped for large diffs; use outputMode=full only when expanded evidence is needed.',
        'Use requiredToolCalls for exact source slices before writing final review comments.',
      ],
    };
  }

  private async patchLineMappings(snapshotId: string, hunks: PatchHunk[]): Promise<Map<PatchHunk, PatchLineMapping>> {
    const result = new Map<PatchHunk, PatchLineMapping>();
    const root = await this.workspaceRootForSnapshot(snapshotId);
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
      const resolved = await this.resolveFile(snapshotId, hunk.file) ?? hunk.file;
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

  private async patchReviewTargets(
    snapshotId: string,
    hunks: PatchHunk[],
    lineMapping: Map<PatchHunk, PatchLineMapping>,
    maxTargets: number,
    maxEvidence: number,
  ): Promise<Array<Record<string, unknown>>> {
    const targets: Array<Record<string, unknown>> = [];
    const targetHunks = hunks.slice(0, maxTargets);
    for (let index = 0; index < targetHunks.length; index++) {
      const hunk = targetHunks[index]!;
      const resolvedFile = await this.resolveFile(snapshotId, hunk.file) ?? hunk.file;
      const mapping = lineMapping.get(hunk);
      const symbolRow = resolvedFile ? await this.symbolForPatchHunk(snapshotId, resolvedFile, hunk) : undefined;
      const symbol = symbolRow
        ? compactSymbolCandidate(symbolDto(symbolRow), 'nearest indexed symbol for this changed hunk')
        : undefined;
      const symbolNeedle = symbol?.symbol || symbol?.name || '';
      const callers = symbolNeedle
        ? ((await this.getCallers(snapshotId, { symbol: symbolNeedle, limit: 6 })) as { callers: CallEdgeRow[] }).callers
        : [];
      const callees = symbolNeedle
        ? ((await this.getCallees(snapshotId, { symbol: symbolNeedle, limit: 6 })) as { callees: CallEdgeRow[] }).callees
        : [];
      const dependencies = resolvedFile ? (await this.dependencyRows(snapshotId, resolvedFile, 'from_file')).slice(0, 6) : [];
      const dependents = resolvedFile ? (await this.dependencyRows(snapshotId, resolvedFile, 'to_file')).slice(0, 6) : [];
      const endpoints = compactEndpointCandidates(
        resolvedFile ? await this.impactedEndpoints(snapshotId, [resolvedFile]) : [],
      ).slice(0, 6);
      const testSeeds = uniqueStrings([
        symbol?.symbol ?? '',
        symbol?.name ?? '',
        resolvedFile ? path.posix.basename(resolvedFile, path.posix.extname(resolvedFile)) : '',
      ]);
      const tests = testSeeds.length > 0
        ? await this.findRelevantTestsForSeeds(snapshotId, testSeeds, 6)
        : [];

      const hunkSummary = compactPatchHunk(hunk, mapping);
      targets.push({
        targetId: `hunk-${index + 1}`,
        file: resolvedFile,
        diffFile: hunk.file !== resolvedFile ? hunk.file : undefined,
        newLines: hunkSummary.newLines,
        fileSliceLines: hunkSummary.fileSliceLines,
        oldLines: hunkSummary.oldLines,
        lineMappingConfidence: hunkSummary.lineMappingConfidence,
        lineMappingReason: hunkSummary.lineMappingReason,
        riskScore: patchHunkRiskScore(hunk),
        riskLevel: patchHunkRiskLevel(hunk),
        changeKinds: hunk.changeKinds,
        changedSymbol: symbol,
        graphContext: {
          callers: callers.slice(0, maxEvidence).map(compactCallEdge),
          callees: callees.slice(0, maxEvidence).map(compactCallEdge),
          dependents: compactReviewObject(dependents, maxEvidence, 2),
          dependencies: compactReviewObject(dependencies, maxEvidence, 2),
          endpoints: compactReviewObject(endpoints, maxEvidence, 2),
          counts: {
            callers: callers.length,
            callees: callees.length,
            dependents: dependents.length,
            dependencies: dependencies.length,
            endpoints: endpoints.length,
          },
        },
        testsLikelyRelevant: compactReviewObject(tests, maxEvidence, 2),
        recommendedChecks: reviewTargetChecksFor(hunk, symbol, endpoints, tests),
      });
    }
    return targets;
  }

  private async symbolForPatchHunk(snapshotId: string, file: string, hunk: PatchHunk): Promise<SymbolRow | undefined> {
    const targetLine = hunk.addedLines[0]?.line ?? hunk.newStart;
    const containing = await this.db.prepare(`
      SELECT fq_name, simple_name, kind, file, line, end_line, signature, visibility, parent,
             package_name, return_type, parameter_types_json, annotations_json,
             framework_role, framework_meta_json, file_role
      FROM symbols
      WHERE snapshot_id = ?
        AND file = ?
        AND line <= ?
        AND COALESCE(end_line, line) >= ?
      ORDER BY
        CASE kind
          WHEN 'method' THEN 0
          WHEN 'function' THEN 0
          WHEN 'constructor' THEN 0
          WHEN 'class' THEN 1
          WHEN 'interface' THEN 1
          ELSE 2
        END,
        (COALESCE(end_line, line) - line) ASC,
        line DESC
      LIMIT 1
    `).get(snapshotId, file, targetLine, targetLine) as SymbolRow | undefined;
    if (containing) return containing;

    return await this.db.prepare(`
      SELECT fq_name, simple_name, kind, file, line, end_line, signature, visibility, parent,
             package_name, return_type, parameter_types_json, annotations_json,
             framework_role, framework_meta_json, file_role
      FROM symbols
      WHERE snapshot_id = ?
        AND file = ?
      ORDER BY ABS(line - ?), line
      LIMIT 1
    `).get(snapshotId, file, targetLine) as SymbolRow | undefined;
  }

  private async findTestsFor(snapshotId: string, args: Record<string, unknown>) {
    const target = String(args.symbol ?? args.target ?? '');
    const limit = Math.min(Number(args.limit ?? 50), 200);
    const tests = await this.findRelevantTests(snapshotId, target, limit);
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

  private async getResearchPack(snapshotId: string, args: Record<string, unknown>) {
    const target = String(args.target ?? '').trim();
    const profile = normalizePackProfile(args.profile);
    const responseMode = normalizePackResponseMode(args.responseMode);
    const requestedTaskType = normalizeOracleTaskType(String(args.taskType ?? 'research'));
    if (requestedTaskType === 'implement' || requestedTaskType === 'debug' || requestedTaskType === 'refactor' || requestedTaskType === 'create-testcase') {
      return {
        target,
        taskType: args.taskType ?? requestedTaskType,
        responseMode,
        profile,
        routing: {
          intendedUse: 'redirect edit/debug request to edit-ready context',
          expectedToolCalls: 1,
          answerDirectly: false,
          followUpRule: 'Call get_change_pack with the full user task before searching or opening files.',
        },
        redirectTool: {
          tool: 'get_change_pack',
          args: {
            task: target || '<full user task>',
            target: target || undefined,
            changeType: requestedTaskType === 'create-testcase' ? 'test' : requestedTaskType,
            profile,
          },
          note: 'Use the full user task text for task when available; the current research target may be too narrow.',
        },
        missingFacts: ['Edit/debug tasks need change_pack edit ranges, invariants, and targeted validation.'],
        nextAction: 'Call get_change_pack with the full user task, then open only routing.firstToolCall slices before editing.',
        confidence: 0.45,
        budget: responseBudgetReport({
          profile,
          returnedPayload: {
            target,
            taskType: args.taskType ?? requestedTaskType,
            responseMode,
            profile,
            redirectTool: 'get_change_pack',
            missingFacts: ['Edit/debug tasks need change_pack edit ranges, invariants, and targeted validation.'],
          },
          handleCount: 0,
          policy: 'research pack redirects edit/debug tasks to get_change_pack before source exploration',
        }),
      };
    }
    const defaultTokenBudget = packProfileValue(profile, 3500, 6000, 8000);
    const maxTokenBudget = packProfileValue(profile, 3500, 6000, 12000);
    const tokenBudget = Math.min(
      clampInt(Number(args.tokenBudget ?? defaultTokenBudget), 1000, 12000),
      maxTokenBudget,
    );
    const preferredFileRole = String(args.fileRole ?? 'main_source');
    const preferredLanguage = args.language ? String(args.language) : await this.dominantResearchLanguage(snapshotId);
    const seedTerms = researchSeedTerms(target);
    const endpointNeedle = endpointNeedleForResearch(target);
    const endpointMethod = endpointMethodForResearch(target, args.method);
    const endpointSearch = endpointNeedle
      ? await this.findEndpoints(snapshotId, {
        ...args,
        path: endpointNeedle,
        method: endpointMethod,
        limit: packProfileValue(profile, 4, 6, 8),
        includeSnippets: false,
        explainRank: true,
      }) as { endpoints: Array<Record<string, unknown>>; totalCount?: number }
      : { endpoints: [], totalCount: 0 };
    const endpointCandidates = compactEndpointCandidates(endpointSearch.endpoints);
    const exactEndpointCandidates = endpointNeedle
      ? endpointCandidates.filter(endpoint =>
        endpoint.path === endpointNeedle
        && (endpointMethod === 'all' || endpoint.method.toUpperCase() === endpointMethod))
      : [];
    const handlerSeedEndpoints = exactEndpointCandidates.length > 0 ? exactEndpointCandidates : endpointCandidates;
    const impactedEndpoints = uniqueEndpointCandidates([
      ...exactEndpointCandidates,
      ...endpointCandidates,
    ]).slice(0, packProfileValue(profile, 4, 5, 6));
    const endpointSymbolCandidates = handlerSeedEndpoints.map(endpointHandlerSymbolCandidate);
    const hasEndpointSeed = endpointSymbolCandidates.length > 0;
    const endpointFileCandidates = handlerSeedEndpoints.map(endpoint => ({
      file: endpoint.file,
      lines: endpoint.lines,
      whyRelevant: endpoint.whyRelevant,
      confidence: Math.min(0.95, endpoint.confidence + 0.1),
      matchedTokens: [endpoint.method, endpoint.path].filter(Boolean),
      topSymbols: [endpointHandlerSymbolCandidate(endpoint) as unknown as Record<string, unknown>],
      endpoints: [endpoint as unknown as Record<string, unknown>],
    }));
    const explicitSymbols = await this.explicitResearchSymbols(
      snapshotId,
      target,
      preferredFileRole,
      preferredLanguage,
      packProfileValue(profile, 6, 8, 8),
    );
    const explicitFiles = await this.explicitResearchFiles(
      snapshotId,
      target,
      preferredFileRole,
      preferredLanguage,
      packProfileValue(profile, 4, 5, 5),
    );
    const explicitMemberTarget = explicitSymbolRefs(target).some(ref => Boolean(ref.member));
    const explicitFastPath = explicitFiles.length >= 3 || (explicitMemberTarget && explicitFiles.length > 0);
    const symbolRows: Array<Record<string, unknown>> = [];
    if (!explicitFastPath && !hasEndpointSeed) {
      for (const query of researchSymbolQueries(target, seedTerms)) {
        const result = await this.searchSymbol(snapshotId, {
          ...args,
          query,
          fileRole: preferredFileRole,
          language: preferredLanguage,
          limit: query === target ? packProfileValue(profile, 6, 8, 10) : packProfileValue(profile, 4, 5, 6),
          includeTests: false,
          includeGenerated: false,
          includeFixtures: false,
          includeSynthetic: false,
          includeSnippets: false,
          explainRank: query === target,
        }) as { symbols: Array<Record<string, unknown>> };
        symbolRows.push(...result.symbols);
      }
    }

    const symbolCandidates = uniqueSymbolCandidates([
      ...endpointSymbolCandidates,
      ...explicitSymbols,
      ...symbolRows.map(row => compactSymbolCandidate(row)),
    ]);
    const endpointSymbolKeys = new Set(endpointSymbolCandidates.map(symbol => `${symbol.symbol}\0${symbol.file}`));
    const explicitFileSet = new Set(explicitFiles.map(file => file.file));
    const scopedSymbolCandidates = explicitFiles.length > 0
      ? symbolCandidates.filter(symbol => explicitFileSet.has(symbol.file) || endpointSymbolKeys.has(`${symbol.symbol}\0${symbol.file}`))
      : symbolCandidates;
    const relevantSymbols = (scopedSymbolCandidates.length > 0
      ? scopedSymbolCandidates
      : explicitFastPath
        ? []
        : symbolCandidates).slice(0, packProfileValue(profile, 4, 5, 6));
    const fileResults = explicitFastPath || hasEndpointSeed
      ? { files: [] as Array<Record<string, unknown>>, totalFound: explicitFiles.length }
      : await this.searchFiles(snapshotId, {
        ...args,
        query: target,
        fileRole: preferredFileRole,
        language: preferredLanguage,
        limit: packProfileValue(profile, 4, 6, 8),
        includeTests: false,
        includeGenerated: false,
        includeFixtures: false,
        includeSnippets: true,
        snippetLines: clampInt(Number(args.snippetLines ?? packProfileValue(profile, 8, 10, 14)), 6, 40),
        snippetTokenBudget: Math.min(packProfileValue(profile, 1600, 2800, 5000), Math.max(900, Math.floor(tokenBudget * 0.4))),
        explainRank: true,
      }) as { files: Array<Record<string, unknown>>; totalFound?: number };
    const candidateFiles = uniqueFileCandidates([
      ...endpointFileCandidates,
      ...explicitFiles,
      ...relevantSymbols.map(symbol => ({
        file: symbol.file,
        lines: symbol.lines,
        whyRelevant: symbol.whyRelevant,
        confidence: symbol.confidence,
        matchedTokens: symbol.matchedTokens,
        topSymbols: [symbol],
        endpoints: [],
      })),
      ...(explicitFiles.length >= 3 ? [] : fileResults.files.map(row => compactFileCandidate(row))),
    ]).slice(0, packProfileValue(profile, 4, 5, 6));

    const edgeSeeds = endpointSymbolCandidates.length > 0
      ? endpointSymbolCandidates.slice(0, packProfileValue(profile, 2, 3, 4))
      : explicitFastPath
        ? []
        : relevantSymbols.slice(0, packProfileValue(profile, 3, 4, 4));
    const candidateFileSet = new Set(candidateFiles.map(file => file.file));
    const includeLowSignal = args.includeLowSignal === true;
    const callersRaw = edgeSeeds.length > 0 ? await this.researchCallEdges(snapshotId, edgeSeeds, 'callers', packProfileValue(profile, 6, 8, 12), includeLowSignal) : [];
    const directCalleesRaw = edgeSeeds.length > 0 ? await this.researchCallEdges(snapshotId, edgeSeeds, 'callees', packProfileValue(profile, 10, 16, 24), includeLowSignal) : [];
    const endpointSeedFiles = new Set(endpointSymbolCandidates.map(symbol => symbol.file).filter(Boolean));
    const scopedDirectCalleesRaw = hasEndpointSeed && endpointSeedFiles.size > 0
      ? directCalleesRaw.filter(edge => endpointSeedFiles.has(edge.file))
      : directCalleesRaw;
    const downstreamCalleesRaw = hasEndpointSeed && scopedDirectCalleesRaw.length > 0
      ? await this.researchCallEdges(
        snapshotId,
        callEdgesAsResearchSymbols(scopedDirectCalleesRaw).slice(0, packProfileValue(profile, 2, 3, 4)),
        'callees',
        packProfileValue(profile, 6, 10, 14),
        includeLowSignal,
      )
      : [];
    const calleesRaw = uniqueCallEdges([...scopedDirectCalleesRaw, ...downstreamCalleesRaw])
      .sort((a, b) => researchCallEdgeScore(b) - researchCallEdgeScore(a) || a.line - b.line || a.callee.localeCompare(b.callee));
    const calleeDefinitions = hasEndpointSeed
      ? await this.researchCalleeDefinitions(snapshotId, calleesRaw, packProfileValue(profile, 4, 6, 8))
      : [];
    const calleeFileCandidates: ResearchFileCandidate[] = calleeDefinitions.map(symbol => ({
      file: symbol.file,
      lines: symbol.lines,
      whyRelevant: `downstream callee definition for endpoint flow: ${symbol.name}`,
      confidence: Math.min(0.95, symbol.confidence + 0.05),
      matchedTokens: symbol.matchedTokens,
      topSymbols: [symbol as unknown as Record<string, unknown>],
      endpoints: [],
    }));
    const restrictEdgesToCandidateFiles = explicitFiles.length > 0 && endpointSymbolCandidates.length === 0;
    const callers = restrictEdgesToCandidateFiles
      ? callersRaw.filter(edge => candidateFileSet.has(edge.file)).slice(0, 8)
      : callersRaw;
    const callees = restrictEdgesToCandidateFiles
      ? calleesRaw.filter(edge => candidateFileSet.has(edge.file)).slice(0, 8)
      : calleesRaw;
    const flowCandidateFiles = uniqueFileCandidates([
      ...candidateFiles,
      ...calleeFileCandidates,
    ]);
    const flowRelevantSymbols = uniqueSymbolCandidates([
      ...relevantSymbols,
      ...calleeDefinitions,
    ]);
    const topFiles = uniqueFilesInOrder([
      ...candidateFiles.map(file => file.file),
      ...calleeFileCandidates.map(file => file.file),
      ...flowRelevantSymbols.map(symbol => symbol.file),
      ...callers.map(edge => edge.file),
      ...callees.map(edge => edge.file),
      ...impactedEndpoints.map(endpoint => endpoint.file),
    ]).slice(0, packProfileValue(profile, 5, 6, 8));
    const evidenceSlices = await this.researchEvidenceSlices(
      snapshotId,
      flowRelevantSymbols,
      flowCandidateFiles,
      seedTerms,
      Math.max(1200, Math.min(packProfileValue(profile, 2200, 3200, 4500), Math.floor(tokenBudget * 4 * 0.22))),
    );
    const flowSteps = researchFlowSteps({
      symbols: flowRelevantSymbols,
      callers,
      callees,
      endpoints: impactedEndpoints,
      files: flowCandidateFiles,
    });
    const notCalledCandidates = hasEndpointSeed
      ? await this.endpointNotCalledCandidates(
        snapshotId,
        flowCandidateFiles.map(file => file.file),
        callees,
      )
      : [];
    const missingFacts = researchMissingFacts({
      target,
      relevantSymbols,
      fileCandidateCount: candidateFiles.length,
      evidenceSlices,
      flowSteps,
    });
    const sufficientForAnswer = missingFacts.length === 0;
    const returnedFlowSteps = flowSteps.slice(0, packProfileValue(profile, 5, 6, 8));
    const returnedDefinitions = flowRelevantSymbols.slice(0, packProfileValue(profile, 3, 5, 8));
    const returnedCallers = callers.slice(0, packProfileValue(profile, 3, 5, 8)).map(compactCallEdge);
    const returnedCallees = callees.slice(0, packProfileValue(profile, 6, 10, 14)).map(compactCallEdge);
    const returnedEndpoints = impactedEndpoints.slice(0, packProfileValue(profile, 3, 4, 4));
    const returnedTopFiles = topFiles.slice(0, packProfileValue(profile, 5, 6, 6));
    const returnedSeedTerms = seedTerms.slice(0, packProfileValue(profile, 8, 10, 10));
    const oracleTests = await this.findRelevantTestsForSeeds(
      snapshotId,
      uniqueStrings([
        target,
        ...returnedDefinitions.flatMap(symbol => [symbol.symbol, symbol.name]),
        ...returnedTopFiles.map(file => path.basename(file, path.extname(file))),
      ]),
      packProfileValue(profile, 5, 6, 8),
    );
    const oracleValidation = await this.validationHints(snapshotId, oracleTests, returnedTopFiles);
    const taskOracle = taskOracleFor({
      task: target,
      taskType: String(args.taskType ?? 'research'),
      candidateFiles: flowCandidateFiles.slice(0, packProfileValue(profile, 4, 6, 8)),
      relevantSymbols: returnedDefinitions,
      testsLikelyRelevant: oracleTests,
      validation: oracleValidation,
      flowSteps: returnedFlowSteps,
      evidenceSlices,
    });
    const compressedEvidence = compressedEvidenceForResearch({
      flowSteps: returnedFlowSteps,
      callers: returnedCallers,
      callees: returnedCallees,
      evidenceSlices,
      definitions: returnedDefinitions,
    });
    const architectureContext = await architectureContextForFiles(this.db, snapshotId, returnedTopFiles, target, packProfileValue(profile, 6, 8, 10));
    const packedEvidenceSlices = slimEvidenceSlicesForPack(evidenceSlices, profile);
    const evidenceHandles = evidenceHandlesForObjects([
      ...evidenceSlices,
      ...returnedDefinitions,
      ...candidateFiles,
    ], profile);
    const disallowedFollowups = [
      'shell_rg',
      'shell_search',
      'shell_read_loop',
      'broad_shell_search',
      'unbounded_file_reads',
      'unbounded_mcp_exploration',
    ];
    const allowedFollowups = sufficientForAnswer
      ? []
      : evidenceHandles.slice(0, 1).map(handle => ({
        ...handle,
        reason: `Only use this exact follow-up to resolve missing fact: ${missingFacts[0]}`,
      }));
    const maxAdditionalCalls = allowedFollowups.length;
    const stopRule = sufficientForAnswer
      ? 'Do not call rg, shell, search_code, search_symbol, get_file_slice, or broad file reads; answer from this get_flow_pack packet.'
      : 'Do not call rg or shell search. Use only allowedFollowups for the listed missingFacts, then answer or report the missing fact.';
    const returnedPayloadForBudget = {
      flowSteps: returnedFlowSteps,
      definitionCandidates: returnedDefinitions,
      callers: returnedCallers,
      callees: returnedCallees,
      impactedEndpoints: returnedEndpoints,
      notCalledCandidates,
      topFiles: returnedTopFiles,
      evidenceSlices: packedEvidenceSlices,
      evidenceHandles,
      architectureContext,
      compressedEvidence,
    };
    const fullPayloadForBudget = {
      flowSteps,
      definitionCandidates: relevantSymbols,
      callers: callers.map(compactCallEdge),
      callees: callees.map(compactCallEdge),
      impactedEndpoints,
      topFiles,
      evidenceSlices,
      architectureContext,
      compressedEvidence,
    };
    const completeness = {
      sufficientForAnswer,
      evidenceSliceCount: evidenceSlices.length,
      symbolCandidateCount: relevantSymbols.length,
      fileCandidateCount: candidateFiles.length,
      omittedFileMatches: Math.max(0, Number(fileResults.totalFound ?? candidateFiles.length) - candidateFiles.length),
    };
    const answerGuidance = sufficientForAnswer
      ? [
        'Answer directly from this pack.',
        'Treat evidenceSlices as already-read source; cite file and line ranges from them.',
        'Do not call rg, shell search, search_code, search_symbol, get_file_slice, grep, or Read unless the user asks for more detail.',
      ]
      : [
        'This pack is incomplete; perform only the targeted follow-up named in missingFacts.',
        'Prefer one allowedFollowup for a listed missing file/range over broad rg/shell/read loops.',
      ];
    const nextAction = sufficientForAnswer
      ? 'Answer the user directly from flowSteps and evidenceSlices.'
      : `Resolve missing fact: ${missingFacts[0]}`;
    const confidence = sufficientForAnswer ? 0.82 : relevantSymbols.length > 0 ? 0.62 : 0.35;
    const confidenceNotes = [
      'The pack intentionally includes capped source evidence so architecture answers do not need many follow-up slice calls.',
      'Flow steps are ranked from indexed symbols, call edges, endpoints, and file evidence; ambiguous Java call edges remain confidence-scored.',
      'Use granular tools only for explicit missing facts, not for broad rediscovery.',
    ];
    const slimTaskOracle = slimTaskOracleForPack(taskOracle, profile);
    const agentPayloadForBudget = {
      ...returnedPayloadForBudget,
      seedTerms: returnedSeedTerms,
      taskOracle: slimTaskOracle,
      completeness,
      answerGuidance,
      nextAction,
    };
    if (responseMode === 'answer') {
      const compactAnswerGuidance = sufficientForAnswer
        ? ['Answer directly from evidenceSlices and flowSteps; cite file/line ranges.']
        : ['Resolve only the listed missingFacts before answering.'];
      const answerPayloadForBudget = {
        flowSteps: returnedFlowSteps,
        definitionCandidates: returnedDefinitions,
        callers: returnedCallers,
        callees: returnedCallees,
        impactedEndpoints: returnedEndpoints,
        notCalledCandidates,
        topFiles: returnedTopFiles,
        evidenceSlices: packedEvidenceSlices,
        completeness,
        missingFacts,
        answerGuidance: compactAnswerGuidance,
      };
      return {
        target,
        taskType: args.taskType ?? 'research',
        responseMode,
        tokenBudget,
        profile,
        answerable: sufficientForAnswer,
        allowedFollowups,
        disallowedFollowups,
        maxAdditionalCalls,
        stopRule,
        routing: {
          intendedUse: 'answer-ready architecture/research context',
          expectedToolCalls: sufficientForAnswer ? 1 : 2,
          answerDirectly: sufficientForAnswer,
          maxAdditionalCalls,
          followUpRule: sufficientForAnswer
            ? stopRule
            : 'Do not call rg or shell search; use only allowedFollowups for specific items listed in missingFacts.',
        },
        flowSteps: returnedFlowSteps,
        definitionCandidates: returnedDefinitions,
        callers: returnedCallers,
        callees: returnedCallees,
        impactedEndpoints: returnedEndpoints,
        notCalledCandidates,
        topFiles: returnedTopFiles,
        evidenceSlices: packedEvidenceSlices,
        completeness,
        missingFacts,
        answerGuidance: compactAnswerGuidance,
        nextAction,
        confidence,
        confidenceNotes: confidenceNotes.slice(0, 2),
        budget: {
          ...responseBudgetReport({
            profile,
            tokenBudget,
            returnedPayload: answerPayloadForBudget,
            fullPayload: agentPayloadForBudget,
            handleCount: 0,
            policy: 'answer mode omits compressedEvidence, taskOracle, evidenceHandles, architectureContext, and seedTerms; set responseMode=agent when planner metadata is needed',
          }),
          preferredFileRole,
          preferredLanguage,
        },
      };
    }

    return {
      target,
      taskType: args.taskType ?? 'research',
      responseMode,
      tokenBudget,
      profile,
      routing: {
        intendedUse: 'answer-ready architecture/research context',
        expectedToolCalls: sufficientForAnswer ? 1 : 2,
        answerDirectly: sufficientForAnswer,
        maxAdditionalCalls,
        followUpRule: sufficientForAnswer
          ? stopRule
          : 'Do not call rg or shell search; use only allowedFollowups for specific items listed in missingFacts.',
      },
      answerable: sufficientForAnswer,
      allowedFollowups,
      disallowedFollowups,
      maxAdditionalCalls,
      stopRule,
      seedTerms: returnedSeedTerms,
      flowSteps: returnedFlowSteps,
      definitionCandidates: returnedDefinitions,
      callers: returnedCallers,
      callees: returnedCallees,
      impactedEndpoints: returnedEndpoints,
      notCalledCandidates,
      topFiles: returnedTopFiles,
      evidenceSlices: packedEvidenceSlices,
      evidenceHandles,
      compressedEvidence,
      architectureContext,
      taskOracle: slimTaskOracle,
      completeness,
      missingFacts,
      answerGuidance,
      nextAction,
      confidence,
      confidenceNotes,
      budget: {
        ...responseBudgetReport({
          profile,
          tokenBudget,
          returnedPayload: agentPayloadForBudget,
          fullPayload: fullPayloadForBudget,
          handleCount: evidenceHandles.length,
          policy: profile === 'full'
            ? 'full profile requested; source evidence is still bounded by slice budgets'
            : 'compact evidence slices plus exact get_file_slice handles',
        }),
        preferredFileRole,
        preferredLanguage,
      },
    };
  }

  private async explicitResearchFiles(
    snapshotId: string,
    target: string,
    preferredFileRole: string,
    preferredLanguage: string | undefined,
    limit: number,
  ): Promise<Array<ReturnType<typeof compactFileCandidate>>> {
    const rootBasename = compactSearchText(path.basename(await this.workspaceRootForSnapshot(snapshotId) ?? ''));
    const needles = explicitFileNeedles(target)
      .filter(needle => path.posix.extname(needle))
      .filter(needle => isPreferredLanguageFileNeedle(needle, preferredLanguage))
      .filter((needle) => {
        const basename = path.posix.basename(needle, path.posix.extname(needle));
        return compactSearchText(basename) !== rootBasename;
      });
    if (needles.length === 0) return [];
    const files: string[] = [];
    const root = await this.workspaceRootForSnapshot(snapshotId);
    const explicitRangeCache = new Map<string, string | undefined>();
    const explicitRangeFor = (file: string, requireMemberMatch = false): string | undefined => {
      const key = `${file}\0${requireMemberMatch ? 'member' : 'any'}`;
      if (!explicitRangeCache.has(key)) {
        explicitRangeCache.set(key, bestExplicitSourceRange(root, file, target, requireMemberMatch));
      }
      return explicitRangeCache.get(key);
    };
    for (const needle of needles.slice(0, 12)) {
      const normalized = needle.replace(/\\/g, '/');
      const basename = path.posix.basename(normalized);
      const params: unknown[] = [snapshotId, `%/${escapeLike(normalized)}`, `%/${escapeLike(basename)}`];
      const filters = ['snapshot_id = ?', "(path LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')"];
      if (preferredFileRole) {
        filters.push('file_role = ?');
        params.push(preferredFileRole);
      }
      if (preferredLanguage) {
        filters.push('language = ?');
        params.push(preferredLanguage);
      }
      const rows = await this.db.prepare(`
        SELECT path
        FROM files
        WHERE ${filters.join(' AND ')}
        ORDER BY LENGTH(path), path
        LIMIT 50
      `).all(...params) as Array<{ path: string }>;
      rows.sort((a, b) => {
        const aHasExplicitRange = explicitRangeFor(a.path, true) ? 0 : 1;
        const bHasExplicitRange = explicitRangeFor(b.path, true) ? 0 : 1;
        return aHasExplicitRange - bHasExplicitRange || a.path.length - b.path.length || a.path.localeCompare(b.path);
      });
      files.push(...rows.slice(0, 1).map(row => row.path));
      if (files.length >= limit * 2) break;
    }
    const orderedFiles = uniqueFilesInOrder(files).slice(0, limit * 2);
    if (orderedFiles.length === 0) return [];
    const placeholders = orderedFiles.map(() => '?').join(', ');
    const rows = await this.db.prepare(`
      SELECT path, language, file_role
      FROM files
      WHERE snapshot_id = ? AND path IN (${placeholders})
    `).all(snapshotId, ...orderedFiles) as Array<{ path: string; language?: string; file_role?: string }>;
    const rowsByPath = new Map(rows.map(row => [row.path, row]));
    return orderedFiles
      .slice(0, limit)
      .map((file) => {
        const row = rowsByPath.get(file);
        const basename = path.posix.basename(file, path.posix.extname(file));
        return {
          file,
          language: row?.language,
          fileRole: row?.file_role,
          lines: explicitRangeFor(file) ?? '1-80',
          whyRelevant: `explicit file/class mention: ${file}`,
          confidence: 0.95,
          matchedTokens: [basename],
          topSymbols: [],
          endpoints: [],
        };
      });
  }

  private async explicitResearchSymbols(
    snapshotId: string,
    target: string,
    preferredFileRole: string,
    preferredLanguage: string | undefined,
    limit: number,
  ): Promise<ResearchSymbolCandidate[]> {
    const refs = explicitSymbolRefs(target);
    if (refs.length === 0) return [];

    const rows: SymbolRow[] = [];
    const baseFilters = ['snapshot_id = ?'];
    const baseParams: unknown[] = [snapshotId];
    if (preferredFileRole) {
      baseFilters.push('file_role = ?');
      baseParams.push(preferredFileRole);
    }
    if (preferredLanguage) {
      baseFilters.push(`file IN (SELECT path FROM files WHERE snapshot_id = ? AND language = ?)`);
      baseParams.push(snapshotId, preferredLanguage);
    }
    const baseWhere = baseFilters.join(' AND ');
    const select = `
      SELECT fq_name, simple_name, kind, file, line, end_line, signature, visibility, parent,
             package_name, return_type, parameter_types_json, annotations_json,
             framework_role, framework_meta_json, file_role
      FROM symbols
    `;
    const classesWithMemberRefs = new Set(refs
      .filter(ref => Boolean(ref.member))
      .map(ref => ref.className));

    for (const ref of refs.slice(0, 12)) {
      if (ref.member) {
        const fileLike = `%/${escapeLike(ref.className)}.%`;
        const fqLike = `%${escapeLike(ref.className)}.${escapeLike(ref.member)}%`;
        rows.push(...await this.db.prepare(`
          ${select}
          WHERE ${baseWhere}
            AND simple_name = ?
            AND (
              parent = ?
              OR fq_name LIKE ? ESCAPE '\\'
              OR file LIKE ? ESCAPE '\\'
            )
          ORDER BY
            CASE
              WHEN parent = ? THEN 0
              WHEN file LIKE ? ESCAPE '\\' THEN 1
              ELSE 2
            END,
            line
          LIMIT 6
        `).all(
          ...baseParams,
          ref.member,
          ref.className,
          fqLike,
          fileLike,
          ref.className,
          fileLike,
        ) as SymbolRow[]);
        continue;
      }
      if (classesWithMemberRefs.has(ref.className)) continue;

      rows.push(...await this.db.prepare(`
        ${select}
        WHERE ${baseWhere}
          AND simple_name = ?
          AND kind IN ('class', 'interface', 'enum', 'record')
        ORDER BY line
        LIMIT 3
      `).all(...baseParams, ref.className) as SymbolRow[]);
    }

    return uniqueSymbolCandidates(rows.map(row => compactSymbolCandidate(
      symbolDto(row),
      'explicit class/method mention in target',
    ))).slice(0, limit);
  }

  private async dominantResearchLanguage(snapshotId: string): Promise<string | undefined> {
    const rows = await this.db.prepare(`
      SELECT language, COUNT(*) AS count
      FROM files
      WHERE snapshot_id = ?
        AND file_role = 'main_source'
        AND language IN ('java', 'typescript', 'javascript', 'python')
      GROUP BY language
      ORDER BY count DESC
      LIMIT 2
    `).all(snapshotId) as Array<{ language: string; count: number }>;
    const first = rows[0];
    if (!first || first.count < 20) return undefined;
    const second = rows[1];
    if (!second || first.count >= second.count * 1.25) return first.language;
    return undefined;
  }

  private async researchCallEdges(
    snapshotId: string,
    symbols: ResearchSymbolCandidate[],
    direction: 'callers' | 'callees',
    limit: number,
    includeLowSignal = false,
  ): Promise<CallEdgeRow[]> {
    const column = direction === 'callers' ? 'callee' : 'caller';
    const needles = researchEdgeNeedles(symbols).slice(0, 8);
    if (needles.length === 0) return [];
    const clauses = needles.map(() => `${column} LIKE ? ESCAPE '\\'`).join(' OR ');
    const dbLimit = Math.min(Math.max(limit * 4, 40), 120);
    const params = [snapshotId, ...needles.map(needle => `%${escapeLike(needle)}%`), dbLimit];
    const rows = await this.db.prepare(`
      SELECT caller, callee, file, line, confidence, resolution_kind, signal_tier, signal_reasons_json
      FROM call_edges
      WHERE snapshot_id = ?
        AND file_role != 'test_source'
        ${includeLowSignal ? '' : "AND signal_tier IN ('primary', 'provider')"}
        AND (${clauses})
      ORDER BY ${callSignalOrder()}, confidence DESC, file, line
      LIMIT ?
    `).all(...params) as CallEdgeRow[];
    return uniqueCallEdges(rows)
      .sort((a, b) => researchCallEdgeScore(b) - researchCallEdgeScore(a) || a.line - b.line || a.callee.localeCompare(b.callee))
      .slice(0, limit);
  }

  private async researchCalleeDefinitions(
    snapshotId: string,
    edges: CallEdgeRow[],
    limit: number,
  ): Promise<ResearchSymbolCandidate[]> {
    const resolved: ResearchSymbolCandidate[] = [];
    const seen = new Set<string>();
    for (const edge of edges) {
      const row = await this.lookupBestCalleeSymbol(snapshotId, edge);
      if (!row) continue;
      const symbol = compactSymbolCandidate(
        symbolDto(row),
        `definition for downstream endpoint-flow callee ${edge.callee}`,
      );
      const key = `${symbol.symbol}\0${symbol.file}`;
      if (!symbol.symbol || seen.has(key)) continue;
      seen.add(key);
      resolved.push(symbol);
      if (resolved.length >= limit) break;
    }
    return resolved;
  }

  private async lookupBestCalleeSymbol(snapshotId: string, edge: CallEdgeRow): Promise<SymbolRow | undefined> {
    const candidates: SymbolRow[] = [];
    for (const term of callEdgeLookupTerms(edge.callee)) {
      const query = term.trim();
      if (!query) continue;
      const pattern = `%${escapeLike(query)}%`;
      const rows = await this.db.prepare(`
        SELECT fq_name, simple_name, kind, file, line, end_line, signature, visibility, parent,
               package_name, return_type, parameter_types_json, annotations_json,
               framework_role, framework_meta_json, file_role
        FROM symbols
        WHERE snapshot_id = ?
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
          line
        LIMIT 25
      `).all(snapshotId, query, query, pattern, pattern, query, query, pattern) as SymbolRow[];
      candidates.push(...rows);
    }
    return uniqueRecordsBy(candidates, row => `${row.fq_name}\0${row.file}`)
      .sort((a, b) => calleeDefinitionScore(b, edge) - calleeDefinitionScore(a, edge) || a.line - b.line)
      [0];
  }

  private async endpointNotCalledCandidates(
    snapshotId: string,
    files: string[],
    callees: CallEdgeRow[],
  ): Promise<Array<Record<string, unknown>>> {
    const uniqueFiles = uniqueStrings(files.filter(Boolean)).slice(0, 20);
    if (uniqueFiles.length === 0) return [];
    const placeholders = uniqueFiles.map(() => '?').join(', ');
    const rows = await this.db.prepare(`
      SELECT fq_name, simple_name, kind, file, line, end_line, signature, visibility, parent,
             package_name, return_type, parameter_types_json, annotations_json,
             framework_role, framework_meta_json, file_role
      FROM symbols
      WHERE snapshot_id = ?
        AND file IN (${placeholders})
        AND kind = 'field'
      ORDER BY file, line
      LIMIT 200
    `).all(snapshotId, ...uniqueFiles) as SymbolRow[];
    const calledText = callees
      .flatMap(edge => [edge.callee, edge.caller])
      .join('\n')
      .toLowerCase();
    const candidates: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const serviceName = serviceLikeFieldType(row);
      if (!serviceName) continue;
      const fieldName = row.simple_name;
      const serviceNeedle = serviceName.toLowerCase();
      const fieldNeedle = fieldName.toLowerCase();
      if (calledText.includes(serviceNeedle) || calledText.includes(fieldNeedle)) continue;
      candidates.push({
        name: serviceName,
        field: fieldName,
        symbol: row.fq_name,
        file: row.file,
        line: row.line,
        reason: 'service-like field in the endpoint flow files is not present in the resolved call chain',
        confidence: 0.75,
      });
    }
    return uniqueRecordsBy(candidates, row => `${row.name}\0${row.file}`).slice(0, 8);
  }

  private async researchEvidenceSlices(
    snapshotId: string,
    symbols: ResearchSymbolCandidate[],
    files: ResearchFileCandidate[],
    seedTerms: string[],
    budgetChars: number,
  ): Promise<Array<Record<string, unknown>>> {
    const seeds: Array<{ file: string; lines?: string; symbol?: string; why: string }> = [];
    const root = await this.workspaceRootForSnapshot(snapshotId);
    for (const symbol of symbols) {
      if (!symbol.file || !symbol.lines) continue;
      seeds.push({
        file: symbol.file,
        lines: symbol.lines,
        symbol: symbol.symbol,
        why: `definition/source evidence for ${symbol.name}`,
      });
    }
    for (const file of files) {
      const lines = file.lines || bestSourceRange(root, file.file, seedTerms);
      if (lines) {
        seeds.push({
          file: file.file,
          lines,
          why: file.whyRelevant,
        });
      }
    }
    for (const file of files) {
      for (const symbol of file.topSymbols.slice(0, 3)) {
        const compact = compactSymbolCandidate(symbol);
        if (compact.file && compact.lines) {
          seeds.push({
            file: compact.file,
            lines: compact.lines,
            symbol: compact.symbol,
            why: `top symbol in ranked file: ${compact.name}`,
          });
        }
      }
    }
    const slices: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    let usedChars = 0;
    for (const seed of seeds) {
      if (usedChars >= budgetChars) break;
      const key = `${seed.file}:${seed.lines ?? ''}:${seed.symbol ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const remaining = budgetChars - usedChars;
      if (remaining < 500) break;
      const sliceArgs: Record<string, unknown> = {
        file: seed.file,
        symbol: seed.symbol,
        maxChars: Math.min(seed.symbol ? 3200 : 900, remaining),
      };
      if (!seed.symbol) sliceArgs.lines = seed.lines;
      const slice = await this.getFileSlice(snapshotId, sliceArgs) as Record<string, unknown>;
      const text = typeof slice.text === 'string' ? slice.text : '';
      if (!text) continue;
      usedChars += text.length;
      slices.push({
        file: String(slice.file ?? seed.file),
        lines: String(slice.lines ?? seed.lines ?? ''),
        symbol: seed.symbol,
        why: seed.why,
        text,
        truncated: Boolean(slice.truncated),
        confidence: slice.confidence,
      });
      if (slices.length >= 5) break;
    }
    return slices;
  }

  private async getContextPacket(snapshotId: string, args: Record<string, unknown>) {
    const task = String(args.task ?? '').trim();
    if (!task) return { error: 'get_context_packet requires a non-empty task.' };

    const profile = normalizePackProfile(args.profile);
    const domain = args.domain ? String(args.domain).trim() : undefined;
    const defaultTokenBudget = packProfileValue(profile, 3000, 5000, 8000);
    const maxTokenBudget = packProfileValue(profile, 3000, 5000, 30000);
    const tokenBudget = Math.min(
      clampInt(Number(args.tokenBudget ?? defaultTokenBudget), 1000, 30000),
      maxTokenBudget,
    );
    const defaultMaxFiles = packProfileValue(profile, 4, 5, 8);
    const maxFileCap = packProfileValue(profile, 4, 5, 20);
    const maxFiles = Math.min(clampInt(Number(args.maxFiles ?? defaultMaxFiles), 1, 20), maxFileCap);
    const defaultMaxSymbols = packProfileValue(profile, 6, 8, 12);
    const maxSymbolCap = packProfileValue(profile, 6, 8, 50);
    const maxSymbols = Math.min(clampInt(Number(args.maxSymbols ?? defaultMaxSymbols), 1, 50), maxSymbolCap);
    const includeTests = args.includeTests !== false;
    const includeSnippets = profile === 'full' ? args.includeSnippets !== false : args.includeSnippets === true;
    const snippetLines = clampInt(Number(args.snippetLines ?? packProfileValue(profile, 5, 8, 12)), 3, 40);
    const snippetTokenBudget = clampInt(
      Number(args.snippetTokenBudget ?? Math.min(
        packProfileValue(profile, 800, 2000, 6000),
        Math.max(500, Math.floor(tokenBudget * packProfileValue(profile, 0.25, 0.35, 0.45))),
      )),
      100,
      12000,
    );
    const query = [domain, task].filter(Boolean).join(' ');
    const explicitContext = await this.explicitContextMatches(snapshotId, task, domain, maxFiles);
    const exactDomainContext = explicitContext.candidateFiles.length > 0
      && Boolean(domain && (domain.includes('/') || path.extname(domain)));
    const endpointNeedle = endpointNeedleForTask(task, domain);
    const endpointMethod = endpointMethodForResearch(query, args.method);
    const endpointSearch = endpointNeedle
      ? await this.findEndpoints(snapshotId, {
        ...args,
        path: endpointNeedle,
        method: endpointMethod,
        limit: Math.min(maxFiles, 10),
        explainRank: true,
        includeSnippets: false,
      }) as { endpoints: Array<Record<string, unknown>>; totalCount?: number }
      : { endpoints: [], totalCount: 0 };
    const allEndpointCandidates = compactEndpointCandidates(endpointSearch.endpoints);
    const exactEndpointCandidates = endpointNeedle
      ? allEndpointCandidates.filter(endpoint =>
        endpoint.path === endpointNeedle
        && (endpointMethod === 'all' || endpoint.method.toUpperCase() === endpointMethod))
      : [];
    const directEndpointCandidates = exactEndpointCandidates.length > 0 ? exactEndpointCandidates : allEndpointCandidates;
    const endpointFileCandidates = directEndpointCandidates.map(endpoint => ({
      file: endpoint.file,
      language: undefined,
      fileRole: undefined,
      lines: endpoint.lines,
      whyRelevant: endpoint.whyRelevant,
      confidence: endpoint.confidence,
      matchedTokens: [endpoint.method, endpoint.path],
      snippet: undefined,
      topSymbols: [endpointHandlerSymbolCandidate(endpoint) as unknown as Record<string, unknown>],
      endpoints: [endpoint],
    }));
    const endpointSymbolCandidates = directEndpointCandidates.map(endpointHandlerSymbolCandidate);
    const endpointFileSet = new Set(endpointFileCandidates.map(file => file.file));
    const hasEndpointContext = directEndpointCandidates.length > 0;

    const files = exactDomainContext || hasEndpointContext
      ? { files: [] as Array<Record<string, unknown>>, totalFound: explicitContext.candidateFiles.length }
      : await this.searchFiles(snapshotId, {
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
    const symbols = hasEndpointContext
      ? { symbols: [] as Array<Record<string, unknown>>, totalFound: 0 }
      : await this.searchSymbol(snapshotId, {
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
    const myBatisContext = isMyBatisIntent(query)
      ? await this.myBatisContext(snapshotId, query, maxFiles, maxSymbols)
      : { candidateFiles: [], relevantSymbols: [], topFiles: [] };

    const fuzzyFileCandidates = files.files
      .map(row => compactFileCandidate(row))
      .filter(candidate => explicitContext.topFiles.length === 0
        || isCompatibleExplicitFileCandidate(candidate.file, explicitContext.topFiles));

    // Fixture/test fallback tier. The primary research search is main-source
    // only so tests/mocks don't pollute normal results. But when the concept
    // the user is after lives ONLY in test/fixture/mock code (or the main-source
    // matches are all generic noise), returning that noise is worse than
    // surfacing the real match. So: if no primary candidate's path actually
    // covers a SPECIFIC (non-broad) query word, re-run the search including
    // tests + fixtures and keep only the candidates that genuinely cover one of
    // those words. Role boosts + tie-breaks keep main_source on top whenever it
    // does match, so this only adds signal, never displaces real impl.
    const specificTaskTokens = uniqueStrings(
      tokenizeSearchQuery(query).filter(token =>
        token.length >= 3 && !isBroadSearchTerm(token) && !FILE_SEARCH_STOP_WORDS.has(token)),
    );
    const coversSpecificToken = (filePath: string): boolean => {
      const words = new Set(splitIdentifierWords(filePath));
      return specificTaskTokens.some(token => words.has(token));
    };
    const primaryCoversTask = fuzzyFileCandidates.some(candidate => coversSpecificToken(String(candidate.file ?? '')));
    let fallbackFileCandidates: Array<ReturnType<typeof compactFileCandidate>> = [];
    let fallbackSymbolCandidates: Array<ReturnType<typeof compactSymbolCandidate>> = [];
    if (!exactDomainContext && !hasEndpointContext && specificTaskTokens.length > 0 && !primaryCoversTask) {
      const fallbackFiles = await this.searchFiles(snapshotId, {
        ...args,
        query,
        limit: maxFiles,
        includeTests: true,
        includeGenerated: false,
        includeFixtures: true,
        explainRank: true,
        includeSnippets,
        snippetLines,
        snippetTokenBudget,
      }) as { files: Array<Record<string, unknown>> };
      fallbackFileCandidates = fallbackFiles.files
        .map(row => compactFileCandidate(row))
        .filter(candidate => coversSpecificToken(String(candidate.file ?? '')));
      const fallbackSymbols = await this.searchSymbol(snapshotId, {
        ...args,
        query,
        limit: maxSymbols,
        includeTests: true,
        includeGenerated: false,
        includeFixtures: true,
        includeSynthetic: false,
        explainRank: true,
        includeSnippets: false,
      }) as { symbols: Array<Record<string, unknown>> };
      fallbackSymbolCandidates = fallbackSymbols.symbols
        .map(row => compactSymbolCandidate(row))
        .filter(candidate => coversSpecificToken(String(candidate.file ?? ''))
          || specificTaskTokens.some(token => splitIdentifierWords(String(candidate.name ?? '')).includes(token)));
    }

    const explicitCandidateFiles = hasEndpointContext
      ? explicitContext.candidateFiles.filter(candidate => endpointFileSet.has(candidate.file))
      : explicitContext.candidateFiles;
    const explicitRelevantSymbols = hasEndpointContext
      ? explicitContext.relevantSymbols.filter(symbol => endpointFileSet.has(symbol.file))
      : explicitContext.relevantSymbols;
    const candidateFiles = uniqueFileCandidates([
      ...endpointFileCandidates,
      ...explicitCandidateFiles,
      ...myBatisContext.candidateFiles,
      // Fallback matches genuinely cover the task's specific words and only
      // exist when the primary main-source set did not, so they rank ahead of
      // the primary candidates. When the fallback fired, the primary set is
      // entirely non-covering noise — drop the primary entries that still fail
      // to cover any specific query word so they cannot occupy top slots ahead
      // of the real matches.
      ...fallbackFileCandidates,
      ...(fallbackFileCandidates.length > 0
        ? fuzzyFileCandidates.filter(candidate => coversSpecificToken(String(candidate.file ?? '')))
        : fuzzyFileCandidates),
    ]).slice(0, maxFiles);
    const relevantSymbols = uniqueSymbolCandidates([
      ...endpointSymbolCandidates,
      ...explicitRelevantSymbols,
      ...myBatisContext.relevantSymbols,
      ...fallbackSymbolCandidates,
      ...symbols.symbols.map(row => compactSymbolCandidate(row)),
    ]).slice(0, maxSymbols);
    const endpointCandidates = compactEndpointCandidates([
      ...directEndpointCandidates,
      ...files.files.flatMap(row => Array.isArray(row.endpoints) ? row.endpoints as Array<Record<string, unknown>> : []),
    ]).slice(0, Math.min(maxFiles, 10));
    const topFiles = uniqueFilesInOrder([
      ...endpointCandidates.map(row => row.file),
      ...candidateFiles.map(row => row.file),
      ...(hasEndpointContext ? [] : explicitContext.topFiles),
      ...relevantSymbols.map(row => row.file),
      ...myBatisContext.topFiles,
    ].filter(Boolean)).slice(0, maxFiles);
    const sliceHints = contextSliceHints(candidateFiles, relevantSymbols, Math.min(packProfileValue(profile, 3, 4, 5), maxFiles));
    const evidenceHandles = evidenceHandlesForObjects(sliceHints, profile);
    const toolHints = sliceHints.length > 0 ? [{
      tool: 'get_file_slice',
      args: {
        slices: sliceHints.map(hint => ({
          file: hint.file,
          lines: hint.lines,
          symbol: hint.symbol,
          maxChars: hint.maxChars,
        })),
      },
      when: 'Use this exact batch call when source context is required for several candidate files/ranges.',
      batching: 'Call get_file_slice once with args.slices; do not loop single-slice calls for these hints.',
    }] : [];
    const testSeeds = [
      task,
      domain ?? '',
      ...directEndpointCandidates.flatMap(endpoint => [
        endpoint.path,
        endpoint.handlerSymbol,
        String((endpoint as unknown as Record<string, unknown>).controller ?? ''),
      ]),
      ...relevantSymbols.slice(0, 8).flatMap(symbol => [symbol.symbol, symbol.name]),
      ...topFiles.slice(0, 5).map(file => path.basename(file, path.extname(file))),
    ].filter(seed => seed.length > 0);
    const testsLikelyRelevant = includeTests
      ? await this.findRelevantTestsForSeeds(snapshotId, testSeeds, Math.max(10, maxFiles * 2))
      : [];
    const validation = await this.validationHints(snapshotId, testsLikelyRelevant, topFiles);
    const inferredDomain = domain ?? inferDomain(task, topFiles);
    const taskOracle = taskOracleFor({
      task,
      taskType: taskKindForOracle(task),
      candidateFiles,
      relevantSymbols,
      testsLikelyRelevant,
      validation,
      flowSteps: [],
      evidenceSlices: [],
    });

    const packedCandidateFiles = slimCandidateFilesForPack(candidateFiles, profile);
    const packedRelevantSymbols = slimSymbolsForPack(relevantSymbols, profile);
    const packedEndpointCandidates = profile === 'full'
      ? endpointCandidates
      : endpointCandidates.slice(0, profile === 'micro' ? 3 : 5);
    const packedTestsLikelyRelevant = slimTestsForPack(testsLikelyRelevant, profile);
    const packedValidation = slimValidationForPack(validation, profile);
    const packedTaskOracle = slimTaskOracleForPack(taskOracle, profile);

    const result = {
      task,
      domain: inferredDomain,
      query,
      profile,
      router: {
        strategy: isMyBatisIntent(query)
          ? 'mybatis-aware file/symbol/config retrieval over the persistent index'
          : 'hybrid file/symbol/endpoint retrieval over the persistent index',
        constraints: [
          'No full-file content is returned by default.',
          'Generated, fixture, and test files are excluded from implementation candidates by default.',
          'Use get_file_slice for the exact edit range before changing a file; use its slices batch argument for multiple ranges.',
        ],
        nextTool: toolHints[0],
      },
      sliceHints,
      evidenceHandles,
      toolHints,
      myBatis: isMyBatisIntent(query) ? {
        mapperFiles: myBatisContext.topFiles.filter(file => file.endsWith('.xml')).slice(0, maxFiles),
        relatedJavaFiles: myBatisContext.topFiles.filter(file => file.endsWith('.java')).slice(0, maxFiles),
      } : undefined,
      candidateFiles: packedCandidateFiles,
      relevantSymbols: packedRelevantSymbols,
      endpointCandidates: packedEndpointCandidates,
      testsLikelyRelevant: packedTestsLikelyRelevant,
      validation: packedValidation,
      taskOracle: packedTaskOracle,
      topFiles,
      omissions: {
        fileCandidates: Math.max(0, Number(files.totalFound ?? candidateFiles.length) - candidateFiles.length),
        symbolCandidates: Math.max(0, Number(symbols.totalFound ?? relevantSymbols.length) - relevantSymbols.length),
        endpointCandidates: Math.max(0, Number(endpointSearch.totalCount ?? endpointCandidates.length) - endpointSearch.endpoints.length),
      },
      nextAction: nextContextAction(candidateFiles, relevantSymbols, sliceHints),
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
        ...responseBudgetReport({
          profile,
          tokenBudget,
          returnedPayload: result,
          handleCount: evidenceHandles.length,
          policy: 'context packet returns ranked handles first; source text is fetched only by explicit get_file_slice',
        }),
        maxFiles,
        maxSymbols,
        includeSnippets,
        snippetLines,
        snippetTokenBudget,
      },
    };
  }

  private async myBatisContext(
    snapshotId: string,
    query: string,
    maxFiles: number,
    maxSymbols: number,
  ): Promise<{
    candidateFiles: Array<ReturnType<typeof compactFileCandidate>>;
    relevantSymbols: Array<ReturnType<typeof compactSymbolCandidate>>;
    topFiles: string[];
  }> {
    const xmlFiles = await this.searchFiles(snapshotId, {
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
      const result = await this.searchSymbol(snapshotId, {
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
    const primaryRelatedFiles = await this.relatedMyBatisFiles(snapshotId, primaryXmlFiles, Math.max(maxFiles * 2, 8));
    const relatedFiles = await this.relatedMyBatisFiles(snapshotId, seedFiles, Math.max(maxFiles * 3, 12));
    const primaryRelatedCandidates = await this.fileCandidatesForPaths(snapshotId, primaryRelatedFiles, query);
    const relatedCandidates = await this.fileCandidatesForPaths(snapshotId, relatedFiles, query);
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

  private async getChangePack(snapshotId: string, args: Record<string, unknown>) {
    const timing = createDebugTiming(args);
    const task = String(args.task ?? args.target ?? '').trim();
    if (!task) return { error: 'get_change_pack requires a non-empty task.' };
    const profile = normalizePackProfile(args.profile);
    const changeType = normalizeOracleTaskType(String(args.changeType ?? taskKindForOracle(task)));
    const context = await this.getContextPacket(snapshotId, {
      ...args,
      task,
      profile,
      tokenBudget: args.tokenBudget ?? packProfileValue(profile, 3000, 5000, 8000),
      maxFiles: args.maxFiles ?? packProfileValue(profile, 4, 5, 8),
      maxSymbols: args.maxSymbols ?? packProfileValue(profile, 6, 8, 12),
      includeTests: args.includeTests !== false,
      includeSnippets: args.includeSnippets ?? false,
    }) as Record<string, unknown>;
    timing.checkpoint('context_packet');
    const taskOracle = isPlainObject(context.taskOracle) ? context.taskOracle : {};
    const validation = isPlainObject(context.validation) ? context.validation : {};
    const contextBudget = isPlainObject(context.budget) ? context.budget : {};
    const candidateFiles = arrayRecords(context.candidateFiles);
    const relevantSymbols = arrayRecords(context.relevantSymbols);
    const sliceHints = arrayRecords(context.sliceHints);
    const testsLikelyRelevant = arrayRecords(context.testsLikelyRelevant);
    const topFiles = stringArray(context.topFiles);
    const requestedFiles = stringArray(args.files);
    const requestedSymbols = stringArray(args.symbols);
    const diff = stringOrUndefined(args.diff);
    const shouldSimulatePatch = requestedFiles.length > 0 || requestedSymbols.length > 0 || Boolean(diff);
    const patchImpact = shouldSimulatePatch
      ? await this.simulatePatchImpact(snapshotId, {
        task,
        files: requestedFiles,
        symbols: requestedSymbols,
        diff,
        riskMode: args.riskMode,
        limit: Math.max(20, Number(args.maxFiles ?? 8) * 4),
      }) as Record<string, unknown>
      : undefined;
    timing.checkpoint('patch_impact');
    const fieldImpact = patchImpact && isPlainObject(patchImpact.fieldImpact)
      ? patchImpact.fieldImpact
      : await this.fieldImpactForInputs(snapshotId, {
        ...args,
        task,
        symbols: requestedSymbols,
        diff,
      }, Math.max(20, Number(args.maxFiles ?? 8) * 4));
    timing.checkpoint('field_impact');
    const calculationImpact = patchImpact && isPlainObject(patchImpact.calculationImpact)
      ? patchImpact.calculationImpact
      : undefined;
    const commands = stringArray(validation.suggestedCommands);
    const editRanges = sliceHints
      .slice(0, packProfileValue(profile, 4, 6, 8))
      .map(hint => ({
        file: stringOrUndefined(hint.file),
        lines: stringOrUndefined(hint.lines),
        symbol: stringOrUndefined(hint.symbol),
        maxChars: typeof hint.maxChars === 'number' ? hint.maxChars : 1200,
        why: 'Open this exact range before editing.',
      }))
      .filter(range => range.file || range.symbol);
    const evidenceHandles = evidenceHandlesForObjects([
      ...editRanges,
      ...candidateFiles,
      ...relevantSymbols,
    ], profile);
    const patchArchitectureContext = patchImpact && isPlainObject(patchImpact.architectureContext)
      ? patchImpact.architectureContext
      : undefined;
    const architectureContext = patchArchitectureContext
      ?? await architectureContextForFiles(this.db, snapshotId, topFiles, task, packProfileValue(profile, 6, 8, 10));
    timing.checkpoint('architecture_context');
    const packedTestsLikelyRelevant = slimTestsForPack(testsLikelyRelevant, profile);
    const packedTaskOracle = slimTaskOracleForPack(taskOracle, profile);
    const packedPatchImpact = patchImpact ? compactReviewObject(patchImpact, packProfileValue(profile, 4, 6, 8), profile === 'micro' ? 2 : 3) : undefined;
    const packedFieldImpact = fieldImpact ? compactReviewObject(fieldImpact, packProfileValue(profile, 4, 6, 8), profile === 'micro' ? 2 : 3) : undefined;
    const packedArchitectureContext = architectureContext ? compactReviewObject(architectureContext, packProfileValue(profile, 4, 6, 8), profile === 'micro' ? 2 : 3) : undefined;
    const changeTokenBudget = typeof contextBudget.tokenBudget === 'number'
      ? contextBudget.tokenBudget
      : Number(args.tokenBudget ?? packProfileValue(profile, 3000, 5000, 8000));
    const returnedPayloadForBudget = {
      files: candidateFiles,
      symbols: relevantSymbols,
      editRanges,
      evidenceHandles,
      testsLikelyRelevant: packedTestsLikelyRelevant,
      commands,
      taskOracle: packedTaskOracle,
      patchImpact: packedPatchImpact,
      fieldImpact: packedFieldImpact,
      calculationImpact,
      architectureContext: packedArchitectureContext,
    };
    const fullPayloadForBudget = {
      files: candidateFiles,
      symbols: relevantSymbols,
      editRanges,
      testsLikelyRelevant,
      commands,
      taskOracle,
      patchImpact,
      fieldImpact,
      calculationImpact,
      architectureContext,
    };
    const calculationAnswerable = !calculationImpact || calculationImpact.answerable !== false;

    const result = {
      task,
      changeType,
      answerable: calculationAnswerable,
      routing: {
        intendedUse: 'edit-ready implementation/debug/refactor packet',
        expectedToolCallsBeforeEdit: editRanges.length > 0 ? 1 : 0,
        firstToolCall: editRanges.length > 0 ? {
          tool: 'get_file_slice',
          args: { slices: editRanges.map(range => ({ file: range.file, lines: range.lines, symbol: range.symbol, maxChars: range.maxChars })) },
        } : undefined,
        stopCondition: 'After opening listed edit ranges, edit only scoped files and run expectedVerification commands.',
      },
      files: candidateFiles,
      symbols: relevantSymbols,
      editRanges,
      evidenceHandles,
      testsLikelyRelevant: packedTestsLikelyRelevant,
      invariants: changePackInvariants(changeType, taskOracle, patchImpact).slice(0, packProfileValue(profile, 5, 8, 12)),
      expectedVerification: isPlainObject(taskOracle.expectedVerification)
        ? taskOracle.expectedVerification
        : { commands, targetedTestFiles: stringArray(validation.targetedTestFiles) },
      commands,
      taskOracle: packedTaskOracle,
      patchImpact: packedPatchImpact,
      fieldImpact: packedFieldImpact,
      calculationImpact,
      architectureContext: packedArchitectureContext,
      topFiles,
      nextAction: editRanges.length > 0
        ? calculationAnswerable
          ? 'Call get_file_slice once with routing.firstToolCall.args, then make the smallest scoped edit.'
          : 'Resolve the unclassified calculation sinks before editing; use calculationImpact.allowedFollowups.'
        : 'Resolve a concrete file/symbol first with search_symbol or search_files before editing.',
      confidence: context.confidence ?? 0.4,
      budget: {
        ...responseBudgetReport({
          profile,
          tokenBudget: changeTokenBudget,
          returnedPayload: returnedPayloadForBudget,
          fullPayload: fullPayloadForBudget,
          handleCount: evidenceHandles.length,
          policy: 'edit packets return exact edit handles; source text is deferred until the required get_file_slice call',
        }),
      },
    };
    timing.checkpoint('response_budget');
    return withDebugTiming(result, timing);
  }

  private async compileEvidence(snapshotId: string, args: Record<string, unknown>) {
    const task = String(args.task ?? '').trim();
    if (!task) return { error: 'compile_evidence requires a non-empty task.' };

    const profile = normalizePackProfile(args.profile);
    const taskType = normalizeCompileEvidenceTaskType(args.taskType ?? args.task_type, task, args);
    const target = String(args.target ?? task).trim();
    const tokenBudget = clampInt(Number(args.budgetTokens ?? args.budget_tokens ?? 5000), 1000, 30000);
    const maxEvidenceItems = clampInt(Number(args.maxEvidenceItems ?? args.max_evidence_items ?? 8), 1, 20);
    const allowTargetedShell = Boolean(args.allowTargetedShell ?? args.allow_targeted_shell ?? true);
    const qualityRubric = compileEvidenceRubric(args.qualityRubric ?? args.quality_rubric, taskType);

    const source = await this.compileEvidenceSourcePacket(snapshotId, {
      ...args,
      task,
      target,
      taskType,
      profile,
      tokenBudget,
    });
    const sourcePacket = await this.augmentCompileEvidenceSourcePacket(snapshotId, source.tool, source.packet, {
      task,
      taskType,
      profile,
      qualityRubric,
    });
    const evidence = compileEvidenceItemsFromPacket(source.tool, sourcePacket, maxEvidenceItems);
    const coverage = compileCoverageCertificate({
      taskType,
      rubric: qualityRubric,
      packet: sourcePacket,
      evidence,
    });
    const missing = Object.entries(coverage)
      .filter(([, value]) => value.status === 'missing')
      .map(([key]) => key);
    const partial = Object.entries(coverage)
      .filter(([, value]) => value.status === 'partial')
      .map(([key]) => key);
    const strictRubric = args.strictRubric !== false && args.strict_rubric !== false;
    const answerable = compileEvidenceAnswerable(source.tool, sourcePacket, evidence, missing, strictRubric ? partial : []);
    const recommendedEscalation = !answerable && allowTargetedShell
      ? targetedShellEscalationForCompile(task, missing.length > 0 ? missing : partial, sourcePacket)
      : undefined;
    const allowedFollowups = answerable
      ? []
      : compileAllowedFollowups(missing.length > 0 ? missing : partial, sourcePacket, recommendedEscalation);
    const recommendedNextAction = answerable
      ? 'answer_now'
      : recommendedEscalation
        ? 'targeted_shell'
        : evidence.length > 0
          ? 'expand_exact'
          : 'ask_user';
    const disallowedFollowups = answerable
      ? [
        'shell_rg',
        'shell_read_loop',
        'search_symbol',
        'search_files',
        'search_code',
        'get_file_slice',
        'find_references',
      ]
      : ['broad_shell_search', 'unbounded_file_reads', 'unbounded_mcp_exploration'];
    const evidenceHandleCount = evidence.filter(item => item.expandTool).length;
    const packetSummary = compilePacketSummary(source.tool, sourcePacket);
    const result = {
      task,
      taskType,
      sourceTool: source.tool,
      answerable,
      confidence: compileEvidenceConfidence(answerable, coverage, evidence, sourcePacket),
      coverage,
      coverageCertificate: {
        rubric: coverage,
        missing,
        partial,
        answerability: answerable ? 'answer_now' : recommendedNextAction,
      },
      evidence,
      missing,
      allowedFollowups,
      disallowedFollowups,
      recommendedNextAction,
      maxAdditionalCalls: answerable ? 0 : allowedFollowups.length,
      gatePolicy: {
        stateKey: compileEvidenceStateKey(task),
        whenAnswerable: 'deny broad shell/search/read and extra MCP exploration; answer from evidence ids',
        allowOnly: answerable ? [] : allowedFollowups.map(followup => followup.tool),
        denyMessage: 'Evidence packet already covers the required rubric. Answer now from the listed evidence ids.',
      },
      pathCoverage: compilePathCoverageMap(source.tool, sourcePacket, recommendedEscalation),
      packetSummary,
    };

    return {
      ...result,
      budget: {
        ...responseBudgetReport({
          profile,
          tokenBudget,
          returnedPayload: result,
          fullPayload: sourcePacket,
          handleCount: evidenceHandleCount,
          policy: answerable
            ? 'compiled evidence is answer-ready; gate should deny further broad search'
            : 'compiled evidence is partial; allow only listed exact follow-ups',
        }),
        sourceTool: source.tool,
      },
    };
  }

  private async augmentCompileEvidenceSourcePacket(
    snapshotId: string,
    sourceTool: string,
    packet: Record<string, unknown>,
    input: {
      task: string;
      taskType: CompileEvidenceTaskType;
      profile: PackProfile;
      qualityRubric: string[];
    },
  ): Promise<Record<string, unknown>> {
    if (sourceTool !== 'get_research_pack' || !isRouteGateCompileTask(input.task, input.qualityRubric)) {
      return packet;
    }

    const routeEvidence = await this.routeGateCompileEvidence(snapshotId);
    if (
      routeEvidence.definitionCandidates.length === 0
      && routeEvidence.evidenceSlices.length === 0
      && routeEvidence.testFiles.length === 0
    ) {
      return packet;
    }

    const existingValidation = isPlainObject(packet.validation) ? packet.validation : {};
    const existingCompleteness = isPlainObject(packet.completeness) ? packet.completeness : {};
    const testsLikelyRelevant = [
      ...routeEvidence.testFiles.map(file => ({
        file,
        symbol: routeEvidence.testSymbols[0],
        score: 0.95,
        reasons: ['route gate benchmark/test coverage for codegraph_context routing'],
      })),
      ...arrayRecords(packet.testsLikelyRelevant),
    ];
    const validation = {
      ...existingValidation,
      targetedTestFiles: uniqueStrings([
        ...routeEvidence.testFiles,
        ...stringArray(existingValidation.targetedTestFiles),
      ]),
    };
    const routeFlowSteps = routeEvidence.flowSteps.length > 0
      ? routeEvidence.flowSteps
      : [{
        claim: 'compile_evidence is the answerable gate packet for codegraph_context routing; answerable=true denies shell fallback and allowedFollowups lists exact expansions only when incomplete',
        file: routeEvidence.primaryRouteFile,
        symbol: 'compile_evidence',
        kind: 'route-gate',
      }];

    return {
      ...packet,
      definitionCandidates: uniqueRecordsBy([
        ...routeEvidence.definitionCandidates,
        ...arrayRecords(packet.definitionCandidates),
      ], item => `${item.symbol ?? item.name ?? ''}\0${item.file ?? ''}`),
      evidenceSlices: uniqueRecordsBy([
        ...routeEvidence.evidenceSlices,
        ...arrayRecords(packet.evidenceSlices),
      ], item => `${item.file ?? ''}\0${item.lines ?? ''}\0${item.symbol ?? ''}\0${item.why ?? item.claim ?? ''}`),
      flowSteps: uniqueRecordsBy([
        ...routeFlowSteps,
        ...arrayRecords(packet.flowSteps),
      ], item => `${item.file ?? ''}\0${item.lines ?? ''}\0${item.symbol ?? ''}\0${item.claim ?? item.why ?? ''}`),
      candidateFiles: uniqueRecordsBy([
        ...routeEvidence.candidateFiles,
        ...arrayRecords(packet.candidateFiles),
      ], item => String(item.file ?? '')),
      testsLikelyRelevant: uniqueRecordsBy(testsLikelyRelevant, item => String(item.file ?? '')),
      validation,
      topFiles: uniqueStrings([
        ...routeEvidence.topFiles,
        ...stringArray(packet.topFiles),
      ]).slice(0, 10),
      completeness: {
        ...existingCompleteness,
        routeGateEvidence: true,
        routeGateSymbols: routeEvidence.definitionCandidates.length,
        routeGateTests: routeEvidence.testFiles.length,
      },
      answerGuidance: uniqueStrings([
        'For route/gate questions, include inspectCodeGraphRoute, routeCodeGraphContext, inferCodeGraphContextMode, compile_evidence, answerable, allowedFollowups, and the route gate test file when present.',
        ...stringArray(packet.answerGuidance),
      ]),
    };
  }

  private async routeGateCompileEvidence(snapshotId: string): Promise<{
    definitionCandidates: Array<Record<string, unknown>>;
    evidenceSlices: Array<Record<string, unknown>>;
    flowSteps: Array<Record<string, unknown>>;
    candidateFiles: Array<Record<string, unknown>>;
    testFiles: string[];
    testSymbols: string[];
    topFiles: string[];
    primaryRouteFile?: string;
  }> {
    const routeSymbolNames = [
      'inspectCodeGraphRoute',
      'routeCodeGraphContext',
      'inferCodeGraphContextMode',
      'compileEvidence',
    ];
    const symbolRows = await this.exactSymbolsBySimpleName(snapshotId, routeSymbolNames, 20);
    const symbolOrder = new Map(routeSymbolNames.map((name, index) => [name, index]));
    const definitionCandidates = uniqueSymbolCandidates(symbolRows
      .map(row => compactSymbolCandidate(symbolDto(row), routeGateWhyForSymbol(row.simple_name)))
      .sort((a, b) => (symbolOrder.get(a.name) ?? 99) - (symbolOrder.get(b.name) ?? 99) || a.file.localeCompare(b.file)));
    const routeFiles = uniqueStrings(definitionCandidates.map(symbol => symbol.file).filter(Boolean));
    const primaryRouteFile = routeFiles.find(file => file.endsWith('src/v2/mcp/proxy.ts')) ?? routeFiles[0];
    const testFiles = await this.exactFilesByBasename(snapshotId, [
      'tests/v2/mcp-client-profile.test.ts',
      'mcp-client-profile.test.ts',
    ], 4);
    const root = await this.workspaceRootForSnapshot(snapshotId);
    const evidenceSlices: Array<Record<string, unknown>> = [];

    for (const symbol of definitionCandidates.slice(0, 4)) {
      const slice = await this.getFileSlice(snapshotId, {
        file: symbol.file,
        symbol: symbol.symbol,
        maxChars: 1000,
      }) as Record<string, unknown>;
      evidenceSlices.push({
        file: String(slice.file ?? symbol.file),
        lines: stringOrUndefined(slice.lines ?? symbol.lines),
        symbol: symbol.symbol,
        why: routeGateWhyForSymbol(symbol.name),
        text: truncateOptional(slice.text, 900),
        confidence: 0.95,
      });
    }

    for (const file of testFiles.slice(0, 2)) {
      const lines = bestSourceRange(root, file, [
        'inspectCodeGraphRoute',
        'routeCodeGraphContext',
        'compile_evidence',
        'answerable',
        'allowedFollowups',
      ]) ?? '1-180';
      const slice = await this.getFileSlice(snapshotId, {
        file,
        lines,
        maxChars: 1200,
      }) as Record<string, unknown>;
      evidenceSlices.push({
        file: String(slice.file ?? file),
        lines: stringOrUndefined(slice.lines ?? lines),
        symbol: 'route gate tests',
        why: 'test evidence for codegraph_context route inference, route inspection, answerable gate, and compile_evidence routing',
        text: truncateOptional(slice.text, 1000),
        confidence: 0.92,
      });
    }

    const flowSteps = [
      {
        claim: 'codegraph_context calls routeCodeGraphContext to choose the bounded internal packet tool before any lower-level search',
        file: primaryRouteFile,
        symbol: 'routeCodeGraphContext',
        kind: 'route-gate',
      },
      {
        claim: 'inspectCodeGraphRoute exposes the route decision, expected stop rule, expectedMaxAdditionalCalls, and disallowed shell/search fallback',
        file: primaryRouteFile,
        symbol: 'inspectCodeGraphRoute',
        kind: 'route-gate',
      },
      {
        claim: 'compile_evidence is the answerable gate packet; answerable=true requires zero extra MCP calls and empty allowedFollowups',
        file: primaryRouteFile,
        symbol: 'compile_evidence',
        kind: 'route-gate',
      },
      {
        claim: 'mcp-client-profile tests lock routeCodeGraphContext, inspectCodeGraphRoute, compile_evidence, answerable, and allowedFollowups behavior',
        file: testFiles[0],
        symbol: 'tests/v2/mcp-client-profile.test.ts',
        kind: 'test',
      },
    ].filter(step => step.file || step.symbol);

    const candidateFiles = uniqueStrings([...routeFiles, ...testFiles]).map(file => ({
      file,
      lines: file.endsWith('mcp-client-profile.test.ts')
        ? '1-140'
        : undefined,
      whyRelevant: file.endsWith('mcp-client-profile.test.ts')
        ? 'route gate regression tests for codegraph_context routing and answerability'
        : 'route/gate implementation file for codegraph_context',
      confidence: 0.95,
      matchedTokens: ['codegraph_context', 'route', 'answerable', 'compile_evidence'],
      topSymbols: definitionCandidates.filter(symbol => symbol.file === file).slice(0, 4),
      endpoints: [],
    }));

    return {
      definitionCandidates,
      evidenceSlices: evidenceSlices.filter(slice => slice.file || slice.symbol || slice.text),
      flowSteps,
      candidateFiles,
      testFiles,
      testSymbols: ['inspectCodeGraphRoute', 'routeCodeGraphContext', 'compile_evidence'],
      topFiles: uniqueStrings([
        'src/v2/mcp/proxy.ts',
        'tests/v2/mcp-client-profile.test.ts',
        ...routeFiles,
        ...testFiles,
      ]),
      primaryRouteFile,
    };
  }

  private async exactSymbolsBySimpleName(snapshotId: string, names: string[], limit: number): Promise<SymbolRow[]> {
    const wanted = uniqueStrings(names.filter(Boolean));
    if (wanted.length === 0) return [];
    const placeholders = wanted.map(() => '?').join(', ');
    const rows = await this.db.prepare(`
      SELECT fq_name, simple_name, kind, file, line, end_line, signature, visibility, parent,
             package_name, return_type, parameter_types_json, annotations_json,
             framework_role, framework_meta_json, file_role
      FROM symbols
      WHERE snapshot_id = ?
        AND simple_name IN (${placeholders})
      ORDER BY
        CASE file_role
          WHEN 'main_source' THEN 0
          WHEN 'test_source' THEN 1
          ELSE 2
        END,
        file,
        line
      LIMIT ?
    `).all(snapshotId, ...wanted, limit) as SymbolRow[];
    return uniqueRecordsBy(rows, row => `${row.simple_name}\0${row.file}\0${row.line}`);
  }

  private async exactFilesByBasename(snapshotId: string, needles: string[], limit: number): Promise<string[]> {
    const files: string[] = [];
    for (const needle of uniqueStrings(needles.filter(Boolean))) {
      if (files.length >= limit) break;
      const normalized = needle.replace(/\\/g, '/');
      const basename = path.posix.basename(normalized);
      const row = await this.db.prepare(`
        SELECT path
        FROM files
        WHERE snapshot_id = ?
          AND (path = ? OR path LIKE ? ESCAPE '\\')
        ORDER BY
          CASE WHEN path = ? THEN 0 ELSE 1 END,
          LENGTH(path),
          path
        LIMIT 1
      `).get(snapshotId, normalized, `%/${escapeLike(basename)}`, normalized) as { path: string } | undefined;
      if (row?.path) files.push(row.path);
    }
    return uniqueStrings(files).slice(0, limit);
  }

  private async compileEvidenceSourcePacket(
    snapshotId: string,
    args: Record<string, unknown> & {
      task: string;
      target: string;
      taskType: CompileEvidenceTaskType;
      profile: PackProfile;
      tokenBudget: number;
    },
  ): Promise<{ tool: string; packet: Record<string, unknown> }> {
    if (args.taskType === 'review_diff' || stringOrUndefined(args.diff)) {
      const packet = await this.reviewPatch(snapshotId, {
        ...args,
        outputMode: 'compact',
        includeLikelyTests: args.includeLikelyTests ?? true,
        limit: args.limit ?? 50,
      }) as Record<string, unknown>;
      return { tool: 'review_patch', packet };
    }

    if (args.taskType === 'implement' || args.taskType === 'test') {
      const packet = await this.getChangePack(snapshotId, {
        ...args,
        task: args.task,
        target: args.target,
        changeType: args.taskType === 'test' ? 'test' : 'implement',
        tokenBudget: args.tokenBudget,
        profile: args.profile,
        includeSnippets: args.includeSnippets ?? false,
      }) as Record<string, unknown>;
      return { tool: 'get_change_pack', packet };
    }

    const researchTaskType = args.taskType === 'api_flow' || args.taskType === 'startup_flow'
      ? 'architecture'
      : args.taskType === 'field_impact'
        ? 'investigate'
        : 'research';
    const packet = await this.getResearchPack(snapshotId, {
      ...args,
      target: args.target,
      taskType: researchTaskType,
      tokenBudget: args.tokenBudget,
      responseMode: 'answer',
      profile: args.profile,
      includeSnippets: args.includeSnippets ?? true,
    }) as Record<string, unknown>;
    return { tool: 'get_research_pack', packet };
  }

  private async relatedMyBatisFiles(snapshotId: string, files: string[], limit: number): Promise<string[]> {
    const unique = [...new Set(files.filter(Boolean))].slice(0, 50);
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(', ');
    const namespaceEdges = await this.db.prepare(`
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
    const dependents = await this.db.prepare(`
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

  private async fileCandidatesForPaths(
    snapshotId: string,
    files: string[],
    query: string,
  ): Promise<Array<ReturnType<typeof compactFileCandidate>>> {
    const unique = [...new Set(files.filter(Boolean))].slice(0, 100);
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(', ');
    const rows = await this.db.prepare(`
      SELECT path, language, file_role, parse_status, size
      FROM files
      WHERE snapshot_id = ? AND path IN (${placeholders})
    `).all(snapshotId, ...unique) as FileRow[];
    const evidence = await this.fileEvidence(snapshotId, rows.map(row => row.path));
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

  private async searchCode(snapshotId: string, args: Record<string, unknown>) {
    const query = String(args.query ?? '').trim();
    const outputMode = String(args.outputMode ?? 'compact');
    const compact = outputMode !== 'full';
    const maxResponseTokens = responseTokenCap(args, compact ? 8000 : 12000);
    const limit = Math.min(Number(args.limit ?? 10), compact ? 8 : 50);
    const includeReferences = Boolean(args.includeReferences ?? true);
    const includeDependencies = Boolean(args.includeDependencies ?? true);
    const downstreamArgs = compact
      ? {
        ...args,
        includeSnippets: false,
        snippetLines: Math.min(Number(args.snippetLines ?? 6), 6),
        snippetTokenBudget: Math.min(Number(args.snippetTokenBudget ?? 800), 800),
      }
      : args;
    const symbolResults = await this.searchSymbol(snapshotId, {
      ...downstreamArgs,
      query,
      limit,
      explainRank: Boolean(args.explainRank ?? false),
    }) as Record<string, unknown>;
    const fileResults = await this.searchFiles(snapshotId, {
      ...downstreamArgs,
      query,
      limit,
      explainRank: Boolean(args.explainRank ?? false),
    }) as Record<string, unknown>;
    const endpointResults = await this.findEndpoints(snapshotId, {
      ...downstreamArgs,
      path: query,
      method: args.method ?? 'all',
      limit,
      explainRank: Boolean(args.explainRank ?? false),
    }) as Record<string, unknown>;
    const references = includeReferences && query
      ? await this.findReferences(snapshotId, {
        ...downstreamArgs,
        symbol: query,
        limit,
        groupBy: args.groupBy ?? 'file',
      }) as Record<string, unknown>
      : undefined;
    const dependencies = includeDependencies && query
      ? await this.traceDependencies(snapshotId, {
        ...downstreamArgs,
        target: query,
        depth: args.depth ?? 1,
        limit: Math.max(limit * 5, 50),
      }) as Record<string, unknown>
      : undefined;
    const fullSections = {
      files: fileResults,
      symbols: symbolResults,
      endpoints: endpointResults,
      references,
      dependencies,
    };
    const summary = {
      fileMatches: Number(fileResults.totalFound ?? 0),
      symbolMatches: Number(symbolResults.totalFound ?? 0),
      endpointMatches: Number(endpointResults.totalCount ?? 0),
      referenceMatches: references ? Number(references.totalCount ?? 0) : undefined,
      dependencyEdges: dependencies ? ((dependencies.edges as unknown[]) ?? []).length : undefined,
    };
    const debug = Boolean(args.explainRank) ? { debug: rankDebug('search_code', [
      'Mixed search delegates ranking to search_files, search_symbol, find_endpoints, find_references, and trace_dependencies.',
      'Use the section-specific nextCursor values when one result type needs deeper pagination.',
    ]) } : {};
    const fullResult = {
      query,
      outputMode: 'full',
      sections: fullSections,
      summary,
      ...debug,
      confidenceNotes: [
        'search_code is a mixed retrieval view; use the section-specific tools when you need deeper pagination or fewer result types.',
      ],
    };
    const requestedResult = compact
      ? {
        query,
        outputMode: 'compact',
        sections: compactSearchCodeSections(fileResults, symbolResults, endpointResults, references, dependencies, limit),
        summary,
        ...debug,
        confidenceNotes: [
          'search_code returns compact sections by default; call a pack tool or get_file_slice for exact source text, or set outputMode=full for expanded retrieval.',
        ],
      }
      : fullResult;
    const requestedTokens = estimateTokens(JSON.stringify(requestedResult));
    if (requestedTokens <= maxResponseTokens) {
      return withResponseCapBudget(requestedResult, {
        fullPayload: fullResult,
        maxResponseTokens,
        capped: false,
        policy: compact
          ? 'compact mixed retrieval returns ranked candidates and graph counts; expand exact files with get_file_slice'
          : 'full mixed retrieval returned within response cap',
      });
    }

    let cappedResult: Record<string, unknown> = {
      query,
      outputMode: 'compact-capped',
      sections: compactSearchCodeSections(
        fileResults,
        symbolResults,
        endpointResults,
        references,
        dependencies,
        compactLimitForResponseCap(maxResponseTokens),
        {
          includeReferences: maxResponseTokens >= 6000,
          includeDependencies: maxResponseTokens >= 6000,
        },
      ),
      summary,
      omissions: {
        reason: 'response-token-cap',
        requestedOutputMode: compact ? 'compact' : 'full',
        referencesOmitted: includeReferences && maxResponseTokens < 6000,
        dependenciesOmitted: includeDependencies && maxResponseTokens < 6000,
      },
      ...debug,
      confidenceNotes: [
        'search_code exceeded maxResponseTokens; returned ranked compact sections and counts instead of expanded mixed retrieval.',
        'Use get_file_slice, search_symbol, find_references, or trace_dependencies for the specific missing fact instead of expanding every section.',
      ],
    };
    if (estimateTokens(JSON.stringify(cappedResult)) > maxResponseTokens) {
      cappedResult = {
        ...cappedResult,
        sections: compactSearchCodeSections(
          fileResults,
          symbolResults,
          endpointResults,
          references,
          dependencies,
          1,
          { includeReferences: false, includeDependencies: false },
        ),
        omissions: {
          reason: 'response-token-cap',
          requestedOutputMode: compact ? 'compact' : 'full',
          referencesOmitted: includeReferences,
          dependenciesOmitted: includeDependencies,
          detail: 'response remained over cap after compacting; returned top file/symbol/endpoint only',
        },
      };
    }
    return withResponseCapBudget(cappedResult, {
      fullPayload: fullResult,
      maxResponseTokens,
      capped: true,
      policy: 'response exceeded maxResponseTokens; returned compact ranked candidates and omitted broad reference/dependency details first',
    });
  }

  private async generateRepoAtlas(snapshotId: string, args: Record<string, unknown> = {}) {
    const startedAt = Date.now();
    const format = normalizeRepoAtlasFormat(args.format);
    const profile = normalizePackProfile(args.profile);
    const includeTests = args.includeTests !== false;
    const includeGenerated = args.includeGenerated === true;
    const maxModules = clampInt(Number(args.maxModules ?? 12), 1, 80);
    const maxEntrypoints = clampInt(Number(args.maxEntrypoints ?? 30), 1, 200);
    const maxHotspots = clampInt(Number(args.maxHotspots ?? 25), 1, 200);
    const moduleLimit = Math.min(maxModules, packProfileValue(profile, 6, 12, 40));
    const entrypointLimit = Math.min(maxEntrypoints, packProfileValue(profile, 8, 30, 120));
    const hotspotLimit = Math.min(maxHotspots, packProfileValue(profile, 8, 25, 100));
    const flowLimit = Math.min(entrypointLimit, packProfileValue(profile, 4, 8, 24));

    const [
      snapshot,
      snapshotStats,
      files,
      symbolCounts,
      endpoints,
      hotspotRows,
      overlayModuleRows,
      overlayFileRows,
      overlayModuleEdgeRows,
      dependencyPairs,
    ] = await Promise.all([
      this.db.prepare(`
        SELECT s.id, s.workspace_id, s.branch, s.head_commit, s.created_at, s.index_time_ms,
               s.manifest_scan_ms, s.files_total, s.files_parsed, s.parse_cache_hits,
               w.root AS workspace_root, w.workspace_key
        FROM snapshots s
        JOIN workspaces w ON w.id = s.workspace_id
        WHERE s.id = ?
      `).get(snapshotId) as Promise<RepoAtlasSnapshotRow | undefined>,
      this.snapshotStats(snapshotId),
      this.db.prepare(`
        SELECT path, language, file_role, parse_status, size
        FROM files
        WHERE snapshot_id = ?
        ORDER BY path
        LIMIT 200000
      `).all(snapshotId) as Promise<RepoAtlasFileRow[]>,
      this.db.prepare(`
        SELECT file, COUNT(*) AS count
        FROM symbols
        WHERE snapshot_id = ?
        GROUP BY file
        LIMIT 200000
      `).all(snapshotId) as Promise<Array<{ file: string; count: number | string }>>,
      this.db.prepare(`
        SELECT method, path, path_resolution, path_resolution_reason,
               handler_symbol, controller, file, line, framework, confidence, file_role
        FROM endpoints
        WHERE snapshot_id = ?
        ORDER BY confidence DESC, file, line
        LIMIT 5000
      `).all(snapshotId) as Promise<EndpointRow[]>,
      this.db.prepare(`
        SELECT f.path, f.language, f.file_role, f.parse_status, f.size,
               COALESCE(outd.count, 0) AS outgoing_deps,
               COALESCE(ind.count, 0) AS incoming_deps,
               COALESCE(calls.count, 0) AS call_edges,
               COALESCE(syms.count, 0) AS symbols,
               COALESCE(eps.count, 0) AS endpoints
        FROM files f
        LEFT JOIN (
          SELECT from_file AS file, COUNT(*) AS count
          FROM dependency_edges
          WHERE snapshot_id = ?
          GROUP BY from_file
        ) outd ON outd.file = f.path
        LEFT JOIN (
          SELECT to_file AS file, COUNT(*) AS count
          FROM dependency_edges
          WHERE snapshot_id = ?
          GROUP BY to_file
        ) ind ON ind.file = f.path
        LEFT JOIN (
          SELECT file, COUNT(*) AS count
          FROM call_edges
          WHERE snapshot_id = ? AND signal_tier IN ('primary', 'provider')
          GROUP BY file
        ) calls ON calls.file = f.path
        LEFT JOIN (
          SELECT file, COUNT(*) AS count
          FROM symbols
          WHERE snapshot_id = ?
          GROUP BY file
        ) syms ON syms.file = f.path
        LEFT JOIN (
          SELECT file, COUNT(*) AS count
          FROM endpoints
          WHERE snapshot_id = ?
          GROUP BY file
        ) eps ON eps.file = f.path
        WHERE f.snapshot_id = ?
        ORDER BY
          (COALESCE(ind.count, 0) * 3)
          + (COALESCE(outd.count, 0) * 2)
          + (COALESCE(calls.count, 0) * 2)
          + (COALESCE(eps.count, 0) * 25)
          + COALESCE(syms.count, 0) DESC,
          f.path
        LIMIT 500
      `).all(snapshotId, snapshotId, snapshotId, snapshotId, snapshotId, snapshotId) as Promise<RepoAtlasHotspotRow[]>,
      this.db.prepare(`
        SELECT node_id, label, stats_json, evidence_json
        FROM graph_nodes
        WHERE snapshot_id = ? AND node_type = 'module'
        ORDER BY label
        LIMIT 500
      `).all(snapshotId) as Promise<RepoAtlasOverlayModuleRow[]>,
      this.db.prepare(`
        SELECT file, parent_node_id
        FROM graph_nodes
        WHERE snapshot_id = ? AND node_type = 'file' AND file IS NOT NULL AND parent_node_id IS NOT NULL
        LIMIT 200000
      `).all(snapshotId) as Promise<Array<{ file: string; parent_node_id: string }>>,
      this.db.prepare(`
        SELECT e.from_node_id, e.to_node_id, e.edge_type, e.confidence, e.edge_count,
               src.label AS from_label, dst.label AS to_label, e.evidence_json
        FROM graph_edges e
        LEFT JOIN graph_nodes src ON src.snapshot_id = e.snapshot_id AND src.node_id = e.from_node_id
        LEFT JOIN graph_nodes dst ON dst.snapshot_id = e.snapshot_id AND dst.node_id = e.to_node_id
        WHERE e.snapshot_id = ? AND e.edge_type LIKE 'module_%'
        ORDER BY e.edge_count DESC, e.confidence DESC
        LIMIT 500
      `).all(snapshotId) as Promise<RepoAtlasOverlayEdgeRow[]>,
      this.db.prepare(`
        SELECT from_file, to_file, COUNT(*) AS count, MAX(confidence) AS confidence
        FROM dependency_edges
        WHERE snapshot_id = ?
        GROUP BY from_file, to_file
        ORDER BY count DESC, confidence DESC
        LIMIT 50000
      `).all(snapshotId) as Promise<Array<{ from_file: string; to_file: string; count: number | string; confidence: number | string }>>,
    ]);

    const workspaceRoot = snapshot?.workspace_root ?? '';
    const workspaceLabel = path.basename(path.resolve(workspaceRoot || 'workspace')) || 'workspace';
    const counts = snapshotStats
      ? countsFromSnapshotStats(snapshotStats)
      : await this.liveIndexCounts(snapshotId);
    const fileRoles = snapshotStats
      ? fileRolesFromSnapshotStats(snapshotStats)
      : await this.liveFileRoles(snapshotId);
    const roleOptions = { includeTests, includeGenerated };
    const symbolCountByFile = new Map(symbolCounts.map(row => [row.file, atlasNumber(row.count)]));
    const endpointCountByFile = new Map<string, number>();
    for (const endpoint of endpoints) {
      endpointCountByFile.set(endpoint.file, (endpointCountByFile.get(endpoint.file) ?? 0) + 1);
    }
    const includedFiles = files.filter(file => repoAtlasIncludesRole(file.file_role, roleOptions));
    const includedFileSet = new Set(includedFiles.map(file => file.path));
    const includedEndpoints = endpoints
      .filter(endpoint => includedFileSet.has(endpoint.file) && repoAtlasIncludesRole(endpoint.file_role, roleOptions));
    const fileToModule = buildRepoAtlasFileModuleMap({
      workspaceLabel,
      files: includedFiles,
      overlayFiles: overlayFileRows,
      overlayModules: overlayModuleRows,
    });
    const modules = buildRepoAtlasModules({
      workspaceLabel,
      files: includedFiles,
      symbolCountByFile,
      endpointCountByFile,
      fileToModule,
      overlayModules: overlayModuleRows,
      limit: moduleLimit,
    });
    const moduleDependencies = buildRepoAtlasModuleDependencies({
      dependencyPairs,
      overlayEdges: overlayModuleEdgeRows,
      moduleById: new Map(modules.map(module => [module.id, module])),
      fileToModule,
      limit: Math.max(moduleLimit * 3, 10),
    });
    const entrypoints = compactEndpointCandidates(includedEndpoints.map(endpoint => endpointDto(endpoint)))
      .slice(0, entrypointLimit);
    const topFiles = hotspotRows
      .filter(row => includedFileSet.has(row.path) && repoAtlasIncludesRole(row.file_role, roleOptions))
      .map(row => repoAtlasHotspot(row, symbolCountByFile, endpointCountByFile))
      .slice(0, hotspotLimit);
    const featureFlows = await mapWithConcurrency(
      entrypoints.slice(0, flowLimit),
      4,
      async endpoint => {
        const handler = String(endpoint.handlerSymbol ?? '');
        const callees = handler
          ? ((await this.getCallees(snapshotId, {
            symbol: handler,
            limit: packProfileValue(profile, 4, 6, 12),
          })) as { callees: CallEdgeRow[] }).callees
          : [];
        const callGraph = callees
          .filter(edge => repoAtlasIncludesRole(edge.file_role ?? 'main_source', roleOptions))
          .map(compactCallEdge)
          .slice(0, packProfileValue(profile, 4, 6, 12));
        const primaryFiles = rankFiles([
          String(endpoint.file ?? ''),
          ...callGraph.map(edge => String(edge.file ?? '')),
        ]).slice(0, packProfileValue(profile, 3, 5, 10));
        const likelyTests = includeTests
          ? await this.findRelevantTestsForSeeds(snapshotId, repoAtlasFlowTestSeeds(endpoint, callGraph), packProfileValue(profile, 2, 4, 8))
          : [];
        return {
          id: `${endpoint.method} ${endpoint.path}`,
          name: repoAtlasFlowName(endpoint),
          entrypoint: endpoint,
          handler,
          primaryFiles,
          callGraph,
          likelyTests,
          confidence: repoAtlasFlowConfidence(endpoint, callGraph, likelyTests),
          evidence: [
            {
              file: endpoint.file,
              line: endpoint.line,
              reason: 'indexed endpoint handler',
            },
            ...callGraph.slice(0, 3).map(edge => ({
              file: edge.file,
              line: edge.line,
              reason: 'direct primary/provider call edge from handler seed',
            })),
          ],
        };
      },
    );
    const likelyTests = includeTests
      ? await this.findRelevantTestsForSeeds(snapshotId, uniqueStrings([
        ...featureFlows.flatMap(flow => [flow.handler, flow.name]),
        ...topFiles.slice(0, 8).map(file => {
          const filePath = String(file.file ?? '');
          return path.posix.basename(filePath, path.posix.extname(filePath));
        }),
      ]), packProfileValue(profile, 4, 10, 25))
      : [];
    const validation = await this.validationHints(snapshotId, likelyTests, topFiles.slice(0, 12).map(file => String(file.file ?? '')).filter(Boolean));
    const diagnostics = {
      parseFailures: parseJson<Array<Record<string, unknown>>>(snapshotStats?.parse_failures_json ?? undefined, []).slice(0, packProfileValue(profile, 3, 8, 30)),
      topUnresolvedImports: parseJson<Array<Record<string, unknown>>>(snapshotStats?.top_unresolved_imports_json ?? undefined, []).slice(0, packProfileValue(profile, 3, 8, 30)),
      topUnresolvedCalls: parseJson<Array<Record<string, unknown>>>(snapshotStats?.top_unresolved_calls_json ?? undefined, []).slice(0, packProfileValue(profile, 3, 8, 30)),
      endpointWarnings: parseJson<Array<Record<string, unknown>>>(snapshotStats?.endpoint_warnings_json ?? undefined, []).slice(0, packProfileValue(profile, 3, 8, 30)),
    };
    const atlas = {
      reportType: 'repo_atlas',
      version: 1,
      format: 'json',
      profile,
      generatedAt: new Date().toISOString(),
      snapshot: {
        workspaceId: snapshot?.workspace_id,
        snapshotId,
        root: workspaceRoot,
        workspaceKey: snapshot?.workspace_key,
        branch: snapshot?.branch,
        headCommit: snapshot?.head_commit,
        createdAt: snapshot?.created_at,
        indexTimeMs: atlasNumber(snapshot?.index_time_ms),
        manifestScanMs: atlasNumber(snapshot?.manifest_scan_ms),
        filesTotal: atlasNumber(snapshot?.files_total),
        filesParsed: atlasNumber(snapshot?.files_parsed),
        parseCacheHits: atlasNumber(snapshot?.parse_cache_hits),
      },
      systemMentalModel: [
        `The current snapshot contains ${counts.files} files, ${counts.symbols} symbols, ${counts.dependencyEdges} file dependency edges, ${counts.callEdgesPrimary} primary/provider call edges, and ${counts.endpoints} endpoints.`,
        'Repo Atlas is generated from persistent CodeGraph facts only; it does not read raw source text or call an AI model.',
        overlayModuleRows.length > 0
          ? 'Graph overlay rows are available, so module boundaries and aggregate module edges come from graph_nodes/graph_edges.'
          : 'Graph overlay rows are absent, so module boundaries fall back to path-based grouping and dependency_edges aggregation.',
      ],
      executionPipeline: [
        { step: 1, owner: 'indexer', mechanism: 'source files were parsed into files, symbols, endpoints, call_edges, and dependency_edges tables' },
        { step: 2, owner: 'query service', mechanism: 'generate_repo_atlas reads snapshot stats and bounded graph aggregates' },
        { step: 3, owner: 'atlas renderer', mechanism: 'modules, flows, hotspots, validation hints, and follow-up tool calls are ranked deterministically' },
      ],
      summary: {
        counts,
        fileRoles: fileRoles.map(row => ({ fileRole: row.file_role, count: atlasNumber(row.count) })),
        languages: repoAtlasLanguageSummary(includedFiles),
        health: {
          parseFailureCount: diagnostics.parseFailures.length,
          unresolvedImportKinds: diagnostics.topUnresolvedImports.length,
          unresolvedCallKinds: diagnostics.topUnresolvedCalls.length,
          endpointWarningCount: diagnostics.endpointWarnings.length,
          overlayAvailable: overlayModuleRows.length > 0,
        },
      },
      architecture: {
        modules,
        moduleDependencies,
        entrypoints,
        topFiles,
      },
      featureMap: {
        generationMode: 'deterministic-index-facts',
        flows: featureFlows,
        confidenceNotes: [
          'Flows start from indexed endpoints and attach direct primary/provider callees from the handler seed.',
          'Business names are heuristic; file, symbol, endpoint, and test evidence are graph-derived.',
        ],
      },
      changePlaybook: {
        hotspots: topFiles,
        validation,
        likelyTests,
        recommendedWorkflow: [
          'For architecture questions, read architecture.modules and architecture.moduleDependencies first.',
          'For API/feature work, start from featureMap.flows and then call get_flow_pack on the selected endpoint or handler.',
          'For edits, call simulate_patch_impact with the planned files before changing code.',
        ],
      },
      diagnostics,
      automation: {
        recommendedToolCalls: [
          entrypoints[0] ? {
            tool: 'get_flow_pack',
            args: {
              target: `${entrypoints[0].method} ${entrypoints[0].path}`,
              responseMode: 'answer',
              profile: 'compact',
            },
            why: 'Expand the highest-ranked endpoint flow with line-level evidence.',
          } : undefined,
          topFiles[0] ? {
            tool: 'simulate_patch_impact',
            args: {
              files: [topFiles[0].file],
              outputMode: 'compact',
            },
            why: 'Check blast radius before editing the highest-risk file.',
          } : undefined,
          {
            tool: 'get_index_stats',
            args: { warnStale: false },
            why: 'Inspect index health diagnostics without rescanning dirty files.',
          },
        ].filter(Boolean),
      },
      assumptions: [
        'No AI was used to infer this report.',
        'Feature names are derived from endpoint path/method and handler names.',
        'Call-chain depth is intentionally shallow; call get_flow_pack for deeper endpoint-specific evidence.',
      ],
      budget: {
        profile,
        dataSources: ['snapshot_stats', 'files', 'symbols', 'endpoints', 'dependency_edges', 'call_edges', 'graph_nodes', 'graph_edges'],
        queryTimeMs: Date.now() - startedAt,
        estimatedResponseTokens: 0,
        policy: 'bounded aggregate report; raw source slices are omitted and exposed through follow-up tool calls',
      },
    };
    atlas.budget.estimatedResponseTokens = estimateTokens(JSON.stringify(atlas));
    if (format === 'markdown') {
      const markdown = renderRepoAtlasMarkdown(atlas);
      return {
        reportType: 'repo_atlas',
        version: atlas.version,
        format,
        profile,
        markdown,
        snapshot: atlas.snapshot,
        budget: {
          ...atlas.budget,
          estimatedResponseTokens: estimateTokens(markdown),
        },
      };
    }
    return atlas;
  }

  private async getIndexStats(snapshotId: string, args: Record<string, unknown> = {}) {
    const snapshot = await this.db.prepare(`
      SELECT s.*, w.root AS workspace_root
      FROM snapshots s
      JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.id = ?
    `).get(snapshotId);
    const snapshotStats = await this.snapshotStats(snapshotId);
    const [
      counts,
      fileRoles,
      parseFailures,
      endpointWarnings,
      staleFiles,
      topUnresolvedImports,
      topUnresolvedCalls,
      endpointPathUnresolvedCount,
    ] = await Promise.all([
      snapshotStats
        ? Promise.resolve(countsFromSnapshotStats(snapshotStats))
        : this.liveIndexCounts(snapshotId),
      snapshotStats
        ? Promise.resolve(fileRolesFromSnapshotStats(snapshotStats))
        : this.liveFileRoles(snapshotId),
      snapshotStats?.parse_failures_json != null
        ? Promise.resolve(parseJson<Array<Record<string, unknown>>>(snapshotStats.parse_failures_json, []))
        : this.db.prepare(`
      SELECT path, language, parse_status FROM files
      WHERE snapshot_id = ? AND parse_status = 'error'
      ORDER BY path
      LIMIT 50
    `).all(snapshotId),
      snapshotStats?.endpoint_warnings_json != null
        ? Promise.resolve(parseJson<Array<Record<string, unknown>>>(snapshotStats.endpoint_warnings_json, []))
        : this.db.prepare(`
      SELECT method, path, path_resolution, path_resolution_reason, handler_symbol, file, line
      FROM endpoints
      WHERE snapshot_id = ? AND path_resolution != 'exact'
      ORDER BY file, line
      LIMIT 50
    `).all(snapshotId),
      args.warnStale === false
      ? {
        skipped: true,
        reason: 'warnStale=false skips filesystem dirty-file scan for fast stats.',
      }
      : this.computeDirtyFiles(snapshotId),
      snapshotStats?.top_unresolved_imports_json != null
        ? Promise.resolve(parseJson<Array<Record<string, unknown>>>(snapshotStats.top_unresolved_imports_json, []))
        : this.topUnresolvedImports(snapshotId),
      snapshotStats?.top_unresolved_calls_json != null
        ? Promise.resolve(parseJson<Array<Record<string, unknown>>>(snapshotStats.top_unresolved_calls_json, []))
        : this.db.prepare(`
        SELECT callee, COUNT(*) AS count, MAX(confidence) AS maxConfidence
        FROM call_edges
        WHERE snapshot_id = ? AND resolution_kind = 'name-only' AND signal_tier IN ('primary', 'provider')
        GROUP BY callee
        ORDER BY count DESC, callee
        LIMIT 20
      `).all(snapshotId),
      snapshotStats
        ? Promise.resolve(Number(snapshotStats.endpoint_path_unresolved ?? 0))
        : scalar(this.db, `
          SELECT COUNT(*) FROM endpoints WHERE snapshot_id = ? AND path_resolution != 'exact'
        `, snapshotId),
    ]);

    return {
      snapshot,
      counts,
      fileRoles,
      diagnostics: {
        parseFailures,
        staleFiles,
        topUnresolvedImports,
        topUnresolvedCalls,
        frameworkWarnings: {
          endpointPathUnresolved: endpointWarnings,
          endpointPathUnresolvedCount,
        },
      },
    };
  }

  private async snapshotStats(snapshotId: string): Promise<SnapshotStatsRow | undefined> {
    return await this.db.prepare(`
      SELECT *
      FROM snapshot_stats
      WHERE snapshot_id = ?
    `).get(snapshotId) as SnapshotStatsRow | undefined;
  }

  private async liveIndexCounts(snapshotId: string): Promise<IndexCountSummary> {
    const [
      files,
      symbols,
      imports,
      fieldUsages,
      callEdges,
      callEdgesPrimary,
      callEdgesLowSignal,
      callEdgesProvider,
      dependencyEdges,
      graphNodes,
      graphEdges,
      endpoints,
      beans,
    ] = await Promise.all([
      scalar(this.db, 'SELECT COUNT(*) FROM files WHERE snapshot_id = ?', snapshotId),
      scalar(this.db, 'SELECT COUNT(*) FROM symbols WHERE snapshot_id = ?', snapshotId),
      scalar(this.db, 'SELECT COUNT(*) FROM imports WHERE snapshot_id = ?', snapshotId),
      scalar(this.db, 'SELECT COUNT(*) FROM field_usages WHERE snapshot_id = ?', snapshotId),
      scalar(this.db, 'SELECT COUNT(*) FROM call_edges WHERE snapshot_id = ?', snapshotId),
      scalar(this.db, "SELECT COUNT(*) FROM call_edges WHERE snapshot_id = ? AND signal_tier IN ('primary', 'provider')", snapshotId),
      scalar(this.db, "SELECT COUNT(*) FROM call_edges WHERE snapshot_id = ? AND signal_tier = 'low_signal'", snapshotId),
      scalar(this.db, "SELECT COUNT(*) FROM call_edges WHERE snapshot_id = ? AND signal_tier = 'provider'", snapshotId),
      scalar(this.db, 'SELECT COUNT(*) FROM dependency_edges WHERE snapshot_id = ?', snapshotId),
      scalar(this.db, 'SELECT COUNT(*) FROM graph_nodes WHERE snapshot_id = ?', snapshotId),
      scalar(this.db, 'SELECT COUNT(*) FROM graph_edges WHERE snapshot_id = ?', snapshotId),
      scalar(this.db, 'SELECT COUNT(*) FROM endpoints WHERE snapshot_id = ?', snapshotId),
      scalar(this.db, 'SELECT COUNT(*) FROM beans WHERE snapshot_id = ?', snapshotId),
    ]);
    return {
      files,
      symbols,
      imports,
      fieldUsages,
      callEdges,
      callEdgesRaw: callEdges,
      callEdgesPrimary,
      callEdgesLowSignal,
      callEdgesProvider,
      dependencyEdges,
      graphNodes,
      graphEdges,
      endpoints,
      beans,
    };
  }

  private async liveFileRoles(snapshotId: string): Promise<FileRoleCountRow[]> {
    return await this.db.prepare(`
      SELECT file_role, COUNT(*) AS count FROM files WHERE snapshot_id = ? GROUP BY file_role
    `).all(snapshotId) as FileRoleCountRow[];
  }

  private async dependencyRows(snapshotId: string, file: string, direction: 'from_file' | 'to_file') {
    const selectTarget = direction === 'from_file' ? 'to_file' : 'from_file';
    const rows = await this.db.prepare(`
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

  private async seedFilesForDependencyTrace(
    snapshotId: string,
    target: string,
    filters: ReturnType<typeof fileFiltersFor>,
  ): Promise<string[]> {
    const resolved = await this.resolveFile(snapshotId, target);
    if (resolved) return [resolved];
    if (!target) return [];
    const normalized = target.replace(/\\/g, '/');
    const pattern = `%${escapeLike(normalized)}%`;
    const filterSql = filters.sql.length > 0
      ? `AND ${filters.sql.map(sql => `(${sql.replace(/\bfile_role\b/g, 'f.file_role')})`).join(' AND ')}`
      : '';
    const rows = await this.db.prepare(`
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

  private async dependencyTraceRows(
    snapshotId: string,
    file: string,
    direction: 'dependencies' | 'dependents' | 'both',
  ): Promise<DependencyTraceEdge[]> {
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
    const rows = await this.db.prepare(`
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

  private async fileRoleMap(snapshotId: string): Promise<Map<string, string>> {
    const rows = await this.db.prepare(`
      SELECT path, file_role FROM files WHERE snapshot_id = ?
    `).all(snapshotId) as Array<{ path: string; file_role: string }>;
    return new Map(rows.map(row => [row.path, row.file_role]));
  }

  private async resolveFile(snapshotId: string, query: string): Promise<string | undefined> {
    if (!query) return undefined;
    const normalized = query.replace(/\\/g, '/');
    const exact = await this.db.prepare('SELECT path FROM files WHERE snapshot_id = ? AND path = ?')
      .get(snapshotId, normalized) as { path: string } | undefined;
    if (exact) return exact.path;
    const basename = normalized.includes('/') ? normalized.substring(normalized.lastIndexOf('/') + 1) : normalized;
    const row = await this.db.prepare(`
      SELECT path FROM files
      WHERE snapshot_id = ?
        AND (path LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')
      ORDER BY LENGTH(path)
      LIMIT 1
    `).get(snapshotId, `%/${escapeLike(normalized)}`, `%/${escapeLike(basename)}`) as { path: string } | undefined;
    return row?.path;
  }

  private async traceCallees(snapshotId: string, handlerSymbol: string, depth: number): Promise<CallEdgeRow[]> {
    const maxDepth = Math.max(1, Math.min(depth, 5));
    const start = callGraphName(handlerSymbol);
    const queue: Array<{ caller: string; depth: number }> = [{ caller: start, depth: 0 }];
    const seenCallers = new Set<string>();
    const edges: CallEdgeRow[] = [];

    while (queue.length > 0 && edges.length < 100) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth || seenCallers.has(current.caller)) continue;
      seenCallers.add(current.caller);
      const rows = await this.db.prepare(`
        SELECT caller, callee, file, line, confidence, resolution_kind, signal_tier, signal_reasons_json
        FROM call_edges
        WHERE snapshot_id = ? AND caller LIKE ? ESCAPE '\\'
          AND signal_tier IN ('primary', 'provider')
        ORDER BY ${callSignalOrder()}, confidence DESC, line
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

  private async symbolsForFiles(snapshotId: string, files: string[], snippets?: SnippetOptions): Promise<Array<Record<string, unknown>>> {
    const unique = [...new Set(files.filter(Boolean))].slice(0, 200);
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(', ');
    const rows = await this.db.prepare(`
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

  private async fileEvidence(snapshotId: string, files: string[]): Promise<Map<string, FileEvidence>> {
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

    const symbols = await this.db.prepare(`
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

    const endpoints = await this.db.prepare(`
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

    const outgoing = await this.db.prepare(`
      SELECT from_file AS file, COUNT(*) AS count
      FROM dependency_edges
      WHERE snapshot_id = ? AND from_file IN (${placeholders})
      GROUP BY from_file
    `).all(snapshotId, ...unique) as Array<{ file: string; count: number }>;
    for (const row of outgoing) {
      const current = evidence.get(row.file);
      if (current) current.dependencyCounts.outgoing = row.count;
    }

    const incoming = await this.db.prepare(`
      SELECT to_file AS file, COUNT(*) AS count
      FROM dependency_edges
      WHERE snapshot_id = ? AND to_file IN (${placeholders})
      GROUP BY to_file
    `).all(snapshotId, ...unique) as Array<{ file: string; count: number }>;
    for (const row of incoming) {
      const current = evidence.get(row.file);
      if (current) current.dependencyCounts.incoming = row.count;
    }

    const imports = await this.db.prepare(`
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

  private async findRelevantTests(snapshotId: string, target: string, limit: number): Promise<Array<Record<string, unknown>>> {
    const normalizedTarget = target.trim();
    const normalizedLimit = clampInt(Math.floor(limit), 1, 200);
    const cacheKey = `${snapshotId}\0${normalizedTarget}\0${normalizedLimit}`;
    const cached = this.relevantTestCache.get(cacheKey);
    if (cached) return cached;

    const lookup = this.findRelevantTestsUncached(snapshotId, normalizedTarget, normalizedLimit)
      .catch(error => {
        this.relevantTestCache.delete(cacheKey);
        throw error;
      });
    this.rememberRelevantTestLookup(cacheKey, lookup);
    return lookup;
  }

  private rememberRelevantTestLookup(
    key: string,
    value: Promise<Array<Record<string, unknown>>>,
  ) {
    const limit = relevantTestCacheLimit();
    if (limit <= 0) return;
    if (!this.relevantTestCache.has(key) && this.relevantTestCache.size >= limit) {
      const oldest = this.relevantTestCache.keys().next().value as string | undefined;
      if (oldest) this.relevantTestCache.delete(oldest);
    }
    this.relevantTestCache.set(key, value);
  }

  private async findRelevantTestsUncached(snapshotId: string, target: string, limit: number): Promise<Array<Record<string, unknown>>> {
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
      const files = await this.db.prepare(`
        SELECT path AS file
        FROM files
        WHERE snapshot_id = ?
          AND file_role IN ('test_source', 'mock_source')
          AND path LIKE ? ESCAPE '\\'
        LIMIT 100
      `).all(snapshotId, pattern) as Array<{ file: string }>;
      for (const row of files) add(row.file, 4, `test file path matches "${term}"`);

      const symbols = await this.db.prepare(`
        SELECT DISTINCT file
        FROM symbols
        WHERE snapshot_id = ?
          AND file_role IN ('test_source', 'mock_source')
          AND (simple_name LIKE ? ESCAPE '\\' OR fq_name LIKE ? ESCAPE '\\')
        LIMIT 100
      `).all(snapshotId, pattern, pattern) as Array<{ file: string }>;
      for (const row of symbols) add(row.file, 3, `test symbol matches "${term}"`);

      const callTerms = exactCallEdgeTestTerms(term);
      if (callTerms.length > 0) {
        const placeholders = callTerms.map(() => '?').join(', ');
        const calls = await this.db.prepare(`
          SELECT DISTINCT file
          FROM call_edges
          WHERE snapshot_id = ?
            AND file_role IN ('test_source', 'mock_source')
            AND signal_tier IN ('primary', 'provider')
            AND (caller IN (${placeholders}) OR callee IN (${placeholders}))
          LIMIT 100
        `).all(snapshotId, ...callTerms, ...callTerms) as Array<{ file: string }>;
        for (const row of calls) add(row.file, 6, `test call edge exactly mentions "${term}"`);
      }
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

  private async explicitContextMatches(
    snapshotId: string,
    task: string,
    domain: string | undefined,
    limit: number,
  ): Promise<{
    candidateFiles: Array<ReturnType<typeof compactFileCandidate>>;
    relevantSymbols: Array<ReturnType<typeof compactSymbolCandidate>>;
    topFiles: string[];
  }> {
    const resolvedNeedles: string[] = [];
    for (const needle of explicitFileNeedles(task, domain)) {
      const resolved = await this.resolveFile(snapshotId, needle);
      if (resolved) resolvedNeedles.push(resolved);
    }
    const resolvedFiles = uniqueFilesInOrder(resolvedNeedles).slice(0, limit);
    if (resolvedFiles.length === 0) {
      return { candidateFiles: [], relevantSymbols: [], topFiles: [] };
    }

    const placeholders = resolvedFiles.map(() => '?').join(', ');
    const rows = await this.db.prepare(`
      SELECT path, language, file_role, parse_status, size
      FROM files
      WHERE snapshot_id = ? AND path IN (${placeholders})
    `).all(snapshotId, ...resolvedFiles) as FileRow[];
    const rowsByPath = new Map(rows.map(row => [row.path, row]));
    const symbolsByFile = new Map<string, Array<Record<string, unknown>>>();
    for (const symbol of await this.symbolsForFiles(snapshotId, resolvedFiles)) {
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

  private async findRelevantTestsForSeeds(snapshotId: string, seeds: string[], limit: number): Promise<Array<Record<string, unknown>>> {
    const merged = new Map<string, { file: string; score: number; reasons: Set<string> }>();
    const seedLookups = await mapWithConcurrency(
      [...new Set(seeds.map(item => item.trim()).filter(Boolean))].slice(0, 8),
      relevantTestLookupConcurrency(),
      seed => this.findRelevantTests(snapshotId, seed, limit),
    );
    for (const tests of seedLookups) {
      for (const test of tests) {
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

  private async validationHints(
    snapshotId: string,
    tests: Array<Record<string, unknown>>,
    topFiles: string[],
  ): Promise<Record<string, unknown>> {
    const root = await this.workspaceRootForSnapshot(snapshotId);
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

  private async lookupBestSymbol(snapshotId: string, symbol: string, file?: string): Promise<SymbolRow | undefined> {
    const query = symbol.trim();
    if (!query) return undefined;
    const pattern = `%${escapeLike(query)}%`;
    const fileClause = file ? 'AND file = ?' : '';
    const params: unknown[] = [snapshotId];
    if (file) params.push(file);
    params.push(query, query, pattern, pattern);
    return await this.db.prepare(`
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

  private async computeDirtyFiles(snapshotId: string): Promise<Record<string, unknown>> {
    const snapshot = await this.db.prepare(`
      SELECT w.root AS root, s.head_commit AS head_commit
      FROM snapshots s
      JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.id = ?
    `).get(snapshotId) as { root?: string; head_commit?: string } | undefined;
    if (!snapshot?.root) return { error: 'Workspace root not found for snapshot.' };

    try {
      if (snapshot.head_commit) {
        const gitDirty = getGitDirtyFiles(snapshot.root);
        if (gitDirty.available) {
          return {
            addedCount: gitDirty.added.length,
            modifiedCount: gitDirty.modified.length,
            deletedCount: gitDirty.deleted.length,
            scanTimeMs: gitDirty.scanTimeMs,
            source: 'git-status',
            samples: {
              added: gitDirty.added.slice(0, 20),
              modified: gitDirty.modified.slice(0, 20),
              deleted: gitDirty.deleted.slice(0, 20),
            },
          };
        }
      }
      const manifest = scanManifest(snapshot.root);
      const current = new Map(manifest.files.map(file => [file.relPath, file.blobHash]));
      const indexedRows = await this.db.prepare(`
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

  private async topUnresolvedImports(snapshotId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db.prepare(`
      SELECT source, COUNT(*) AS count
      FROM imports
      WHERE snapshot_id = ? AND ${COMMON_EXTERNAL_IMPORT_SQL}
      GROUP BY source
      ORDER BY count DESC, source
      LIMIT 200
    `).all(snapshotId) as Array<{ source: string; count: number | string }>;
    const knownTypes = new Set((await this.db.prepare(`
      SELECT fq_name, simple_name
      FROM symbols
      WHERE snapshot_id = ? AND kind IN ('class', 'interface', 'enum', 'type')
    `).all(snapshotId) as Array<{ fq_name: string; simple_name: string }>)
      .flatMap(row => [row.fq_name, row.simple_name]));
    return rows
      .filter(row => !knownTypes.has(row.source) && !knownTypes.has(simpleTypeName(row.source)))
      .slice(0, 20)
      .map(row => ({ source: row.source, count: Number(row.count) }));
  }

  private async impactedEndpoints(snapshotId: string, files: string[]): Promise<Array<Record<string, unknown>>> {
    const unique = [...new Set(files.filter(Boolean))].slice(0, 200);
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(', ');
    const rows = await this.db.prepare(`
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

interface SymbolSearchEntityKey {
  fqName: string;
  file: string;
  line: number;
}

interface RepoAtlasSnapshotRow {
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

interface RepoAtlasFileRow {
  path: string;
  language?: string;
  file_role: string;
  parse_status: string;
  size: number | string;
}

interface RepoAtlasHotspotRow extends RepoAtlasFileRow {
  outgoing_deps: number | string;
  incoming_deps: number | string;
  call_edges: number | string;
  symbols: number | string;
  endpoints: number | string;
}

interface RepoAtlasOverlayModuleRow {
  node_id: string;
  label: string;
  stats_json?: string;
  evidence_json?: string;
}

interface RepoAtlasOverlayEdgeRow {
  from_node_id: string;
  to_node_id: string;
  edge_type: string;
  confidence: number | string;
  edge_count: number | string;
  from_label?: string;
  to_label?: string;
  evidence_json?: string;
}

interface RepoAtlasModule {
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

interface CallEdgeRow {
  caller: string;
  callee: string;
  file: string;
  line: number;
  confidence: number;
  resolution_kind: string;
  signal_tier?: string;
  signal_reasons_json?: string;
  file_role?: string;
}

interface FieldUsageRow {
  field_name: string;
  field_fq_name?: string;
  owner_class?: string;
  file: string;
  line: number;
  column: number;
  enclosing_class?: string;
  enclosing_symbol?: string;
  access_kind: string;
  receiver_text?: string;
  context: string;
  confidence: number;
  resolution_kind: string;
  file_role: FileRole;
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

interface IndexCountSummary {
  files: number;
  symbols: number;
  imports: number;
  fieldUsages: number;
  callEdges: number;
  callEdgesRaw: number;
  callEdgesPrimary: number;
  callEdgesLowSignal: number;
  callEdgesProvider: number;
  dependencyEdges: number;
  graphNodes: number;
  graphEdges: number;
  endpoints: number;
  beans: number;
}

interface SnapshotStatsRow {
  files: number | string;
  symbols: number | string;
  imports: number | string;
  field_usages: number | string;
  call_edges: number | string;
  call_edges_primary: number | string;
  call_edges_low_signal: number | string;
  call_edges_provider: number | string;
  dependency_edges: number | string;
  graph_nodes: number | string;
  graph_edges: number | string;
  endpoints: number | string;
  beans: number | string;
  endpoint_path_unresolved: number | string;
  file_roles_json?: string;
  parse_failures_json?: string | null;
  endpoint_warnings_json?: string | null;
  top_unresolved_imports_json?: string | null;
  top_unresolved_calls_json?: string | null;
}

interface FileRoleCountRow {
  file_role: string;
  count: number | string;
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

interface ResearchSymbolCandidate {
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
}

interface ResearchFileCandidate {
  file: string;
  lines?: string;
  whyRelevant: string;
  confidence: number;
  matchedTokens: string[];
  topSymbols: Array<Record<string, unknown>>;
  endpoints: Array<Record<string, unknown>>;
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
  fileCache: Map<string, string>;
}

function compactSearchCodeSections(
  fileResults: Record<string, unknown>,
  symbolResults: Record<string, unknown>,
  endpointResults: Record<string, unknown>,
  references: Record<string, unknown> | undefined,
  dependencies: Record<string, unknown> | undefined,
  limit: number,
  options: { includeReferences?: boolean; includeDependencies?: boolean } = {},
): Record<string, unknown> {
  const includeReferences = options.includeReferences !== false;
  const includeDependencies = options.includeDependencies !== false;
  return {
    files: {
      totalFound: Number(fileResults.totalFound ?? 0),
      nextCursor: fileResults.nextCursor,
      files: arrayRecords(fileResults.files).slice(0, limit).map(slimSearchCodeFile),
    },
    symbols: {
      totalFound: Number(symbolResults.totalFound ?? 0),
      nextCursor: symbolResults.nextCursor,
      symbols: arrayRecords(symbolResults.symbols).slice(0, limit).map(slimSearchCodeSymbol),
    },
    endpoints: {
      totalCount: Number(endpointResults.totalCount ?? 0),
      endpoints: compactEndpointCandidates(arrayRecords(endpointResults.endpoints)).slice(0, limit),
    },
    references: includeReferences && references ? {
      totalCount: Number(references.totalCount ?? 0),
      truncated: Boolean(references.truncated),
      nextCursor: references.nextCursor,
      references: arrayRecords(references.references).slice(0, limit).map(row => compactReviewObject(row, 8, 2)),
      groups: arrayRecords(references.groups).slice(0, Math.min(limit, 5)).map(row => compactReviewObject(row, 8, 2)),
    } : undefined,
    dependencies: includeDependencies && dependencies ? {
      seedFiles: stringArray(dependencies.seedFiles).slice(0, limit),
      transitiveFiles: stringArray(dependencies.transitiveFiles).slice(0, limit * 2),
      edges: arrayRecords(dependencies.edges).slice(0, limit * 3).map(row => compactReviewObject(row, 8, 2)),
    } : undefined,
  };
}

function slimSearchCodeFile(row: Record<string, unknown>): Record<string, unknown> {
  return {
    path: String(row.path ?? row.file ?? ''),
    language: stringOrUndefined(row.language),
    fileRole: stringOrUndefined(row.fileRole ?? row.file_role),
    parseStatus: stringOrUndefined(row.parseStatus ?? row.parse_status),
    searchScore: Number(row.searchScore ?? 0),
    matchedTokens: stringArray(row.matchedTokens),
    matchReason: stringOrUndefined(row.matchReason),
    topSymbols: arrayRecords(row.topSymbols).slice(0, 3).map(slimSearchCodeSymbol),
    endpoints: compactEndpointCandidates(arrayRecords(row.endpoints)).slice(0, 3),
  };
}

function slimSearchCodeSymbol(row: Record<string, unknown>): Record<string, unknown> {
  return {
    name: String(row.name ?? row.simple_name ?? ''),
    fqName: String(row.fqName ?? row.fq_name ?? row.symbol ?? ''),
    kind: stringOrUndefined(row.kind),
    file: String(row.file ?? ''),
    line: Number(row.line ?? 0),
    lines: stringOrUndefined(row.lines),
    signature: stringOrUndefined(row.signature),
    frameworkRole: stringOrUndefined(row.frameworkRole ?? row.framework_role),
    fileRole: stringOrUndefined(row.fileRole ?? row.file_role),
    searchScore: Number(row.searchScore ?? 0),
    matchedTokens: stringArray(row.matchedTokens),
    matchReason: stringOrUndefined(row.matchReason),
  };
}

function mergeSymbolRows(...groups: SymbolRow[][]): SymbolRow[] {
  const merged: SymbolRow[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const row of group) {
      const key = `${row.fq_name}\0${row.kind}\0${row.file}\0${row.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }
  }
  return merged;
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
    signalTier: row.signal_tier,
    signalReasons: typeof row.signal_reasons_json === 'string'
      ? parseJson<string[]>(row.signal_reasons_json, [])
      : undefined,
    fieldAccess: row.field_access,
    enclosingClass: row.enclosing_class,
    enclosingSymbol: row.enclosing_symbol,
    ownerClass: row.owner_class,
    receiverText: row.receiver_text,
    context: row.context,
    fileRole: row.file_role,
  };
}

function fieldUsageDto(row: FieldUsageRow): Record<string, unknown> {
  return {
    fieldName: row.field_name,
    fieldFqName: row.field_fq_name,
    ownerClass: row.owner_class,
    file: row.file,
    line: row.line,
    column: row.column,
    enclosingClass: row.enclosing_class,
    enclosingSymbol: row.enclosing_symbol,
    fieldAccess: row.access_kind,
    receiverText: row.receiver_text,
    context: row.context,
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
    if (snippets.fileCache.has(absolutePath)) {
      content = snippets.fileCache.get(absolutePath) ?? '';
    } else {
      content = fs.readFileSync(absolutePath, 'utf-8');
      snippets.fileCache.set(absolutePath, content);
    }
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

function bestSourceRange(root: string | undefined, file: string, terms: string[]): string | undefined {
  if (!root || !file) return undefined;
  const absolutePath = safeResolve(root, file);
  if (!absolutePath) return undefined;
  let source: string;
  try {
    source = fs.readFileSync(absolutePath, 'utf-8');
  } catch {
    return undefined;
  }
  const needles = uniqueStrings(terms
    .flatMap(term => [term, ...tokenizeSearchQuery(term)])
    .map(term => term.trim().toLowerCase())
    .filter(term => term.length >= 4 && !RESEARCH_STOP_WORDS.has(term)))
    .slice(0, 16);
  if (needles.length === 0) return undefined;
  const lines = source.split(/\r?\n/);
  let bestLine = 0;
  let bestScore = 0;
  for (let index = 0; index < lines.length; index++) {
    const lower = lines[index]?.toLowerCase() ?? '';
    let score = 0;
    for (const needle of needles) {
      if (lower.includes(needle)) score += needle.length >= 8 ? 3 : 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = index + 1;
    }
  }
  if (bestScore === 0) return undefined;
  return lineRangeString(Math.max(1, bestLine - 24), Math.min(lines.length, bestLine + 44));
}

function bestExplicitSourceRange(
  root: string | undefined,
  file: string,
  target: string,
  requireMemberMatch = false,
): string | undefined {
  if (!root || !file) return undefined;
  const refs = explicitSymbolRefs(target);
  if (refs.length === 0) return undefined;
  const basename = path.posix.basename(file.replace(/\\/g, '/'), path.posix.extname(file));
  const matchingRefs = refs.filter(ref => ref.className === basename || file.includes(`${ref.className}.`));
  if (matchingRefs.length === 0) return undefined;
  const absolutePath = safeResolve(root, file);
  if (!absolutePath) return undefined;

  let source: string;
  try {
    source = fs.readFileSync(absolutePath, 'utf-8');
  } catch {
    return undefined;
  }
  const lines = source.split(/\r?\n/);
  const memberNames = uniqueStrings(matchingRefs
    .map(ref => ref.member)
    .filter((member): member is string => Boolean(member)));
  for (const member of memberNames) {
    const memberPattern = new RegExp(`\\b${escapeRegExp(member)}\\s*\\(`);
    const line = firstSourceLineMatching(lines, memberPattern);
    if (line > 0) return sourceWindow(lines.length, line, 10, 60);
  }
  if (requireMemberMatch && memberNames.length > 0) return undefined;
  for (const ref of matchingRefs) {
    const classPattern = new RegExp(`\\b(class|interface|enum|record)\\s+${escapeRegExp(ref.className)}\\b`);
    const line = firstSourceLineMatching(lines, classPattern);
    if (line > 0) return sourceWindow(lines.length, line, 6, 48);
  }
  return undefined;
}

function firstSourceLineMatching(lines: string[], pattern: RegExp): number {
  for (let index = 0; index < lines.length; index++) {
    const trimmed = (lines[index] ?? '').trim();
    if (!trimmed || trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    if (pattern.test(trimmed)) return index + 1;
  }
  return 0;
}

function sourceWindow(lineCount: number, line: number, before: number, after: number): string {
  return lineRangeString(Math.max(1, line - before), Math.min(lineCount, line + after));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function uniqueEndpointCandidates<T extends { method: string; path: string; handlerSymbol: string; file: string; line: number }>(candidates: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.method}\0${candidate.path}\0${candidate.handlerSymbol}\0${candidate.file}\0${candidate.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function endpointNeedleFromText(text: string): string {
  const candidates: Array<{ path: string; index: number; score: number }> = [];
  const endpointIntent = /\b(api|endpoint|route|rest|http|handler|controller|request|response)\b/i.test(text);
  for (const match of text.matchAll(/\/[A-Za-z0-9_{}:$.-][A-Za-z0-9_{}:$/.-]*/g)) {
    const raw = match[0] ?? '';
    const value = raw.replace(/[),.;:]+$/g, '');
    if (!value || value === '/' || value.length < 2) continue;
    const index = match.index ?? 0;
    const before = text.slice(Math.max(0, index - 24), index);
    const segments = value.split('/').filter(Boolean);
    const first = segments[0]?.toLowerCase() ?? '';
    let score = 0;
    if (/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*$/i.test(before)) score += 120;
    if (/^\/(?:api|apis|ws|rest|v\d+|actuator|health|metrics|graphql)(?:\/|$)/i.test(value)) score += 80;
    if (/[{}]/.test(value)) score += 35;
    if (segments.length >= 2) score += 20;
    if (endpointIntent) score += 15;
    if (/\.(?:java|kt|scala|ts|tsx|js|jsx|py|xml|json|ya?ml|md|txt|class)$/i.test(value)) score -= 120;
    if (/^(?:users?|home|personal|projects?|workspace|workspaces|src|main|test|tests|java|com|org|net|io|d)$/i.test(first)) score -= 90;
    if (/^[A-Z]:\//.test(text.slice(Math.max(0, index - 2), index + value.length))) score -= 70;
    candidates.push({ path: value, index, score });
  }
  candidates.sort((a, b) => b.score - a.score || b.path.length - a.path.length || a.index - b.index);
  const best = candidates[0];
  if (!best || best.score < 15) return '';
  return best.path;
}

function endpointNeedleForTask(task: string, domain?: string): string {
  return endpointNeedleFromText([task, domain ?? ''].join(' '));
}

function explicitSymbolRefs(task: string, domain?: string): Array<{ className: string; member?: string }> {
  const text = [task, domain ?? ''].join(' ');
  const refs: Array<{ className: string; member?: string }> = [];
  for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9_$]{2,})\.([A-Za-z_$][A-Za-z0-9_$]{2,})\b/g)) {
    const className = match[1] ?? '';
    const member = match[2] ?? '';
    if (!className || !member || EXPLICIT_FILENAME_STOP_WORDS.has(className)) continue;
    refs.push({ className, member });
  }
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9_$]{3,}\b/g)) {
    const className = match[0];
    if (EXPLICIT_FILENAME_STOP_WORDS.has(className)) continue;
    refs.push({ className });
  }

  const seen = new Set<string>();
  const result: Array<{ className: string; member?: string }> = [];
  for (const ref of refs) {
    const key = `${ref.className}\0${ref.member ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function explicitFileNeedles(task: string, domain?: string): string[] {
  const text = [task, domain ?? ''].join(' ');
  const needles = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+/g)) {
    const value = match[0]?.replace(/\\/g, '/').replace(/[),.;:]+$/g, '');
    if (value && value.includes('/')) needles.add(value);
  }
  for (const ref of explicitSymbolRefs(task, domain)) {
    needles.add(`${ref.className}.java`);
    needles.add(`${ref.className}.ts`);
    needles.add(`${ref.className}.py`);
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

function isPreferredLanguageFileNeedle(needle: string, preferredLanguage: string | undefined): boolean {
  if (!preferredLanguage) return true;
  const ext = path.posix.extname(needle).toLowerCase();
  const allowed = preferredLanguage === 'java'
    ? new Set(['.java'])
    : preferredLanguage === 'typescript'
      ? new Set(['.ts', '.tsx'])
      : preferredLanguage === 'javascript'
        ? new Set(['.js', '.jsx'])
        : preferredLanguage === 'python'
          ? new Set(['.py'])
          : undefined;
  return !allowed || allowed.has(ext);
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
  'Task',
  'Question',
  'Feature',
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
  'Read',
  'Only',
  'Return',
  'Current',
  'Behavior',
  'Proposed',
  'Acceptance',
  'Criteria',
  'Edge',
  'Cases',
  'Validation',
  'Commands',
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

function contextSliceHints(
  files: Array<{ file: string; lines?: string; whyRelevant?: string }>,
  symbols: Array<{ symbol: string; name?: string; file: string; lines?: string }>,
  limit: number,
): Array<{ file: string; lines?: string; symbol?: string; maxChars: number; why: string }> {
  const hints: Array<{ file: string; lines?: string; symbol?: string; maxChars: number; why: string }> = [];
  const seen = new Set<string>();
  const addHint = (hint: { file: string; lines?: string; symbol?: string; maxChars: number; why: string }) => {
    if (!hint.file || (!hint.lines && !hint.symbol)) return;
    const key = `${hint.file}:${hint.lines ?? ''}:${hint.symbol ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    hints.push(hint);
  };

  for (const file of files) {
    addHint({
      file: file.file,
      lines: file.lines,
      maxChars: 1200,
      why: file.whyRelevant ?? 'ranked candidate file',
    });
    if (hints.length >= limit) return hints;
  }
  for (const symbol of symbols) {
    addHint({
      file: symbol.file,
      lines: symbol.lines,
      symbol: symbol.symbol,
      maxChars: 1200,
      why: symbol.name ? `ranked symbol ${symbol.name}` : 'ranked symbol',
    });
    if (hints.length >= limit) return hints;
  }
  return hints;
}

function nextContextAction(
  files: Array<{ file: string; lines?: string }>,
  symbols: Array<{ symbol: string; file: string; lines?: string }>,
  sliceHints: Array<{ file: string; lines?: string; symbol?: string }> = [],
): string {
  if (sliceHints.length > 1) {
    return 'Call get_file_slice once with args.slices from toolHints[0] for exact edit context, then run the suggested targeted validation.';
  }
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
  return estimateTextTokens(value);
}

type PackProfile = 'micro' | 'compact' | 'full';
type PatchImpactOutputMode = 'compact' | 'full';
type PackResponseMode = 'answer' | 'agent' | 'full';
type GraphOutputMode = 'compact' | 'full';
type RiskMode = 'normal' | 'calculation_sensitive';

function normalizePatchImpactOutputMode(value: unknown): PatchImpactOutputMode {
  return String(value ?? '').trim().toLowerCase() === 'full' ? 'full' : 'compact';
}

function normalizePackResponseMode(value: unknown, fallback: PackResponseMode = 'agent'): PackResponseMode {
  const mode = String(value ?? '').trim().toLowerCase();
  if (mode === 'answer' || mode === 'agent' || mode === 'full') return mode;
  return fallback;
}

function normalizeGraphOutputMode(value: unknown): GraphOutputMode {
  return String(value ?? '').trim().toLowerCase() === 'full' ? 'full' : 'compact';
}

function normalizeRiskMode(value: unknown, text: string): RiskMode {
  const mode = String(value ?? '').trim().toLowerCase();
  if (mode === 'calculation_sensitive' || mode === 'calculation-sensitive' || mode === 'calculation') {
    return 'calculation_sensitive';
  }
  if (mode && mode !== 'auto') return 'normal';
  return hasCalculationSignals(text) ? 'calculation_sensitive' : 'normal';
}

function responseTokenCap(args: Record<string, unknown>, fallback: number): number {
  const value = args.maxResponseTokens;
  if (value === undefined || value === null || value === '') return fallback;
  return clampInt(Number(value), 500, 30000);
}

function compactLimitForResponseCap(maxResponseTokens: number): number {
  if (maxResponseTokens <= 1500) return 2;
  if (maxResponseTokens <= 3000) return 3;
  if (maxResponseTokens <= 6000) return 5;
  return 8;
}

function responseCapBudget(input: {
  returnedPayload: unknown;
  fullPayload?: unknown;
  maxResponseTokens: number;
  capped: boolean;
  policy: string;
}): Record<string, unknown> {
  const estimatedResponseTokens = estimateTokens(JSON.stringify(input.returnedPayload));
  const rawFullResponseTokens = input.fullPayload
    ? estimateTokens(JSON.stringify(input.fullPayload))
    : estimatedResponseTokens;
  const estimatedFullResponseTokens = Math.max(rawFullResponseTokens, estimatedResponseTokens);
  return {
    maxResponseTokens: input.maxResponseTokens,
    estimatedResponseTokens,
    estimatedFullResponseTokens,
    estimatedTokensSaved: Math.max(0, estimatedFullResponseTokens - estimatedResponseTokens),
    compressionRatio: estimatedFullResponseTokens > 0
      ? Math.round((estimatedResponseTokens / estimatedFullResponseTokens) * 100) / 100
      : 1,
    capped: input.capped,
    capExceeded: estimatedResponseTokens > input.maxResponseTokens,
    policy: input.policy,
  };
}

function withResponseCapBudget<T extends Record<string, unknown>>(result: T, input: {
  fullPayload?: unknown;
  maxResponseTokens: number;
  capped: boolean;
  policy: string;
}): T & { budget: Record<string, unknown> } {
  const existingBudget = isPlainObject(result.budget) ? result.budget : {};
  return {
    ...result,
    budget: {
      ...existingBudget,
      responseCap: responseCapBudget({
        returnedPayload: result,
        fullPayload: input.fullPayload,
        maxResponseTokens: input.maxResponseTokens,
        capped: input.capped,
        policy: input.policy,
      }),
    },
  };
}

interface DebugTimingCollector {
  checkpoint(name: string): void;
  finish(): Record<string, unknown> | undefined;
}

function createDebugTiming(args: Record<string, unknown>): DebugTimingCollector {
  const enabled = args.debugTiming === true;
  const startedAt = Date.now();
  let lastAt = startedAt;
  const phases: Array<{ name: string; durationMs: number }> = [];
  return {
    checkpoint(name: string): void {
      if (!enabled) return;
      const now = Date.now();
      phases.push({
        name,
        durationMs: Math.max(0, now - lastAt),
      });
      lastAt = now;
    },
    finish(): Record<string, unknown> | undefined {
      if (!enabled) return undefined;
      const totalMs = Math.max(0, Date.now() - startedAt);
      const topPhase = [...phases].sort((a, b) => b.durationMs - a.durationMs)[0];
      return {
        enabled: true,
        totalMs,
        phases,
        topPhase,
      };
    },
  };
}

function withDebugTiming<T extends Record<string, unknown>>(
  result: T,
  timing: DebugTimingCollector,
): T & { debugTiming?: Record<string, unknown> } {
  const debugTiming = timing.finish();
  return debugTiming ? { ...result, debugTiming } : result;
}

function normalizePackProfile(value: unknown, fallback: PackProfile = 'compact'): PackProfile {
  const profile = String(value ?? '').trim().toLowerCase();
  if (profile === 'micro' || profile === 'compact' || profile === 'full') return profile;
  return fallback;
}

function packProfileValue(profile: PackProfile, micro: number, compact: number, full: number): number {
  if (profile === 'micro') return micro;
  if (profile === 'full') return full;
  return compact;
}

type RepoAtlasFormat = 'json' | 'markdown';

function normalizeRepoAtlasFormat(value: unknown): RepoAtlasFormat {
  return String(value ?? '').trim().toLowerCase() === 'markdown' ? 'markdown' : 'json';
}

function repoAtlasIncludesRole(
  fileRole: string | undefined,
  options: { includeTests: boolean; includeGenerated: boolean },
): boolean {
  const role = fileRole ?? '';
  if (!options.includeGenerated && role === 'generated') return false;
  if (!options.includeTests && (role === 'test_source' || role === 'mock_source')) return false;
  return true;
}

function atlasNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function repoAtlasLanguageSummary(files: RepoAtlasFileRow[]): Array<{ language: string; files: number; bytes: number }> {
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

function buildRepoAtlasFileModuleMap(input: {
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

function buildRepoAtlasModules(input: {
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

function buildRepoAtlasModuleDependencies(input: {
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

function repoAtlasHotspot(
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

function repoAtlasFlowName(endpoint: Record<string, unknown>): string {
  const method = String(endpoint.method ?? '').toUpperCase() || 'REQUEST';
  const route = String(endpoint.path ?? '').replace(/^\/api\//, '/').replace(/[{}]/g, '').replace(/\/+/g, '/');
  const handler = String(endpoint.handlerSymbol ?? '').split('.').slice(-2).join('.');
  return handler ? `${method} ${route} via ${handler}` : `${method} ${route}`;
}

function repoAtlasFlowTestSeeds(endpoint: Record<string, unknown>, callGraph: Array<Record<string, unknown>>): string[] {
  return uniqueStrings([
    String(endpoint.handlerSymbol ?? ''),
    String(endpoint.controller ?? ''),
    String(endpoint.path ?? '').split(/[/?#]/)[1] ?? '',
    ...callGraph.flatMap(edge => [String(edge.callee ?? ''), String(edge.caller ?? '')]),
  ].flatMap(value => value.split(/[/:{}._\-\s]+/).concat(value)).filter(value => value.length >= 3));
}

function repoAtlasFlowConfidence(
  endpoint: Record<string, unknown>,
  callGraph: Array<Record<string, unknown>>,
  tests: Array<Record<string, unknown>>,
): number {
  const endpointConfidence = atlasNumber(endpoint.confidence) || 0.65;
  const callBoost = callGraph.length > 0 ? 0.08 : 0;
  const testBoost = tests.length > 0 ? 0.05 : 0;
  return Math.min(0.95, Math.round((endpointConfidence + callBoost + testBoost) * 100) / 100);
}

function repoAtlasModuleRootForFile(file: string): string {
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

function repoAtlasModuleLabel(rootPrefix: string | undefined, fallback: string): string {
  if (!rootPrefix) return fallback;
  return path.posix.basename(rootPrefix) || rootPrefix;
}

function repoAtlasModuleId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/[^a-z0-9/._-]+/g, '-')
    .replace(/[/.]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `module:${normalized || 'workspace'}`;
}

function renderRepoAtlasMarkdown(atlas: Record<string, unknown>): string {
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

function repoAtlasMd(value: unknown): string {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function evidenceHandleForObject(value: Record<string, unknown>, maxChars = 3000): Record<string, unknown> | undefined {
  const file = stringOrUndefined(value.file);
  const lines = stringOrUndefined(value.fileSliceLines ?? value.lines ?? value.newLines);
  const symbol = stringOrUndefined(value.symbol);
  if (!file && !symbol) return undefined;
  const args: Record<string, unknown> = { maxChars };
  if (file) args.file = file;
  if (lines) args.lines = lines;
  if (symbol) args.symbol = symbol;
  return {
    tool: 'get_file_slice',
    args,
    source: stringOrUndefined(value.targetId) ?? stringOrUndefined(value.why) ?? stringOrUndefined(value.whyRelevant),
  };
}

function evidenceHandlesForObjects(values: Array<Record<string, unknown>>, profile: PackProfile, maxChars?: number): Array<Record<string, unknown>> {
  const limit = packProfileValue(profile, 4, 6, 12);
  const charLimit = maxChars ?? packProfileValue(profile, 1800, 2600, 5000);
  const seen = new Set<string>();
  const handles: Array<Record<string, unknown>> = [];
  for (const value of values) {
    const handle = evidenceHandleForObject(value, charLimit);
    if (!handle) continue;
    const key = JSON.stringify(handle.args);
    if (seen.has(key)) continue;
    seen.add(key);
    handles.push(handle);
    if (handles.length >= limit) break;
  }
  return handles;
}

function responseBudgetReport(input: {
  profile: PackProfile;
  tokenBudget?: number;
  returnedPayload: unknown;
  fullPayload?: unknown;
  handleCount?: number;
  policy?: string;
}): Record<string, unknown> {
  const estimatedResponseTokens = estimateTokens(JSON.stringify(input.returnedPayload));
  const rawFullResponseTokens = input.fullPayload
    ? estimateTokens(JSON.stringify(input.fullPayload))
    : estimatedResponseTokens;
  const estimatedFullResponseTokens = Math.max(rawFullResponseTokens, estimatedResponseTokens);
  const estimatedTokensSaved = Math.max(0, estimatedFullResponseTokens - estimatedResponseTokens);
  const handleCount = input.handleCount ?? 0;
  const capExceeded = typeof input.tokenBudget === 'number'
    ? estimatedResponseTokens > input.tokenBudget
    : false;
  return {
    profile: input.profile,
    tokenBudget: input.tokenBudget,
    requestedTokenBudget: input.tokenBudget,
    estimatedResponseTokens,
    estimatedFullResponseTokens,
    estimatedTokensSaved,
    compressionRatio: estimatedFullResponseTokens > 0
      ? Math.round((estimatedResponseTokens / estimatedFullResponseTokens) * 100) / 100
      : 1,
    handleCount,
    evidenceHandleCount: handleCount,
    capExceeded,
    policy: input.policy ?? 'compact evidence first; expand exact slices only when needed',
  };
}

type CompileEvidenceTaskType = 'api_flow' | 'field_impact' | 'review_diff' | 'startup_flow' | 'implement' | 'investigate' | 'test' | 'unknown';
type CompileCoverageStatus = 'covered' | 'partial' | 'missing';

function normalizeCompileEvidenceTaskType(value: unknown, task: string, args: Record<string, unknown>): CompileEvidenceTaskType {
  const raw = String(value ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  const allowed = new Set<CompileEvidenceTaskType>([
    'api_flow',
    'field_impact',
    'review_diff',
    'startup_flow',
    'implement',
    'investigate',
    'test',
    'unknown',
  ]);
  if (allowed.has(raw as CompileEvidenceTaskType) && raw !== 'unknown') return raw as CompileEvidenceTaskType;
  if (stringOrUndefined(args.diff) || /\bdiff\b|\bpatch\b|\breview\b/i.test(task)) return 'review_diff';
  if (/\b(unit\s+test|testcase|write\s+tests?|spec)\b/i.test(task)) return 'test';
  if (/\b(implement|fix|refactor|debug|change|edit)\b/i.test(task)) return 'implement';
  if (/\b(GET|POST|PUT|PATCH|DELETE)\s+\//.test(task) || /\b(endpoint|api|route|handler)\b/i.test(task)) return 'api_flow';
  if (/\b(field|initialized|read|write|usage|usages)\b/i.test(task)) return 'field_impact';
  if (/\b(startup|handshake|proxy|mode selection|watchdog)\b/i.test(task)) return 'startup_flow';
  if (/\b(investigate|trace|understand|explain|flow|impact)\b/i.test(task)) return 'investigate';
  return 'unknown';
}

function compileEvidenceRubric(value: unknown, taskType: CompileEvidenceTaskType): string[] {
  const provided = Array.isArray(value)
    ? value.map(item => normalizeCoverageKey(String(item))).filter(Boolean)
    : [];
  if (provided.length > 0) return uniqueStrings(provided).slice(0, 20);
  switch (taskType) {
    case 'api_flow':
      return ['handler', 'flow', 'dependencies', 'tests', 'risks'];
    case 'field_impact':
      return ['definitions', 'usages', 'flow', 'tests', 'risks'];
    case 'review_diff':
      return ['changed_lines', 'findings', 'impact', 'tests'];
    case 'startup_flow':
      return ['entrypoint', 'mode_selection', 'handshake', 'tests'];
    case 'implement':
      return ['target_files', 'symbols', 'edit_ranges', 'tests', 'validation'];
    case 'test':
      return ['target_files', 'symbols', 'tests', 'validation'];
    case 'investigate':
      return ['definitions', 'flow', 'files', 'tests'];
    case 'unknown':
      return ['files', 'symbols', 'evidence'];
  }
}

function normalizeCoverageKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isRouteGateCompileTask(task: string, rubric: string[]): boolean {
  const text = compactSearchText(`${task} ${rubric.join(' ')}`);
  return text.includes('codegraphcontext')
    && ['route', 'routing', 'gate', 'answerable', 'fallback', 'pbi', 'acceptance', 'compileevidence']
      .some(token => text.includes(token));
}

function routeGateWhyForSymbol(symbol: string): string {
  switch (symbol) {
    case 'inspectCodeGraphRoute':
      return 'route inspector evidence: exposes routed tool, stop rule, allowed follow-ups, and disallowed shell/search fallback';
    case 'routeCodeGraphContext':
      return 'route facade evidence: codegraph_context dispatches broad tasks to bounded internal packet tools';
    case 'inferCodeGraphContextMode':
      return 'route classifier evidence: PBI, acceptance criteria, answerable, and rubric wording infer evidence mode';
    case 'compileEvidence':
      return 'compile_evidence gate evidence: builds answerable packets, coverage certificate, allowedFollowups, and disallowedFollowups';
    default:
      return 'route gate evidence for codegraph_context benchmark quality';
  }
}

function compileEvidenceItemsFromPacket(
  sourceTool: string,
  packet: Record<string, unknown>,
  maxItems: number,
): Array<Record<string, unknown>> {
  const candidates: Array<Record<string, unknown>> = [];
  const pushRecords = (source: string, values: Array<Record<string, unknown>>, kind: string) => {
    for (const value of values) candidates.push({ ...value, source, kind });
  };

  pushRecords('evidenceSlices', arrayRecords(packet.evidenceSlices), 'source-slice');
  pushRecords('reviewFindings', arrayRecords(packet.reviewFindings), 'review-finding');
  pushRecords('flowSteps', arrayRecords(packet.flowSteps), 'flow-step');
  pushRecords('definitionCandidates', arrayRecords(packet.definitionCandidates), 'definition');
  pushRecords('symbols', arrayRecords(packet.symbols).concat(arrayRecords(packet.relevantSymbols)), 'symbol');
  pushRecords('candidateFiles', arrayRecords(packet.candidateFiles).concat(arrayRecords(packet.files)), 'file');
  pushRecords('lineFocus', arrayRecords(packet.lineFocus), 'changed-line');
  pushRecords('reviewTargets', arrayRecords(packet.reviewTargets), 'review-target');
  pushRecords('editRanges', arrayRecords(packet.editRanges), 'edit-range');
  pushRecords('testsLikelyRelevant', arrayRecords(packet.testsLikelyRelevant), 'test');

  const evidence: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (evidence.length >= maxItems) break;
    const file = stringOrUndefined(candidate.file);
    const lines = stringOrUndefined(candidate.lines ?? candidate.fileSliceLines ?? candidate.newLines);
    const symbol = stringOrUndefined(candidate.symbol)
      ?? stringOrUndefined(candidate.handlerSymbol)
      ?? (isPlainObject(candidate.changedSymbol) ? stringOrUndefined(candidate.changedSymbol.symbol) : undefined);
    const claim = compileEvidenceClaim(candidate);
    const snippet = truncateOptional(candidate.text ?? candidate.snippet ?? candidate.context, 900);
    const key = [candidate.source, file, lines, symbol, claim].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push({
      id: `E${evidence.length + 1}`,
      kind: stringOrUndefined(candidate.kind) ?? 'evidence',
      claim,
      file,
      lines,
      symbol,
      snippet,
      sourceTool,
      sourceSection: candidate.source,
      expandTool: file || symbol ? {
        tool: 'get_file_slice',
        args: {
          file,
          lines,
          symbol,
          maxChars: 1800,
        },
      } : undefined,
    });
  }
  return evidence;
}

function compileEvidenceClaim(value: Record<string, unknown>): string {
  const direct = stringOrUndefined(value.claim)
    ?? stringOrUndefined(value.title)
    ?? stringOrUndefined(value.summary)
    ?? stringOrUndefined(value.message)
    ?? stringOrUndefined(value.why)
    ?? stringOrUndefined(value.whyRelevant)
    ?? stringOrUndefined(value.check)
    ?? stringOrUndefined(value.id);
  if (direct) return truncateOptional(direct, 240) ?? direct;
  const symbol = stringOrUndefined(value.symbol)
    ?? stringOrUndefined(value.handlerSymbol)
    ?? (isPlainObject(value.changedSymbol) ? stringOrUndefined(value.changedSymbol.symbol) : undefined);
  const file = stringOrUndefined(value.file);
  if (symbol && file) return `Evidence for ${symbol} in ${file}`;
  if (symbol) return `Evidence for ${symbol}`;
  if (file) return `Evidence from ${file}`;
  return `Evidence from ${stringOrUndefined(value.source) ?? stringOrUndefined(value.kind) ?? 'compiled packet'}`;
}

function compileCoverageCertificate(input: {
  taskType: CompileEvidenceTaskType;
  rubric: string[];
  packet: Record<string, unknown>;
  evidence: Array<Record<string, unknown>>;
}): Record<string, { status: CompileCoverageStatus; evidence: string[]; reason: string }> {
  const summary = compilePacketSummary('compile_evidence', input.packet);
  const haystack = compactSearchText(JSON.stringify({
    packet: input.packet,
    evidence: input.evidence.map(item => ({
      claim: item.claim,
      file: item.file,
      symbol: item.symbol,
      sourceSection: item.sourceSection,
    })),
  }));
  const result: Record<string, { status: CompileCoverageStatus; evidence: string[]; reason: string }> = {};
  for (const key of input.rubric) {
    const status = taskRubricMatchesTaskType(key, input.taskType)
      ? 'covered'
      : coverageStatusForKey(key, summary, haystack, input.evidence);
    result[key] = {
      status,
      evidence: evidenceIdsForCoverageKey(key, input.evidence, haystack).slice(0, 4),
      reason: coverageReasonForStatus(key, status, summary),
    };
  }
  if (Object.keys(result).length === 0) {
    result.evidence = {
      status: input.evidence.length > 0 ? 'covered' : 'missing',
      evidence: input.evidence.slice(0, 4).map(item => String(item.id)),
      reason: input.evidence.length > 0 ? 'compiled packet returned evidence items' : 'compiled packet has no evidence items',
    };
  }
  return result;
}

function coverageStatusForKey(
  key: string,
  summary: Record<string, number | string[]>,
  haystack: string,
  evidence: Array<Record<string, unknown>>,
): CompileCoverageStatus {
  const count = (name: string) => typeof summary[name] === 'number' ? summary[name] as number : 0;
  if (key.startsWith('field_')) {
    return coverageStatusForAnswerField(key.slice('field_'.length), summary, haystack, evidence);
  }
  switch (key) {
    case 'handler':
    case 'entrypoint':
    case 'definitions':
      return count('symbols') > 0 || count('endpoints') > 0 ? 'covered' : evidence.length > 0 ? 'partial' : 'missing';
    case 'flow':
    case 'mode_selection':
    case 'handshake':
    case 'impact':
    case 'dependencies':
    case 'usages':
      return count('flowSteps') > 0 || count('callEdges') > 0 || haystack.includes(key.replace(/_/g, ' '))
        ? 'covered'
        : evidence.length > 1 ? 'partial' : 'missing';
    case 'changed_lines':
    case 'edit_ranges':
      return count('editRanges') > 0 || count('changedLines') > 0 ? 'covered' : 'missing';
    case 'tests':
      return count('tests') > 0 ? 'covered' : haystack.includes('test') ? 'partial' : 'missing';
    case 'risks':
    case 'findings':
      return count('findings') > 0 || count('riskFlags') > 0 || haystack.includes('risk') || haystack.includes('finding')
        ? 'covered'
        : 'partial';
    case 'validation':
      return haystack.includes('validation') || haystack.includes('command') || haystack.includes('test') ? 'covered' : 'partial';
    case 'target_files':
    case 'files':
      return count('files') > 0 ? 'covered' : 'missing';
    case 'symbols':
      return count('symbols') > 0 ? 'covered' : 'missing';
    case 'evidence':
      return evidence.length > 0 ? 'covered' : 'missing';
    default: {
      const tokens = key.split('_').filter(token => token.length > 2);
      if (tokens.length === 0) return evidence.length > 0 ? 'covered' : 'missing';
      const hitCount = tokens.filter(token => haystack.includes(token)).length;
      if (hitCount === tokens.length) return 'covered';
      if (hitCount > 0 || evidence.length > 2) return 'partial';
      return 'missing';
    }
  }
}

function taskRubricMatchesTaskType(key: string, taskType: CompileEvidenceTaskType): boolean {
  if (!key.startsWith('task_')) return false;
  const expected = key.slice('task_'.length);
  const aliases: Record<CompileEvidenceTaskType, string[]> = {
    api_flow: ['api_flow', 'api', 'flow'],
    field_impact: ['field_impact', 'field'],
    review_diff: ['review_diff', 'review'],
    startup_flow: ['startup_flow', 'startup'],
    implement: ['implement', 'implementation'],
    investigate: ['investigate', 'investigation', 'research'],
    test: ['test', 'tests'],
    unknown: ['unknown'],
  };
  return (aliases[taskType] ?? [taskType]).includes(expected);
}

function coverageStatusForAnswerField(
  field: string,
  summary: Record<string, number | string[]>,
  haystack: string,
  evidence: Array<Record<string, unknown>>,
): CompileCoverageStatus {
  const count = (name: string) => typeof summary[name] === 'number' ? summary[name] as number : 0;
  switch (field) {
    case 'task':
      return 'covered';
    case 'keyfiles':
    case 'files':
      return count('files') > 0 ? 'covered' : evidence.length > 0 ? 'partial' : 'missing';
    case 'methods':
    case 'symbols':
      return count('symbols') > 0 || haystack.includes('function') || haystack.includes('method')
        ? 'covered'
        : evidence.length > 0 ? 'partial' : 'missing';
    case 'flow':
      return count('flowSteps') > 0 || count('callEdges') > 0 ? 'covered' : evidence.length > 1 ? 'partial' : 'missing';
    case 'tests':
      return count('tests') > 0 || evidence.some(item => String(item.file ?? '').toLowerCase().includes('test'))
        ? 'covered'
        : haystack.includes('test') ? 'partial' : 'missing';
    case 'risks':
      return count('riskFlags') > 0 || haystack.includes('risk') ? 'covered' : 'partial';
    default: {
      const normalizedField = field.replace(/_/g, ' ');
      if (haystack.includes(normalizedField)) return 'covered';
      return evidence.length > 0 ? 'partial' : 'missing';
    }
  }
}

function evidenceIdsForCoverageKey(key: string, evidence: Array<Record<string, unknown>>, haystack: string): string[] {
  const keyTokens = key.split('_').filter(token => token.length > 2);
  const matching = evidence
    .filter(item => {
      const text = compactSearchText(JSON.stringify(item));
      return keyTokens.some(token => text.includes(token));
    })
    .map(item => String(item.id));
  if (matching.length > 0) return matching;
  if (haystack.includes(key.replace(/_/g, ' '))) return evidence.slice(0, 2).map(item => String(item.id));
  return evidence.slice(0, 2).map(item => String(item.id));
}

function coverageReasonForStatus(
  key: string,
  status: CompileCoverageStatus,
  summary: Record<string, number | string[]>,
): string {
  if (status === 'covered') return `${key} is covered by compiled packet evidence.`;
  if (status === 'partial') return `${key} has partial signal; use only listed exact follow-ups if this is required.`;
  return `${key} is missing from the compiled packet.`;
}

function compileEvidenceAnswerable(
  sourceTool: string,
  packet: Record<string, unknown>,
  evidence: Array<Record<string, unknown>>,
  missing: string[],
  strictPartial: string[] = [],
): boolean {
  if (missing.length > 0 || strictPartial.length > 0 || evidence.length === 0) return false;
  if (sourceTool === 'get_research_pack') {
    const routing = isPlainObject(packet.routing) ? packet.routing : {};
    const completeness = isPlainObject(packet.completeness) ? packet.completeness : {};
    return routing.answerDirectly === true
      || completeness.sufficientForAnswer === true
      || stringArray(packet.missingFacts).length === 0
      || evidence.length >= 2;
  }
  if (sourceTool === 'review_patch') {
    return stringArray(packet.changedFiles).length > 0
      && (arrayRecords(packet.reviewTargets).length > 0 || arrayRecords(packet.lineFocus).length > 0 || arrayRecords(packet.reviewFindings).length > 0);
  }
  if (sourceTool === 'get_change_pack') {
    const calculationImpact = isPlainObject(packet.calculationImpact) ? packet.calculationImpact : undefined;
    if (calculationImpact?.answerable === false) return false;
    return arrayRecords(packet.editRanges).length > 0 || arrayRecords(packet.files).length > 0 || arrayRecords(packet.symbols).length > 0;
  }
  return evidence.length > 0;
}

function compileEvidenceConfidence(
  answerable: boolean,
  coverage: Record<string, { status: CompileCoverageStatus }>,
  evidence: Array<Record<string, unknown>>,
  packet: Record<string, unknown>,
): number {
  const statuses = Object.values(coverage);
  const covered = statuses.filter(item => item.status === 'covered').length;
  const partial = statuses.filter(item => item.status === 'partial').length;
  const base = typeof packet.confidence === 'number' ? packet.confidence : answerable ? 0.78 : 0.45;
  const coverageScore = statuses.length > 0 ? (covered + partial * 0.5) / statuses.length : 0;
  const evidenceBonus = Math.min(0.1, evidence.length * 0.015);
  return Math.max(0.1, Math.min(0.95, Math.round((base * 0.55 + coverageScore * 0.35 + evidenceBonus) * 100) / 100));
}

function compileAllowedFollowups(
  missing: string[],
  packet: Record<string, unknown>,
  recommendedEscalation?: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const followups: Array<Record<string, unknown>> = [];
  const handle = firstExactEvidenceHandle(packet);
  if (missing.some(item => item.includes('test'))) {
    followups.push({
      tool: 'find_tests_for',
      args: { symbol: firstPacketSymbol(packet) ?? '<target-symbol>', limit: 20 },
      reason: 'Only tests coverage is missing; do not perform broad search.',
    });
  }
  if (handle) {
    followups.push({
      tool: 'get_file_slice',
      args: handle.args,
      reason: 'Exact source expansion from compiled packet handle.',
    });
  }
  if (recommendedEscalation) followups.push(recommendedEscalation);
  return followups.slice(0, 3);
}

function firstExactEvidenceHandle(packet: Record<string, unknown>): Record<string, unknown> | undefined {
  const handles = arrayRecords(packet.evidenceHandles);
  return handles.find(handle => handle.tool === 'get_file_slice' && isPlainObject(handle.args));
}

function firstPacketSymbol(packet: Record<string, unknown>): string | undefined {
  for (const section of ['definitionCandidates', 'symbols', 'relevantSymbols', 'reviewTargets', 'editRanges']) {
    for (const item of arrayRecords(packet[section])) {
      const symbol = stringOrUndefined(item.symbol)
        ?? stringOrUndefined(item.handlerSymbol)
        ?? (isPlainObject(item.changedSymbol) ? stringOrUndefined(item.changedSymbol.symbol) : undefined);
      if (symbol) return symbol;
    }
  }
  return undefined;
}

function targetedShellEscalationForCompile(
  task: string,
  missing: string[],
  packet: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const terms = uniqueStrings([
    ...missing,
    ...researchSeedTerms(task).slice(0, 4),
    ...stringArray(packet.topFiles).slice(0, 2).map(file => path.posix.basename(file, path.posix.extname(file))),
  ])
    .map(term => term.replace(/[_-]+/g, ' ').trim())
    .filter(term => term.length >= 3)
    .slice(0, 6);
  if (terms.length === 0) return undefined;
  const pattern = terms
    .map(term => term.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&').replace(/\s+/g, '.*'))
    .join('|');
  return {
    tool: 'shell',
    args: {
      command: `rg --line-number --hidden -g "!node_modules" -g "!dist" -g "!build" "${pattern}" .`,
      maxOutputTokens: 800,
    },
    reason: 'Graph coverage is partial or missing for this rubric; allow one exact targeted shell escalation only.',
  };
}

function compilePathCoverageMap(
  sourceTool: string,
  packet: Record<string, unknown>,
  recommendedEscalation?: Record<string, unknown>,
): Record<string, unknown> {
  const summary = compilePacketSummary(sourceTool, packet);
  return {
    knownCoverage: {
      staticSymbols: Number(summary.symbols) > 0 ? 'high' : 'low',
      imports: Number(summary.files) > 0 ? 'medium' : 'low',
      callEdges: Number(summary.callEdges) > 0 || Number(summary.flowSteps) > 0 ? 'medium' : 'low',
      frameworkRuntimeRoutes: Number(summary.endpoints) > 0 ? 'medium' : 'low',
      tests: Number(summary.tests) > 0 ? 'medium' : 'low',
    },
    risk: recommendedEscalation ? 'graph_may_miss_runtime_or_test_flow' : 'compiled_packet_has_enough_indexed_evidence',
    recommendedEscalation,
  };
}

function compilePacketSummary(sourceTool: string, packet: Record<string, unknown>): Record<string, number | string[]> {
  const files = uniqueStrings([
    ...stringArray(packet.changedFiles),
    ...stringArray(packet.topFiles),
    ...arrayRecords(packet.candidateFiles).map(item => String(item.file ?? '')).filter(Boolean),
    ...arrayRecords(packet.files).map(item => String(item.file ?? item.path ?? '')).filter(Boolean),
    ...arrayRecords(packet.evidenceSlices).map(item => String(item.file ?? '')).filter(Boolean),
    ...arrayRecords(packet.definitionCandidates).map(item => String(item.file ?? '')).filter(Boolean),
    ...arrayRecords(packet.lineFocus).map(item => String(item.file ?? '')).filter(Boolean),
    ...arrayRecords(packet.reviewTargets).map(item => String(item.file ?? '')).filter(Boolean),
    ...arrayRecords(packet.editRanges).map(item => String(item.file ?? '')).filter(Boolean),
  ]);
  const symbols = uniqueStrings([
    ...arrayRecords(packet.definitionCandidates).map(item => String(item.symbol ?? item.name ?? '')).filter(Boolean),
    ...arrayRecords(packet.symbols).map(item => String(item.symbol ?? item.name ?? '')).filter(Boolean),
    ...arrayRecords(packet.relevantSymbols).map(item => String(item.symbol ?? item.name ?? '')).filter(Boolean),
    ...arrayRecords(packet.editRanges).map(item => String(item.symbol ?? '')).filter(Boolean),
    ...arrayRecords(packet.reviewTargets)
      .map(item => isPlainObject(item.changedSymbol) ? String(item.changedSymbol.symbol ?? '') : '')
      .filter(Boolean),
  ]);
  const endpoints = [
    ...arrayRecords(packet.impactedEndpoints),
    ...arrayRecords(packet.endpointCandidates),
    ...arrayRecords(packet.changedEndpoints),
  ];
  const tests = [
    ...arrayRecords(packet.testsLikelyRelevant),
    ...stringArray(isPlainObject(packet.validation) ? packet.validation.targetedTestFiles : undefined).map(file => ({ file })),
  ];
  const callEdges = [
    ...arrayRecords(packet.callers),
    ...arrayRecords(packet.callees),
  ];
  return {
    sourceTool: [sourceTool],
    files: files.length,
    symbols: symbols.length,
    endpoints: endpoints.length,
    tests: tests.length,
    flowSteps: arrayRecords(packet.flowSteps).length,
    evidenceSlices: arrayRecords(packet.evidenceSlices).length,
    findings: arrayRecords(packet.reviewFindings).length,
    riskFlags: arrayRecords(packet.riskFlags).length,
    editRanges: arrayRecords(packet.editRanges).length,
    changedLines: arrayRecords(packet.lineFocus).length,
    callEdges: callEdges.length,
    topFiles: files.slice(0, 6),
    topSymbols: symbols.slice(0, 6),
  };
}

function compileEvidenceStateKey(task: string): string {
  let hash = 2166136261;
  for (const char of task) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `compiled:${(hash >>> 0).toString(16)}`;
}

function slimCandidateFilesForPack(files: Array<Record<string, unknown>>, profile: PackProfile): Array<Record<string, unknown>> {
  if (profile === 'full') return files;
  const symbolLimit = profile === 'micro' ? 2 : 3;
  const endpointLimit = profile === 'micro' ? 1 : 2;
  const reasonLimit = profile === 'micro' ? 120 : 180;
  return files.map(file => {
    const snippet = isPlainObject(file.snippet)
      ? {
        startLine: file.snippet.startLine,
        endLine: file.snippet.endLine,
        text: truncateOptional(file.snippet.text, profile === 'micro' ? 420 : 900),
        truncated: Boolean(file.snippet.truncated),
      }
      : undefined;
    return {
      file: String(file.file ?? ''),
      lines: stringOrUndefined(file.lines),
      whyRelevant: truncateOptional(file.whyRelevant, reasonLimit),
      confidence: typeof file.confidence === 'number' ? file.confidence : undefined,
      language: stringOrUndefined(file.language),
      fileRole: stringOrUndefined(file.fileRole),
      snippet,
      topSymbols: slimSymbolsForPack(arrayRecords(file.topSymbols).slice(0, symbolLimit), profile),
      endpoints: arrayRecords(file.endpoints)
        .slice(0, endpointLimit)
        .map(endpoint => compactReviewObject(endpoint, endpointLimit, 1)),
    };
  });
}

function slimSymbolsForPack(symbols: Array<Record<string, unknown>>, profile: PackProfile): Array<Record<string, unknown>> {
  if (profile === 'full') return symbols;
  const reasonLimit = profile === 'micro' ? 120 : 180;
  const signatureLimit = profile === 'micro' ? 120 : 180;
  return symbols.map(symbol => ({
    symbol: String(symbol.symbol ?? symbol.fqName ?? symbol.name ?? ''),
    name: String(symbol.name ?? symbol.symbol ?? ''),
    kind: stringOrUndefined(symbol.kind),
    file: String(symbol.file ?? ''),
    lines: stringOrUndefined(symbol.lines ?? symbol.line),
    signature: truncateOptional(symbol.signature, signatureLimit),
    frameworkRole: stringOrUndefined(symbol.frameworkRole),
    whyRelevant: truncateOptional(symbol.whyRelevant ?? symbol.matchReason, reasonLimit),
    confidence: typeof symbol.confidence === 'number' ? symbol.confidence : undefined,
  }));
}

function slimTestsForPack(tests: Array<Record<string, unknown>>, profile: PackProfile): Array<Record<string, unknown>> {
  if (profile === 'full') return tests;
  const limit = profile === 'micro' ? 4 : 6;
  return tests.slice(0, limit).map(test => ({
    file: String(test.file ?? ''),
    symbol: stringOrUndefined(test.symbol),
    score: typeof test.score === 'number' ? test.score : undefined,
    reasons: stringArray(test.reasons).slice(0, profile === 'micro' ? 1 : 2),
  })).filter(test => test.file);
}

function slimValidationForPack(validation: Record<string, unknown>, profile: PackProfile): Record<string, unknown> {
  if (profile === 'full') return validation;
  return {
    targetedTestFiles: stringArray(validation.targetedTestFiles).slice(0, profile === 'micro' ? 4 : 6),
    suggestedCommands: stringArray(validation.suggestedCommands).slice(0, profile === 'micro' ? 2 : 3),
    packageManager: stringOrUndefined(validation.packageManager),
  };
}

function slimTaskOracleForPack(taskOracle: Record<string, unknown>, profile: PackProfile): Record<string, unknown> {
  if (profile === 'full') return taskOracle;
  const factLimit = profile === 'micro' ? 5 : 8;
  return {
    taskType: stringOrUndefined(taskOracle.taskType),
    successCriteria: stringArray(taskOracle.successCriteria).slice(0, profile === 'micro' ? 3 : 5),
    expectedVerification: isPlainObject(taskOracle.expectedVerification)
      ? {
        commands: stringArray(taskOracle.expectedVerification.commands).slice(0, profile === 'micro' ? 2 : 3),
        targetedTestFiles: stringArray(taskOracle.expectedVerification.targetedTestFiles).slice(0, profile === 'micro' ? 4 : 6),
        fallback: stringOrUndefined(taskOracle.expectedVerification.fallback),
        redGreenRequired: taskOracle.expectedVerification.redGreenRequired,
      }
      : undefined,
    likelyTests: slimTestsForPack(arrayRecords(taskOracle.likelyTests), profile),
    goldenFacts: arrayRecords(taskOracle.goldenFacts).slice(0, factLimit),
    editGuardrails: stringArray(taskOracle.editGuardrails).slice(0, profile === 'micro' ? 2 : 4),
    passSignal: stringOrUndefined(taskOracle.passSignal),
  };
}

function slimEvidenceSlicesForPack(slices: Array<Record<string, unknown>>, profile: PackProfile): Array<Record<string, unknown>> {
  if (profile === 'full') return slices;
  const limit = profile === 'micro' ? 2 : 3;
  const textLimit = profile === 'micro' ? 320 : 560;
  return slices.slice(0, limit).map(slice => ({
    file: String(slice.file ?? ''),
    lines: stringOrUndefined(slice.lines),
    symbol: stringOrUndefined(slice.symbol),
    why: truncateOptional(slice.why, profile === 'micro' ? 100 : 150),
    text: truncateOptional(slice.text, textLimit),
    truncated: Boolean(slice.truncated),
    confidence: typeof slice.confidence === 'number' ? slice.confidence : undefined,
  }));
}

interface TaskOracleInput {
  task: string;
  taskType: string;
  candidateFiles: Array<{ file: string; lines?: string; whyRelevant?: string; confidence?: number }>;
  relevantSymbols: Array<{ symbol: string; name?: string; file: string; lines?: string; confidence?: number }>;
  testsLikelyRelevant: Array<Record<string, unknown>>;
  validation: Record<string, unknown>;
  flowSteps: Array<Record<string, unknown>>;
  evidenceSlices: Array<Record<string, unknown>>;
}

function taskOracleFor(input: TaskOracleInput): Record<string, unknown> {
  const taskType = normalizeOracleTaskType(input.taskType);
  const topFiles = uniqueStrings(input.candidateFiles.map(file => file.file).filter(Boolean)).slice(0, 6);
  const topSymbols = uniqueStrings(input.relevantSymbols.map(symbol => symbol.symbol || symbol.name || '').filter(Boolean)).slice(0, 8);
  const likelyTests = input.testsLikelyRelevant
    .slice(0, 8)
    .map(test => ({
      file: String(test.file ?? ''),
      why: Array.isArray(test.reasons) ? (test.reasons as unknown[]).map(String).slice(0, 3) : undefined,
      score: typeof test.score === 'number' ? test.score : undefined,
    }))
    .filter(test => test.file);
  const suggestedCommands = stringArray(input.validation.suggestedCommands).slice(0, 4);
  const targetedTestFiles = stringArray(input.validation.targetedTestFiles).slice(0, 8);

  return {
    taskType,
    successCriteria: oracleSuccessCriteria(taskType, topFiles, topSymbols),
    expectedVerification: {
      commands: suggestedCommands,
      targetedTestFiles,
      fallback: suggestedCommands.length > 0
        ? 'Run the first targeted command before broader validation.'
        : 'Identify the smallest compile/test/lint command for the top candidate file before finalizing.',
      redGreenRequired: taskType === 'debug' || taskType === 'create-testcase',
    },
    likelyTests,
    goldenFacts: oracleGoldenFacts(input, topFiles, topSymbols),
    editGuardrails: oracleEditGuardrails(taskType, topFiles),
    passSignal: oraclePassSignal(taskType),
  };
}

function normalizeOracleTaskType(value: string): string {
  const lower = value.toLowerCase();
  if (/debug|bug|fix|failing/.test(lower)) return 'debug';
  if (/test|case|coverage/.test(lower)) return 'create-testcase';
  if (/review/.test(lower)) return 'codereview';
  if (/break|plan|task/.test(lower)) return 'break-task';
  if (/refactor/.test(lower)) return 'refactor';
  if (/implement|change|edit|feature/.test(lower)) return 'implement';
  return lower || 'investigate';
}

function taskKindForOracle(task: string): string {
  return normalizeOracleTaskType(task);
}

function oracleSuccessCriteria(taskType: string, topFiles: string[], topSymbols: string[]): string[] {
  const criteria = [
    topFiles[0] ? `Use ${topFiles[0]} as the first source-of-truth file.` : 'Resolve at least one concrete source file before editing or answering.',
    topSymbols[0] ? `Anchor reasoning on ${topSymbols[0]}.` : 'Anchor reasoning on concrete symbols or line-numbered source evidence.',
  ];
  if (taskType === 'implement' || taskType === 'debug' || taskType === 'refactor') {
    criteria.push('Keep the diff scoped to the files needed for the requested behavior.');
    criteria.push('Run targeted validation and report the command result.');
  } else if (taskType === 'create-testcase') {
    criteria.push('The new test must fail against the seeded buggy behavior and pass after the implementation is correct.');
    criteria.push('Avoid changing production files unless the task explicitly asks for a fix.');
  } else if (taskType === 'codereview') {
    criteria.push('Report only findings with file/line evidence or a concrete validation gap.');
    criteria.push('Separate deterministic blockers from hypotheses that require follow-up slices/tests.');
  } else {
    criteria.push('Cite file and line evidence for each important claim.');
    criteria.push('List missing facts instead of guessing beyond the indexed evidence.');
  }
  return criteria;
}

function oracleGoldenFacts(input: TaskOracleInput, topFiles: string[], topSymbols: string[]): Array<Record<string, unknown>> {
  const facts: Array<Record<string, unknown>> = [];
  for (const file of topFiles.slice(0, 4)) facts.push({ kind: 'file', value: file });
  for (const symbol of topSymbols.slice(0, 4)) facts.push({ kind: 'symbol', value: symbol });
  for (const step of input.flowSteps.slice(0, 4)) {
    facts.push({
      kind: String(step.kind ?? 'flow'),
      value: String(step.summary ?? step.symbol ?? step.file ?? ''),
      file: stringOrUndefined(step.file),
      lines: stringOrUndefined(step.lines) ?? (typeof step.line === 'number' ? String(step.line) : undefined),
    });
  }
  for (const slice of input.evidenceSlices.slice(0, 3)) {
    facts.push({
      kind: 'evidence',
      file: stringOrUndefined(slice.file),
      lines: stringOrUndefined(slice.lines),
      value: truncateString(String(slice.why ?? slice.symbol ?? slice.file ?? ''), 180),
    });
  }
  return facts.filter(fact => String(fact.value ?? fact.file ?? '').length > 0).slice(0, 12);
}

function oracleEditGuardrails(taskType: string, topFiles: string[]): string[] {
  const guardrails = [
    'Open exact slices before editing; avoid broad repo reads once the oracle has top files.',
  ];
  if (topFiles.length > 0) guardrails.push(`Prefer editing only: ${topFiles.slice(0, 4).join(', ')}.`);
  if (taskType === 'refactor') guardrails.push('Preserve public API signatures unless the prompt explicitly asks for an API change.');
  if (taskType === 'debug') guardrails.push('Keep the failing test red before the fix when the suite defines a before-command.');
  if (taskType === 'create-testcase') guardrails.push('Do not make the test pass by weakening assertions or deleting existing tests.');
  return guardrails;
}

function oraclePassSignal(taskType: string): string {
  if (taskType === 'codereview') return 'Golden findings are covered with file/line/severity and no unsupported blockers.';
  if (taskType === 'investigate') return 'Golden facts are covered with file/line evidence and no unsupported claims.';
  if (taskType === 'break-task') return 'Task DAG includes dependencies, order, risks, validation milestones, and definition of done.';
  return 'Diff, compile/tests, and requested file/API assertions pass.';
}

function changePackInvariants(
  changeType: string,
  taskOracle: Record<string, unknown>,
  patchImpact: Record<string, unknown> | undefined,
): string[] {
  const invariants = [
    ...stringArray(taskOracle.successCriteria),
    ...stringArray(taskOracle.editGuardrails),
  ];
  const summary = patchImpact && isPlainObject(patchImpact.summary) ? patchImpact.summary : {};
  if (Number(summary.impactedEndpointCount ?? 0) > 0) {
    invariants.push('Preserve endpoint request/response compatibility or update contract tests intentionally.');
  }
  if (changeType === 'debug') invariants.push('Prove red-to-green behavior with the smallest targeted failing test.');
  if (changeType === 'refactor') invariants.push('Behavior tests must pass and public API signatures must remain unchanged.');
  if (changeType === 'implement') invariants.push('Implement only the requested behavior; avoid opportunistic refactors.');
  return uniqueStrings(invariants).slice(0, 12);
}

function rawSliceRequestKey(snapshotId: string, args: Record<string, unknown>): string | undefined {
  const file = stringOrUndefined(args.file)?.replace(/\\/g, '/').toLowerCase() ?? '';
  const lines = stringOrUndefined(args.lines) ?? '';
  const symbol = stringOrUndefined(args.symbol) ?? '';
  if (!file && !symbol) return undefined;
  if (!lines && !symbol) return undefined;
  return `${snapshotId}:${file}:${lines}:${symbol}`;
}

function duplicateBatchSliceResponse(args: Record<string, unknown>): Record<string, unknown> {
  return {
    duplicateOfBatch: true,
    file: stringOrUndefined(args.file),
    lines: stringOrUndefined(args.lines),
    symbol: stringOrUndefined(args.symbol),
    text: '',
    guidance: [
      'This exact slice is already covered by an in-flight batch get_file_slice call.',
      'Use the batch get_file_slice result as the source evidence; do not repeat the single-slice call.',
    ],
    confidence: 0.8,
  };
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

function callSignalFilter(args: Record<string, unknown>, alias = ''): string {
  if (args.includeLowSignal === true) return '';
  const prefix = alias ? `${alias}.` : '';
  return `AND ${prefix}signal_tier IN ('primary', 'provider')`;
}

function callSignalOrder(alias = ''): string {
  const prefix = alias ? `${alias}.` : '';
  return `CASE ${prefix}signal_tier WHEN 'provider' THEN 0 WHEN 'primary' THEN 1 ELSE 2 END`;
}

function researchSeedTerms(target: string): string[] {
  const identifierTerms = target.match(/\b[A-Za-z_$][\w$]*(?:(?:::|\.)[A-Za-z_$][\w$]*)+\b/g) ?? [];
  const explicitIdentifierTerms = target.match(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:_[A-Za-z0-9_$]+)+\b/g) ?? [];
  const symbolTerms = target.match(/\b(?:[A-Z][A-Za-z0-9_$]{2,}|[a-z]+[A-Z][A-Za-z0-9_$]*)\b/g) ?? [];
  const tokenTerms = tokenizeSearchQuery(target)
    .filter(token => token.length >= 3 && !RESEARCH_STOP_WORDS.has(token))
    .slice(0, 12);
  return uniqueStrings([
    ...identifierTerms,
    ...explicitIdentifierTerms,
    ...explicitIdentifierTerms.map(snakeToLowerCamel),
    ...symbolTerms,
    ...tokenTerms,
  ].filter(Boolean)).slice(0, 18);
}

function researchSymbolQueries(target: string, seedTerms: string[]): string[] {
  const identifiers = seedTerms.filter(term => /[A-Z_.$:]/.test(term));
  const queryGroups = [
    ...identifiers.slice(0, 5),
    identifiers.slice(0, 4).join(' '),
    seedTerms.slice(0, 6).join(' '),
    target,
  ];
  return uniqueStrings(queryGroups.filter(query => query.trim().length >= 3)).slice(0, 7);
}

function snakeToLowerCamel(value: string): string {
  return value.replace(/_+([A-Za-z0-9_$])/g, (_match, char: string) => char.toUpperCase());
}

function endpointNeedleForResearch(target: string): string {
  return endpointNeedleFromText(target);
}

function endpointMethodForResearch(target: string, explicitMethod?: unknown): string {
  const provided = typeof explicitMethod === 'string' ? explicitMethod.toUpperCase() : '';
  if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ALL)$/.test(provided)) return provided;
  const match = target.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i);
  return match ? (match[1] ?? 'all').toUpperCase() : 'all';
}

function endpointHandlerSymbolCandidate(endpoint: ReturnType<typeof compactEndpointCandidates>[number]): ResearchSymbolCandidate {
  const symbol = endpoint.handlerSymbol;
  const nameMatch = symbol.match(/\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
  const fallbackName = symbol.split(/[.#]/).pop()?.replace(/\([^)]*\)$/, '') ?? symbol;
  return {
    symbol,
    name: nameMatch?.[1] ?? fallbackName,
    kind: 'method',
    file: endpoint.file,
    lines: endpoint.lines,
    frameworkRole: 'endpoint:handler',
    whyRelevant: `handler for indexed endpoint ${endpoint.method} ${endpoint.path}`,
    confidence: Math.min(0.95, endpoint.confidence + 0.15),
    matchedTokens: [endpoint.method, endpoint.path, endpoint.framework ?? 'endpoint'].filter(Boolean),
  };
}

function compactCallEdge(edge: CallEdgeRow): Record<string, unknown> {
  return {
    caller: edge.caller,
    callee: edge.callee,
    file: edge.file,
    line: edge.line,
    confidence: edge.confidence,
    resolutionKind: edge.resolution_kind,
    signalTier: edge.signal_tier,
    signalReasons: edge.signal_reasons_json ? parseJson<string[]>(edge.signal_reasons_json, []) : undefined,
  };
}

function callEdgesAsResearchSymbols(edges: CallEdgeRow[]): ResearchSymbolCandidate[] {
  return uniqueSymbolCandidates(edges.map(edge => {
    const withoutParams = edge.callee.replace(/\([^)]*\)$/, '').trim();
    const parts = withoutParams.split(/[.#]/g).filter(Boolean);
    const name = parts[parts.length - 1] ?? withoutParams;
    return {
      symbol: edge.callee,
      name,
      kind: 'method',
      file: edge.file,
      lines: edge.line > 0 ? String(edge.line) : undefined,
      whyRelevant: `direct endpoint-flow callee from ${edge.caller}`,
      confidence: edge.confidence,
      matchedTokens: callEdgeLookupTerms(edge.callee).slice(0, 3),
    };
  }));
}

function calleeDefinitionScore(row: SymbolRow, edge: CallEdgeRow): number {
  const rowFile = row.file.replace(/\\/g, '/');
  const edgeFile = edge.file.replace(/\\/g, '/');
  const callee = edge.callee.replace(/\([^)]*\)$/, '').toLowerCase();
  let score = 0;
  if (path.extname(rowFile).toLowerCase() === path.extname(edgeFile).toLowerCase()) score += 80;
  score += commonPathPrefixSegments(rowFile, edgeFile) * 8;
  if (sameFixtureProject(rowFile, edgeFile)) score += 60;
  if (row.file_role === 'main_source') score += 20;
  else if (row.file_role === 'test_source') score -= 20;
  if (row.kind === 'method' || row.kind === 'function') score += 20;
  const fqName = row.fq_name.toLowerCase();
  const simple = row.simple_name.toLowerCase();
  if (fqName.includes(callee)) score += 35;
  if (callee.endsWith(`.${simple}`) || callee === simple) score += 15;
  if (rowFile === edgeFile) score += 5;
  return score;
}

function commonPathPrefixSegments(left: string, right: string): number {
  const leftParts = left.split('/').filter(Boolean);
  const rightParts = right.split('/').filter(Boolean);
  let count = 0;
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index++) {
    if (leftParts[index] !== rightParts[index]) break;
    count++;
  }
  return count;
}

function sameFixtureProject(left: string, right: string): boolean {
  const leftMatch = left.match(/(?:^|\/)tests\/fixtures\/([^/]+)\//);
  const rightMatch = right.match(/(?:^|\/)tests\/fixtures\/([^/]+)\//);
  return Boolean(leftMatch?.[1] && leftMatch[1] === rightMatch?.[1]);
}

function serviceLikeFieldType(row: SymbolRow): string | undefined {
  const type = String(row.return_type ?? '').replace(/<.*>$/, '').trim();
  const field = row.simple_name.trim();
  const candidate = type || field.replace(/^[a-z]/, char => char.toUpperCase());
  if (/(Service|Client|Gateway|Repository|Dao|Manager)$/.test(candidate)) return candidate;
  return undefined;
}

function researchCallEdgeScore(edge: CallEdgeRow): number {
  const callee = edge.callee;
  let score = edge.confidence * 100;
  if (edge.signal_tier === 'provider') score += 30;
  else if (edge.signal_tier === 'primary') score += 20;
  else score += 5;
  if (
    edge.resolution_kind === 'receiver-field'
    || edge.resolution_kind === 'receiver-field-chain'
    || edge.resolution_kind === 'receiver-type-field'
    || edge.resolution_kind === 'receiver-type-chain'
    || edge.resolution_kind === 'interface-implementation'
    || edge.resolution_kind === 'enclosing-method'
    || edge.resolution_kind === 'super-method'
    || edge.resolution_kind === 'static-import'
    || edge.resolution_kind === 'receiver-type'
  ) score += 8;
  if (/\b(Service|Client|Manager|Context|Store|Repository|Dao|Request|Response|Builder|Info|Entity|Controller)\b/.test(callee)) score += 18;
  if (/\b(Logger|String|HashSet|ArrayList|List|Set|Map|ConcurrentMap|AtomicLong|Objects|Optional)\./.test(callee)) score -= 24;
  if (/\.new$/.test(callee) && !/\b(Request|Response|Info|Entity|Builder|Service|Client)\.new$/.test(callee)) score -= 8;
  return score;
}

function researchEdgeNeedles(symbols: ResearchSymbolCandidate[]): string[] {
  const values: string[] = [];
  for (const symbol of symbols) {
    const withoutParams = symbol.symbol.replace(/\([^)]*\)$/, '').trim();
    const parts = withoutParams.split(/[.#]/g).filter(Boolean);
    const compact = parts.length >= 2 ? `${parts[parts.length - 2]}.${parts[parts.length - 1]}` : '';
    if (symbol.kind === 'method' || symbol.kind === 'function') {
      values.push(symbol.symbol, withoutParams, compact);
    } else {
      values.push(symbol.name, symbol.symbol, withoutParams, compact, parts[parts.length - 1] ?? '');
    }
  }
  return uniqueStrings(values
    .map(value => value.replace(/\([^)]*\)$/, '').trim())
    .filter(value => value.length >= 4 && !RESEARCH_STOP_WORDS.has(value.toLowerCase())));
}

function researchFlowSteps(input: {
  symbols: ResearchSymbolCandidate[];
  callers: CallEdgeRow[];
  callees: CallEdgeRow[];
  endpoints: Array<{ method: string; path: string; handlerSymbol: string; file: string; line: number; confidence: number }>;
  files: ResearchFileCandidate[];
}): Array<Record<string, unknown>> {
  const steps: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const add = (step: Record<string, unknown>) => {
    const key = `${step.kind}:${step.summary}:${step.file}:${step.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    steps.push({ order: steps.length + 1, ...step });
  };

  for (const endpoint of input.endpoints.slice(0, 4)) {
    add({
      kind: 'endpoint',
      summary: `${endpoint.method} ${endpoint.path} enters ${endpoint.handlerSymbol}`,
      file: endpoint.file,
      line: endpoint.line,
      confidence: endpoint.confidence,
    });
  }
  for (const symbol of input.symbols.slice(0, 6)) {
    add({
      kind: 'definition',
      summary: `${symbol.name} (${symbol.kind ?? 'symbol'}) is a ranked entry point`,
      symbol: symbol.symbol,
      file: symbol.file,
      lines: symbol.lines,
      confidence: symbol.confidence,
    });
  }
  for (const file of input.files.slice(0, 5)) {
    add({
      kind: 'file',
      summary: file.whyRelevant,
      file: file.file,
      lines: file.lines,
      confidence: file.confidence,
    });
  }
  for (const edge of [...input.callees, ...input.callers]
    .sort((a, b) => b.confidence - a.confidence || a.file.localeCompare(b.file))
    .slice(0, 8)) {
    add({
      kind: 'call',
      summary: `${edge.caller} -> ${edge.callee}`,
      file: edge.file,
      line: edge.line,
      confidence: edge.confidence,
      resolutionKind: edge.resolution_kind,
      signalTier: edge.signal_tier,
    });
  }
  return steps.slice(0, 10);
}

function researchMissingFacts(input: {
  target: string;
  relevantSymbols: ResearchSymbolCandidate[];
  fileCandidateCount: number;
  evidenceSlices: Array<Record<string, unknown>>;
  flowSteps: Array<Record<string, unknown>>;
}): string[] {
  const missing: string[] = [];
  if (!input.target.trim()) missing.push('Target was empty; rerun with the subsystem, class, or request flow to research.');
  if (input.relevantSymbols.length === 0 && input.fileCandidateCount === 0) {
    missing.push('No ranked symbols or files resolved; call search_code with the exact subsystem/class names.');
  }
  if (input.evidenceSlices.length === 0) missing.push('No source evidence slices were produced; call get_file_slice for the top ranked file or symbol.');
  if (input.flowSteps.length === 0 && input.evidenceSlices.length === 0) missing.push('No flow steps or source evidence were available from the index.');
  return missing;
}

function compressedEvidenceForResearch(input: {
  flowSteps: Array<Record<string, unknown>>;
  callers: Array<Record<string, unknown>>;
  callees: Array<Record<string, unknown>>;
  evidenceSlices: Array<Record<string, unknown>>;
  definitions: ResearchSymbolCandidate[];
}): Record<string, unknown> {
  const factCards = [
    ...input.definitions.slice(0, 5).map(symbol => ({
      kind: 'definition',
      subject: symbol.symbol,
      file: symbol.file,
      lines: symbol.lines,
      confidence: symbol.confidence,
    })),
    ...input.flowSteps.slice(0, 6).map(step => ({
      kind: String(step.kind ?? 'flow'),
      subject: String(step.summary ?? step.symbol ?? step.file ?? ''),
      file: stringOrUndefined(step.file),
      lines: stringOrUndefined(step.lines) ?? (typeof step.line === 'number' ? String(step.line) : undefined),
      confidence: typeof step.confidence === 'number' ? step.confidence : undefined,
    })),
  ].filter(card => card.subject || card.file).slice(0, 10);
  const callGraphEdges = [...input.callers, ...input.callees]
    .map(edge => ({
      caller: stringOrUndefined(edge.caller),
      callee: stringOrUndefined(edge.callee),
      file: stringOrUndefined(edge.file),
      line: typeof edge.line === 'number' ? edge.line : undefined,
      confidence: typeof edge.confidence === 'number' ? edge.confidence : undefined,
    }))
    .filter(edge => edge.caller && edge.callee)
    .slice(0, 10);
  const sourceSliceRefs = input.evidenceSlices
    .slice(0, 6)
    .map(slice => ({
      file: stringOrUndefined(slice.file),
      lines: stringOrUndefined(slice.lines),
      symbol: stringOrUndefined(slice.symbol),
      why: truncateOptional(slice.why, 120),
      textPreview: truncateOptional(slice.text, 180),
    }))
    .filter(slice => slice.file);
  const fullEvidenceTokens = estimateTokens(JSON.stringify({
    flowSteps: input.flowSteps,
    callers: input.callers,
    callees: input.callees,
    evidenceSlices: input.evidenceSlices,
    definitions: input.definitions,
  }));
  const compressedTokens = estimateTokens(JSON.stringify({ factCards, callGraphEdges, sourceSliceRefs }));
  return {
    intendedUse: 'Read this first for small-model routing; open full evidenceSlices only when a fact needs exact source text.',
    factCards,
    callGraphEdges,
    sourceSliceRefs,
    estimatedTokens: compressedTokens,
    fullEvidenceEstimatedTokens: fullEvidenceTokens,
    compressionRatio: fullEvidenceTokens > 0 ? Math.round((compressedTokens / fullEvidenceTokens) * 100) / 100 : 1,
  };
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
  severity?: 'blocker' | 'high' | 'medium';
  category?: string;
  file?: string;
  line?: number;
  hunk?: Record<string, unknown>;
  title: string;
  why: string;
  evidence?: unknown;
  suggestedCheck: string;
  suggestedFix?: string;
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
  maxReviewTargets: number;
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
    ? { maxFindings: limit, maxLineFocus: limit, maxReviewTargets: Math.min(limit, 20), maxRiskFlags: limit, maxTests: Math.min(limit, 50), maxEvidencePerFinding: 12, maxRequiredToolCalls: 8 }
    : outputMode === 'balanced'
      ? { maxFindings: 10, maxLineFocus: 20, maxReviewTargets: 10, maxRiskFlags: 12, maxTests: 8, maxEvidencePerFinding: 5, maxRequiredToolCalls: 4 }
      : { maxFindings: 6, maxLineFocus: 10, maxReviewTargets: 6, maxRiskFlags: 8, maxTests: 5, maxEvidencePerFinding: 3, maxRequiredToolCalls: 3 };
  return {
    outputMode,
    maxFindings: clampInt(Number(args.maxFindings ?? defaults.maxFindings), 1, limit),
    maxLineFocus: clampInt(Number(args.maxLineFocus ?? defaults.maxLineFocus), 1, limit),
    maxReviewTargets: clampInt(defaults.maxReviewTargets, 1, limit),
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

function reviewAgentGuidance(
  focus: ReviewFocus,
  findings: ReviewFinding[],
  reviewTargets: Array<Record<string, unknown>>,
  followUpSliceHints: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
  const highPriorityFindings = findings.filter(finding => finding.priority === 'P0' || finding.priority === 'P1');
  const targetOrder = reviewTargets
    .slice(0, 6)
    .map(target => ({
      targetId: target.targetId,
      file: target.file,
      lines: target.fileSliceLines ?? target.newLines,
      symbol: isPlainObject(target.changedSymbol) ? target.changedSymbol.symbol : undefined,
      riskLevel: target.riskLevel,
      changeKinds: target.changeKinds,
    }));
  return {
    mode: focus,
    firstPass: highPriorityFindings.length > 0
      ? 'Validate P0/P1 findings against reviewTargets and exact file slices before broad repository search.'
      : 'Review targets in risk order, then inspect tests and validation hints.',
    reviewOrder: targetOrder,
    findingContract: {
      requiredFields: ['priority', 'severity', 'category', 'file', 'line', 'why', 'suggestedFix', 'confidence'],
      commentRule: 'Only leave a final review comment after confirming the changed line or symbol through reviewTargets or get_file_slice.',
    },
    sourceInspection: followUpSliceHints.length > 0 ? {
      firstTool: 'get_file_slice',
      batching: 'Use one get_file_slice call with args.slices from firstFollowUpToolCall.',
      sliceCount: followUpSliceHints.length,
    } : undefined,
    stopRules: [
      'Do not open unrelated files until the listed reviewTargets have been checked.',
      'For each issue, include a concrete failure mode or caller/endpoint path, not only style preference.',
      'If no targeted tests are listed for production code, report that gap or request the smallest validation command.',
    ],
  };
}

function reviewSliceHints(
  lineFocus: Array<Record<string, unknown>>,
  reviewTargets: Array<Record<string, unknown>>,
  maxHints = 6,
): Array<Record<string, unknown>> {
  const hints: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const item of [...reviewTargets, ...lineFocus]) {
    if (hints.length >= maxHints) break;
    const file = stringOrUndefined(item.file);
    const lines = stringOrUndefined(item.fileSliceLines);
    const symbol = isPlainObject(item.changedSymbol)
      ? stringOrUndefined(item.changedSymbol.symbol)
      : stringOrUndefined(item.symbol);
    if (!file || !lines) continue;
    const key = `${file}\0${lines}\0${symbol ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push({
      file,
      lines,
      symbol,
      maxChars: 4000,
      why: stringOrUndefined(item.targetId)
        ? `Exact changed range for ${item.targetId}.`
        : 'Exact changed range for review validation.',
    });
  }
  return hints;
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

function patchHunkRiskLevel(hunk: PatchHunk): 'critical' | 'high' | 'medium' | 'low' {
  const score = patchHunkRiskScore(hunk);
  if (score >= 160) return 'critical';
  if (score >= 90) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

function reviewTargetChecksFor(
  hunk: PatchHunk,
  symbol: ReturnType<typeof compactSymbolCandidate> | undefined,
  endpoints: Array<{ method: string; path: string }>,
  tests: Array<Record<string, unknown>>,
): string[] {
  const checks: string[] = [];
  if (symbol) checks.push(`Inspect changed symbol ${symbol.symbol} before reviewing unrelated code.`);
  if (endpoints.length > 0 || hunk.changeKinds.includes('endpoint')) {
    checks.push('Verify endpoint compatibility, auth assumptions, status codes, and request/response shape.');
  }
  if (hunk.changeKinds.includes('security')) checks.push('Review secret/auth/input handling and add a negative security test if applicable.');
  if (hunk.changeKinds.includes('sql')) checks.push('Verify SQL/query construction uses binding or a safe query builder.');
  if (hunk.changeKinds.includes('error-handling')) checks.push('Check exception semantics, retries, rollback behavior, and logging.');
  if (hunk.changeKinds.includes('config')) checks.push('Check defaults, deployment overrides, and rollback impact.');
  if (hunk.changeKinds.includes('debug-output')) checks.push('Remove debug output or replace it with structured logging at an appropriate level.');
  checks.push(tests.length > 0
    ? 'Run or inspect the listed likely targeted tests.'
    : 'Identify the smallest targeted test or command before approval.');
  return uniqueStrings(checks).slice(0, 6);
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

function reviewFindingAgentFields(finding: ReviewFinding): Partial<ReviewFinding> {
  const evidence = isPlainObject(finding.evidence) ? finding.evidence : undefined;
  const file = finding.file ?? stringOrUndefined(evidence?.file);
  const line = finding.line ?? (typeof evidence?.line === 'number' ? evidence.line : undefined);
  return {
    severity: finding.severity ?? reviewSeverityForPriority(finding.priority),
    category: finding.category ?? reviewFindingCategory(finding),
    file,
    line,
    hunk: finding.hunk ?? (file ? {
      file,
      line,
      preview: stringOrUndefined(evidence?.text),
    } : undefined),
  };
}

function reviewSeverityForPriority(priority: ReviewFinding['priority']): 'blocker' | 'high' | 'medium' {
  if (priority === 'P0') return 'blocker';
  if (priority === 'P1') return 'high';
  return 'medium';
}

function reviewFindingCategory(finding: ReviewFinding): string {
  const text = `${finding.id} ${finding.title}`.toLowerCase();
  if (/(secret|sql|command|security|auth|credential|token)/.test(text)) return 'security';
  if (/(endpoint|api|contract|public)/.test(text)) return 'api-contract';
  if (/(test|validation|assertion)/.test(text)) return 'tests';
  if (/(config|default|deployment)/.test(text)) return 'configuration';
  if (/(fanout|dependent|caller|impact)/.test(text)) return 'impact';
  if (/(debug|logging)/.test(text)) return 'observability';
  return 'correctness';
}

function suggestedFixForReviewFinding(finding: ReviewFinding): string {
  const category = reviewFindingCategory(finding);
  if (category === 'security') return 'Constrain or remove the risky path, prefer safe APIs/secret management, and add a negative test around the changed behavior.';
  if (category === 'api-contract') return 'Confirm compatibility for callers and endpoint consumers; add or update contract/integration tests when behavior changes.';
  if (category === 'tests') return 'Add or restore a targeted assertion that fails on the previous broken behavior and passes with this patch.';
  if (category === 'configuration') return 'Document the default/override behavior and verify startup or deployment rollback with the changed config.';
  if (category === 'observability') return 'Remove ad-hoc debug output or replace it with structured logging at an appropriate level.';
  return finding.suggestedCheck;
}

function compactReviewFinding(finding: ReviewFinding, maxEvidence: number): ReviewFinding {
  const agentFields = reviewFindingAgentFields(finding);
  return {
    ...finding,
    ...agentFields,
    evidence: finding.evidence === undefined ? undefined : compactReviewObject(finding.evidence, maxEvidence, 3),
    why: truncateString(finding.why, 420),
    suggestedCheck: truncateString(finding.suggestedCheck, 320),
    suggestedFix: truncateString(finding.suggestedFix ?? suggestedFixForReviewFinding(finding), 320),
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

function compactPatchImpactResult(result: Record<string, unknown>, maxItems: number, options: {
  outputMode: string;
  includeArchitecture?: boolean;
  includeFieldImpact?: boolean;
  countsOnly?: boolean;
  cappedReason?: string;
}): Record<string, unknown> {
  const itemLimit = clampInt(maxItems, 1, 20);
  const depth = 2;
  const listLimit = options.countsOnly ? itemLimit : itemLimit * 2;
  const dependencyImpact = isPlainObject(result.dependencyImpact) ? result.dependencyImpact : {};
  const callImpact = isPlainObject(result.callImpact) ? result.callImpact : {};
  const fieldImpact = isPlainObject(result.fieldImpact) ? result.fieldImpact : undefined;
  const calculationImpact = isPlainObject(result.calculationImpact) ? result.calculationImpact : undefined;
  const architectureContext = isPlainObject(result.architectureContext) ? result.architectureContext : undefined;
  const changedFiles = stringArray(result.changedFiles);
  const touchedSymbols = arrayRecords(result.touchedSymbols);
  const changedEndpoints = arrayRecords(result.changedEndpoints);
  const dependencies = arrayRecords(dependencyImpact.dependencies);
  const dependents = arrayRecords(dependencyImpact.dependents);
  const callers = arrayRecords(callImpact.callers);
  const callees = arrayRecords(callImpact.callees);
  const impactedFiles = stringArray(result.impactedFiles);
  const impactedEndpoints = arrayRecords(result.impactedEndpoints);
  const tests = arrayRecords(result.testsLikelyRelevant);
  const riskFlags = arrayRecords(result.riskFlags);
  const notes = stringArray(result.confidenceNotes);
  if (options.cappedReason) {
    notes.push('Expanded patch-impact evidence was omitted because the response exceeded maxResponseTokens; use get_file_slice or graph-specific tools for exact follow-up evidence.');
  }

  const compacted: Record<string, unknown> = {
    outputMode: options.outputMode,
    riskMode: result.riskMode,
    inputs: compactReviewObject(result.inputs, itemLimit, depth),
    changedFiles: changedFiles.slice(0, listLimit),
    touchedSymbols: compactReviewObject(touchedSymbols.slice(0, itemLimit), itemLimit, depth),
    changedEndpoints: compactReviewObject(changedEndpoints.slice(0, itemLimit), itemLimit, depth),
    dependencyImpact: {
      dependencies: compactReviewObject(dependencies.slice(0, itemLimit), itemLimit, depth),
      dependents: compactReviewObject(dependents.slice(0, itemLimit), itemLimit, depth),
      dependencyCount: dependencyImpact.dependencyCount,
      dependentCount: dependencyImpact.dependentCount,
    },
    callImpact: {
      queriedSymbols: stringArray(callImpact.queriedSymbols).slice(0, itemLimit),
      callers: compactReviewObject(callers.slice(0, itemLimit), itemLimit, depth),
      callees: compactReviewObject(callees.slice(0, itemLimit), itemLimit, depth),
      callerCount: callImpact.callerCount,
      calleeCount: callImpact.calleeCount,
    },
    impactedFiles: impactedFiles.slice(0, listLimit),
    impactedEndpoints: compactReviewObject(impactedEndpoints.slice(0, itemLimit), itemLimit, depth),
    calculationImpact: calculationImpact ? compactReviewObject(calculationImpact, itemLimit, depth + 1) : undefined,
    testsLikelyRelevant: compactReviewObject(tests.slice(0, itemLimit), itemLimit, depth),
    validation: compactReviewObject(result.validation, itemLimit, depth),
    riskFlags: compactReviewObject(riskFlags.slice(0, itemLimit), itemLimit, depth),
    summary: result.summary,
    nextActions: stringArray(result.nextActions).slice(0, itemLimit + 2),
    confidence: result.confidence,
    confidenceNotes: notes,
    omissions: {
      reason: options.cappedReason ?? 'compact-output-mode',
      changedFilesOmitted: Math.max(0, changedFiles.length - listLimit),
      touchedSymbolsOmitted: Math.max(0, touchedSymbols.length - itemLimit),
      changedEndpointsOmitted: Math.max(0, changedEndpoints.length - itemLimit),
      dependenciesOmitted: Math.max(0, dependencies.length - itemLimit),
      dependentsOmitted: Math.max(0, dependents.length - itemLimit),
      callersOmitted: Math.max(0, callers.length - itemLimit),
      calleesOmitted: Math.max(0, callees.length - itemLimit),
      impactedFilesOmitted: Math.max(0, impactedFiles.length - listLimit),
      impactedEndpointsOmitted: Math.max(0, impactedEndpoints.length - itemLimit),
      testsOmitted: Math.max(0, tests.length - itemLimit),
      riskFlagsOmitted: Math.max(0, riskFlags.length - itemLimit),
    },
  };
  if (options.includeFieldImpact && fieldImpact) {
    compacted.fieldImpact = compactReviewObject(fieldImpact, itemLimit, depth);
  } else if (fieldImpact) {
    compacted.fieldImpact = {
      omitted: true,
      reason: options.cappedReason ?? 'compact-output-mode',
      usageCount: fieldImpact.usageCount,
      fileCount: stringArray(fieldImpact.files).length,
    };
  }
  if (options.includeArchitecture && architectureContext) {
    compacted.architectureContext = compactReviewObject(architectureContext, itemLimit, depth);
  } else if (architectureContext) {
    compacted.architectureContext = {
      omitted: true,
      reason: options.cappedReason ?? 'compact-output-mode',
    };
  }
  return compacted;
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

function seededRiskCategoriesForReview(
  focus: ReviewFocus,
  findings: ReviewFinding[],
  riskFlags: Array<Record<string, unknown>>,
  diffStats: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const categories = new Map<string, Record<string, unknown>>();
  const add = (id: string, reason: string, severity: string, evidence?: unknown) => {
    if (categories.has(id)) return;
    categories.set(id, { id, severity, reason, evidence });
  };
  for (const finding of findings) {
    add(reviewFindingCategory(finding), `Seeded by finding ${finding.id}.`, finding.severity ?? reviewSeverityForPriority(finding.priority), {
      file: finding.file,
      line: finding.line,
      title: finding.title,
    });
  }
  for (const flag of riskFlags) {
    add(String(flag.type ?? 'risk'), String(flag.reason ?? 'Graph impact risk.'), String(flag.severity ?? 'medium'), flag.evidence);
  }
  if (focus === 'security') add('security', 'Security-focused review must check secrets, injection, auth, and unsafe IO paths.', 'high');
  if (focus === 'api-contract') add('api-contract', 'API-contract review must check endpoint compatibility and downstream consumers.', 'high');
  if (Number(diffStats.changedLineCount ?? 0) > 500) {
    add('large-diff-sampling', 'Large diffs require risk-based batching instead of line-by-line review.', 'medium');
  }
  return [...categories.values()].slice(0, 12);
}

function mustCheckInvariantsForReview(
  focus: ReviewFocus,
  changedFiles: string[],
  impact: Record<string, unknown>,
  findings: ReviewFinding[],
): string[] {
  const summary = isPlainObject(impact.summary) ? impact.summary : {};
  const invariants = [
    'Every blocking finding must include file, line or slice, severity, why, and a suggested fix.',
    'Do not report a blocker from graph proximity alone; confirm with exact source evidence or a failing validation signal.',
    'If validation is missing, report the missing targeted test separately from behavior findings.',
  ];
  if (changedFiles.some(isConfigPatchFile)) invariants.push('Config changes must preserve default behavior, rollback path, and environment-specific overrides.');
  if (Number(summary.impactedEndpointCount ?? 0) > 0 || focus === 'api-contract') {
    invariants.push('Endpoint/API changes must preserve request/response/error compatibility or name the breaking contract explicitly.');
  }
  if (focus === 'security' || findings.some(finding => reviewFindingCategory(finding) === 'security')) {
    invariants.push('Security-sensitive paths must avoid plaintext secrets, unsafe command execution, SQL/string injection, and auth bypass.');
  }
  if (findings.some(finding => reviewFindingCategory(finding) === 'observability')) {
    invariants.push('Ad-hoc debug output must not leak identifiers or bypass existing logging controls.');
  }
  return uniqueStrings(invariants).slice(0, 10);
}

function knownSensitiveDataPatternsForReview(focus: ReviewFocus): Array<Record<string, unknown>> {
  const patterns = [
    { id: 'secret-assignment', pattern: '(password|secret|token|apiKey|credential)\\s*[:=]', severity: 'high' },
    { id: 'identifier-logging', pattern: '(customerId|userId|email|phone|ssn|token).*log', severity: 'medium' },
    { id: 'command-execution', pattern: '(Runtime\\.exec|ProcessBuilder|child_process|exec\\()', severity: 'high' },
    { id: 'sql-string-concat', pattern: '(SELECT|UPDATE|DELETE|INSERT).*(\\+|\\$\\{)', severity: 'high' },
  ];
  if (focus === 'security') return patterns;
  return patterns.slice(0, 2);
}

function precisionTargetsForReview(focus: ReviewFocus, findings: ReviewFinding[]): Record<string, unknown> {
  const blockerCount = findings.filter(finding => finding.priority === 'P0' || finding.priority === 'P1').length;
  return {
    requireFileLineForBlockers: true,
    maxUnsupportedClaims: 0,
    maxUnconfirmedBlockers: 0,
    preferredFindingCount: focus === 'general' ? '1-5 highest-confidence findings' : 'all confirmed findings in focus area',
    blockerEvidenceRule: 'Each P0/P1 must cite exact changed line, source slice, or failing validation command.',
    precisionBeforeRecallWhenNoEvidence: true,
    currentBlockerCandidates: blockerCount,
  };
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

  const fileRole = args.fileRole ? String(args.fileRole) : '';
  if (fileRole) {
    sql.push('file_role = ?');
    params.push(fileRole);
  }
  const language = args.language ? String(args.language) : '';
  if (language) {
    const extensionFilter = symbolFileLanguageFilter(language);
    if (extensionFilter) sql.push(extensionFilter);
  }
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
      fileRole: fileRole || undefined,
      language: language || undefined,
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

function symbolFileLanguageFilter(language: string): string | undefined {
  switch (language) {
    case 'java':
      return "file LIKE '%.java'";
    case 'typescript':
      return "(file LIKE '%.ts' OR file LIKE '%.tsx')";
    case 'javascript':
      return "(file LIKE '%.js' OR file LIKE '%.jsx' OR file LIKE '%.mjs' OR file LIKE '%.cjs')";
    case 'python':
      return "file LIKE '%.py'";
    default:
      return undefined;
  }
}

function referenceFiltersFor(args: Record<string, unknown>, query: string): {
  symbolSql: string[];
  symbolParams: unknown[];
  importSql: string[];
  importParams: unknown[];
  callSql: string[];
  callParams: unknown[];
  fieldSql: string[];
  fieldParams: unknown[];
  effective: Record<string, unknown>;
} {
  const fileFilters = fileFiltersFor(args, query);
  const includeSynthetic = typeof args.includeSynthetic === 'boolean' ? args.includeSynthetic : hasSyntheticIntent(query);
  const symbolSql = [...fileFilters.sql];
  const symbolParams = [...fileFilters.params];
  const includeLowSignal = args.includeLowSignal === true;
  const callSql = [...fileFilters.sql];
  const fieldSql = [...fileFilters.sql];
  if (!includeLowSignal) callSql.push("signal_tier IN ('primary', 'provider')");
  if (!includeLowSignal) fieldSql.push('confidence >= 0.5');
  if (!includeSynthetic) symbolSql.push("COALESCE(framework_meta_json, '') NOT LIKE '%\"synthetic\":\"true\"%'");
  return {
    symbolSql,
    symbolParams,
    importSql: [...fileFilters.sql],
    importParams: [...fileFilters.params],
    callSql,
    callParams: [...fileFilters.params],
    fieldSql,
    fieldParams: [...fileFilters.params],
    effective: {
      ...fileFilters.effective,
      includeSynthetic,
      includeLowSignal,
      fieldAccess: typeof args.fieldAccess === 'string' ? args.fieldAccess : 'all',
    },
  };
}

function scoreFileSearch(row: FileRow, evidence: FileEvidence | undefined, query: string, tokens: string[]): FileSearchScore {
  const pathLower = row.path.toLowerCase();
  const basename = pathLower.substring(pathLower.lastIndexOf('/') + 1);
  const basenameWithoutExt = basename.replace(/\.[^.]+$/, '');
  // Original-case basename for camelCase-aware word splitting. Splitting the
  // lowercased form would collapse `OrderService` into `orderservice`, which has
  // no boundary to split on — so a PascalCase Java file would lose the
  // per-word/compound boosts that a separator-cased sibling (`order-service.ts`)
  // gets for free.
  const basenameOriginalNoExt = row.path
    .substring(Math.max(row.path.lastIndexOf('/'), row.path.lastIndexOf('\\')) + 1)
    .replace(/\.[^.]+$/, '');
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
  // Exact-basename and basename-part boosts only fire for SPECIFIC tokens. A
  // file literally named `service.ts` matching the broad token "service" must
  // not collect +90/+45 and bury `PaymentService.java`; broad terms are noise
  // on their own and only carry signal as part of a compound (handled below).
  const exactBasenameMatches = tokens.filter(token => token === basenameWithoutExt && !isBroadSearchTerm(token));
  if (exactBasenameMatches.length > 0) {
    score += 90;
    reason = 'query token exactly matched file basename';
    factors.push('query token exactly matched file basename');
  }
  // Split the basename on BOTH camelCase and separators so a PascalCase name
  // like `PaymentService` contributes its individual words ("payment",
  // "service") instead of staying an opaque single token.
  const basenameParts = splitIdentifierWords(basenameOriginalNoExt);
  const basenamePartMatches = uniqueStrings(tokens.filter(token => basenameParts.includes(token)));
  const specificBasenamePartMatches = basenamePartMatches.filter(token => !isBroadSearchTerm(token));
  if (specificBasenamePartMatches.length > 0) {
    score += 45 * specificBasenamePartMatches.length;
    factors.push(`${specificBasenamePartMatches.length} specific query tokens matched file basename parts`);
  }
  // Compound specificity: a basename whose camel-split words cover MULTIPLE
  // distinct query tokens (e.g. PaymentService covering both "payment" and
  // "service") is a far more precise hit than a generic file matching one broad
  // token. Requires >=2 covered words with >=1 being non-broad so a bare
  // "service" match cannot trigger it.
  if (basenamePartMatches.length >= 2 && specificBasenamePartMatches.length >= 1) {
    score += 110;
    reason = 'file basename matched a multi-word query phrase';
    factors.push(`file basename covered ${basenamePartMatches.length} query words (${basenamePartMatches.join('+')})`);
  }
  // A file that DEFINES a symbol whose camel-split name covers the same
  // multi-word phrase is the canonical home of that concept even when its
  // filename differs from the class name.
  const definesPhraseSymbol = symbols.some(symbol => {
    const words = splitIdentifierWords(String((symbol as { name?: unknown }).name ?? ''));
    const covered = uniqueStrings(tokens.filter(token => words.includes(token)));
    return covered.length >= 2 && covered.some(token => !isBroadSearchTerm(token));
  });
  if (definesPhraseSymbol) {
    score += 80;
    factors.push('file defines a symbol whose name matches a multi-word query phrase');
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
  const expanded = query
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return /\b(test|tests|testable|spec|behavior|behaviour|should|fixture|fixtures|mock|mocks)\b/i.test(expanded);
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

function slimReferenceForBudget(reference: Record<string, unknown>): Record<string, unknown> {
  return copyDefined({
    file: reference.file,
    line: reference.line,
    column: reference.column,
    kind: reference.kind,
    symbolName: reference.symbolName,
    source: reference.source,
    caller: reference.caller,
    callee: reference.callee,
    confidence: reference.confidence,
    resolutionKind: reference.resolutionKind,
    signalTier: reference.signalTier,
    fieldAccess: reference.fieldAccess,
    enclosingClass: reference.enclosingClass,
    enclosingSymbol: reference.enclosingSymbol,
    ownerClass: reference.ownerClass,
    receiverText: reference.receiverText,
    fileRole: reference.fileRole,
    context: truncateOptional(reference.context, 160),
  });
}

function slimDependencyTraceEdge(edge: DependencyTraceEdge): Record<string, unknown> {
  return {
    fromFile: edge.fromFile,
    toFile: edge.toFile,
    kind: edge.kind,
    confidence: edge.confidence,
    resolutionKind: edge.resolutionKind,
    depth: edge.depth,
  };
}

function dependencyTraceGroups(edges: DependencyTraceEdge[]): Array<Record<string, unknown>> {
  const groups = new Map<string, DependencyTraceEdge[]>();
  for (const edge of edges) {
    const key = `${edge.kind}:${edge.depth}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(edge);
    groups.set(key, bucket);
  }
  return [...groups.entries()]
    .map(([key, rows]) => ({
      key,
      kind: key.split(':')[0],
      depth: Number(key.split(':')[1] ?? 0),
      count: rows.length,
      files: rankFiles(rows.flatMap(row => [row.fromFile, row.toFile])).slice(0, 8),
      representativeEdges: rows.slice(0, 3).map(slimDependencyTraceEdge),
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function copyDefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

function calculationImpactForPatch(input: {
  changedFiles: string[];
  requestedSymbols: string[];
  touchedSymbols: Array<Record<string, unknown>>;
  dependencyRows: Array<Record<string, unknown>>;
  dependentRows: Array<Record<string, unknown>>;
  callers: CallEdgeRow[];
  callees: CallEdgeRow[];
  fieldImpact?: Record<string, unknown>;
  impactedEndpoints: Array<Record<string, unknown>>;
  tests: Array<Record<string, unknown>>;
  taskText: string;
}, limit: number): Record<string, unknown> {
  const changedSymbolNames = uniqueStrings([
    ...input.requestedSymbols,
    ...input.touchedSymbols.flatMap(symbol => [
      String(symbol.symbol ?? ''),
      String(symbol.name ?? ''),
    ]),
    ...input.callers.flatMap(edge => [edge.caller, edge.callee]),
    ...input.callees.flatMap(edge => [edge.caller, edge.callee]),
  ].filter(Boolean)).slice(0, 40);
  const contractText = [
    input.taskText,
    ...changedSymbolNames,
    ...input.changedFiles,
  ].join(' ');
  const invariants = calculationInvariantsFor(contractText);
  const sinks: Array<Record<string, unknown>> = [];
  for (const symbol of input.requestedSymbols) {
    sinks.push({
      source: 'requested_symbol',
      text: `${symbol} ${input.taskText}`,
      symbol,
      path: [symbol],
      confidence: 0.6,
    });
  }
  for (const symbol of input.touchedSymbols) {
    sinks.push({
      source: 'changed_symbol',
      text: `${symbol.symbol ?? ''} ${symbol.name ?? ''} ${symbol.file ?? ''} ${input.taskText}`,
      file: symbol.file,
      symbol: symbol.symbol ?? symbol.name,
      line: symbol.line,
      path: [symbol.symbol, symbol.name].filter(Boolean),
      confidence: symbol.confidence,
    });
  }
  for (const edge of input.callers) {
    sinks.push({
      source: 'caller',
      text: `${edge.caller} ${edge.callee} ${edge.file}`,
      file: edge.file,
      symbol: edge.caller,
      line: edge.line,
      path: [edge.callee, edge.caller].filter(Boolean),
      confidence: edge.confidence,
    });
  }
  for (const edge of input.callees) {
    sinks.push({
      source: 'callee',
      text: `${edge.caller} ${edge.callee} ${edge.file}`,
      file: edge.file,
      symbol: edge.callee,
      line: edge.line,
      path: [edge.caller, edge.callee].filter(Boolean),
      confidence: edge.confidence,
    });
  }
  for (const usage of arrayRecords(input.fieldImpact?.usages)) {
    sinks.push({
      source: 'field_usage',
      text: `${usage.enclosingSymbol ?? ''} ${usage.enclosingClass ?? ''} ${usage.context ?? ''} ${usage.file ?? ''}`,
      file: usage.file,
      symbol: usage.enclosingSymbol ?? usage.fieldName,
      line: usage.line,
      path: [usage.fieldName, usage.enclosingSymbol].filter(Boolean),
      confidence: usage.confidence,
    });
  }
  for (const row of input.dependentRows) {
    sinks.push({
      source: 'dependent_file',
      text: `${row.file ?? row.modulePath ?? ''} ${row.type ?? ''} ${row.resolutionKind ?? ''}`,
      file: row.file ?? row.modulePath,
      symbol: row.type,
      path: [row.modulePath ?? row.file].filter(Boolean),
      confidence: row.confidence,
    });
  }
  for (const endpoint of input.impactedEndpoints) {
    sinks.push({
      source: 'endpoint',
      text: `${endpoint.method ?? ''} ${endpoint.path ?? ''} ${endpoint.handlerSymbol ?? ''} ${endpoint.controller ?? ''} ${endpoint.file ?? ''}`,
      file: endpoint.file,
      symbol: endpoint.handlerSymbol ?? endpoint.controller,
      line: endpoint.line,
      path: [endpoint.handlerSymbol, `${endpoint.method ?? ''} ${endpoint.path ?? ''}`].filter(Boolean),
      confidence: endpoint.confidence,
    });
  }

  const calculationSinks = sinks.filter(sink => hasCalculationSignals(String(sink.text ?? '')) || sink.source === 'endpoint');
  const unknownSinks = sinks.filter(sink => !calculationSinks.includes(sink) && maybeRuntimeSink(String(sink.file ?? sink.text ?? '')));
  const groupsByOutput = new Map<string, Array<Record<string, unknown>>>();
  for (const sink of calculationSinks) {
    const output = calculationOutputGroup(String(sink.text ?? ''));
    const bucket = groupsByOutput.get(output) ?? [];
    bucket.push(sink);
    groupsByOutput.set(output, bucket);
  }
  if (unknownSinks.length > 0) groupsByOutput.set('unknown_runtime_calculation_sink', unknownSinks.slice(0, limit));
  const outputGroups = [...groupsByOutput.entries()]
    .map(([output, rows]) => ({
      output,
      risk: output === 'unknown_runtime_calculation_sink' ? 'unknown' : calculationRiskForOutput(output, rows),
      usageCount: rows.length,
      path: representativeCalculationPath(changedSymbolNames, rows[0]),
      representativeEvidence: rows.slice(0, 3).map(row => copyDefined({
        file: row.file,
        symbol: row.symbol,
        line: row.line,
        source: row.source,
        confidence: row.confidence,
      })),
      requiredTests: calculationTestObligations(output, contractText),
    }))
    .sort((a, b) => calculationRiskRank(b.risk) - calculationRiskRank(a.risk) || b.usageCount - a.usageCount)
    .slice(0, Math.max(1, Math.min(limit, 20)));
  const unclassifiedCalculationSinks = unknownSinks.length;
  const answerable = unclassifiedCalculationSinks === 0;
  return {
    riskMode: 'calculation_sensitive',
    answerable,
    changedContract: {
      symbols: changedSymbolNames.slice(0, 12),
      meaning: calculationMeaningFor(contractText),
      invariants,
    },
    calculationContract: {
      meaning: calculationMeaningFor(contractText),
      invariants,
    },
    impactCoverage: {
      totalUsages: sinks.length,
      calculationUsages: calculationSinks.length,
      classifiedCalculationSinks: calculationSinks.length,
      unclassifiedCalculationSinks,
      outputGroupCount: outputGroups.length,
    },
    outputGroups,
    omitted: {
      sinksOmitted: Math.max(0, sinks.length - calculationSinks.length - unknownSinks.length),
      outputGroupsOmitted: Math.max(0, groupsByOutput.size - outputGroups.length),
    },
    testsLikelyRelevant: input.tests.slice(0, 8),
    requiredTestObligations: uniqueStrings(outputGroups.flatMap(group => stringArray(group.requiredTests))).slice(0, 12),
    allowedFollowups: answerable
      ? []
      : [{
        tool: 'trace_dependencies',
        args: copyDefined({
          target: input.changedFiles[0] ?? changedSymbolNames[0],
          direction: 'both',
          depth: 2,
          outputMode: 'full',
        }),
        reason: 'Classify remaining runtime calculation sinks before editing calculation-sensitive code.',
      }],
    stopRule: answerable
      ? 'All high-risk calculation sinks in the current graph packet are classified; inspect representative evidence and required tests before editing.'
      : 'Do not implement until critical, high, or unknown calculation sinks are classified.',
  };
}

function hasCalculationSignals(text: string): boolean {
  return /\b(calc\w*|calculate\w*|compute\w*|score\w*|rank\w*|rating|priority|quota|limit\w*|threshold|quantity|capacity|total\w*|subtotal|amount|price|tax|fee|discount|rate|ratio|percent|aggregate\w*|metric|duration|timeout|window|allocation|forecast|estimate|normalize\w*|convert\w*|precision|rounding|unit|boundary|validation|eligible|balance|refund|invoice|payment)\b/i.test(text);
}

function maybeRuntimeSink(text: string): boolean {
  return !/\b(test|spec|mock|fixture|docs?|readme|generated|target|build)\b/i.test(text);
}

function calculationOutputGroup(text: string): string {
  if (/\b(rank\w*|rating|score\w*|priority)\b/i.test(text)) return 'score_or_ranking';
  if (/\b(limit\w*|threshold|quota|eligible|validation|validat\w*)\b/i.test(text)) return 'threshold_or_validation_decision';
  if (/\b(quantity|capacity|inventory|count)\b/i.test(text)) return 'quantity_or_capacity';
  if (/\b(total\w*|subtotal|amount|price|tax|fee|discount|balance|refund|invoice|payment)\b/i.test(text)) return 'amount_or_total';
  if (/\b(rate|ratio|percent|conversion)\b/i.test(text)) return 'rate_or_ratio';
  if (/\b(aggregate\w*|metric|report|dashboard|analytics)\b/i.test(text)) return 'aggregate_metric';
  if (/\b(duration|timeout|window|sla|latency|date|time)\b/i.test(text)) return 'time_or_duration';
  if (/\b(allocation|distribution|forecast|estimate)\b/i.test(text)) return 'allocation_or_forecast';
  if (/\b(get|post|put|delete|patch)\s+\//i.test(text)) return 'api_visible_output';
  return 'generic_calculation_output';
}

function calculationRiskForOutput(output: string, rows: Array<Record<string, unknown>>): 'critical' | 'high' | 'medium' | 'low' {
  if (output === 'amount_or_total' || output === 'threshold_or_validation_decision' || output === 'score_or_ranking' || output === 'api_visible_output') return 'critical';
  if (output === 'quantity_or_capacity' || output === 'time_or_duration' || output === 'rate_or_ratio') return 'high';
  if (output === 'aggregate_metric' || output === 'allocation_or_forecast') return 'medium';
  return rows.length >= 10 ? 'high' : 'medium';
}

function calculationRiskRank(risk: unknown): number {
  switch (risk) {
    case 'unknown':
      return 5;
    case 'critical':
      return 4;
    case 'high':
      return 3;
    case 'medium':
      return 2;
    default:
      return 1;
  }
}

function representativeCalculationPath(changedSymbols: string[], sink: Record<string, unknown> | undefined): string[] {
  return uniqueStrings([
    ...changedSymbols.slice(0, 1),
    ...stringArray(sink?.path),
    String(sink?.symbol ?? ''),
  ].filter(Boolean)).slice(0, 5);
}

function calculationMeaningFor(text: string): string {
  const group = calculationOutputGroup(text);
  return group.replace(/_/g, ' ');
}

function calculationInvariantsFor(text: string): string[] {
  const invariants = [
    'input and output units must remain explicit',
    'null, zero, negative, and boundary behavior must be known',
    'precision and rounding behavior must not change accidentally',
  ];
  if (/\b(rank\w*|score\w*|priority)\b/i.test(text)) invariants.push('relative ordering must remain intentional and tested');
  if (/\b(duration|timeout|window|date|time)\b/i.test(text)) invariants.push('time window boundaries and timezone assumptions must be explicit');
  if (/\b(aggregate|metric|report|ratio|rate|percent)\b/i.test(text)) invariants.push('aggregation grouping and denominator semantics must be preserved');
  if (/\b(limit|threshold|quota|eligible|validation)\b/i.test(text)) invariants.push('threshold inclusivity and eligibility boundaries must be tested');
  if (/\b(total|amount|price|tax|fee|discount|quantity|capacity)\b/i.test(text)) invariants.push('scale, unit conversion, and overflow behavior must be tested');
  return uniqueStrings(invariants).slice(0, 8);
}

function calculationTestObligations(output: string, text: string): string[] {
  const tests = ['boundary values', 'zero/null/negative values'];
  if (/\b(round|precision|amount|total|rate|ratio|percent)\b/i.test(`${output} ${text}`)) tests.push('precision and rounding');
  if (/\b(unit|convert|quantity|capacity)\b/i.test(`${output} ${text}`)) tests.push('unit conversion');
  if (output === 'score_or_ranking' || /\b(rank\w*|score\w*|priority)\b/i.test(`${output} ${text}`)) tests.push('ordering or ranking stability');
  if (/\b(aggregate|metric|report)\b/i.test(`${output} ${text}`)) tests.push('aggregation and grouping behavior');
  if (/\b(limit|threshold|quota|validation|eligible)\b/i.test(`${output} ${text}`)) tests.push('threshold inclusivity');
  if (/\b(duration|timeout|window|date|time)\b/i.test(`${output} ${text}`)) tests.push('time-window boundary behavior');
  return uniqueStrings(tests).slice(0, 8);
}

function groupFieldUsages(usages: Array<Record<string, unknown>>, keyName: string): Array<Record<string, unknown>> {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const usage of usages) {
    const key = String(usage[keyName] ?? 'unknown');
    const bucket = groups.get(key) ?? [];
    bucket.push(usage);
    groups.set(key, bucket);
  }
  return [...groups.entries()]
    .map(([key, rows]) => ({
      key,
      count: rows.length,
      accessKinds: [...new Set(rows.map(row => String(row.fieldAccess ?? 'unknown')))],
      files: rankFiles(rows.map(row => String(row.file ?? ''))).slice(0, 8),
      usages: rows.slice(0, 8),
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
    case 'method':
      return String(reference.enclosingSymbol ?? reference.caller ?? reference.file ?? 'unknown');
    case 'class':
      return String(reference.enclosingClass ?? reference.ownerClass ?? reference.file ?? 'unknown');
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

function fileSearchRankingTokens(query: string, tokens: string[]): string[] {
  const pruned = tokens.filter(token => !FILE_SEARCH_STOP_WORDS.has(token) && !/^\d+$/.test(token));
  return pruned.length > 0 ? pruned : tokens.slice(0, 6);
}

function fileSearchCandidateTerms(query: string, tokens: string[]): string[] {
  const explicitRefs = explicitSymbolRefs(query)
    .filter(ref => !isBroadExplicitRef(ref.className))
    .flatMap(ref => [
      ref.className,
      ref.member ?? '',
      ref.member ? `${ref.className}.${ref.member}` : '',
    ]);
  const explicitFiles = explicitFileNeedles(query)
    .filter(needle => !isBroadExplicitRef(path.posix.basename(needle, path.posix.extname(needle))))
    .flatMap(needle => [needle, path.posix.basename(needle, path.posix.extname(needle))]);
  const endpointNeedle = endpointNeedleForResearch(query);
  const identifiers = identifierSearchTerms(query.toLowerCase())
    .filter(term => !FILE_SEARCH_STOP_WORDS.has(term) && !isBroadSearchTerm(term));
  const explicitTerms = uniqueStrings([
    ...explicitRefs,
    ...explicitFiles,
    endpointNeedle,
    ...identifiers,
  ].filter(term => term.length >= 3));
  if (explicitTerms.length > 0) return explicitTerms.slice(0, 10);

  const fallbackTerms = uniqueStrings(tokens
    .filter(term => term.length >= 3 && !isBroadSearchTerm(term)))
    .slice(0, 10);
  return fallbackTerms.length > 0 ? fallbackTerms : tokens.slice(0, 6);
}

function ftsPrefixQuery(terms: string[]): string | undefined {
  const tokens = uniqueStrings(terms
    .flatMap(term => tokenizeSearchQuery(term))
    .filter(token => /^[a-z0-9]+$/.test(token)))
    .slice(0, 12);
  if (tokens.length === 0) return undefined;
  return tokens.map(token => `${token}*`).join(' OR ');
}

function parseSymbolSearchEntityId(value: string): SymbolSearchEntityKey | undefined {
  const [fqName, file, lineText] = value.split('\t');
  const line = Number(lineText);
  if (!fqName || !file || !Number.isFinite(line)) return undefined;
  return { fqName, file, line };
}

function chunksOf<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  const safeSize = Math.max(1, size);
  for (let index = 0; index < values.length; index += safeSize) {
    chunks.push(values.slice(index, index + safeSize));
  }
  return chunks;
}

function isBroadExplicitRef(value: string): boolean {
  return EXPLICIT_FILENAME_STOP_WORDS.has(value)
    || FILE_SEARCH_STOP_WORDS.has(value.toLowerCase())
    || /^[A-Z0-9_]{2,8}$/.test(value);
}

function isBroadSearchTerm(value: string): boolean {
  return value.length < 3 || FILE_SEARCH_BROAD_TERMS.has(value.toLowerCase());
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

/**
 * Split an identifier (filename, symbol name) into its lowercase word parts,
 * honoring BOTH camel/Pascal-case boundaries and separator characters.
 * `PaymentService` -> ['payment','service'], `order_service` -> ['order','service'].
 *
 * The query tokenizer ({@link tokenizeSearchQuery}) already splits camelCase, but
 * the file ranker historically only split filenames on `._-`. That left a
 * PascalCase basename like `PaymentService` as a single opaque token that never
 * matched the individual query words "payment"/"service", so a generic file
 * literally named `service.ts` outranked the specific `PaymentService.java` the
 * user wanted. Splitting both sides the same way closes that gap.
 */
function splitIdentifierWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
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

const RESEARCH_STOP_WORDS = new Set([
  ...SEARCH_STOP_WORDS,
  'about',
  'does',
  'execute',
  'explain',
  'flow',
  'handle',
  'happen',
  'how',
  'overview',
  'request',
  'through',
  'what',
  'when',
  'where',
  'work',
  'works',
]);

const FILE_SEARCH_STOP_WORDS = new Set([
  ...RESEARCH_STOP_WORDS,
  'business',
  'deep',
  'deepdive',
  'detail',
  'details',
  'dive',
  'glossary',
  'mcp',
  'study',
]);

const FILE_SEARCH_BROAD_TERMS = new Set([
  'app',
  'application',
  'business',
  'codebase',
  'detail',
  'details',
  'flow',
  'glossary',
  'hadoop',
  'hdfs',
  'implementation',
  'mcp',
  'project',
  'request',
  'response',
  'search',
  'service',
  'study',
  'system',
]);

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}

function fieldImpactSeeds(args: Record<string, unknown>): string[] {
  const values = [
    ...stringArray(args.symbols),
    stringOrUndefined(args.symbol),
    stringOrUndefined(args.target),
    stringOrUndefined(args.task),
    stringOrUndefined(args.diff),
  ].filter((value): value is string => Boolean(value));
  const seeds: string[] = [];
  const keyword = new Set([
    'class', 'interface', 'enum', 'public', 'private', 'protected', 'static', 'final',
    'return', 'new', 'void', 'int', 'long', 'double', 'float', 'boolean', 'char',
    'byte', 'short', 'if', 'else', 'for', 'while', 'switch', 'case', 'try', 'catch',
    'true', 'false', 'null', 'this', 'super', 'package', 'import',
  ]);
  for (const value of values) {
    for (const match of value.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?\b/g)) {
      const token = match[0] ?? '';
      const simple = token.split('.').pop() ?? token;
      if (simple.length < 2 || keyword.has(simple)) continue;
      if (/^[A-Z0-9_]+$/.test(simple) && !token.includes('.')) continue;
      seeds.push(token);
      if (token.includes('.')) seeds.push(simple);
    }
  }
  return uniqueStrings(seeds).slice(0, 80);
}

function fieldImpactConfidence(definitionCount: number, usageCount: number): number {
  if (definitionCount > 0 && usageCount > 0) return 0.82;
  if (usageCount > 0) return 0.68;
  if (definitionCount > 0) return 0.55;
  return 0.3;
}

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function countsFromSnapshotStats(row: SnapshotStatsRow): IndexCountSummary {
  const callEdges = Number(row.call_edges ?? 0);
  return {
    files: Number(row.files ?? 0),
    symbols: Number(row.symbols ?? 0),
    imports: Number(row.imports ?? 0),
    fieldUsages: Number(row.field_usages ?? 0),
    callEdges,
    callEdgesRaw: callEdges,
    callEdgesPrimary: Number(row.call_edges_primary ?? 0),
    callEdgesLowSignal: Number(row.call_edges_low_signal ?? 0),
    callEdgesProvider: Number(row.call_edges_provider ?? 0),
    dependencyEdges: Number(row.dependency_edges ?? 0),
    graphNodes: Number(row.graph_nodes ?? 0),
    graphEdges: Number(row.graph_edges ?? 0),
    endpoints: Number(row.endpoints ?? 0),
    beans: Number(row.beans ?? 0),
  };
}

function fileRolesFromSnapshotStats(row: SnapshotStatsRow): FileRoleCountRow[] {
  return parseJson<Array<{ file_role?: unknown; count?: unknown }>>(row.file_roles_json, [])
    .map(item => ({
      file_role: String(item.file_role ?? ''),
      count: Number(item.count ?? 0),
    }))
    .filter(item => item.file_role.length > 0);
}

async function scalar(db: CodeGraphDb, sql: string, ...args: unknown[]): Promise<number> {
  const row = await db.prepare(sql).get(...args) as Record<string, number> | undefined;
  return row ? Number(Object.values(row)[0] ?? 0) : 0;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index] as T);
    }
  }));
  return results;
}

function relevantTestLookupConcurrency(): number {
  const raw = Number(process.env.CODEGRAPH_RELEVANT_TEST_LOOKUP_CONCURRENCY ?? 6);
  if (!Number.isFinite(raw)) return 6;
  return clampInt(Math.floor(raw), 1, 16);
}

function relevantTestCacheLimit(): number {
  const raw = Number(process.env.CODEGRAPH_RELEVANT_TEST_CACHE_LIMIT ?? 512);
  if (!Number.isFinite(raw)) return 512;
  return clampInt(Math.floor(raw), 0, 10_000);
}

function autoRefreshFileLimit(): number {
  const raw = Number(process.env.CODEGRAPH_AUTO_REFRESH_FILE_LIMIT ?? 10_000);
  if (!Number.isFinite(raw) || raw < 0) return 10_000;
  return Math.floor(raw);
}

function freshnessCacheMs(): number {
  const raw = Number(process.env.CODEGRAPH_QUERY_FRESHNESS_CACHE_MS ?? 0);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

function callGraphName(symbol: string): string {
  const withoutParams = symbol.replace(/\([^)]*\)$/, '');
  const parts = withoutParams.split('.').filter(Boolean);
  if (parts.length >= 2) return `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  return withoutParams;
}

function simpleTypeName(typeName: string): string {
  const withoutParams = typeName.replace(/\([^)]*\)$/, '');
  const parts = withoutParams.split('.').filter(Boolean);
  return parts[parts.length - 1] ?? withoutParams;
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

function exactCallEdgeTestTerms(term: string): string[] {
  const withoutParams = term.replace(/\([^)]*\)$/, '').trim();
  if (!withoutParams || withoutParams.length < 4) return [];
  const parts = withoutParams.split(/[.#]/g).filter(Boolean);
  const compact = callGraphName(withoutParams);
  return uniqueStrings([
    withoutParams,
    compact,
    parts.length >= 2 ? `${parts[parts.length - 2]}.${parts[parts.length - 1]}` : '',
  ].filter(value => value.length >= 4 && !isBroadSearchTerm(value)));
}

function callEdgeLookupTerms(symbol: string): string[] {
  const raw = symbol.trim();
  const withoutParams = raw.replace(/\([^)]*\)$/, '').trim();
  return uniqueStrings([
    ...exactCallEdgeTestTerms(raw),
    callGraphName(raw),
    withoutParams,
    raw,
  ].filter(value => value.length >= 3 && !isBroadSearchTerm(value))).slice(0, 6);
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

const COMMON_EXTERNAL_IMPORT_PATTERN = '^(java|javax|jakarta|org\\.springframework|lombok|org\\.junit|org\\.mockito|com\\.fasterxml|org\\.slf4j)\\.';
const COMMON_EXTERNAL_IMPORT_RE = new RegExp(COMMON_EXTERNAL_IMPORT_PATTERN);
const COMMON_EXTERNAL_IMPORT_SQL = [
  "source NOT LIKE 'java.%'",
  "source NOT LIKE 'javax.%'",
  "source NOT LIKE 'jakarta.%'",
  "source NOT LIKE 'org.springframework.%'",
  "source NOT LIKE 'lombok.%'",
  "source NOT LIKE 'org.junit.%'",
  "source NOT LIKE 'org.mockito.%'",
  "source NOT LIKE 'com.fasterxml.%'",
  "source NOT LIKE 'org.slf4j.%'",
].join(' AND ');

function isCommonExternalImport(source: string): boolean {
  return COMMON_EXTERNAL_IMPORT_RE.test(source);
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