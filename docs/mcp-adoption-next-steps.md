# MCP adoption — what's next after checkpoint 1

Status: brainstorm 2026-07-04; execution started the same day. Progress:

- ✅ **1. Commit & ship** — 3 slices + Release v1.4.0 committed, pushed,
  published to npm (verify green, quality gate A+ after reindex).
- ✅ **2. Real-corpus A/B** — checkpoint 2 on ecommerce-jhipter done:
  46.7% → 80.0% adoption, tokens −9.4%, pooled p = 0.0021 (Results log).
- ⏸ **3. Claude-side** — CLI 2.1.201 installed globally, but headless auth is
  blocked: run `claude /login` once in a terminal (desktop-app auth is not
  shared), or set ANTHROPIC_API_KEY. Then the A/B pattern is ready to reuse.
- ◐ **4. Quality signal** — checkpoint 2's validators DID give a quality
  signal (86.7%/80%), so this is less urgent; fixture re-score still open.
- ◐ **5. Verify + dogfood** — server-side P4 contract verified via raw MCP
  client (1,401 chars, 3 tools, 5-param schema); retro-baseline frozen (this
  workspace's ledger: zero real-usage calls before the changes). Remaining:
  client-side rendering check in a fresh Claude Code session + the after-week
  adoption-report snapshot.

Ordered by priority = (protects value already created) → (closes proof gaps)
→ (expands the win). Each item lists effort and what "done" looks like.

## 1. Commit and ship the proven bundle — protect the work

Everything (P0–P5 code, harness fixes, docs, the measured evidence) sits
**uncommitted** in one working tree. One bad `git checkout` erases a proven
+38-point lever. Nothing below matters if this is lost.

- Commit in reviewable slices: (a) P0 tooling — adoption-score.mjs,
  adoption-report, organic mode, harness `-CopilotCli`/BOM fixes;
  (b) persuasion bundle — single-gate surface, descriptions, slim schema,
  instructions, `next:` affordances, onboard routing blocks;
  (c) docs + plan + evidence pointer.
- Then release (v1.4.0): the npm package's default surface changes from
  7 tools to 3 — that is a behavior change worth a minor version and a
  MIGRATION note (both docs already updated).
- Effort: ~30 min. Done = `git log` shows the slices; `npm test` green at HEAD.

## 2. Real-corpus A/B (doughnut / ecommerce-jhipter) — the biggest open validity question

The fixture corpus is 6 files; grep is genuinely cheap there. Two write-heavy
tasks (create-testcase, refactor) adopted 0/3 in BOTH conditions — the model
just edits directly on a tiny repo. Whether the +38 generalizes to repos where
exploration is expensive is exactly what a skeptic asks first.

- Build a small organic suite (4–6 natural tasks: investigate / debug / flow /
  change) against local `doughnut` and/or `ecommerce-jhipter`, reusing the
  checkpoint-1 driver pattern (short `%TEMP%` run dirs, `--model auto`,
  per-task resume). Prebuild the index once per condition template.
- Watch specifically: do write tasks flip once the repo is big? Does
  turns-to-first stay 1?
- Effort: ~half a day (task authoring + ~1.5h runtime). Done = second
  checkpoint row in the Results log with a real-corpus label.

## 3. Claude-side measurement — the missing client + the missing metrics

Copilot stdout logs don't embed tool results, so **stop-rule compliance** and
**double-spend** — the metrics that distinguish "persuaded" from "convinced" —
were unmeasurable in checkpoint 1. Claude session JSONL carries full tool
results; the scorer already parses it (`--claude-jsonl/--claude-dir`).

- Install headless CLI (`npm i -g @anthropic-ai/claude-code`), then A/B with
  `claude -p` + `--mcp-config` (old dist vs new dist worktree, same pattern):
  5–10 tasks × 3 reps × 2 conditions on a corpus repo, `--strict-mcp-config`
  so the session's own codegraph server doesn't leak in.
- This also measures the levers Claude actually sees (CLAUDE.md routing block,
  server instructions) vs Copilot's (copilot-instructions.md, descriptions).
- Effort: ~half a day. Done = claude rows (baseline + after) in the Results
  log **including** stop-rule % and double-spend %.

## 4. Fix the quality signal — validators saturated at 0/21 on both sides

The pre-committed decision rule is "adoption up AND quality within −5% AND
double-spend ≤ baseline". Checkpoint 1 proved the first clause only; quality
gave no signal because the fixture validators (written for forced-MCP
gpt-5-mini runs) fail every `--model auto` run on format/strictness grounds.

- Cheapest: relax answer-format checks (accept prose around the JSON, case-
  insensitive golden facts) and re-score the EXISTING 42 transcripts — no new
  runs needed; the raw logs are archived in `%TEMP%\cg-ab` +
  `.codegraph/adoption-ab-20260704/`.
- Alternative: LLM-rubric grading of final answers (reuse copilot-e2e's
  goldenFacts as the rubric input).
- Effort: 1–2 h. Done = quality Δ column filled for checkpoint 1; decision
  rule fully evaluated.

## 5. Live truncation verify + start the dogfood window (cheap, do alongside)

- Fresh Claude Code session against the rebuilt server: confirm initialize
  instructions render without `[truncated]`, tools/list shows exactly 3 tools,
  and the first repo question routes through `codegraph_context` (P4
  acceptance, still unticked).
- The call ledger already records sessionId: run
  `codegraph adoption-report --until 2026-07-05` once to freeze the
  retro-baseline of real usage, then compare after a week of normal work.
- Effort: minutes now, one command in a week. Done = P4 checkbox ticked;
  two adoption-report snapshots to diff.

## 6. Optional: one-lever attribution run (only if the answer would change action)

Checkpoint 1 measured P1–P5 as a bundle. If Copilot strategy needs to know
whether the instructions FILE or the tool SURFACE does the work there, run one
extra condition: after-build **without** `.github/copilot-instructions.md`
(21 runs, ~45 min). Skip if the answer wouldn't change what ships — the
bundle is already proven and all levers are cheap to keep.

## 7. Parked (deliberately)

- **P6 hook enforcement** — decision rules say enforce only if persuasion
  plateaus. It didn't; stays parked until a checkpoint says otherwise.
- **Packet quality track** (flow pack missing first downstream service, from
  the doughnut Sonnet A/B) — load-bearing for RETENTION (double-spend, trust)
  but a separate workstream; revisit once stop-rule/double-spend numbers exist
  from item 3.
- **Write-task adoption gap** — re-examine after item 2; on a 6-file fixture
  "just edit it" is arguably the right call, so this may not be a defect.

## Suggested order

1 (commit/ship) today → 5 (verify + freeze retro-baseline) same session →
2 and 3 as the next two working blocks → 4 whenever a spare hour exists
(re-scores existing data) → 6 only on demand → 7 stays parked.
