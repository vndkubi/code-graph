# CodeGraph Benchmark Results

This document records the latest local benchmark results for CodeGraph indexing and real-agent MCP usage. The goal is to show when CodeGraph MCP improves agent workflow performance, token use, tool calls, and answer quality compared with baseline shell search.

## Summary

The benchmark compared Codex CLI baseline shell/search behavior against Codex CLI with CodeGraph MCP on the Hadoop project copy.

Aggregate result across three representative tasks:

| Metric | Baseline shell/search | CodeGraph MCP-first | Change |
| --- | ---: | ---: | ---: |
| Total agent wall time | `444.7s` | `235.8s` | `47.0%` faster |
| Input tokens | `3,818,267` | `834,162` | `78.2%` lower |
| Output tokens | `33,492` | `17,370` | `48.1%` lower |
| MCP tool calls | `0` | `16` | MCP used for graph context |
| Shell calls | `128` | `10` | `92.2%` lower |

Main conclusion:

- CodeGraph MCP is strongest for investigation and flow tracing in large repositories because it avoids repeated raw file reads.
- Field usage indexing improves field-impact questions by returning definition, initialization, reads, enclosing methods, related calls, and tests.
- Review tasks can still fall back to shell if the prompt allows it; `review_patch` quality improved, but total wall time was slower in this run because the agent still made shell calls after MCP.

## Environment

| Item | Value |
| --- | --- |
| Date | 2026-06-01 |
| CodeGraph branch | `codex/answer-ready-flow-pack` |
| Source repository | Hadoop project copy |
| Source state | Dirty working tree with `95` deleted files before benchmark |
| Runtime | Windows, local Node.js, local Postgres |
| Model | `gpt-5.4-mini` |
| Reasoning | `medium` |
| Codex mode | `codex exec --json --ephemeral --ignore-user-config --ignore-rules --dangerously-bypass-approvals-and-sandbox` |
| Field usage indexing | Enabled with `CODEGRAPH_ENABLE_FIELD_USAGES=1` |
| Parse workers | `8` |
| Token source | Actual Codex CLI `turn.completed.usage` event fields |
| Quality score | Heuristic expected-file and expected-term hit rate in final answer |

The benchmark used a copied Hadoop checkout instead of the clean main Hadoop checkout. Treat these numbers as a local workflow benchmark, not a canonical clean-repository index benchmark.

## Reproducible Codex E2E Runner

The repository includes a tracked Hadoop task suite at `examples/codex-e2e-quality-suite.example.json` and a CLI runner:

```powershell
node dist/cli.js benchmark codex-e2e `
  --suite examples/codex-e2e-quality-suite.example.json `
  --root "<hadoop-project>" `
  --workspace-key hadoop-project `
  --run-dir ".tmp/codex-e2e-hadoop" `
  --modes baseline,mcp-first,mcp-only `
  --models gpt-5.4-mini `
  --parse-workers 8
```

Runner behavior:

- `baseline`: tells Codex not to use CodeGraph MCP and allows shell/search/read.
- `mcp-first`: tells Codex to use CodeGraph MCP first and shell only when evidence is missing.
- `mcp-only`: tells Codex to use CodeGraph MCP only, which isolates MCP answer quality.
- Captures cold index result, index progress events, raw Codex JSONL, stderr, wall time, MCP calls, shell calls, token usage, final output, and heuristic quality score.
- Reads actual Codex `usage` events when present and falls back to `ceil(chars / 4)` estimates only when usage is missing.

On the current Windows machine, `codex.exe` was discovered under WindowsApps but returned `Access denied`. The working path is to invoke the published CLI through `npx` via `cmd.exe`, which avoids the WindowsApps policy wrapper.

WindowsApps workaround:

```powershell
node dist/cli.js benchmark codex-e2e `
  --suite examples/codex-e2e-quality-suite.example.json `
  --root "<hadoop-project>" `
  --workspace-key hadoop-project `
  --run-dir ".tmp/codex-e2e-hadoop" `
  --modes baseline,mcp-first,mcp-only `
  --models gpt-5.4-mini `
  --codex-command cmd.exe `
  --codex-command-args "/d,/c,npx.cmd,-y,@openai/codex" `
  --parse-workers 8
```

