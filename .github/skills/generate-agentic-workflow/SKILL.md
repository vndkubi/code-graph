---
name: generate-agentic-workflow
description: 'Generate GitHub Copilot Agentic Workflow files (.md) with frontmatter for triggers, permissions, and safe-outputs. Creates automation workflows for issue triage, daily reports, PR checks, and compliance audits that run via the Copilot coding agent in GitHub Actions. Use when setting up automated repository workflows.'
---

# Generate Agentic Workflow

Generate Agentic Workflow markdown files for GitHub Copilot autonomous automation.

## When to Use

- Setting up automated issue triage with AI
- Creating scheduled reports (daily standups, weekly digests)
- Automating PR relevance checks or compliance audits
- Building slash-command-triggered automations
- Keywords: "agentic workflow", "automate", "scheduled report", "triage", "workflow automation"

## What Are Agentic Workflows

Agentic Workflows are AI-powered automations that:
- Are defined in `.md` files with YAML frontmatter
- Get compiled to GitHub Actions via `gh aw compile`
- Run the Copilot coding agent autonomously
- Triggered by schedules, events, or slash commands

## Workflow

### Step 1: Determine the Automation Need

Ask the user:
- What should be automated? (triage, report, check, audit)
- When should it trigger? (schedule, event, slash command)
- What outputs should be created? (issue, comment, PR)
- What permissions are needed? (minimum required)

### Step 2: Generate Workflow File

Place in `.github/workflows/<name>.md`:

```markdown
---
name: "<Workflow Name>"
description: "<Clear description of what this workflow does>"
on:
  schedule: <trigger>  # e.g., "daily on weekdays", "every Monday at 9am"
  # OR
  issues:
    types: [opened]
  # OR
  slash_command: /command-name
permissions:
  contents: read
  issues: read       # or write if creating issues
  pull-requests: read
safe-outputs:
  create-issue:
    title-prefix: "[auto] "
    labels: [automated]
  # OR
  add-comment:
    prefix: "<!-- bot -->"
---

## Task Overview

[Clear description of what the agent should do]

## Steps

1. [First step — gather data]
2. [Second step — analyze/summarize]
3. [Third step — create output]

## Output Format

[Describe the expected format of the result]

## Constraints

- [What the agent must NOT do]
- [Security boundaries]
```

### Step 3: Common Workflow Templates

#### Daily Issues Report
```yaml
on:
  schedule: daily on weekdays at 9am
permissions:
  contents: read
  issues: read
safe-outputs:
  create-issue:
    title-prefix: "[daily-report] "
    labels: [report]
```

#### Issue Triage
```yaml
on:
  issues:
    types: [opened]
permissions:
  issues: write
safe-outputs:
  add-comment:
    prefix: "<!-- triage-bot -->"
```

#### PR Relevance Check
```yaml
on:
  pull_request:
    types: [opened, synchronize]
permissions:
  pull-requests: write
  contents: read
safe-outputs:
  add-comment:
    prefix: "<!-- relevance-check -->"
```

#### Weekly Stale Repos Audit
```yaml
on:
  schedule: every Monday at 8am
permissions:
  contents: read
  issues: write
safe-outputs:
  create-issue:
    title-prefix: "[audit] "
    labels: [maintenance, automated]
```

### Step 4: Compile & Commit

Provide instructions:
```bash
# Install CLI
gh extension install github/gh-aw

# Validate
gh aw compile --validate --no-emit .github/workflows/<name>.md

# Compile
gh aw compile

# Commit both files
git add .github/workflows/<name>.md .github/workflows/<name>.lock.yml
git commit -m "ci(workflow): add <name> agentic workflow"
```

## Security Rules

- Always use **least-privilege permissions** — only request what's needed
- Use **safe-outputs** instead of direct write access
- Include **title-prefix** to make automated outputs identifiable
- Add **labels** to distinguish automated content
- Never grant `admin` or `security_events` permissions unless absolutely necessary

## Output

A complete `.md` workflow file ready to be compiled with `gh aw compile`.
