---
name: generate-hooks
description: 'Generate GitHub Copilot hooks (.github/hooks/*.json) for automating lifecycle events during agent sessions. Creates hook configurations for auto-formatting after file edits, lint checks on agent stop, security gating before tool use, and governance audit. Detects project formatters and linters to generate tailored hooks. Use when bootstrapping Copilot config, setting up quality automation, or adding lifecycle hooks.'
---

# Generate Copilot Hooks

Generate `.github/hooks/*.json` files that automate shell commands at key moments during Copilot agent sessions.

## When to Use

- Bootstrapping a new Copilot configuration (as part of the pipeline)
- User wants auto-formatting after Copilot edits files
- User wants lint checks to run when agent finishes
- User wants security gates before shell commands execute
- Keywords: "hooks", "auto-format", "auto-lint", "quality gates", "lifecycle automation"

## Hook Events Reference

> **Official GitHub Copilot hook events** — only these 6 events are supported. `agentStop` and `subagentStop` do NOT exist for GitHub Copilot hooks.

| Event | When it Fires | Common Use |
|-------|---------------|------------|
| `sessionStart` | Agent session begins | Initialize environments, validate project state |
| `sessionEnd` | Agent session completes | Final checks, cleanup, audit trail |
| `userPromptSubmitted` | User submits a prompt | Audit prompts, rate-limit, compliance logging |
| `preToolUse` | Before each tool execution | Block dangerous commands, enforce security policies |
| `postToolUse` | After each tool execution | Format code after file edits, log tool usage |
| `errorOccurred` | Error during execution | Log errors, send alerts |

### Choosing the Right Event for Quality Checks

There is no "agentStop" equivalent in GitHub Copilot hooks. Use this mapping instead:

| Quality Check Goal | Recommended Event | Rationale |
|-------------------|-----------------|-----------|
| Auto-format after file edit | `postToolUse` | Fires immediately after each edit |
| Lint check | `postToolUse` (filter by tool) | Run only when file-editing tools are used |
| Compile check | `postToolUse` (filter by tool) | Run after file writes |
| Security gate | `preToolUse` | Block before execution, not after |
| Session audit log | `sessionStart` + `sessionEnd` | Bracket the full session |
| Error monitoring | `errorOccurred` | Catch failures as they happen |

**Filtering by tool in `postToolUse`** — the hook receives `toolName` in its stdin JSON. Use a script that reads stdin and skips non-edit tools:

```bash
#!/bin/bash
# Only run quality check when a file was edited
TOOL=$(echo "$STDIN_JSON" | jq -r '.toolName // empty')
case "$TOOL" in
  "str_replace_editor"|"create_file"|"write_file"|*"edit"*|*"write"*) ;;
  *) exit 0 ;;  # skip — not a file-editing tool
esac
# run your quality check here
```

## Hook File Format

Location: `.github/hooks/<hook-name>.json`

```json
{
  "version": 1,
  "hooks": {
    "<event>": [
      {
        "type": "command",
        "bash": "<unix command>",
        "powershell": "<windows command>",
        "cwd": ".",
        "timeoutSec": 30,
        "env": {
          "CUSTOM_VAR": "value"
        }
      }
    ]
  }
}
```

**Key rules:**
- `type` is always `"command"`
- Either `bash` or `powershell` (or both) must be provided
- Non-zero exit code **blocks** the triggering action (especially for `preToolUse`)
- `timeoutSec` default is 30 — keep hooks fast

## Workflow

### Step 1: Detect Project Tooling

Search the project for:
- **Formatters**: Prettier, Black, gofmt, google-java-format, spotless, ktlint
- **Linters**: ESLint, Checkstyle, PMD, SpotBugs, pylint, SwiftLint, detekt
- **Type checkers**: TypeScript `tsc`, mypy
- **Build tools**: Maven, Gradle, npm, cargo
- **Test runners**: JUnit, pytest, jest, XCTest

### Step 2: Generate Hooks Based on Detection

#### Auto-Format Hook (auto-format.json)

If formatter detected, create `postToolUse` hook:

**Java (Maven + Spotless)**:
```json
{
  "version": 1,
  "hooks": {
    "postToolUse": [
      {
        "type": "command",
        "bash": "mvn spotless:apply -q",
        "powershell": "mvn spotless:apply -q",
        "cwd": ".",
        "timeoutSec": 30
      }
    ]
  }
}
```

**JavaScript/TypeScript (Prettier)**:
```json
{
  "version": 1,
  "hooks": {
    "postToolUse": [
      {
        "type": "command",
        "bash": "npx prettier --write .",
        "powershell": "npx prettier --write .",
        "cwd": ".",
        "timeoutSec": 30
      }
    ]
  }
}
```

