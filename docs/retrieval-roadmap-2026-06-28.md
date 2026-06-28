# Retrieval roadmap (2026-06-28)

Through-line from the right-sizing work: **retrieval quality is the bottleneck**,
and it cannot be improved safely without a multi-repo, broad-task measurement
loop. Everything below is ordered by that.

## Shipped in this pass

- **Eval harness (`benchmark recall`).** Broad multi-file tasks (answer = a
  union of files across modules) measured with right-sizing ON vs the no-trim
  baseline: `allFound`, `avgRecall`, and `recall@N` (the ranking ceiling,
  independent of trimming). Point `--root`/`--tasks` at any repo.
  See [`recall-bench.ts`](../src/v2/benchmark/recall-bench.ts) and
  [`recall-bench-tasks.example.json`](../examples/recall-bench-tasks.example.json).
  Current: internal 2/3 (recall 0.83), external 4/5 (recall 0.93) — right-sizing
  matches the no-trim baseline on both.
- **Index-logic staleness guard.** `DERIVATION_LOGIC_VERSION` in
  [`providers.ts`](../src/v2/index/providers.ts) folds non-provider derivation
  logic (file-role classification etc.) into the provider-version identity, so a
  change forces a full re-derive instead of incremental refresh silently serving
  stale path-derived metadata. This closes the class of bug hit during the
  right-sizing work (a file-role fix that never reached unchanged files). Bump
  the constant whenever that derivation logic changes.

## Shipped in a follow-up pass (test-impact + eval)

- **Test-impact selection (`affected-tests` + `benchmark affected-tests`).**
  Given changed files, walk the reverse local-import graph to the tests that
  depend on them, so CI runs a targeted subset. Graph-native and precise (a test
  is affected only if an actual import path reaches a changed file). Eval: every
  directly-coupled test recovered (recall 1.0) while cutting the suite ~76–79%
  (internal 41 tests → ~8.7 selected; external 86 → ~21.4). See
  [`affected-tests.ts`](../src/v2/query/affected-tests.ts) and
  [`affected-tests-eval.ts`](../src/v2/benchmark/affected-tests-eval.ts).
  Next: augment reverse-import reachability with reverse call-graph edges, and
  expose as an MCP tool (currently CLI + eval).

## Deferred — ordered

### 0. Semantic embedding channel (the "A" bet — designed, not shipped)
The remaining ranking residuals (`tree-sitter.ts` for "parsed/extracted") are
**semantic** misses that neither lexical BM25 nor the graph closes. A local
embedding model + ANN index as a third retrieval channel (fused via RRF) is the
fix. NOT shipped this pass on purpose: it needs a model runtime + vector index,
which is a real departure from the current deterministic, no-daemon, no-extra-
dependency design — it deserves its own design pass (model choice, on-disk ANN
format, determinism/caching, cold-index cost) rather than a half-build. This is
the top "A" item; treat it as the next major effort alongside fusion.

### 1. Cross-channel fusion (the biggest remaining quality lever)
The two residual misses (`tree-sitter.ts` for an indexing task; `text-util.ts`
for a ranking/tokenizer task) sit at the no-trim ceiling — single-channel BM25
buries them. A prototype graph-neighbor fill (outgoing imports of the top hits)
was built and **reverted**: it picked high-fan-out utility neighbors by import
frequency, not query relevance, and could not see symbol-level relevance, so it
was benchmark-inert. The real design needs:
- reciprocal-rank fusion across file / symbol / graph-neighbor channels;
- neighbor ranking by **query relevance** (incl. the neighbor's symbols), not
  import frequency;
- handling barrel-file crowding (a bare `index.ts` matching the stem `index`
  should not occupy slots a specific implementation needs);
- stem-aware **symbol** ranking (mirror the file-search stemming) so a query
  token surfaces a symbol named with another inflection
  (`tokenizer` -> `tokenizeSearchQuery`).
Gate every step on `benchmark recall` (must beat, not just match, the no-trim
baseline) plus the four proofs.

### 2. Deepen graph-native queries (the moat vs embedding-RAG)
Lean into what only a real call/dependency graph answers precisely:
blast-radius of a change, "what breaks if I change X", dataflow/taint,
dead-code, cross-service call tracing. Build on the existing
`get_impact_radius` / `trace_dependencies`.

### 3. Per-repo feedback loop (long-term moat)
Instrument which delivered evidence the agent actually used (follow-up calls in
the same `sessionId`) and learn per-repo ranking weights + keepRatio. A static
competitor index cannot do this; a local always-on server can. Needs the eval
harness (now shipped) as its safety net.

## Guardrails
Every retrieval change is gated on `benchmark recall` (broad-task recall) +
`evidence-audit` (waste down, gap not up) + the four proofs (context, golden,
review, route-gate) + the full unit suite.
