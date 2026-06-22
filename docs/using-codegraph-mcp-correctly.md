# Using CodeGraph MCP Correctly

This guide explains how to get reliable answers from CodeGraph MCP during real coding work. It focuses on how to prompt the agent, when to trust the index, when to refresh it, and when to allow shell fallback. For the internal architecture, see [System Design](system-design.md). For Jira and Confluence ticket workflows, see [Ticket-Driven Agent Workflow](ticket-driven-agent-workflow.md).

## The Short Version

Do not use free-form `MCP-first` as the default for every task. In the
default/client MCP profile, ask CodeGraph to start with `codegraph_context`.
That facade routes to the right internal packet, then the agent should stop when
the packet says it is answerable.

```text
Use CodeGraph MCP. Start with codegraph_context.
Trace <target API/method/field/change>.
Include handlers, service calls, callers/callees, dependencies, tests, and risks as a quality rubric.
If answerable=true, do not search further; answer from the evidence ids.
Cite repository-relative files and methods.
```

For full-profile benchmark or audit runs, remove fallback and name the direct
tool intentionally:

```text
Use CodeGraph MCP compile_evidence only. Do not use shell/read/write/edit.
Return evidence-backed JSON with keyFiles, keySymbols, flow, risks, tests, and confidence.
```

Use shell or `rg` first for tiny repositories and broad tasks without a concrete
anchor. Use CodeGraph when it is likely to replace several search/read turns.

## Before You Ask Questions

Set up the repository once for the default MCP facade path:

```powershell
node dist/cli.js setup --root "<project>"
```

Run the MCP server with the same root:

```powershell
node dist/cli.js mcp --root "<project>"
```

Refresh the SQLite graph index when you need current callers, dependencies,
freshness checks, or lower-level graph tools:

```powershell
node dist/cli.js index --root "<project>" --workspace-key "<project-key>" --parse-workers 8
node dist/cli.js mcp --root "<project>" --workspace-key "<project-key>"
```

Java field usage indexing is enabled by default, so field-impact questions such as "where is `fieldA` read or written?" work after a normal index:

```powershell
node dist/cli.js index --root "<project>" --workspace-key "<project-key>" --parse-workers 8
node dist/cli.js mcp --root "<project>" --workspace-key "<project-key>"
```

If you need to trade away that quality for a colder large-repo run, you can opt out explicitly:

```powershell
$env:CODEGRAPH_ENABLE_FIELD_USAGES="0"
node dist/cli.js index --root "<project>" --workspace-key "<project-key>" --parse-workers 8
```

## Prompt Contract

Good prompts tell the agent four things:

| Part | What to include | Example |
| --- | --- | --- |
| Intent | The job you want done | `Trace the full API flow`, `Investigate impact`, `Review this diff` |
| Target | The exact route, class, method, field, file, error, or diff | `GET /ws/v1/cluster/apps`, `BlockReceiver.datanode` |
| Evidence | What must be included | `handler, request builder, service filtering, tests, risks` |
| Output | The shape of the answer | `Mermaid + bullets`, `findings first`, `compact JSON` |

Avoid vague prompts such as:

```text
Use MCP and explain this code.
```

Prefer:

```text
Use CodeGraph MCP first. Trace GET /ws/v1/cluster/apps from REST handler to request builder to service filtering.
Include applicationTags behavior, cache key, likely tests, and risks. Cite files/methods.
```

## Tool Choice

You usually do not need to remember tool names. The agent learns the available
tools from the MCP `initialize` instructions plus the active `tools/list`
descriptions. The default/client MCP profile intentionally exposes only the
facade tools (`codegraph_context`, `codegraph_slice`, `codegraph_status`) so the
agent starts with `codegraph_context` and drills down only when a packet names an
exact follow-up. Mention a first tool only when you want repeatable behavior or
when running with `--mcp-profile full`.

