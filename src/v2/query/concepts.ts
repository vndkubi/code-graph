/**
 * Concept lexicon — framework-aware boosting for cross-cutting concerns that
 * carry NO signal in pure lexical token ranking. A query like "how does
 * authentication work" names a *concept* (auth/login/security) whose canonical
 * code (AuthorizationService, CurrentUserFetcherFromRequest, a UserDetailsService
 * bean, a security filter) usually does NOT contain the literal words
 * "authentication" or "login". Token-overlap ranking therefore falls back to
 * whatever generic word co-occurs ("user", "http") and surfaces the wrong
 * neighborhood — a keyword collision that still reports answerable=true.
 *
 * This module maps a small set of high-frequency concepts to the framework
 * ROLES (java-framework-detector.ts), ANNOTATIONS, and NAME fragments that
 * actually mark them, then contributes a bounded additive boost — the exact
 * same shape as the existing intent boosts in ranking.ts (service/repository/
 * entity/mybatis/docker), which are proven not to regress. It is deliberately
 * NOT lexical synonym expansion of the query (that approach was tried and
 * reverted): concepts are detected once from the query and matched against
 * indexed structural metadata, not by rewriting search terms.
 *
 * Scope: only concerns with no existing ranking signal (auth, transaction,
 * caching, scheduling/async, validation, events/messaging). service/repository/
 * entity/endpoint already have intent boosts in scoreFileSearch and are left
 * alone to avoid double-counting.
 */

export interface ConceptRule {
  id: string;
  /** Fires the concept when the natural-language query mentions it. */
  trigger: RegExp;
  /** Indexed framework_role values that mark this concept (broad — moderate boost). */
  roles: Set<string>;
  /** Annotation simple-names that mark this concept (fairly specific). */
  annotations: RegExp;
  /** Name fragments whose presence in a symbol/file name signals the concept (specific). */
  nameHints: RegExp;
  /**
   * Distinctive lowercase substrings used to RETRIEVE concept candidates via SQL
   * LIKE — concept boosting only re-ranks rows that were fetched, and the concept's
   * canonical code (AuthorizationService for "authentication") usually shares no
   * literal query token, so it would never enter the candidate pool without these.
   * Kept specific (len >= 4, no generic words) to bound over-fetch.
   */
  likeTerms: string[];
  /** Annotation substrings to retrieve annotated symbols via annotations_json LIKE. */
  annotationTerms: string[];
}

// Boost magnitudes, calibrated to compete with lexical token tiers in
// ranking.ts (single-token-in-simple-name = 88, all-tokens-in-name = 88). A
// name literally about the concept is as strong a signal as a name token match;
// an annotation is a firm structural marker; a role is broader (a @Transactional
// method is only weakly "about transactions") so it earns the least. Max across
// hint types per concept, summed across distinct concepts, then capped so a
// multi-concept query can never let concept boosts dominate an exact match.
export const CONCEPT_NAME_BOOST = 72;
export const CONCEPT_ANNOTATION_BOOST = 48;
export const CONCEPT_ROLE_BOOST = 34;
export const CONCEPT_TOTAL_CAP = 100;
// A file that merely HOSTS a concept symbol is weaker evidence than a symbol
// that IS the concept, so file matches earn a flat per-concept boost below the
// symbol name tier.
export const CONCEPT_FILE_BOOST = 55;

/**
 * The lexicon. Ordered by rough frequency of the question in real repos. Each
 * rule's roles come straight from java-framework-detector.ts so they match real
 * indexed metadata, not aspirational strings.
 */
