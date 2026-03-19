---
name: generate-copilot-config
description: 'Complete GitHub Copilot configuration generator. Runs the full 14-phase bootstrap pipeline: deep codebase scan, project classification, business domain analysis, then generates copilot-instructions.md, domain-scoped instructions, language instructions, agents, skills, prompts, hooks, agentic workflows — with 3-tier validation. This is the SINGLE SOURCE OF TRUTH for the bootstrap pipeline. Use when asked to bootstrap Copilot, generate Copilot configuration, or set up Copilot for a new project.'
---

# Generate Complete Copilot Configuration — 14-Phase Pipeline

> **This file is the SINGLE SOURCE OF TRUTH for the bootstrap pipeline.**
> All other files (`bootstrap-copilot.prompt.md`, `conductor.agent.md`) reference this skill — they do NOT define their own pipeline.

## Pipeline Overview

```
Phase 1:  SCAN — Deep multi-stack codebase analysis
Phase 2:  CLASSIFY — Project size → Small / Standard / Enterprise
Phase 3:  DOMAIN — Business domain deep analysis (rules, glossary, workflows)
Phase 4:  GEN copilot-instructions.md (≤ 4 KB index card)
Phase 5:  GEN domain-scoped .instructions.md per domain (Enterprise only)
Phase 6:  GEN language/framework .instructions.md
Phase 6b: GEN templates (.github/templates/ — PRD, API contract, DB schema)
Phase 7:  GEN agents (stack-specific + conditional + enterprise)
Phase 8:  GEN skills (auto-selected based on detected capabilities)
Phase 9:  GEN prompts (entry points, ≤ 3 KB each)
Phase 10: GEN hooks (format/lint/compile automation)
Phase 11: GEN agentic workflows (if CI/CD detected)
Phase 12: VALIDATE — structural + functional + context budget
Phase 13: DEVCONTAINER — review existing or generate new
Phase 14: MANIFEST & CLEANUP — generate manifest, delete bootstrap files, final summary
```

---

## Phase 1: SCAN — Deep Codebase Analysis

Delegate to `@codebase-analyzer` or use the `analyze-codebase` skill. This phase MUST be thorough.

