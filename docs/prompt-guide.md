# CodeGraph Prompt Guide

This guide gives copy-paste prompt patterns for using CodeGraph MCP without memorizing every tool name. For workflow rules, freshness behavior, MCP-vs-shell guidance, and quality checks, see [Using CodeGraph MCP Correctly](using-codegraph-mcp-correctly.md).

## Core Pattern

Start with intent, target, expected output, and constraints:

```text
Use CodeGraph MCP. <Task intent> for <target>.
Include <required evidence>.
Do not edit files unless I explicitly ask.
Return <format>.
```

Good CodeGraph prompts usually name:

| Field | Examples |
| --- | --- |
| Target | API route, method, class, file, package, symbol, diff, error message |
| Intent | trace flow, investigate bug, plan implementation, review patch, find tests |
| Evidence | handlers, service methods, callers, callees, cache keys, tests, config, database/client calls |
| Output | summary, Mermaid flow, findings, implementation plan, checklist, JSON |
| Constraints | read-only, no shell, no edits, cite files/methods, keep answer short |

You do not need to name a specific CodeGraph tool. The agent should choose the right MCP tool from the task. If a task is critical or broad, add a first-tool hint from the examples below.

## Prompt Prefixes

Use one of these prefixes:

```text
Use CodeGraph MCP first. Use shell only if CodeGraph says evidence is missing.
```

```text
Use CodeGraph MCP only. Do not use shell/read/write/edit.
```

```text
Use CodeGraph MCP. Start with the best graph pack for this task, then use follow-up tools only for missing evidence.
```

Use "MCP only" for benchmark runs. For normal engineering work, allow shell as a fallback after CodeGraph has narrowed the search.

## API Flow

Use this when you know an endpoint, route, controller, REST method, RPC method, or handler.

```text
Use CodeGraph MCP. Trace the full flow for API <METHOD /path>.
Include the route/handler, request parsing, validation, service calls, downstream clients or storage calls, cache keys, response construction, tests, and likely failure points.
Draw a Mermaid flowchart and cite concrete files/methods.
```

Stronger version:

```text
Use CodeGraph MCP. Start with get_flow_pack for <METHOD /path or handler symbol>.
Trace handler -> request object -> service layer -> downstream dependencies -> response.
Include tests and risks. Return a Mermaid flowchart plus a short explanation.
```

Example:

```text
Use CodeGraph MCP. Trace the full flow for GET /ws/v1/cluster/apps with states, limit, and applicationTags.
Include RMWebServices, request builder, ClientRMService, cache key, filtering order, tests, and risks.
Draw a Mermaid flowchart and cite files/methods.
```

## Bug Investigation

Use this for regressions, production symptoms, wrong output, slow behavior, or "why does this happen?"

```text
Use CodeGraph MCP first. Investigate this bug:
<symptom or error>

Find the likely root cause, trace the relevant flow, list affected files/methods, identify tests that should cover it, and propose the safest fix strategy.
Do not edit files yet.
```

If the bug is tied to an endpoint:

```text
Use CodeGraph MCP. Investigate why <API> returns <wrong behavior>.
Trace the request flow, filter/order/cache behavior, service calls, and tests.
Return findings ordered by likelihood with concrete evidence.
```

## Implementation Planning

Use this before coding a feature or refactor.

```text
Use CodeGraph MCP. Build an implementation plan for <feature/change>.
Cover public API surface, request/response models, service logic, storage/client calls, compatibility risks, tests, and validation commands.
Distinguish what already exists in this checkout from what must be added.
Do not edit files yet.
```

Stronger version:

```text
Use CodeGraph MCP. Start with get_change_pack for <feature/change>.
Return a step-by-step implementation plan with target files, symbols to modify, likely tests, risks, and validation commands.
```

## Direct Implementation

Use this when you want the agent to edit code.

```text
Use CodeGraph MCP first to identify the right files and tests. Then implement <change>.
Keep the change minimal. Preserve existing behavior except for <desired behavior>.
Run the focused tests or explain why they could not run.
```

For safer large changes:

```text
Use CodeGraph MCP to create an edit plan first. After the plan, implement it.
Touch only files needed for <change>. Add or update focused tests. Do not refactor unrelated code.
```

## Code Review

Use this for a diff, PR, patch, or local changes.

```text
Use CodeGraph MCP. Review this patch for correctness, security, performance, compatibility, and missing tests.
Findings first. Each finding must include severity, concrete failure mode, affected file/method, and required test.
Do not make unsupported claims.

<paste diff or describe changed files>
```

Stronger version:

```text
Use CodeGraph MCP. Start with review_patch for this diff, then inspect only the required follow-up slices.
Return findings first, ordered by severity. If there are no issues, say so and list residual test gaps.

<paste diff>
```

## Spec Or Requirements Work

Use this when converting an idea, ticket, or spec into engineering tasks.

```text
Use CodeGraph MCP. Turn this requirement into an implementation-ready spec:
<requirement>

Map the requirement to existing files, symbols, APIs, tests, data models, and risks.
Return acceptance criteria, non-goals, open questions, and a phased implementation plan.
```

## Test Planning

Use this when you need the right tests for a change.

