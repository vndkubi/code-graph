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
- `super::baseHook`
- `gateway::processPayment`
- `PaymentGateway::audit`
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

Interpretation:

- The main remaining speed issue on large clean repos was not SQLite itself; it was git-freshness invalidation caused by `.codegraph*` artifact directories showing up as untracked repo dirt.
- Fixing that restored the intended warm-index fast path on a large Java-heavy target.
- Field usage facts add measurable but bounded cold-index cost on the larger Java repos tested, and the quality gain is large enough to justify default-on behavior.

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
  - This repo did close one important gap here: `.codegraph*` index artifacts are now ignored by git-freshness checks so they do not force false reindexing on clean repos.
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

- embedded repo detection
- gitignored nested repo handling
- worktree mismatch warning

Reason:

- These are correctness issues, not just ergonomics.
- They matter for monorepos, nested worktrees, and AI-driven multi-checkout workflows.

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

### 2. Improve index quality

Status:

- Improved for Java callback/method-reference cases.
- Java field usage facts now index by default, with explicit opt-out only for speed-sensitive cold runs.
- Added TS/JS and Python callback reference coverage for `this/self` registrations and inline callback bodies.
- Cache invalidation now preserves that improvement in real runs.
- Largest remaining quality gap versus external is generalized callback/function-as-value capture breadth across more positions and languages.

### 3. Compare with `codegraph-external` and improve where useful

Status:

- Comparison is complete enough to drive selective porting.
- The best ideas to port next are:
  - workspace boundary/worktree handling
  - snapshot-level extraction version visibility
  - broader function-reference capture for gated bare identifiers / extra languages