export const CONCEPT_RULES: readonly ConceptRule[] = [
  {
    id: 'auth',
    trigger: /\b(authentication|authenticate|authenticated|authorization|authorize|authorized|auth|login|log[- ]?in|logout|log[- ]?out|sign[- ]?in|sign[- ]?out|signin|signout|credential|credentials|principal|security|secured|permission|permissions|access[- ]?control|current[- ]?user|logged[- ]?in|jwt|oauth|bearer[- ]?token|session)\b/i,
    roles: new Set(['spring:security']),
    annotations: /^(PreAuthorize|PostAuthorize|Secured|RolesAllowed|DenyAll|PermitAll|EnableWebSecurity|EnableGlobalMethodSecurity|EnableMethodSecurity|AuthenticationPrincipal|WithMockUser|WithUserDetails)$/i,
    nameHints: /(authoriz|authentic|\bauth\b|security|secured|login|logout|signin|signout|credential|principal|currentuser|userdetails|userfetcher|jwt|oauth|bearer|permission|accesscontrol|loginuser)/i,
    likeTerms: ['authoriz', 'authentic', 'security', 'login', 'logout', 'credential', 'principal', 'currentuser', 'userdetails', 'oauth', 'permission'],
    annotationTerms: ['PreAuthorize', 'PostAuthorize', 'Secured', 'RolesAllowed', 'EnableWebSecurity', 'AuthenticationPrincipal'],
  },
  {
    id: 'transaction',
    trigger: /\b(transaction|transactional|transactions|commit|committed|rollback|rolled[- ]?back|atomic|atomicity|unit[- ]?of[- ]?work)\b/i,
    roles: new Set(['spring:transactional', 'spring:enable-tx', 'jakarta:transaction-attribute', 'jakarta:tx-management']),
    annotations: /^(Transactional|TransactionAttribute|EnableTransactionManagement)$/i,
    nameHints: /(transaction|transactional|\bcommit\b|rollback|unitofwork)/i,
    likeTerms: ['transaction', 'rollback', 'unitofwork'],
    annotationTerms: ['Transactional', 'TransactionAttribute'],
  },
  {
    id: 'cache',
    trigger: /\b(cache|caches|caching|cached|evict|eviction|memoize|memoized|memoization)\b/i,
    roles: new Set(['spring:cacheable', 'spring:cache-evict', 'spring:enable-caching']),
    annotations: /^(Cacheable|CacheEvict|CachePut|Caching|EnableCaching)$/i,
    nameHints: /(cache|caching|evict|memoiz)/i,
    likeTerms: ['cache', 'caching', 'evict', 'memoiz'],
    annotationTerms: ['Cacheable', 'CacheEvict', 'CachePut', 'EnableCaching'],
  },
  {
    id: 'scheduling',
    trigger: /\b(schedule|scheduled|scheduler|scheduling|cron|periodic|periodically|background[- ]?job|background[- ]?task|async|asynchronous|asynchronously)\b/i,
    roles: new Set(['spring:scheduled', 'spring:enable-scheduling', 'spring:async', 'spring:enable-async', 'jakarta:schedule', 'jakarta:ejb-async']),
    annotations: /^(Scheduled|Async|EnableScheduling|EnableAsync|Schedule|Asynchronous)$/i,
    nameHints: /(schedul|\bcron\b|\basync\b|background(job|task)|worker|periodic)/i,
    likeTerms: ['schedul', 'async', 'periodic'],
    annotationTerms: ['Scheduled', 'EnableScheduling', 'EnableAsync'],
  },
  {
    id: 'validation',
    trigger: /\b(validation|validate|validated|validates|validator|validating|constraint|constraints|invalid|malformed)\b/i,
    roles: new Set<string>(),
    annotations: /^(Valid|Validated|NotNull|NotBlank|NotEmpty|Size|Pattern|Min|Max|Email|Positive|Negative|Constraint|AssertTrue|AssertFalse|Past|Future|Digits)$/i,
    nameHints: /(validat|validator|constraint)/i,
    likeTerms: ['validat', 'constraint'],
    annotationTerms: ['Validated', 'Constraint'],
  },
  {
    id: 'messaging',
    trigger: /\b(event|events|listener|listeners|publish|published|publisher|subscribe|subscriber|subscription|message|messages|messaging|queue|kafka|rabbit|rabbitmq|jms|amqp|pub[- ]?sub|broker)\b/i,
    roles: new Set(['spring:event-listener', 'jakarta:observes', 'jakarta:message-driven']),
    annotations: /^(EventListener|TransactionalEventListener|Observes|ObservesAsync|MessageDriven|KafkaListener|RabbitListener|JmsListener|StreamListener)$/i,
    nameHints: /(event|listener|publish|subscrib|\bmessage\b|messaging|consumer|producer|\bqueue\b|kafka|rabbit)/i,
    likeTerms: ['listener', 'publish', 'subscrib', 'messaging', 'kafka', 'rabbit'],
    annotationTerms: ['EventListener', 'KafkaListener', 'RabbitListener', 'JmsListener'],
  },
];