| Task | Default first tool | Internal/full-profile route | Why |
| --- | --- | --- |
| Answer-ready investigation, review, or planning | `codegraph_context` | `compile_evidence` | Returns an answerability certificate, compact evidence ids, missing coverage, allowed exact follow-ups, and stop rules. |
| API, RPC, handler, or method flow | `codegraph_context` | `get_flow_pack` | Returns entry point, flow steps, callers/callees, tests, and risk hints. |
| Bug, debug, fix, implementation, or refactor, even if it mentions flow | `codegraph_context` | `get_change_pack` | Produces scoped files, symbols, edit handles, tests, risks, and validation hints. |
| Broad investigation or architecture | `codegraph_context` | `get_research_pack` | Finds ranked symbols, files, evidence slices, and follow-up hints. |
| Implementation planning | `codegraph_context` | `get_change_pack` | Produces target files, symbols, tests, edit plan, and validation hints. |
| Code review | `codegraph_context` | `review_patch` | Builds findings, risky hunks, impacted tests, and follow-up slices from a diff. |
| Field, method, or constant impact | `codegraph_context`, then `codegraph_slice` if needed | `find_references` | Finds definitions, calls, imports, and field usages when enabled. |
| Exact source evidence | `codegraph_slice` after a packet | `get_file_slice` | Opens bounded file ranges after a pack has narrowed the context. |
| Dependency or dependent analysis | `codegraph_context` | `trace_dependencies` | Walks graph edges instead of broad text search. |
| Index health | `codegraph_status` | `get_index_stats` | Confirms counts, snapshot state, warnings, and freshness. |

Recommended default/client pattern:

```text
Use CodeGraph MCP. Start with codegraph_context for this task.
If answerable=true, answer from the packet and do not call more tools.
If missing is non-empty, use only allowedFollowups from the packet.
Do not open broad files or run broad shell search.
```

## Correct Workflows

### API Flow

```text
Use CodeGraph MCP first. Trace the full flow for <METHOD /path>.
Include the route/handler, request parsing, validation, service calls, downstream dependencies, response construction, tests, and risks.
Return a Mermaid flowchart plus key files/methods.
```

Expected quality:

- Names the endpoint handler and file.
- Shows ordered flow from entry point to service/dependency.
- Includes tests or test gaps.
- Separates confirmed evidence from assumptions.

### Field Impact

Use this after a normal index. Set `CODEGRAPH_ENABLE_FIELD_USAGES=0` only when you explicitly want to skip field facts.

```text
Use CodeGraph MCP first. Analyze impact of changing field <Class.field>.
Find definition, initialization, reads, writes, read-write updates, enclosing methods/classes, related calls, tests, and review risks.
Group usages by method and cite files.
```

Expected quality:

- Separates declaration, constructor/init writes, reads, and read-write updates.
- Groups usages by method or class.
- Identifies nearby call flow and likely tests.
- Hides low-confidence matches unless you ask for low-signal evidence.

### Bug Investigation

```text
Use CodeGraph MCP first. Investigate why <symptom> happens in <area/API/method>.
Trace the relevant flow, list evidence, identify likely root cause, affected tests, and safest fix.
Do not edit files yet.
```

Expected quality:

- Starts from likely entry points rather than broad search.
- Explains why each file matters.
- Gives a fix strategy with validation commands.

### Implementation

```text
Use CodeGraph MCP first to identify files and tests. Then implement <change>.
Keep the change minimal. Preserve existing behavior except for <desired behavior>.
Run focused tests or explain why they could not run.
```

Expected quality:

- Uses `get_change_pack` or equivalent before editing.
- Touches only relevant files.
- Adds or updates focused tests when behavior changes.
- Reports validation results.

### Code Review

```text
Use CodeGraph MCP. Review this diff for correctness, security, performance, compatibility, and missing tests.
Start with codegraph_context, then inspect only required follow-up slices. In full profile, review_patch is the direct route.
Findings first. Each finding must include severity, failure mode, affected file/method, and required test.

<diff>
```

Expected quality:

- Findings lead the answer.
- No unsupported claims.
- Maps the diff to impacted flow and tests.
- Calls out missing tests as a concrete risk.

## Freshness Rules

CodeGraph queries read completed snapshots. That is good for consistency, but it means the snapshot must match the checkout you are asking about.

