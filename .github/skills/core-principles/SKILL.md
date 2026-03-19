---
name: core-principles
description: 'Core engineering principles that all agents follow: understand before changing, confirm business logic, no duplicate validation, multi-module awareness, clarify before acting, business domain awareness, and explain decisions. Reference this skill when you need detailed guidance on any of these principles.'
---

# Core Engineering Principles

These principles apply to ALL agents, skills, and workflows in this project. They are the foundation of high-quality, business-aware code generation.

## Principle 1: Understand Before Changing — Read the Current Code Flow First

**Every agent MUST thoroughly read and trace the existing code flow before making any change.** Never assume how the code works — always verify by reading the actual implementation.

- Trace the full call chain: Controller/Resource → Service → Repository → Database
- Understand what each layer is responsible for (validation, business logic, data access)
- Identify what is already handled at each layer before proposing changes
- In multi-module projects, map module boundaries and responsibilities

## Principle 2: Confirm Business Logic — Match Existing Business Rules

Before implementing or suggesting changes, confirm alignment with current business logic:

- If the codebase validates a field at the service layer, respect that pattern
- If business rules are enforced via database constraints, don't duplicate them in code
- When in doubt, present findings and ask the user to confirm the business intent

## Principle 3: No Duplicate Validation Across Layers

**Critical rule**: If validation is already handled at one layer, do NOT duplicate it at another unless there is a clear architectural reason.

| Layer | Validates |
|-------|----------|
| **REST/Controller** | Input format (`@NotNull`, `@Size`, `@Pattern`) |
| **Service** | Business rules (e.g., "order total ≤ credit limit") |
| **Repository/Database** | Data integrity (unique, FK, check constraints) |

Each layer validates what it owns. Do not re-validate upstream concerns downstream.

## Principle 4: Multi-Module Awareness

In multi-module projects (enterprise scale), understand module boundaries:

- Identify which module owns a given responsibility
- Do not duplicate logic that is already handled by another module
- Respect module APIs — don't bypass a module's public interface
- Flag cross-module duplication as a 🔴 Critical issue in reviews

## Principle 5: Clarify Before Acting — Ask the Right Questions First

**Ask clarifying questions when the request lacks sufficient detail.** Do not guess.

- Compose domain-specific questions and wait for answers before proceeding
- Batch related questions (max 3-5 at a time)
- Provide sensible defaults when possible: "I'll use PostgreSQL unless you prefer another?"
- Skip obvious questions — if the codebase already answers it, don't ask

**When to ask**: Ambiguous requests, multiple valid approaches, unclear business rules, breaking changes, infrastructure cost decisions.

**When NOT to ask**: Answer is in the codebase, obvious best practice, user already specified.

## Principle 6: Business Domain Awareness

**Understand the business domain before writing code.** Technically correct code that violates business rules is a critical failure.

- Read business rules from service classes, validators, and domain models
- Understand entity lifecycles and valid state transitions
- Respect domain terminology — use the same terms the codebase uses
- Map business workflows end-to-end before touching any part
- Reference business context in code comments, test names, and PR descriptions

## Principle 7: Explain Decisions & Report Outcomes

**Every agent MUST explain its decisions during execution AND produce a structured completion report.**

### During Execution
- Before each major action, state what you're doing and why
- When choosing between alternatives, explain the trade-off
- When skipping something, explain why

### Completion Report — MANDATORY

**Every agent MUST produce this completion table after finishing work.** This is NOT optional.

**Trigger**: Any time an agent completes a task that involves code changes, investigation, analysis, or planning.

```markdown
## ✅ Completion Report

### Work Summary
| # | Action | File/Artifact | Description | Business Reason |
|---|--------|--------------|-------------|----------------|
| 1 | Created | `src/.../XxxService.java` | New service for order validation | PBI-123: Order limit check |
| 2 | Modified | `src/.../OrderController.java` | Added new endpoint | PBI-123: Expose validation API |
| 3 | Created | `test/.../XxxServiceTest.java` | Unit tests (12 tests, 100% branch) | Quality gate |

### Business Rules Implemented
- ✅ [Rule 1 — enforced at which layer, code location]
- ✅ [Rule 2 — enforced at which layer, code location]

### Design Decisions
| Decision | Alternatives Considered | Rationale |
|----------|------------------------|----------|
| [choice made] | [option A vs B vs C] | [why this was the best choice] |

### What Was NOT Done (and why)
- [item] — [reason: out of scope / already handled / deferred to next sprint]

### Metrics
- Files created: [N]
- Files modified: [N]
- Tests added: [N]
- Test coverage: [%] branch coverage
- Estimated effort: [X] SP → Actual: [Y] hours
```

**Rules:**
- The table must list EVERY file that was created, modified, or deleted
- Each row must have a business reason — not just "added code"
- If investigation only (no code changes), list analyzed files + findings instead
- If planning only (stories/PBIs), list generated artifacts instead

## Principle 8: Verify Before Delivering — Build-Test-Lint Loop

**Every agent that writes code MUST verify it works before presenting results.** Writing code without running it is incomplete work.

### Verify-Fix Loop (MANDATORY after implementation)

1. **BUILD**: Run build command → if fails, read error, fix, rebuild (max 3 retries)
2. **TEST**: Run tests → if fails, analyze output, fix code or test, re-run (max 3 retries)
3. **LINT**: Run linter → if fails, fix violations, re-run

Only report completion after all 3 pass. If still failing after 3 retries: STOP, report the issue with full error output, ask user for guidance.

### Stack-Specific Verify Commands

| Stack | Build | Test | Lint |
|-------|-------|------|------|
| Java/Maven | `mvn compile` | `mvn test` | `mvn checkstyle:check` |
| Java/Gradle | `./gradlew compileJava` | `./gradlew test` | `./gradlew checkstyleMain` |
| .NET | `dotnet build` | `dotnet test` | `dotnet format --verify-no-changes` |
| Python | `python -m py_compile` | `pytest` | `ruff check` or `flake8` |
| TypeScript | `tsc --noEmit` | `npm test` or `vitest` | `eslint .` |
| PHP | `composer install` | `./vendor/bin/phpunit` | `./vendor/bin/phpstan` |
| Android/Kotlin | `./gradlew compileDebugKotlin` | `./gradlew testDebugUnitTest` | `./gradlew detekt` |
| iOS/Swift | `xcodebuild build` | `xcodebuild test` | `swiftlint` |

### Terminal Execution Rules

- **ALWAYS run build after writing production code** — verify compilation
- **ALWAYS run tests after writing test code** — verify they pass
- **Parse terminal output** — read error messages, don't just check exit code
- **Set reasonable timeouts** — build: 120s, test: 300s, lint: 60s
- **Never run destructive commands** without user confirmation (`DROP TABLE`, `rm -rf`, `git push --force`)

## Principle 9: Manage Context in Long Sessions

In long agentic sessions (multi-step implementations, large features), actively manage context to prevent losing track of decisions:

- **Save progress to file**: After each major phase, write progress to a working document
- **Summarize before switching phases**: When moving from investigation to implementation, summarize key decisions
- **Use todo lists**: Track which files have been created/modified
- **Reference files over memory**: Write decisions to investigation docs, reference them during implementation
- **Break large tasks**: If a feature touches 10+ files, implement in verifiable chunks (see Incremental Implementation in `orchestrate-development` skill)

