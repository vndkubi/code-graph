# Su dung CodeGraph MCP hieu qua voi GitHub Copilot Agent

Guide nay tap trung vao cach lam viec voi Copilot agent sau khi CodeGraph MCP
da duoc cau hinh. Phan setup Docker va `mcp-config.json` nam o
[`copilot-mcp-config.md`](copilot-mcp-config.md).

## Nguyen tac chinh

Dung CodeGraph nhu mot lop dieu huong ngu canh truoc khi agent doc file bang
shell:

1. Bat agent goi dung tool graph dau tien.
2. Bat agent chi mo exact slice/range can thiet.
3. Bat agent chay validation tu `expectedVerification` hoac `validation`.
4. Kiem tra daemon log de chac MCP that su duoc dung.

Muc tieu la giam viec agent grep/doc tran lan, nhat la voi repo lon nhu Hadoop
hoac Elasticsearch.

## Setup khuyen nghi

Prewarm index truoc khi mo Copilot:

```powershell
node D:\Personal\Projects\code-graph\dist\cli.js index `
  --root D:\Personal\Projects\hadoop `
  --parse-workers 8
```

Voi Docker, dung cung `CODEGRAPH_WORKSPACE_KEY` giua lenh `index` va
`mcp-config.json`.

Khi dung Copilot CLI, uu tien `--no-prewarm` de startup nhanh:

```json
{
  "mcpServers": {
    "codegraph-hadoop": {
      "type": "local",
      "command": "node",
      "args": [
        "D:/Personal/Projects/code-graph/dist/cli.js",
        "mcp",
        "--root",
        "D:/Personal/Projects/hadoop",
        "--no-prewarm"
      ],
      "env": {},
      "tools": ["*"]
    }
  }
}
```

Bat `--watch` khi muon save file local tu dong refresh graph. Watch mode dung
path-delta refresh cho save nho, nen nhanh hon full manifest scan. Voi Docker
bind mount Windows, hay test latency truoc khi bat watch cho repo rat lon.

## Kiem tra agent co dung MCP khong

Mo log:

```powershell
cd D:\Personal\Projects\code-graph
node .\dist\cli.js logs --tail 50
```

Hoac watch live:

```powershell
$info = node .\dist\cli.js doctor | ConvertFrom-Json
Get-Content -LiteralPath $info.daemonLogPath -Tail 20 -Wait
```

Hoi agent:

```text
Use codegraph MCP tool get_index_stats and tell me the indexed file count.
```

Log dung se co dang:

```json
{"event":"query","toolName":"get_index_stats","durationMs":24,"responseChars":1200}
```

Neu log khong co `event:"query"` thi agent chua dung CodeGraph cho step do.

## Chon tool theo task

| Task | Tool nen dung dau tien | Khi nao dung |
| --- | --- | --- |
| Investigate/deep dive | `get_research_pack` hoac `get_flow_pack` | Can giai thich flow, business logic, glossary, file/line evidence |
| Implement/debug/refactor | `get_change_pack` | Can sua code, can edit ranges, invariants, tests, validation |
| Code review | `review_patch` | Co diff/changed files, can findings co file/line va precision targets |
| Tim endpoint | `find_endpoints` | Biet method/path hoac muon tim controller/handler |
| Tim symbol | `search_symbol` | Biet class/method/type name |
| Mo source | `get_file_slice` | Sau khi pack da dua exact file/lines/symbol |
| Impact truoc khi sua | `simulate_patch_impact` | Biet files/symbols/diff va muon xem callers, endpoints, tests |
| Tim test | `find_tests_for` | Can targeted tests cho symbol |

Khong nen bat dau bang `search_code` tru khi pack bao `missingFacts` hoac query
qua mo ho. `search_code` la fallback mixed search, khong phai default.

## Workflow chuan cho daily tasks

### 1. Investigate / deep dive

Prompt:

```text
Use CodeGraph MCP server codegraph-hadoop.
First call get_research_pack for BlockManager.processReport with taskType=architecture and tokenBudget=6000.
Answer only from flowSteps, compressedEvidence, evidenceSlices, and taskOracle.goldenFacts.
Include business deep dive, glossary, and file/line evidence.
Do not use shell grep/read unless missingFacts says evidence is insufficient.
```

Expected behavior:

- Agent goi `get_research_pack` hoac `get_flow_pack` 1 lan.
- Agent tra loi bang file/line evidence.
- Neu thieu thong tin, agent chi goi follow-up cu the, thuong la `get_file_slice`.

### 2. Implement

Prompt:

```text
Use CodeGraph MCP server codegraph-hadoop.
First call get_change_pack for this task:
"Implement inventory reservation in OrderService.create before charging payment."
Then call get_file_slice exactly once using routing.firstToolCall args.
Edit only files listed in the change pack unless expectedVerification proves another file is required.
Run expectedVerification.commands.
Report changed files and validation result.
```

Expected behavior:

- `get_change_pack` tra `editRanges`, `invariants`, `expectedVerification`.
- Agent mo exact slice, khong doc ca repo.
- Agent chay test/compile tu `expectedVerification`.

### 3. Debug

Prompt:

```text
Use CodeGraph MCP server codegraph-hadoop.
First call get_change_pack with changeType=debug for:
"Debug failing test around duplicate refund timeout in PaymentService.refund."
Keep the fix minimal.
Use taskOracle.successCriteria and invariants as acceptance criteria.
Run the targeted red/green validation commands if listed.
Do not commit.
```

Expected behavior:

- Agent xac dinh source + test lien quan.
- Neu co before-command, test phai do truoc fix va xanh sau fix.
- Diff nho, khong refactor lan man.

