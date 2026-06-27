# Research-Pack Ranking Quality Fix — Before/After Report (2026-06-27)

## Goal

Make CodeGraph **more correct** on the tasks agents actually run — investigate
code, trace code, debug, trace an issue, implement code + unit tests, code
review — and prove it with a measurable before/after, while keeping token usage
low.

## TL;DR

| Harness | Quality BEFORE | Quality AFTER | Input-token saving (after) |
| --- | --- | --- | ---: |
| Context proof (`benchmark proof`) | **1 / 3 correct** (`qualityMaintained: false`) | **3 / 3 correct** (`qualityMaintained: true`) | 86.1% |
| Golden eval (`benchmark eval`) | 4 / 4 | 4 / 4 | 97.8% |
| Review proof (`benchmark review`) | 1 / 1 | 1 / 1 | 90.6% |
| Local fallback (`benchmark fallback`) | 3 / 3 | 3 / 3 | — |
| Route gate (`benchmark route-gate`) | 5 / 5 | 5 / 5 | — |

**The headline: the research/context packet went from silently wrong on 2 of 3
tasks to correct on all 3 — with token savings unchanged (≈86%).** No other
harness regressed.

---

## The defect (root cause)

The context proof is the harness closest to the "investigate code" agent task:
"find the X implementation". Baseline (raw grep + file reads) was 3/3; the MCP
packet was only **1/3**, i.e. CodeGraph confidently returned the wrong evidence
while looking efficient.

Reproduced directly. For the task *"Find the payment service implementation and
tests for refund behavior"* the packet's top files were:

```
src/v2/query/service.ts              <- 10.8k-line file; only MENTIONS "payment"/"refund" in benchmark strings
examples/context-proof-tasks.example.json
examples/copilot-e2e-quality-suite.example.json
src/v2/mcp/tools.ts
...
```

`PaymentService.java` — a class whose name *is* the query — never made the
top-6. Three compounding bugs in `scoreFileSearch` / `getContextPacket`:

1. **No camelCase split on filenames.** The query tokenizer splits
   `PaymentService` → `["payment","service"]`, but the file ranker split the
   basename only on `._-`. `PaymentService` stayed one opaque token and matched
   neither "payment" nor "service". Meanwhile a file literally named
   `service.ts` collected the **+90 exact-basename + +45 part** boosts for the
   broad token "service" and won.
2. **Basename was lowercased before splitting.** Even after adding a camel
   splitter, `pathLower` had already collapsed `OrderService` → `orderservice`,
   so PascalCase Java files *still* couldn't split — while separator-cased
   siblings (`order-service.ts`) split for free. Java lost every head-to-head.
3. **Hard fixture exclusion with no fallback.** `getContextPacket` searches
   main-source only. In a repo where the only matching code is a test fixture
   (or where main-source matches are all generic noise), the packet returned
   the noise instead of the real match.

## The fix

All in `src/v2/query/service.ts`:

1. **`splitIdentifierWords()`** — one splitter that honors both camel/Pascal-case
   boundaries *and* separators, applied to filenames and symbol names alike.
2. **Original-case basename** (`basenameOriginalNoExt`) for word splitting, so
   `OrderService` actually splits.
3. **Broad-term gating + compound boosts.** Exact-basename / per-part boosts now
   fire only for *specific* (non-broad) tokens, so a bare `service.ts` no longer
   hijacks the result. A new **compound boost (+110)** rewards a basename whose
   words cover ≥2 query words (e.g. `PaymentService` covering "payment"+"service"),
   and a **symbol-name compound boost (+80)** rewards files that *define* such a
   symbol even when the filename differs.
4. **Fixture/test fallback tier.** If no primary candidate covers a specific
   query word, re-run the search including tests+fixtures and keep only the
   candidates that genuinely cover one — and drop the non-covering primary noise
   so the real matches take the top slots. Role boosts (main_source 100 vs
   mock_source 45) + tie-breaks keep real implementation on top whenever it
   exists, so this only adds signal, never displaces real code.

## Before/after detail — context proof

| Task | BEFORE | AFTER |
| --- | --- | --- |
| `payment-service-context` | ❌ missing `PaymentService.java` | ✅ |
| `order-create-context` | ❌ missing `OrderService.java` | ✅ |
| `gateway-call-context` | ✅ | ✅ |

`mcpCorrect 1 → 3`, `qualityMaintained false → true`,
`inputTokenSavingPct 0.849 → 0.861`.

## How this maps to the agent task types

- **Investigate code / "where is X"** — directly fixed: the research packet now
  surfaces the canonical implementation file instead of length-inflated noise.
- **Trace code / trace issue** — flow/call tracing (`gateway-call`,
  `route-gate 5/5`) unaffected and still correct; investigation seeds that feed
  tracing are now accurate.
- **Debug** — the fix removes false-lead files (a 10k-line file that merely
  mentions the term) from the top of the evidence, which is exactly what derails
  a debugging agent.
- **Implement code + UT** — added `tests/v2/research-ranking.test.ts` (2 cases)
  locking in (a) PascalCase class file outranks generic same-word file, (b)
  fixture fallback surfaces the only real match. Full suite stays green except
  two **pre-existing** `indexFreshness.isStale` failures unrelated to ranking
  (confirmed by re-running on stashed/original code — they fail there too).
- **Code review** — review proof unchanged at 1/1, 90.6% saving.

## Token vs quality (goal Q2)

- **Quality: up.** Context-proof correctness 1/3 → 3/3; everything else held at
  100%. This is a pure precision gain — the agent now gets the right file.
- **Tokens: flat (slightly better).** Input-token saving stayed ≈86% on context,
  98% golden, 91% review. The fix re-ranks within the same bounded budget; it
  does **not** spend more tokens to be correct. (Absolute baseline token counts
  drift run-to-run because the grep baseline scans the live repo, which now
  contains the new test file — the saving *ratio* is the stable metric.)

## Reproduce

```powershell
node dist/cli.js setup --root .
node dist/cli.js benchmark proof  --root .   # 3/3, qualityMaintained: true
node dist/cli.js benchmark eval   --root .   # 4/4
node dist/cli.js benchmark review --root .   # 1/1
node dist/cli.js benchmark route-gate --root .  # 5/5
npx vitest run tests/v2/research-ranking.test.ts
```
