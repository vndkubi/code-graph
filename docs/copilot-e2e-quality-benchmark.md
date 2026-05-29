# Copilot E2E Quality Benchmark

This runbook measures real GitHub Copilot CLI + CodeGraph MCP behavior. It is
for proving whether a model can complete developer tasks with real quality
checks, not just whether it returns a well-shaped JSON answer.

The benchmark runner is
[`examples/copilot-e2e-quality-bench.ps1`](../examples/copilot-e2e-quality-bench.ps1).
The starter suite is
[`examples/copilot-e2e-quality-suite.example.json`](../examples/copilot-e2e-quality-suite.example.json).
The official CLI entry point wraps the same runner:

```powershell
node D:\Personal\Projects\code-graph\dist\cli.js benchmark copilot-e2e --dry-run
```

## What It Measures

Each prompt runs in a fresh workspace and a fresh Copilot session.

The runner records:

| Metric | Source |
| --- | --- |
| Model | Suite model or `-Models` CLI argument |
| Runs | Number of model/task sessions |
| Avg latency | Wall-clock time around `gh copilot` |
| Credit | `session.shutdown.data.totalPremiumRequests` |
| Input tokens | `session.shutdown.data.modelMetrics.*.usage.inputTokens` |
| Cached input tokens | `session.shutdown.data.modelMetrics.*.usage.cacheReadTokens` |
| Output tokens | `session.shutdown.data.modelMetrics.*.usage.outputTokens` |
| Reasoning tokens | `session.shutdown.data.modelMetrics.*.usage.reasoningTokens` |
| Total tokens | `inputTokens + outputTokens` |
| Quality | Validator pass/fail after the run |

Quality is computed from the resulting workspace: diff, changed files, file
contents, validation commands, and golden fact/finding coverage. It is not based
on the assistant's final JSON shape alone.

## Prerequisites

Build CodeGraph and make sure local Postgres is running:

```powershell
cd D:\Personal\Projects\code-graph
npm.cmd run build
docker compose -f compose.postgres.yml up -d
```

Verify Copilot CLI is installed and authenticated:

```powershell
gh copilot -- --help
```

## Quick Smoke

Run one low-cost implement task:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File D:\Personal\Projects\code-graph\examples\copilot-e2e-quality-bench.ps1 `
  -TaskIds fixture-implement-reserve-before-charge `
  -Models gpt-5-mini `
  -ParseWorkers 2
```

Equivalent CLI wrapper:

```powershell
node D:\Personal\Projects\code-graph\dist\cli.js benchmark copilot-e2e `
  --dry-run `
  --models gpt-5-mini `
  --task-ids fixture-implement-reserve-before-charge `
  --modes codegraph,baseline
```

The runner writes a timestamped report under:

```text
D:\Personal\Projects\code-graph\.tmp-debug-home\copilot-e2e-quality\<timestamp>
```

Important output files:

| File | Purpose |
| --- | --- |
| `quality-report.json` | Full machine-readable report |
| `summary-by-model.txt` | Model-level table |
| `summary-by-type.txt` | Task-type table |
| `run-details.txt` | Per-session summary |
| `<task>__<model>\copilot.stdout.jsonl` | Raw Copilot JSONL |
| `<task>__<model>\git-diff.patch` | Diff from the task baseline commit |
| `<task>__<model>\mcp-config.json` | Temporary CodeGraph MCP config for CodeGraph mode |

Example real smoke result from 2026-05-29:

| Model | Task | Quality | Latency | Credit | Input tokens | Cached input | Output tokens | Reasoning tokens | Total tokens |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `gpt-5-mini` | `fixture-implement-reserve-before-charge` | pass | 48.4s | 0 | 105,944 | 97,024 | 2,858 | 2,304 | 108,802 |

The validator checked that only `src/order-service.ts` changed and that the
diff inserted:

```typescript
await this.inventoryService.reserve(request.items);
```

between `checkAvailability(request.items)` and
`paymentService.charge(request.customerId, 100)`.

## Full Suite

