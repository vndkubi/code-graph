import type { SymbolInfo } from './base-analyzer.js';

// ─── Role mapping tables ─────────────────────────────────────────────────────

/**
 * Maps annotation name → framework role string.
 * Applied to classes, interfaces, methods, and fields.
 */
const ANNOTATION_ROLE: Record<string, string> = {
  // ── Spring Boot / Spring Framework ──────────────────────────────────────
  SpringBootApplication: 'spring:application',
  Component: 'spring:component',
  Service: 'spring:service',
  Repository: 'spring:repository',
  Controller: 'spring:controller',       // resolved to mvc:controller in Jakarta context
  RestController: 'spring:rest-controller',
  Configuration: 'spring:configuration',
  Bean: 'spring:bean',
  Transactional: 'spring:transactional',
  Scheduled: 'spring:scheduled',
  EventListener: 'spring:event-listener',
  Async: 'spring:async',
  EnableAsync: 'spring:enable-async',
  EnableScheduling: 'spring:enable-scheduling',
  EnableTransactionManagement: 'spring:enable-tx',
  EnableCaching: 'spring:enable-caching',
  Cacheable: 'spring:cacheable',
  CacheEvict: 'spring:cache-evict',
  ConditionalOnProperty: 'spring:conditional',
  Profile: 'spring:profile',
  Primary: 'spring:primary',
  Qualifier: 'spring:qualifier',
  Scope: 'spring:scope',
  Lazy: 'spring:lazy',
  // Spring HTTP endpoints
  RequestMapping: 'spring:endpoint',
  GetMapping: 'spring:endpoint',
  PostMapping: 'spring:endpoint',
  PutMapping: 'spring:endpoint',
  DeleteMapping: 'spring:endpoint',
  PatchMapping: 'spring:endpoint',
  // Spring Security
  PreAuthorize: 'spring:security',
  PostAuthorize: 'spring:security',
  Secured: 'spring:security',
  // Spring Data
  Query: 'spring:query',
  Modifying: 'spring:modifying',
  // DI (Spring + Jakarta)
  Autowired: 'di:autowired',
  Value: 'spring:config-value',

  // ── Jakarta EE / Java EE ─────────────────────────────────────────────────
  // ── EJB ─────────────────────────────────────────────────────────────────
  Stateless: 'jakarta:stateless',
  Stateful: 'jakarta:stateful',
  Singleton: 'jakarta:singleton',
  MessageDriven: 'jakarta:message-driven',
  LocalBean: 'jakarta:local-bean',
  Startup: 'jakarta:startup',
  TransactionAttribute: 'jakarta:transaction-attribute',
  TransactionManagement: 'jakarta:tx-management',
  Lock: 'jakarta:lock',
  Schedule: 'jakarta:schedule',
  Asynchronous: 'jakarta:ejb-async',
  ConcurrencyManagement: 'jakarta:ejb-concurrency',
  AccessTimeout: 'jakarta:ejb-access-timeout',
  Remove: 'jakarta:ejb-remove',
  ActivationConfigProperty: 'jakarta:ejb-config',
  // ── JPA ─────────────────────────────────────────────────────────────────
  Entity: 'jakarta:entity',
  Table: 'jakarta:table',
  MappedSuperclass: 'jakarta:mapped-superclass',
  Embeddable: 'jakarta:embeddable',
  Embedded: 'jakarta:embedded',
  EmbeddedId: 'jakarta:id',
  Inheritance: 'jakarta:inheritance',
  Column: 'jakarta:column',
  Id: 'jakarta:id',
  IdClass: 'jakarta:id-class',
  GeneratedValue: 'jakarta:generated-value',
  ManyToOne: 'jakarta:relation',
  OneToMany: 'jakarta:relation',
  OneToOne: 'jakarta:relation',
  ManyToMany: 'jakarta:relation',
  JoinColumn: 'jakarta:join-column',
  JoinTable: 'jakarta:join-table',
  NamedQuery: 'jakarta:named-query',
  NamedQueries: 'jakarta:named-query',
  NamedNativeQuery: 'jakarta:named-query',
  Enumerated: 'jakarta:enumerated',
  Temporal: 'jakarta:temporal',
  Lob: 'jakarta:lob',
  Transient: 'jakarta:transient',
  Version: 'jakarta:version',
  Basic: 'jakarta:basic',
  OrderBy: 'jakarta:order-by',
  OrderColumn: 'jakarta:order-column',
  ElementCollection: 'jakarta:element-collection',
  CollectionTable: 'jakarta:collection-table',
  SecondaryTable: 'jakarta:secondary-table',
  EntityListeners: 'jakarta:entity-listeners',
  AttributeOverride: 'jakarta:attribute-override',
  AttributeOverrides: 'jakarta:attribute-override',
  AssociationOverride: 'jakarta:association-override',
  // JPA lifecycle callbacks
  PrePersist: 'jakarta:lifecycle',
  PostPersist: 'jakarta:lifecycle',
  PreUpdate: 'jakarta:lifecycle',
  PostUpdate: 'jakarta:lifecycle',
  PreRemove: 'jakarta:lifecycle',
  PostRemove: 'jakarta:lifecycle',
  PostLoad: 'jakarta:lifecycle',
  // ── CDI ─────────────────────────────────────────────────────────────────
  Named: 'jakarta:cdi-bean',
  ApplicationScoped: 'jakarta:cdi-bean',
  RequestScoped: 'jakarta:cdi-bean',
  SessionScoped: 'jakarta:cdi-bean',
  Dependent: 'jakarta:cdi-bean',
  ConversationScoped: 'jakarta:cdi-bean',
  Produces: 'jakarta:produces',
  Disposes: 'jakarta:disposes',
  Observes: 'jakarta:observes',
  ObservesAsync: 'jakarta:observes',
  Stereotype: 'jakarta:stereotype',
  Alternative: 'jakarta:alternative',
  Specializes: 'jakarta:specializes',
  Vetoed: 'jakarta:vetoed',
  Interceptor: 'jakarta:interceptor',
  Interceptors: 'jakarta:interceptors',
  AroundInvoke: 'jakarta:around-invoke',
  AroundTimeout: 'jakarta:around-timeout',
  AroundConstruct: 'jakarta:around-construct',
  Decorator: 'jakarta:decorator',
  Delegate: 'jakarta:delegate',
  // ── JAX-RS ──────────────────────────────────────────────────────────────
  Path: 'jaxrs:endpoint',
  GET: 'jaxrs:endpoint',
  POST: 'jaxrs:endpoint',
  PUT: 'jaxrs:endpoint',
  DELETE: 'jaxrs:endpoint',
  PATCH: 'jaxrs:endpoint',
  HEAD: 'jaxrs:endpoint',
  OPTIONS: 'jaxrs:endpoint',
  ApplicationPath: 'jaxrs:application-path',
  Provider: 'jaxrs:provider',
  Consumes: 'jaxrs:consumes',
  PathParam: 'jaxrs:path-param',
  QueryParam: 'jaxrs:query-param',
  FormParam: 'jaxrs:form-param',
  BeanParam: 'jaxrs:bean-param',
  HeaderParam: 'jaxrs:header-param',
  MatrixParam: 'jaxrs:matrix-param',
  CookieParam: 'jaxrs:cookie-param',
  Context: 'jaxrs:context',
  // ── Jakarta MVC ─────────────────────────────────────────────────────────
  // Note: @Controller is detected contextually — if paired with JAX-RS annotations → mvc:controller
  View: 'mvc:view',
  CsrfProtected: 'mvc:csrf-protected',
  MvcBinding: 'mvc:binding',
  UriRef: 'mvc:uri-ref',
  RedirectScoped: 'mvc:redirect-scoped',
  // ── DI (Jakarta) ────────────────────────────────────────────────────────
  Inject: 'di:inject',
  PersistenceContext: 'jakarta:persistence-context',
  PersistenceUnit: 'jakarta:persistence-unit',
  Resource: 'jakarta:resource',
  EJB: 'jakarta:ejb-ref',
  WebServiceRef: 'jakarta:ws-ref',
  // ── Jakarta Annotations ─────────────────────────────────────────────────
  PostConstruct: 'jakarta:lifecycle',
  PreDestroy: 'jakarta:lifecycle',
  Priority: 'jakarta:priority',
  // ── Servlet ─────────────────────────────────────────────────────────────
  WebServlet: 'jakarta:web-servlet',
  WebFilter: 'jakarta:web-filter',
  WebListener: 'jakarta:web-listener',
  WebInitParam: 'jakarta:web-init-param',
  MultipartConfig: 'jakarta:multipart-config',
  ServletSecurity: 'jakarta:servlet-security',
  // ── Security (JSR-250 / Jakarta Security) ───────────────────────────────
  RolesAllowed: 'jakarta:security',
  PermitAll: 'jakarta:security',
  DenyAll: 'jakarta:security',
  DeclareRoles: 'jakarta:security',
  RunAs: 'jakarta:security',
  // ── Bean Validation ─────────────────────────────────────────────────────
  NotNull: 'jakarta:validation',
  NotBlank: 'jakarta:validation',
  NotEmpty: 'jakarta:validation',
  Size: 'jakarta:validation',
  Min: 'jakarta:validation',
  Max: 'jakarta:validation',
  DecimalMin: 'jakarta:validation',
  DecimalMax: 'jakarta:validation',
  Digits: 'jakarta:validation',
  Pattern: 'jakarta:validation',
  Email: 'jakarta:validation',
  Future: 'jakarta:validation',
  Past: 'jakarta:validation',
  FutureOrPresent: 'jakarta:validation',
  PastOrPresent: 'jakarta:validation',
  Positive: 'jakarta:validation',
  PositiveOrZero: 'jakarta:validation',
  Negative: 'jakarta:validation',
  NegativeOrZero: 'jakarta:validation',
  AssertTrue: 'jakarta:validation',
  AssertFalse: 'jakarta:validation',
  Valid: 'jakarta:validation',
  Validated: 'jakarta:validation',
  Constraint: 'jakarta:validation',

  // ── JUnit 5 ──────────────────────────────────────────────────────────────
  Test: 'test:test',
  ParameterizedTest: 'test:parameterized',
  RepeatedTest: 'test:repeated',
  TestFactory: 'test:factory',
  BeforeEach: 'test:before-each',
  AfterEach: 'test:after-each',
  BeforeAll: 'test:before-all',
  AfterAll: 'test:after-all',
  Disabled: 'test:disabled',
  DisplayName: 'test:display-name',
  Tag: 'test:tag',
  Nested: 'test:nested',
  ExtendWith: 'test:extend-with',
  TestMethodOrder: 'test:order',
  Order: 'test:order',
  Timeout: 'test:timeout',
  TempDir: 'test:temp-dir',
  // JUnit 4 (legacy)
  RunWith: 'test:run-with',
  Rule: 'test:rule',
  ClassRule: 'test:class-rule',
  Before: 'test:before-each',
  After: 'test:after-each',
  BeforeClass: 'test:before-all',
  AfterClass: 'test:after-all',
  Ignore: 'test:disabled',
  // Mockito
  Mock: 'test:mock',
  Spy: 'test:spy',
  InjectMocks: 'test:subject',
  Captor: 'test:captor',
  MockBean: 'test:mock-bean',    // Spring Boot Test
  SpyBean: 'test:spy-bean',
  // Arquillian / integration test
  Deployment: 'test:deployment',
  ArquillianResource: 'test:resource',

  // ── Lombok ────────────────────────────────────────────────────────────────
  Data: 'lombok:data',
  // Note: Lombok @Value conflicts with Spring @Value — handled contextually in detectFrameworkRoles()
  Builder: 'lombok:builder',
  SuperBuilder: 'lombok:super-builder',
  Getter: 'lombok:getter',
  Setter: 'lombok:setter',
  ToString: 'lombok:to-string',
  EqualsAndHashCode: 'lombok:equals-hashcode',
  RequiredArgsConstructor: 'lombok:required-constructor',
  AllArgsConstructor: 'lombok:all-constructor',
  NoArgsConstructor: 'lombok:no-constructor',
  Slf4j: 'lombok:logger',
  Log4j2: 'lombok:logger',
  Log: 'lombok:logger',
  NonNull: 'lombok:non-null',
  SneakyThrows: 'lombok:sneaky-throws',
  Synchronized: 'lombok:synchronized',
  Cleanup: 'lombok:cleanup',
  With: 'lombok:with',
  FieldDefaults: 'lombok:field-defaults',
  Accessors: 'lombok:accessors',
};

