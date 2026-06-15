# CodeGraph Benchmark Results

This document records the current benchmark evidence for the no-daemon, per-repository SQLite refactor.

Runtime under test:

- Branch/worktree: `D:\Personal\Projects\code-graph`
- Backend: `.codegraph/graph.sqlite`
- Date: 2026-06-16 Asia/Saigon
- Token estimator for deterministic proof harnesses: `ceil(character_count / 4)`
- Agent E2E runners: dry-run only in this pass; no paid/model agent run was executed.

## Validation Gates

| Gate | Result |
| --- | --- |
| `npm.cmd run lint` | pass |
| `npm.cmd run build` | pass |
| `npm.cmd test` | pass, 7 files / 64 tests |
| JSON example parse | pass for `examples/developer-mcp-prompt-suite.example.json` |
| PowerShell script parse | pass for Copilot E2E, real-repo compare, review proof, repo atlas scripts |

## CLI And Feature Smoke

| Feature | Command | Result |
| --- | --- | --- |
| Setup | `node dist/cli.js setup --root . --quiet` | SQLite backend, 74 files, 74 parse-cache hits, 607 ms warm setup |
| Doctor | `node dist/cli.js doctor --root .` | `backend: sqlite`, artifact ready, database ready |
| Atlas | `node dist/cli.js atlas --root . --format json --profile compact --max-modules 5 --max-entrypoints 5` | generated repo atlas from SQLite facts |
| Graph export | `node dist/cli.js graph --root . --out .codegraph/graph.html --no-index` | 800 nodes, 2000 edges, truncated static graph |
| Logs | `node dist/cli.js logs --root . --tail 5` | no query log yet when no MCP tool call has been made |
| MCP stdio | SDK client over `node dist/cli.js mcp --root . --no-prewarm` | 28 tools, `codegraph_status` call returned non-error text content |

`logs` reads `.codegraph/logs/query.jsonl`, which is created by MCP tool calls. Direct CLI benchmarks do not necessarily create that log.

## Index Benchmark

Command:

```powershell
node dist/cli.js benchmark index --root .
```

Result:

| Metric | Value |
| --- | ---: |
| Files total | 74 |
| Files parsed | 74 |
| Parse cache hits | 0 |
| Files hashed | 28 |
| Hash cache hits | 46 |
| Manifest scan | 130 ms |
| Index time | 3065 ms |
| Parse workers | 7 |
| Peak RSS | 151 MB |
| Provider | `tree-sitter` |

Important fix from this benchmark pass: manifest and benchmark scanners now skip `.codegraph/`, `.tmp/`, build/cache folders, and dependency folders. Before that fix, benchmark index was distorted by local artifact directories and timed out.

## Golden Eval

Command:

```powershell
node dist/cli.js benchmark eval --root .
```

Result:

| Metric | Value |
| --- | ---: |
| Tasks | 4 |
| Correct | 4 |
| Baseline estimated tokens | 96,027 |
| CodeGraph estimated tokens | 3,251 |
| Token saving | 96.6% |
| Baseline files opened | 65 |

The default `search_files` fixture task now opts into fixtures explicitly with `includeFixtures: true`, matching the expected `PaymentService` evidence.

## Context Proof

Command:

```powershell
node dist/cli.js benchmark proof --root . --tasks auto --task-count 5 --no-index
```

Result:

| Metric | Value |
| --- | ---: |
| Tasks | 5 |
| Baseline correct | 1 |
| MCP correct | 5 |
| Quality maintained | true |
| Baseline estimated input tokens | 114,355 |
| MCP estimated input tokens | 19,754 |
| Input token saving | 82.7% |
| Baseline files opened | 35 |
| MCP slices opened | 9 |
| File-open reduction | 74.3% |
| Context packet p95 | 261 ms |
| MCP workflow p95 | 516 ms |

## Review Proof

Command:

```powershell
node dist/cli.js benchmark review --root . --tasks auto --task-count 5 --no-index
```

Result:

| Metric | Value |
| --- | ---: |
| Tasks | 5 |
| Baseline correct | 5 |
| MCP correct | 5 |
| Quality maintained | true |
| Baseline estimated input tokens | 114,557 |
| MCP estimated input tokens | 12,461 |
| Input token saving | 89.1% |
| Baseline files opened | 35 |
| MCP tool calls | 5 |
| File-open reduction | 85.7% |
| `review_patch` p95 | 172 ms |

## Local Fallback

Command:

```powershell
node dist/cli.js benchmark fallback --root . --tasks auto --task-count 5
```

Result:

| Metric | Value |
| --- | ---: |
| Tasks | 5 |
| Correct | 5 |
| Quality score | 1.0 |
| p50 | 56 ms |
| p95 | 109 ms |
| Max | 109 ms |
| Estimated response tokens | 5,575 |
| Average estimated response tokens | 1,115 |
| Files considered | 74 |
| Files read | 50 |
| Files matched | 49 |

## Synthetic Generate

Command:

```powershell
node dist/cli.js benchmark generate --root .tmp/synthetic-smoke --files 10 --modules 2
```

Result:

| Metric | Value |
| --- | ---: |
| Files | 10 |
| Modules | 2 |

## Agent E2E Harnesses

These commands validate runner setup and config generation without invoking real agent tasks.

```powershell
node dist/cli.js benchmark codex-e2e --root . --dry-run --task-count 1
node dist/cli.js benchmark copilot-e2e --root . --dry-run
```

Results:

| Harness | Result |
| --- | --- |
| Codex E2E dry-run | generated plan and performed SQLite index phase; 74 parse-cache hits, 1304 ms index phase, no task runs because dry-run |
| Copilot E2E dry-run | generated suite metadata without `CODEGRAPH_DATABASE_URL` or `--home` |

The Copilot PowerShell harnesses were updated to pass `codegraph mcp --root ... --workspace-key ... --no-prewarm` and `codegraph index --root ... --workspace-key ...` directly. They no longer emit Postgres environment variables or `--home`.

## Interpretation

The refactor meets the intended local runtime shape:

- no daemon process is required for MCP;
- no Postgres or Docker service is required for graph queries;
- the graph database is per repo at `.codegraph/graph.sqlite`;
- setup, index, query packs, review packets, graph export, atlas, and deterministic benchmarks run against SQLite;
- local generated folders are excluded from indexing and benchmark baselines.

The deterministic feature benchmarks show the strongest gains for graph/search/review workflows after the fixed setup cost is paid. Real model quality still requires separate non-dry-run Codex/Copilot E2E runs because agent behavior and token accounting are model/runtime dependent.
