---
name: validate-bootstrap-output
description: 'Validate the quality of a bootstrapped Copilot configuration beyond structural checks. Tests that generated agents, skills, and instructions actually reference the target project — not generic placeholder content. Use after bootstrapping or upgrading a project. Keywords: validate bootstrap, quality check, bootstrap validation, config quality.'
---

# Validate Bootstrap Output

This skill runs deep quality validation on a bootstrapped `.github/` configuration, beyond the structural Phase 12 checks. It catches the most common failure: generated files that look valid but contain generic placeholder content instead of project-specific information.

## When to Use

- After running `/bootstrap-copilot` to verify output quality
- After running `upgrade-config` to verify new files are project-specific
- When agents or skills seem to give generic responses that don't match the project
- Keywords: "validate bootstrap", "check quality", "is the config good?"

## Validation Checklist

### Tier 1: Structural (fast — run first)

Re-run Phase 12 checks from `generate-copilot-config`:
- [ ] All `.agent.md` have valid `name` and `description` frontmatter
- [ ] No `tools:` or `mode:` fields in agent frontmatter
- [ ] All `SKILL.md` have `name` and `description` (10-1024 chars)
- [ ] All `.instructions.md` have `applyTo` patterns
- [ ] No empty or stub files (< 200 bytes)
- [ ] Context budget compliant (use `context-budget-check` skill)

### Tier 2: Project-Specificity (critical — the most common failure)

For each generated file, verify it contains **project-specific content** — not generic phrases.

**Red flags** (fail immediately if found):
- Any agent description containing: "your project", "the codebase", "detected tech stack", "[tech stack]", "[framework]"
- Any instruction `applyTo` set to `**/*` (too broad — not stack-specific)
- Any skill referring to `mvn clean install` when the project uses Gradle (or vice versa)
- Any agent referencing entity names like `Order`, `Customer` when those don't exist in the project
- Any instruction file that is byte-for-byte identical to a toolkit template

**Project-specificity checks:**

| File | What to Verify |
|------|---------------|
| `copilot-instructions.md` | Contains actual project name, actual build commands, actual module names |
| `dev-orchestrator.agent.md` | `agents:` list matches ALL other generated agent names (no missing, no extra) |
| `implementor.agent.md` | References actual package names from Phase 1 scan (e.g., `com.company.project`) |
| `java.instructions.md` | If Java 17 project — contains Records / sealed classes section |
| `testing.instructions.md` | References actual test framework detected (JUnit5 / pytest / xUnit) |
| Domain instructions | `applyTo` patterns match actual file paths in the project |
| Skill files | Build commands match project's actual build tool and module names |

### Tier 3: Cross-Reference Integrity

- [ ] Every agent name listed in `dev-orchestrator.agent.md` `agents:` field has a corresponding `.agent.md` file
- [ ] Every skill referenced by an agent (`follow the X skill`) exists as a `SKILL.md` in `.github/skills/X/`
- [ ] Every `applyTo` pattern in instructions matches ≥ 1 real file in the project (run a glob check)
- [ ] Domain instruction `applyTo` patterns don't overlap (two instructions shouldn't apply to the same file for the same rules)

### Tier 4: Manifest Integrity

- [ ] `.github/.bootstrap-manifest.json` exists and is valid JSON
- [ ] `generatedFiles` in manifest lists all files currently present
- [ ] No files in `.github/` that are NOT in the manifest (indicates leftover bootstrap templates)
- [ ] `contextBudget.passed` is `true`

## Output Format

```markdown
## Bootstrap Output Validation Report

**Project**: [project name from copilot-instructions.md]
**Toolkit version**: [from manifest]
**Classification**: [Small | Standard | Enterprise]
**Validated at**: [timestamp]

### Tier 1: Structural
| Check | Status | Notes |
|-------|--------|-------|
| Frontmatter validity | ✅ | All files valid |
| No obsolete fields | ✅ | |
| No empty files | ✅ | |
| Context budget | ✅ | 38 KB / 45 KB max |

### Tier 2: Project-Specificity
| File | Status | Issue |
|------|--------|-------|
| copilot-instructions.md | ✅ | References "OrderService", "com.acme.orders" |
| dev-orchestrator.agent.md | ✅ | 9 agents listed, all files present |
| implementor.agent.md | ⚠️ | Package name is generic "com.company.project" — update with actual package |
| java.instructions.md | ✅ | Java 17+ sections present (project uses Java 17) |

### Tier 3: Cross-Reference
| Check | Status | Notes |
|-------|--------|-------|
| All orchestrator agents exist | ✅ | |
| All skill references resolve | ✅ | |
| applyTo patterns match files | ⚠️ | `**/domain/payment/**/*.java` matches 0 files — payment module may be named differently |

### Tier 4: Manifest
| Check | Status | Notes |
|-------|--------|-------|
| Manifest exists | ✅ | |
| generatedFiles complete | ⚠️ | 2 files in .github/ not in manifest (leftover bootstrap templates?) |
| contextBudget.passed | ✅ | |

---

### Summary
- ✅ Passed: 14 checks
- ⚠️ Warnings: 3 checks (non-blocking)
- ❌ Failures: 0

### Recommendations
1. `implementor.agent.md` L12 — replace `com.company.project` with `com.acme.orders`
2. `java.instructions.md` `applyTo` — verify `**/domain/payment/**/*.java` matches actual path
3. Check for leftover bootstrap templates: [file list]
```

## Fix Guidance

For each warning/failure:

| Issue | Fix |
|-------|-----|
| Generic package name in agent | Edit agent file — replace placeholder with actual package from Phase 1 scan |
| `applyTo` matches 0 files | Run glob against project to find correct path pattern, update instruction |
| Missing agent in orchestrator `agents:` list | Add agent name to `dev-orchestrator.agent.md` agents field |
| Leftover bootstrap template | Delete the file — it was not cleaned up in Phase 14 |
| Generic build command | Edit skill — replace `mvn clean install` with project's actual command from manifest |
