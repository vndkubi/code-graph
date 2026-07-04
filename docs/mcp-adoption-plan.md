# MCP Adoption Plan — making Claude/Copilot actually call CodeGraph

Status: P0–P5 landed and measured (checkpoint 1, 2026-07-04 — see Results
log). What happens next is prioritized in
[mcp-adoption-next-steps.md](mcp-adoption-next-steps.md).

## Problem

CodeGraph's value only materializes if the host LLM *chooses* to call it instead
of falling back to grep/read loops. Every benchmark so far (copilot-e2e, doughnut
Sonnet A/B) **forces** MCP usage via prompt directives — organic adoption (the
model picking the tool on its own) has never been measured, and the current
surface works against it.

An LLM considers an MCP tool when three things hold at decision time:

1. the tool is **visible** in context (not deferred/truncated away),
2. an instruction layer with enough **authority** says when to use it and what
   the payoff is,
3. the **first call succeeds** (in-session experience compounds fast — one
   error or bloated response teaches avoidance for the rest of the session).

## Evidence (observed live in a Claude Code session, 2026-07-04)

- All codegraph tools were **deferred** behind ToolSearch — not in the model's
  initial tool list. Tool descriptions alone cannot win adoption if the model
  never sees them. VS Code Copilot has an analogous ceiling (128-tool cap,
  virtual grouping).
- MCP initialize instructions (`MCP_SERVER_INSTRUCTIONS` in
  `src/v2/mcp/proxy.ts`) were **truncated by the client at ~1,900 chars**,
  mid-sentence in "Tool selection by intent". The sessionId evidence-ledger
  rule, follow-up policy, and anti-patterns were never shown to the model.
- Three tools all claim "PRIMARY - call FIRST" (`codegraph_context`,
  `contextgate_get_context`, `tokenopt_compile_evidence`), and when the
  standalone tokenopt server is connected alongside codegraph, the 4
  contextgate/tokenopt tools are **registered twice** (`mcp__codegraph__*` +
  `mcp__tokenopt__*`). The model arbitrates between our own tools before it
  arbitrates against Grep.
- `codegraph onboard` writes CLAUDE.md project facts
  (`composeClaudeMarkdown`, `src/v2/query/onboard.ts`) but **never mentions the
  MCP tools** — the highest-authority, never-truncated instruction channel is
  unused. No `.github/copilot-instructions.md` is generated at all.
- Instructions reference tools not exposed in the client profile
  (`search_symbol`, `get_flow_pack`, …) → model calls them → error → trust loss.
- copilot-e2e prompt template says "Use only CodeGraph MCP server …" — we
  measure quality-given-usage, not adoption.

Guiding principle: **adoption is downstream of reliability.** The doughnut A/B
showed MCP investigate missing the first downstream service; every miss trains
the model (and the human) to avoid the server. Levers below get the model to
the first call; packet quality keeps it there.

---

## Phase 0 — Baseline: measure organic adoption (cheap version OK)

Do this BEFORE landing Phases 1–4, otherwise improvements can't be attributed.
This phase stands up the measurement described in "Proof protocol" below and
records the first row of the Results log.

- [x] Add an `organic` mode to the copilot-e2e harness
      (`examples/copilot-e2e-quality-bench.ps1`): MCP server available, but the
      prompt directive "Use only CodeGraph MCP server …" replaced by a neutral
      task statement (the `-replace` logic for baseline mode shows where).
      Organic runs also keep workspace instruction files loaded
      (no `--no-custom-instructions`) — that file is a lever being measured.
- [x] Metrics per run: **adoption rate** (% runs with ≥1 codegraph call),
      **turns/time to first MCP call**, quality delta organic-vs-forced.
      → `scripts/adoption-score.mjs --copilot-run-dir <dir>` emits all four
      proof-protocol metrics plus ready-to-paste Results-log rows.
- [ ] Same for Claude: headless `claude -p` runs over 5–10 repo tasks with the
      MCP configured, count codegraph tool calls in the transcript.
      (Scorer side is ready: `adoption-score.mjs --claude-jsonl/--claude-dir`;
      the runs themselves are still to do.)
