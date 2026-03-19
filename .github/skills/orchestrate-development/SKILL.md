---
name: orchestrate-development
description: 'Full lifecycle development orchestration skill for agile teams. Receives a requirement or PBI then executes the complete workflow: investigate as-is/to-be, estimate effort, confirm analysis with user, multi-stack implementation (Java/.NET/Python/PHP), unit tests with 100% branch coverage, PR description, conventional commits, and markdown documentation. Supports sprint-aware estimation and architectural decision-making. Use when asked to implement a feature end-to-end, take a PBI from analysis to completion, or do full-stack implementation with tests and docs.'
---

# Orchestrate Development

Full lifecycle development workflow from requirement to delivery, supporting multiple tech stacks.

## When to Use

- User provides a PBI, user story, or requirement and wants end-to-end implementation
- User asks to "implement and test" or "take this from start to finish"
- User wants investigation + implementation + tests + PR + documentation in one flow
- Keywords: "implement end-to-end", "full implementation", "analyze and implement", "requirement to delivery"

## Tech Stack Detection

Automatically detect and adapt to the project's tech stack:
- `pom.xml` / `build.gradle` → Java/Jakarta EE/Spring Boot
- `*.csproj` / `*.sln` → .NET/C#/ASP.NET Core
- `pyproject.toml` / `manage.py` → Python/Django/FastAPI
- `composer.json` / `artisan` → PHP/Laravel/Symfony
- `package.json` + React/Vue/Angular, `*.ts`, `*.tsx` → TypeScript/React/Frontend
- `build.gradle.kts` + Android → Android/Kotlin
- `Package.swift` / `*.xcodeproj` → iOS/Swift

## Workflow

### Step 1: Parse Requirement & Detect Mode
- Extract what, why, scope, constraints, acceptance criteria
- Detect tech stack from project files
- Ask clarifying questions if ambiguous
- **Detect implementation mode**:
  - **Standard** (default): Investigate → Implement → Test → Verify → Review
  - **TDD**: If user says "TDD" or "test first" → Write failing tests → Implement to pass → Refactor → Verify
  - **Bug Fix**: If user provides error/stack trace → Reproduce → Locate → Fix → Verify → Regression check

### Step 2: Investigate
- **Trace current code flow (as-is)** — follow the full call chain, understand what each layer handles
- **Identify layer responsibilities** — document which layer handles which validation to prevent duplication
- **Confirm business logic alignment** — verify proposed changes match existing business rules
- Design proposed solution (to-be) with change table: Component | Change Type | File | Business Reason
- Map all scenarios (happy path, errors, edge cases, concurrency)
- Assess impact on existing code and database — produce impact matrix: Area | Impact Level (🔴🟡🟢) | Details
- In multi-module projects, map module boundaries and responsibilities
- Identify risks with mitigation plans
- **Generate sequence diagrams** — MUST produce both:
  - **As-Is diagram** — current flow traced from actual code
  - **To-Be diagram** — proposed flow with change markers: 🆕 New (green box), ✏️ Modified (yellow box), ❌ Removed (red box)
- **Estimate effort** — story points with task breakdown by layer

### Step 3: Confirm with User ⏸️
- Present structured investigation summary with effort estimate
- List all files to create and modify
- Show scenarios, risks, and architecture decisions
- **Wait for explicit user confirmation before proceeding**

### Step 4: Implement (Stack-Adaptive)

**Code Reasoning Rule**: For every file created or modified, explain the business reasoning BEFORE writing code:
- "Adding `XxxService` because [business rule] needs a dedicated service"
- "Using [pattern] because the codebase uses this approach (see `ExistingClass:L45`)"
- "Not adding validation here — already handled by `@Valid` in `XxxController`"

**Java/Jakarta EE**: Migration → Entity → DTO → Mapper → Repository → Service → Resource
**Java/Spring Boot**: Migration → Entity → DTO → Mapper → Repository → Service → Controller
**.NET/C#**: Entity + EF Config → Migration → DTO → Validator → Repository → Service/Handler → Controller → DI
**Python (FastAPI)**: SQLAlchemy Model → Alembic Migration → Pydantic Schema → Repository → Service → Dependencies → Router
**Python (Django)**: Model → Migration → Serializer → Service/Selector → View/ViewSet → URL
**PHP (Laravel)**: Model → Migration → FormRequest → API Resource → Service → Controller → Route
**PHP (Symfony)**: Entity → Migration → DTO → Repository → Service → Controller → Validator
**TypeScript (React/Next.js)**: Types/Interfaces → API Service → Custom Hook → Component → Tests → Page Route
**TypeScript (Node/Express)**: Types → Prisma/Drizzle Schema → Repository → Service → Controller → Route → Middleware

