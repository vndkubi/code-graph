# Competitive Benchmark: vndkubi/code-graph vs colbymchenry/codegraph

This is the proof protocol for showing this project is better than
`https://github.com/colbymchenry/codegraph` across prompt types, not just one
architecture prompt.

## Why This Protocol Exists

The public competitor README currently positions `colbymchenry/codegraph` around
lower cost, fewer tokens, faster runs, and fewer tool calls. Its published
benchmark reports an average of 16% cheaper, 47% fewer tokens, 22% faster, and
58% fewer tool calls across seven real-world repos, using one architecture-style
question per repo.

That is a strong baseline, but it does not prove behavior for the prompt classes
that matter most for this project:

- natural API/flow prompts such as `trace api "/a" please`
- answerability-gated evidence packets
- implementation/change planning
- code review with a diff
- architecture research
- test discovery
- stop-rule discipline after an answer-ready packet

## Claim To Prove

This project wins when it produces equal-or-better answer quality with fewer
unnecessary follow-up calls across the prompt types above.

A run is a valid win only if all of these hold:

- Quality is at least equal to the competitor on every task, using the expected
  files, methods, terms, and required answer fields in the suite.
- Aggregate fresh input tokens are lower, or the quality gain is high enough to
  justify any token increase.
- Tool calls are lower, especially after answer-ready packets.
- Broad shell/search/read fallback is zero when `answerable=true`.
- Missing evidence is handled only through listed exact follow-ups.

## Prompt Suite

Use:

```powershell
examples\competitive-codegraph-prompt-suite.example.json
```

The suite intentionally covers multiple prompt classes:

| Task ID | Prompt Class | Why It Matters |
| --- | --- | --- |
| `natural-api-trace` | natural API/flow | Proves casual prompts route to answer-mode packets instead of extra discovery. |
| `answerability-gate` | evidence gate | Proves `answerable`, `allowedFollowups`, and `disallowedFollowups` are understood. |
| `change-planning` | implementation planning | Proves edit tasks route to scoped change context, not architecture search. |
| `review-routing-diff` | code review | Proves diff review finds impacted routing/tests without raw file sweeps. |
| `architecture-research` | architecture | Gives the competitor its strongest public benchmark class. |
| `test-discovery` | test mapping | Proves tests are found as first-class evidence. |

## Reproducible Head-To-Head Method

Use the same repo checkout, model, prompt suite, timeout, and tool permissions
for both arms.

The one-command runner is:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\competitive-codegraph-proof.ps1 `
  -PrepareOnly
```

This creates isolated workspaces and indexes this project without model calls or
third-party package execution.

The full proof runner is:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\competitive-codegraph-proof.ps1 `
  -AllowModelRun `
  -AllowThirdParty
```

Without both switches, the script prints the planned model/competitor command and
exits without running model calls or third-party code.

To pin or override the competitor package, pass separate init and serve commands:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\competitive-codegraph-proof.ps1 `
  -CompetitorInitCommand npx.cmd `
  -CompetitorInitArgs "-y,@colbymchenry/codegraph@1.0.0,init" `
  -CompetitorIndexCommand npx.cmd `
  -CompetitorIndexArgs "-y,@colbymchenry/codegraph@1.0.0,index" `
  -CompetitorCommand npx.cmd `
  -CompetitorCommandArgs "-y,@colbymchenry/codegraph@1.0.0,serve,--mcp" `
  -AllowModelRun `
  -AllowThirdParty
```

Do not initialize both tools in the same physical checkout. Both tools use a
`.codegraph` workspace directory, so use separate workspace copies or worktrees
for the two arms:

```powershell
robocopy . .tmp\competitive-workspaces\ours /MIR /XD .git .codegraph .tmp node_modules dist
robocopy . .tmp\competitive-workspaces\colbymchenry /MIR /XD .git .codegraph .tmp node_modules dist
```

Build this project from the original checkout, then run each arm with its own
`--root`.

### Arm A: this project

```powershell
npm.cmd run build
node dist/cli.js setup --root .tmp\competitive-workspaces\ours
node dist/cli.js benchmark codex-e2e `
  --root .tmp\competitive-workspaces\ours `
  --workspace-key codegraph-self-competitive `
  --suite .tmp\competitive-workspaces\ours\examples\competitive-codegraph-prompt-suite.example.json `
  --models gpt-5.3-codex-spark `
  --modes compiled-packet+gate `
  --no-index `
  --codex-command cmd.exe `
  --codex-command-args "/c,npx.cmd,-y,@openai/codex" `
  --codex-timeout-seconds 300 `
  --run-dir .tmp\competitive-self-this-codegraph
```