/** HTTP method implied by annotation (Spring MVC + JAX-RS) */
const HTTP_METHOD: Record<string, string> = {
  // Spring MVC
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
  // JAX-RS
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  DELETE: 'DELETE',
  PATCH: 'PATCH',
  HEAD: 'HEAD',
  OPTIONS: 'OPTIONS',
};

/** JAX-RS annotations that indicate a class/method is a REST endpoint */
const JAXRS_HTTP_ANNOTATIONS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'Path']);

/** Lombok annotations that synthesize getters for all fields. */
const LOMBOK_ALL_GETTERS = new Set(['Data', 'Value', 'Getter']);
/** Lombok annotations that synthesize setters for all fields. */
const LOMBOK_ALL_SETTERS = new Set(['Data', 'Setter']);
/** Lombok annotations that synthesize a constructor. */
const LOMBOK_CONSTRUCTORS: Record<string, string> = {
  Data: 'RequiredArgs',
  Value: 'AllArgs',
  RequiredArgsConstructor: 'RequiredArgs',
  AllArgsConstructor: 'AllArgs',
  NoArgsConstructor: 'NoArgs',
};

// ─── Main exports ─────────────────────────────────────────────────────────────

/**
 * Mutates symbols in-place: sets frameworkRole and frameworkMeta
 * based on the annotations already extracted from the AST.
 */