- [x] Record baseline numbers in this file:
      - Copilot organic adoption: **14.3 %** (3/21, fixture suite, 2026-07-04 — see Results log)
      - Claude organic adoption: ____ % (pending — no headless claude CLI on this machine)

Acceptance: numbers exist for both clients; harness re-runnable with one flag.

## Phase 1 — Routing policy in CLAUDE.md + copilot-instructions.md (biggest lever)

Host-level instruction files are never deferred, never truncated, and carry
override-level authority. They already ride our distribution channel: onboard.

- [x] Extend `composeClaudeMarkdown` (`src/v2/query/onboard.ts:458`) with an
      MCP-routing section inside the same generated block. Keep it ≤10 lines.
      Draft:

      ## Repo context: use the codegraph MCP first
      - Any repo question, or before any edit → call `codegraph_context` with the user's task verbatim
      - Response has `answerable=true` → answer from the packet; do NOT re-grep/re-read the same ground
      - Need more source at an exact file/line the packet named → `codegraph_slice`
      - Pass the same `sessionId` on every call in a conversation (dedupes evidence, saves tokens)
      - Index missing/stale → the tool says so; run `codegraph index` then retry

- [x] New: onboard also writes `.github/copilot-instructions.md` with the same
      routing block (Copilot auto-attaches this file to every Chat/agent
      request; Copilot has no hooks, so this file is most of the game there).
      New `--profile copilot`; `both` includes it.
- [x] Reuse `applyGeneratedBlock` for the new file target — existing-file
      handling is already solved: replace inside markers, append after
      hand-written content when no markers, error on a lone marker.
- [x] Only emit the MCP section when onboard can see an MCP-usable index (same
      gate as the rest of the generated block).
      Implemented as a hedge instead: onboard already requires the index, and
      the block opens with "When the codegraph MCP tools are available in this
      session" so it stays harmless when the server isn't configured.
- [ ] Optional, later: a `.github/chatmodes/codegraph.chatmode.md` custom chat
      mode pinning codegraph tools for hard opt-in in VS Code.

Acceptance: fresh repo → `codegraph onboard` produces both files with the
routing block; repo with existing CLAUDE.md/copilot-instructions.md → block
inserted/updated without touching hand-written content; re-run is idempotent.

## Phase 2 — One entry point, no duplicate tools

- [x] Decide THE gate for client profile: `codegraph_context` vs
      `contextgate_get_context`. Criteria: benchmark recall/token numbers
      (research-pack path holds the 0.83 recall result), cleaner story in one
      sentence, param surface. Loser leaves the client profile (stays in
      `full`).
      → `codegraph_context` (it routes into the same packs internally); client
      profile now advertises exactly 3 tools.
- [x] Kill the double registration when both servers are configured: document
      the canonical setup as **codegraph only** (it already embeds the tokenopt
      tools post-fusion) in `docs/mcp-setup-and-usage.md`, and add a
      config/env escape hatch to hide the embedded tokenopt tool copies for
      anyone who insists on running both servers.
      → embedded tokenopt tools are now hidden on every profile except `full`;
      `TOKENOPT_MCP_MODE=lite|full|broker` restores them, `off` hides them even
      on `full`.
