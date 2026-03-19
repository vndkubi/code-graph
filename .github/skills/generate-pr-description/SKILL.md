---
name: generate-pr-description
description: 'Generate comprehensive pull request descriptions by analyzing git diff, commit history, and related issues. Creates structured PR descriptions with summary, changes, testing notes, and review checklist. Use when creating or improving PR descriptions.'
---

# Generate PR Description

Generate structured PR descriptions from code changes.

## When to Use

- Creating a new pull request
- Improving an existing PR description
- Summarizing changes for code review
- Keywords: "PR description", "pull request", "PR summary", "create PR"

## Workflow

### Step 1: Gather Context
1. Run `git log --oneline main..HEAD` (or target branch) to see commits
2. Run `git diff main..HEAD --stat` for file change summary
3. Run `git diff main..HEAD` for detailed changes
4. Search for related issue/PBI numbers in commit messages

### Step 2: Analyze Changes
- Categorize changes: features, fixes, refactoring, tests, docs
- Identify the primary purpose of the PR
- List affected modules/domains
- Identify breaking changes
- Check for database migrations

### Step 3: Generate PR Description

```markdown
## Summary

[1-2 sentence description of what this PR does and why]

Closes #[issue-number]

## Changes

### [Category 1: e.g., Feature Implementation]
- [Change 1 with brief explanation]
- [Change 2 with brief explanation]

### [Category 2: e.g., Database Changes]
- [Migration description]

### [Category 3: e.g., Tests]
- [New tests added]
- [X] tests covering [Y] scenarios

## Screenshots / API Examples

<!-- For UI changes, include screenshots -->
<!-- For API changes, include request/response examples -->

```bash
# Example API call
curl -X POST /api/v1/orders \
  -H "Content-Type: application/json" \
  -d '{"customer_id": 1, "items": [...]}'
```

## Testing

### How to Test
1. [Step-by-step testing instructions]
2. [Include test data or setup needed]

### Test Coverage
- [X] Unit tests: [count] tests, [coverage]% branch coverage
- [X] Integration tests: [count] scenarios
- [ ] Manual testing: [describe what to test manually]

## Impact Analysis

### Affected Areas
- [Module/Service A] — [how it's affected]
- [Module/Service B] — [how it's affected]

### Breaking Changes
- [ ] No breaking changes
- [ ] Breaking: [describe what breaks and migration path]

### Database Changes
- [ ] No database changes
- [ ] Migration: [describe migration and rollback plan]

### Configuration Changes
- [ ] No config changes  
- [ ] New env vars: `[VAR_NAME]` — [description]

## Review Checklist

- [ ] Code follows project coding standards
- [ ] No duplicate validation across layers
- [ ] All public methods have documentation
- [ ] Error handling covers edge cases
- [ ] No hardcoded values (URLs, credentials, magic numbers)
- [ ] Database queries are optimized (no N+1, proper indexes)
- [ ] Security: input validation, authorization checks
- [ ] Tests pass locally
- [ ] No TODOs left unresolved (or they have issue references)
```

## Rules

- Keep the summary concise — reviewers should understand the PR in 10 seconds
- Be specific about testing steps — another developer should be able to verify
- Always include impact analysis for medium/large PRs
- Reference the issue/PBI that this PR addresses
- If it's a draft PR, explain what's pending
