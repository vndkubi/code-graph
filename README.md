# mcp-code-graph

MCP server that exposes a real-time codebase dependency graph as queryable tools for GitHub Copilot agents.

Supports **Java** (Spring Boot, Jakarta EE, Lombok, JUnit), **TypeScript/JavaScript**, and **Python** via tree-sitter parsing.

---

## Tools

| Tool | Description |
|------|-------------|
| `search_symbol` | Search symbols by name, kind, annotation, or framework role |
| `find_references` | Find all references to a symbol (definitions, imports, calls) |
| `get_dependencies` | Find modules that a given module depends on |
| `get_dependents` | Find modules that depend on a given module |
| `get_call_chain` | Trace function call paths between two symbols |
| `get_impact_radius` | Compute blast radius for a proposed change |
| `find_circular_dependencies` | Detect circular dependency cycles |
| `get_module_graph` | Export the full dependency graph (JSON/Mermaid/DOT) |

All tools return a **confidence score** (0–1) and notes explaining any limitations (parse errors, fuzzy symbol resolution, unresolved imports).

---

## Quick Start

### Prerequisites

- **Node.js 20+** — check with `node --version`
- **npm** — bundled with Node.js

### 1. Install & Build

```bash
git clone <repo>
cd mcp-code-graph
npm install
npm run build
```

### 2. Run the server

**stdio (for direct VS Code / Copilot integration):**

```bash
node dist/server.js --root /path/to/your/project
```

**HTTP (for browser, curl, or multi-client access):**

```bash
node dist/server.js --root /path/to/your/project --transport http --port 3100
```

---

## Integrate with VS Code / GitHub Copilot

Add to your project's `.vscode/settings.json`:

### Option A — stdio (recommended for local dev)

```jsonc
{
  "mcp": {
    "servers": {
      "code-graph": {
        "type": "stdio",
        "command": "node",
        "args": [
          "/absolute/path/to/mcp-code-graph/dist/server.js",
          "--root",
          "${workspaceFolder}"
        ]
      }
    }
  }
}
```

> Replace `/absolute/path/to/mcp-code-graph` with the actual path where you cloned this repo.

### Option B — HTTP (for Docker / WSL / remote)

```jsonc
{
  "mcp": {
    "servers": {
      "code-graph": {
        "type": "http",
        "url": "http://localhost:3100"
      }
    }
  }
}
```

> Start the server separately with `--transport http --port 3100`.

---

## Docker

### Build the image

```bash
# Build only
./docker-build.sh

# Build + export to tar.gz (for transfer to WSL / another machine)
./docker-build.sh --export

# Export to a specific path
./docker-build.sh --export --out /mnt/d/transfer/mcp-code-graph.tar.gz

# Build + run immediately against a project
./docker-build.sh --run /path/to/your/project

# Custom port
./docker-build.sh --run /path/to/your/project --port 3200
```

### Transfer to WSL / another machine via tar.gz

```bash
# On the source machine (Windows PowerShell or WSL with Docker Desktop):
./docker-build.sh --export
# → produces mcp-code-graph-latest.tar.gz

# Copy the file to the target machine, then load it:
docker load -i mcp-code-graph-latest.tar.gz
# → Loaded image: mcp-code-graph:latest

# Run immediately after loading:
docker run --rm \
  -v "/path/to/project:/workspace:ro" \
  -p 3100:3100 \
  mcp-code-graph:latest
```

### Run manually

```bash
docker build -t mcp-code-graph .

docker run --rm \
  -v "/absolute/path/to/project:/workspace:ro" \
  -p 3100:3100 \
  mcp-code-graph
```

### Windows host → WSL2 / Docker Desktop

When your project lives on Windows (`D:\Projects\myapp`) and you run Docker from WSL2:

```bash
# WSL2: Windows drives are mounted under /mnt/
docker run --rm \
  -v "/mnt/d/Projects/myapp:/workspace:ro" \
  -p 3100:3100 \
  mcp-code-graph
```

Then add to `.vscode/settings.json` (running on Windows side):

```jsonc
{
  "mcp": {
    "servers": {
      "code-graph": {
        "type": "http",
        "url": "http://localhost:3100"
      }
    }
  }
}
```

### Docker Compose (optional)

```yaml
# docker-compose.yml — place in the project you want to analyze
services:
  code-graph:
    image: mcp-code-graph:latest
    volumes:
      - .:/workspace:ro
    ports:
      - "3100:3100"
```

```bash
docker compose up -d
```

---

## CLI Reference

```
--root <path>          Project root to analyze (default: cwd)
--transport <type>     Transport: stdio (default) | http
--port <number>        HTTP port (default: 3100)
--log-level <level>    Log level: debug | info | warn | error (default: warn)
--cache-ttl <ms>       Index cache TTL in milliseconds (default: 300000)
--max-file-size <kb>   Max file size to index in KB (default: 500)
--exclude <pattern>    Additional glob exclusion pattern (repeatable)
--version              Print version
--help                 Show help
```

