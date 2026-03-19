---
agent: 'agent'
description: 'Generate reusable workflow skills from current codebase patterns. Detects developer workflows like testing, implementation, review, and deployment, then creates SKILL.md files with step-by-step instructions.'
---

# Generate Workflow Skills

Create `.github/skills/[name]/SKILL.md` files based on developer workflows detected in the current codebase.

## Step 1: Detect Developer Workflows

Analyze the project to identify common workflows:

### Always-Present Workflows
| Workflow | Detection Signal | Skill to Create |
|----------|-----------------|----------------|
| Feature implementation | Source code exists | `implement-feature` |
| Unit testing | Test framework in dependencies | `generate-unit-tests` |
| Code review | Any collaborative project | `review-code-changes` |

### Conditional Workflows
| Detection Signal | Skill to Create |
|-----------------|----------------|
| Multi-layer architecture (3+ layers) | `investigate-pbi` |
| REST/API endpoints | `create-api-endpoint` |
| Database entities/migrations | `database-migration` |
| WireMock/MockServer stubs detected | `generate-wiremock` |
| Complex request flows | `generate-sequence-diagram` |
| Android/iOS source code | `implement-mobile-feature`, `generate-mobile-tests` |
| CI/CD pipelines | `prepare-deployment` |
| OpenAPI/Swagger specs | `generate-api-client` |
| Docker/container files | `setup-local-env` |
| Multiple environments | `manage-config` |

## Step 2: Analyze Existing Patterns

For each workflow to create:
1. Find existing examples in the codebase (how is this workflow done today?)
2. Read test files to understand testing patterns
3. Read build files for build/deploy commands
4. Read README and docs for documented procedures

## Step 3: Create Skill Files

### Skill File Format

Each skill is a folder with a `SKILL.md` inside:

```
.github/skills/
├── skill-name/
│   ├── SKILL.md              # Main skill definition (REQUIRED)
│   ├── references/             # Optional: example files
│   └── templates/              # Optional: code templates
```

### SKILL.md Format

```markdown
---
name: skill-name-in-kebab-case
description: '[WHAT it does]. [WHEN to use it]. [KEYWORDS for discovery]. Must be 10-1024 characters.'
---

# Skill Title

## When to Use

- [Condition 1 that triggers this skill]
- [Condition 2]
- [Trigger phrases users might say]

## Prerequisites

- [What must exist before this skill runs]
- [Required context or prior analysis]

## Workflow

### Step 1: [Action Name]
[Detailed instructions for step 1]

### Step 2: [Action Name]
[Detailed instructions for step 2]

### Step N: [Action Name]
[Final step]

## Validation Checklist

- [ ] [Verification item 1]
- [ ] [Verification item 2]
```

### Frontmatter Rules

| Field | Requirements |
|-------|-------------|
| `name` | kebab-case, max 64 characters, globally unique |
| `description` | 10-1024 characters, format: WHAT + WHEN + KEYWORDS |

### Description Best Practices

The `description` is used for **agent skill discovery** — it determines when the skill is auto-selected. Include:

1. **WHAT**: What the skill does (first sentence)
2. **WHEN**: When to use it (second sentence)
3. **KEYWORDS**: Terms that trigger discovery

**Example:**
```
'Generate comprehensive unit tests for Java classes with minimal mocking. Analyzes all code branches, creates test builders, and outputs JUnit 5 tests with full coverage. Use when asked to write tests, improve coverage, or generate tests for existing code.'
```

## Step 4: Customize to Project Patterns

For each skill, read the actual codebase and include:
- Real package names and class naming patterns
- Real build commands (`mvn`, `gradle`, `npm`, `xcodebuild`)
- Real test frameworks and assertion libraries used
- Real architecture layers and their responsibilities
- Real directory structure and conventions

## Step 5: Validate

For each skill file:
- [ ] `name` is kebab-case, max 64 characters
- [ ] `description` is 10-1024 characters
- [ ] Description contains WHAT + WHEN + trigger KEYWORDS
- [ ] Workflow steps are specific and actionable (not generic)
- [ ] References patterns actually used in this codebase
- [ ] Validation checklist items are verifiable
- [ ] Folder name matches the `name` field

## Output

List all created skills:
```
🎯 Skills Generated:
├── [skill-name]/ — [brief description]
├── ...
```
