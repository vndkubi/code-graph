# MCP Code Graph — Product Requirements

> **Project**: `mcp-code-graph` (standalone repository, separate from copilot-bootstrap)
> **Type**: MCP (Model Context Protocol) Server
> **Purpose**: Expose real-time codebase dependency graph as queryable tools for GitHub Copilot agents
> **Version**: 1.0.0

---

## 1. Problem Statement

GitHub Copilot agents cannot inherently understand **which modules depend on which**, **what breaks if X changes**, or **what calls Y**. They can only grep text — they have no semantic understanding of the dependency graph.

Currently, `copilot-bootstrap` generates a static `module-dependency-map.json` (Approach 1). This file is generated once and becomes stale. It cannot answer fine-grained questions like "which specific methods in `OrderService` call `PaymentGateway`?" or "trace the full call chain from `OrderController.create()` to the database".

This project provides **real-time, on-demand** answers to these questions via MCP tools that agents call directly.

---

## 2. Goals

| Goal | Description |
|---|---|
| **G1** | Agent asks "what breaks if I change `PaymentService`?" → gets accurate answer in < 2s |
| **G2** | Agent asks "what calls `authenticate()`?" → gets file + line + context |
| **G3** | Agent asks "trace call chain from `OrderController.create` to DB" → gets full path |
| **G4** | Works on Java, TypeScript, Python, Kotlin, Swift without configuration |
| **G5** | Runs locally via stdio — no server setup required for VS Code users |
| **G6** | Zero config — point at repo root, it figures out the rest |

---

## 3. Non-Goals

- Does NOT modify any source files (read-only)
- Does NOT replace the static `module-dependency-map.json` (they complement each other)
- Does NOT support compiled-only analysis (e.g., reading `.class` bytecode)
- Does NOT provide IDE features (autocomplete, rename refactor) — that's LSP's job
- Does NOT require a running build or compilation

---

## 4. Tech Stack

| Layer | Decision | Reason |
|---|---|---|
| Language | **TypeScript** (Node.js 20+) | Official MCP SDK is TypeScript-first; best ecosystem |
| MCP SDK | `@modelcontextprotocol/sdk` latest | Official Anthropic SDK |
| Schema validation | `zod` | Required by MCP SDK, excellent DX |
| Parser | `tree-sitter` + language grammars | Supports 30+ languages via single API, no compilation needed |
| Transport | **stdio** (primary) + HTTP/SSE (secondary) | stdio for VS Code local; HTTP for remote/GitHub.com |
| Cache | In-memory (LRU, TTL-based) | Avoid re-parsing unchanged files |
| Testing | `vitest` | Fast, native ESM support |
| Package manager | `npm` | Widest compatibility |

### Language grammar packages (install as needed)

```
tree-sitter-java
tree-sitter-typescript
tree-sitter-python
tree-sitter-kotlin
tree-sitter-swift
tree-sitter-c-sharp
tree-sitter-php
```

---

## 5. Architecture

```
┌─────────────────────────────────────────────────┐
│                 MCP Client                       │
│    (GitHub Copilot VS Code / GitHub.com Agent)   │
└───────────────────┬─────────────────────────────┘
                    │  stdio (JSON-RPC)
                    ▼
┌─────────────────────────────────────────────────┐
│              MCP Server Layer                    │
│  server.ts — register tools, handle requests     │
└───────────────────┬─────────────────────────────┘
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
┌──────────┐ ┌──────────┐ ┌──────────────┐
│  Tools   │ │  Index   │ │   Cache      │
│ (8 fns)  │ │  Engine  │ │  (LRU+TTL)   │
└─────┬────┘ └────┬─────┘ └──────────────┘
      │           │
      └─────┬─────┘
            ▼
┌─────────────────────────────────────────────────┐
│            Analyzer Layer                        │
│   tree-sitter parsers × language grammars        │
│   Graph builder — adjacency list + call graph    │
│   Query engine — BFS/DFS traversals              │
└─────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────┐
│          File System (read-only)                 │
│   repo root → source files                       │
└─────────────────────────────────────────────────┘
```

---

## 6. Project Structure

