import { describe, expect, it } from 'vitest';
import {
  tokenizeSearchQuery,
  splitIdentifierWords,
  compactSearchText,
  identifierSearchTerms,
  isBroadSearchTerm,
  stemWord,
  wordsShareStem,
  isLibraryCallOwner,
} from '../../src/v2/query/text-util.js';

describe('text-util (extracted from service.ts)', () => {
  it('tokenizes with camelCase boundaries and drops stop words', () => {
    expect(tokenizeSearchQuery('PaymentService refund')).toEqual(['payment', 'refund']);
    // "service" is a stop word; "the"/"of" dropped; short tokens dropped.
    expect(tokenizeSearchQuery('the OrderController of a')).toEqual(['order', 'controller']);
    expect(tokenizeSearchQuery('*')).toEqual([]);
  });

  it('splits identifiers on camelCase and separators', () => {
    expect(splitIdentifierWords('PaymentService')).toEqual(['payment', 'service']);
    expect(splitIdentifierWords('order_service')).toEqual(['order', 'service']);
    expect(splitIdentifierWords('HTTPServer')).toEqual(['http', 'server']);
  });

  it('compacts to a normalized identifier form', () => {
    expect(compactSearchText('Payment-Service')).toBe('paymentservice');
    expect(compactSearchText('paymentService')).toBe('paymentservice');
  });

  it('extracts dotted/dashed identifier terms', () => {
    expect(identifierSearchTerms('call com.example.payment now')).toContain('com.example.payment');
  });

  it('flags broad/noise terms', () => {
    expect(isBroadSearchTerm('service')).toBe(true);
    expect(isBroadSearchTerm('ab')).toBe(true);
    expect(isBroadSearchTerm('payment')).toBe(false);
  });

  it('stems common inflections to a shared root', () => {
    expect(stemWord('indexing')).toBe('index');
    expect(stemWord('indexer')).toBe('index');
    expect(stemWord('index')).toBe('index');
    expect(stemWord('signals')).toBe('signal');
    // short words are left untouched to avoid over-stemming
    expect(stemWord('test')).toBe('test');
  });

  it('matches words that share a stem (the indexer<-indexing case)', () => {
    expect(wordsShareStem('indexing', 'indexer')).toBe(true);
    expect(wordsShareStem('index', 'indexing')).toBe(true);
    // silent-e / -ion cases recovered by the prefix check
    expect(wordsShareStem('scoring', 'score')).toBe(true);
    expect(wordsShareStem('extraction', 'extract')).toBe(true);
    expect(wordsShareStem('phases', 'phase')).toBe(true);
    // unrelated words must not match
    expect(wordsShareStem('index', 'render')).toBe(false);
    expect(wordsShareStem('payment', 'parser')).toBe(false);
    // a short token must NOT prefix-swallow a longer unrelated word: the
    // remainder must be a real inflection, not arbitrary letters.
    expect(wordsShareStem('call', 'callback')).toBe(false);
    expect(wordsShareStem('test', 'testament')).toBe(false);
  });

  it('flags JDK/stdlib call owners as library noise, keeps domain symbols', () => {
    // The high-frequency stdlib callees observed in the doughnut index that
    // pass the primary/provider signal gate yet carry no domain-flow meaning.
    expect(isLibraryCallOwner('Arrays.stream')).toBe(true);
    expect(isLibraryCallOwner('Integer.valueOf')).toBe(true);
    expect(isLibraryCallOwner('Collectors.toList')).toBe(true);
    expect(isLibraryCallOwner('List.of')).toBe(true);
    expect(isLibraryCallOwner('Map.put')).toBe(true);
    expect(isLibraryCallOwner('StringBuilder.append')).toBe(true);
    expect(isLibraryCallOwner('Strings.isEmpty')).toBe(true);
    // fully-qualified java.* is noise regardless of simple name
    expect(isLibraryCallOwner('java.util.Arrays.stream')).toBe(true);
    // domain symbols must be kept
    expect(isLibraryCallOwner('Note.getId')).toBe(false);
    expect(isLibraryCallOwner('AuthorizationService.assertAuthorize')).toBe(false);
    expect(isLibraryCallOwner('currentUser.getUser')).toBe(false);
    expect(isLibraryCallOwner('NotebookController.createNotebook')).toBe(false);
    // unqualified callees (no owner) are kept — constructors / local calls
    expect(isLibraryCallOwner('createNote')).toBe(false);
    expect(isLibraryCallOwner('')).toBe(false);
  });
});
