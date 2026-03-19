---
name: dependency-extractor
description: 'Extract and write the module dependency graph for any codebase to .github/module-dependency-map.json and .github/MODULE-ARCHITECTURE.md. Supports Maven, Gradle, npm workspaces, .NET solutions, and Python monorepos. Use after bootstrap or whenever the module structure changes. Keywords: dependency map, module graph, impact map, regenerate dependencies.'
hint: '[path to repo root, or leave blank for current directory]'
hidden: false
---

# Dependency Extractor

Scan the codebase and produce two files:
- `.github/module-dependency-map.json` — machine-readable graph for agents
- `.github/MODULE-ARCHITECTURE.md` — human-readable diagram + impact reference

## When to Use

- After running `/bootstrap-copilot` (called automatically from Phase 3b)
- After adding or removing a module
- After restructuring inter-module dependencies
- When `@dependency-analyzer` reports "map not found or stale"

---

## Step 1: Detect Build System and Module Boundaries

Read the root build file to identify all modules:

| Build System | Root File | Module Declaration |
|---|---|---|
| Maven multi-module | `pom.xml` | `<modules><module>name</module></modules>` |
| Gradle multi-project | `settings.gradle` / `settings.gradle.kts` | `include(":module-name")` |
| npm workspaces | root `package.json` | `"workspaces": ["packages/*"]` |
| .NET solution | `*.sln` | `Project(...)` entries |
| Python monorepo | `pyproject.toml` or workspace `setup.cfg` | `[tool.poetry.packages]` or `packages` list |

If none found → single-module project. Write a minimal map with one module and exit.

---

## Step 2: Extract Inter-Module Dependencies

For each module, read its build file and extract declared dependencies on OTHER modules in the same project:

**Maven** — read `pom.xml` `<dependencies>`:
```xml
<dependency>
  <groupId>com.acme</groupId>
  <artifactId>shared-api</artifactId>   ← this is a sibling module if it matches another module's artifactId
</dependency>
```

**Gradle** — read `build.gradle`:
```groovy
dependencies {
  implementation project(':shared-api')   ← direct inter-module reference
  api project(':domain')
}
```

**npm workspaces** — read each `package.json`:
```json
"dependencies": {
  "@acme/shared-utils": "*"   ← workspace package = inter-module reference
}
```

**.NET** — read each `*.csproj`:
```xml
<ProjectReference Include="..\SharedLibrary\SharedLibrary.csproj" />
```

**Python** — read `pyproject.toml`:
```toml
[tool.poetry.dependencies]
acme-shared = {path = "../shared", develop = true}
```

---

## Step 3: Verify with Import Scanning

Cross-check declared dependencies against actual source imports. This catches undeclared runtime dependencies.

Grep each module's source directory for imports referencing other modules' packages:

```bash
# Java — find cross-module package imports
grep -r "^import com\.acme\." [module]/src/main/java/ --include="*.java" -h \
  | sort -u | grep -v "^import com\.acme\.[current-module-package]\."

# TypeScript — find workspace imports
grep -r "from '@acme/" [module]/src/ --include="*.ts" --include="*.tsx" -h | sort -u

# Python — find sibling module imports
grep -r "^from [sibling_package]" [module]/src/ --include="*.py" -h | sort -u

# C# — find using statements for other project namespaces
grep -r "^using [OtherProject]\." [module]/ --include="*.cs" -h | sort -u
```

Flag any imports found in step 3 that are **NOT** declared in step 2 as undeclared dependencies (add to `violations` with type `undeclared-runtime-dependency`).

---

## Step 4: Classify Each Module

Determine each module's `type` and `layer` by scanning its source files:

```
Has @RestController / @Path / Router / Controller class  → type: api,         layer: presentation
Has @Service / @Stateless / UseCase class                → type: service,     layer: service
Has @Entity / @Table / domain model only                 → type: domain,      layer: domain
Has @Repository / DAO / migration files                  → type: persistence, layer: infrastructure
Name contains "common|shared|core|utils|base"            → type: shared,      layer: shared
Has Feign / HTTP client / external gateway class         → type: integration, layer: infrastructure
Has @Scheduled / batch processor / job runner            → type: batch,       layer: service
Has AndroidManifest / build.gradle with android plugin   → type: mobile,      layer: presentation
Has package.json + React/Vue/Angular dependencies        → type: frontend,    layer: presentation
```