### Arm B: colbymchenry/codegraph

Run the same prompts against the competitor MCP server on the same checkout.
Do not use its installer in a persistent developer profile during benchmarking;
use an isolated Codex home/config so the only MCP server exposed to the agent is
the competitor server.

Initialize the competitor index once in the same checkout:

```powershell
cd .tmp\competitive-workspaces\colbymchenry
npx.cmd -y @colbymchenry/codegraph init
npx.cmd -y @colbymchenry/codegraph index
cd ..\..\..
```

The `codex-e2e` runner supports this through `--mcp-command` and
`--mcp-command-args`, keeping the same prompt suite, model, modes, timeout, and
quality scorer:

```powershell
node dist/cli.js benchmark codex-e2e `
  --root .tmp\competitive-workspaces\colbymchenry `
  --workspace-key codegraph-self-competitive `
  --suite .tmp\competitive-workspaces\colbymchenry\examples\competitive-codegraph-prompt-suite.example.json `
  --models gpt-5.3-codex-spark `
  --modes mcp-first `
  --no-index `
  --mcp-server-name codegraph_bench `
  --mcp-command npx.cmd `
  --mcp-command-args "-y,@colbymchenry/codegraph,serve,--mcp" `
  --skip-preflight `
  --codex-command cmd.exe `
  --codex-command-args "/c,npx.cmd,-y,@openai/codex" `
  --codex-timeout-seconds 300 `
  --run-dir .tmp\competitive-self-colbymchenry-codegraph
```

If the competitor CLI changes its MCP subcommand, change only
`--mcp-command-args`; do not change prompts, scoring, model, timeout, or
permissions.

Record the same raw fields:

- answer JSON
- quality score against suite expectations
- total MCP calls
- shell/search/read calls
- fresh input tokens
- output tokens
- wall time
- whether extra tool calls happened after an answer-ready packet

### Compare The Two Arms

After both arms produce `report.json`, generate the head-to-head comparison:

```powershell
node dist/cli.js benchmark competitive-compare `
  --ours .tmp\competitive-self-this-codegraph\report.json `
  --theirs .tmp\competitive-self-colbymchenry-codegraph\report.json `
  --ours-label vndkubi-code-graph `
  --theirs-label colbymchenry-codegraph `
  > .tmp\competitive-codegraph-comparison.json

node dist/cli.js benchmark competitive-compare `
  --ours .tmp\competitive-self-this-codegraph\report.json `
  --theirs .tmp\competitive-self-colbymchenry-codegraph\report.json `
  --ours-label vndkubi-code-graph `
  --theirs-label colbymchenry-codegraph `
  --format markdown `
  > .tmp\competitive-codegraph-comparison.md
```

The comparison output groups by task id and reports:

- average quality
- fresh model tokens
- total tool calls
- MCP calls
- shell/search/read calls
- wall time
- stop-rule violation calls
- per-task winner and reasons
- aggregate winner

## Scoring

For each task:

```text
quality = matched expected files/methods/terms/required JSON fields
discipline = 1 when no forbidden follow-up happened after answerable=true
cost = fresh input tokens + output tokens
tool_efficiency = total tool calls + shell/search/read calls
```

Recommended pass threshold:

- `quality >= 0.90` per task
- `discipline == 1.0` per task
- this project has lower aggregate `cost`
- this project has lower aggregate `tool_efficiency`

If the competitor has better cost on a task but misses required files, methods,
or stop-rule discipline, that task is not a competitor win.

## Existing Local Evidence For This Project

The current benchmark record already shows this project can produce large token
reductions in repo-grounded tasks:

- Golden eval: 96.0% estimated token saving.
- Context proof: 80.1% input token saving with quality maintained.
- Review proof: 85.4% input token saving with quality maintained.

Those are not yet head-to-head against `colbymchenry/codegraph`; they are the
local proof that this project has enough measurement surfaces to run the
competitive suite above.

## Natural Prompt Head-To-Head Evidence (2026-06-22)

This run tested natural user prompts that do not mention `MCP` or `CodeGraph`
in the task prompt text. The suite covers the four requested prompt classes:
investigation, API trace, implementation plus unit-test planning, and code
review.

Suite:

```powershell
examples\competitive-natural-workflow-prompt-suite.example.json
```

External competitor state checked for this run:

- GitHub HEAD for `https://github.com/colbymchenry/codegraph`:
  `03666584ed9836d7954cbb19e2252081b96fcad9`
- npm package: `@colbymchenry/codegraph@1.0.1`
- competitor CLI-reported version: `0.9.7`

Commands:

```powershell
npm.cmd run build

node dist/cli.js benchmark codex-e2e `
  --root D:\Personal\Projects\code-graph\.tmp\competitive-proof\workspaces\ours `
  --workspace-key competitive-natural-ours `
  --suite D:\Personal\Projects\code-graph\examples\competitive-natural-workflow-prompt-suite.example.json `
  --models gpt-5.3-codex-spark `
  --modes natural-tool-use `
  --codex-command cmd.exe `
  --codex-command-args "/c,npx.cmd,-y,@openai/codex" `
  --codex-timeout-seconds 300 `
  --run-dir D:\Personal\Projects\code-graph\.tmp\competitive-proof\natural-ours-v1

node dist/cli.js benchmark codex-e2e `
  --root D:\Personal\Projects\code-graph\.tmp\competitive-proof\workspaces\colbymchenry `
  --workspace-key competitive-natural-colbymchenry `
  --suite D:\Personal\Projects\code-graph\examples\competitive-natural-workflow-prompt-suite.example.json `
  --models gpt-5.3-codex-spark `
  --modes natural-tool-use `
  --no-index `
  --skip-preflight `
  --mcp-command npx.cmd `
  --mcp-command-args "-y,@colbymchenry/codegraph,serve,--mcp" `
  --codex-command cmd.exe `
  --codex-command-args "/c,npx.cmd,-y,@openai/codex" `
  --codex-timeout-seconds 300 `
  --run-dir D:\Personal\Projects\code-graph\.tmp\competitive-proof\natural-colbymchenry-v1

node dist/cli.js benchmark competitive-compare `
  --ours .tmp\competitive-proof\natural-ours-v1\report.json `
  --theirs .tmp\competitive-proof\natural-colbymchenry-v1\report.json `
  --ours-label vndkubi-code-graph-natural-v1 `
  --theirs-label colbymchenry-codegraph-1.0.1-natural-v1 `
  --format markdown `
  > .tmp\competitive-proof\natural-competitive-comparison-v1.md
```

Result:

| Metric | This project | colbymchenry/codegraph | Delta vs competitor |
| --- | ---: | ---: | ---: |
| Prompt-class wins | 3 | 1 |  |
| Average quality | 0.868 | 0.840 | +0.028 |
| Fresh model tokens | 184,182 | 257,851 | -28.57% |
| Tool calls | 55 | 112 | -50.89% |
| Shell calls | 50 | 112 | -55.36% |
| Wall time | 200,322 ms | 307,375 ms | -34.83% |

Per prompt class:

| Task | Winner | Quality ours/theirs | Fresh tokens ours/theirs | Tool calls ours/theirs |
| --- | --- | ---: | ---: | ---: |
| `natural-investigation-order-side-effects` | ours | 1.000 / 0.889 | 49,989 / 36,280 | 15 / 26 |
| `natural-trace-post-orders` | ours | 1.000 / 1.000 | 15,579 / 92,152 | 1 / 42 |
| `natural-implement-fraud-check-ut` | theirs | 0.737 / 0.737 | 89,618 / 73,082 | 24 / 26 |
| `natural-code-review-order-regression` | ours | 0.733 / 0.733 | 28,996 / 56,337 | 15 / 18 |

Interpretation:

- This project won the natural prompt suite overall: 3 of 4 prompt classes,
  higher aggregate quality, fewer fresh tokens, fewer tool calls, fewer shell
  calls, and lower wall time.
- The strongest win was casual API trace: equal quality at 83.09% fewer fresh
  tokens and 97.62% fewer tool calls.
- The implementation plus unit-test prompt is the remaining weak class. Quality
  tied, but this project spent more fresh tokens, so the competitor won that
  task on efficiency.
- In this natural mode, the competitor did not call its MCP server at all
  (`mcpCalls=0`), while this project was discovered and used on 3 of 4 tasks
  (`mcpCalls=5`). That is evidence that this project is more discoverable under
  natural prompts, but it also means the competitor arm mostly reflects shell
  fallback behavior under the same user prompt.

Primary artifacts:

- `.tmp\competitive-proof\natural-ours-v1\report.json`
- `.tmp\competitive-proof\natural-colbymchenry-v1\report.json`
- `.tmp\competitive-proof\natural-competitive-comparison-v1.md`

## Headroom Natural Prompt Comparison (2026-06-22)

This run compared the same natural prompt suite against
`https://github.com/headroomlabs-ai/headroom` as an MCP server in the same Codex
E2E harness.

External Headroom state checked for this run:

- GitHub HEAD for `https://github.com/headroomlabs-ai/headroom`:
  `95b2333ee5a3f1cbe512ca04a6563c3572835758`
