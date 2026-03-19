# mcp-code-graph

MCP server that exposes a real-time codebase dependency graph as queryable tools for GitHub Copilot agents.

Supports **Java**, **TypeScript/JavaScript**, and **Python** via tree-sitter parsing.

## Tools

| Tool | Description |
|------|-------------|
| `find_references` | Find all references to a symbol (definitions, imports, calls) |
| `get_dependents` | Find modules that depend on a given module |
| `get_dependencies` | Find modules that a given module depends on |
| `get_call_chain` | Trace function call paths between two symbols |
| `get_impact_radius` | Compute blast radius for a proposed change |
| `find_circular_dependencies` | Detect circular dependency cycles |
| `get_module_graph` | Export the full dependency graph (JSON/Mermaid/DOT) |
| `search_symbol` | Search symbols by name pattern and kind |

## Quickstart

```bash
npm install
npm run build
```

### VS Code / GitHub Copilot

Add to your `.vscode/settings.json`:

```jsonc
{
  "mcp": {
    "servers": {
      "code-graph": {
        "type": "stdio",
        "command": "node",
        "args": ["<absolute-path-to>/dist/server.js", "--root", "${workspaceFolder}"]
      }
    }
  }
}
```

Or with `npx` (after `npm install -g`):

```jsonc
{
  "mcp": {
    "servers": {
      "code-graph": {
        "type": "stdio",
        "command": "npx",
        "args": ["mcp-code-graph", "--root", "${workspaceFolder}"]
      }
    }
  }
}
```

### CLI Options

```
--root <path>       Project root directory (required)
--transport <type>  Transport: stdio (default) or http
--port <number>     HTTP port (default: 3100)
--log-level <level> Log level: debug | info | warn | error (default: info)
--cache-ttl <ms>    Cache TTL in milliseconds (default: 300000)
--max-file-size <b> Max file size in bytes (default: 1048576)
--exclude <pattern> Additional glob exclusion patterns (repeatable)
--version           Print version
--help              Show help
```

## Development

```bash
npm run dev -- --root /path/to/project   # Run with tsx (no build)
npm test                                  # Run tests
npm run test:watch                        # Watch mode
npm run lint                              # Type-check
```

## Architecture

```
src/
├── server.ts              # Entry point, CLI, tool registration
├── analyzers/             # Tree-sitter based code parsing
│   ├── base-analyzer.ts   # Types & CodeAnalyzer interface
│   ├── language-detector.ts
│   └── tree-sitter-analyzer.ts
├── graph/                 # Dependency & call graphs
│   ├── dependency-graph.ts
│   ├── call-graph.ts
│   ├── graph-builder.ts
│   └── cycle-detector.ts
├── index/                 # File indexing & symbol lookup
│   ├── file-indexer.ts
│   ├── symbol-index.ts
│   └── import-index.ts
├── tools/                 # MCP tool handlers (one per file)
├── transport/             # stdio & http transports
├── cache/                 # LRU cache with mtime invalidation
└── utils/                 # Path guard, error types
```

## Supported Languages

| Language | Symbols | Imports | Call Graph |
|----------|---------|---------|------------|
| Java | classes, interfaces, methods, fields | `import` statements | method calls |
| TypeScript/JavaScript | classes, interfaces, functions, methods | `import`/`require` | function/method calls |
| Python | classes, functions, methods | `import`/`from...import` | function/method calls |

## License

MIT
