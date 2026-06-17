# SQLite Index Research - 2026-06-16

## Scope

User goal:

1. Increase indexing speed and complete the move to SQLite.
2. Improve index quality.
3. Compare this repo with `D:\Personal\Projects\codegraph-external`, identify strengths, weaknesses, and practical next improvements.

This note is evidence-driven from the current worktree and local benchmark runs on 2026-06-16.

## System Mental Model

Current `code-graph` runtime is already fully SQLite-local:

- Per-repo database: `.codegraph/graph.sqlite`
- Direct MCP process, no daemon, no HTTP hop
- Index snapshots stored in SQLite with parse cache keyed by provider/version/blob hash
- Tree-sitter is the primary provider, optional SCIP provider can merge semantic facts

The core cold-index path is:

1. Manifest scan and blob hash diff
2. Parse-cache lookup by `(provider_id, provider_version, blob_hash)`
3. Parse changed files with worker threads
4. Bulk materialize facts into SQLite
5. Rebuild call/dependency/overlay structures
6. Refresh planner maintenance/statistics

Key current modules:

- [src/v2/index/indexer.ts](D:/Personal/Projects/code-graph/src/v2/index/indexer.ts)
- [src/v2/storage/sqlite-backend.ts](D:/Personal/Projects/code-graph/src/v2/storage/sqlite-backend.ts)
- [src/v2/index/providers.ts](D:/Personal/Projects/code-graph/src/v2/index/providers.ts)
- [src/analyzers/tree-sitter-analyzer.ts](D:/Personal/Projects/code-graph/src/analyzers/tree-sitter-analyzer.ts)

## Changes Made In This Turn

### 1. SQLite runtime maintenance tightened

Ported two low-risk SQLite behaviors that `codegraph-external` already uses:

- `busy_timeout = 5000`
- post-index lightweight maintenance:
  - `PRAGMA optimize`
  - `PRAGMA wal_checkpoint(PASSIVE)`

Implementation:

- [graph-backend.ts](D:/Personal/Projects/code-graph/src/v2/storage/graph-backend.ts)
- [sqlite-backend.ts](D:/Personal/Projects/code-graph/src/v2/storage/sqlite-backend.ts)
- [indexer.ts](D:/Personal/Projects/code-graph/src/v2/index/indexer.ts)

Behavior:

- Default path now uses lightweight maintenance after index.
- Full table-by-table `ANALYZE` is still available via `CODEGRAPH_FULL_ANALYZE=1`.

### 2. Parse cache invalidation fixed for callback extraction changes

The current worktree added better callback extraction across the tree-sitter analyzer:

- `this::method`
- `super::method`
- field receiver method references
- synthetic lambda callback edges
- TS/JS `this.method` callback references in argument position
- Python `self.method` callback references in argument position

Without a provider version bump, old parse-cache rows could silently hide the new extraction behavior. The tree-sitter provider version was bumped accordingly in:

- [providers.ts](D:/Personal/Projects/code-graph/src/v2/index/providers.ts)

### 3. Java callback/method-reference quality improved

Added/verified coverage for:

- `this::handlePayment`
- `this::inheritedHook`
- `super::baseHook`
- `gateway::processPayment`
- `PaymentGateway::audit`
- `OuterCallback.this::mapInfo`
- `() -> worker.runJob()`

Implementation/tests:

- [tree-sitter-analyzer.ts](D:/Personal/Projects/code-graph/src/analyzers/tree-sitter-analyzer.ts)
- [index-query.test.ts](D:/Personal/Projects/code-graph/tests/v2/index-query.test.ts)

### 4. TS/Python callback references now have direct coverage

Added/verified coverage for:

- TS/JS callback registration like `bus.on('click', this.handleClick)`
- TS/JS inline callbacks like `() => this.handleHover()`
- Python callback registration like `scheduler.on_done(self.handle_done)`
- Python inline callbacks like `lambda: self.handle_inline()`

This closes the high-confidence part of the cross-language callback gap without importing the full complexity of external's generalized function-value capture.

### 5. Java field usage facts are now on by default

The current worktree flips Java field usage extraction from opt-in to default-on, while preserving an explicit opt-out for colder large-repo runs:

- default behavior now records Java field read/write/init facts
- `CODEGRAPH_ENABLE_FIELD_USAGES=0` disables those facts when needed
- provider versions now separate default-on versus explicit opt-out snapshots so parse cache reuse stays correct

### 6. Manifest scanning now respects git visibility while keeping embedded repos

The current worktree also ports a scoped version of external's repository-boundary handling into manifest scan:

- ordinary `.gitignore`d source files are no longer indexed just because they exist on disk
- gitignored embedded repos are still scanned when they are real nested repos rather than ordinary ignored directories
- linked worktrees discovered as nested `.git` pointers are skipped rather than duplicated

This improves correctness for multi-repo workspaces without pulling in the full watcher/sync complexity from external.

### 7. Java inherited-field receiver resolution improved

The current worktree extends Java receiver-field resolution across:

- superclass fields declared in another file
- nested inner classes accessing outer-class fields
- outer classes whose own fields come from a superclass chain

This closes a real quality gap seen in Doughnut controller tests, where calls like
`currentUser.getUser()` were previously left as unresolved `name-only` edges when
`currentUser` came from `ControllerTestBase`.

### 8. Java unqualified method-owner resolution improved

The current worktree now resolves bare Java method calls and explicit `this.` / `super.`
method calls through:

- the current class
- superclass chains
- nested inner classes reaching outer-class methods
- outer classes whose method comes from a superclass chain

This closes a larger real-repo quality gap than the earlier field-receiver fix alone:
Java test and service code often calls helper methods as `helper()` rather than
`this.helper()`, and those calls were previously stored only as low-context `name-only`
edges.

### 9. Java named static imports now resolve to owner methods

The current worktree now resolves Java calls imported through named static imports:

- `import static com.example.Utility.parseXmlSecure;`
- `import static org.mockito.Mockito.eq;`
- `import static org.junit.jupiter.api.Assertions.assertEquals;`

Those calls now index as explicit owner-qualified edges such as `Utility.parseXmlSecure`,
`Mockito.eq`, and `Assertions.assertEquals` instead of falling back to bare unresolved names.

This matters in real Java test-heavy repos because static imports are extremely common for:

- assertions
- Mockito helpers
- Spring MockMvc helpers
- internal static utility methods

### 10. Java enhanced-for and catch receiver typing improved

The current worktree now extends Java receiver typing beyond method parameters and
plain local variables to also cover:

- `for (Map.Entry<K, V> entry : values.entrySet())`
- `for (String k : data.keySet())`
- `catch (IOException ex)`
- `catch (RuntimeException e)`

Those receivers now index as explicit `receiver-type` call edges rather than staying
as raw unresolved names such as `entry.getKey`, `entry.getValue`, `e.getMessage`,
or `ex.getMessage`.

### 11. Java chained field receivers now resolve across nested field types

The current worktree now resolves Java calls where the receiver itself is a field chain:

- `makeMe.entityPersister.flush()`
- `this.apiLock.writeLock()`
- `this.fsState.getRootFallbackLink()`

This is still a scoped static resolution. It follows:

- current-class fields
- inherited fields
- outer-class fields
- nested field types through their declared field return types

It does not attempt full data-flow or arbitrary method-return chaining.

### 12. Java method-return stream typing now spans records, Lombok getters, `var`, and sibling source roots

The current worktree now extends Java type inference for receiver calls that depend on
method-return types rather than only declared local/parameter types.

Covered cases now include:

- record accessors like `listing.folders()`
- Lombok-generated getters like `result.getUsers()`
- explicit methods returning collections like `RelationshipLiteralSearchHits.noteMatches(...)`
- `var view = controller.myNotebooks()` followed by typed field chains
- test code in `src/test/java` resolving same-package or imported DTO/controller types from `src/main/java`
- nested `@Nested`/inner test classes that read outer or inherited controller/service fields before chaining into method-return typing

To keep parse-cache reuse correct for these analyzer changes, the tree-sitter provider version was
bumped again and now uses the `v20` provider cache key.

## Benchmark Evidence

### A/B: lightweight maintenance vs full ANALYZE

Synthetic repo: `1500` generated Java files, `20` modules.

- Lightweight maintenance:
  - `filesTotal`: `1521`
  - `indexTimeMs`: `5856`
  - `peakRssMb`: `140`
