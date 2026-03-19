---
name: context-budget-check
description: 'Validate that all generated Copilot configuration files comply with context budget targets. Calculates worst-case co-loading scenarios and flags oversized files. Use after generating or modifying .github/ configuration files.'
---

# Context Budget Check

Verify all Copilot config files stay within context budget targets to ensure optimal model performance.

## When to Use

- After bootstrap pipeline generates all config files
- After modifying any agent, instruction, skill, or prompt file
- As Phase 12 in the bootstrap pipeline
- Keywords: "check context budget", "validate sizes", "context audit"

## Target Sizes

| File Type | Target | Maximum | Rationale |
|-----------|--------|---------|-----------|
| `copilot-instructions.md` | 2-3 KB | 4 KB | Loaded EVERY request |
| `.instructions.md` | 2-4 KB | 6 KB | Auto-loaded, multiple co-load |
| `.agent.md` | 4-8 KB | 10 KB | On-demand, competes with code |
| `SKILL.md` | 3-8 KB | 15 KB | On-demand, loaded when needed |
| `.prompt.md` | 1-2 KB | 3 KB | Entry point only |

## Workflow

### Step 1: Measure All Files

List all `.md` files in `.github/` with their sizes.

### Step 2: Check Individual Compliance

For each file, verify it's under the maximum for its type:
- ✅ Under target → OK
- ⚠️ Between target and maximum → Warning
- ❌ Over maximum → Must fix

### Step 3: Calculate Co-Loading Scenarios

Simulate worst-case context loading:

| Scenario | Files Loaded | Budget |
|----------|-------------|--------|
| General chat | `copilot-instructions.md` | ≤ 4 KB |
| Editing `*.java` | copilot-instructions + java + jakartaee + error-handling + security + logging | ≤ 24 KB |
| `@dev-orchestrator` on `*.java` | Above + agent file | ≤ 34 KB |
| Full pipeline with skill | Above + skill file | ≤ 49 KB |

### Step 4: Generate Report

```markdown
## Context Budget Report

### File Compliance
| File | Size | Target | Status |
|------|------|--------|--------|
| copilot-instructions.md | 3.5 KB | 4 KB | ✅ |
| dev-orchestrator.agent.md | 8 KB | 10 KB | ✅ |

### Co-Loading Budget
| Scenario | Total | Budget | Status |
|----------|-------|--------|--------|
| Edit *.java | 18 KB | 24 KB | ✅ |

### Recommendations
- [any files that need splitting or trimming]
```

### Step 5: Fix Oversized Files

If files exceed budget:
1. **Agent too large** → Move workflow detail to a skill
2. **Instruction too large** → Split by domain or reduce code examples
3. **copilot-instructions.md too large** → Move content to domain instructions or skills
4. **Prompt too large** → Keep as entry point only, delegate to agent + skill