**Minimum scan requirements:**
- [ ] Read ALL build config files (not just root — every module's pom.xml, every csproj, etc.)
- [ ] Sample ≥ 10 source files per detected domain (not 5 total)
- [ ] Read ALL entity/model classes
- [ ] Read ≥ 3 service classes per domain
- [ ] Read ≥ 3 test classes to detect test patterns
- [ ] Check for CI/CD, Docker, devcontainer configurations
- [ ] Scan for external service integrations (HTTP clients, message queues, event buses)
- [ ] **Detect language/runtime version** — Java: check `<java.version>` in pom.xml or `sourceCompatibility` in Gradle; .NET: check `<TargetFramework>` in csproj; Node: check `engines.node` in package.json; Python: check `python_requires` in pyproject.toml or `.python-version` file; Kotlin: check `kotlinOptions.jvmTarget`; Swift: check `SWIFT_VERSION` or `Package.swift` tools version. Record exact versions in scan output.

**Output**: Structured analysis report with: tech stack + **exact versions**, architecture pattern, module list, domain map, coding conventions, test patterns, infrastructure.

## Phase 2: CLASSIFY — Project Size

| Classification | Criteria | Strategy |
|---|---|---|
| **Small** | ≤ 5 source files, 1 module | Minimal: merged `copilot-instructions.md` + 1 implementor + 1 test agent |
| **Standard** | ≤ 100 files, 1-3 modules | Standard: + investigator, code-reviewer, dev-orchestrator |
| **Enterprise** | 5+ domains OR 10+ modules | Full suite + domain-scoped instructions + enterprise agents |
| **Framework/Library** | Published as library/framework, not deployed as application | Treat as Enterprise for instruction generation; focus on API design, backward compat, contributor guidelines |

> This classification determines what gets generated in Phases 4-11. It MUST happen before generation.
> **Note**: Framework/Library projects with 3+ modules should generate domain-scoped instructions (Phase 5) regardless of domain count.

### Context Pressure Estimate (run immediately after classification)

After determining classification, estimate context risk for the upcoming pipeline:

| Estimate | Threshold | Action |
|---|---|---|
| **Low** | ≤ 5 modules, ≤ 50 domain files | Proceed normally |
| **Medium** | 6–10 modules OR 51–150 domain files | Warn user: "This project is large — Phase 3 will summarize findings to preserve context. May need 2 sessions for Phases 4-11." |
| **High** | 10+ modules OR 150+ domain files | **HARD STOP** — output: "⚠️ Context Risk: Enterprise project with [N] modules. Running Phases 1-3 in this session. Start a new session for Phases 4-14 using the saved checkpoint. Proceed? (yes/no)" — wait for confirmation before continuing |

**Record in state**: Save estimate as `"contextRisk": "low" | "medium" | "high"` in `BOOTSTRAP_STATE.json` (see Phase 14).

### Workspace Indexing Limit Warning

GitHub Copilot's **local workspace indexing has a hard limit of 2,500 files**. Beyond this limit, Copilot falls back to basic (non-semantic) indexing, making `#codebase` searches less accurate.

Check total source file count during Phase 1 SCAN. If the project exceeds the threshold:

| File Count | Action |
|---|---|
| ≤ 2,000 files | No action needed — well within limit |
| 2,001–2,500 files | Note in checkpoint: "Near indexing limit — avoid adding many new source files" |
| > 2,500 files | **Warn** in Phase 3 checkpoint and copilot-instructions.md: "⚠️ This project exceeds Copilot's 2,500-file local indexing limit. Use **remote indexing** (index via github.com) for accurate `#codebase` search. Alternatively, narrow `#file` references when using Copilot in large modules." |

Add to `copilot-instructions.md` (Enterprise projects > 2,500 files):
```markdown
## Workspace Context
⚠️ Project exceeds 2,500-file local index limit. For accurate codebase search:
- Use `#file path/to/relevant/file` to narrow context rather than `#codebase`
- Enable remote indexing at github.com/[org]/[repo]/settings for semantic search
- For large module work, open only that module's folder in VS Code
```

## Phase 3: DOMAIN — Business Domain Deep Analysis

**CRITICAL for quality output.** Without this phase, agents produce technically correct but business-unaware code.

Extract from the codebase:
- **Domain Glossary**: Key business terms from entity names, enums, constants, service methods, documentation
- **Business Rules Summary**: Core rules from service/validator classes — what they enforce and where
- **Entity Relationship Map**: How entities relate with business-meaningful descriptions
- **Business Workflows**: Key processes and state transitions (e.g., DRAFT → SUBMITTED → APPROVED → SHIPPED)
- **Business Invariants**: Data consistency rules with justification (e.g., "sum of line items must equal order total")

### Phase 3 Checkpoint — MANDATORY OUTPUT

After completing domain analysis, produce a **checkpoint summary** before proceeding. This preserves findings if context is compacted during Phases 4-11.

Write `.github/.phase3-checkpoint.md` (≤ 3 KB) with:

```markdown
# Bootstrap Checkpoint — Phase 3 Complete

## Project Summary
- **Classification**: [Small | Standard | Enterprise]
- **Tech Stack**: [language version, framework, build tool]
- **Modules**: [count and list]
- **Domains**: [count and list with brief description]
- **Context Risk**: [low | medium | high]

## Domain Glossary (top 15 terms)
| Term | Definition |
|------|-----------|
| ... | ... |

## Key Business Rules (top 10)
1. [rule — enforced at: Service/DB/Validator]
...

## Entity Relationship Summary
[3-5 lines describing key entities and how they relate]

## Key Workflows
1. [workflow name]: [brief state transition, e.g., DRAFT → SUBMITTED → APPROVED]
...

## Tech Stack Details
- Language version: [exact version detected]
- Framework: [name + version]
- Test framework: [name + version]
- Build commands: [build / test / lint commands]
```

> **Why**: If context is compacted between sessions, agents in Phases 4-11 can load this ≤3 KB checkpoint instead of re-reading all source files.

## Phase 3b: GEN Module Dependency Map

**Trigger**: Standard or Enterprise classification (skip for Small — single module has no inter-module graph).

Build a pre-computed dependency graph from the codebase so that `@dependency-analyzer`, `@investigator`, and `@dev-orchestrator` can instantly answer "what is affected if X changes?" without re-scanning source files each time.

### Step 1: Extract Module Dependencies (read-only — no tools needed)

For each module detected in Phase 1, extract its dependencies by reading build files:

| Build System | Where to Read | What to Extract |
|---|---|---|
| Maven multi-module | Each `pom.xml` → `<dependencies>`, `<parent>`, `<modules>` | Inter-module `artifactId` references |
| Gradle multi-project | `settings.gradle` → `include`, each `build.gradle` → `dependencies {}` | `project(':module-name')` references |
| npm workspaces | `package.json` → `workspaces`, each workspace `package.json` → `dependencies` | Local package references (`"@scope/module": "*"`) |
| .NET solution | `*.sln` + each `*.csproj` → `<ProjectReference>` | `.csproj` path references |
| Python (monorepo) | Each `pyproject.toml` or `setup.py` → `[tool.poetry.dependencies]` | Local package names |

Then verify with **import scanning** — grep source files for cross-module imports to catch undeclared runtime dependencies:

```
# Java: find cross-module package imports
grep -r "^import com\.company\." src/main/java/ --include="*.java"

# TypeScript: find workspace imports
grep -r "from '@scope/" src/ --include="*.ts"

# Python: find local module imports
grep -r "^from \." src/ --include="*.py"
```

### Step 2: Identify Module Layers and Types

Classify each module by its architectural role:

| Type | Indicators |
|---|---|
| `domain` | Contains only entities, value objects, enums — no framework annotations |
| `service` | `@Service`, `@Stateless`, business logic classes, use cases |
| `api` / `presentation` | `@Controller`, `@Path`, `@RestController`, HTTP handlers |
| `persistence` | `@Repository`, DAO classes, migration files |
| `shared` | `common`, `shared`, `core`, `utils` in name; no domain logic |
| `integration` | External API clients, Feign, `@FeignClient`, HTTP client config |
| `batch` | Scheduled jobs, `@Scheduled`, batch processors |
| `mobile` | Android/iOS source structure |
| `frontend` | React/Vue/Angular component trees |

### Step 3: Detect Dependency Rules and Violations

Based on the layer classification, derive the allowed dependency direction (Clean Architecture / Onion):

```
Allowed:  api → service → domain
          api → service → persistence
          any → shared
Forbidden: domain → service (inward pointing)
           persistence → service (inward pointing)
           shared → domain (shared must be layer-agnostic)
```

Flag any detected violations as `"violations"` in the map.

### Step 4: Identify High-Risk and Critical Path Modules

- **High-risk modules**: Modules with the most dependents (high `inDegree` in the graph) — changing them has the widest blast radius
- **Isolated modules**: Modules with no dependents — safe to change independently
- **Critical paths**: Chains of 3+ modules that form key business flows (e.g., `api → orders → payments → external-gateway`)

### Step 5: Write `.github/module-dependency-map.json`

```json
{
  "$schema": "https://copilot-bootstrap.dev/dependency-map.schema.json",
  "generatedAt": "<ISO 8601 UTC>",
  "toolkitVersion": "<version>",
  "project": {
    "name": "<project name>",
    "classification": "<Small|Standard|Enterprise>",
    "buildSystem": "<maven|gradle|npm|dotnet|poetry>"
  },
  "modules": [
    {
      "id": "<kebab-case-id>",
      "name": "<display name>",
      "type": "<domain|service|api|persistence|shared|integration|batch|mobile|frontend>",
      "layer": "<domain|service|presentation|infrastructure|shared>",
      "path": "<relative path from repo root>",
      "buildFile": "<relative path to pom.xml / build.gradle / package.json>",
      "dependencies": ["<module-id>"],
      "dependents": ["<module-id>"],
      "externalDeps": [
        { "id": "<groupId:artifactId or package@version>", "scope": "<compile|runtime|test>" }
      ],
      "keyClasses": ["<ClassName>"],
      "publicApi": ["<ClassName.methodName()>"],
      "inDegree": 0,
      "outDegree": 0,
      "riskLevel": "<low|medium|high>"
    }
  ],
  "dependencyEdges": [
    {
      "from": "<module-id>",
      "to": "<module-id>",
      "type": "<compile|runtime|optional|test>",
      "via": "<import statement or build declaration>",
      "keyCallSites": ["<ClassName.method() at File:Line>"]
    }
  ],
  "dependencyRules": [
    { "fromLayer": "presentation", "toLayer": "service", "allowed": true },
    { "fromLayer": "service", "toLayer": "domain", "allowed": true },
    { "fromLayer": "domain", "toLayer": "service", "allowed": false, "reason": "Clean Architecture inward dependency" },
    { "fromLayer": "persistence", "toLayer": "service", "allowed": false, "reason": "Inversion of control violation" },
    { "fromLayer": "*", "toLayer": "shared", "allowed": true }
  ],
  "violations": [
    {
      "type": "<circular|layer-violation|internal-class-access>",
      "from": "<module-id>",
      "to": "<module-id>",
      "description": "<what the violation is>",
      "severity": "<high|medium|low>"
    }
  ],
  "circularDependencies": [
    { "cycle": ["<module-id>", "<module-id>", "..."], "description": "<how they depend on each other>" }
  ],
  "graphMetadata": {
    "highRiskModules": ["<module-id>"],
    "isolatedModules": ["<module-id>"],
    "criticalPaths": [
      {
        "name": "<path name, e.g. Order Payment Flow>",
        "path": ["<module-id>", "..."],
        "description": "<what this path implements>"
      }
    ],
    "totalModules": 0,
    "totalEdges": 0
  }
}
```

**Rules:**
- `dependencies` = modules this module depends ON (outbound edges)
- `dependents` = modules that depend ON this module (inbound edges) — derive by inverting `dependencies`
- `inDegree` = count of `dependents` — high inDegree = high blast radius risk
- `riskLevel`: `high` if inDegree ≥ 5, `medium` if 2–4, `low` if 0–1
- List only **inter-module** dependencies — exclude external library deps from the graph edges

### Step 6: Write `.github/MODULE-ARCHITECTURE.md`

Human-readable companion to the JSON map. Include a Mermaid dependency graph.

```markdown
# Module Architecture

> Auto-generated by copilot-bootstrap v[version] on [date].
> Source of truth: `.github/module-dependency-map.json`
> Regenerate: run `/bootstrap-copilot` or `dependency-extractor` skill.

## Dependency Graph

```mermaid
graph TD
    %% Layer colors
    classDef presentation fill:#dbeafe,stroke:#3b82f6
    classDef service fill:#dcfce7,stroke:#22c55e
    classDef domain fill:#fef9c3,stroke:#eab308
    classDef persistence fill:#fce7f3,stroke:#ec4899
    classDef shared fill:#f3f4f6,stroke:#6b7280

    %% Modules (one node per module with type label)
    [ID]["[Name]\n([type])"]

    %% Edges (dependencies)
    [FROM] --> [TO]

    %% Apply styles
    class [ID] [layerClass]
```

## Module Inventory

| Module | Type | Layer | Depends On | Used By | Risk |
|--------|------|-------|-----------|---------|------|
| [name] | [type] | [layer] | [comma-separated] | [comma-separated] | 🔴/🟡/🟢 |

## Dependency Rules

| Rule | Allowed | Reason |
|------|---------|--------|
| presentation → service | ✅ | Standard layered architecture |
| service → domain | ✅ | Business logic uses entities |
| domain → service | ❌ | Would create circular dependency |
| * → shared | ✅ | Shared utilities are layer-agnostic |

## Violations (if any)

| Type | From | To | Severity | Description |
|------|------|----|----------|-------------|

## High-Risk Modules

Modules with the most dependents — changes here have the widest blast radius:

| Module | Dependents | Risk | Why |
|--------|-----------|------|-----|

## Critical Paths

Key feature chains crossing multiple modules:

| Path Name | Chain | Description |
|-----------|-------|-------------|

## Impact Quick Reference

> Use this table when investigating PBIs or planning changes.

| If you change... | Direct impact | Transitive impact | Blast radius |
|-----------------|--------------|-------------------|--------------|
| [module] | [direct dependents] | [transitive] | 🔴/🟡/🟢 |
```

**Rules for generation:**
- Generate the Mermaid diagram from `dependencyEdges` in the JSON map
- `riskLevel: high` → 🔴, `medium` → 🟡, `low` → 🟢
- Keep the file ≤ 8 KB — if too large, truncate `keyCallSites` and `externalDeps` details

## Phase 4: GEN copilot-instructions.md

Create `.github/copilot-instructions.md` (≤ 4 KB):
- Project name, purpose, architecture overview
- Build/test/lint commands (extracted from build configs)
- Core coding standards (from analyzed conventions)
- Key patterns to follow and anti-patterns to avoid
- Domain overview with glossary (for Standard/Enterprise)
- Module map with cross-references (for Enterprise)

## Phase 5: GEN Domain-Scoped Instructions

**Trigger conditions** (generate if ANY are true):
- Enterprise classification (5+ domains)
- Multi-module project (3+ modules with distinct module groups)
- Framework/Library project with module groups (e.g., core, web, data, messaging)

**Skip if**: Small project with ≤ 1 module and ≤ 1 domain.

Use `domain-registry` skill to:
1. Auto-scan source code → detect domains or module groups
2. Generate `.github/domains/domain-registry.json`
3. Generate per-domain `.instructions.md` with narrow `applyTo` patterns
4. Each ≤ 4 KB with domain rules, entities, patterns, glossary

**For framework/library projects**, generate per-module-group instructions:

| Module Group | Instruction File | applyTo Example |
|---|---|---|
| Core modules | `core-domain.instructions.md` | `**/spring-core/**/*.java,**/spring-beans/**/*.java` |
| Web modules | `web-domain.instructions.md` | `**/spring-web*/**/*.java` |
| Data modules | `data-domain.instructions.md` | `**/spring-jdbc/**/*.java,**/spring-orm/**/*.java` |

**For application projects**, generate per-business-domain instructions (existing behavior).

## Phase 6: GEN Language/Framework Instructions

Generate `.github/instructions/*.instructions.md` with correct `applyTo` globs:

| Detected Stack | Instruction Files to Generate |
|---|---|
| Java/Jakarta EE/Spring | `java.instructions.md`, `jakartaee.instructions.md` or `spring.instructions.md` |
| .NET/C# | `dotnet.instructions.md` |
| Python/Django/FastAPI | `python.instructions.md` |
| PHP/Laravel/Symfony | `php.instructions.md` |
| TypeScript/React | `typescript.instructions.md`, `react.instructions.md` |
| Android/Kotlin | `kotlin.instructions.md`, `android.instructions.md` |
| iOS/Swift | `swift.instructions.md`, `ios.instructions.md` |
| Maven/Gradle | `maven.instructions.md` or `gradle.instructions.md` |
| SQL / DB detected | `oracle-sql.instructions.md` or `database-migration.instructions.md` |
| Test framework detected | `testing.instructions.md` |
| WireMock detected | `wiremock.instructions.md` |

**Each file MUST**: reference conventions discovered in Phase 1, not generic placeholder text.

## Phase 6b: GEN Standardized Templates

Generate `.github/templates/` with output format templates for spec generation agents.

**Always generate these templates:**

| Template | Purpose | Used By |
|---|---|---|
| `PRD-template.md` | Product Requirements Document structure | `@business-analyst`, `@spec-reviewer` |
| `API-contract-template.md` | OpenAPI/Swagger API contract format | `@business-analyst`, `@implementor` |
| `DB-schema-template.md` | DBML database schema format | `@database-specialist`, `@business-analyst` |

**Rules:**
- Templates are **output format guides**, not instruction files — they don't have `applyTo` patterns
- Templates MUST be customized with project-specific examples (actual entity names, actual enum values) from Phase 3
- `@business-analyst` and `@spec-reviewer` agents MUST reference these templates in their output instructions
- Templates should be ≤ 8 KB each

## Phase 7: GEN Agents

> **⚠️ ANTI-COPY RULE**: DELETE all existing `.github/agents/*.agent.md` files first. Then create NEW agent files with content specific to THIS project's tech stack, patterns, and conventions from Phases 1-3. Do NOT copy or reuse content from the bootstrap toolkit templates.

Use the `generate-agents` prompt as a guide for agent file format and detection logic.

**Agent frontmatter format:**
```yaml
---
name: agent-name
description: "What the agent does, including project-specific tech stack keywords"
agents: ["Sub Agent 1", "Sub Agent 2"]  # only for orchestrator agents that delegate
---
```

> **⚠️ Do NOT include `tools:` or `mode:` fields in generated agent frontmatter.** These are not needed in generated output. Only `name`, `description`, and `agents` (for orchestrators) are valid fields.

Create `.github/agents/*.agent.md` (≤ 10 KB each). Each agent MUST:
- Reference the **actual tech stack** detected in Phase 1 (e.g., "Java 11, Jakarta EE 8, Maven" not "Java")
- Include **actual coding patterns** from Phase 1 (e.g., real package names, real class naming patterns)
- Include **actual business domain context** from Phase 3 (e.g., domain glossary terms, entity names)

**Always generate these core agents:**
- `dev-orchestrator` — single entry point with `agents:` field listing ALL generated agents
- `implementor` — stack-specific, referencing actual framework patterns
- `test-specialist` — using project's actual test framework and patterns
- `code-reviewer` — with project-specific review checklist

**Conditionally generate based on Phase 1 detection:**

| Detection | Agent | Must Include |
|---|---|---|
| Complex domains (5+ entities) | `investigator` | Actual domain entities and relationships |
| Complex domains (5+ entities) | `business-analyst` | Actual domain entities, personas, workflows |
| Spec/requirements workflow | `spec-reviewer` | Domain-specific NFR checks, template references |
| Multi-layer architecture | `sequence-diagrammer` | Actual layer structure |
| Entities with status/lifecycle | `sequence-diagrammer` + state diagrams | Status enums, transition logic |
| Database / migrations | `database-specialist` | Actual DB type and migration tool |
| WireMock / external APIs | `mock-data-specialist` | Actual API endpoints to mock |
| 10+ modules / Enterprise | `dependency-analyzer` | Actual module list and dependencies |
| Mobile platform | `mobile-implementor` | Platform-specific patterns |
| Mobile platform | `mobile-reviewer` | Mobile-specific review: memory leaks, UI thread, Compose recomposition, actor isolation, accessibility |
| Any project with code review | `functional-reviewer` | AC traceability, cross-domain data integrity, adversarial edge cases |
| Any project with code review | `technical-reviewer` | Migration safety, domain boundary guardian, NFR compliance |

**Dev Orchestrator wiring (CRITICAL):** The `dev-orchestrator.agent.md` `agents:` field MUST list ALL other generated agent names.

## Phase 8: GEN Skills

> **⚠️ ANTI-COPY RULE**: DELETE all existing `.github/skills/*/SKILL.md` directories first. Then create NEW skill directories with content specific to THIS project. Do NOT copy bootstrap toolkit skills.

Use the `generate-skills` prompt as a guide for skill file format and detection logic.

Create `.github/skills/[name]/SKILL.md` (≤ 15 KB each). Each skill MUST:
- Have `name:` in frontmatter that **exactly matches the parent directory name** (GitHub Copilot rejects mismatches). E.g., directory `implement-feature/` → `name: implement-feature`
- Reference **actual build commands** (e.g., `mvn clean verify -pl module-name` not `build`)
- Reference **actual test commands** (e.g., `mvn test -Dtest=OrderServiceTest` not `run tests`)
- Reference **actual project directory structure** (e.g., `src/main/java/com/company/...`)
- Reference **actual framework patterns** (e.g., "Entity → DAO → Service → Resource" for Jakarta EE)

### Skill Frontmatter Schema (complete)

```yaml
---
name: skill-name          # MUST match parent directory name exactly
description: '...'        # 10-1024 chars — what it does and when to use
hint: '[PBI] [module]'    # shown in chat input when user types /skill-name — guides what to type next
hidden: false             # true = hidden from / menu but still auto-loaded; default false
---
```

**`hint` usage guidance** — add `hint` to all generated skills:

| Skill | Recommended `hint` value |
|-------|--------------------------|
| `implement-feature` | `[feature description or PBI ID] [module name]` |
| `investigate-pbi` | `[PBI ID or description]` |
| `generate-unit-tests` | `[class name or file path]` |
| `review-code-changes` | `[branch name or file list]` |
| `generate-sequence-diagram` | `[flow name] [entry-point class]` |
| `sprint-planning` | `[sprint number] [PBI list]` |
| `impact-analysis` | `[class or field being changed]` |

**`hidden` usage** — set `hidden: true` for internal/utility skills that should not appear in the slash-command menu but can still be invoked by agents:
- Skills that are only called by other agents (e.g., `domain-registry`, `context-budget-check`)
- Skills used internally by the bootstrap pipeline

**Auto-select based on detected capabilities:**

| Detection | Skills to Generate |
|---|---|
| Any project | `implement-feature`, `generate-unit-tests`, `review-code-changes` |
| CI/CD pipeline exists | `generate-pr-description`, `conventional-commit` |
| 3+ modules | `orchestrate-development`, `investigate-pbi`, `estimate-effort` |
| Sprint/agile references | `sprint-planning` |
| Complex domain (5+ entities) | `generate-sequence-diagram`, `generate-state-diagram` |
| Entities with status/lifecycle enums | `generate-state-diagram` |
| Spec/requirements workflow | `review-spec`, `update-spec` |
| WireMock / mock dependencies | `generate-wiremock` |
| Enterprise classification | `impact-analysis` |
| Tech debt indicators | `technical-debt-analysis` |

### Mandatory Agentic Patterns in Generated Skills

Every generated `implement-feature` and `orchestrate-development` skill MUST include:

1. **Verify-Fix Loop**: Build → Test → Lint cycle with max 3 retries per step, using the project's actual commands
2. **Incremental Implementation**: For features touching 5+ files, verify each layer group before proceeding
3. **Self-Review Checklist**: Re-read all changes, check pattern consistency, verify cross-file integrity
4. **Stack-specific verify commands table**: Actual build/test/lint commands detected from the project

### Stack-Specific Skill Customization (CRITICAL)

Skills MUST contain stack-specific content. The same skill name produces DIFFERENT content depending on the detected tech stack.

**`implement-feature` — Implementation order per stack:**

| Stack | Implementation Order in Skill |
|---|---|
| Java / Jakarta EE | DB Migration → `@Entity` + JPA annotations → DAO (`@Stateless`) → Service (`@Inject`) → `@Path` Resource → CDI event |
| Java / Spring Boot | Migration → Entity → DTO + MapStruct → Repository → Service (`@Transactional`) → Controller → Config |
| .NET / ASP.NET Core | Entity + EF Config → Migration → DTO → FluentValidation → Repository → Service/MediatR Handler → Controller → DI registration |
| Python / Django | Model → Migration → Serializer → Service/Selector → View/ViewSet → URL config → Admin registration |
| Python / FastAPI | SQLAlchemy Model → Alembic Migration → Pydantic Schema → Repository → Service → Dependencies → Router |
| TypeScript / React | Types/Interfaces → API service → Custom Hook → Component → Storybook → Page route |
| TypeScript / Next.js | Types → Server Action or Route Handler → Data fetching → Component → Page → Layout |
| PHP / Laravel | Model + fillable/casts → Migration → FormRequest → API Resource → Service → Controller → Route |
| PHP / Symfony | Entity + ORM mapping → Migration → DTO → Validator → Repository → Service → Controller → Route annotation |
| Android / Kotlin | Room Entity + DAO → Repository → UseCase → ViewModel → Compose UI → Navigation → Hilt module |
| iOS / Swift | SwiftData Model → Repository → Service → ViewModel (`@Observable`) → SwiftUI View → Navigation |
| Kotlin Multiplatform | Shared: expect/actual → Repository → UseCase → Android ViewModel + iOS ObservableObject |

**`generate-unit-tests` — Test framework per stack:**

| Stack | Test Config in Skill |
|---|---|
| Java | JUnit 5 + `@Nested` + `@DisplayName` + AssertJ + Mockito (`@ExtendWith`) + `@ParameterizedTest` |
| .NET | xUnit + `[Fact]`/`[Theory]` + FluentAssertions + Moq + nested classes |
| Python | pytest + `@pytest.fixture` + `factory_boy` + `pytest-asyncio` + parametrize |
| TypeScript / React | Vitest or Jest + React Testing Library + `render()`/`screen`/`userEvent` + MSW for API mocks |
| PHP | PHPUnit or Pest + Model Factories + `RefreshDatabase` + mock facades |
| Android / Kotlin | JUnit 5 + Turbine (Flow testing) + MockK + Hilt test + Compose testing (`createComposeRule`) |
| iOS / Swift | XCTest + Swift Testing (`@Test`) + async/await testing + ViewInspector for SwiftUI |

**`review-code-changes` — Review focus per stack:**

| Stack | Review Focus Areas in Skill |
|---|---|
| Java / Jakarta EE | CDI scope correctness, JPA lazy/eager loading, transaction boundaries, JNDI naming |
| .NET | EF query performance (N+1), DI lifetime (Scoped/Transient/Singleton), async/await patterns |
| Python | Type hint completeness, async context managers, SQLAlchemy session handling, Pydantic validation |
| TypeScript / React | Hook dependency arrays, re-render optimization, proper error boundaries, accessibility |
| PHP | Eloquent N+1 (eager loading), mass assignment guards, middleware ordering |
| Android / Kotlin | Compose recomposition, coroutine scope lifecycle, state hoisting, memory leaks |
| iOS / Swift | Actor isolation, Sendable conformance, memory ownership (@Observable vs @State), accessibility |

## Phase 9: GEN Prompts

> **⚠️ ANTI-COPY RULE**: DELETE all existing `.github/prompts/*.prompt.md` files first. Create NEW prompts for this project.

Create `.github/prompts/*.prompt.md` (≤ 3 KB each):
- Always: `implement-feature` (entry point to dev-orchestrator)
- If complex codebase: `learn-codebase` (entry point to understand this project)
- Each prompt is an entry point only — delegates to agents + skills for real work

### Prompt Frontmatter Schema

```yaml
---
name: prompt-display-name      # shown after / in chat (defaults to filename)
description: One-line summary  # for discoverability
agent: agent                   # mode: ask | edit | agent | <custom-agent-name>
model: gpt-4o                  # optional — defaults to selected model
tools: ['codebase', 'github']  # optional — specific tools this prompt requires
---
```

### Interactive Variables with `${input:variableName}`

Use `${input:variableName}` to create prompts that ask the user for input before running. When the user invokes the prompt, Copilot displays an input field for each variable.

```markdown
---
name: implement-feature
description: 'Implement a feature end-to-end: investigate → implement → test'
agent: agent
---

Implement the following feature in @dev-orchestrator:

**Requirement**: ${input:requirement}
**Module** (leave blank for auto-detect): ${input:module}
**Acceptance criteria** (optional): ${input:acceptanceCriteria}
```

**Rules for generated prompts:**
- Use `${input:variableName}` for required user context that cannot be inferred from the codebase (PBI ID, feature description, module name)
- Keep variable names concise and self-explanatory — users see the variable name as the input label
- Provide inline hints using comments or parenthetical notes: `${input:module} (e.g. orders, payments)`
- **Do NOT** use `{variableName}` (curly only, no dollar) — that is not valid Copilot prompt syntax

## Phase 10: GEN Hooks

Create `.github/hooks/*.json` based on detected project tooling:

> **Supported hook events** (GitHub Copilot official): `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `errorOccurred`. There is no `agentStop` — use `postToolUse` with tool-name filtering for quality checks.

| Detection | Hook File | Event | Purpose |
|---|---|---|---|
| Formatter (Prettier/Spotless/Black/ktlint) | `auto-format.json` | `postToolUse` | Auto-format after file edit |
| Linter (ESLint/Checkstyle/PMD/detekt) | `lint-check.json` | `postToolUse` | Lint after file-editing tools (filtered by toolName) |
| Build tool (Maven/Gradle/tsc/dotnet) | `compile-check.json` | `postToolUse` | Verify compilation after file-editing tools |
| Enterprise/security patterns | `security-gate.json` | `preToolUse` | Block dangerous commands |

Hook format:
```json
{
  "version": 1,
  "hooks": {
    "<event>": [{
      "type": "command",
      "bash": "<unix command>",
      "powershell": "<windows command>",
      "cwd": ".",
      "timeoutSec": 30
    }]
  }
}
```

Rules: Both `bash` and `powershell` for cross-platform. `postToolUse` hooks < 30s. Non-zero exit blocks action.

## Phase 11: GEN Agentic Workflows

**Trigger**: `.github/workflows/` directory exists (GitHub Actions available).

If triggered, generate `.github/copilot/` workflow files:
- Issue triage workflow (label bugs, assign priority, suggest affected modules)
- Dependency audit workflow (weekly check for outdated/vulnerable deps)

**Skip** if no CI/CD directory is detected.

## Phase 12: VALIDATE — 3-Tier Validation

### Tier 1: Structural Validation
- [ ] All `.agent.md` have valid YAML frontmatter (`name`, `description`; `agents:` list for orchestrators only; NO `mode:` field — `tools:` IS valid)
- [ ] All `SKILL.md` have `name` and `description` (10-1024 chars)
- [ ] **Skill `name` matches parent directory** — e.g., `skills/implement-feature/SKILL.md` must have `name: implement-feature`. GitHub Copilot rejects skills where name ≠ directory. Check every generated skill.
- [ ] All `.instructions.md` have `description` and `applyTo` globs
- [ ] All `.prompt.md` have valid frontmatter
- [ ] No files with empty or placeholder content

### Tier 1b: Dependency Map Validation (Standard/Enterprise only)
- [ ] `.github/module-dependency-map.json` exists and is valid JSON
- [ ] Every module listed in Phase 1 SCAN appears in `modules[]`
- [ ] `dependents` arrays are consistent with `dependencies` (if A depends on B, then B's `dependents` includes A)
- [ ] No module references a non-existent module ID in `dependencies` or `dependents`
- [ ] `.github/MODULE-ARCHITECTURE.md` exists and contains a Mermaid diagram
- [ ] Mermaid diagram node count matches `graphMetadata.totalModules`

### Tier 2: Functional Validation
- [ ] Each agent `description` mentions the actual tech stack detected in Phase 1
- [ ] Each instruction `applyTo` pattern matches ≥ 1 real file in the project
- [ ] `dev-orchestrator.agent.md` `agents:` field lists ALL generated agent names
- [ ] Each skill is referenced by at least one agent or prompt
- [ ] No agent references a sub-agent that wasn't generated
- [ ] Hooks reference commands that exist in the project (e.g., `mvn` if maven hook)
- [ ] No two instruction files have overlapping `applyTo` patterns covering the same rules

### Tier 3: Context Budget Validation
- [ ] `copilot-instructions.md` ≤ 4 KB
- [ ] Each `.instructions.md` ≤ 6 KB
- [ ] Each `.agent.md` ≤ 10 KB
- [ ] Each `.prompt.md` ≤ 3 KB
- [ ] Simulate worst-case co-loading: instructions + agent + skill ≤ 45 KB

**If any check fails**: fix immediately before proceeding. Report which checks failed and how they were resolved.

## Phase 13: DevContainer Setup

Runs BEFORE cleanup so bootstrap agents (`@devcontainer-reviewer`) are still available.

**If `.devcontainer/` exists**: Delegate to `@devcontainer-reviewer` to optimize.

**If no `.devcontainer/`**: Ask user if they want one generated. If yes:
1. Requirements interview (databases, services, tools, shell, extensions)
2. Resource estimation (RAM/CPU/disk)
3. Wait for user confirmation
4. Generate: `devcontainer.json`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`

**If user declines**: Skip, report "DevContainer: skipped"

## Phase 14: Manifest, Cleanup & Final Report

> **This phase is CRITICAL.** First, generate the bootstrap manifest to record what was generated and by which toolkit version. Then delete all bootstrap template files. Only project-specific generated files remain.

### Step 0a: Generate `.github/.bootstrap-state.json` (Pipeline State Tracker)

Write this file at the **START of Phase 1** and **update it after each phase completes**. This enables the `resume-bootstrap` skill to resume from any interrupted phase.

```json
{
  "toolkitVersion": "<version from VERSION file>",
  "startedAt": "<ISO 8601 UTC timestamp>",
  "lastUpdatedAt": "<ISO 8601 UTC timestamp>",
  "classification": "<Small | Standard | Enterprise | null>",
  "contextRisk": "<low | medium | high | null>",
  "phases": {
    "1":  { "status": "completed | in_progress | pending | skipped", "completedAt": "<timestamp>", "summary": "<1-line result>" },
    "2":  { "status": "...", "completedAt": "...", "summary": "<classification result>" },
    "3":  { "status": "...", "completedAt": "...", "summary": "<N domains extracted, checkpoint written>" },
    "4":  { "status": "...", "completedAt": "...", "summary": "<copilot-instructions.md written, N KB>" },
    "5":  { "status": "...", "completedAt": "...", "summary": "<N domain instruction files | skipped: reason>" },
    "6":  { "status": "...", "completedAt": "...", "summary": "<N instruction files written>" },
    "6b": { "status": "...", "completedAt": "...", "summary": "<N templates written>" },
    "7":  { "status": "...", "completedAt": "...", "summary": "<N agents written>" },
    "8":  { "status": "...", "completedAt": "...", "summary": "<N skills written>" },
    "9":  { "status": "...", "completedAt": "...", "summary": "<N prompts written>" },
    "10": { "status": "...", "completedAt": "...", "summary": "<N hooks written | skipped>" },
    "11": { "status": "...", "completedAt": "...", "summary": "<N workflows written | skipped: no CI/CD>" },
    "12": { "status": "...", "completedAt": "...", "summary": "<validation passed | N issues fixed>" },
    "13": { "status": "...", "completedAt": "...", "summary": "<devcontainer generated | optimized | skipped>" },
    "14": { "status": "...", "completedAt": "...", "summary": "<manifest written, N files cleaned up>" }
  },
  "generatedFiles": ["<list of .github/ files generated so far — append after each phase>"],
  "errors": ["<any errors encountered — helps diagnose resume>"]
}
```

**Rules:**
- Create this file before Phase 1 starts, with all phases set to `"pending"`
- Update `status` → `"in_progress"` when a phase begins
- Update `status` → `"completed"` + `completedAt` + `summary` immediately after each phase
- For skipped phases: set `status` → `"skipped"` + `summary` → reason
- Append newly generated file paths to `generatedFiles` after each generation phase
- If pipeline is interrupted, the last `in_progress` phase is the resume point

### Step 0b: Generate `.bootstrap-manifest.json`

**MUST run BEFORE cleanup** — this step collects all generated file paths while they still exist.

Read the toolkit version from the `VERSION` file at the repository root of the **bootstrap toolkit** (not the target project). Generate `.github/.bootstrap-manifest.json` in the **target project**:

```json
{
  "$schema": "https://copilot-bootstrap.dev/manifest.schema.json",
  "generatedBy": "copilot-bootstrap",
  "toolkitVersion": "<version from VERSION file>",
  "generatedAt": "<ISO 8601 UTC timestamp>",
  "classification": "<Small | Standard | Enterprise>",
  "domainsDetected": <number>,
  "techStack": {
    "languages": ["<lang> <version>"],
    "frameworks": ["<framework> <version>"],
    "buildTools": ["<tool> <version>"],
    "databases": ["<db> <version>"],
    "testFrameworks": ["<framework> <version>"]
  },
  "generatedFiles": {
    "copilotInstructions": ".github/copilot-instructions.md",
    "agents": [".github/agents/<name>.agent.md"],
    "skills": [".github/skills/<name>/SKILL.md"],
    "instructions": [".github/instructions/<name>.instructions.md"],
    "prompts": [".github/prompts/<name>.prompt.md"],
    "hooks": [".github/hooks/<name>.json"],
    "templates": [".github/templates/<name>.md"],
    "domains": [".github/domains/domain-registry.json", ".github/domains/<name>.instructions.md"],
    "devcontainer": [".devcontainer/devcontainer.json"],
    "dependencyMap": ".github/module-dependency-map.json",
    "moduleArchitecture": ".github/MODULE-ARCHITECTURE.md"
  },
  "contextBudget": {
    "worstCaseKB": <number>,
    "maxKB": 45,
    "passed": <boolean>
  },
  "pipelineConfig": {
    "phasesExecuted": [1, 2, 3, 4, 6, 7, 8, 9, 10, 12, 14],
    "phasesSkipped": {
      "5": "Not Enterprise classification",
      "11": "No CI/CD detected",
      "13": "User declined"
    }
  }
}
```

**Rules:**
- `generatedFiles` lists ONLY files actually generated (not skipped phases)
- `techStack` values come from Phase 1 scan results
- `pipelineConfig.phasesSkipped` records WHY each phase was skipped — this helps future migration agents
- The manifest itself is NOT listed in `generatedFiles` (it's meta)
- File MUST be valid JSON — validate before writing

### Step 1: Delete ALL Bootstrap Toolkit Template Files

**Delete these bootstrap template agents** (ALL of them — they are toolkit templates, NOT project agents):
```
.github/agents/agent-generator.agent.md
.github/agents/codebase-analyzer.agent.md
.github/agents/conductor.agent.md
.github/agents/devcontainer-reviewer.agent.md
.github/agents/dotnet-implementor.agent.md
.github/agents/frontend-implementor.agent.md
.github/agents/mobile-architect.agent.md
.github/agents/mobile-implementor.agent.md
.github/agents/mobile-test-specialist.agent.md
.github/agents/mock-data-specialist.agent.md
.github/agents/php-implementor.agent.md
.github/agents/pr-manager.agent.md
.github/agents/python-implementor.agent.md
.github/agents/refactoring-specialist.agent.md
.github/agents/sequence-diagrammer.agent.md
.github/agents/sprint-planner.agent.md
.github/agents/dependency-analyzer.agent.md
.github/agents/database-specialist.agent.md
.github/agents/spec-reviewer.agent.md
.github/agents/functional-reviewer.agent.md
.github/agents/technical-reviewer.agent.md
.github/agents/mobile-reviewer.agent.md
```

**Delete these bootstrap template skills** (ALL skill directories):
```
.github/skills/analyze-codebase/
.github/skills/context-budget-check/
.github/skills/conventional-commit/
.github/skills/core-principles/
.github/skills/domain-registry/
.github/skills/estimate-effort/
.github/skills/generate-adr/
.github/skills/generate-agentic-workflow/
.github/skills/generate-copilot-config/
.github/skills/generate-domain-instructions/
.github/skills/generate-hooks/
.github/skills/generate-mobile-tests/
.github/skills/generate-pr-description/
.github/skills/generate-sequence-diagram/
.github/skills/generate-unit-tests/
.github/skills/generate-wiremock/
.github/skills/impact-analysis/
.github/skills/implement-feature/
.github/skills/implement-mobile-feature/
.github/skills/investigate-pbi/
.github/skills/learn-codebase/
.github/skills/optimize-devcontainer/
.github/skills/orchestrate-development/
.github/skills/review-code-changes/
.github/skills/sprint-planning/
.github/skills/technical-debt-analysis/
.github/skills/generate-state-diagram/
.github/skills/review-spec/
.github/skills/update-spec/
.github/skills/resume-bootstrap/
.github/skills/upgrade-config/
.github/skills/validate-bootstrap-output/
```

**Delete these bootstrap template instructions** (ALL of them):
```
.github/instructions/*.instructions.md  (all 23 files)
```

**Delete these bootstrap template templates** (ALL of them):
```
.github/templates/PRD-template.md
.github/templates/API-contract-template.md
.github/templates/DB-schema-template.md
```

**Delete these bootstrap template prompts** (ALL of them):
```
.github/prompts/bootstrap-copilot.prompt.md
.github/prompts/generate-agents.prompt.md
.github/prompts/generate-skills.prompt.md
.github/prompts/generate-instructions.prompt.md
.github/prompts/analyze-project.prompt.md
.github/prompts/implement-feature.prompt.md
.github/prompts/learn-codebase.prompt.md
```

**Delete the bootstrap copilot-instructions.md** (replaced by project-specific version in Phase 4):
```
.github/copilot-instructions.md  (the template version)
```

**Delete bootstrap documentation:**
```
docs/enterprise-guide.md
docs/context-budget-guide.md
```

Also add `dependency-extractor` to the bootstrap template skills delete list:
```
.github/skills/dependency-extractor/
```

### Step 2: Verify Only Project-Specific Files Remain

After cleanup, `.github/` should contain ONLY files generated in Phases 4-14:
- `.bootstrap-manifest.json` — generated in Phase 14 Step 0
- `.bootstrap-state.json` — generated in Phase 14 Step 0a
- `.phase3-checkpoint.md` — generated in Phase 3
- `module-dependency-map.json` — generated in Phase 3b (**do NOT delete**)
- `MODULE-ARCHITECTURE.md` — generated in Phase 3b (**do NOT delete**)
- `copilot-instructions.md` — generated in Phase 4, project-specific
- `agents/` — generated in Phase 7, project-specific
- `skills/` — generated in Phase 8, project-specific
- `instructions/` — generated in Phase 6, project-specific
- `prompts/` — generated in Phase 9, project-specific
- `hooks/` — generated in Phase 10, project-specific
- `domains/` — generated in Phase 5, Enterprise only

**Verification**: List all remaining files. If ANY file contains generic/template content (not referencing this project's actual tech stack, entities, or patterns), it was not properly generated — delete and regenerate.

### Step 3: Final Report

```
✅ Bootstrap Complete!
📁 .github/
├── .bootstrap-manifest.json  ← toolkit version + generated file inventory
├── copilot-instructions.md   ← [project name] index card
├── agents/ ([count] project-specific agents)
├── skills/ ([count] project-specific skills)
├── instructions/ ([count] instruction files)
├── prompts/ ([count] prompts)
└── hooks/ ([count] hooks)

🐳 .devcontainer/ (if generated)

Toolkit version: [version from VERSION file]
Classification: [Small/Standard/Enterprise]
Domains detected: [count]
Context budget: [worst-case KB] / 45 KB max
Validation: [passed/N issues fixed]
Manifest: .github/.bootstrap-manifest.json ✅

🧹 Cleanup:
- Deleted [N] bootstrap template agents
- Deleted [N] bootstrap template skills
- Deleted [N] bootstrap template instructions
- Deleted [N] bootstrap template prompts
- Deleted bootstrap copilot-instructions.md + docs/
- Remaining: [N] project-specific generated files
```