export function detectFrameworkRoles(symbols: SymbolInfo[]): void {
  for (const sym of symbols) {
    if (!sym.annotations?.length) continue;

    const anns = sym.annotations;
    const roles: string[] = [];
    const meta: Record<string, string> = {};

    for (const ann of anns) {
      // @Value on a class → Lombok @Value (immutable @Data); on a field → Spring @Value
      if (ann === 'Value') {
        const role = sym.kind === 'class' ? 'lombok:value' : 'spring:config-value';
        if (!roles.includes(role)) roles.push(role);
        continue;
      }

      // @Controller: Jakarta MVC when also annotated with JAX-RS annotations; else Spring MVC
      if (ann === 'Controller') {
        const hasJaxrs = anns.some(a => JAXRS_HTTP_ANNOTATIONS.has(a));
        const role = hasJaxrs ? 'mvc:controller' : 'spring:controller';
        if (!roles.includes(role)) roles.push(role);
        continue;
      }

      const role = ANNOTATION_ROLE[ann];
      if (role && !roles.includes(role)) roles.push(role);

      // HTTP method metadata
      const httpMethod = HTTP_METHOD[ann];
      if (httpMethod) meta['httpMethod'] = httpMethod;
    }

    if (roles.length > 0) {
      // Primary role = first detected; but prefer mvc:controller / spring:rest-controller
      // over generic cdi-bean / endpoint so the most actionable role surfaces first
      const prioritized = [
        'mvc:controller', 'spring:rest-controller', 'spring:controller',
        'jakarta:stateless', 'jakarta:singleton', 'jakarta:stateful',
        'spring:service', 'spring:repository', 'spring:component',
      ];
      const primary = prioritized.find(r => roles.includes(r)) ?? roles[0];
      sym.frameworkRole = primary;
      // Merge annotation-derived meta with any parse-time meta (e.g. path from @GetMapping args)
      if (Object.keys(meta).length > 0) {
        sym.frameworkMeta = { ...(sym.frameworkMeta ?? {}), ...meta };
      }
    }
  }
}