```text
Use CodeGraph MCP. Find the focused tests for <feature/method/API>.
Include existing test files, missing cases, fixtures or mocks to reuse, and exact validation commands.
```

For changed files:

```text
Use CodeGraph MCP. Given these changed files, find impacted tests and test gaps:
<files>

Return a small test plan ordered by confidence and cost.
```

## Find References, Callers, And Impact

Use this when you know a class, method, field, or constant.

```text
Use CodeGraph MCP. Find where <symbol> is defined, referenced, and called.
Separate direct callers, likely dynamic/interface callers, tests, and generated or low-signal matches.
Return the top risky dependents first.
```

For change impact:

```text
Use CodeGraph MCP. Analyze impact of changing <symbol/file/API>.
Include direct callers, transitive dependents, tests, external API exposure, and migration risks.
```

## Architecture Or Onboarding

Use this to learn a subsystem.

```text
Use CodeGraph MCP. Explain the architecture of <subsystem/package>.
Start from entry points and key abstractions. Include the main files, data flow, extension points, tests, and common pitfalls.
Keep it practical for a developer who needs to make a change.
```

## Performance Investigation

Use this for slow paths, heavy queries, or batch jobs.

```text
Use CodeGraph MCP. Investigate performance risks in <flow/method/job>.
Trace loops, database/client calls, caches, concurrency, batching, and tests.
Return bottleneck hypotheses with evidence and safe measurement steps.
```

## Security Review

Use this for auth, input validation, injection, secrets, unsafe IO, or sensitive data.

```text
Use CodeGraph MCP. Security-review <API/method/diff>.
Trace input sources to sensitive sinks, auth checks, validation, logging, storage/client calls, and tests.
Findings first with severity, exploit preconditions, affected files/methods, and required fix/tests.
```

## Branch Checkout Or Local Edit Freshness

Use this after switching branches or editing files.

```text
Use CodeGraph MCP. Check whether the index is fresh for this workspace before answering.
If the workspace looks stale, say what needs to be refreshed and do not rely on stale evidence.
```

For large branch changes:

```text
I just checked out a different branch. Use CodeGraph MCP only after confirming the index snapshot matches this branch.
If it does not match, tell me to run a full index.
```

For small local edits:

```text
I edited <file>. Use CodeGraph MCP with freshness checks. If that file is stale, read or refresh only the changed path before answering.
```

## Output Formats

### Short Answer

```text
Use CodeGraph MCP. Answer in 5 bullets max. Cite files/methods only where needed.
```

### Mermaid Flow

```text
Use CodeGraph MCP. Return:
1. One Mermaid flowchart.
2. A short step-by-step explanation.
3. Key files/methods.
4. Risks and tests.
```

### Implementation Checklist

```text
Use CodeGraph MCP. Return a checklist grouped by files to change, tests to add, validation commands, and risks.
```

### Machine-Readable JSON

```text
Use CodeGraph MCP. Return valid compact JSON only with keys:
target, summary, keyFiles, keySymbols, flowSteps, risks, tests, confidence.
```

## When To Mention A Tool Name

Most prompts should not mention tool names. Mention a first tool only when you want repeatable benchmark behavior or the task is broad.

| If the task is... | Optional first-tool hint |
| --- | --- |
| API or method flow | `Start with get_flow_pack.` |
| Feature implementation or refactor | `Start with get_change_pack.` |
| Broad investigation | `Start with get_research_pack.` |
| Code review with a diff | `Start with review_patch.` |
| Exact symbol lookup | `Use search_symbol only if the pack misses the symbol.` |
| Exact source quote needed | `Use get_file_slice after the pack identifies the file.` |

## Anti-Patterns

Avoid prompts like:

```text
Use CodeGraph somehow.
```

This gives the agent too much tool-selection freedom.

Avoid:

```text
Search the repo for everything related to apps.
```

This encourages broad text search instead of graph-first context.

Prefer:

```text
Use CodeGraph MCP. Trace GET /ws/v1/cluster/apps from REST handler to service filtering and cache key. Cite concrete files/methods.
```

Avoid asking for final conclusions without evidence:

```text
Why is this broken?
```

Prefer:

```text
Use CodeGraph MCP. Investigate why <symptom> happens. Return evidence, likely root cause, affected tests, and safest fix.
```

## Minimal Cheat Sheet

| You want... | Prompt |
| --- | --- |
| API flow | `Use CodeGraph MCP. Trace full flow for <API>. Include handler, service, dependencies, tests, and Mermaid.` |
| Bug root cause | `Use CodeGraph MCP first. Investigate <symptom>. Return evidence, root cause, tests, and fix strategy.` |
| Implementation plan | `Use CodeGraph MCP. Plan implementation for <feature>. Cover files, symbols, tests, compatibility, validation.` |
| Code review | `Use CodeGraph MCP. Review this diff. Findings first with severity, failure mode, file/method, tests.` |
| Test plan | `Use CodeGraph MCP. Find focused tests for <change>. Include gaps and commands.` |
| Impact analysis | `Use CodeGraph MCP. Analyze impact of changing <symbol>. Include callers, dependents, tests, risks.` |
| Architecture | `Use CodeGraph MCP. Explain <subsystem> architecture with entry points, key abstractions, tests, pitfalls.` |