Universal rules:
- Follow existing codebase patterns exactly
- No duplicate validation across layers
- Add proper documentation
- Respect module boundaries

#### Incremental Implementation (for features touching 5+ files)

Break work into verifiable chunks — each chunk MUST pass build+test before proceeding:

1. **Data layer**: DB migration + entity/model → BUILD → verify schema
2. **Business layer**: Repository + service → BUILD + unit tests → RUN tests
3. **API layer**: Controller/resource + integration → BUILD + API tests → RUN tests
4. **Final**: Full test suite → lint → PR

Do NOT write all files then test at the end — verify incrementally.

### Step 5: Write Unit Tests
- Analyze ALL branches in implemented code
- Create test builders/factories for entities/DTOs
- Use the stack's preferred testing framework:
  - Java: JUnit 5 + AssertJ + @Nested/@DisplayName
  - .NET: xUnit + FluentAssertions + nested classes
  - Python: pytest + pytest-asyncio + factory_boy
  - PHP: PHPUnit/Pest + Model Factories
- Use real objects wherever possible, minimize mocks
- Target 100% branch coverage
- Ensure all tests execute fast (<100ms each)

### Step 5.5: Verify-Fix & Self-Review (MANDATORY)

**After writing code + tests, MUST execute:**

1. **Build**: Run build command → if fails, read error, fix, rebuild (max 3 retries)
2. **Test**: Run test suite → if fails, analyze output, fix code or test, re-run (max 3 retries)
3. **Lint**: Run linter → if fails, fix violations, re-run
4. **Self-Review**: Re-read ALL files created/modified and check:
   - Does each file follow existing codebase patterns?
   - Is there duplicate validation across layers?
   - Are all acceptance criteria covered?
   - Do test names reflect business scenarios (not method names)?
   - Is every new field in Entity reflected in DTO, mapper, and tests?

If any issue found → fix BEFORE presenting to user.
If still failing after 3 retries → STOP, report status with error output, ask user.

### Step 6: Generate PR Description & Commits
- Generate conventional commit messages for each logical change
- Generate structured PR description with:
  - Summary, changes, testing notes, impact analysis, review checklist

### Step 7: Final Report — Mandatory Output

ALWAYS produce this structured markdown report:

```markdown
## Summary of Changes

### What Was Done
| # | Action | File | Business Reason |
|---|--------|------|----------------|
| 1 | Created | [path] | [why this was needed] |

### Business Rules Implemented
- ✅ [Rule — enforced at which layer]

### Sequence Diagram (Updated)
[To-Be Mermaid diagram with 🆕✏️❌ markers and colored boxes]

### Design Decisions
| Decision | Alternatives | Rationale |
|----------|-------------|----------|
| [choice] | [options] | [why] |

### What Was NOT Done (and why)
- [item] — [reason]

### Quick Verify
[build/test command]
```

### Step 8: Estimation Accuracy
- Report all deliverables (code files, test files, docs, migrations, PR description)
- Compare estimated vs actual effort
- Provide stack-appropriate verification command

## Validation
- All production code compiles / passes static analysis
- All unit tests pass
- Branch coverage meets 100% target
- Documentation is complete and accurate
- Existing tests still pass
- **Existing code flow was traced before implementation**
- **No duplicate validation across layers** (Controller/Service/Repository)
- **No duplicate logic across modules** (multi-module projects)
- **Business logic confirmed** — changes match existing business rules
- **PR description generated and review-ready**
- **Verify-Fix loop passed** — build + test + lint all green
- **Cross-file consistency verified**:
  - [ ] Every new Entity field → has DTO field + mapper logic
  - [ ] Every new endpoint → has corresponding test
  - [ ] Every new service method → referenced in controller/resource
  - [ ] Every new validation → has negative test case
  - [ ] Method signatures consistent across interface ↔ implementation