/**
 * Returns synthetic SymbolInfo entries for methods/fields that Lombok would generate.
 * These help the call graph find usages like user.getEmail(), User.builder(), etc.
 */
export function synthesizeLombokSymbols(symbols: SymbolInfo[], file: string): SymbolInfo[] {
  const synthetic: SymbolInfo[] = [];

  // Group symbols by parent class
  const classesByName = new Map<string, SymbolInfo>();
  const fieldsByClass = new Map<string, SymbolInfo[]>();

  for (const sym of symbols) {
    if (sym.kind === 'class' && !sym.parent) {
      classesByName.set(sym.name, sym);
    }
    if (sym.kind === 'field' && sym.parent) {
      if (!fieldsByClass.has(sym.parent)) fieldsByClass.set(sym.parent, []);
      fieldsByClass.get(sym.parent)!.push(sym);
    }
  }

  for (const [className, classSym] of classesByName) {
    const annotations = classSym.annotations ?? [];
    const fields = fieldsByClass.get(className) ?? [];

    // @Slf4j, @Log4j2, @Log → synthesize `log` field
    if (annotations.some(a => ['Slf4j', 'Log4j2', 'Log'].includes(a))) {
      synthetic.push(makeSyntheticField(className, 'log', 'Logger', file, classSym.line, 'lombok:logger'));
    }

    // @Builder / @SuperBuilder → synthesize static builder() method
    if (annotations.some(a => ['Builder', 'SuperBuilder'].includes(a))) {
      synthetic.push(makeSyntheticMethod(className, 'builder', file, classSym.line, 'lombok:builder', true));
      synthetic.push(makeSyntheticMethod(className, 'build', file, classSym.line, 'lombok:builder', false));
      synthetic.push(makeSyntheticMethod(className, 'toBuilder', file, classSym.line, 'lombok:builder', false));
    }

    // @Getter / @Data / @Value → synthesize getXxx() for each field
    if (annotations.some(a => LOMBOK_ALL_GETTERS.has(a))) {
      for (const field of fields) {
        const getterName = 'get' + capitalize(field.name);
        synthetic.push(makeSyntheticMethod(className, getterName, file, field.line, 'lombok:getter', false));
      }
    }

    // @Setter / @Data → synthesize setXxx() for non-final fields
    if (annotations.some(a => LOMBOK_ALL_SETTERS.has(a))) {
      for (const field of fields) {
        if (field.isStatic) continue;  // skip static fields
        const setterName = 'set' + capitalize(field.name);
        synthetic.push(makeSyntheticMethod(className, setterName, file, field.line, 'lombok:setter', false));
      }
    }

    // @Data / @EqualsAndHashCode → equals, hashCode, toString
    if (annotations.some(a => ['Data', 'EqualsAndHashCode', 'ToString'].includes(a))) {
      synthetic.push(makeSyntheticMethod(className, 'equals', file, classSym.line, 'lombok:equals-hashcode', false));
      synthetic.push(makeSyntheticMethod(className, 'hashCode', file, classSym.line, 'lombok:equals-hashcode', false));
      synthetic.push(makeSyntheticMethod(className, 'toString', file, classSym.line, 'lombok:to-string', false));
    }

    // @RequiredArgsConstructor / @AllArgsConstructor / @NoArgsConstructor / @Data / @Value → constructor
    const constructorAnnotations = annotations.filter(a => a in LOMBOK_CONSTRUCTORS);
    if (constructorAnnotations.length > 0) {
      synthetic.push(makeSyntheticMethod(className, className, file, classSym.line, 'lombok:constructor', false));
    }

    // @With → synthesize withXxx() for each field
    if (annotations.includes('With')) {
      for (const field of fields) {
        const withName = 'with' + capitalize(field.name);
        synthetic.push(makeSyntheticMethod(className, withName, file, field.line, 'lombok:with', false));
      }
    }
  }

  return synthetic;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function capitalize(name: string): string {
  if (!name) return name;
  // Handle boolean fields: isActive → IsActive (getIsActive or isActive)
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function makeSyntheticMethod(
  className: string,
  methodName: string,
  file: string,
  line: number,
  role: string,
  isStatic: boolean,
): SymbolInfo {
  return {
    name: methodName,
    kind: 'method',
    file,
    line,
    column: 1,
    endLine: line,
    signature: `/* lombok-generated */ ${isStatic ? 'public static ' : 'public '}${className} ${methodName}()`,
    visibility: 'public',
    module: '',
    parent: className,
    isStatic: isStatic || undefined,
    frameworkRole: role,
    frameworkMeta: { synthetic: 'true', generator: 'lombok' },
  };
}

function makeSyntheticField(
  className: string,
  fieldName: string,
  fieldType: string,
  file: string,
  line: number,
  role: string,
): SymbolInfo {
  return {
    name: fieldName,
    kind: 'field',
    file,
    line,
    column: 1,
    endLine: line,
    signature: `/* lombok-generated */ private static final ${fieldType} ${fieldName}`,
    visibility: 'private',
    module: '',
    parent: className,
    isStatic: true,
    returnType: fieldType,
    frameworkRole: role,
    frameworkMeta: { synthetic: 'true', generator: 'lombok' },
  };
}
