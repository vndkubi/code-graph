import { describe, expect, it } from 'vitest';
import {
  detectConcepts,
  scoreConceptMatch,
  conceptLikeTerms,
  conceptAnnotationTerms,
  conceptRoles,
  CONCEPT_NAME_BOOST,
  CONCEPT_ANNOTATION_BOOST,
  CONCEPT_ROLE_BOOST,
} from '../../src/v2/query/concepts.js';

describe('concept lexicon', () => {
  it('detects the auth concept from natural-language phrasing that shares no code token', () => {
    const concepts = detectConcepts('How does user authentication and login work end to end?');
    expect(concepts.map(c => c.id)).toContain('auth');
  });

  it('detects multiple concepts and none for a plain query', () => {
    expect(detectConcepts('where are transactions committed and cache evicted?').map(c => c.id).sort())
      .toEqual(['cache', 'transaction']);
    expect(detectConcepts('how does PaymentService refund work')).toEqual([]);
  });

  it('matches a concept-canonical class by NAME even without the literal query word', () => {
    const concepts = detectConcepts('how does authentication work');
    // "AuthorizationService" contains none of "authentication"/"login" as tokens.
    const result = scoreConceptMatch({ name: 'AuthorizationService' }, concepts);
    expect(result.matched).toBe(true);
    expect(result.matchedConcepts).toContain('auth');
    expect(result.score).toBe(CONCEPT_NAME_BOOST);
  });

  it('matches by annotation and by framework role, weighted below name', () => {
    const concepts = detectConcepts('how does authentication work');
    const byAnnotation = scoreConceptMatch({ name: 'DoThing', annotations: ['PreAuthorize'] }, concepts);
    expect(byAnnotation.score).toBe(CONCEPT_ANNOTATION_BOOST);
    const byRole = scoreConceptMatch({ name: 'DoThing', frameworkRole: 'spring:security' }, concepts);
    expect(byRole.score).toBe(CONCEPT_ROLE_BOOST);
    expect(CONCEPT_NAME_BOOST).toBeGreaterThan(CONCEPT_ANNOTATION_BOOST);
    expect(CONCEPT_ANNOTATION_BOOST).toBeGreaterThan(CONCEPT_ROLE_BOOST);
  });

  it('does not match unrelated symbols and stays zero when no concept fired', () => {
    const concepts = detectConcepts('how does authentication work');
    expect(scoreConceptMatch({ name: 'PaymentGateway' }, concepts).matched).toBe(false);
    // No triggered concept -> always zero regardless of the symbol.
    expect(scoreConceptMatch({ name: 'AuthorizationService' }, []).score).toBe(0);
  });

  it('exposes distinctive retrieval terms (>= 4 chars, no generic words) for candidate fetch', () => {
    const concepts = detectConcepts('how does authentication and login work');
    const likeTerms = conceptLikeTerms(concepts);
    expect(likeTerms).toContain('authoriz');
    expect(likeTerms).toContain('login');
    expect(likeTerms.every(term => term.length >= 4)).toBe(true);
    expect(conceptAnnotationTerms(concepts)).toContain('PreAuthorize');
    expect(conceptRoles(concepts)).toContain('spring:security');
  });
});