Run the built-in fixture suite with and without CodeGraph MCP:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File D:\Personal\Projects\code-graph\examples\copilot-e2e-quality-bench.ps1 `
  -Models gpt-5-mini,gpt-5.4-mini,claude-haiku-4.5,gpt-5.4,claude-sonnet-4.6 `
  -Modes codegraph,baseline `
  -ParseWorkers 2
```

Use one session per prompt/model. Do not combine multiple prompts into one
Copilot session if you need trustworthy token numbers.

## Latest Real Matrix

Final combined fixture run from 2026-05-29:

```text
D:\Personal\Projects\code-graph\.tmp-debug-home\copilot-e2e-quality\20260529-095300\quality-report.final-combined.json
```

The suite ran 7 task types for each model and mode: `implement`, `debug`,
`create-testcase`, `codereview`, `investigate`, `break-task`, and `refactor`.
Quality was validator pass/fail from diffs, TypeScript compile, behavior tests,
mutation tests, and golden fact/finding checks.

| Model | Mode | Runs | Quality | Avg latency | Credit | Input tokens | Output tokens | Total tokens |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `claude-haiku-4.5` | baseline | 7 | 7 | 64.8s | 2.31 | 1,381,761 | 24,943 | 1,406,704 |
| `claude-haiku-4.5` | codegraph | 7 | 7 | 88.5s | 2.31 | 2,892,357 | 35,970 | 2,928,327 |
| `claude-sonnet-4.6` | baseline | 7 | 7 | 50.9s | 7 | 627,977 | 15,704 | 643,681 |
| `claude-sonnet-4.6` | codegraph | 7 | 7 | 67.3s | 7 | 823,139 | 19,852 | 842,991 |
| `gpt-5.4` | baseline | 7 | 7 | 109.7s | 7 | 2,485,255 | 35,710 | 2,520,965 |
| `gpt-5.4` | codegraph | 7 | 7 | 121.2s | 7 | 2,283,746 | 26,934 | 2,310,680 |
| `gpt-5.4-mini` | baseline | 7 | 7 | 63.5s | 2.31 | 1,750,057 | 30,534 | 1,780,591 |
| `gpt-5.4-mini` | codegraph | 7 | 7 | 69.1s | 2.31 | 1,178,477 | 21,841 | 1,200,318 |
| `gpt-5-mini` | baseline | 7 | 7 | 32.7s | 0 | 328,515 | 18,603 | 347,118 |
| `gpt-5-mini` | codegraph | 7 | 7 | 51.0s | 0 | 776,578 | 23,631 | 800,209 |

Token saving is computed as `(baseline - codegraph) / baseline`.

| Model | Quality baseline | Quality CodeGraph | Input token saving | Total token saving |
| --- | ---: | ---: | ---: | ---: |
| `claude-haiku-4.5` | 7/7 | 7/7 | -109.32% | -108.17% |
| `claude-sonnet-4.6` | 7/7 | 7/7 | -31.08% | -30.96% |
| `gpt-5.4` | 7/7 | 7/7 | 8.11% | 8.34% |
| `gpt-5.4-mini` | 7/7 | 7/7 | 32.66% | 32.59% |
| `gpt-5-mini` | 7/7 | 7/7 | -136.39% | -130.53% |

Interpretation for this fixture: CodeGraph helped token usage most for
`gpt-5.4-mini`, helped modestly for `gpt-5.4`, and was net-negative for
`gpt-5-mini`, Haiku, and Sonnet because the repository is tiny and MCP context
overhead dominates.

## Quality Checks By Task Type

Use these validation patterns when creating project-specific suites:

| Task | Real quality check |
| --- | --- |
| `implement` | Fresh workspace, required diff/files, unit test/lint, API/file assertions |
| `debug` | Inject failing state first, pass only when red-to-green test or bug fixture validates |
| `create-testcase` | New test compiles/passes; ideally fails against the seeded buggy implementation |
| `codereview` | Seeded bad diff with golden findings; score recall and precision |
| `investigate` | Golden fact coverage, file/line evidence, and no unsupported claims |
| `break-task` | Golden DAG/checklist coverage, dependency order, risks, and test milestones |
| `refactor` | Behavior tests pass, public API unchanged, diff stays within scope |

