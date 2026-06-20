# Contributing

CodeGraph is a local-first MCP server and indexer. Keep changes small, measurable, and compatible with the no-daemon per-repository SQLite runtime.

## Development Setup

```powershell
npm ci
npm run build
npm test
```

On Windows PowerShell, prefer `npm.cmd` if script execution policy blocks `npm.ps1`.

## Before Opening A PR

Run the same gates CI uses:

```powershell
npm run lint
npm run build
npm test
node dist/cli.js benchmark index --root .
node dist/cli.js benchmark codex-e2e --root . --suite examples/codegraph-self-e2e-quality-suite.example.json --dry-run
```

For benchmark claims, include the command, repo size, indexed file count, token estimator, and whether the run used a real agent/model or a deterministic dry-run harness.

## Scope Guidelines

- Preserve the default local path: per-repo SQLite, stdio MCP, no daemon, no HTTP hop.
- Add parser/provider support incrementally with fixtures and focused tests.
- Do not publish token-saving claims from only one tiny self-repo run as if they generalize to large repos.
- Keep MCP responses bounded and evidence-first; avoid broad raw source dumps.
- Treat generated `.codegraph/`, `.tmp/`, `dist/`, and benchmark scratch output as local state.
