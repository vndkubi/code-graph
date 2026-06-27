import { describe, expect, it } from 'vitest';
import {
  tokenizeSearchQuery,
  splitIdentifierWords,
  compactSearchText,
  identifierSearchTerms,
  isBroadSearchTerm,
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
});
