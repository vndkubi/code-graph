# Three-Feature Implementation Report - 2026-06-20

Implemented features:

1. MCP Route Inspector + Benchmark Gate
2. Response Budget + Evidence Handles for broad graph outputs
3. Calculation Impact Pack for calculation-sensitive changes

The goal was not to hide context. The goal was to return enough structured
evidence for an agent to stop, and to expose exact follow-ups only when the
packet is incomplete.

## Implemented Scope

### Route Inspector + Gate

- Added `inspectCodeGraphRoute()` in `src/v2/mcp/proxy.ts`.
- Added CLI:

```powershell
node dist/cli.js route-inspect --task "<task text>"
node dist/cli.js benchmark route-gate
```

- Added deterministic route-gate benchmark in
  `src/v2/benchmark/route-gate.ts`.
- Added gate assertions for the client-facing route contract in
  `tests/v2/mcp-client-profile.test.ts`.

The route packet now states the primary facade, routed tool, expected stop
rule, maximum additional calls, allowed follow-up tools, and disallowed broad
fallback behavior.

### Response Budget + Evidence Handles

- Added compact default output for `find_references`.
- Added compact default output for `trace_dependencies`.
- Preserved expanded rows through `outputMode=full`.
- Added response budget reporting:
  - estimated compact tokens
  - estimated full tokens
  - estimated tokens saved
  - compression ratio
  - cap exceeded state
- Added `omitted`, `nextCursor`, and `allowedFollowups` handles so agents can
  expand the next exact page instead of using shell or broad MCP exploration.

Measured on `.tmp\perf-hadoop-common-20260619-125802`:

| Query | Compact approx tokens | Full approx tokens | Reduction | Compact follow-up |
| --- | ---: | ---: | ---: | --- |
| `find_references` for `Configuration.set` calls | 1,600 | 12,842 | 87.5% | one exact `find_references` cursor |
| `trace_dependencies` for `FileSystem.java` depth 2 | 2,649 | 25,051 | 89.4% | one exact `trace_dependencies` cursor |

The full `trace_dependencies` response exceeded the 16k response cap estimate,
while compact mode stayed under the default 6k cap and still returned counts,
groups, representative edges, omitted counts, and a cursor.

### Calculation Impact Pack

- Added `riskMode=calculation_sensitive` support for:
  - `codegraph_context`
  - `simulate_patch_impact`
  - `get_change_pack`
- Added calculation sink grouping by output behavior instead of raw reference
  count.
- Added output classes including score/ranking, thresholds, quantities,
  totals, ratios, aggregates, duration, allocation/forecast, API-visible
  output, and generic calculations.
- Added impact coverage and test obligations for boundary values, zero/null,
  precision, unit conversion, ordering/ranking stability, aggregation,
  thresholds, and time windows.
- Added answerability guard in `get_change_pack`: unresolved calculation
  impact can force `answerable=false`.

This covers the broader case discussed in the thread: any change that can
modify computed output should be treated as high-impact, not only money or
billing changes.

## Verification

Deterministic checks run:

```powershell
npm.cmd run build
npm.cmd test -- --run tests/v2/mcp-client-profile.test.ts
npm.cmd test -- --run tests/v2/index-query.test.ts -t "calculation-sensitive"
npm.cmd test -- --run tests/v2/index-query.test.ts -t "serves agent-oriented file"
npm.cmd test
node dist/cli.js route-inspect --task "Analyze PBI acceptance criteria against code"
node dist/cli.js benchmark route-gate
```

Results:

- Build passed.
- Full test suite passed: 8 files, 96 tests.
- Route gate passed: 5/5 tasks.
- `route-inspect` routed PBI/acceptance-criteria work to `compile_evidence`
  with zero expected additional calls.

## GPT 5.3 Codex Spark Benchmark

The local Windows Store `codex.exe` returned `Access is denied`, so the
benchmark used the npm CLI through:

```powershell
cmd.exe /c npx.cmd -y @openai/codex
```

The model string used by the runner was:

```text
gpt-5.3-codex-spark
```

### Dry Run

Command shape validated with:

```powershell
node dist/cli.js benchmark codex-e2e --root .tmp\perf-hadoop-common-20260619-125802 --suite examples\codex-e2e-quality-suite.example.json --models gpt-5.3-codex-spark --modes compiled-packet,compiled-packet+gate --dry-run --no-index --run-dir .tmp\codex-e2e-spark-20260620-dry
```

### Hadoop Common Sample

Run:

```powershell
node dist/cli.js benchmark codex-e2e --root .tmp\perf-hadoop-common-20260619-125802 --workspace-key hadoop-project --suite examples\codex-e2e-quality-suite.example.json --models gpt-5.3-codex-spark --modes compiled-packet+gate --task-ids api-flow-yarn-apps --no-index --codex-command cmd.exe --codex-command-args "/c,npx.cmd,-y,@openai/codex" --codex-timeout-seconds 300 --run-dir .tmp\codex-e2e-spark-20260620-run-indexed
```

Observed:

- exit status: 0
- MCP calls: 1
- MCP tool: `compile_evidence`
- shell calls: 0
- input tokens: 44,334
- cached input tokens: 31,360
- output tokens: 2,880
- reasoning tokens: 2,194
- wall time: 16,015 ms
- quality score: 0.636

The task asked for a YARN endpoint, but the sample root was Hadoop Common.
The model correctly noticed the packet was not enough for the requested YARN
surface. This is useful negative evidence: the E2E runner should preflight
suite/root compatibility before spending model tokens.

### CodeGraph Self Suite

Added `examples/codegraph-self-e2e-quality-suite.example.json` and ran:

```powershell
node dist/cli.js benchmark codex-e2e --root . --workspace-key "D:/Personal/Projects/code-graph" --suite examples\codegraph-self-e2e-quality-suite.example.json --models gpt-5.3-codex-spark --modes compiled-packet+gate --task-ids route-inspector-gate --no-index --codex-command cmd.exe --codex-command-args "/c,npx.cmd,-y,@openai/codex" --codex-timeout-seconds 300 --run-dir .tmp\codex-e2e-spark-20260620-self-indexed
```

Observed:

- exit status: 0
- MCP calls: 1
- MCP tool: `compile_evidence`
- shell calls: 0
- input tokens: 40,708
- cached input tokens: 28,160
- output tokens: 2,767
- reasoning tokens: 1,855
- wall time: 20,656 ms
- quality score: 0.769

The response found `src/v2/mcp/proxy.ts`, `inferCodeGraphContextMode`,
`compile_evidence`, `answerable`, `allowedFollowups`, and required fields.
It missed `tests/v2/mcp-client-profile.test.ts`, `inspectCodeGraphRoute`,
and `routeCodeGraphContext`, while the packet still claimed `answerable=true`.
This is useful quality evidence for stricter answerability.

## Additional Proposals From The Run

### 1. Benchmark Preflight Gate

Problem found:

- A workspace-key mismatch returned `workspace_not_indexed`.
- A YARN suite was allowed to run against a Hadoop Common sample.

Proposal:

- Before paid model execution, validate:
  - workspace key resolves to a current snapshot;
  - expected files or expected packages exist in the indexed root;
  - task suite declares a compatible root profile.

Expected value:

- Prevents wasted model runs with misleading low scores.
- Makes negative benchmark results easier to classify as environment/setup
  failures versus feature quality failures.

### 2. Windows `.cmd` Spawn Wrapper

Problem found:

- Direct `npx.cmd` spawn failed with `spawnSync npx.cmd EINVAL`.
- Running through `cmd.exe /c npx.cmd -y @openai/codex` worked.

Proposal:

- In the Codex E2E runner, detect `.cmd` or `.bat` commands on Windows and
  wrap them as `cmd.exe /c <command> ...args`.

Expected value:

- Removes a Windows-specific benchmark footgun.
- Keeps benchmark commands portable for local contributors.

### 3. Strict Evidence Answerability

Problem found:

- The self-suite run returned `answerable=true` even though some expected
  methods and tests were missing from the packet.

Proposal:

- Add a strict rubric mode for `compile_evidence`:
  - `strictRubric=true`
  - `expectedFiles`
  - `expectedSymbols`
  - `expectedTests`
  - `criticalTerms`
- Return `answerable=false` when critical expected evidence is absent or only
  partial.

Expected value:

- Prevents early stopping when the packet is compact but materially incomplete.
- Makes route-gate benchmarks check quality, not just tool discipline.

### 4. Net Savings Report

Problem found:

- Compact responses save tokens, but the gate should account for exact
  follow-up cost.

Proposal:

Add a benchmark field:

```text
netSaving =
  fullPacketTokens
  - compactPacketTokens
  - exactFollowupTokens
  - fallbackShellTokens
```

Expected value:

- Gives a clear answer to whether compact mode still wins after follow-ups.
- Helps decide which tools should default to compact versus full.

## Practical Rule

Default compact is enough only when it includes:

- total count;
- grouped impact;
- representative evidence;
- omitted count;
- exact cursor;
- allowed follow-up reason;
- stop rule or answerability state.

If a change affects calculated output, compact evidence is not enough unless
the packet classifies downstream output groups and marks unclassified
calculation sinks. For those cases, `riskMode=calculation_sensitive` should be
used and unresolved high-risk sinks should block `answerable=true`.
