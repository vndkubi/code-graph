---
name: review-code-changes
description: 'Multi-stage code review pipeline: Self-Review → Functional Review (@functional-reviewer) → Technical Review (@technical-reviewer). Functional Review runs first — if business logic is wrong, reject immediately. Each finding must include actionable code snippets. Produces a combined review report with verdict. Use when reviewing PRs or branch changes via @code-reviewer.'
---

# Review Code Changes — Multi-Stage Pipeline

Structured multi-stage code review pipeline with short-circuit logic for maximum efficiency.

## When to Use

- Reviewing a pull request
- Pre-merge quality gate
- Code review as part of feature delivery pipeline
- Keywords: "review PR", "review code", "check changes", "code review"

## Pipeline Overview

```
Stage 0: CONTEXT GATHERING → Load changed files + related files (import graph, callers)
    ↓
Stage 1: SELF-REVIEW GATE → Author checklist (quick sanity check)
    ↓
Stage 2: FUNCTIONAL REVIEW → @functional-reviewer validates business logic
    ↓ If 🔴 BLOCKER found → REJECT immediately, skip Stage 3
    ↓
Stage 3: TECHNICAL REVIEW → @technical-reviewer validates architecture & quality
    ↓
COMBINED REPORT → Merge findings from both stages with verdict
```

## Stage 0: Context Gathering (Deep Context Retrieval)

**CRITICAL: Reading only the git diff is like "blind men and an elephant."** The reviewer MUST load FULL file contents and their dependencies — not just diff chunks.

### 0a. Get Changed Files

```bash
git diff [base]...[head] --name-only
```

### 0b. Categorize Changed Files

| Type | Pattern | Reviewer | Priority |
|------|---------|----------|----------|
| Business logic | `*Service*, *Validator*, *Calculator*, *StateMachine*` | Functional | 🔴 Load first |
| API/Controller | `*Resource*, *Controller*, *DTO*, *Mapper*` | Both | 🔴 Load first |
| Data access | `*Repository*, *DAO*, *Query*` | Technical | 🟡 Load second |
| Database | `*.sql, *migration*` | Technical | 🟡 Load second |
| Configuration | `*.properties, *.yml, *.yaml` | Technical | 🟢 Load if relevant |
| Tests | `*Test*, *Spec*` | Functional (coverage check) | 🔴 Load first |

### 0c. Load FULL Content of Changed Files

**Do NOT rely on diff chunks alone.** For every changed file:
1. Read the **entire file** — the diff only shows what changed, not the surrounding logic that gives it meaning
2. This ensures reviewers see: preceding validation, conditional branches, try-catch blocks, related methods in the same class

### 0d. Context Retrieval — Find Related Files Outside the PR

**This is the most important step.** For each changed class/method, use tool calls to build the dependency graph:

#### Step 1: Trace Outbound Dependencies (what this file depends on)
```
For each changed file:
  → Read import/require/using statements
  → Load the FULL content of each imported file (especially interfaces, base classes, DTOs)
  → If an imported class is also a service/repository, load it — the changed code may call it incorrectly
```

#### Step 2: Trace Inbound Dependencies (what depends on this file) — CALLERS
```
For each changed class/method:
  → grep/search the codebase for references to the class name or method name
  → Load the FULL content of each caller file
  → These callers are NOT in the PR but may BREAK due to the change
```

**Tool usage pattern:**
```
# Find all callers of a changed method
grep -rn "orderService.calculateTotal" --include="*.java" src/
grep -rn "OrderService" --include="*.java" src/main/  # find all usages of the class

# Find all implementations/subclasses
grep -rn "extends OrderService\|implements OrderProcessor" --include="*.java" src/

# Find all consumers of a changed DTO
grep -rn "OrderResponseDto" --include="*.java" src/
grep -rn "OrderResponseDto" --include="*.ts" src/  # frontend consumers too
```

#### Step 3: Trace Cross-Service Dependencies
```
For changed API endpoints (Controller/Resource):
  → Search for Feign clients, RestTemplate, WebClient, HttpClient referencing the same URL path
  → Search for OpenAPI/Swagger spec references
  → These are OTHER SERVICES that will break if the API contract changes
```

#### Step 4: Load Domain Context
```
For changed entities/models:
  → Load the entity class and all its relationships (@ManyToOne, @OneToMany, FK references)
  → Load related domain events, listeners, observers
  → Load state machine / status transition logic if entity has status field
```

### 0e. Locate Requirement Document

1. Check PR description for PBI/issue link
2. Search `docs/requirements/` for related spec
3. Check commit messages for issue references
4. If no requirement found → flag it, but continue review with best effort

### 0f. Build Context Summary

Before passing to reviewers, produce a brief context map:

```markdown
### Context Map
- **Changed files**: [N] files ([list])
- **Related files loaded**: [N] files
  - Callers: [list of files that call changed methods]
  - Dependencies: [list of files imported by changed files]
  - Cross-service: [list of Feign/HTTP clients referencing changed APIs]
- **Requirement**: [link or "not found"]
- **Estimated blast radius**: Low (1-3 files) / Medium (4-10) / High (10+)
```

> **Budget rule**: If the PR touches 50+ files, prioritize context loading for 🔴-priority file types first. Load 🟡 and 🟢 types only if context budget allows.