```
mcp-code-graph/
├── src/
│   ├── server.ts                   # Entry point: MCP server init + tool registration
│   ├── tools/
│   │   ├── find-references.ts      # FR-001
│   │   ├── get-dependents.ts       # FR-002
│   │   ├── get-dependencies.ts     # FR-003
│   │   ├── get-call-chain.ts       # FR-004
│   │   ├── get-impact-radius.ts    # FR-005
│   │   ├── find-cycles.ts          # FR-006
│   │   ├── get-module-graph.ts     # FR-007
│   │   └── search-symbol.ts        # FR-008
│   ├── analyzers/
│   │   ├── base-analyzer.ts        # Interface: CodeAnalyzer
│   │   ├── tree-sitter-analyzer.ts # Core parser (all languages)
│   │   └── language-detector.ts    # Detect language from file extension + content
│   ├── graph/
│   │   ├── dependency-graph.ts     # Graph data structure (adjacency list)
│   │   ├── call-graph.ts           # Function-level call graph
│   │   ├── graph-builder.ts        # Build graphs from parsed ASTs
│   │   └── cycle-detector.ts       # DFS-based cycle detection
│   ├── index/
│   │   ├── file-indexer.ts         # Walk repo, parse files, populate graph
│   │   ├── symbol-index.ts         # symbol name → {file, line, kind}
│   │   └── import-index.ts         # module → [imported-by] reverse map
│   ├── cache/
│   │   └── lru-cache.ts            # LRU cache with file-change invalidation
│   ├── transport/
│   │   ├── stdio.ts                # stdio transport (primary)
│   │   └── http.ts                 # HTTP/SSE transport (secondary)
│   └── utils/
│       ├── path-guard.ts           # Prevent path traversal attacks
│       └── errors.ts               # MCP error codes + messages
├── tests/
│   ├── fixtures/
│   │   ├── java-project/           # Minimal Java Maven project for testing
│   │   ├── ts-project/             # Minimal TypeScript project for testing
│   │   └── python-project/         # Minimal Python project for testing
│   ├── tools/
│   │   ├── find-references.test.ts
│   │   ├── get-dependents.test.ts
│   │   └── ...
│   └── graph/
│       ├── cycle-detector.test.ts
│       └── graph-builder.test.ts
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .nvmrc                          # Node 20
└── README.md
```

---

## 7. Functional Requirements

### FR-001: `find_references`

**Description**: Find all locations in the codebase that reference a given symbol (class, function, variable, interface).

**Input**:
```typescript
{
  symbol: string            // Required. Class/function/variable name. Exact or regex.
  file?: string             // Optional. Restrict to a single file path (relative to root).
  kind?: 'call'             // Optional. Filter by reference kind.
        | 'import'
        | 'definition'
        | 'all'             // Default: 'all'
  contextLines?: number     // Optional. Lines of surrounding code. Default: 2. Max: 5.
}
```

**Output**:
```typescript
{
  references: Array<{
    file: string            // Relative path from repo root
    line: number            // 1-indexed
    column: number          // 1-indexed
    kind: 'call' | 'import' | 'definition' | 'type'
    context: string         // The matching line + contextLines above/below
    symbolName: string      // Exact matched symbol name (useful when input was regex)
  }>
  totalCount: number
  filesScanned: number
  truncated: boolean        // true if results > 100 (return first 100)
}
```

**Acceptance criteria**:
- Returns results within 2s for repos up to 50,000 LOC
- Finds `import` statements, constructor calls, method calls, type annotations
- Does NOT return results inside comments (unless they are JSDoc/JavaDoc)
- Returns empty array (not error) when symbol not found

---

### FR-002: `get_dependents`

**Description**: Find all modules that depend ON a given module — i.e., who imports or uses it.

**Input**:
```typescript
{
  module: string            // Required. Module ID (from dep map), file path, or module name.
  recursive?: boolean       // Optional. Include transitive dependents. Default: false.
  maxDepth?: number         // Optional. Transitive depth limit. Default: 3. Max: 10.
}
```

