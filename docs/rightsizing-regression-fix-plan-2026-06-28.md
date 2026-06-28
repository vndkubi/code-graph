# Right-sizing regression fix — implementation plan (2026-06-28)

Follow-up to [`right-sizing-plan-2026-06-28.md`](right-sizing-plan-2026-06-28.md).
Phase A shipped (commit `e7bd79e`, keepRatio=0.8 default ON) and the
internal/external comparison exposed a **quality regression**: right-sizing
turns ranking errors into recall failures.

## Verified evidence (this drives the plan)

Query P1 — *"How does the indexing pipeline work? … file scan to final SQLite
snapshot."* on this repo, `get_context_packet maxFiles=6`:

| | candidateFiles |
| --- | --- |
| `rightSize=false` | sqlite-backend.ts, service.ts, context-proof.ts, **indexer.ts**, package.json |
| `rightSize=true` (0.8) | sqlite-backend.ts **only** — 5 → 1 |

Three facts that change the design:

1. **Outlier-top pathology.** Scores are `sqlite-backend=271` then a cluster
   `…=135 (indexer)`. Cutoff `271 × 0.8 = 217` kills *everything below rank 1*,
   including the genuine cluster. One spurious high scorer nukes the answer set.
2. **Cross-signal protection does NOT save it here.** `indexer.ts` is absent
   from the independent `relevantSymbols` channel (which returned graph/export,
   overlay, manifest). Both channels bury it for the same query, so "keep a file
   that's also a symbol hit" recovers nothing in this case. (It *would* help P2
   `proxy.ts`, which the symbol channel does carry — so the idea is real but
   not a universal safety net. Demoted to Phase 3.)
3. **Root cause is ranking, not the threshold.** `indexer.ts` (basename
   `indexer`) never matches the query token `indexing`/`index`, so it misses the
   exact-basename / compound boosts in `scoreFileSearch` and loses to the
   verbose `sqlite-backend.ts` on raw body term-frequency. Same class of defect
   as the camelCase bug fixed in
   [`ranking-quality-improvement-2026-06-27.md`](ranking-quality-improvement-2026-06-27.md),
   but for morphology (stem) instead of case.

## Outcome (implemented 2026-06-28)

All of Phase 1, 2a, 2c landed; the default keepRatio dropped 0.8 → 0.5 with a
`minKeep=3` floor. Measured before/after on a broad multi-file suite (3 internal
+ 5 external tasks, `rightSize` ON — the shipped config):

| Suite | BEFORE (e7bd79e) | AFTER | no-trim baseline (after) |
| --- | --- | --- | --- |
| INTERNAL allFound | 1/3 (recall 0.61) | **2/3 (recall 0.83)** | 2/3 (0.83) |
| EXTERNAL allFound | 2/5 (recall 0.70) | **4/5 (recall 0.93)** | 4/5 (0.93) |

Right-sizing ON now matches the no-trim baseline on BOTH repos — fully
quality-neutral while still saving tokens — versus the earlier config which was
a net quality loss. Four proofs held (context 3/3 87.5%, golden 4/4 98%, review
1/1 92.2%, route-gate 5/5); full unit suite 228/228; lint clean.