---

## Step 5: Identify Key Classes and Public API

For each module, find its top-level service/API classes (these become `keyClasses` and `publicApi`):

- **Java**: classes named `*Service`, `*Resource`, `*Controller`, `*Repository` at the module root package
- **TypeScript**: exported functions/classes from `index.ts` or router files
- **.NET**: classes with `[ApiController]` or `IService` implementations
- **Python**: functions in `views.py`, `routers.py`, or exported from `__init__.py`

Limit to top 5 key classes and top 10 public API methods per module to keep the map ≤ 8 KB.

---

## Step 6: Compute Graph Metrics

After building the full edge list:

```
inDegree[module]  = count of other modules that have this module in their `dependencies`
outDegree[module] = count of modules in this module's `dependencies`
riskLevel:
  inDegree ≥ 5 → "high"
  inDegree 2-4 → "medium"
  inDegree 0-1 → "low"
```

**Detect circular dependencies** using DFS cycle detection:
- Start from each module, follow `dependencies` edges
- If you reach the starting module again → cycle detected
- Record the cycle path

**Identify critical paths** — chains of 3+ modules following `dependencies` edges that form key business flows:
- Trace the longest paths through the graph
- Name them based on the domain context (e.g., "Order Checkout Flow: api → orders → payments → external-gateway")

---

## Step 7: Write `.github/module-dependency-map.json`

Assemble and write the full JSON. Follow the schema from `generate-copilot-config` Phase 3b exactly.

Validate before writing:
- [ ] Valid JSON (no syntax errors)
- [ ] All `dependencies` values are valid module IDs in `modules[]`
- [ ] `dependents` is consistent with `dependencies` (fully computed from edge inversion)
- [ ] `graphMetadata.totalModules` matches `modules[]` length
- [ ] `graphMetadata.totalEdges` matches `dependencyEdges[]` length

---

## Step 8: Write `.github/MODULE-ARCHITECTURE.md`

Generate the markdown file with:

1. **Auto-generation header** — timestamp, toolkit version, regeneration instructions
2. **Mermaid dependency graph** — one node per module, edges from `dependencyEdges`
3. **Module inventory table** — all modules with type, layer, dependencies, risk
4. **Dependency rules table** — from `dependencyRules`
5. **Violations table** — from `violations` (empty if none)
6. **High-risk modules** — from `graphMetadata.highRiskModules`
7. **Critical paths** — from `graphMetadata.criticalPaths`
8. **Impact quick reference** — for each module, list direct and transitive dependents

Mermaid node naming convention:
```
[ID]["[DisplayName]\n([type])"]:::layerClass
```

Layer CSS classes:
```mermaid
classDef presentation fill:#dbeafe,stroke:#3b82f6
classDef service fill:#dcfce7,stroke:#22c55e
classDef domain fill:#fef9c3,stroke:#eab308
classDef persistence fill:#fce7f3,stroke:#ec4899
classDef shared fill:#f3f4f6,stroke:#6b7280
classDef integration fill:#fef3c7,stroke:#f59e0b
```

---

## Output

```
✅ Dependency Map Generated

Modules: [N]
Edges: [N]
Circular dependencies: [N] (⚠️ if > 0)
Violations: [N] (⚠️ if > 0)
High-risk modules: [list]

📄 .github/module-dependency-map.json ([size] KB)
📄 .github/MODULE-ARCHITECTURE.md ([size] KB)
```

If violations or circular dependencies found:
```
⚠️ Issues Found:
- Circular: [module-a] → [module-b] → [module-a]
- Layer violation: [module] (persistence) imports from [module] (service)
These are recorded in the map. Run @dependency-analyzer for remediation advice.
```