**Output**:
```typescript
{
  module: string            // Resolved module identifier
  direct: Array<{
    moduleId: string
    modulePath: string
    importStatement: string // The actual import line
    usageCount: number      // How many times symbols from this module are used
    riskLevel: 'high' | 'medium' | 'low'
  }>
  transitive: Array<{       // Only populated when recursive: true
    moduleId: string
    via: string[]           // Dependency chain path
    depth: number
  }>
  directCount: number
  transitiveCount: number   // 0 when recursive: false
}
```

**Acceptance criteria**:
- Reads `module-dependency-map.json` first if available (O(1) lookup)
- Falls back to import scanning if map not found
- `riskLevel` = high if this module's dependents > 5, medium if 2–4, low if 0–1
- Recursive traversal uses BFS to avoid stack overflow on large graphs

---

### FR-003: `get_dependencies`

**Description**: Find all modules that a given module depends ON — i.e., what does it import.

**Input**:
```typescript
{
  module: string            // Required. Module ID, file path, or module name.
  transitive?: boolean      // Optional. Include indirect dependencies. Default: false.
  typeFilter?: 'all'        // Optional. Default: 'all'.
             | 'local'      // Only project-internal modules
             | 'external'   // Only third-party packages
}
```

**Output**:
```typescript
{
  module: string
  dependencies: Array<{
    moduleId: string
    modulePath: string
    type: 'local' | 'external'
    importCount: number     // Number of import statements
    usageCount: number      // Number of usages of exported symbols
    scope: 'compile' | 'runtime' | 'test' | 'optional'
  }>
  totalCount: number
}
```

---

### FR-004: `get_call_chain`

**Description**: Find the call path from function/method A to function/method B, tracing through the call graph.

**Input**:
```typescript
{
  from: string              // Required. "ClassName.methodName" or just "functionName"
  to: string                // Required. Target symbol (same format as from)
  maxDepth?: number         // Optional. Max chain length. Default: 5. Max: 15.
  allPaths?: boolean        // Optional. Return all paths, not just shortest. Default: false.
}
```

**Output**:
```typescript
{
  found: boolean
  chains: Array<{
    path: Array<{
      symbol: string        // "ClassName.methodName"
      file: string
      line: number
    }>
    depth: number
    isShortest: boolean
  }>
  searchedNodes: number     // For transparency on search scope
  message?: string          // e.g., "No path found within depth 5"
}
```

**Acceptance criteria**:
- Uses BFS to find shortest path first
- Returns empty chains + `found: false` when no path exists within maxDepth
- When `allPaths: false`, returns only the shortest chain (fastest response)
- Chain traversal respects module boundaries from dep map

---

### FR-005: `get_impact_radius`

**Description**: Given a module or class, compute the full blast radius — what would be affected if it changes.

**Input**:
```typescript
{
  target: string            // Required. Module ID, class name, or file path.
  changeType?: 'signature'  // Optional. Type of change being made.
             | 'behavior'   // Breaking behavior change
             | 'delete'     // Deletion
             | 'any'        // Default: 'any'
}
```

**Output**:
```typescript
{
  target: string
  blastRadius: 'high' | 'medium' | 'low'
  direct: Array<{
    moduleId: string
    impactType: 'breaking' | 'likely' | 'possible'
    reason: string          // Human-readable explanation
    keyCallSites: string[]  // "ClassName.method() at File:Line"
  }>
  transitive: Array<{
    moduleId: string
    via: string[]           // Path through which impact propagates
    depth: number
    impactType: 'possible'
  }>
  summary: string           // e.g., "3 direct dependents (1 breaking), 7 transitive"
  recommendations: string[] // e.g., "Update OrderService.chargeOrder() callers"
}
```

**Blast radius rules**:
- `high`: directCount ≥ 5 OR any breaking direct impact
- `medium`: directCount 2–4 OR transitive > 10
- `low`: directCount 0–1 AND transitive ≤ 10

---

### FR-006: `find_circular_dependencies`

**Description**: Detect all circular import cycles in the codebase.

**Input**:
```typescript
{
  scope?: 'modules'         // Optional. Default: 'modules' (inter-module only).
        | 'files'           // File-level cycles
        | 'all'
  minCycleLength?: number   // Optional. Ignore cycles shorter than N. Default: 2.
}
```

