# Agent integration proof — 2026-07-18

## Decision gate

An MCP arm passes only when:

1. quality regresses by no more than 5 percentage points;
2. broad shell/search calls do not increase;
3. latency or provider-correct fresh-token usage improves;
4. the run uses the requested real model and actual CLI usage fields.

Fresh-token accounting is provider-specific:

- Codex: `(input - cached_input) + output + reasoning`;
- Claude: `input + cache_creation + output` (cache reads excluded);
- Copilot: `(input - cache_read) + output + reasoning`.

## Real-model results

One repository investigation task was run against the CodeGraph repository. This is a smoke-quality A/B result, not yet a multi-task Java claim.

| Model / cache state | Arm | Quality | Shell calls | Fresh tokens | Wall time |
| --- | --- | ---: | ---: | ---: | ---: |
| Codex `gpt-5.6-luna` | baseline | 92.9% | 7 | 35,597 | 70.6s |
| Codex `gpt-5.6-luna` | MCP-first | 92.9% | 0 | 19,725 | 40.0s |
| Claude `claude-sonnet-5`, cold | baseline | 100% | 6 | 23,720 | 49.7s |
| Claude `claude-sonnet-5`, cold | MCP-first | 100% | 0 | 41,731 | 27.0s |
| Claude `claude-sonnet-5`, warm | baseline | 100% | 6 | 11,091 | 41.7s |
| Claude `claude-sonnet-5`, warm | MCP-first | 100% | 0 | 8,710 | 27.7s |

Observed deltas:

- Luna MCP-first: quality neutral, fresh tokens **-44.6%**, latency **-43.3%**, shell calls **7 -> 0**.
- Claude cold MCP-first: quality neutral and latency **-45.8%**, but fresh tokens **+75.9%** because the first call creates the MCP/tool prompt cache.
- Claude warm MCP-first: quality neutral, fresh tokens **-21.5%**, latency **-33.5%**, shell calls **6 -> 0**.

Claude's small three-tool server is emitted with `alwaysLoad: true`, which removes the deferred `ToolSearch` round trip. The client schema does not advertise the `mode` override, preventing the model from forcing a PBI/acceptance-criteria task into `research` mode. Power-user `full` profile calls still accept an explicit mode.

## Copilot status

Live Copilot A/B was not run because Copilot is not installed on this machine. The locally provable path is complete:

- `.vscode/mcp.json` uses the VS Code workspace `servers` format;
- it launches the built local CLI with `--mcp-profile client`;
- a real MCP handshake returned exactly `codegraph_context`, `codegraph_slice`, and `codegraph_status`;
- `.github/copilot-instructions.md` tells the agent to use the facade, preserve automatic routing, and stop after `answerable=true`;
- the Copilot benchmark now includes reasoning tokens and treats missing model usage as unavailable instead of zero.

## Regression proof

- TypeScript lint/build passed.
- Targeted routing, Claude-runner, Copilot-integration, and compile-evidence tests passed.
- The full Vitest run executed **319/319 passing tests**. Vitest then emitted an infrastructure-level worker RPC timeout (`onTaskUpdate`) after the 570-second workspace-readiness file, so `npm test` exited 1 despite no failed test.
- The separate TokenOpt/fusion phase passed **84/84 tests**.
- Both Copilot PowerShell scripts parsed successfully.

## Next improvements, ranked

1. **Java multi-task proof (highest value):** add 5–10 tasks covering Spring endpoint flow, service/repository impact, JPA field usage, test selection, refactor planning, and a seeded bug. Require at least three repetitions per arm and report medians.
2. **Split long integration tests:** move `workspace-readiness.test.ts` into a long-running CI job so the normal suite does not hit Vitest worker RPC reporting limits. Do not hide the problem by accepting a red `npm test`.
3. **Live Copilot A/B:** after installing Copilot, run `baseline`, forced `codegraph`, and neutral `organic` modes. Apply only if quality loss is at most 5 points and at least three paired tasks have valid token usage.
4. **Cold/warm reporting as a first-class gate:** record cold setup cost separately and report the break-even number of repeated tasks instead of mixing cache creation with steady-state usage.
5. **Broader repository proof:** repeat the Java suite on one external Spring/Jakarta repository to detect self-repo overfitting.

The external `Doughnut` follow-up is now recorded in
[`doughnut-java-external-proof-2026-07-18.md`](doughnut-java-external-proof-2026-07-18.md).
It found and fixed two concrete Java integration defects, but the three-task
Claude quality/token gate still fails; external promotion remains blocked.

Stop rule: do not add more routing heuristics until a failed Java task identifies a specific missing file, symbol, call edge, or packet field.