This bypass was smoke-tested with `npx.cmd -y @openai/codex exec --json ... "Return exactly OK."`; Codex returned `OK` and actual usage fields.

The runner now injects CodeGraph MCP config through Codex `--config` overrides, sends the prompt through stdin, and configures the benchmark MCP server with `--no-prewarm`. That keeps indexing as a separate benchmark phase: if a snapshot is missing during `--no-index`, the agent phase fails fast instead of silently starting a full index inside a tool call.

## Architecture Overlay Experiment

A Repowise-inspired persistent architecture overlay was implemented behind `CODEGRAPH_ENABLE_GRAPH_OVERLAY=1`. The overlay materializes `graph_nodes` and `graph_edges` from completed snapshot facts and lets pack tools add optional architecture context.

The first Hadoop overlay benchmark did not meet the performance gate:

| Run | Result |
| --- | --- |
| Default overlay attempt | Timed out after `25m`; Postgres was still aggregating `call_edges` to `symbols`. |
| Deduped aggregate attempt | Timed out after `35m`; Postgres was still grouping primary/provider call edges. |

Decision:

- Do not enable the overlay by default.
- Keep `CODEGRAPH_ENABLE_GRAPH_OVERLAY=1` as an opt-in experiment.
- Query tools and graph export fall back to existing behavior when overlay rows are absent.
- The next optimization was implemented: sharded full indexing now records file-pair call aggregates while streaming resolved raw call shards, and the overlay builder uses those small aggregates instead of scanning persisted `call_edges`.
- `CODEGRAPH_GRAPH_OVERLAY_DB_CALL_AGGREGATE=1` can still force the old DB aggregate for experiments, but it is not the default.

Follow-up measurement note:

- The post-fix overlay benchmark must use an isolated database to stay truly cold. A warm retry on the previous benchmark DB hit a separate parse-cache fallback memory limit before reaching overlay because the aborted run had already populated `parse_cache`.

Post-fix measurement on the Hadoop project:

| Run | Result |
| --- | ---: |
| Sharded full with streaming call aggregates, cold-ish parse cache misses | `17m04s` total; overlay phase `17.1s`; `45,719` graph nodes; `47,967` graph edges |
| Sharded full from parse cache hits, overlay enabled, full bulk index rebuild disabled to avoid local lock contention | `6m03s` total; overlay phase `13.0s`; `45,719` graph nodes; `47,984` graph edges |

The overlay phase is no longer the `25m+` bottleneck. It remains opt-in until a clean cold run also meets the default full-index gate.

## Full-Mode MCP And Codex Smoke

The original failure mode for Codex full-mode testing was not just model time. The MCP proxy performed daemon startup and workspace prewarm before the stdio handshake, so Codex could fail to see tools or time out while a large repository started indexing. The MCP proxy now handshakes immediately and initializes the daemon/workspace lazily on the first tool call.

Warm full snapshot rebuild used for the smoke test:

| Metric | Value |
| --- | ---: |
| Total index time | `6m03s` |
| Files total | `14,082` |
| Files parsed | `0` |
| Parse cache hits | `14,082` |
| Parse-cache hydrate | `69.6s` |
| Call edge resolution | `11.2s` |
| Fact COPY | `203.5s` |
| Call edge COPY | `97.1s` |
| Symbols COPY | `76.5s` |
| Call search index rebuild | `26.9s` |
| Dependency rebuild | `6.3s` |
| Graph overlay rebuild | `13.0s` |
| Call edges | `1,186,425` |

Codex MCP-only smoke after the lazy MCP startup fix:

| Task | Mode | Time | Input tokens | Cached input | Output tokens | Reasoning tokens | MCP calls | Shell calls | Quality |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `api-flow-yarn-apps` | MCP-only | `119.1s` | `212,452` | `172,160` | `5,205` | `2,435` | `5` | `0` | `90.9%` |