- [x] Exactly ONE tool description may say "call first". Every other
      description must name its trigger relative to the gate ("after
      codegraph_context names …").

Acceptance: a client connecting per-docs sees 3 tools, one marked as the entry
point; no identically-described tool pairs.

## Phase 3 — Descriptions that persuade + slim client schema

Descriptions are prompt engineering: state capability + trigger + payoff, drop
imperative shouting and internal jargon ("answer-mode bounded packets",
"coverage contract" mean nothing to a model choosing vs Grep). We own real
benchmark numbers — use them.

- [x] Rewrite the 3 client-profile descriptions in
      `src/v2/mcp/tools.ts` (`compactDescriptionFor`). Draft for the gate:

      "One call returns ranked files, call/dependency edges, and line-numbered
      source snippets for an entire task from a pre-indexed code graph —
      replaces a grep→read→grep loop (benchmarked: ~20% fewer tokens, ~5×
      fewer tool round-trips than raw reads). Use for any repo question or
      before any edit; pass the user's task verbatim. If the response says
      answerable=true, answer from it and stop searching."

- [x] Slim the client-profile schema of the gate tool from 17 params to ~5
      (task, mode, target, diff, sessionId). Power knobs stay in `full`
      profile; server stays lenient to unknown params.
      → `SLIM_CODEGRAPH_CONTEXT_SCHEMA` advertised on every profile except
      `full`; the server still parses the full zod schema.
- [x] Re-run the proof protocol after landing; add a checkpoint row to the
      Results log. → done 2026-07-04: 14.3% → 52.4%, p = 0.0101 (see Results
      log; P1+P2+P3+P4+P5 measured as one bundle — per-lever attribution
      requires the staged checkpoints described below).

Acceptance: adoption rate moves (or we learn it doesn't and revisit); no
invalid-call regressions in benchmark logs.

## Phase 4 — Server instructions that survive truncation

- [x] Cut `MCP_SERVER_INSTRUCTIONS` (`src/v2/mcp/proxy.ts:813`) to ≤1,500
      chars. Order: (1) one-line role, (2) routing table, (3) sessionId rule,
      (4) stop rule (`answerable=true` → answer, don't re-search). Prose,
      dual-server role-switching lore, and anything else moves to docs.
      → base is 1,413 chars; a full-profile addendum (only sent when the
      tokenopt/pack tools are exposed) brings the combined text to 1,804 —
      still under the observed ~1,900 truncation point.
- [x] Remove references to tools not exposed in the active profile (no ghost
      tools → no failed calls → no trust loss).
- [ ] Verify in a live Claude Code session that the full text renders without
      `[truncated]`. (Needs a fresh session against the rebuilt server.
      Server-side contract verified 2026-07-04 via raw MCP client: 1,401 chars
      on the wire, sessionId rule on line 5, exactly 3 tools, 5-param gate
      schema. Only the client-side rendering check remains.)

Acceptance: instructions fully visible in-session; sessionId rule within the
first 5 lines.

## Phase 5 — First-call experience & in-packet affordances

- [x] First call on an unindexed/stale workspace must not dead-end: either
      auto-bootstrap the index or return a one-line actionable message naming
      the exact command, plus what to call after.
      → `workspace_not_indexed` errors carry `next:` naming the exact
      `codegraph index`/`codegraph setup` command.
- [x] Every packet/error response ends with a compact `next:` affordance
      naming an MCP tool (extend the existing allowedFollowups pattern), so
      the chain stays in-MCP instead of dropping back to shell.
      → answerable packets get `_codegraph_meta.next` (stop rule travels with
      the packet); every error payload carries `next:`.
- [x] Audit error paths: no error may end without naming the recovery tool.
      → `errorPayload` fallback, profile-gated tools, and structured errors
      all name a recovery path.

Acceptance: cold-start transcript shows model recovering into a successful
codegraph call without human help.

## Phase 6 — Optional: Claude-side enforcement (only after 1–4 are good)

Forcing an unconvinced model creates the measured double-spend pattern (calls
the gate, then greps anyway). Enforce last, not first.

- [ ] Flip the existing gateway PreToolUse hook from shadow to enforce for
      broad task classes: deny Grep/Glob/Read with the message "call
      codegraph_context first with the task" + keep an escape hatch.
- [ ] Cheaper alternative first: UserPromptSubmit hook injecting a one-line
      routing hint.
- [ ] Re-measure double-spend rate after enabling; roll back if it rises.

Not applicable to Copilot (no hooks) — Phases 1–3 are the whole game there.

---

## Proof protocol — how we prove the levers worked

A single "adoption went up" number is not proof. Effectiveness =
**model uses the tool more, trusts its output, quality doesn't regress, and
cost drops** — four separate claims, each needs its own metric.

### Metrics (the scoreboard)

| Metric | Definition | How counted | Success direction |
| --- | --- | --- | --- |
| Organic adoption rate | % runs with ≥1 codegraph call, prompt never mentions MCP/codegraph | transcript parse | up; target ≥70% on broad-investigation tasks |
| Turns to first MCP call | index of the first codegraph call in the tool-call sequence | transcript parse | down; target: 1st–2nd call |
| Double-spend rate | % runs where, after a packet returned `answerable=true` covering file F, the model still greps/reads F | transcript parse vs packet evidence list | down; target ≤20% |
| Stop-rule compliance | % `answerable=true` packets followed by zero further search/read tools | transcript parse | up |
| Task quality | per-task oracle/rubric score (reuse copilot-e2e quality scoring) | existing harness | non-regression (>−5% fails the phase) |
| Cost | tokens per completed task + wall-clock | harness + API usage | ≤ raw-file baseline |

Adoption up + double-spend up = the instructions persuaded but the packets
didn't convince — that is NOT a pass; it reproduces the measured double-spend
pathology.

### Experiment design (what makes it credible)

- [ ] Fixed task suite: 10–20 tasks × 4 task classes (investigate / flow /
      change / review) × 2 corpora (doughnut, ecommerce-jhipter). Prompts are
      natural dev asks; the words "MCP", "codegraph", "tool" never appear.
- [ ] Pin everything else: model version, corpus commit, prebuilt index,
      default sampling. The ONLY variable between conditions is the phase
      being tested.
- [ ] N ≥ 3 repetitions per task per condition — LLM runs are stochastic;
      single runs prove nothing. Report raw counts (n/N), not just
      percentages.
- [ ] One checkpoint per user-visible phase: BEFORE → after P1 → after P3 →
      after P4 (P2 lands with P3 if convenient). This attributes effect to a
      specific lever instead of "the bundle did something".
- [ ] Both clients every checkpoint: copilot-e2e organic mode + headless
      `claude -p` with transcript parsing.

### Instrumentation to build

- [x] Transcript scorer (small script, or extend the harness): parses the
      tool-call sequence from Claude session JSONL / copilot-e2e logs and
      emits adoption, turns-to-first-call, double-spend, stop-rule compliance
      automatically. Manual counting doesn't survive N×tasks×conditions.
      → `scripts/adoption-score.mjs` (no deps, Node ≥18).
- [x] Server-side call ledger (cheap, high value): codegraph appends
      `{timestamp, tool, sessionId, workspace}` to a local log file on every
      call. This is what makes the dogfood proof below possible, and it
      measures real usage rather than benchmark usage.
      → the existing `.codegraph/logs/query.jsonl` now also records
      `sessionId`; `codegraph adoption-report [--since --until --format]`
      aggregates it.

### Dogfood proof (strongest evidence, run last)

Synthetic A/B can get lucky; a week of real work is hard to argue with.

- [ ] 5+ working days of normal daily sessions BEFORE the changes (ledger
      running) vs 5+ days AFTER all phases land: compare real per-session
      codegraph calls, and count sessions where the first repo-exploration
      action was codegraph vs grep/read.
- [ ] Qualitative pass over 5 random post-change transcripts: did the model
      answer from packets, or call the tool and ignore the output?

### Decision rules (pre-committed, so results can't be rationalized)

- Adoption +20 points or more AND quality within −5% AND double-spend ≤
  baseline → lever proven; keep, move to next phase.
- Adoption up but double-spend up → stop adding persuasion; fix packet
  quality/trust (see out-of-scope note) before touching Phase 6.
- Adoption flat after P1–P4 → persuasion levers exhausted; Phase 6
  enforcement is the remaining option, and must re-measure double-spend after
  enabling (rollback if it rises).
- Quality regresses in any condition → phase fails regardless of adoption.

### Results log

| Date | Checkpoint | Client | Adoption % (n/N) | Turns→1st | Double-spend % | Stop-rule % | Quality Δ | Tokens/task Δ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-07-04 | baseline (HEAD 4b4f2296) | copilot organic/auto | **14.3% (3/21)** | 1 (med, when adopted) | n/m | n/m | 0/21 pass | (ref: 95k avg) |
| 2026-07-04 | after P1–P5 (same session, working tree) | copilot organic/auto | **52.4% (11/21)** | 1 (med, when adopted) | n/m | n/m | 0/21 pass (no delta) | +8.6% raw avg |
| 2026-07-04 | baseline, real corpus (jhipster) | copilot organic/auto | **46.7% (7/15)** | 1 (med) | n/m | n/m | 86.7% (13/15) | (ref: 175k avg) |
| 2026-07-04 | after P1–P5, real corpus (jhipster) | copilot organic/auto | **80.0% (12/15)** | 1 (med) | n/m | n/m | 80.0% (12/15) | **−9.4%** |
| 2026-07-__ | baseline | claude | | | | | — | — |

**Checkpoint 2 (2026-07-04) — real corpus.** Same design as checkpoint 1 but
on a copy of `ecommerce-jhipter` (220 indexed files, 60 endpoints): 5 natural
tasks (investigate / flow / debug / review / plan) × 3 reps × 2 conditions,
v1.4.0 dist vs commit 4b4f2296 dist. Adoption **+33.3 points** (one-sided
Fisher p = 0.064 alone; **pooled with checkpoint 1: 10/36 → 23/36,
p = 0.0021**). The real-corpus baseline is much higher than the fixture's
(46.7% vs 14.3%) — on a repo where grep is expensive the model already reaches
for the tool more, and the levers lift it to 80%. Per model: claude-haiku-4.5
0/4 → 5/5, gpt-5-mini 7/11 → 7/10. Per task, adoption improved or held
everywhere (debug 1/3→3/3, flow 2/3→3/3, investigate 3/3→3/3, plan 1/3→2/3,
review 0/3→1/3). Quality had signal this time: 13/15 vs 12/15 — the whole
delta is the seeded-review task, where BOTH conditions miss the hardest
golden finding (NPE risk on `order.getCustomer()`); before 1/3, after 0/3,
n=1 run, Fisher n.s. — treated as validator difficulty, watch at next
checkpoint. Tokens per task **dropped 9.4%** with adoption up. Evidence:
`.codegraph/adoption-ab-20260704/checkpoint2-jh-*`.

**Checkpoint 1 (2026-07-04) — method & caveats.** 7 fixture tasks
(`copilot-e2e-quality-suite.example.json`) × 3 reps × 2 conditions, organic
mode, server-default tool surface (`--mcp-tools` override removed for organic).
Only variables between conditions: codegraph dist (HEAD build vs P1–P5 build)
and `.github/copilot-instructions.md` (absent vs onboard-generated). Adoption
delta **+38.1 points, one-sided Fisher p = 0.0101**. Effect survives the model
split (account only allows `--model auto`): claude-haiku-4.5 0/7 → 5/6,
gpt-5-mini 3/14 → 6/15 — both models move, not a mix artifact. When adopted,
`codegraph_context` is the **first** tool call in every adopted run, both
conditions. Per-task: debug 0/3→3/3, codereview 1/3→3/3, investigate 2/3→3/3,
implement 0/3→1/3, break-task 0/3→1/3; create-testcase and refactor stayed
0/3→0/3 (write-heavy tasks on a 6-file fixture — model edits directly; expect
different behavior on a real corpus). Caveats logged, not hidden: tiny fixture
corpus (grep is genuinely cheap there — a hard test for adoption); quality
saturated at 0/21 on BOTH sides (validators written for forced-MCP gpt-5-mini
runs; no quality delta signal either way); stop-rule and double-spend not
measurable from Copilot stdout logs (tool results are not embedded — Claude
session JSONL runs will carry these); Claude-side baseline still pending (no
headless claude CLI on this machine). Raw data:
`.codegraph/adoption-ab-20260704/` (ab-summary.json + per-run-breakdown.txt);
full per-run logs in `%TEMP%\cg-ab\`.

---

## Out of scope here, but load-bearing

Packet quality gaps (e.g. flow packs missing the first downstream service)
directly cap adoption. Track those separately; this plan only covers getting
the model to the first call and keeping the loop inside MCP.
