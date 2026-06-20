# CodeGraph Three-Feature Build Plan - 2026-06-20

This plan turns the current discussion into three buildable CodeGraph features:

1. MCP Route Inspector + Benchmark Gate
2. Response Budget + Evidence Handles
3. Calculation Impact Pack

The shared goal is not to return less context blindly. The goal is to return
enough structured evidence for the agent to stop, or to expose only exact
follow-ups when the packet is incomplete.

## Current Evidence

Use these current worktree facts as the baseline:

- Full MCP profile exposes 28 tools and the all-tool benchmark covered all 28
  tool names with 32 scenarios.
- `codegraph_context.evidence` is already compact at about 7.4 KB median
  response, while `codegraph_context.flow` and `codegraph_context.research`
  are about 19.6 KB and 21.9 KB.
- High-volume graph tools are the main response-size issue:
  - `find_references`: about 121.8 KB median response.
  - `trace_dependencies`: about 103.5 KB median response.
  - `generate_repo_atlas`: about 97.3 KB median response.
- `compile_evidence` already returns `answerable`, `allowedFollowups`,
  `disallowedFollowups`, and a gate policy.
- `get_change_pack` already returns `evidenceHandles`, exact edit ranges,
  patch/field impact, and a response budget report.
- The Codex E2E benchmark runner accepts `--models` and passes the selected
  model to `codex exec --model`.

Sources in this repo:

- `docs/performance-all-tools-hadoop-common-2026-06-19.md`
- `docs/performance-hadoop-common-2026-06-19.md`
- `src/v2/query/service.ts`
- `src/v2/mcp/proxy.ts`
- `src/v2/benchmark/codex-e2e.ts`

## Feature 1: MCP Route Inspector + Benchmark Gate

### Problem

The MCP tool surface is powerful but easy for an agent to misuse. If a packet
says enough to answer but the agent still opens shell, search, or many
follow-up tools, token savings disappear and quality may get worse.

### Proposed User Surface

Add a CLI command:

```powershell
node dist/cli.js route-inspect --root <repo> --task "<task text>"
```

Add benchmark mode or task suite:

```powershell
node dist/cli.js benchmark route-gate --root <repo> --suite <json>
```

If keeping CLI scope smaller, implement the gate first inside the existing
Codex E2E harness as a new mode before adding a public command.

### Output Contract

`route-inspect` should return:

```json
{
  "task": "...",
  "inferredMode": "change|review|flow|research|evidence",
  "primaryTool": "codegraph_context",
  "routedTool": "get_change_pack",
  "packetContract": {
    "requiresAnswerable": true,
    "requiresAllowedFollowups": true,
    "denyBroadShellAfterAnswerable": true
  },
  "expectedStopRule": "answer_from_packet|open_exact_slice_once|expand_exact_followup",
  "expectedMaxAdditionalCalls": 0,
  "expectedDisallowedFollowups": [
    "shell_rg",
    "shell_read_loop",
    "unbounded_mcp_exploration"
  ]
}
```

### Gate Metrics

For each benchmark task, record:

- selected primary tool
- routed internal tool
- `answerable`
- extra MCP calls after answerable packet
- shell/search/read fallback after answerable packet
- total tool calls
- response bytes and estimated response tokens
- correctness against the task oracle
- missing required evidence categories

### Pass Criteria

The route gate passes only when:

- Expected primary route is selected.
- If `answerable=true`, broad shell/search/read calls are zero.
- If `answerable=true`, extra MCP exploration is zero unless the packet lists
  exact follow-ups.
- If `answerable=false`, follow-up tools are a subset of `allowedFollowups`.
- Correctness is not lower than the current deterministic proof/review
  baseline.

### Implementation Steps

1. Extract routing classification from `src/v2/mcp/proxy.ts` into a pure
   helper that can be called by tests and CLI.
2. Add `route-inspect` JSON output around that helper.
3. Add fixture tasks for research, flow, change, review, and evidence/PBI.
4. Extend the Codex E2E analyzer to count post-packet shell and MCP behavior.
5. Add a route-gate report that fails on broad fallback after answerable
   packets.

### Tests

- Unit tests in `tests/v2/mcp-client-profile.test.ts` for route inference.
- Snapshot-like tests for `route-inspect` output.
- E2E benchmark dry-run test proving the model/mode matrix is constructed.
- Non-dry-run benchmark only when a Codex CLI model is available.

## Feature 2: Response Budget + Evidence Handles

### Problem

Some tools are fast locally but return too much model-facing context. Large
flat outputs make the agent scroll, summarize, or search again.

### Principle