What each fix did:
- **2a stem-aware ranking** (`indexer` ↔ `indexing`): internal P1 `indexer.ts`
  135 → 350 (rank #4 → #1); external `extraction/index.ts` to #1.
- **2a-precision** (`call` must NOT match `callback`): the prefix branch of
  `wordsShareStem` now requires an inflectional remainder. Removed a false boost
  that inflated `callback-synthesizer.ts` 268 → 133, lifting the real
  `mcp/engine.ts` from rank #5 to #3 so the `minKeep=3` floor keeps it
  (external MCP task 0.67 → 1.0).
- **1 outlier guard**: external "ranking" query keeps the real `query-utils.ts`
  despite a spurious 288-point test-file top.
- **2c `__tests__/` role fix + stem-aware fallback coverage**: stopped
  `full-pipeline.test.ts` surfacing as the top "indexing pipeline" candidate.
- **keepRatio 0.5 + minKeep 3**: stopped broad multi-file answer sets being
  trimmed to one file.

Residual (these now equal the no-trim ceiling, i.e. NOT trimming-related):
internal `text-util.ts` (not in raw top-6 for the "tokenizer" task) and external
`extraction/tree-sitter.ts` (one of three indexing-pipeline files) — pure
ranking-depth gaps, the Phase 3 cross-channel-fusion target.

## Thesis

The audit oracle already says most tasks need **minFiles = 1–2** — so trimming
*hard* is the right amount. The bug is **selection**: we trim by one fragile
signal (BM25 file-top) and keep the wrong file. Fix selection (ranking +
trim-gating), not amount.

Cost is asymmetric and the current default ignores it:

| Error | Real cost |
| --- | --- |
| Waste (1 extra file) | ~200 tokens, agent skims past |
| Gap (drop the needed file) | ~3 000 tokens — agent must re-query/re-read a whole turn |

→ The bar to trim must be high; bias toward recall.

## Success criteria (all measured, no live agent)

A change ships only if, vs the pre-change baseline:

1. `evidence-audit` gap% = 0 **and** tokenWaste% still materially down (keep the
   Phase A win, lose the regression).
2. The three comparison queries on this repo — P1 indexing, P2 MCP routing,
   P3 symbol ranking — are **all correct with `rightSize` ON**.
3. Context proof ≥ 3/3, golden 4/4, review 1/1, route-gate 5/5
   (`qualityMaintained: true`); full unit suite green; lint clean.
4. A regression test locks each specific case fixed.
5. `quality-trend` row recorded before/after.

## Phase 0 — Make the regression a RED test (do first, cheap)

Right now the regression is a manual observation. Turn it into a gate.

- **0a.** Add P1/P2/P3 (internal) + 2 external tasks (`extraction/index.ts`
  for "pipeline", `search/query-utils.ts` for "ranking") as fixtures to the
  context-proof suite (or a new `comparison` suite), each run with
  `rightSize:true`. P1 and the external pair should be RED now.
- **0b.** Fix the audit/shipped mismatch: `evidence-audit` defaults
  `keepRatio=0.5` (`src/v2/benchmark/evidence-audit.ts`) while the shipped
  packet default is `0.8`. Make the audit measure the **shipped** config
  (`rightSize:true`, shipped keepRatio) so Waste/Gap reflect reality.

## Phase 1 — Trim-gating safety net (stops the regression; low risk)

Directly prevent the 5→1 collapse in `rightSizeCandidates`
(`src/v2/query/ranking.ts`). Replace the fixed `topScore × keepRatio` cut with
outlier- and cliff-aware gating:

- **Outlier guard.** If the top score is an outlier vs the cluster
  (`score[0] / score[1]` above ~1.4, or `score[0] > k × median`), anchor the
  cutoff to `score[1]` (the cluster head), not `score[0]`. One spurious top
  scorer can no longer define the threshold.
- **Cliff-only trimming.** Trim at the largest *relative* gap below `minKeep`.
  If the sorted scores are smooth (no gap exceeding a min drop), keep all — a
  smooth distribution means no clear relevant/irrelevant separation, so trimming
  is unsafe.
- **Recall floor.** Raise `minKeep` for context packets (e.g. 3) so trimming can
  shrink the tail but never collapse the candidate set to a single file.
- Calibrate the constants by sweeping `evidence-audit`; ship the most aggressive
  config with **gap% = 0**. Keep the `rightSize` flag for A/B + rollback.

Expected: P1 keeps the `indexer.ts` cluster; clean-cliff queries still trim.
Token win is smaller than 0.8-unconditional but gap returns to 0.

## Phase 2 — Ranking root cause (the real fix; medium)

Make implementation files rank where they belong so trimming is safe *and*
effective. All in `scoreFileSearch` / `getContextPacket`
(`src/v2/query/service.ts`); one regression test per sub-fix.

- **2a. Stem/morphology match.** `indexer` ↔ `indexing` ↔ `index` must match for
  the exact-basename and compound boosts (light suffix strip, or prefix match
  on basename/symbol words). Mirrors the existing `splitIdentifierWords` camel
  fix. This is the direct cause of `indexer.ts` losing its boost.
- **2b. Centrality boost.** For architecture/how-does-X queries, give a modest
  boost to call-graph hubs (high outgoing fan-out / entry points). The
  orchestrator (`indexer.ts`) is a hub; CodeGraph already has the call graph.
- **2c. External test-file dominance.** A `test_source` path-token match must
  not outrank a `main_source` file that covers the same concept. Verify the
  fixture/test fallback tier only fires when **no** main-source candidate covers
  the query (the spec says so, but external P1 returns a test file at rank 1
  with `rightSize` OFF — confirm whether `includeTests:false` is bypassed via
  the fallback path or a file-role misclassification).

Validate each sub-fix independently (audit + four proofs) before stacking.

## Phase 3 — Cross-channel fusion (deeper; larger, later)

Make the channels reinforce each other instead of being concatenated.

- Reciprocal-rank fusion of file-search + symbol-search + graph-neighbor
  channels: a file weakly present in several channels beats one strong-but-
  spurious channel. This is the *proper* home for "cross-signal recall
  protection" — verified to only help when a channel actually carries the file,
  so make that systematic rather than incidental.
- 1-hop call-graph expansion: protect the top symbol's call neighbors as
  candidates.

## Sequencing & guardrails

1. **0** make it RED + fix audit/shipped mismatch.
2. **1** trim-gating → gap back to 0 (regression gone).
3. **2a → 2b → 2c** ranking → P1/P2/P3 + external correct, then re-tighten the
   trim config (Phase 1 constants) now that ranking is trustworthy.
4. Re-run `evidence-audit` + four proofs; record `quality-trend`.
5. **3** fusion — separate, larger effort.

Guardrails: every step gated on `evidence-audit` (gap not↑, waste↓) + the four
proofs + the new regression tests. Right-sizing stays flag-controlled and never
grows beyond the existing `maxFiles` cap. Nothing is "done" until the numbers
move in the intended direction with no proof regression.