| Situation | Correct action |
| --- | --- |
| First time indexing a repo | Run explicit `index --root ...`. |
| Small local edit | Run MCP with `--watch`, or ask with `autoRefresh: true`. |
| Single file delete | Use `--watch` or run `index --root ...`; path-delta refresh removes deleted rows. |
| Large branch checkout | Run explicit `index --root ...` after checkout. |
| Pull, rebase, generated-file burst | Run explicit `index --root ...` before relying on answers. |
| Two branches at once | Use two worktrees or clones with different workspace keys. |
| Container `/workspace` mount | Always set a stable `CODEGRAPH_WORKSPACE_KEY`. |

Good prompt after a checkout:

```text
I just checked out a new branch. Use CodeGraph MCP only after confirming the index snapshot is fresh.
If it is stale, tell me to run a full index instead of answering from stale evidence.
```

## MCP Vs Shell

Use MCP-first for large repositories. Shell fallback is still useful, but only after MCP narrows the search.

| Mode | Use when | Prompt prefix |
| --- | --- | --- |
| MCP only | Benchmarking, auditing tool quality, avoiding token-heavy raw file reads | `Use CodeGraph MCP only. Do not use shell/read/write/edit.` |
| MCP first with shell fallback | Normal engineering work | `Use CodeGraph MCP first. Use shell only if CodeGraph evidence is missing.` |
| Shell only | Testing baseline behavior or when no index exists | `Do not use CodeGraph MCP. Use shell/search/read commands only.` |

If the agent opens many files before using a pack tool, the prompt is too loose. Ask it to restart with MCP-first and bounded source slices.

## Verify MCP Was Used

Ask a direct check:

```text
Use CodeGraph MCP get_index_stats and tell me the indexed file count.
```

Then inspect logs:

```powershell
node dist/cli.js logs --tail 50
```

A successful MCP query writes log entries with `toolName`, `durationMs`, and response-size telemetry.

## Quality Checklist

A good CodeGraph-assisted answer should include:

- Repository-relative files and method/class names.
- A clear flow or dependency path, not just a list of files.
- Tests or test gaps.
- Risks and confidence.
- Follow-up tool calls only when evidence is missing.
- A note when the index is stale or field usage indexing was not enabled.

A weak answer usually has one of these problems:

- It uses broad shell search first on a large repo.
- It cites files without explaining why they matter.
- It answers a field-impact question without read/write/init classification.
- It gives conclusions without tests or validation hints.
- It ignores branch checkout or local edit freshness.

## Troubleshooting Bad Answers

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Agent does not call MCP | Prompt did not require MCP, or MCP client is not configured | Ask for `get_index_stats`; check `.codegraph/logs/query.jsonl`. |
| Answer references old branch | Snapshot is stale | Run explicit `index --root ...` with the same workspace key. |
| Field impact lacks read/write/init | Field usage indexing was explicitly disabled before indexing | Re-index normally, or unset `CODEGRAPH_ENABLE_FIELD_USAGES`, or set it to `1`. |
| Too many tokens | Agent opened broad files or used large dependency output | Ask for one pack tool first and bounded `get_file_slice` calls only. |
| Review answer is slower than shell | Agent used MCP and then unnecessary shell fallback | Use `MCP only` for review benchmarks, or require `review_patch` plus bounded slices. |
| Container repo has no files | Bind mount is wrong | Check `/workspace` in the container and rerun index. |

## Copy-Paste Starters

```text
Use CodeGraph MCP first. Trace full flow for <API>. Include handler, service, dependencies, tests, risks, and Mermaid.
```

```text
Use CodeGraph MCP first. Analyze impact of changing <Class.field>. Include definition, reads, writes, init, enclosing methods, related calls, tests, and risks.
```

```text
Use CodeGraph MCP first. Investigate <symptom>. Return evidence, likely root cause, affected tests, and safest fix strategy.
```

```text
Use CodeGraph MCP. Review this diff. Findings first with severity, failure mode, impacted flow, affected tests, and fix.
```

```text
Use CodeGraph MCP first to identify target files and tests. Then implement <change>. Keep the change minimal and run focused tests.
```