**Examples:**

```bash
# Analyze a Java project, exclude generated sources
node dist/server.js --root /path/to/project \
  --exclude "**/generated/**" \
  --exclude "**/target/**"

# HTTP server on custom port with debug logging
node dist/server.js --root /path/to/project \
  --transport http --port 4000 \
  --log-level debug

# Larger files (e.g. generated protobuf Java)
node dist/server.js --root /path/to/project --max-file-size 2000
```

---

## Development

```bash
npm run dev -- --root /path/to/project   # Run with tsx (no build step)
npm run build                             # Compile TypeScript → dist/
npm test                                  # Run test suite
npm run test:watch                        # Watch mode
npm run lint                              # Type-check only
```

**Run demo scripts** (requires `npm run build` first):

```bash
node demo.mjs              # Spring Boot (doughnut project)
node demo-jakartaee.mjs    # Jakarta EE MVC sample
node demo-ecommerce.mjs    # Jakarta EE Servlet + JPA
```

---

## Supported Languages & Framework Detection

### Java

| Feature | Details |
|---------|---------|
| Symbols | classes, interfaces, enums, records, fields, methods, constructors |
| Imports | full package path resolution |
| Call graph | method calls, method references (`User::getName`) |
| Framework roles | Spring Boot, Jakarta EE, JUnit 5/4, Mockito, Lombok |
| Annotation filters | `search_symbol` accepts `annotation` and `frameworkRole` params |

**Framework roles** detectable via `search_symbol { frameworkRole: "..." }`:

| Role | Annotations |
|------|------------|
| `spring:rest-controller` | `@RestController` |
| `spring:endpoint` | `@GetMapping`, `@PostMapping`, `@PutMapping`, etc. |
| `spring:service` | `@Service` |
| `spring:transactional` | `@Transactional` |
| `mvc:controller` | `@Controller` + `@Path` (Jakarta MVC) |
| `jaxrs:endpoint` | `@GET`, `@POST`, `@PUT`, `@DELETE`, `@PATCH` |
| `jaxrs:provider` | `@Provider` (ExceptionMapper, ParamConverter) |
| `jakarta:entity` | `@Entity` |
| `jakarta:stateless` | `@Stateless` |
| `jakarta:singleton` | `@Singleton` + `@Startup` |
| `jakarta:web-servlet` | `@WebServlet` |
| `jakarta:web-filter` | `@WebFilter` |
| `jakarta:lifecycle` | `@PrePersist`, `@PostConstruct`, etc. |
| `jakarta:validation` | `@NotNull`, `@Size`, `@Email`, etc. |
| `test:test` | `@Test` (JUnit 5/4) |
| `test:mock` | `@Mock`, `@MockBean` (Mockito) |
| `lombok:data` | `@Data` |
| `lombok:builder` | `@Builder` |

### TypeScript / JavaScript

| Feature | Details |
|---------|---------|
| Symbols | classes, interfaces, functions, arrow functions, methods |
| Imports | `import`/`require`, resolves relative paths |
| Call graph | function and method calls |

### Python

| Feature | Details |
|---------|---------|
| Symbols | classes, functions, methods |
| Imports | `import`/`from...import` |
| Call graph | function and method calls |

---

## Architecture

```
src/
├── server.ts                  # Entry point, CLI, MCP tool registration
├── analyzers/
│   ├── base-analyzer.ts       # Interfaces: SymbolInfo, ParseResult, TypeRefInfo
│   ├── language-detector.ts   # File extension → language mapping
│   ├── tree-sitter-analyzer.ts # AST parsing for Java, TS, Python
│   └── java-framework-detector.ts  # Annotation → framework role mapping + Lombok synthesis
├── graph/
│   ├── dependency-graph.ts    # Module-level dependency graph
│   ├── call-graph.ts          # Function call graph with confidence scoring
│   ├── graph-builder.ts       # Assembles both graphs from parse results
│   └── cycle-detector.ts      # Tarjan's SCC for circular dependency detection
├── index/
│   ├── file-indexer.ts        # Orchestrates indexing, caching, parse error tracking
│   ├── symbol-index.ts        # Symbol search (name, kind, annotation, frameworkRole)
│   └── import-index.ts        # Import reference lookup
├── tools/                     # MCP tool handlers (one file per tool)
├── transport/
│   ├── stdio.ts               # stdio MCP transport
│   └── http.ts                # HTTP/SSE MCP transport
├── cache/
│   └── lru-cache.ts           # LRU cache with mtime-based invalidation
└── utils/
    ├── confidence.ts          # Confidence score computation
    ├── errors.ts              # Error types
    └── path-guard.ts          # Directory traversal prevention
```

---

## License

MIT
