# CLI Reference

CodeGraph ships one CLI, `codegraph` (entrypoint `dist/cli.js`). After the
TokenOpt fusion, the TokenOpt operational surface is reached through the
`codegraph gate <…>` subcommand. The legacy `tokenopt` binary alias is preserved
for existing hook installs.

```powershell
node dist/cli.js <command> [options]
# or, when on PATH:
codegraph <command> [options]
```

## CodeGraph commands

| Command | Purpose |
| --- | --- |
| `mcp --root <repo>` | Run the fused MCP stdio server (CodeGraph packs + ContextGate gate). |
| `setup --root <repo>` | Build `.codegraph/graph.sqlite` and the local artifact index. |
| `index --root <repo>` | Build or refresh the SQLite graph index. |
| `atlas --root <repo>` | Generate a deterministic repo atlas (JSON/Markdown). |
| `graph --root <repo> --out <graph.html>` | Export a self-contained graph viewer. |
| `doctor --root <repo>` | Inspect readiness, freshness, and setup actions. |
| `status --root <repo> [--json] [--require-ready] [--require-fresh]` | Human/machine-readable status; non-zero exit for CI gating. |
| `logs --root <repo> --tail <n> [--summary\|--all\|--since\|--until\|--tool\|--event\|--invalid]` | Print recent query events or a compact summary. |
| `upgrade-audit --root <repo> [policy/threshold flags]` | Readiness + query-log audit with an `A+`–`F` grade. |
| `affected-tests --root <repo> --base <ref> [--format json\|list\|maven\|gradle]` | CI test selection over a git range; `ALL` = safety fallback. `--changed <file[,file…]>` still works for explicit lists. |
| `review --root <repo> --base <ref> [--format json\|sarif\|markdown\|text] [--min-priority P0\|P1\|P2] [--fail-on P0\|P1\|P2\|none] [--out <path>]` | Deterministic PR review over a git range: graph-fact findings (stale callers, untested change, duplication, design smells) as SARIF for GitHub code scanning or markdown for a sticky PR comment. Exit code gates on `--fail-on`. |
| `onboard --root <repo> [--profile architecture\|claude\|copilot\|both] [--dry-run]` | Generate `ARCHITECTURE.md` (humans), `CLAUDE.md` (agents), and `.github/copilot-instructions.md` (Copilot) from index facts. The agent files include an MCP-routing block (call `codegraph_context` first, hedged on the tools being available in-session). Marker-based: only the `<!-- codegraph:begin/end generated -->` block is rewritten, hand-written content survives regeneration. |
| `adoption-report --root <repo> [--since <ISO>] [--until <ISO>] [--format json\|text]` | Aggregate the MCP call ledger (`.codegraph/logs/query.jsonl`) into real-usage adoption numbers: calls by tool/day, conversations (distinct `sessionId`), % starting with the `codegraph_context` gate, answerable-rate. Dogfood instrumentation for [the adoption plan](mcp-adoption-plan.md). |
| `benchmark <sub>` | Deterministic harnesses (see below). |

### Common MCP flags

```text
--mcp-profile <client|minimal|research|change|review|full>   Exposed tools/list width
--workspace-key <key>        Stable workspace identity for unusual mount paths
--parse-workers <n>          Worker threads for cold/cache-miss parsing
--auto-refresh               Refresh stale snapshots before MCP tool calls when safe
--refresh-on-start           Queue a background refresh when MCP starts
--watch                      Watch files and refresh changed paths in the background
--warn-stale / --no-warn-stale   Freshness checks on every tool response (on by default)
--prewarm                    Index missing snapshots inside MCP startup/runtime
```

See [MCP Setup And Usage](mcp-setup-and-usage.md) for profiles, modes, and the
`TOKENOPT_MCP_MODE` override.

### `benchmark` subcommands

```text
codegraph benchmark generate|index|eval|proof|review|fallback|route-gate|
                    quality-trend|evidence-audit|recall|affected-tests|
                    copilot-e2e|codex-e2e
```

- `recall [--root <repo>] [--tasks <suite.json>] [--max-files N] [--keep-ratio R]`
  — broad multi-file recall (allFound, avg recall, recall@N) with right-sizing ON
  vs the no-trim baseline. Point it at any repo.
- `evidence-audit` — measures Waste% (evidence sent but not needed) and Gap%
  (needed evidence never delivered) so packets can be right-sized.
- `quality-trend [--out <report.md>]` — appends a dated correctness/token-saving
  row so ranking/resolver regressions surface over time.

## `gate` subcommands

`codegraph gate <…>` delegates to the TokenOpt CLI. It covers config
scaffolding, exec wrapping, reporting, and the gate doctor.

| Subcommand | Purpose |
| --- | --- |
| `gate init` | Scaffold TokenOpt config in the current repo. |
| `gate exec -- <command>` | Run a command through the gate's exec wrapper. |
| `gate report` | Emit a gate/session report. |
| `gate doctor` | Diagnose gate wiring. |

> `codegraph gate mcp` is intentionally **rejected**. The fused `codegraph mcp`
> server already exposes the TokenOpt/ContextGate gate tools — there is no
> separate gate MCP server. See [Migration](MIGRATION.md).

### Legacy alias

The `tokenopt` bin (→ `dist/tokenopt/cli.js`) is kept so existing hook installs
that shell out to `tokenopt …` keep working. New setups should use
`codegraph gate …`.