**Output**:
```typescript
{
  cycles: Array<{
    id: string              // Unique cycle identifier
    modules: string[]       // Module IDs in the cycle
    chain: string           // Human-readable: "A → B → C → A"
    severity: 'high' | 'medium' | 'low'
    suggestion: string      // e.g., "Extract shared interface to break cycle"
  }>
  totalCycles: number
  clean: boolean            // true if no cycles found
}
```

**Severity rules**:
- `high`: Cycle involves a `shared` or `domain` module
- `medium`: Cycle length ≤ 3
- `low`: Long cycles or test-only cycles

---

### FR-007: `get_module_graph`

**Description**: Return the full dependency graph for visualization or further analysis.

**Input**:
```typescript
{
  format?: 'json'           // Default: 'json'. Adjacency list.
         | 'mermaid'        // Mermaid graph TD syntax
         | 'dot'            // Graphviz DOT format
  includeExternal?: boolean // Include third-party dependencies. Default: false.
  filterLayer?: string      // Optional. Only include modules of this layer type.
}
```

**Output** (format: json):
```typescript
{
  nodes: Array<{
    id: string
    name: string
    type: string
    layer: string
    path: string
    riskLevel: 'high' | 'medium' | 'low'
    inDegree: number
    outDegree: number
  }>
  edges: Array<{
    from: string
    to: string
    type: 'compile' | 'runtime' | 'test'
  }>
  metadata: {
    totalNodes: number
    totalEdges: number
    generatedAt: string
  }
}
```

**Output** (format: mermaid): Raw Mermaid string with classDef color coding.

---

### FR-008: `search_symbol`

**Description**: Search for symbols (classes, functions, methods, variables) by name pattern.

**Input**:
```typescript
{
  query: string             // Required. Exact name or regex pattern.
  kind?: 'class'            // Optional. Symbol type filter. Default: 'all'.
       | 'function'
       | 'method'
       | 'interface'
       | 'variable'
       | 'all'
  module?: string           // Optional. Restrict to specific module.
  limit?: number            // Optional. Max results. Default: 20. Max: 100.
}
```

**Output**:
```typescript
{
  symbols: Array<{
    name: string
    kind: string
    file: string
    line: number
    signature: string       // e.g., "public OrderDto createOrder(CreateOrderRequest)"
    module: string
    visibility: 'public' | 'private' | 'protected' | 'internal'
  }>
  totalFound: number
  truncated: boolean
}
```

---

## 8. Non-Functional Requirements

### NFR-001: Performance

| Metric | Target | Maximum |
|---|---|---|
| First tool call (cold start, small repo ≤ 1k files) | < 3s | 5s |
| First tool call (warm index, any repo) | < 500ms | 1s |
| Subsequent tool calls (cached) | < 100ms | 300ms |
| Memory usage | < 256 MB | 512 MB |
| Large repo (10k files) cold start | < 15s | 30s |

**Strategy**:
- Index is built lazily on first tool call, not on server start
- File-watch invalidation: re-index only changed files
- LRU cache: evict least-recently-used parsed results when memory > 200 MB

### NFR-002: Language Coverage (v1.0)

| Language | Extensions | Support Level |
|---|---|---|
| Java | `.java` | Full: classes, methods, imports, annotations |
| TypeScript | `.ts`, `.tsx` | Full: classes, functions, imports, types |
| JavaScript | `.js`, `.jsx` | Full: functions, require/import |
| Python | `.py` | Full: classes, functions, imports |
| Kotlin | `.kt`, `.kts` | Full: classes, functions, imports |
| Swift | `.swift` | Basic: classes, functions, imports |
| C# | `.cs` | Basic: classes, methods, using |
| PHP | `.php` | Basic: classes, functions, require |

### NFR-003: Security

- **Read-only**: No tool writes to disk or executes shell commands
- **Path guard**: All file paths resolved against `--root` flag; reject `../` traversals
- **Input validation**: All tool inputs validated with zod before processing
- **Timeout**: Individual tool calls timeout after 30s
- **No secrets**: Server never reads `.env`, credential files, or private keys

