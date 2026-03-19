---
name: estimate-effort
description: 'Estimate development effort for user stories, PBIs, or technical tasks by analyzing codebase complexity, affected layers, test coverage needs, and risk factors. Produces story point estimates with justification and confidence levels. Use when estimating backlog items or planning capacity.'
---

# Estimate Effort

Analyze codebase and requirements to produce development effort estimates.

## When to Use

- Estimating story points for a PBI or user story
- Comparing effort between alternative implementation approaches
- Capacity planning for a sprint or release
- Technical feasibility assessment with time estimates
- Keywords: "estimate", "how long", "story points", "effort", "complexity", "how big"

## Workflow

### Step 1: Understand the Requirement
- Extract what needs to change and why
- Identify acceptance criteria
- Clarify unknowns with the user

### Step 2: Analyze Codebase Impact
1. **Search** for all affected files, modules, and layers
2. **Count** the changes needed:
   - New files to create
   - Existing files to modify
   - Tests to write/update
   - Migrations to create
   - Config changes
3. **Assess complexity** per change:
   - Simple (add/rename field, config change)
   - Moderate (new business logic, new endpoint)
   - Complex (architectural change, new patterns, multi-service)

### Step 3: Factor in Risk Multipliers

| Factor | Multiplier | Reason |
|--------|-----------|--------|
| Well-understood domain | 1.0x | Low risk |
| New technology/pattern | 1.5x | Learning curve |
| External API integration | 1.3x | Dependency risk |
| Database migration (large tables) | 1.5x | Performance risk |
| Cross-team dependency | 1.3x | Coordination overhead |
| No existing tests | 1.5x | Higher test effort |
| Legacy code (no patterns) | 1.5x | Comprehension time |

### Step 4: Produce Estimate

```markdown
## Estimate: [Task/PBI Title]

### Summary
- **Estimated Points**: [X] (Fibonacci) / [T-shirt size]
- **Confidence**: High / Medium / Low
- **Calendar Time**: ~[X] days (1 developer)

### Breakdown
| Component | Effort | Complexity | Notes |
|-----------|--------|-----------|-------|
| Entity/Model | 2h | Simple | New field + relationship |
| Migration | 1h | Simple | New column + index |
| Service layer | 4h | Moderate | New business logic |
| API endpoint | 2h | Simple | Standard CRUD |
| Unit tests | 4h | Moderate | ~15 test cases |
| Integration tests | 3h | Moderate | 5 API test scenarios |
| Documentation | 1h | Simple | API docs update |
| **Total** | **17h** | — | ~2.5 days |

### Risk Factors
- [factor]: [impact on estimate]

### Assumptions
- [assumption affecting the estimate]

### Alternatives Considered
| Approach | Estimate | Pros | Cons |
|----------|----------|------|------|
| [approach A] | 5 pts | [pro] | [con] |
| [approach B] | 8 pts | [pro] | [con] |
```

## Calibration Guidelines

Compare with recent completed work in the same codebase:
- Find similar past tasks and their actual effort
- Adjust estimate based on team velocity
- Account for team familiarity with the area