- Full `ANALYZE` (`CODEGRAPH_FULL_ANALYZE=1`):
  - `filesTotal`: `1521`
  - `indexTimeMs`: `6350`
  - `peakRssMb`: `110`

Observed result:

- Lightweight maintenance was faster by `494 ms` on this workload.
- On small synthetic repos (`311` files), the difference was negligible and noisy.

Interpretation:

- The patch is justified for medium/large indexes.
- The effect is tail-latency reduction after bulk load, not parse-speed reduction.

### Actual repo note

Cold index numbers on the repo itself were noisy on this Windows workstation and varied much more than the synthetic A/B runs. I do not trust a single local cold-index number here as architecture evidence. The synthetic A/B comparison is the cleaner signal for the maintenance change.

### Real Java repo benchmarks

Representative repo/subtree runs on this workstation:

- `D:/Personal/Projects/doughnut/backend`
  - cold: `542` files, `9123 ms`
  - warm: `483 ms`
- `D:/Personal/Projects/hadoop/hadoop-common-project`
  - cold: `2335` files, `50903 ms`
  - warm: `1010 ms`
- `D:/Personal/Projects/elasticsearch/server`
  - before git-freshness fix:
    - warm run incorrectly created a new snapshot and took `103875 ms` even with `filesChanged = 0`
  - after git-freshness fix:
    - cold: `7979` files, `520250 ms`
    - warm: `1401 ms`
    - warm run reuses the same `snapshotId` and short-circuits correctly

Java field usage fact cost on real repos:

- `D:/Personal/Projects/doughnut/backend`
  - field usages off: `10495 ms`, `0` field usage facts
  - field usages on: `10631 ms`, `4026` field usage facts
- `D:/Personal/Projects/hadoop/hadoop-common-project`
  - field usages off: `59888 ms`, `0` field usage facts
  - field usages on: `68762 ms`, `59218` field usage facts
- `D:/Personal/Projects/elasticsearch/server`
  - field usages off: `520250 ms`, `0` field usage facts
  - field usages on: `565637 ms`, `197521` field usage facts

Java inherited-field receiver quality probe:

- `D:/Personal/Projects/doughnut/backend`
  - `CurrentUser.getUser` now has `311` resolved `receiver-field` callers
  - unresolved raw `currentUser.getUser` edges dropped to `3`
  - many recovered callers come from controller test classes inheriting `currentUser` from `ControllerTestBase`

Java unqualified method-owner resolution probes:

- `D:/Personal/Projects/doughnut/backend`
  - before this patch, there were `1747` primary unqualified Java `name-only` calls
  - after this patch, `1487` calls resolve as `enclosing-method` or `super-method`
  - remaining primary unqualified Java `name-only` calls dropped to `266`
  - top recovered callees include `NotebookBooksControllerTestBase.node`, `NotebookBooksControllerTestBase.myNotebook`, `JapaneseLemmaStemMasker.addSpec`, and `NotebookBooksControllerTestBase.bookOf`
- `D:/Personal/Projects/hadoop/hadoop-common-project`
  - `19275` calls now resolve as `enclosing-method` or `super-method`
  - `4035` primary unqualified Java `name-only` calls still remain
  - many recovered callees come from inherited test helpers such as `AbstractFSContractTestBase.getFileSystem`, `FileContextMainOperationsBaseTest.getTestRootPath`, and `Configured.getConf`

Java named static import resolution probes:

- `D:/Personal/Projects/doughnut/backend`
  - primary unqualified Java `name-only` calls dropped from `266` to `101`
  - `2694` Java call edges now resolve as explicit `static-import`
  - top recovered static-import callees include `MatcherAssert.assertThat`, `Matchers.equalTo`, `Assertions.assertThrows`, `MockMvcResultMatchers.status`, and internal helpers such as `EpubPackageIo.readEntryBytes`
- `D:/Personal/Projects/hadoop/hadoop-common-project`
  - primary unqualified Java `name-only` calls dropped from `4067` to `1298`
  - `15237` Java call edges now resolve as explicit `static-import`
  - top recovered static-import callees include `Assertions.assertEquals`, `Assertions.assertTrue`, `Mockito.when`, `Mockito.verify`, `LambdaTestUtils.intercept`, and `BindingUtils.loadStaticMethod`

