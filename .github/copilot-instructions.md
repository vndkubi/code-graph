# CodeGraph repository instructions

Use TDD and keep changes trunk-based: add or update a focused failing test before implementation, then run the narrow test, `npm run lint`, and `npm run build`.

## Repository context

When the `codegraph` MCP tools are available, call `codegraph_context` first with the user's full task and reuse one `sessionId` per conversation. Do not set a routing mode; the server infers it from the task. If the packet says `answerable=true`, answer from its evidence and stop broad grep/read/shell exploration. Use `codegraph_slice` only for an exact missing file, line range, or symbol named by the packet.
For PR review, pass `prUrl` or `baseRef` plus `headRef` when available; a GitHub PR URL or `from <base> to <head>` phrase in the task is resolved into an immutable, batched review. If the packet says `answerable=false`, follow its exact `allowedFollowups` instead of answering from zero patch metrics.

The default `client` MCP profile intentionally exposes only `codegraph_context`, `codegraph_slice`, and `codegraph_status` to reduce tool-selection and schema overhead.
