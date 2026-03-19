---
name: implement-feature
description: 'Guided feature implementation across all layers of a Java/Jakarta EE application. Creates or modifies entities, DTOs, mappers, repositories, services, REST resources, and database migration scripts following existing codebase patterns. Use when asked to implement a feature, fix a bug, add an API endpoint, or make code changes based on an investigation report.'
---

# Implement Feature

Step-by-step implementation guidance for Java/Jakarta EE projects.

## When to Use

- Implementing a new feature or PBI
- Fixing a bug with code changes
- Adding a new API endpoint
- Modifying existing business logic
- Creating database migrations

## Prerequisites

- Investigation report or clear PBI requirements
- Understanding of affected domains/modules

## Workflow

### Step 1: Review Requirements

Read the investigation report or PBI:
- What files need to be created or modified?
- What layers are affected?
- What database changes are needed?
- What tests need to be written?

### Step 1.5: Trace Existing Code Flow & Confirm Business Logic

**MANDATORY before writing any code:**
- Trace the full call chain: Controller/Resource → Service → Repository → Database
- Identify what each layer already handles (validation, business logic, data access)
- Confirm proposed changes align with existing business rules
- In multi-module projects, understand module boundaries and responsibilities
- Document which layer handles which validation to prevent duplication

### Step 2: Analyze Existing Patterns

Before writing code, examine:
- How similar features are implemented in the codebase
- Base classes, interfaces, utilities available
- Naming conventions, package structure
- Exception handling approach
- Validation approach (Bean Validation, custom)

### Step 3: Implement (bottom-up)

1. **Database migration** — SQL scripts for schema changes
2. **Entity classes** — JPA entities with mappings
3. **DTOs** — Request/Response objects with validation
4. **Mappers** — Entity ↔ DTO conversion
5. **Repository/DAO** — Data access with JPQL/Criteria/Native queries
6. **Service** — Business logic, transaction management
7. **REST Resource** — Endpoint with validation, documentation
8. **Configuration** — Properties, CDI producers if needed

**Incremental verification (for 5+ files):** After completing each layer group (data → business → API), run `mvn compile` to verify before proceeding. Do NOT write all layers then compile at the end.

### Step 4: Write Unit Tests

For each new/modified class:
- Use real objects whenever possible (minimize mocks)
- Create test builders for new entities/DTOs
- Cover all business logic branches
- Follow existing test patterns in the project

### Step 5: Verify (MANDATORY)

Execute the Verify-Fix Loop — do NOT skip:
1. `mvn compile` — compilation check → if fails, fix and retry (max 3)
2. `mvn test` — unit tests → if fails, analyze output, fix, retry (max 3)
3. `mvn verify` — integration tests (if applicable)
4. Check for any new linting/checkstyle warnings

Only proceed to report/PR after all checks pass.
If still failing after 3 retries: STOP, report the error, ask user.

## Validation

- [ ] **Existing code flow was traced before implementation**
- [ ] **Business logic confirmed** — changes match existing business rules
- [ ] **No duplicate validation across layers** (REST/Service/Repository)
- [ ] **No duplicate logic across modules** (multi-module projects)
- [ ] All layers follow existing codebase patterns
- [ ] Database migration is reversible
- [ ] Unit tests cover all new business branches
- [ ] No compilation errors
- [ ] No test failures
- [ ] JavaDoc added for public APIs
- [ ] **Verify-Fix loop passed** — build + test + lint all green
- [ ] **Cross-file consistency**:
  - [ ] Every new Entity field → has DTO field + mapper logic
  - [ ] Every new endpoint → has corresponding test
  - [ ] Every new service method → referenced in resource
  - [ ] Every new validation → has negative test case
  - [ ] Method signatures consistent across interface ↔ implementation
