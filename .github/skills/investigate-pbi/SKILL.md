---
name: investigate-pbi
description: 'PBI and technical investigation workflow. Performs as-is analysis by tracing current code flow, designs to-be state with proposed changes, maps scenarios with edge cases, assesses impact on affected modules and systems, identifies risks, and outputs a structured markdown investigation report. Use when asked to investigate a PBI, bug, performance issue, or plan a technical change in Java/Jakarta EE projects.'
---

# Investigate PBI

Structured PBI/technical investigation that produces a comprehensive analysis report.

## When to Use

- Investigating a new PBI or user story
- Analyzing a bug to find root cause
- Planning performance improvements
- Evaluating technical changes before implementation
- Understanding impact of proposed modifications

## Workflow

### Step 1: Parse the Request

Extract from the PBI/issue:
- Business requirement or problem description
- Acceptance criteria
- Scope and constraints
- Related systems or dependencies

### Step 2: As-Is Analysis

Trace the current flow through the codebase:

1. Identify entry points (REST endpoints, JMS listeners, schedulers)
2. Follow call chain: Resource → Service → Repository → Database
3. Document current data flow and transformations
4. Note current database queries and schemas
5. Identify external service calls
6. Assess current test coverage for affected code
7. **Identify what each layer already handles** (validation, business logic, data access)
8. **In multi-module projects**, map module boundaries and which module owns which responsibility
9. **Document which layer handles which validation** — to prevent duplication in the to-be design

### Step 3: To-Be Design

Design the target state:

1. Proposed changes to each layer (what files to create/modify/delete)
2. New/modified entities, DTOs, services
3. Database schema changes (new tables, columns, indexes)
4. New/modified APIs

### Step 4: Scenario Mapping

Create a scenario table:

| Scenario | Precondition | Input | Expected Result | Edge Cases |
|----------|-------------|-------|-----------------|------------|
| Happy Path | [state] | [data] | [result] | - |
| Validation Error | [state] | [invalid data] | [error] | [cases] |
| Not Found | [state] | [missing ref] | [404] | [cases] |
| Concurrent Access | [state] | [parallel] | [behavior] | [race conditions] |
| Boundary | [state] | [limits] | [behavior] | [overflow, max] |

### Step 5: Impact Analysis

Assess:
- Directly affected modules/domains
- Indirect dependencies that might break
- Database changes and migration needs
- API contract changes (backward compatibility)
- Integration impact (JMS, external services)
- Configuration changes needed
- WireMock stubs that need updating

### Step 6: Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| [risk] | High/Med/Low | High/Med/Low | [plan] |

### Step 7: Generate Report

Output a markdown file with all findings, following the format defined in the `@investigator` agent.

## Validation

- [ ] Current flow was traced from actual code (not assumed)
- [ ] **Business logic confirmed** — proposed changes align with existing business rules
- [ ] **Layer responsibilities documented** — which layer validates what
- [ ] **No duplicate validation in to-be design** across layers
- [ ] **Multi-module boundaries respected** — no cross-module duplication
- [ ] All affected files are listed with their paths
- [ ] All scenarios include expected results
- [ ] Impact covers both direct and indirect dependencies
- [ ] Risks have mitigation plans
- [ ] Implementation checklist is complete