Java enhanced-for and catch receiver typing probes:

- `D:/Personal/Projects/doughnut/backend`
  - total primary Java `name-only` calls dropped from `1095` to `742`
  - `5294` Java call edges now resolve as explicit `receiver-type`
  - `entry.getKey` fell from `12` unresolved edges to `2`
  - `entry.getValue` fell from `7` unresolved edges to `0`
  - former raw catch/message cases now surface as typed callees such as `Throwable.getMessage` and `Exception.getMessage`
- `D:/Personal/Projects/hadoop/hadoop-common-project`
  - total primary Java `name-only` calls dropped from `6590` to `4706`
  - `35210` Java call edges now resolve as explicit `receiver-type`
  - `e.getMessage` fell from `149` unresolved edges to `0`
  - `ex.getMessage` fell from `60` unresolved edges to `0`
  - `entry.getKey` fell from `84` unresolved edges to `3`
  - `entry.getValue` fell from `80` unresolved edges to `3`
  - recovered typed callees now include `Entry.getKey`, `Entry.getValue`, `IOException.getMessage`, `Throwable.getMessage`, and `Exception.getMessage`

Java chained field receiver probes:

- `D:/Personal/Projects/doughnut/backend`
  - total primary Java `name-only` calls dropped from `739` to `627`
  - `87` Java call edges now resolve as explicit `receiver-field-chain`
  - `makeMe.entityPersister.flush` fell from `41` unresolved edges to `0`
  - `makeMe.entityPersister.save` fell from `15` unresolved edges to `0`
  - `makeMe.entityPersister.merge` fell from `14` unresolved edges to `0`
  - `makeMe.entityPersister.flushAndClear` fell from `7` unresolved edges to `0`
  - top recovered callees include `EntityPersister.flush`, `EntityPersister.save`, `EntityPersister.merge`, `EntityPersister.flushAndClear`, `EntityPersister.find`, and `EntityPersister.refresh`
- `D:/Personal/Projects/hadoop/hadoop-common-project`
  - total primary Java `name-only` calls dropped from `4713` to `4322`
  - `93` Java call edges now resolve as explicit `receiver-field-chain`
  - `this.apiLock.writeLock` fell from `30` unresolved edges to `0`
  - `this.apiLock.readLock` fell from `12` unresolved edges to `0`
  - `this.fsState.getRootFallbackLink` fell from `16` unresolved edges to `0`
  - top recovered callees include `FileStatus.isDirectory`, `FileStatus.isSymlink`, `ReentrantReadWriteLock.writeLock`, `ReentrantReadWriteLock.readLock`, and `InodeTree.getRootFallbackLink`

Java qualified/inherited method-reference probe:

- `D:/Personal/Projects/doughnut/backend`
  - `EmbeddingService.this::combineNoteContent` previously stayed as unresolved raw callee `EmbeddingService.this.combineNoteContent`
  - after the patch it resolves to `EmbeddingService.combineNoteContent`
  - `get_callers('EmbeddingService.combineNoteContent')` now returns `EmbeddingService.streamEmbeddingsForNotes` with `resolution_kind: 'method-reference'`
  - targeted cold-index timing on the same repo stayed in the same range: `15.1s -> 16.6s`

Java typed-receiver field-chain probes:

- `D:/Personal/Projects/doughnut/backend`
  - total primary Java `name-only` calls dropped from `630` to `597`
  - `4` Java call edges now resolve as explicit `receiver-type-field` or `receiver-type-chain`
  - `view.catalogItems.stream` fell from `10` unresolved edges to `0`
- `D:/Personal/Projects/hadoop/hadoop-common-project`
  - total primary Java `name-only` calls dropped from `5117` to `4449`
  - `513` Java call edges now resolve as explicit `receiver-type-field` or `receiver-type-chain`
  - `item.stat.isDirectory` fell from `20` unresolved edges to `0`
  - `item.stat.isSymlink` fell from `3` unresolved edges to `0`

Java pattern-variable and cast-inferred lambda probes:

- `D:/Personal/Projects/doughnut/backend`
  - total primary Java `name-only` calls dropped again from `597` to `544`
  - `receiver-type-field` edges increased from `4` to `17`
  - `n.notebook.getId` fell from `5` unresolved edges to `0`
  - `s.notebook.getId` fell from `2` unresolved edges to `0`
  - recovered cases include:
    - `case NotebookCatalogNotebookItem n -> n.notebook.getId()`
    - `item instanceof NotebookCatalogSubscribedNotebookItem s && s.notebook.getId()...`
    - `.map(NotebookCatalogNotebookItem.class::cast).map(n -> n.notebook.getId())`

Java method-return / sibling-source-root / `var` stream probes:

- `D:/Personal/Projects/doughnut/backend`
  - total primary Java `name-only` calls dropped again from `544` to `501`
  - `receiver-type*` call edges increased from `5859` to `6296`
  - unresolved counts fell to `0` for:
    - `f.getId`
    - `u.getId`
    - `r.getNoteTopology`
    - `n.getEdgeType`
    - `view.catalogItems.stream`
  - recovered real-repo shapes now include:
    - `listing.folders().stream().anyMatch(f -> f.getId()...)`
    - `result.getUsers().stream().filter(u -> u.getId()...)`
    - `var notes = RelationshipLiteralSearchHits.noteMatches(result); notes.stream()...`
    - inner test classes calling `var view = controller.myNotebooks(); view.catalogItems.stream()`
- `D:/Personal/Projects/hadoop/hadoop-common-project`
  - total primary Java `name-only` calls stayed effectively flat: `4449` to `4448`
  - the remaining top unresolved set is still dominated by library/static/helper cases such as:
    - `System.out.println`
    - `getClass`
    - `exists`
    - `onChanged`
  - this is consistent with the patch scope: the change mainly targets project-local method-return typing rather than broad library or reflective dispatch recovery

Interpretation:

- The main remaining speed issue on large clean repos was not SQLite itself; it was git-freshness invalidation caused by `.codegraph*` artifact directories showing up as untracked repo dirt.
- Fixing that restored the intended warm-index fast path on a large Java-heavy target.
- Field usage facts add measurable but bounded cold-index cost on the larger Java repos tested, and the quality gain is large enough to justify default-on behavior.
- Manifest scan correctness now lines up better with git-visible project scope instead of raw filesystem scope.
- Java call quality also improved on a concrete real-repo inheritance pattern instead of only synthetic fixtures.
- Java call quality improved again for the much larger bucket of same-class, superclass, and outer-class helper method calls, with strong wins on both Doughnut and Hadoop.
- Java static-import resolution materially reduces unresolved helper calls and turns a large body of formerly low-context assertion/mock/util edges into explicit owner-qualified calls.
- Java receiver typing is now broader inside ordinary control-flow, which removes a large batch of unresolved loop and exception-handling calls on real Java repos.
- Java field-chain resolution closes another real test-helper gap, especially where builder/test harness objects expose service fields that are called repeatedly.
- Java method-reference resolution now also handles explicit outer-instance receivers like `OuterClass.this::method` and inherited `this::baseMethod` ownership.
- Java typed-receiver field-chain resolution closes a larger cross-file gap where the first receiver segment is a typed local/parameter and later segments are project fields.
- Java pattern variables and narrow class-cast lambda inference close another practical Java 17/test-heavy gap without attempting a broad generic stream-type solver.
- Java method-return typing now closes a further gap where the receiver type is only recoverable by following record/Lombok/ordinary accessor return types across `src/main` and `src/test`, including nested test classes that rely on inherited outer controller fields.

## Quality Evidence

Verified locally:

- `npm.cmd run lint`
- `npm.cmd run build`
- `npm.cmd test`

The callback/method-reference path now has direct tests for caller/callee behavior instead of relying on incidental coverage.
The git-freshness path now also has direct regression coverage for warm reindex with `.codegraph` artifacts present inside a git repo.

## Compare With `codegraph-external`

### Where current `code-graph` is stronger

- Simpler runtime: no daemon, no socket transport, no daemon registry, no telemetry path.
- Per-repo SQLite layout is already the default architecture.
- Stronger benchmark harness for agent workflows:
  - context proof
  - review proof
  - fallback benchmark
  - Codex/Copilot dry-run harnesses
- More explicit snapshot/provider-aware indexing model for MCP-oriented use:
  - snapshot stats
  - provider merge
  - workspace key support
  - direct MCP answer/change/review packets