/** Detect which concepts a natural-language query mentions. Cheap: run once per query. */
export function detectConcepts(query: string): ConceptRule[] {
  if (!query) return [];
  return CONCEPT_RULES.filter(rule => rule.trigger.test(query));
}

/** Distinctive name substrings to fetch concept candidates (SQL LIKE on name/fqName/file). */
export function conceptLikeTerms(concepts: readonly ConceptRule[]): string[] {
  return [...new Set(concepts.flatMap(concept => concept.likeTerms))];
}

/** Annotation substrings to fetch annotated concept candidates (SQL LIKE on annotations_json). */
export function conceptAnnotationTerms(concepts: readonly ConceptRule[]): string[] {
  return [...new Set(concepts.flatMap(concept => concept.annotationTerms))];
}

/** Exact framework_role values to fetch concept candidates (SQL IN on framework_role). */
export function conceptRoles(concepts: readonly ConceptRule[]): string[] {
  return [...new Set(concepts.flatMap(concept => [...concept.roles]))];
}

export interface ConceptTarget {
  name?: string;
  frameworkRole?: string;
  /** Annotation simple-names, if available (symbol rows only). */
  annotations?: string[];
}

/**
 * Score a single symbol/file against the triggered concepts. Returns the bounded
 * additive boost and which concepts matched (for rank explanation and for the
 * calibration coverage signal). `matched` is true when at least one concept was
 * satisfied — used to retain concept-only candidates through the token filter
 * and to detect whether a pack actually covered the concept the user asked about.
 */
export function scoreConceptMatch(target: ConceptTarget, concepts: readonly ConceptRule[]): {
  score: number;
  matched: boolean;
  matchedConcepts: string[];
  factors: string[];
} {
  if (concepts.length === 0) return { score: 0, matched: false, matchedConcepts: [], factors: [] };
  const name = (target.name ?? '').toLowerCase();
  const role = (target.frameworkRole ?? '').toLowerCase();
  const annotations = target.annotations ?? [];
  let total = 0;
  const matchedConcepts: string[] = [];
  const factors: string[] = [];
  for (const concept of concepts) {
    let best = 0;
    let via = '';
    if (name && concept.nameHints.test(name)) {
      best = CONCEPT_NAME_BOOST;
      via = 'name';
    }
    if (best < CONCEPT_ANNOTATION_BOOST && annotations.some(annotation => concept.annotations.test(annotation))) {
      best = CONCEPT_ANNOTATION_BOOST;
      via = 'annotation';
    }
    if (best < CONCEPT_ROLE_BOOST && role && concept.roles.has(role)) {
      best = CONCEPT_ROLE_BOOST;
      via = 'role';
    }
    if (best > 0) {
      total += best;
      matchedConcepts.push(concept.id);
      factors.push(`concept '${concept.id}' matched via ${via} (+${best})`);
    }
  }
  const capped = Math.min(total, CONCEPT_TOTAL_CAP);
  return { score: capped, matched: matchedConcepts.length > 0, matchedConcepts, factors };
}