### NFR-004: Reliability

- Tool call errors return structured MCP error responses (never crash the server)
- Server runs indefinitely (no memory leak from repeated indexing)
- Graceful degradation: if a file fails to parse, skip it and continue (log warning)

### NFR-005: Zero Configuration

```bash
# Install
npm install -g @yourorg/mcp-code-graph

# Run (auto-detects language from files in current directory)
npx @yourorg/mcp-code-graph --root /path/to/repo

# That's it. No config files. No build step. No language selection.
```

---

## 9. CLI Interface

```
mcp-code-graph [options]

Options:
  --root <path>        Repo root to analyze (default: current directory)
  --transport <type>   Transport: stdio (default) | http
  --port <number>      HTTP port (only with --transport http, default: 3000)
  --log-level <level>  debug | info | warn | error (default: warn)
  --cache-ttl <ms>     Cache TTL in milliseconds (default: 300000 = 5 min)
  --max-file-size <kb> Skip files larger than N KB (default: 500)
  --exclude <glob>     Exclude pattern (repeatable, e.g. --exclude "**/*.test.ts")
  --version            Show version
  --help               Show help
```

---

## 10. Integration with Copilot Bootstrap Agents

When `mcp-code-graph` is installed and running, these agents in the bootstrap toolkit use its tools:

### `dependency-analyzer.agent.md`

```yaml
mcp-servers:
  code-graph:
    type: command
    command: npx
    args: ["-y", "@yourorg/mcp-code-graph", "--root", "${workspaceFolder}"]
```

Tool usage in agent instructions:
```
When asked "what breaks if I change X?":
  → call get_impact_radius(target="X")

When asked "what calls Y?":
  → call find_references(symbol="Y", kind="call")

When asked "is there circular dependency?":
  → call find_circular_dependencies()
```

### `investigator.agent.md`

```
When doing field usage analysis:
  → call find_references(symbol="fieldName") to find all usage points
  → call get_call_chain(from="ControllerMethod", to="fieldName") for trace
```

### `technical-reviewer.agent.md`

```
When checking module boundaries in PR:
  → call get_dependents(module="changed-module") to assess blast radius
  → call find_references(symbol="ChangedClass") to find all callers
```

---

## 11. Acceptance Criteria (Definition of Done)

### v1.0 — MVP

- [ ] All 8 tools implemented and returning correct results
- [ ] Java + TypeScript + Python supported (minimum language set)
- [ ] stdio transport working with GitHub Copilot VS Code
- [ ] Cold start < 5s for repo with 1,000 files
- [ ] Warm tool call < 300ms
- [ ] All tools have unit tests with Java + TS + Python fixtures
- [ ] Path guard prevents directory traversal
- [ ] npm package published as `@yourorg/mcp-code-graph`
- [ ] README with quickstart + VS Code settings snippet
- [ ] `find_references` tested against real project and verified accurate

### v1.1

- [ ] Kotlin + Swift support added
- [ ] HTTP transport working (for GitHub.com Copilot)
- [ ] File-watch cache invalidation (don't re-index on every call)
- [ ] Memory usage < 256 MB on 10k file repo
- [ ] Integration test with copilot-bootstrap `dependency-analyzer` agent

### v2.0 (Future)

- [ ] C# + PHP support
- [ ] Persistent index (survive server restart without re-parsing)
- [ ] `.mcpb` bundle format for one-click VS Code install
- [ ] Multi-repo support (query across multiple related repos)

---

## 12. Open Questions

| # | Question | Decision needed by |
|---|---|---|
| Q1 | Package name: `@yourorg/mcp-code-graph` or `mcp-code-graph` (public)? | Before npm publish |
| Q2 | Ship with all tree-sitter grammars bundled, or install on demand per language? | Affects install size |
| Q3 | Persistent index storage: skip in v1, add in v1.1? | Architecture decision |
| Q4 | Should server auto-read `module-dependency-map.json` as starting point, then supplement with live analysis? | Yes — faster, fewer re-parses |
| Q5 | License: MIT or Apache 2.0? | Before first release |
