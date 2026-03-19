---
name: conventional-commit
description: 'Generate conventional commit messages by analyzing staged git changes and applying the Conventional Commits specification. Supports scopes, breaking changes, and multi-line bodies. Use when committing changes or writing commit messages.'
---

# Conventional Commit

Generate conventional commit messages from staged changes.

## When to Use

- After implementing changes, before committing
- When writing commit messages following team conventions
- Keywords: "commit", "commit message", "conventional commit", "git commit"

## Workflow

1. Run `git status` to review changed files
2. Run `git diff --cached` to inspect staged changes (or `git diff` for unstaged)
3. Analyze the changes to determine:
   - **Type**: What kind of change is this?
   - **Scope**: Which module/component is affected?
   - **Description**: What was changed?
   - **Body**: Why was it changed? (for non-obvious changes)
   - **Breaking**: Does it break backward compatibility?
4. Construct the commit message
5. Execute the commit

## Commit Message Format

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

### Types

| Type | When to Use |
|------|------------|
| `feat` | New feature for the user |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Formatting, missing semicolons (no logic change) |
| `refactor` | Code restructuring (no feature/fix) |
| `perf` | Performance improvement |
| `test` | Adding or updating tests |
| `build` | Build system, dependencies |
| `ci` | CI/CD pipeline changes |
| `chore` | Maintenance tasks |
| `revert` | Reverting a previous commit |

### Scope Examples

- `(api)`, `(auth)`, `(orders)`, `(db)`, `(ui)`, `(config)`
- Use the module or feature area affected

### Examples

```
feat(orders): add discount calculation for VIP customers

fix(auth): prevent token expiration race condition on concurrent requests

refactor(services): extract payment processing into dedicated service

BREAKING CHANGE: OrderService.create() now requires a customerId parameter

test(orders): add integration tests for bulk order creation

docs(api): update OpenAPI spec for v2 endpoints

perf(db): add composite index on orders(customer_id, status)

chore(deps): upgrade Spring Boot to 3.2.1
```

### Multi-file Changes

When multiple files are changed:
- Identify the primary purpose of the change
- Use the most relevant scope
- Add body text listing secondary changes if needed

```
feat(orders): implement order cancellation workflow

- Add OrderCancellationService with refund calculation
- Create CancellationReason enum
- Add cancellation endpoint to OrderResource
- Update OrderStatus with CANCELLED state
- Add database migration for cancellation_reason column
```

## Rules

- Description: imperative mood, lowercase, no period at end, max 72 chars
- Body: explain WHAT and WHY, not HOW (the code shows how)
- One logical change per commit — don't mix features with refactoring
- Reference issue/ticket numbers in footer: `Refs: #123` or `Closes: #456`