**Python (Black)**:
```json
{
  "version": 1,
  "hooks": {
    "postToolUse": [
      {
        "type": "command",
        "bash": "python -m black .",
        "powershell": "python -m black .",
        "cwd": ".",
        "timeoutSec": 30
      }
    ]
  }
}
```

**Kotlin (ktlint)**:
```json
{
  "version": 1,
  "hooks": {
    "postToolUse": [
      {
        "type": "command",
        "bash": "./gradlew ktlintFormat -q",
        "powershell": ".\\gradlew ktlintFormat -q",
        "cwd": ".",
        "timeoutSec": 30
      }
    ]
  }
}
```

#### Lint Check Hook (lint-check.json)

If linter detected, create `postToolUse` hook (fires after each file edit):

**Java (Checkstyle via Maven)**:
```json
{
  "version": 1,
  "hooks": {
    "postToolUse": [
      {
        "type": "command",
        "bash": "TOOL=$(echo \"$STDIN_JSON\" | jq -r '.toolName // empty'); case \"$TOOL\" in *edit*|*write*|*create*) mvn checkstyle:check -q ;; *) exit 0 ;; esac",
        "powershell": "mvn checkstyle:check -q",
        "cwd": ".",
        "timeoutSec": 60
      }
    ]
  }
}
```

**JavaScript/TypeScript (ESLint)**:
```json
{
  "version": 1,
  "hooks": {
    "postToolUse": [
      {
        "type": "command",
        "bash": "TOOL=$(echo \"$STDIN_JSON\" | jq -r '.toolName // empty'); case \"$TOOL\" in *edit*|*write*|*create*) npx eslint . --max-warnings 0 ;; *) exit 0 ;; esac",
        "powershell": "npx eslint . --max-warnings 0",
        "cwd": ".",
        "timeoutSec": 60
      }
    ]
  }
}
```

#### Compile Check Hook (compile-check.json)

If build tool detected, create `postToolUse` hook to verify compilation after file edits:

**Java (Maven)**:
```json
{
  "version": 1,
  "hooks": {
    "postToolUse": [
      {
        "type": "command",
        "bash": "TOOL=$(echo \"$STDIN_JSON\" | jq -r '.toolName // empty'); case \"$TOOL\" in *edit*|*write*|*create*) mvn compile -q -DskipTests ;; *) exit 0 ;; esac",
        "powershell": "mvn compile -q -DskipTests",
        "cwd": ".",
        "timeoutSec": 120
      }
    ]
  }
}
```

**TypeScript**:
```json
{
  "version": 1,
  "hooks": {
    "postToolUse": [
      {
        "type": "command",
        "bash": "TOOL=$(echo \"$STDIN_JSON\" | jq -r '.toolName // empty'); case \"$TOOL\" in *edit*|*write*|*create*) npx tsc --noEmit ;; *) exit 0 ;; esac",
        "powershell": "npx tsc --noEmit",
        "cwd": ".",
        "timeoutSec": 60
      }
    ]
  }
}
```

### Step 3: Optional Enterprise Hooks

If enterprise/security patterns detected, additionally generate:

#### Security Gate Hook (security-gate.json)

For `preToolUse` — block dangerous terminal commands:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "bash": ".github/hooks/scripts/security-check.sh",
        "powershell": ".github/hooks/scripts/security-check.ps1",
        "cwd": ".",
        "timeoutSec": 10
      }
    ]
  }
}
```

#### Governance Audit Hook (governance-audit.json)

For compliance logging:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      {
        "type": "command",
        "bash": "echo \"[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Session started\" >> .github/hooks/logs/audit.log",
        "cwd": ".",
        "timeoutSec": 5
      }
    ],
    "sessionEnd": [
      {
        "type": "command",
        "bash": "echo \"[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Session ended\" >> .github/hooks/logs/audit.log",
        "cwd": ".",
        "timeoutSec": 5
      }
    ]
  }
}
```

### Step 4: Validate

- All hook files are valid JSON with `"version": 1`
- All commands are tested and available in the project
- Timeouts are reasonable for the project size
- `preToolUse` hooks are fast (< 10s) to avoid blocking the agent
- `postToolUse` hooks are idempotent (safe to run multiple times)

## Output

```
📎 Hooks Generated:
├── .github/hooks/
│   ├── auto-format.json      ← postToolUse: [formatter command]
│   ├── lint-check.json        ← agentStop: [linter command]
│   ├── compile-check.json     ← agentStop: [compile command]
│   └── (optional enterprise hooks)
```

## Best Practices

- **Keep hooks fast** — they run synchronously and block the agent
- **Use non-zero exit codes** to block bad actions (especially in `preToolUse`)
- **Provide both `bash` and `powershell`** for cross-platform teams
- **Layer hooks** — use separate files for independent concerns
- **Test manually first** — run hook commands by hand before relying on automation