Do not optimize for "smaller". Optimize for "enough to stop".

A compact packet is sufficient only when it contains:

- `answerable` or equivalent sufficiency state.
- evidence anchors: file, symbol, lines, endpoint, flow step, or test.
- representative snippets or exact slice handles.
- missing coverage and exact `allowedFollowups` when incomplete.
- omitted counts and cursors for capped data.

### Output Budget Tiers

Default budgets:

| Tool family | Default target |
| --- | ---: |
| `compile_evidence` | 7-12 KB |
| research/architecture packets | 18-25 KB |
| flow/API trace packets | 18-30 KB |
| change/review packets | 25-40 KB |
| refs/deps/atlas compact summaries | 15-25 KB |

Expanded modes:

- `outputMode=full`: preserve current expanded row behavior.
- `cursor`: expand one omitted group.
- `profile=micro|compact|full`: keep profile behavior consistent with packs.

### Data Contract

For capped tools, return:

```json
{
  "responseMode": "compact",
  "budget": {
    "estimatedResponseTokens": 4200,
    "estimatedFullResponseTokens": 28000,
    "estimatedTokensSaved": 23800,
    "capExceeded": false
  },
  "groups": [
    {
      "kind": "runtime_callers",
      "shown": 8,
      "total": 214,
      "representativeEvidence": [
        { "file": "...", "symbol": "...", "lines": "42-80" }
      ],
      "cursor": "refs:runtime_callers:..."
    }
  ],
  "omitted": [
    {
      "kind": "generated_or_low_signal",
      "count": 600,
      "reason": "low risk for default compact response"
    }
  ],
  "allowedFollowups": [
    {
      "tool": "find_references",
      "reason": "expand one impact group",
      "args": { "cursor": "refs:runtime_callers:..." }
    }
  ]
}
```

### Implementation Steps

1. Add a shared response budget utility for grouped graph outputs.
2. Apply it first to `find_references` and `trace_dependencies`.
3. Add compact `generate_repo_atlas` mode after the graph tools are stable.
4. Preserve `outputMode=full` for users who need raw expanded rows.
5. Add benchmark reporting for full tokens, returned tokens, omitted counts,
   and follow-up tokens.

### Pass Criteria

- `find_references` and `trace_dependencies` default responses are below the
  configured compact cap for broad queries.
- The packet includes total counts for omitted rows.
- Exact follow-up cursors exist for every omitted high-signal group.
- Existing correctness-oriented proof/review benchmarks do not regress.
- Net token savings remain positive after allowed follow-up calls:

```text
net_saving =
  full_packet_tokens
  - compact_packet_tokens
  - extra_mcp_response_tokens
  - extra_shell_or_read_tokens
```

## Feature 3: Calculation Impact Pack

### Problem

Some changes are dangerous because they affect computed outputs, not because
they affect many files. This is broader than money. It includes scores, ranks,
quotas, limits, totals, metrics, durations, ratios, forecasts, allocations,
and validation decisions.

Flat references are not enough. The agent needs to know which outputs can
change and which calculation paths remain unclassified.

### Trigger

Enable `riskMode=calculation_sensitive` when:

- task text contains terms like calculate, compute, score, rank, threshold,
  limit, quota, quantity, total, rate, ratio, aggregate, metric, duration,
  allocation, forecast, normalize, convert, precision, rounding, unit, or
  boundary;
- changed symbols contain calculation-like names;
- symbol body or nearby flow has numeric/decimal/date/time operations;
- patch touches a calculator, scorer, ranking, pricing, validation,
  aggregation, or report metric module.

### Output Contract

```json
{
  "riskMode": "calculation_sensitive",
  "answerable": false,
  "changedSymbol": "calculateA",
  "calculationContract": {
    "meaning": "normalizes quantity before downstream scoring",
    "invariants": [
      "unit must remain the same",
      "rounding or precision must be explicit",
      "null, zero, negative, and boundary behavior must be known",
      "ordering of filters and aggregation must not change accidentally"
    ]
  },
  "impactCoverage": {
    "totalUsages": 214,
    "calculationUsages": 47,
    "classifiedCalculationSinks": 39,
    "unclassifiedCalculationSinks": 8
  },
  "outputGroups": [
    {
      "output": "finalScore",
      "risk": "critical",
      "usageCount": 12,
      "path": ["calculateA", "normalizeInput", "computeScore", "rankResult"],
      "representativeEvidence": [
        { "file": "...", "symbol": "computeScore", "lines": "80-121" }
      ],
      "requiredTests": [
        "score boundary",
        "zero input",
        "rounding or precision",
        "ranking order unchanged"
      ]
    }
  ],
  "allowedFollowups": [
    {
      "reason": "classify remaining calculation sinks",
      "tool": "trace_dependencies",
      "args": { "cursor": "calc-impact:unclassified-sinks" }
    }
  ],
  "stopRule": "Do not implement until critical and high calculation sinks are classified."
}
```