### 4. Refactor

Prompt:

```text
Use CodeGraph MCP server codegraph-hadoop.
First call get_change_pack with changeType=refactor for:
"Refactor OrderService.create to isolate availability check and reservation into a private helper."
Preserve public API signatures.
Open only editRanges from the pack before editing.
Run expectedVerification.commands and report whether public API changed.
```

Expected behavior:

- Agent khong doi public API neu prompt khong yeu cau.
- Behavior tests pass.
- Diff gioi han vao file/source duoc pack de xuat.

### 5. Create testcase

Prompt:

```text
Use CodeGraph MCP server codegraph-hadoop.
First call get_change_pack with changeType=test for:
"Create a focused test proving OrderService.create checks availability, reserves items, then charges."
Do not change production files.
Use taskOracle.expectedVerification and likelyTests to choose the test style.
The new test must fail if the reserve call is removed.
```

Expected behavior:

- Agent them test dung stack hien co.
- Khong sua production code de lam test pass.
- Co mutation/red check neu co the.

### 6. Code review

Prompt:

```text
Use CodeGraph MCP server codegraph-hadoop.
Call review_patch with focus=api-contract and outputMode=compact for this diff.
Use seededRiskCategories, mustCheckInvariants, knownSensitiveDataPatterns, and precisionTargets.
Before final findings, call only requiredToolCalls needed to confirm P0/P1 findings.
Return findings first with file/line, severity, why, suggested fix, and test gap.
Do not report blockers without exact evidence.
```

Expected behavior:

- Agent khong review diff line-by-line tran lan.
- Findings co file/line va severity.
- Hypothesis khong co evidence thi phai ghi la can verify, khong block.

### 7. Break task / planning

Prompt:

```text
Use CodeGraph MCP server codegraph-hadoop.
Call get_research_pack for the target feature first.
Then break work into an ordered task DAG with dependencies, risks, validation milestones, and definition of done.
Use taskOracle.goldenFacts as required coverage.
Do not edit files.
```

Expected behavior:

- Plan dua tren source evidence.
- Co dependency/order/test milestone.
- Khong bien thanh marketing-style plan chung chung.

## Prompt pattern tot nhat

Dung format nay de agent it di lac:

```text
Use CodeGraph MCP server <server-name>.
Task type: <investigate|implement|debug|test|review|refactor|break-task>.
First tool: <tool-name>.
Target: <class/method/path/file/diff>.
Rules:
- Use the pack's taskOracle/expectedVerification/invariants.
- Open exact get_file_slice ranges before editing.
- Do not use shell grep/read unless missingFacts requires it.
- Run listed validation commands.
Output:
- changed files or findings
- validation result
- unresolved risks only if evidence is missing
```

## Cach tiet kiem token

- Voi architecture/deep dive: dung `get_research_pack`/`get_flow_pack`, doc
  `compressedEvidence` truoc, chi mo `evidenceSlices` khi can exact quote.
- Voi edit/debug: dung `get_change_pack`, sau do mot batch `get_file_slice`.
- Voi review: dung `review_patch outputMode=compact`; chi rerun `balanced` cho
  mot subsystem/file group, khong rerun full diff.
- Dung `tokenBudget` 4000-8000 cho task binh thuong. Tang len 12000 chi khi
  pack bao thieu evidence.
- Khong yeu cau agent "study entire repo" neu da biet target symbol/path.

## Khi nao khong nen dung CodeGraph dau tien

- Task chi la format mot file da mo san.
- Sua typo/doc nho khong can graph.
- Repo chua prewarm va ban can response cuc nhanh trong lan dau.
- Search literal string rat cu the trong mot file da biet; shell search co the
  nhanh hon.

## Xu ly stale index

Neu source moi thay doi:

- Repo nho/local: dung `--watch` hoac `autoRefresh:true`.
- Repo lon Docker bind mount: prewarm lai bang `index --root /workspace`, hoac
  bat `--watch` chi sau khi da test save latency.
- Branch checkout/pull lon: chay full refresh background/prewarm, khong trong
  tool call dang answer.

Kiem tra stale:

```text
Use codegraph MCP get_index_stats and report indexFreshness / dirty file counts.
```

## Model nho vs model lon

Voi model nho, prompt can ep dung pack/oracle hon:

```text
You must follow taskOracle.successCriteria, expectedVerification, and invariants.
Do not invent files. If missingFacts is non-empty, perform only the listed follow-up.
```

Voi model lon, co the cho them autonomy, nhung van nen bat:

```text
Use review_patch/get_change_pack first and keep follow-up tool calls bounded.
```

Ket qua benchmark hien tai cho thay CodeGraph giup tiet kiem token ro nhat voi
`gpt-5.4-mini` va nhe voi `gpt-5.4` tren fixture. Voi repo nho, overhead MCP co
the lon hon loi ich; voi repo lon, loi ich chinh la routing dung file/symbol va
giam doc file tran lan.

## Checklist truoc khi ket luan agent dung tot

- Da co log `event:"query"` voi tool dung.
- Agent khong mo hang loat file bang grep/read sau khi pack da du context.
- Final answer co file/line evidence hoac validation result.
- Implement/debug/refactor co targeted test/lint/compile pass.
- Review findings co file/line/severity/suggested fix va khong co unsupported blocker.
- Neu quality quan trong, chay benchmark E2E:

```powershell
node D:\Personal\Projects\code-graph\dist\cli.js benchmark copilot-e2e `
  --models gpt-5-mini,gpt-5.4-mini `
  --modes codegraph,baseline `
  --task-ids fixture-implement-reserve-before-charge
```
