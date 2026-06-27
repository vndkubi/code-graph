# Guiding the agent to answer from CodeGraph — stop rules + evidence reuse (2026-06-27)

## Goal

Make the agent (LLM) produce its answer **from CodeGraph packets** without
paying extra cost for shell/grep/read fallback, and without receiving the **same
source twice** across a multi-step task.

Two distinct problems, two mechanisms:

| Problem | Mechanism |
| --- | --- |
| Agent runs shell/grep/read even though the packet already answers | Stop-rule / answerability signaling (existing, reinforced) |
| Agent receives the same source body again on every pack call (duplicate tokens) | Session evidence ledger (new, opt-in) |

## 1. Stop the shell fallback (answer from the packet)

CodeGraph packets already carry the signals an agent needs to terminate:

- `answerable` / `sufficientForAnswer` — when true, the packet is enough.
- `stopRule` — "Do not call rg, shell, search_code, ...; answer from this packet."
- `answerGuidance` — explicit "treat evidenceSlices as already-read source".
- `allowedFollowups` / `disallowedFollowups` — when not answerable, exactly which
  follow-up is permitted (and that broad shell/rg is banned).
- `evidenceHandles` — exact `get_file_slice` handles for any missing fact, so the
  agent never needs to grep to find a file.

The `MCP_SERVER_INSTRUCTIONS` (sent at MCP initialize) tell the agent to call
codegraph_context first, treat answerable packets as terminal, and use only the
listed follow-ups. The route-gate and context/flow/review proofs verify that
answerable packets drive **zero** broad shell/search fallback.

## 2. Avoid duplicate tokens (session evidence ledger)

### How it works

- Pass a stable **`sessionId`** (any constant string for the conversation) on
  every codegraph_context / pack call.
- CodeGraph keeps a per-session ledger of which source bodies (`file + lines +
  symbol`) it has already sent. On a later call, a slice you already received
  comes back with `reusedFromEarlierCall: true` and **no `text`** — only the
  file/lines/symbol handle. `completeness.reusedEvidenceCount` reports how many.
- The agent reuses the source it was already given instead of being charged for
  it again. The handle is preserved, so it can still `get_file_slice` that one
  exact range if it scrolled out of context.

### Why opt-in (not always-on)

Without `sessionId`, every packet stays fully self-contained (default, no
behavior change) — two *different* questions ("where is X" then "trace X")
each get complete source. The dedup only kicks in when the caller signals "I am
the same conversation and I remember earlier evidence" by passing `sessionId`.
`freshEvidence: true` forces full bodies even within a session.

The ledger lives on the single `V2QueryService` the MCP runtime builds per
process, keyed by `sessionId` and invalidated when the snapshot changes
(reindex), so stale line ranges are never reused.

### Measured effect (this repo)

- Exact repeated evidence slices: source text dropped **~68%** on the second
  call (4990 → 1593 chars across 4 slices, full profile).
- Realistic investigate → trace → change sequence (3 packs, partial overlap):
  **~5%** fewer total packet tokens (19,479 → 18,442 est. tokens) — free, with no
  loss of information (handles retained). Savings scale with how often the same
  hot files recur across a task.

## Default behavior is unchanged

- No `sessionId` → identical to before (every packet self-contained). Verified:
  golden 4/4, context 3/3, review 1/1, route-gate 5/5; full query suite green
  except two pre-existing `indexFreshness.isStale` failures unrelated to this
  change.

## Tests

- `tests/v2/evidence-ledger.test.ts`:
  - repeated pack call omits text + flags `reusedFromEarlierCall`, and
    `freshEvidence: true` restores it;
  - no `sessionId` → no dedup (packets stay self-contained).

## For agent integrators

Add one field to every CodeGraph call: `sessionId: "<conversation id>"`. Then
honor `reusedFromEarlierCall` (reuse, don't re-open) and the packet `stopRule`
(answer, don't shell-search). That combination is what keeps token spend flat
across a long task.
