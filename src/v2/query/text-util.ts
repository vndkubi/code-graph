/**
 * Leaf text/tokenization utilities for query ranking and search. Extracted from
 * service.ts (which had grown past 11k lines) so the ranking/search logic can be
 * reasoned about and unit-tested in isolation. Pure functions and stop-word
 * sets only — no DB or class state.
 */

export const EXPLICIT_FILENAME_STOP_WORDS = new Set([
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

export const SEARCH_STOP_WORDS = new Set([
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

export const RESEARCH_STOP_WORDS = new Set([
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

export const FILE_SEARCH_STOP_WORDS = new Set([
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

export const FILE_SEARCH_BROAD_TERMS = new Set([
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

export function isBroadExplicitRef(value: string): boolean {
  return EXPLICIT_FILENAME_STOP_WORDS.has(value)
    || FILE_SEARCH_STOP_WORDS.has(value.toLowerCase())
    || /^[A-Z0-9_]{2,8}$/.test(value);
}

export function isBroadSearchTerm(value: string): boolean {
  return value.length < 3 || FILE_SEARCH_BROAD_TERMS.has(value.toLowerCase());
}

export function tokenizeSearchQuery(query: string): string[] {
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

export function identifierSearchTerms(query: string): string[] {
  return [...new Set((query.match(/[a-z0-9]+(?:[._-][a-z0-9]+)+/g) ?? [])
    .map(term => term.trim().toLowerCase())
    .filter(term => term.length >= 4))];
}

export function compactSearchText(value: string): string {
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
export function splitIdentifierWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

// Suffixes stripped longest-first so a single pass removes the most specific
// morphological ending. Conservative on purpose: the `wordsShareStem` prefix
// check below recovers cases this list doesn't normalize perfectly (e.g.
// `extraction` ~ `extract`), so the list only needs the high-frequency endings.
const STEM_SUFFIXES = [
  'izations', 'ization', 'ations', 'ation', 'izing',
  'ings', 'ies', 'ing', 'ers', 'ors', 'er', 'or', 'ed', 'es', 's',
];

/**
 * Light morphological stem. Maps `indexing`, `indexer`, `index` -> `index`;
 * `scoring` -> `scor`; `phases` -> `phas`. Not a full Porter stemmer — just
 * enough to let a file literally named for a concept (`indexer.ts`) match a
 * query that names the concept in a different inflection (`indexing pipeline`).
 * Words of length <= 4 are returned unchanged to avoid over-stemming.
 */
export function stemWord(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= 4) return w;
  for (const suffix of STEM_SUFFIXES) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 3) {
      return w.slice(0, w.length - suffix.length);
    }
  }
  return w;
}

// The remainder a prefix match is allowed to add. Restricting it to genuine
// inflectional endings stops a short query token from prefix-matching an
// unrelated longer word (`call` must NOT match `callback` — remainder `back`;
// but `extract` ~ `extraction` (remainder `ion`) and `scor` ~ `score`
// (remainder `e`) are real morphology and must still match).
const INFLECTIONAL_REMAINDER = /^(e|s|es|d|ed|r|er|ers|or|ors|ing|ings|ion|ions|tion|ation|al)$/;

/**
 * Whether two words refer to the same root after light stemming. Equal stems
 * match; so do stems where one is a prefix of the other (min shared length 4)
 * AND the trailing remainder is a real inflectional ending — the suffix list
 * leaves silent-`e`/`-ion` cases slightly off, and this recovers them without
 * letting `call` swallow `callback`.
 */
export function wordsShareStem(a: string, b: string): boolean {
  if (a === b) return true;
  const sa = stemWord(a);
  const sb = stemWord(b);
  if (sa === sb) return true;
  const [shorter, longer] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  if (shorter.length < 4 || !longer.startsWith(shorter)) return false;
  return INFLECTIONAL_REMAINDER.test(longer.slice(shorter.length));
}