- PyPI package used for the MCP server: `headroom-ai==0.27.0`
- CLI-reported version: `headroom, version 0.27.0`
- npm package `headroom-ai` was `0.22.4` and was not used for this run.

Setup and benchmark commands:

```powershell
py -3 -m venv .tmp\competitive-proof\headroom-venv
.tmp\competitive-proof\headroom-venv\Scripts\python.exe -m pip install --upgrade pip
.tmp\competitive-proof\headroom-venv\Scripts\python.exe -m pip install "headroom-ai[mcp]==0.27.0"

node dist/cli.js benchmark codex-e2e `
  --root D:\Personal\Projects\code-graph\.tmp\competitive-proof\workspaces\ours `
  --workspace-key competitive-natural-headroom `
  --suite D:\Personal\Projects\code-graph\examples\competitive-natural-workflow-prompt-suite.example.json `
  --models gpt-5.3-codex-spark `
  --modes natural-tool-use `
  --no-index `
  --skip-preflight `
  --mcp-server-name headroom_bench `
  --mcp-command D:\Personal\Projects\code-graph\.tmp\competitive-proof\headroom-venv\Scripts\headroom.exe `
  --mcp-command-args "mcp,serve" `
  --codex-command cmd.exe `
  --codex-command-args "/c,npx.cmd,-y,@openai/codex" `
  --codex-timeout-seconds 300 `
  --run-dir D:\Personal\Projects\code-graph\.tmp\competitive-proof\natural-headroom-v1

node dist/cli.js benchmark competitive-compare `
  --ours .tmp\competitive-proof\natural-ours-v1\report.json `
  --theirs .tmp\competitive-proof\natural-headroom-v1\report.json `
  --ours-label vndkubi-code-graph-natural-v1 `
  --theirs-label headroom-ai-0.27.0-mcp-natural-v1 `
  --format markdown `
  > .tmp\competitive-proof\natural-competitive-comparison-headroom-v1.md
```

Result:

| Metric | This project | headroom-ai MCP | Delta vs Headroom |
| --- | ---: | ---: | ---: |
| Prompt-class wins | 2 | 2 |  |
| Average quality | 0.868 | 0.854 | +0.014 |
| Fresh model tokens | 184,182 | 210,679 | -12.58% |
| Tool calls | 55 | 111 | -50.45% |
| MCP calls | 5 | 0 |  |
| Shell calls | 50 | 111 | -54.95% |
| Wall time | 200,322 ms | 294,109 ms | -31.89% |

Per prompt class:

| Task | Winner | Quality ours/theirs | Fresh tokens ours/theirs | Tool calls ours/theirs |
| --- | --- | ---: | ---: | ---: |
| `natural-investigation-order-side-effects` | ours | 1.000 / 0.944 | 49,989 / 53,459 | 15 / 45 |
| `natural-trace-post-orders` | ours | 1.000 / 1.000 | 15,579 / 63,992 | 1 / 30 |
| `natural-implement-fraud-check-ut` | theirs | 0.737 / 0.737 | 89,618 / 67,239 | 24 / 22 |
| `natural-code-review-order-regression` | theirs | 0.733 / 0.733 | 28,996 / 25,989 | 15 / 14 |

Interpretation:

- The direct comparator result is `inconclusive` because prompt-class wins split
  2 to 2.
- On aggregate metrics, this project still had higher average quality, fewer
  fresh tokens, fewer tool calls, fewer shell calls, and lower wall time.
- Headroom is primarily a context compression/proxy/wrapper project, not a
  semantic code graph. This comparison exposed Headroom as an MCP server in the
  same natural prompt harness. It does not evaluate Headroom's proxy or wrap
  mode.
- In this MCP-native natural mode, the Headroom server was configured and
  available but the model did not invoke any Headroom MCP tools (`mcpCalls=0`).
  That is a discoverability and routing result for this harness, not proof that
  Headroom's compression proxy cannot help in a proxy-mode setup.

Primary artifacts:

- `.tmp\competitive-proof\natural-headroom-v1\report.json`
- `.tmp\competitive-proof\natural-competitive-comparison-headroom-v1.md`
- `.tmp\competitive-proof\natural-competitive-comparison-headroom-v1.json`
- `.tmp\competitive-proof\natural-competitive-three-way-v1.md`

## Headroom Forced Proxy/Wrap Comparison (2026-06-22)

The MCP-native run above does not measure Headroom's main integration path.
Headroom's own docs and CLI describe automatic compression through
`headroom proxy` or `headroom wrap codex`, with MCP mainly providing
`headroom_retrieve`/`headroom_compress`/`headroom_stats`.

This follow-up forced Codex through the Headroom proxy path:

- Installed Headroom proxy dependencies in the isolated benchmark venv:
  `headroom-ai[proxy]==0.27.0`
- Used a temporary `CODEX_HOME` outside the repo so Headroom could inject
  provider config without mutating the user's real Codex config.
- Ran `headroom wrap codex --prepare-only --port 8798 --no-serena` to inject
  the Headroom Codex provider and retrieve MCP config.
- Ran `headroom proxy --port 8798 --log-file
  .tmp\competitive-proof\headroom-forced-proxy-gpt55.jsonl`.
- Ran the Codex E2E suite with `--use-user-config`, so Codex did not pass
  `--ignore-user-config` and therefore used the Headroom provider config.

The original benchmark model label `gpt-5.3-codex-spark` could not be used for
this proxy arm. The Headroom-routed ChatGPT-account path rejected it with:

```text
The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.
```

The forced proxy comparison therefore uses `gpt-5.5` for both arms. Do not mix
these totals with the earlier `gpt-5.3-codex-spark` tables.

Result:

| Metric | This project | Headroom proxy/wrap | Delta vs Headroom |
| --- | ---: | ---: | ---: |
| Prompt-class wins | 3 | 1 |  |
| Average quality | 0.851 | 0.801 | +0.050 |
| Fresh model tokens | 198,629 | 139,077 | +42.82% |
| Tool calls | 31 | 107 | -71.03% |
| MCP calls | 4 | 0 |  |
| Shell calls | 27 | 107 | -74.77% |
| Wall time | 228,024 ms | 524,593 ms | -56.53% |

Per prompt class:

| Task | Winner | Quality ours/theirs | Fresh tokens ours/theirs | Tool calls ours/theirs |
| --- | --- | ---: | ---: | ---: |
| `natural-investigation-order-side-effects` | ours | 1.000 / 0.778 | 66,159 / 41,973 | 11 / 24 |
| `natural-trace-post-orders` | ours | 1.000 / 1.000 | 30,564 / 41,960 | 1 / 43 |
| `natural-implement-fraud-check-ut` | theirs | 0.737 / 0.895 | 69,720 / 52,070 | 12 / 40 |
| `natural-code-review-order-regression` | ours | 0.667 / 0.533 | 32,186 / 3,074 | 7 / 0 |

Headroom proxy evidence:

- Proxy log rows: `48`
- Proxy requests: `43`
- Proxy tokens saved: `68,269`
- Proxy savings percent: `8.40%`
- RTK/context-tool commands recorded: `0`

Interpretation:

- The direct comparator winner is this project: 3 of 4 prompt classes.
- Headroom proxy/wrap did reduce aggregate fresh model tokens, but it did so
  with lower aggregate quality, 3.45x more tool calls, 3.96x more shell calls,
  and 2.30x wall time.
- Headroom's best result was the implementation plus unit-test prompt, where it
  produced higher quality at lower fresh token cost, but it needed 40 shell
  calls.
- The casual API trace remains this project's strongest comparative class:
  equal quality with 27.16% fewer fresh tokens and 97.67% fewer tool calls.
- RTK was configured by `wrap codex`, but the benchmark runner still used
  `--ignore-rules`, so RTK instructions were not exercised. This run measures
  Headroom proxy compression plus retrieve MCP availability, not a full
  Headroom rule-injection workflow.

Primary artifacts:

- `.tmp\competitive-proof\natural-ours-gpt55\report.json`
- `.tmp\competitive-proof\natural-headroom-forced-gpt55\report.json`
- `.tmp\competitive-proof\natural-competitive-comparison-headroom-forced-gpt55.md`
- `.tmp\competitive-proof\natural-competitive-comparison-headroom-forced-gpt55.json`
- `.tmp\competitive-proof\headroom-forced-proxy-gpt55.jsonl`

## Evidence To Attach To The Final Claim

Do not claim "better" until these files exist:

- `.tmp/competitive-self-this-codegraph/report.json`
- `.tmp/competitive-self-colbymchenry-codegraph/report.json`
- `.tmp/competitive-codegraph-comparison.json`
- `.tmp/competitive-codegraph-comparison.md`
- raw model outputs for every task and arm

The final claim should be phrased as:

```text
On <date>, using <model>, <repo>, and <suite>, this project beat
colbymchenry/codegraph on <N>/<N> prompt classes with <X>% lower fresh tokens,
<Y>% fewer tool calls, and no answer-ready follow-up violations.
```

Until that table exists, the defensible statement is:

```text
This project has a broader prompt-suite proof protocol than the competitor's
published architecture-only benchmark, and it is ready for head-to-head runs.
```
