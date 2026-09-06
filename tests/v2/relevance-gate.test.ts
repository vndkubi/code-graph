import { afterEach, describe, expect, it } from 'vitest';
import { applyContextScopeGate, inferCodeGraphContextMode, shouldRequireScopePlan } from '../../src/v2/mcp/proxy.js';

const previousGate = process.env.CODEGRAPH_RELEVANCE_GATE;

afterEach(() => {
  if (previousGate === undefined) delete process.env.CODEGRAPH_RELEVANCE_GATE;
  else process.env.CODEGRAPH_RELEVANCE_GATE = previousGate;
});

describe('host-driven scope and relevance gate', () => {
  it('fails closed with a discovery packet for ambiguous checkpoint work', () => {
    process.env.CODEGRAPH_RELEVANCE_GATE = 'enforce';
    const task = 'Assess where to add a persistent phase checkpoint while preserving exact evidence.';
    expect(shouldRequireScopePlan(task, { task })).toBe(true);
    const result = applyContextScopeGate({ task }, {
      answerable: true,
      sufficientForAnswer: true,
      sourceTool: 'get_change_pack',
      candidateFiles: [{ file: 'src/v2/checkpoint.ts', score: 0.8 }],
      evidenceSlices: [{ file: 'src/v2/checkpoint.ts', lines: '1-20', text: 'checkpoint state' }],
    }) as Record<string, unknown>;
    expect(result.answerable).toBe(false);
    expect(result.recommendedNextAction).toBe('refine_scope_with_luna');
    expect(result).toHaveProperty('scopeRequest');
    expect(result).not.toHaveProperty('evidenceSlices');
  });

  it('requires target and requirement evidence after Luna supplies scopePlan', () => {
    process.env.CODEGRAPH_RELEVANCE_GATE = 'enforce';
    const result = applyContextScopeGate({
      task: 'Implement checkout validation',
      scopePlan: {
        intent: 'change',
        target: 'checkout',
        requirements: [{ id: 'source', description: 'source', kinds: ['source'] }, { id: 'tests', description: 'tests', kinds: ['test'] }],
      },
    }, {
      answerable: true,
      sufficientForAnswer: true,
      evidenceSlices: [{ id: 'src-1', file: 'src/checkout.ts', text: 'checkout' }],
      candidateFiles: [{ file: 'src/checkout.ts' }],
    }) as Record<string, unknown>;
    expect(result.answerable).toBe(false);
    expect(result.relevanceGate).toMatchObject({ status: 'blocked' });
    expect(result.missing).toContain('tests');
  });

  it('stops after the second refinement attempt', () => {
    process.env.CODEGRAPH_RELEVANCE_GATE = 'enforce';
    const result = applyContextScopeGate({
      task: 'Implement checkout validation',
      scopePlan: {
        intent: 'change',
        target: 'missing-target',
        attempt: 2,
        requirements: [{ id: 'source', description: 'source', kinds: ['source'] }],
      },
    }, { answerable: true, sufficientForAnswer: true, evidenceSlices: [{ file: 'src/checkout.ts', text: 'checkout' }] }) as Record<string, unknown>;
    expect(result.recommendedNextAction).toBe('ask_for_exact_target');
    expect(result.allowedFollowups).toEqual([]);
  });

  it('does not let an unrelated source slice satisfy a substantive requirement', () => {
    process.env.CODEGRAPH_RELEVANCE_GATE = 'enforce';
    const result = applyContextScopeGate({
      task: 'Trace the signal',
      scopePlan: {
        intent: 'research',
        target: 'build_signal',
        requirements: [{ id: 'scoring', description: '252-day momentum and volatility scoring', kinds: ['source'] }],
      },
    }, {
      answerable: true,
      sufficientForAnswer: true,
      evidenceSlices: [{ id: 'alert-1', file: 'vn_momentum_alert_bot.py', symbol: 'build_alert_message', text: 'formats the alert message and order plan' }],
      callEdges: [{ id: 'edge-1', callee: 'build_signal', file: 'vn_momentum_alert_bot.py' }],
    }) as Record<string, unknown>;

    expect(result.answerable).toBe(false);
    expect(result.relevanceGate).toMatchObject({ status: 'blocked', targetMatched: true });
    expect(result.missing).toContain('scoring');
  });

  it('allows a session-deduplicated slice with retained terms to satisfy a substantive requirement', () => {
    process.env.CODEGRAPH_RELEVANCE_GATE = 'enforce';
    const result = applyContextScopeGate({
      task: 'Trace the signal',
      scopePlan: {
        intent: 'research',
        target: 'build_signal',
        requirements: [{ id: 'scoring', description: '252-day momentum and volatility scoring', kinds: ['source'] }],
      },
    }, {
      answerable: true,
      sufficientForAnswer: true,
      evidenceSlices: [{
        id: 'signal-1',
        file: 'vn_momentum_alert_bot.py',
        symbol: 'build_signal',
        reusedFromEarlierCall: true,
        terms: ['momentum', 'volatility', 'scoring', 'signal'],
      }],
      callEdges: [{ id: 'edge-1', callee: 'build_signal', file: 'vn_momentum_alert_bot.py' }],
    }) as Record<string, unknown>;

    expect(result.answerable).toBe(true);
    expect(result.relevanceGate).toMatchObject({ status: 'passed', targetMatched: true });
  });

  it('blocks an unrelated session-deduplicated slice that lacks the substantive terms', () => {
    process.env.CODEGRAPH_RELEVANCE_GATE = 'enforce';
    const result = applyContextScopeGate({
      task: 'Trace the signal',
      scopePlan: {
        intent: 'research',
        target: 'build_signal',
        requirements: [{ id: 'scoring', description: '252-day momentum and volatility scoring', kinds: ['source'] }],
      },
    }, {
      answerable: true,
      sufficientForAnswer: true,
      evidenceSlices: [{
        id: 'alert-1',
        file: 'vn_momentum_alert_bot.py',
        symbol: 'build_alert_message',
        reusedFromEarlierCall: true,
        terms: ['formats', 'alert', 'message', 'order', 'plan'],
      }],
      callEdges: [{ id: 'edge-1', callee: 'build_signal', file: 'vn_momentum_alert_bot.py' }],
    }) as Record<string, unknown>;

    expect(result.answerable).toBe(false);
    expect(result.relevanceGate).toMatchObject({ status: 'blocked', targetMatched: true });
    expect(result.missing).toContain('scoring');
  });

  it('matches test requirements using the file path in testsLikelyRelevant', () => {
    process.env.CODEGRAPH_RELEVANCE_GATE = 'enforce';
    const result = applyContextScopeGate({
      task: 'Implement PaymentService refund behavior',
      scopePlan: {
        intent: 'change',
        target: 'PaymentService',
        requirements: [
          { id: 'payment-test', description: 'PaymentService test coverage', kinds: ['test'] },
        ],
      },
    }, {
      answerable: true,
      sufficientForAnswer: true,
      candidateFiles: [{ file: 'src/payment/PaymentService.java' }],
      testsLikelyRelevant: [{ file: 'tests/payment/PaymentService.test.ts', score: 0.95 }],
    }) as Record<string, unknown>;

    expect(result.answerable).toBe(true);
    expect(result.relevanceGate).toMatchObject({
      status: 'passed',
      targetMatched: true,
      missingRequirements: [],
    });
  });

  it('matches short 2-3 char domain acronyms such as jwt, vat, api, and sql in source requirements', () => {
    process.env.CODEGRAPH_RELEVANCE_GATE = 'enforce';
    const result = applyContextScopeGate({
      task: 'Verify JWT authentication token',
      scopePlan: {
        intent: 'research',
        target: 'jwt',
        requirements: [
          { id: 'jwt-check', description: 'JWT signature check', kinds: ['source'] },
        ],
      },
    }, {
      answerable: true,
      sufficientForAnswer: true,
      evidenceSlices: [{
        id: 'jwt-1',
        file: 'src/auth/jwt.ts',
        symbol: 'verifyJWT',
        text: 'function verifyJWT(token: string) { return decode(token); }',
      }],
    }) as Record<string, unknown>;

    expect(result.answerable).toBe(true);
    expect(result.relevanceGate).toMatchObject({ status: 'passed', targetMatched: true });
  });

  it('does not route a generic evidence noun to evidence mode', () => {
    expect(inferCodeGraphContextMode('Assess where to add persistent checkpoint evidence', {})).toBe('change');
    expect(inferCodeGraphContextMode('Analyze PBI acceptance criteria against code', {})).toBe('evidence');
  });
});
