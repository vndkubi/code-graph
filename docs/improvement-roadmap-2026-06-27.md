# CodeGraph improvement roadmap — implementation plan (2026-06-27)

Sequenced so each phase unblocks the next. Each item: current state (with file
refs), approach, files to change, tests, how to measure, effort, risk.

Effort scale: S = <0.5d, M = 0.5–2d, L = 2–5d, XL = 1–2w.

## Execution order (dependency-aware)

1. P1 — Fix freshness bug (#6)            [S] correctness, unblocks trust
2. P2 — Extract helpers from service.ts (#7a) [M] unblocks deep work, low risk
3. P3 — BM25 + graph-centrality ranking (#3)  [M] measurable ROI now
4. P4 — Extend evidence ledger (#4)        [S] builds on shipped feature
5. P5 — Claude-accurate token estimator (#5) [S] makes metrics honest
6. P6 — TS/Python resolver provider (#1)   [L] accuracy step change
7. P7 — Interface-impl edge confidence (#2) [M] fewer false positives
8. P8 — Pack-builder module split (#7b)    [L] finishes the refactor
9. P9 — calculation_sensitive data-flow (#8) [L] differentiator
10. P10 — Continuous retrieval telemetry (#9) [M] regression guardrail

---

## P1 — Fix the stale-index detection bug (#6) [S]

**Current state.** `indexFreshness` is attached to a response only when
`isStale === true` (service.ts:142). Two tests are red:
`index-query.test.ts:4888` and `workspace-readiness.test.ts:2949`, both asserting
`isStale === true` after a `git checkout` to a branch with different code.
`isStale = fileDirty || gitDirty` (service.ts:342); `gitDirty` compares
`getGitFreshnessInfo(root).headCommit/dirtyHash` against the snapshot's stored
values (service.ts:319-322). The tests gate on `hasGit()`, so git is available —
meaning `gitDirty` is computing `false` when it should be `true`.

**Approach.**
1. Repro with a probe: print `git.available`, `git.headCommit`,
   `row.head_commit`, `git.dirtyHash`, `row.dirty_hash` inside the failing test
   path on Windows.
2. Likely root cause: `getGitFreshnessInfo` ([git.ts](src/v2/git.ts)) returns an
   empty/cached HEAD on Windows (path quoting, `\r\n` trimming, or wrong cwd), so
   `headCommit === row.head_commit` accidentally holds. Fix the git invocation
   (trim CRLF, use absolute `-C <root>`, handle exit codes).
3. If git read is fine, the bug is that the snapshot's `head_commit` was written
   as the post-checkout commit — check the indexer's snapshot write.

**Files.** `src/v2/git.ts`, possibly `src/v2/index/indexer.ts`.
**Tests.** The two existing tests must go green; add a unit test for
`getGitFreshnessInfo` CRLF/exit-code handling.
**Measure.** Full suite 199/199 (currently 197/199).
**Risk.** Low. **Effort.** S.

## P2 — Extract pure helpers out of service.ts (#7a) [M]

**Current state.** `service.ts` is ~10.8k lines: one `V2QueryService` class plus
many module-level pure functions (`scoreFileSearch`, `scoreSymbolSearch`,
`splitIdentifierWords`, `tokenizeSearchQuery`, `slimEvidenceSlicesForPack`,
`evidenceHandlesForObjects`, the stop-word sets, etc.). The class methods are the
hard part to move; the free functions are not.

**Approach (low-risk first).** Move the pure, `this`-free functions into focused
modules, re-exported so call sites are unchanged:
- `query/ranking.ts` — scoring, tokenization, `splitIdentifierWords`, stop-word
  sets, `roleRank` re-export.
- `query/evidence.ts` — `slimEvidenceSlicesForPack`, `evidenceHandlesForObjects`,
  compaction helpers.
- `query/packing.ts` — `compactFileCandidate`, `compactSymbolCandidate`,
  budget/format helpers.
Keep `V2QueryService` in place; it imports from the new modules. No behavior
change — this is mechanical.

**Files.** New `src/v2/query/ranking.ts`, `evidence.ts`, `packing.ts`; edit
`service.ts` to import.
**Tests.** Existing suite is the safety net (no behavior change). Move
`research-ranking.test.ts` assertions if imports change.
**Measure.** `service.ts` LOC drops materially (target <7k); all benchmarks +
suite unchanged.
**Risk.** Low–medium (large mechanical diff). **Effort.** M.

## P3 — BM25 + graph-centrality ranking (#3) [M]

**Current state.** `scoreFileSearch`/`scoreSymbolSearch` re-score candidates
lexically and discard FTS5's `rank`. Candidate rows come from
`fileSearchCandidateRows` (FTS MATCH) but the BM25 score is unused. No call-graph
centrality signal.

**Approach.**
1. Select `bm25(codegraph_search_fts)` as `fts_rank` in the candidate query and
   thread it into `scoreFileSearch` as a normalized term (lower = better →
   invert, scale into the existing additive scale).
2. Add a cheap centrality signal: precompute per-file in/out `call_edges` degree
   (one grouped query, cached per snapshot) and add `min(log1p(degree), cap)` so
   hub files rank up. Tables already exist (`call_edges`, indexed by file).
3. Re-tune weights against the competitive suite; keep the camelCase/compound
   boosts.

**Files.** `service.ts` (ranking + candidate SQL), `query/ranking.ts` if P2 done.
**Tests.** Extend `research-ranking.test.ts` (hub file outranks leaf on tie);
add a BM25 length-normalization case (big file with sparse matches loses).
**Measure.** Competitive suite (`benchmark competitive-compare`) + context proof
must hold 3/3 and ideally improve token-saving / first-hit rank. Add a ranking
micro-eval reporting MRR before/after.
**Risk.** Medium (ranking regressions) — gate on the suite. **Effort.** M.

## P4 — Extend the evidence ledger beyond slice text (#4) [S]

**Current state.** Ledger ([service.ts] `dedupePackEvidenceSlices`) dedups only
`evidenceSlices.text`. `architectureContext`, `flowSteps`, `compressedEvidence`
also repeat across calls in a session.

**Approach.** Generalize the ledger to key any large repeated payload object by a
stable id (file/symbol/range), and stub repeats with `reusedFromEarlierCall` the
same way. Keep it sessionId-gated and `freshEvidence`-overridable. Add per-field
reuse counts to `completeness`.

**Files.** `service.ts` (ledger method + the research/flow/change payload
assembly).
**Tests.** Extend `evidence-ledger.test.ts`: architectureContext deduped on
repeat; still self-contained without sessionId.
**Measure.** Re-run the 3-pack sequence probe; target >5% total-token saving.
**Risk.** Low (same opt-in pattern). **Effort.** S.

## P5 — Claude-accurate token estimator (#5) [S]

**Current state.** `estimateTextTokens` uses `cl100k_base` (OpenAI) —
[token-estimator.ts](src/v2/token-estimator.ts). On Claude the count is off, so
budgets and saving %s are systematically biased.

**Approach.** Add a model-aware estimator: keep cl100k for determinism in
self-repo proofs, but add a Claude calibration factor (or the Anthropic token
counter if a dependency is acceptable) selectable via env/arg. Surface which
estimator was used in `_codegraph_meta`.

**Files.** `token-estimator.ts`, callers that report savings.
**Tests.** Unit test the calibration factor and selection.
**Measure.** Benchmark token numbers documented as Claude-calibrated.
**Risk.** Low. **Effort.** S.

## P6 — TS/Python resolver provider (#1) [L]

**Current state.** Call-edge resolution is heuristic and Java-centric
(`resolveCallEdges`, indexer.ts:3126: field types + inheritance + method owners).
TS/Python edges stay mostly `name-only`. A SCIP provider exists but is opt-in
(`providers.ts`, `ScipIndexProvider`) so real runs use tree-sitter only.

**Approach.**
1. Add `TsCompilerProvider implements IndexProvider` using the TypeScript
   compiler API for exact symbol/type/import resolution; run it for TS/TSX by
   default, tree-sitter as fast fallback.
2. Emit real `resolution_kind`/`confidence` from the resolver instead of
   heuristic constants.
3. Python: wire pyright/jedi or a SCIP-python step behind the same interface.

**Files.** `src/v2/index/providers.ts`, new `providers/ts-compiler.ts`,
`indexer.ts` (consume resolved edges), schema unchanged (`call_edges` already has
`resolution_kind`/`confidence`).
**Tests.** New fixtures: cross-file TS call resolved exactly; method override /
interface call resolved; compare edge precision vs tree-sitter baseline.
**Measure.** Call-edge precision on TS/Python fixtures (resolved vs name-only %);
`agent-eval` on a real TS repo before/after.
**Risk.** High (perf, new heavy dep, build time) — make it incremental + cached.
**Effort.** L.

## P7 — Interface-implementation edge confidence (#2) [M]

**Current state.** indexer.ts:3230 adds an edge for *every* implementation of an
interface at a fixed `0.65`. In repos with many implementors this floods the
graph with low-value edges.

**Approach.** Weight/prune by DI evidence: prefer implementations bound in
`beans`/DI config; down-rank or cap fan-out when many implementors exist; expose
`signal_reasons` so packs can explain. Optionally gate behind
`includeLowSignal`.

**Files.** `indexer.ts` (edge generation), pack ranking that reads these edges.
**Tests.** Fixture with 1 DI-bound impl + 3 others → bound impl ranks first;
fan-out cap respected.
**Measure.** Flow-pack precision on an interface-heavy fixture; edge count delta.
**Risk.** Medium (could drop a real edge) — keep edges, adjust confidence/order.
**Effort.** M.

## P8 — Pack-builder module split (#7b) [L]

**Current state.** After P2, `V2QueryService` still holds the big pack methods
(`getResearchPack`, `getChangePack`, `getContextPacket`, `reviewPatch`).

**Approach.** Extract each pack builder into its own module taking a small
`PackContext` ({ db, snapshotId, ledger, helpers }) instead of `this`. `query()`
becomes a thin router. Do one pack at a time, suite green between each.

**Files.** New `query/packs/research.ts`, `change.ts`, `context.ts`, `review.ts`;
slim `service.ts`.
**Tests.** Full suite per extraction.
**Measure.** `service.ts` <2k lines; no behavior change.
**Risk.** Medium–high (shared state: caches, ledger). **Effort.** L.

## P9 — Lightweight data-flow for calculation_sensitive (#8) [L]

**Current state.** `riskMode: 'calculation_sensitive'` is accepted but underused;
no value/data-flow tracking. Tables capture `field_usages`, `call_edges`.

**Approach.** For flagged symbols, build a bounded backward slice: variable →
assignments/sources → call sinks, using `field_usages` + `call_edges`, depth-
capped. Surface as `dataFlow` in the pack with confidence. Not full taint — a
shallow, explainable chain for financial/aggregation logic.

**Files.** new `query/dataflow.ts`, indexer emit if extra facts needed, pack
assembly.
**Tests.** Fixture: amount → discount → total chain surfaced; depth cap honored.
**Measure.** New eval task class in the suite; correctness on calc fixtures.
**Risk.** High (scope creep) — keep shallow + capped. **Effort.** L.

## P10 — Continuous retrieval-quality telemetry (#9) [M]

**Current state.** `benchmark` harnesses + `agent-eval`/`competitive-compare`
exist but are run ad hoc.

**Approach.** A `benchmark quality-trend` command that runs the deterministic
proofs + a small real-repo eval and appends a dated row (correct%, MRR, token
saving, p95) to a tracked report, so ranking/resolver regressions show up
immediately. Optionally a CI job.

**Files.** new `src/v2/benchmark/quality-trend.ts`, `cli.ts` wiring, a report md.
**Tests.** Smoke test the runner on the self repo.
**Measure.** The trend file itself.
**Risk.** Low. **Effort.** M.

---

## Notes

- P1 → P2 → P3 is the highest-value early sequence (fix correctness, open the
  codebase, then a measurable ranking win).
- P6 (TS resolver) is the biggest accuracy lever but also the riskiest/heaviest;
  do it after the refactor (P2) so it lands in a clean module.
- Every ranking/resolver change must gate on the competitive + context/flow/
  review proofs to prevent silent regressions.