## Suite Format

Each task can define:

```json
{
  "id": "fixture-implement-reserve-before-charge",
  "type": "implement",
  "repoRoot": "${codeGraphRoot}/tests/fixtures/ts-project",
  "workspaceMode": "copy",
  "prompt": "Use only CodeGraph MCP server ${mcpServer} ...",
  "validation": {
    "maxChangedFiles": 1,
    "requiredChangedFiles": ["src/order-service.ts"],
    "requiredDiffRegex": ["reserve\\(request\\.items\\)"],
    "orderedFileContains": [
      {
        "file": "src/order-service.ts",
        "patterns": [
          "checkAvailability\\(request\\.items\\)",
          "reserve\\(request\\.items\\)",
          "charge\\(request\\.customerId, 100\\)"
        ]
      }
    ],
    "commands": [
      {
        "name": "unit-test",
        "command": "npm.cmd test -- --runInBand",
        "timeoutSeconds": 300,
        "expectedExitCode": 0
      }
    ]
  }
}
```

Supported validation fields:

| Field | Meaning |
| --- | --- |
| `maxChangedFiles` | Upper bound for changed files since the task baseline commit |
| `requiredChangedFiles` | Files that must change |
| `forbiddenChangedFiles` | Files that must not change |
| `requiredDiffRegex` | Regexes that must match the baseline diff |
| `forbiddenDiffRegex` | Regexes that must not match the baseline diff |
| `fileContains` | File content regex/text assertions |
| `fileNotContains` | Negative file content assertions |
| `orderedFileContains` | Regexes that must appear in order within one file |
| `goldenFacts` | Regexes that must appear in the final answer |
| `forbiddenClaims` | Claims that must not appear in the final answer |
| `goldenFindings` | Seeded review findings that must be reported |
| `expectedDagNodes` | Task-breakdown nodes that must be present |
| `commands` | Real validation commands to run after Copilot finishes |

The runner validates against a baseline commit created after fixture setup or
`prePatch`. This still works if Copilot commits changes during the run.
Untracked files are also counted as changed files.

## Hadoop And Elasticsearch

For large real repositories, create a separate suite file and use
`workspaceMode: "git-worktree"` so each prompt has an isolated checkout without
copying the full repository:

```json
{
  "version": 1,
  "models": [{ "id": "gpt-5-mini", "effort": "low" }],
  "tasks": [
    {
      "id": "hadoop-investigate-block-report",
      "type": "investigate",
      "repoRoot": "D:/Personal/Projects/hadoop",
      "workspaceMode": "git-worktree",
      "prompt": "Use only CodeGraph MCP server ${mcpServer}. Do not edit files. Study BlockManager.processReport and explain business flow, deep dive, and glossary with file/line evidence.",
      "validation": {
        "maxChangedFiles": 0,
        "goldenFacts": [
          "BlockManager",
          "processReport",
          "Datanode",
          "block report"
        ],
        "forbiddenClaims": ["unsupported", "guess"]
      }
    }
  ]
}
```

Run it:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File D:\Personal\Projects\code-graph\examples\copilot-e2e-quality-bench.ps1 `
  -SuitePath D:\Personal\Projects\code-graph\.tmp-debug-home\hadoop-quality-suite.json `
  -Models gpt-5-mini,gpt-5.4-mini,claude-haiku-4.5 `
  -ParseWorkers 4
```

The runner pre-indexes each fresh workspace before starting Copilot and writes a
temporary `codegraph-bench` MCP server config for that workspace.

## Safety Notes

The runner uses `--allow-all-tools` plus `--add-dir=<workspace>` so Copilot can
edit and test non-interactively while staying scoped to the disposable fixture
copy or git worktree. It intentionally does not use `--allow-all-paths`.

For implementation/debug/refactor tasks, include "Do not run git commit" in the
prompt unless committing is part of the benchmark. The validator handles commits,
but avoiding commits usually saves model turns and tokens.