- Java-specific indexed facts are richer in several important areas:
  - endpoints
  - beans
  - inheritance
  - field usages
  - graph overlay
  - unqualified method-owner resolution for current/super/outer Java method calls
  - named static-import method resolution for Java utility/assertion/helper calls
  - typed Java receiver resolution for parameters, locals, enhanced-for variables, and catch variables
  - nested Java field-chain receiver resolution across declared field types
  - field usage facts are now enabled by default instead of living behind an extra indexing flag

### Where `codegraph-external` is stronger

- Language coverage is much broader.
  - Current repo supports `12` languages/config formats in [language-detector.ts](D:/Personal/Projects/code-graph/src/analyzers/language-detector.ts).
  - External repo ships dedicated extractors for roughly `19` code languages plus framework/template extractors.
- Callback/function-as-value capture is still broader and more mature cross-language.
  - See [function-ref.ts](D:/Personal/Projects/codegraph-external/src/extraction/function-ref.ts).
  - It covers registration sites and function references across Java, Kotlin, TS/JS, Python, C#, PHP, Ruby, Swift, Go, Rust, Scala, Lua, Pascal, C/C++.
  - Current repo now covers Java method references/lambda callbacks plus high-confidence TS/JS `this.method` and Python `self.method` callback registrations.
- Workspace scoping is more defensive.
  - Embedded repo discovery
  - gitignored nested repo handling
  - worktree mismatch detection
  - watcher fallback policies
  - git hook sync fallback
  - This repo has now closed two important parts of that gap:
    - `.codegraph*` index artifacts are ignored by git-freshness checks so they do not force false reindexing on clean repos
    - manifest scan respects `.gitignore` while still discovering gitignored embedded repos
- SQLite operational hardening is more mature.
  - connection PRAGMAs
  - maintenance/checkpoint habits
  - extraction version stamping

### Where external is weaker for this repo's target direction

- It still carries daemon/session/telemetry complexity that this repo intentionally removed.
- It is architecturally broader, but also heavier to reason about and port wholesale.
- Its strengths should be mined selectively, not copied as-is.

## Recommended Priority Order

### P1: broaden callback/function-value capture beyond the new high-confidence cases

Port the next slice of external's function-as-value capture idea in a scoped way:

- TS/JS: bare callback args in known HOF positions when same-file/import-gated
- Python: bare callback args and keyword callback targets with the same kind of gate
- C#: delegate/event subscription cases
- Ruby/PHP only if there is real target demand

Reason:

- The `this/self` callback registration cases are now covered here.
- The remaining callback gap versus `codegraph-external` is mostly breadth: more value positions, more languages, and gated bare identifiers.
- It directly improves `get_callers`, `find_references`, impact analysis, and review packets.

### P1: keep SQLite maintenance lightweight by default

Keep the new default:

- `PRAGMA optimize`
- `wal_checkpoint(PASSIVE)`

Reason:

- Measured faster on the larger synthetic benchmark.
- Preserves an escape hatch with `CODEGRAPH_FULL_ANALYZE=1`.

### P2: add explicit extraction-version metadata at snapshot level

Provider-version-based cache invalidation works, but external has a separate extraction-version stamp for user-facing stale/reindex semantics.

Recommended addition:

- persist extraction engine/version in snapshot metadata
- expose it in doctor/status
- warn when snapshot semantics lag parser/resolver changes

Reason:

- Better operator visibility than provider-version-only internals.

### P2: improve workspace boundary handling

Port selected ideas from external:

- worktree mismatch warning
- watcher parity for embedded-repo scope changes

Reason:

- The manifest-side embedded repo / gitignored nested repo gap is now addressed here.
- The remaining boundary gaps are mostly around warnings/sync ergonomics rather than base indexing scope.

### P3: broaden language coverage only when justified

External has much broader extractor coverage, but porting many languages is expensive.

Suggested order if needed:

- Go
- Rust
- C/C++
- Ruby/PHP only after concrete usage demand

Reason:

- Current repo is strongest around JVM + MCP agent workflows.
- Coverage expansion should follow target repos, not abstract parity.

## What This Means For The Original Goal

### 1. Increase speed and finish SQLite migration

Status:

- SQLite migration is already architecturally complete in this repo.
- This turn improved SQLite operational behavior and parse-cache correctness.
- Measured speed improvement is proven in two places:
  - post-index maintenance tail on larger synthetic workloads
  - restored warm-index fast-path behavior on large real git repos by ignoring `.codegraph*` artifacts in git freshness checks
- Repository scope correctness also improved by aligning manifest scan with git-visible files instead of raw filesystem walk.

### 2. Improve index quality

Status:

- Improved for Java callback/method-reference cases.
- Java method-reference ownership now covers inherited `this::method` and explicit outer-instance `OuterClass.this::method`.
- Java field usage facts now index by default, with explicit opt-out only for speed-sensitive cold runs.
- Java inherited-field receiver calls now resolve across superclass and nested-class access patterns.
- Java unqualified helper-method calls now resolve across current classes, superclass chains, and nested outer-class access paths.
- Java named static-import calls now resolve to explicit owner methods instead of bare unresolved names.
- Java receiver-type calls now cover enhanced-for variables and catch variables in addition to parameters and plain locals.
- Java chained field receivers now resolve through nested field types instead of staying as raw dotted names.
- Java typed local/parameter receiver chains now resolve through project field types, with especially large wins on Hadoop-style `item.stat.*` access patterns.
- Java pattern variables and `.map(Type.class::cast)` lambda params now contribute receiver typing as well, which materially helps Doughnut's catalog/test code.
- Added TS/JS and Python callback reference coverage for `this/self` registrations and inline callback bodies.
- Cache invalidation now preserves that improvement in real runs.
- Largest remaining quality gap versus external is generalized callback/function-as-value capture breadth across more positions and languages.

### 3. Compare with `codegraph-external` and improve where useful

Status:

- Comparison is complete enough to drive selective porting.
- The best ideas to port next are:
  - snapshot-level extraction version visibility
  - broader function-reference capture for gated bare identifiers / extra languages
  - worktree mismatch warning / watcher parity for boundary handling

## 2026-06-17 Continuation: Java v20, Large-Repo Evidence, and External Recheck

### Changes made

1. Bumped the tree-sitter provider cache key from `v18` to `v20`.
   - `v19` covered assignment-position callback references.
   - `v20` also covers Java try-with-resources receiver typing.
   - This is required because parse cache is keyed by provider version and blob hash.

2. Reduced SQLite text-copy batch pressure for large `parse_cache` shards.
   - Before: `copyFromTextFiles()` flushed every 1000 rows for every table.
   - Problem: `parse_cache.parse_json` rows can be hundreds of KB on Java-heavy repos, so 1000-row batches can create very large SQL statements and parameter arrays.
   - Now: text-copy has per-table row and character limits, with `parse_cache` defaulting to smaller chunks.
   - Tunables:
     - `CODEGRAPH_SQLITE_TEXT_COPY_CHUNK_ROWS`
     - `CODEGRAPH_SQLITE_PARSE_CACHE_COPY_CHUNK_ROWS`
     - `CODEGRAPH_SQLITE_TEXT_COPY_CHUNK_CHARS`
     - `CODEGRAPH_SQLITE_PARSE_CACHE_COPY_CHUNK_CHARS`

3. Improved Java receiver typing for try-with-resources.
   - Tree-sitter Java parses `try (XContentBuilder b = ...)` as a `resource` node with direct `type`, `name`, and `value` fields.
   - The previous collector looked for `variable_declarator` children under `resource`, so resource variables were not bound.
   - This now resolves calls such as `b.field(...)` and `b.startObject(...)` when `b` is declared in a resource specification.

### Validation

- `npm.cmd test -- tests/v2/sqlite-backend.test.ts`: pass, 3 tests.
- `npm.cmd test -- tests/v2/index-query.test.ts -t "try-with-resources|callback references"`: pass, 2 targeted tests.
- `npm.cmd run build`: pass.

### Index benchmark evidence after v20

