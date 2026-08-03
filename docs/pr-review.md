# Pull request review

Review a GitHub pull request from its URL:

```powershell
codegraph review `
  --root D:\src\my-repo `
  --pr https://github.com/acme/my-repo/pull/123 `
  --format markdown `
  --out codegraph-review.md
```

`--root` identifies the existing local clone. The command resolves immutable
base and head SHAs through the GitHub REST API, fetches the pull-request ref,
and checks out the head in a CodeGraph-owned detached worktree under
`.codegraph/pr-worktrees/`. The caller's checkout is not switched or reset.
The managed worktree and its index are reused when the pull request advances,
so later reviews can use incremental indexing.

Public repositories need no token. For private repositories, set `GH_TOKEN` or
`GITHUB_TOKEN`; CodeGraph sends it only in the GitHub API authorization header
and does not include it in reports or errors. The current `--pr` adapter
supports `https://github.com/<owner>/<repo>/pull/<number>` URLs. The local clone
must contain a remote whose GitHub owner/repository matches the URL.

Large diffs are split into bounded calls to `review_patch`. The final report
contains a `coverage` ledger with assigned batches, graph-resolved files,
reviewed hunks, and any omission. Do not treat a report with
`coverage.complete=false` as full-PR evidence.

Useful controls:

```text
--batch-size <number>           Changed files per batch (default 50, max 50)
--max-hunks-per-batch <number>  Hunk target per batch (default 200)
--limit <number>                Findings/evidence limit per batch (max 200)
```

Branch-to-branch review remains available:

```powershell
codegraph review --root D:\src\my-repo --base origin/main --head HEAD
```

This mode fails closed unless the checkout's current commit exactly equals
`--head` and tracked files are clean. That invariant prevents a graph built
from one source state from being combined with a diff from another.