## Stage 1: Self-Review Gate (Quick Sanity Check)

**The implementor should verify these before PR submission. The pipeline checks automatically:**

- [ ] Code compiles without errors
- [ ] All existing tests pass
- [ ] New tests included for new logic
- [ ] No debugging code left (`console.log`, `System.out.println`, `TODO`/`FIXME` in new code)
- [ ] No unresolved merge conflicts
- [ ] No hardcoded credentials, tokens, or secrets
- [ ] Commit messages follow conventional commit format

**If any basic hygiene item fails → return immediately with clear instructions.**

## Stage 2: Functional Review

**Delegate to `@functional-reviewer` with this context:**

1. Changed files (business logic + API + tests)
2. Requirement document / acceptance criteria
3. Related files from import graph

**Functional Reviewer will:**
- Build AC ↔ Test ↔ Code traceability matrix
- Verify business logic correctness
- Run adversarial edge-case analysis
- Check cross-domain data integrity
- Verify business scenario test coverage

**Short-circuit rule:** If Functional Review returns ANY 🔴 BLOCKER:
- **STOP** — do NOT proceed to Stage 3
- **REJECT** the PR with Functional Review findings only
- Rationale: No point reviewing technical quality if the code doesn't solve the right problem

**If Functional Review returns ✅ PASS (or only 🟡/🔵 findings):**
- Proceed to Stage 3
- Carry forward 🟡/🔵 findings to combined report

## Stage 3: Technical Review

**Delegate to `@technical-reviewer` with this context:**

1. ALL changed files (including migrations, configs)
2. Related files from import graph (callers, subclasses)
3. Module/service boundary information

**Technical Reviewer will:**
- Check API backward compatibility
- Assess database migration safety
- Detect domain boundary violations (DDD)
- Verify NFR compliance (logging, tracing, error handling)
- Check layer responsibility and duplicate validation
- Review performance, security, shared component impact

**Technical Review runs in full — no short-circuit.**

## Combined Report Format

```markdown
# Code Review Report

## Summary
- **PR/Branch**: [reference]
- **Author**: [name]
- **PBI/Issue**: [reference]
- **Files Changed**: [count]
- **Risk Level**: 🔴 High / 🟡 Medium / 🟢 Low

## Verdict: ✅ APPROVE / ⚠️ APPROVE WITH COMMENTS / ❌ REQUEST CHANGES

### Decision Rationale
[1-2 sentences explaining the verdict]

## Functional Review Results
[Full output from @functional-reviewer]

## Technical Review Results
[Full output from @technical-reviewer]

## Combined Findings Summary

| # | Stage | Severity | Category | File:Line | Finding | Suggested Fix |
|---|-------|----------|----------|-----------|---------|---------------|

## Statistics
- 🔴 Blockers: [N]
- 🟡 Warnings: [N]
- 🔵 Suggestions: [N]
- 🟢 Praise: [N]

## Actions Required
1. [Must fix #1 — with file and line reference]
2. [Must fix #2 — with file and line reference]
```

## Verdict Determination

| Condition | Verdict |
|-----------|---------|
| Any 🔴 BLOCKER from either stage | ❌ REQUEST CHANGES |
| Only 🟡 WARNING + 🔵 SUGGESTION | ⚠️ APPROVE WITH COMMENTS |
| Only 🔵 SUGGESTION + 🟢 PRAISE | ✅ APPROVE |
| No findings | ✅ APPROVE |

## Actionable Comment Rules

**Every finding at 🔴 or 🟡 level MUST follow this format:**

```markdown
### [SEVERITY]: [Title] — `File.java:L45`

**Problem:** [Explain WHAT is wrong and WHY it matters]

**Current code:**
[problematic code snippet]

**Suggested fix:**
[recommended correction]
```

**Non-actionable comments are forbidden:**
- ❌ "This could be improved" (how?)
- ❌ "Consider refactoring" (to what?)
- ❌ "Code looks good" (not helpful)

## Stack-Specific Review Focus

| Stack | Functional Focus | Technical Focus |
|-------|-----------------|----------------|
| Java/Jakarta EE | CDI-managed business rules, JPA entity state | Transaction boundaries, CDI scope, JPA fetch strategy, Oracle SQL |
| .NET/C# | Domain services, EF entity tracking | Middleware pipeline, DI lifetime, EF migration safety |
| Python/Django | Model signals, manager methods | Migration operations, queryset optimization, async handling |
| Python/FastAPI | Pydantic validation, dependency injection | Async patterns, SQLAlchemy session management |
| TypeScript/React | State management, API integration | Bundle size, re-render performance, type safety |
| PHP/Laravel | Eloquent events, form requests | Migration safety, queue jobs, cache invalidation |
| Android/Kotlin | ViewModel state, use case logic | Coroutine scope, memory leaks, Compose recomposition |
| iOS/Swift | ObservableObject, Combine pipelines | Memory management, MainActor, Core Data migration |

## Validation

- [ ] Requirement document was located and read (or flagged as missing)
- [ ] Functional review traceability table was produced
- [ ] Every changed file was reviewed by the appropriate stage
- [ ] All 🔴 and 🟡 findings include code snippets
- [ ] Short-circuit logic was applied correctly
- [ ] Combined report has accurate statistics
- [ ] Verdict matches finding severity rules