| Repo root | Files indexed | Cold index | Cold peak RSS | Warm index | Warm peak RSS | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `D:/Personal/Projects/doughnut/backend` | 542 | 11153 ms | 387 MB | 872 ms | 77 MB | v20 cold, no parse-cache hits |
| `D:/Personal/Projects/hadoop/hadoop-common-project` | 2335 | 78835 ms | 937 MB | 1264 ms | 93 MB | v20 cold, no parse-cache hits |
| `D:/Personal/Projects/elasticsearch/server` | 7979 | 1166508 ms | 2252 MB | 1952 ms | 113 MB | v20 cold, no parse-cache hits |

Interpretation:

- Warm index behavior is healthy on all three target repos. The warm path short-circuits in about 0.9s to 2.0s.
- The SQLite chunking change primarily reduces memory pressure. Hadoop cold peak RSS dropped from the prior v19 measurement of about 2166 MB to 937 MB. Doughnut dropped from about 603 MB to 387 MB. The large Elasticsearch cold run completed with 2252 MB peak instead of the earlier timed-out process observed at about 4108 MB RSS.
- Cold Elasticsearch indexing is still too slow at about 19.4 minutes. The remaining bottleneck is not warm-cache SQLite freshness; it is cold parse plus huge fact materialization for roughly 1.18M call edges and about 197k field usages.

### Java quality evidence after v20

| Repo root | Primary `name-only` calls | `receiver-type` edges | `static-import` edges | `lambda-callback` | `method-reference` |
| --- | ---: | ---: | ---: | ---: | ---: |
| `doughnut/backend` | 475 | 6637 | 2694 | 555 | 140 |
| `hadoop/hadoop-common-project` | 3972 | 37996 | 15237 | 1013 | 173 |
| `elasticsearch/server` | 93738 | 259691 | 68578 | 27290 | 9298 |

Try-with-resources effect:

- Elasticsearch now has `XContentBuilder.field`: 3050 `receiver-type` edges.
- Elasticsearch now has `XContentBuilder.startObject`: 1804 `receiver-type` edges.
- The remaining top unresolved `b.field` / `b.startObject` cases are mostly lambda parameters such as `mapping(b -> b.field(...))`, not resource declarations.

Remaining Java quality gaps seen in Elasticsearch:

- Lambda parameter type inference from local helper methods or functional interfaces, for example `mapping(b -> ...)`.
- External/inherited test helper methods, for example `internalCluster`, `prepareSearch`, `client`, `indicesAdmin`.
- External receiver field types, for example inherited/logging fields such as `logger.info`.
- Common JDK/static output calls such as `System.out.println` and `System.err.println`.

### External recheck

Fresh source inspection of `D:/Personal/Projects/codegraph-external` still shows these useful contrasts:

- `src/extraction/function-ref.ts` has a broad, table-driven function-as-value capture model across many languages. Current repo has now closed the high-confidence Java, TS/JS, and Python slices needed by the active target, but external remains broader.
- `src/extraction/extraction-version.ts` uses a separate `EXTRACTION_VERSION = 24` signal for stale-index user visibility. Current repo relies on provider-version cache keys and snapshot provider metadata, which is correct for cache invalidation but less user-facing.
- `src/sync/worktree.ts` has explicit worktree mismatch warnings for borrowed indexes. Current repo has stronger per-repo SQLite isolation but still should add warning UX for unusual nested worktree layouts.
- `src/db/sqlite-adapter.ts` uses Node built-in `node:sqlite` and exposes `iterate()` to avoid materializing large result sets. Current repo uses `better-sqlite3`; the useful lesson is not the adapter swap, but the memory discipline around large scans and batches.

### Updated priority order

1. P1: cold Elasticsearch speed.
   - Measure phase-level time on the v20 cold path.
   - Likely next candidates: reduce parse-cache JSON payload size, make parse cache optional/compact for very large repos, stream/copy facts with lower duplication, or split large snapshot materialization phases.

2. P1: Java lambda parameter type inference for local helper APIs.
   - Target real shapes like `mapping(b -> b.field(...))`.
   - Keep this gated to local method signatures or known functional interfaces to avoid false edges.

3. P2: snapshot-level extraction version visibility.
   - Add a user-facing extraction version separate from provider cache key.
   - Expose in `doctor` and stale snapshot warnings.

4. P2: worktree mismatch warnings.
   - Selectively port external's warning model without adding a daemon/session model.

5. P3: broader language/function-ref parity.
   - Useful, but secondary while the main target remains Java quality and large Java repo indexing speed.
