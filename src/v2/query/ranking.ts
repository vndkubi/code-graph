/**
 * Search ranking — file and symbol scoring plus the intent/classification
 * helpers they use. Extracted from service.ts so ranking logic is isolated and
 * unit-testable. Pure functions only; no DB or class state.
 */
import { roleRank } from '../index/file-role.js';
import {
  compactSearchText,
  splitIdentifierWords,
  isBroadSearchTerm,
  identifierSearchTerms,
  wordsShareStem,
} from './text-util.js';
import { parseJson, uniqueStrings } from './util.js';
import type {
  SymbolRow,
  FileRow,
  FileEvidence,
  FileSearchScore,
  SearchScore,
  SearchIntent,
} from './types.js';

export function detectSearchIntent(query: string): SearchIntent {
  const lower = query.toLowerCase();
  if (/\bentry\s*point\b/.test(lower) || /\bmain\s+application\b/.test(lower) || /\bapplication\s+entry\b/.test(lower)) {
    return { kind: 'entry_point' };
  }
  return { kind: 'none' };
}

export function scoreSearchIntent(row: SymbolRow, intent: SearchIntent, annotations: string[]): { score: number; reason: string; factors: string[] } {
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

export function isSyntheticSymbol(row: SymbolRow): boolean {
  return parseJson<Record<string, string>>(row.framework_meta_json, {}).synthetic === 'true';
}

export function isServiceLike(symbol: Record<string, unknown>): boolean {
  return String(symbol.frameworkRole ?? '').includes('service') || String(symbol.name ?? '').endsWith('Service');
}

export function isRepositoryLike(symbol: Record<string, unknown>): boolean {
  const role = String(symbol.frameworkRole ?? '');
  const name = String(symbol.name ?? '');
  return role.includes('repository') || name.endsWith('Repository') || name.endsWith('Dao');
}

export function isMyBatisIntent(query: string): boolean {
  return /\b(mybatis|mapper|sql|result\s*map|resultmap|mapper\s+xml|xml\s+mapper)\b/i.test(query);
}

export function isMyBatisLike(symbol: Record<string, unknown>): boolean {
  return String(symbol.frameworkRole ?? '').startsWith('mybatis:');
}

export function isApiSpecLike(symbol: Record<string, unknown>): boolean {
  const role = String(symbol.frameworkRole ?? '');
  return role === 'openapi:endpoint' || role === 'postman:request' || role.startsWith('elastic-rest:');
}

export function isApiSpecQuery(query: string): boolean {
  return /\b(openapi|swagger|postman|api\s+doc|api\s+spec|rest\s+api|yaml\s+rest|endpoint)\b/i.test(query);
}

export function isDockerConfigLike(symbol: Record<string, unknown>): boolean {
  return String(symbol.frameworkRole ?? '').startsWith('docker:');
}

export function isEntityLike(symbol: Record<string, unknown>): boolean {
  const role = String(symbol.frameworkRole ?? '');
  const name = String(symbol.name ?? '');
  return role.includes('entity') || name.endsWith('Entity');
}

/**
 * Relative findability of a symbol kind when its name matches the query. A bare
 * type name resolves to its definition far more often than to a same-named field
 * or local, so definitions outrank members outrank locals. Small enough to only
 * break ties among equal name-match tiers, never to override a stronger match.
 */
/**
 * Role weight for symbol ranking. main_source is the investigation target;
 * config/build/test/generated symbols are demoted with real (negative) weight so
 * the thousands of YAML/properties keys a repo exposes cannot outrank code on an
 * exact name match, while still ranking when no code symbol matches. Steeper than
 * the file-search roleRank/10 (which is near-flat: 10 vs 8) on purpose.
 */
function symbolRoleScore(role: string): number {
  switch (role) {
    case 'main_source': return 10;
    case 'test_source': return -8;
    case 'mock_source': return -10;
    case 'resource_config': return -12;
    case 'build_config': return -15;
    case 'generated': return -12;
    case 'external_stub': return -14;
    case 'vendored': return -20;
    default: return 0;
  }
}

function symbolKindRank(kind: string): number {
  switch (kind) {
    case 'class':
    case 'interface':
    case 'enum':
    case 'record':
    case 'annotation':
    case 'struct':
    case 'type':
      return 18;
    case 'method':
    case 'constructor':
    case 'function':
      return 10;
    case 'field':
    case 'property':
    case 'enum_constant':
    case 'constant':
      return 5;
    default:
      return 0;
  }
}

export function scoreSymbolSearch(
  row: SymbolRow,
  query: string,
  compactQuery: string,
  tokens: string[],
  intent: SearchIntent,
  callInDegree?: number,
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
  // Physical DB identifier from @Table/@Column(name=...), captured at index time.
  // Lets a query for the physical name ("quiz_answer") resolve to the entity/field
  // even when it differs from the Java name (class Answer) — from Java source only.
  const dbName = parseJson<{ dbName?: string }>(row.framework_meta_json, {}).dbName?.toLowerCase() ?? '';
  const dbNameCompact = dbName ? compactSearchText(dbName) : '';
  const simpleCompact = compactSearchText(row.simple_name);
  const fqCompact = compactSearchText(row.fq_name);
  const fileCompact = compactSearchText(row.file);
  const haystack = `${simpleLower} ${fqLower} ${fileLower} ${packageLower} ${frameworkLower} ${signatureLower} ${annotationLower} ${dbName}`;
  const haystackCompact = `${simpleCompact} ${fqCompact} ${fileCompact} ${dbNameCompact}`;
  const matchedTokens = tokens.filter(token => haystack.includes(token) || haystackCompact.includes(compactSearchText(token)));
  const allTokensMatched = matchedTokens.length === tokens.length;
  const matchedInSimple = tokens.filter(token => simpleLower.includes(token) || simpleCompact.includes(compactSearchText(token)));
  const exactPhrase = simpleLower === queryLower || fqLower === queryLower
    || simpleLower.includes(queryLower)
    || fqLower.includes(queryLower);
  // Qualified member reference: a dotted query "Owner.member" whose FQCN ends with
  // ".owner.member" is the precise member the user named. Rank it at the exact tier
  // so it beats a class whose name merely COMPACTS to the same string — e.g.
  // "Note.title" resolves to the Note.title field, not the unrelated NoteTitle class
  // (which otherwise wins the compact tier since "Note.title" -> "notetitle").
  const qualifiedMember = queryLower.includes('.')
    && (fqLower === queryLower || fqLower.endsWith(`.${queryLower}`));
  // The query references this symbol's physical DB name (table/column) — the
  // precise hit for a schema-driven lookup, even when the Java name differs
  // entirely. Fires when the query IS the name, compacts to it, OR (for a
  // distinctive snake_case identifier) contains it as a whole word — so a natural
  // "where is the quiz_answer table used" question through codegraph_context still
  // lifts the entity whose @Table name is quiz_answer, not just a bare lookup.
  const dbNameDistinctive = dbName.length >= 5 && dbName.includes('_');
  const queryContainsDbName = dbNameDistinctive
    && new RegExp(`(^|[^a-z0-9_])${dbName}([^a-z0-9_]|$)`).test(queryLower);
  const physicalNameMatch = dbName !== ''
    && (dbName === queryLower || (compactQuery !== '' && dbNameCompact === compactQuery) || queryContainsDbName);

  let score = 0;
  let reason = 'partial token match';
  const factors: string[] = [];

  if (physicalNameMatch && simpleLower !== queryLower) {
    score = 122;
    reason = 'exact physical DB name (@Table/@Column) match';
    factors.push('query equals the symbol physical DB name from @Table/@Column');
  } else if (qualifiedMember && simpleLower !== queryLower) {
    // Above the plain exact tier: a dotted Owner.member query is more specific
    // than a bare name, and must win even against a class that takes the compact
    // tier (112) plus the definition kind boost (+18) for the concatenated name.
    score = 135;
    reason = 'exact qualified member match';
    factors.push('FQCN ends with the qualified Owner.member query');
  } else if (simpleLower === queryLower || fqLower === queryLower) {
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
  // Kind priority: a bare type-name query ("Note", "User", "RecallPrompt") almost
  // always wants the DEFINITION, but a field/parameter that happens to share the
  // lowercased name ties it at the exact-match tier and — because such fields are
  // numerous (72 `name` fields, 116 `description`) — floods the result and buries
  // the one class. Rank definition kinds above members above locals so the type
  // wins its exact-name tie. Applied only to genuine name matches (exact tiers or
  // a name-token hit) so it never resurfaces an otherwise-irrelevant definition.
  const nameMatched = matchedInSimple.length > 0 || exactPhrase;
  if (nameMatched) {
    const kindBoost = symbolKindRank(row.kind);
    if (kindBoost !== 0) {
      score += kindBoost;
      factors.push(`symbol kind ${row.kind} contributed ${kindBoost} points (definition-over-member priority)`);
    }
  }
  // Role weight for symbol search. Steeper than file search: config/build files
  // expose huge numbers of key "symbols" (doughnut: 6353 resource_config vs 5023
  // main_source), so a near-flat role boost let YAML/properties keys exactly
  // matching a query ("username", "password") bury all code — search_symbol
  // "password" returned only ci.yml / *.properties keys. Demote non-source roles
  // so code wins equal matches while config stays findable when nothing else hits.
  const fileRoleBoost = symbolRoleScore(row.file_role);
  score += fileRoleBoost;
  factors.push(`file role ${row.file_role} contributed ${fileRoleBoost} points`);

  // Call-graph centrality: a symbol called from many places is more central and
  // a more likely target. Bounded log-scaled tie-breaker so it never overrides
  // exact/intent matches.
  if (callInDegree && callInDegree > 0) {
    const centralityBoost = Math.min(Math.round(Math.log1p(callInDegree) * 6), 15);
    if (centralityBoost > 0) {
      score += centralityBoost;
      factors.push(`call-graph centrality (${callInDegree} callers) contributed ${centralityBoost} points`);
    }
  }

  return {
    score,
    matchedTokens,
    reason,
    exactPhrase,
    intentMatch: intentScore.score > 0,
    factors,
  };
}

export function scoreFileSearch(row: FileRow, evidence: FileEvidence | undefined, query: string, tokens: string[], bm25Boost?: number): FileSearchScore {
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
  // Stem-aware so a file named for the concept matches an inflected query token
  // (`indexer.ts` <- "indexing pipeline"). Without this the named orchestrator
  // misses the +90 boost and loses to a verbose file that merely repeats the
  // term in its body.
  const exactBasenameMatches = tokens.filter(token => wordsShareStem(token, basenameWithoutExt) && !isBroadSearchTerm(token));
  if (exactBasenameMatches.length > 0) {
    score += 90;
    reason = 'query token matched file basename';
    factors.push('query token matched file basename (stem-aware)');
  }
  // Split the basename on BOTH camelCase and separators so a PascalCase name
  // like `PaymentService` contributes its individual words ("payment",
  // "service") instead of staying an opaque single token.
  const basenameParts = splitIdentifierWords(basenameOriginalNoExt);
  const basenamePartMatches = uniqueStrings(tokens.filter(token => basenameParts.some(part => wordsShareStem(token, part))));
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
    const covered = uniqueStrings(tokens.filter(token => words.some(word => wordsShareStem(token, word))));
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

  // BM25 textual relevance from the FTS index — a bounded tie-breaker that
  // favors files whose indexed name/content genuinely match the query, on top
  // of the structural and exact/compound signals above.
  if (bm25Boost && bm25Boost > 0) {
    score += bm25Boost;
    factors.push(`BM25 textual relevance contributed ${bm25Boost} points`);
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

/**
 * Rank-1 is treated as a spurious outlier (and the cutoff anchored to rank-2
 * instead) once it exceeds the cluster head by this factor. Calibrated against
 * the evidence corpus: a verbose file that merely repeats the query term can
 * outscore the genuine cluster ~2x (e.g. `evaluation/scoring.ts` 208 over a
 * 95-point cluster); a real clear winner sits ~1.2-1.3x above rank-2. 1.4 sits
 * between those so only the spurious case relaxes the cut.
 */
const RIGHTSIZE_OUTLIER_FACTOR = 1.4;

/**
 * Relevance-cliff trimming. Candidates must already be sorted highest-score
 * first. Drops the low-relevance tail where the score falls below
 * `anchor * keepRatio`. The anchor is normally the top score, BUT when rank-1
 * is an outlier far above rank-2 the anchor drops to rank-2 — otherwise a
 * single spurious high scorer pulls the cutoff up and nukes the genuine
 * candidate cluster (observed: a 271-point outlier trimming a real answer at
 * 135 down to nothing). `minKeep` (default 1) ensures we never return empty;
 * the existing cap (maxFiles/maxSymbols) is applied upstream and only shrinks
 * the set further, never grows it.
 *
 * Rows must expose a numeric `searchScore` property (present on raw DB rows
 * returned by searchFiles / searchSymbol). Rows without it are kept as-is.
 */
export function rightSizeCandidates<T extends Record<string, unknown>>(
  rows: T[],
  opts: { keepRatio?: number; minKeep?: number } = {},
): T[] {
  const keepRatio = opts.keepRatio ?? 0.8;
  const minKeep = Math.max(1, opts.minKeep ?? 1);
  if (rows.length <= minKeep) return rows;
  const scoreOf = (row: T): number => (typeof row.searchScore === 'number' ? row.searchScore as number : 0);
  const topScore = scoreOf(rows[0]);
  if (topScore <= 0) return rows;
  const secondScore = scoreOf(rows[1]);
  // Outlier guard: if rank-1 stands far above rank-2, it is likely a spurious
  // term-frequency winner, not evidence that everything below it is irrelevant.
  // Anchor the cutoff to the cluster head (rank-2) so the real candidates below
  // survive; the answer is often in that cluster, not the outlier.
  const anchor = secondScore > 0 && topScore / secondScore >= RIGHTSIZE_OUTLIER_FACTOR
    ? secondScore
    : topScore;
  const cutoff = anchor * keepRatio;
  return rows.filter((row, i) => {
    if (i < minKeep) return true;
    return scoreOf(row) >= cutoff;
  });
}
