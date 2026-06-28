# Right-sizing evidence — implementation plan (2026-06-28)

## Thesis

Give the agent EXACTLY the evidence it needs: no more (wasted input tokens), no
less (a gap it must grep to fill). Both move the same dial — quality up AND input
tokens down. We now MEASURE both with `benchmark evidence-audit`:

- **Waste%** = evidence delivered but not needed for a correct answer.
- **Gap%** = needed evidence the packet never delivered (correct=false at any size).

Baseline reality (this repo, derived suite): tokenWaste **24%**, fileWaste
**83%**, gap **0%**; the example suite has **1 hard gap** (`calculation-impact`).

## Success criteria (all measured, no live agent)

A change ships only if, vs the pre-change baseline:

1. `evidence-audit` tokenWaste% drops materially **and** gap% does NOT increase.
2. Context proof stays 3/3, golden 4/4, review 1/1, route-gate 5/5
   (`qualityMaintained: true`).
3. Full unit suite green; lint clean.
4. `quality-trend` row recorded before/after.

## Phase A — Right-sizing (cut Waste), lowest risk

**Problem.** Packs emit a fixed `maxFiles` (default 6) regardless of how many
candidates are actually relevant. The audit shows the needed file is usually
rank 1, so ranks 2–6 are dead weight (~24% tokens).

**Design — relevance-cliff trimming.** After candidates are ranked (already
scored in `searchFiles`/`getContextPacket`/`getResearchPack`), trim the
low-relevance tail before emitting:

- Keep candidate `i` only if `score[i] >= topScore * keepRatio` OR `i < minKeep`.
- `minKeep = 1` (never return empty), hard cap stays `maxFiles` (never grow).
- `keepRatio` starts conservative (e.g. 0.5) and is **calibrated by
  evidence-audit** — sweep it, choose the smallest packets with gap% = 0.
- Apply to `candidateFiles`, `relevantSymbols`, and the evidence slices derived
  from them (fewer files → fewer slices → fewer tokens).
- Gate behind a flag (`rightSize` default on, `rightSize:false` to disable) so
  it is reversible and A/B-measurable.

**Why low risk.** Only trims the tail the audit already shows is unused; the cap
and minKeep bound it; answerability/correctness is the calibration target.

**Files.** `src/v2/query/service.ts` (candidate selection in `getContextPacket`
and `getResearchPack`); a small `rightSizeCandidates(scored, opts)` helper
(extract to `ranking.ts` or `packing.ts`).

**Validation.** `evidence-audit` tokenWaste% ↓, gap% = 0; all proofs hold;
sweep keepRatio and record the chosen value.

## Phase B — Close Gap (raise quality)

**Problem.** Some tasks are correct=false at every size (e.g.
`calculation-impact`) — the needed evidence is never surfaced. This is a
ranking/coverage failure, not a budget one (Phase A must not paper over it).

**Design.**
1. Add `--list-gaps` to `evidence-audit` so it prints the gap tasks + their
   expected-but-missing files/symbols.
2. Per gap task, diagnose: (a) is the needed file even indexed? (b) does it
   appear in `searchFiles` candidates at a large cap but rank too low? (c) is it
   filtered out (fixture/test/role)?
3. Fix the specific cause: ranking signal (the BM25/centrality/compound levers),
   a fixture-fallback gap, or a missing index fact.

**Validation.** Gap task flips to correct in `evidence-audit`; no regression on
the others.

## Phase C — Closed feedback loop (the moat), later

Once A/B land, learn per-repo right-sizing from real usage:

- Instrument evidence attribution in the MCP proxy: tag each delivered evidence
  item; correlate with follow-up MCP calls in the same `sessionId` (already
  threaded for the ledger) to label delivered-and-used vs delivered-unused
  (live Waste) and fetched-but-not-in-packet (live Gap).
- Persist per-repo signals to `query.jsonl`; periodically re-weight ranking and
  the keepRatio per repo. Static competitor indexes cannot do this — it gets
  better with use.

## Sequencing

1. **A** (right-sizing + calibrate keepRatio) — biggest token win, low risk.
2. **B** (`--list-gaps` + fix the known gap task) — quality win.
3. Re-run `evidence-audit` + all proofs; record `quality-trend`.
4. **C** (feedback loop) — separate, larger effort; the durable moat.

## Guardrails

- Every step is gated on `evidence-audit` (waste↓, gap not↑) + the four proofs.
- Right-sizing is flag-controlled and never grows beyond the existing cap.
- No change is "done" until the numbers move in the intended direction with no
  proof regression.
