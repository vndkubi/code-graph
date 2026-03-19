---
name: impact-analysis
description: 'Cross-module impact analysis for enterprise projects. Traces reverse dependencies, estimates blast radius, detects breaking changes, and generates migration guides. Use before making changes to shared code, APIs, or database schemas in large multi-module codebases.'
---

# Impact Analysis

Workflow for assessing the blast radius of proposed changes in enterprise multi-module projects.

## When to Use

- Before modifying shared classes, interfaces, DTOs, or constants
- Before changing database schemas referenced by multiple modules
- Before updating API contracts (REST endpoints, message formats)
- Before upgrading shared library versions
- Keywords: "impact analysis", "blast radius", "what would break", "which modules affected"

## Workflow

### Step 1: Define the Change

Identify what is being changed:
- **File/Class level**: Which classes/interfaces are modified?
- **API level**: Any method signature changes, new required fields, removed fields?
- **Schema level**: Table/column changes, constraint modifications?
- **Dependency level**: Library version upgrade, transitive dependency changes?

### Step 2: Trace Direct Consumers

Find all direct usages of the changed item:
- **Code search**: Grep for imports, method calls, class references
- **Build dependencies**: Which modules declare a dependency on the changed module?
- **Database references**: Which entities/repositories reference modified tables?
- **API consumers**: Which modules call the modified REST API?

### Step 3: Trace Transitive Impact

Follow the dependency chain outward:
- Module A changes → Module B imports from A → Module C imports from B → ...
- Map the full chain with depth level

### Step 4: Classify Impact

For each affected consumer:

| Impact Level | Criteria | Action Required |
|---|---|---|
| 🔴 **Breaking** | Compile error, runtime failure, data loss risk | Must update consumer before/during deployment |
| 🟡 **Behavioral** | Logic change, different output, performance impact | Should verify consumer still works correctly |
| 🟢 **Compatible** | Additive change, new optional field, backward compatible | No consumer changes needed |

### Step 5: Generate Report

```markdown
## Impact Analysis Report: [Change Description]

### Change Summary
- **Changed**: [module/file/API]
- **Type**: [Breaking / Behavioral / Compatible]
- **Blast Radius**: [Low: 1-3 modules / Medium: 4-10 / High: 10+]

### Affected Modules
| Module | Impact Level | Depth | Required Changes |
|--------|-------------|-------|------------------|
| [module] | 🔴 Breaking | Direct | Update import, fix API call |
| [module] | 🟡 Behavioral | Transitive | Verify tests pass |

### Migration Guide
1. [Step-by-step for each breaking change]

### Test Impact
| Test Suite | Module | Needs Re-run | Reason |
|-----------|--------|-------------|--------|

### Recommended Deployment Order
1. [deploy order to avoid runtime failures]

### Risk Assessment
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|-----------|
```

## Validation

- [ ] All direct consumers identified
- [ ] Transitive chain traced at least 2 levels deep
- [ ] Each affected module classified by impact level
- [ ] Migration guide provided for breaking changes
- [ ] Deployment order recommended
