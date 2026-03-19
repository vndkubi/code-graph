---
name: sprint-planning
description: 'Sprint planning assistant for agile teams. Decomposes PBIs into technical tasks, estimates story points using t-shirt sizing or Fibonacci, identifies dependencies and risks, creates sprint backlogs with clear acceptance criteria. Use when planning sprints, breaking down user stories, or estimating effort.'
---

# Sprint Planning

Assist with sprint planning by decomposing requirements into technical tasks with proper estimation.

## When to Use

- Sprint planning sessions — breaking PBIs into implementable tasks
- Story point estimation for user stories or technical tasks
- Identifying dependencies between tasks and cross-team coordination
- Creating sprint backlogs with prioritization
- Keywords: "sprint planning", "break down", "estimate", "story points", "decompose PBI", "technical tasks"

## Workflow

### Step 1: Understand the PBI/User Story

Read the requirement carefully and extract:
- **As a** [role] **I want** [capability] **so that** [benefit]
- Acceptance criteria (explicit and implicit)
- Non-functional requirements (performance, security, scalability)
- Dependencies on other teams, APIs, or infrastructure

### Step 2: Codebase Impact Analysis

Before estimating, analyze the actual codebase:
1. Search for related code — entry points, services, models, tests
2. Assess complexity of changes needed per layer
3. Identify shared code / cross-cutting concerns that might be affected
4. Check existing test coverage in affected areas
5. Look for similar past implementations for comparison

### Step 3: Decompose into Technical Tasks

Break each PBI into tasks following this pattern:

| # | Task | Layer | Estimate | Dependencies |
|---|------|-------|----------|--------------|
| 1 | Database migration | Data | S | None |
| 2 | Entity/Model changes | Domain | S | Task 1 |
| 3 | Service/business logic | Application | M | Task 2 |
| 4 | API endpoint | Presentation | S | Task 3 |
| 5 | Unit tests | Testing | M | Task 3, 4 |
| 6 | Integration tests | Testing | M | Task 4 |
| 7 | Documentation update | Docs | S | Task 4 |

### Step 4: Estimate using team's preferred method

**Fibonacci (1, 2, 3, 5, 8, 13, 21)**:
- 1: Trivial change, <30 min (config, typo fix)
- 2: Simple change, ~1-2 hours (add field, rename)
- 3: Standard task, ~half day (new endpoint, new service method)
- 5: Moderate complexity, ~1 day (new feature across layers)
- 8: Complex, ~2 days (multi-service changes, new patterns)
- 13: Very complex, ~3-5 days (new subsystem, architecture changes)
- 21: Epic-level — should be decomposed further

**T-Shirt Sizing (XS, S, M, L, XL)**:
- XS: < 2 hours
- S: 2-4 hours
- M: 4-8 hours (1 day)
- L: 1-3 days
- XL: 3-5 days — consider splitting

### Step 5: Risk & Dependency Matrix

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| External API change | Low | High | Mock first, integration test |
| Schema migration on large table | Medium | High | Test on staging data volume |
| Cross-team dependency | Medium | Medium | Align in sprint planning |

### Step 6: Sprint Backlog Output

```markdown
## Sprint [N] Backlog

### Sprint Goal
[One sentence describing the sprint's primary objective]

### Capacity
- Team capacity: [X] story points
- Planned: [Y] story points
- Buffer: [Z] points for bugs/support

### Items
| Priority | PBI/Task | Points | Assignee | Status |
|----------|----------|--------|----------|--------|
| P0 | [task] | 5 | — | To Do |
| P1 | [task] | 3 | — | To Do |

### Dependencies
- [Task A] blocks [Task B] — same sprint, manage order
- [External team] delivers API by day 3

### Risks
- [risk with mitigation]

### Definition of Done
- [ ] Code complete with tests
- [ ] Code reviewed and approved
- [ ] Documentation updated
- [ ] Deployed to staging
- [ ] PO acceptance
```

## Output Format

Present the sprint plan as a structured markdown document with tables for easy copy to Jira/Azure DevOps/Linear.