Tools used: `get_flow_pack`, `explain_endpoint`, `get_callees` twice, and `find_tests_for`. The answer identified `RMWebServices.getApps`, `ApplicationsRequestBuilder`, `AppsCacheKey`, `LRUCache`, `DeSelectFields`, likely tests, and the `applicationTags` query parameter. The only expected heuristic miss was `withApplicationTags`.

## Index Benchmark

Command shape:

```powershell
$env:CODEGRAPH_ENABLE_FIELD_USAGES="1"
node dist/cli.js index `
  --root "<hadoop-project-copy>" `
  --workspace-key hadoop-copy-field-bench `
  --parse-workers 8
```

Final index result:

| Metric | Value |
| --- | ---: |
| Total index time | `15m57.6s` |
| Files total | `13,987` |
| Files parsed | `13,987` |
| Parse cache hits | `0` |
| Parse workers | `8` |
| Provider | `tree-sitter` |
| Provider version | `tree-sitter-analyzer-v9-field-usages` |
| Symbols | `323,077` |
| Type refs | `298,956` |
| Field usages | `382,483` |
| Call edges | `1,183,062` |
| Dependency edges | `66,100` |
| Endpoints | `279` |
| COPY fallbacks | `0` |
| COPY errors | `0` |

Important phases:

| Phase | Time |
| --- | ---: |
| Manifest scan | `1.7s` |
| Parse worker phase | `445.1s` |
| Parse context build | `0.6s` |
| Parse cache COPY | `357.0s` |
| Call edge resolution | `6.8s` |
| Field usage COPY | `7.9s` |
| Call edge COPY | `23.2s` |
| Symbols COPY | `19.1s` |
| Dependency rebuild | `2.9s` |
| Full bulk index rebuild | `54.7s` |

Interpretation:

- Field usage COPY itself is not the bottleneck at `7.9s`.
- The expensive phases remain cold parsing and full `parse_cache.parse_json` COPY.
- Field usage indexing adds useful query capability but still increases total cold index cost compared with the non-field baseline, so it remains opt-in.

## Real-Agent Task Matrix

Each task ran twice:

- `baseline`: Codex was told not to use CodeGraph MCP and could use shell/search/read commands.
- `mcp`: Codex was told to use CodeGraph MCP first and use shell only if MCP evidence was missing.

| Task | Purpose | Expected evidence |
| --- | --- | --- |
| `api-flow` | Trace `GET /ws/v1/cluster/apps` through Hadoop YARN REST handling. | `RMWebServices`, `ApplicationsRequestBuilder`, `ClientRMService`, `applicationTags`, likely tests. |
| `field-impact` | Investigate impact of changing `BlockReceiver.datanode`. | Definition, constructor initialization, reads, methods/classes, related calls, likely tests. |
| `review-diff` | Review a patch that drops `applicationTags` by passing `Collections.emptySet()`. | Correctness finding, impacted flow, missing endpoint-level test. |

## Agent Metrics By Task

| Task | Mode | Time | Input tokens | Cached input | Output tokens | Reasoning tokens | MCP calls | Shell calls | Quality |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `api-flow` | baseline | `265.5s` | `3,018,876` | `2,886,656` | `17,219` | `6,544` | `0` | `85` | `85.7%` |
| `api-flow` | MCP-first | `69.0s` | `257,738` | `215,936` | `5,860` | `2,720` | `7` | `0` | `85.7%` |
| `field-impact` | baseline | `107.6s` | `410,118` | `341,376` | `10,281` | `5,877` | `0` | `22` | `100%` |
| `field-impact` | MCP-first | `74.8s` | `206,461` | `161,792` | `6,722` | `3,494` | `6` | `0` | `100%` |
| `review-diff` | baseline | `71.5s` | `389,273` | `342,912` | `5,992` | `3,123` | `0` | `21` | `71.4%` |
| `review-diff` | MCP-first | `92.0s` | `369,963` | `305,792` | `4,788` | `2,693` | `3` | `10` | `85.7%` |

## Per-Task Deltas

| Task | Time change | Input token change | Output token change | Tool-call change | Quality change |
| --- | ---: | ---: | ---: | --- | ---: |
| `api-flow` | `74.0%` faster | `91.5%` lower | `66.0%` lower | `85` shell calls to `7` MCP calls | unchanged |
| `field-impact` | `30.5%` faster | `49.7%` lower | `34.6%` lower | `22` shell calls to `6` MCP calls | unchanged |
| `review-diff` | `28.6%` slower | `5.0%` lower | `20.1%` lower | `21` shell calls to `3` MCP + `10` shell calls | `14.3pp` higher |

## MCP Tool Usage

| Task | MCP tools used |
| --- | --- |
| `api-flow` | `get_flow_pack`, `get_file_slice`, `find_tests_for`, `trace_dependencies`, `search_symbol`, `get_file_slice`, `get_file_slice` |
| `field-impact` | `get_research_pack`, `find_references`, `get_file_slice`, `get_file_slice`, `find_tests_for`, `find_references` |
| `review-diff` | `review_patch`, `find_tests_for`, `find_tests_for` |

MCP query latency from daemon telemetry, excluding the smoke-test `get_index_stats` call:

| Metric | Value |
| --- | ---: |
| Query count | `16` |
| Min latency | `7ms` |
| Average latency | `382.2ms` |
| p95 latency | `1,919ms` |
| Max latency | `1,919ms` |
| Total MCP response chars | `233,673` |

The slowest MCP call in this run was `review_patch` at `1,919ms`. The field reference call for `BlockReceiver.datanode` was approximately `1,003ms`, close to the target for exact field usage queries on a large snapshot.

## Prompts

### API Flow

Baseline prompt:

```text
Do not use CodeGraph MCP. Use shell/search/read commands only as needed. Do not modify files. Trace the Hadoop YARN REST API GET /ws/v1/cluster/apps. Include handler, query params states/limit/applicationTags, request builder/service filtering, dependencies, and likely tests. Return valid compact JSON only with keys task,keyFiles,methods,flow,dependencies,tests,risks,confidence. Cite repository-relative files.
```

MCP prompt:

```text
Use CodeGraph MCP server codegraph_hadoop first. Choose the best CodeGraph MCP tools yourself. Use shell only if MCP evidence is missing. Do not modify files. Trace the Hadoop YARN REST API GET /ws/v1/cluster/apps. Include handler, query params states/limit/applicationTags, request builder/service filtering, dependencies, and likely tests. Return valid compact JSON only with keys task,keyFiles,methods,flow,dependencies,tests,risks,confidence. Cite repository-relative files.
```

Expected output quality:

- Names `RMWebServices.getApps`.
- Connects the request builder and service filtering.
- Includes `applicationTags`.
- Includes likely tests.
- Cites repository-relative files.

### Field Impact

Baseline prompt:

```text
Do not use CodeGraph MCP. Use shell/search/read commands only as needed. Do not modify files. Investigate impact of changing the Java field BlockReceiver.datanode in Hadoop. Where is it initialized, read, or used in methods/classes/flow? Include access kind when known, related calls/dependencies, review risks, and likely tests. Return valid compact JSON only with keys task,field,definitions,usagesByMethod,flow,risks,tests,confidence. Cite repository-relative files.
```

MCP prompt:

```text
Use CodeGraph MCP server codegraph_hadoop first. Choose the best CodeGraph MCP tools yourself. Use shell only if MCP evidence is missing. Do not modify files. Investigate impact of changing the Java field BlockReceiver.datanode in Hadoop. Where is it initialized, read, or used in methods/classes/flow? Include access kind when known, related calls/dependencies, review risks, and likely tests. Return valid compact JSON only with keys task,field,definitions,usagesByMethod,flow,risks,tests,confidence. Cite repository-relative files.
```

Expected output quality:

- Identifies `BlockReceiver.datanode`.
- Separates field declaration, constructor parameter, and initialization.
- Groups uses by method.
- Mentions `getDataNode`, `DataNode`, and metrics/dataset/config interactions.
- Includes likely tests and review risks.

### Review Diff

Baseline prompt:

```text
Do not use CodeGraph MCP. Use shell/search/read commands only as needed. Do not modify files. Review this Hadoop patch for correctness and missing tests. Return valid compact JSON only with keys status,topFindings,impactedFlow,tests,confidence. Cite repository-relative files.

