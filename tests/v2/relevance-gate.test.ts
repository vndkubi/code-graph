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

  it('does not route a generic evidence noun to evidence mode', () => {
    expect(inferCodeGraphContextMode('Assess where to add persistent checkpoint evidence', {})).toBe('change');
    expect(inferCodeGraphContextMode('Analyze PBI acceptance criteria against code', {})).toBe('evidence');
  });
});
