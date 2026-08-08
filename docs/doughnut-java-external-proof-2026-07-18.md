# Doughnut Java external proof — 2026-07-18

## 1. System mental model

Claude's first repository turn pays for four layers before the answer is useful:

1. Claude CLI startup and project instructions;
2. built-in tool, skill, agent, and auto-memory surfaces;
3. MCP initialization plus advertised server/tool schemas;
4. one or more model/tool/model turns to obtain repository evidence.

The CodeGraph client surface itself is small: three tools plus MCP instructions
serialize to 3,393 characters, roughly 849 tokens. The measured cold penalty is
therefore dominated by prompt-cache prefix creation and extra turns, not by the
raw CodeGraph schema alone.

## 2. Execution pipeline

| Step | Owner | Main cold cost | Optimization tested |
| --- | --- | --- | --- |
| CLI boot | Claude Code | settings, agents, skills, persistence | lean startup profile |
| Memory/bootstrap | Claude Code | auto-memory load or Bash read | disable auto-memory in lean mode |
| Tool availability | Claude Code/MCP | eager schema or ToolSearch | eager versus lazy |
| Repository evidence | CodeGraph | index quality and routing | exact endpoint and field-change routing |
| Final response | Sonnet 5 | extra turns and output correctness | quality oracle and JSON validation |

## 3. Step-by-step bottleneck analysis

### Controlled cold-start task

Task: trace `GET /api/recalls/recalling` on the same clean Doughnut snapshot,
model `claude-sonnet-5`, one run per configuration.

| Configuration | Quality | Fresh tokens | Wall time | Extra behavior |
| --- | ---: | ---: | ---: | --- |
| standard + eager | 93.3% | 38,877 | 26.6s | one MCP call |
| standard + lazy | 93.3% | 69,082 | 24.0s | two ToolSearch calls |
| lean + eager | 93.3% | 26,120 | 23.8s | one MCP call |
| lean + lazy | 93.3% | 43,611 | 39.9s | one shell fallback |

Against standard + eager, lean + eager reduced fresh usage by **32.8%** and
wall time by **10.6%** without changing the quality score. Lazy loading is
rejected: it increased fresh usage by **77.7%** in the standard profile and
introduced extra discovery/fallback work.

The lean profile now additionally sets:

- `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`;
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`;
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.

This prevents the observed first-turn Bash read of Claude auto-memory while
leaving project `CLAUDE.md` instructions enabled.

## 4. Root-cause hypotheses

| Hypothesis | Result |
| --- | --- |
| CodeGraph's schema is the main +18k-token cold cost | Rejected; schema/instructions are only about 849 tokens |
| Lazy MCP avoids the cold penalty | Rejected; ToolSearch added turns and more fresh tokens |
| Unrelated Claude startup surfaces are material | Supported; lean + eager saved 32.8% fresh tokens |
| External Java misses are only model variance | Rejected; the index omitted Spring array-valued method paths |
| Field-impact misses need more generic research | Rejected; the prompt was misrouted to research instead of change/field impact |

## 5. Evidence from code and benchmarks

Repository under proof:

- source: `D:\Personal\Projects\doughnut`;
- immutable benchmark snapshot: commit `333e63f27cdbbfe673f7f63aba2282a474fa8aae`;
- indexed files: 1,232;
- final snapshot: `85baabc2a366cc940fbe5a4b7d882bf5`;
- suite: `examples/doughnut-java-e2e-quality-suite.example.json`.

The source worktree was not modified. Benchmarking used a detached local clone
under `.tmp/doughnut-external-proof-20260718-0142/source-clone` because the
original worktree already contained uncommitted user changes.

Two deterministic defects were reproduced and fixed with failing tests first:

1. `changing the Java field Note.deletedAt` was inferred as research. It now
   routes to a change pack with `changeType=investigate` and the explicit field
   symbol.
2. Spring `@GetMapping(value = {"/recalling"})` uses Tree-sitter node type
   `element_value_array_initializer`. The parser only recognized
   `array_initializer`, so the index stored `/api/recalls` instead of
   `/api/recalls/recalling`. Provider version v25 forces correct reindexing.

After reindexing, the database contains exact endpoints for both
`/api/recalls/recalling` and `/api/recalls/previously-answered`. A live Sonnet 5
run then returned 93.3% quality with one MCP call and zero shell calls.

### Three-task external gate

Baseline is from `claude-ab-3tasks/report.json`; the current MCP arm is from
`claude-mcp-final-v25/report.json`.

| Arm | Quality | Fresh tokens | Raw tokens | Wall time | Shell calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 95.1% | 30,263 | 406,539 | 122.0s | 17 |
| MCP final v25 | 76.9% | 45,444 | 317,914 | 105.3s | 1 |

The MCP arm reduced raw context by **21.8%**, latency by **13.7%**, and shell
calls by **94.1%**, but fresh usage increased **50.2%** and quality fell **18.2
percentage points**. The external promotion gate therefore **fails**.

Per-task final MCP quality:

- endpoint flow: 93.3%;
- field impact: 87.5%;
- review diff: 50.0% because Sonnet emitted invalid JSON with a trailing comma.

## 6. Feature and optimization ideas

1. Keep eager loading for this three-tool MCP surface.
2. Offer lean startup only for headless/controlled runs; retain standard mode for
   interactive sessions that need skills and auto-memory.
3. Add task-derived `--json-schema` to Claude runs so structured-output failures
   are measured separately from repository evidence quality.
4. Add a dedicated answer-ready field-impact packet. The current field task
   still took five MCP calls and one shell call in the final run.
5. Improve relevant-test ranking so `RecallsControllerTests.java` and
   `NoteServiceTest.java` are included directly rather than inferred by name.
6. Add `--repeats` and median/p95 reporting; current repeated live runs show
   material model variance, especially on review output formatting.

## 7. Expected impact estimates

| Change | Expected effect | Confidence |
| --- | --- | --- |
| lean + eager headless profile | about 25–35% less fresh cold usage | measured on one controlled task |
| disable auto-memory in benchmark | removes one unrelated first-turn shell read | measured and documented |
| structured output schema | eliminates invalid-JSON scoring failures, not semantic misses | high, still needs A/B |
| one-call field-impact packet | reduce five MCP calls toward one or two | medium, needs implementation |
| exact relevant-test retrieval | recover 6–8 quality points on affected task rubrics | inferred from current misses |

## 8. Tradeoffs and risks

- Lean mode intentionally excludes user skills, auto-memory, persistence, and
  unrelated built-ins; it is not representative of every interactive session.
- Eager loading wins for an always-used three-tool server, but may not win for a
  large MCP surface.
- Server-side prompt-cache state cannot be reset locally, so single-run “cold”
  numbers must not be treated as stable p50 values.
- JSON schema enforcement can improve format correctness while leaving semantic
  evidence gaps untouched; both must be scored independently.

## 9. Implementation plan

1. Land the parser/routing/runner changes only after targeted and full regression
   tests pass.
2. Add Claude structured-output schema generation from each task's
   `requiredAnswerFields`.
3. Implement a compact field-impact response that includes definitions,
   read/write usages, repository text references, related methods, and tests.
4. Add repeat count, randomized arm order, median, and p95 reporting.
5. Re-run all five Doughnut tasks at least three times per arm.

## 10. Benchmark and validation plan

Promotion gates:

- median quality no worse than baseline by more than 5 percentage points;
- no critical expected file/method misses;
- median fresh tokens lower than baseline by at least 15%;
- median latency lower by at least 15%, or a documented quality win;
- no broad shell fallback after an answerable packet;
- every structured answer valid against its task schema.

## 11. Recommended priority order

1. Structured-output schema and repeated-run statistics.
2. Answer-ready field-impact packet.
3. Relevant-test ranking for Java controllers/services.
4. Full five-task Doughnut matrix, then Codex Luna on the same suite.

Stop rule: do not promote lean mode or claim external Java success until the
three-repeat gate passes. Do not add more generic routing heuristics without a
specific missing file, symbol, endpoint, field usage, or test from a failed task.