diff --git a/hadoop-yarn-project/hadoop-yarn/hadoop-yarn-server/hadoop-yarn-server-resourcemanager/src/main/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/RMWebServices.java b/hadoop-yarn-project/hadoop-yarn/hadoop-yarn-server/hadoop-yarn-server-resourcemanager/src/main/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/RMWebServices.java
--- a/hadoop-yarn-project/hadoop-yarn/hadoop-yarn-server/hadoop-yarn-server-resourcemanager/src/main/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/RMWebServices.java
+++ b/hadoop-yarn-project/hadoop-yarn/hadoop-yarn-server/hadoop-yarn-server-resourcemanager/src/main/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/RMWebServices.java
@@
-                    .withApplicationTags(applicationTags)
+                    .withApplicationTags(java.util.Collections.emptySet())
                     .build();
```

MCP prompt:

```text
Use CodeGraph MCP server codegraph_hadoop first. Choose the best CodeGraph MCP tools yourself. Use shell only if MCP evidence is missing. Do not modify files. Review this Hadoop patch for correctness and missing tests. Return valid compact JSON only with keys status,topFindings,impactedFlow,tests,confidence. Cite repository-relative files.

diff --git a/hadoop-yarn-project/hadoop-yarn/hadoop-yarn-server/hadoop-yarn-server-resourcemanager/src/main/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/RMWebServices.java b/hadoop-yarn-project/hadoop-yarn/hadoop-yarn-server/hadoop-yarn-server-resourcemanager/src/main/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/RMWebServices.java
--- a/hadoop-yarn-project/hadoop-yarn/hadoop-yarn-server/hadoop-yarn-server-resourcemanager/src/main/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/RMWebServices.java
+++ b/hadoop-yarn-project/hadoop-yarn/hadoop-yarn-server/hadoop-yarn-server-resourcemanager/src/main/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/RMWebServices.java
@@
-                    .withApplicationTags(applicationTags)
+                    .withApplicationTags(java.util.Collections.emptySet())
                     .build();