### Classification Rules

Classify by output behavior, not by raw usage count:

- `critical`: runtime output, persisted value, external API response,
  ranking/order decision, validation gate, billing/payment-like decision, or
  control-flow threshold.
- `high`: internal calculation output consumed by critical path.
- `medium`: report, dashboard, analytics, or batch metric.
- `low`: tests, docs, generated code, logging-only, or display-only formatting.
- `unknown`: graph cannot classify the sink.

If any `critical`, `high`, or `unknown` calculation sink remains unclassified,
the packet must set `answerable=false`.

### Required Test Obligations

The pack should propose test obligations based on the detected contract:

- boundary values
- zero/null/negative values
- precision and rounding
- unit conversion
- ordering/ranking stability
- aggregation and grouping behavior
- min/max threshold behavior
- time window or duration boundary
- compatibility with persisted or API-visible output

### Implementation Steps

1. Add `riskMode` and `domainSignals` to `simulate_patch_impact` and
   `get_change_pack`.
2. Build a lightweight calculation signal detector for symbol names, file
   roles, task text, and operation hints.
3. Reuse call edges, field usages, dependency edges, endpoints, and tests to
   group downstream calculation sinks.
4. Return output groups with counts, representative paths, omitted counts, and
   exact follow-up cursors.
5. Add `answerable=false` when high-risk calculation sinks are not classified.
6. Add tests with Java/TypeScript fixture calculators, scorers, thresholds,
   and reporting-only usages.

### Pass Criteria

The Calculation Impact Pack passes only when:

- expected output groups are found;
- all critical/high calculation sinks are classified or explicitly marked
  unknown;
- unknown high-risk sinks force `answerable=false`;
- representative evidence includes file/symbol/line anchors;
- required test obligations are present;
- compact output has lower total tokens than full flat references after
  exact follow-ups.

## Build Order

1. Response Budget + Evidence Handles for `find_references` and
   `trace_dependencies`.
2. MCP Route Inspector + Benchmark Gate, using the new budget fields as gate
   inputs.
3. Calculation Impact Pack, because it depends on reliable grouping,
   follow-up handles, and gate semantics.

This order gives the route gate a real contract to validate before the more
domain-sensitive calculation mode lands.

## CLI Benchmark Plan

Build-time deterministic checks:

```powershell
npm.cmd run build
npm.cmd test -- --run tests/v2/mcp-client-profile.test.ts
npm.cmd test -- --run tests/v2/index-query.test.ts
```

All-tool benchmark after each feature:

```powershell
node dist/cli.js benchmark proof --root .tmp\perf-hadoop-common-20260619-125802 --tasks examples\context-proof-tasks.example.json
node dist/cli.js benchmark review --root .tmp\perf-hadoop-common-20260619-125802 --tasks examples\review-proof-tasks.example.json
```

Codex E2E dry run:

```powershell
node dist/cli.js benchmark codex-e2e --root .tmp\perf-hadoop-common-20260619-125802 --suite examples\codex-e2e-quality-suite.example.json --models gpt-5.3-codex-spark --modes compiled-packet,compiled-packet+gate --dry-run
```

Codex E2E non-dry-run, when the CLI model is available:

```powershell
node dist/cli.js benchmark codex-e2e --root .tmp\perf-hadoop-common-20260619-125802 --suite examples\codex-e2e-quality-suite.example.json --models gpt-5.3-codex-spark --modes baseline,mcp-first,compiled-packet,compiled-packet+gate --codex-timeout-seconds 300
```

The benchmark runner currently passes the model string to:

```text
codex exec --model <model>
```

So the CLI execution target for this plan is `gpt-5.3-codex-spark`.
If the local Codex CLI rejects that model string, treat it as an environment
or access failure, not a CodeGraph benchmark failure.

## Completion Checklist

- `route-inspect` or route-gate report exists and can prove no broad fallback
  after answerable packets.
- `find_references` and `trace_dependencies` have capped compact responses
  with counts and cursors.
- Calculation-sensitive changes return output groups, calculation contracts,
  classification coverage, and test obligations.
- Benchmarks record full tokens, returned tokens, follow-up tokens, and shell
  fallback tokens.
- E2E benchmark plan can run with `--models gpt-5.3-codex-spark`.
- Existing deterministic tests and build pass.