```

Expected output quality:

- Flags the dropped `applicationTags` filter.
- Explains the impacted `/ws/v1/cluster/apps` flow.
- Points to `RMWebServices.java`.
- Mentions missing endpoint-level tests.

## Output Quality Observations

### API Flow

Both modes found the main flow. MCP used zero shell calls and still returned the handler, builder, service dependency, and tests. MCP also included `TestRMWebServices.java`, which the baseline final answer did not include in the expected-file hit list.

### Field Impact

Both modes produced high-quality answers, but MCP used half the input tokens and avoided raw shell search. The MCP answer used the new field usage index through `find_references`, returning field declaration, constructor assignment, read usages grouped by method, related calls, and likely tests.

### Review Diff

Both modes found the correctness bug. MCP produced a stronger answer by explicitly tying the change to `GET /ws/v1/cluster/apps`, cache/filter behavior, and missing endpoint-level tests. It was slower because the agent still used 10 shell calls after `review_patch`.

## Limitations

- This is a single-run benchmark, not a statistically repeated suite.
- The Hadoop project copy had a dirty working tree with deleted files, so counts differ from a clean checkout.
- The quality score is a deterministic expected-file and expected-term heuristic, not a human review score.
- Codex model behavior can change over time and may choose different tools on later runs.
- MCP-first prompts allowed shell fallback; strict MCP-only runs may produce different review timing.
- Raw event JSONL and final outputs were stored under `.tmp/` locally and are not committed.

## Follow-Up Work

Recommended next measurements:

- Re-run on a clean Hadoop checkout with the same benchmark suite.
- Add a strict MCP-only review run to isolate `review_patch` quality without shell fallback.
- Repeat each task at least three times and report median/p95.
- Tune `review_patch` evidence so the agent does not need extra shell calls.
- Continue optimizing cold index bottlenecks: parse worker time and full `parse_cache.parse_json` COPY.

## Related Documents

- [System Design](system-design.md)
- [Using CodeGraph MCP Correctly](using-codegraph-mcp-correctly.md)
- [CodeGraph Prompt Guide](prompt-guide.md)
