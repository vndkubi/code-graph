---
name: technical-debt-analysis
description: 'Analyze codebase for technical debt including code smells, outdated dependencies, missing tests, architecture violations, and security vulnerabilities. Produces prioritized tech debt backlog with effort estimates and business impact. Use when assessing code quality, planning tech debt sprints, or justifying refactoring work.'
---

# Technical Debt Analysis

Analyze codebase for technical debt and produce a prioritized remediation backlog.

## When to Use

- Tech debt assessment for sprint planning or roadmap discussions
- Code quality review before a major feature
- Justifying refactoring work to stakeholders
- Audit before migrating, upgrading frameworks, or scaling
- Keywords: "tech debt", "code quality", "code smells", "refactoring backlog", "technical debt", "health check"

## Workflow

### Step 1: Scan the Codebase

Analyze the following dimensions:

#### Code Smells
- Long methods (>50 lines)
- Large classes (>500 lines)
- Deep nesting (>3 levels)
- Duplicate code blocks
- God objects / God services
- Magic numbers / hardcoded values
- Dead code (unused methods, imports, variables)
- Complex conditionals (cyclomatic complexity >10)

#### Architecture Violations
- Circular dependencies between modules
- Layer violations (controller accessing repository directly)
- Duplicate validation across layers
- Business logic in controllers/resources
- Infrastructure code in domain layer
- Missing abstractions (hardcoded external service calls)

#### Testing Gaps
- Classes with 0% test coverage
- Tests that don't assert anything
- Missing edge case and error path tests
- Flaky tests (time-dependent, order-dependent)
- Integration tests posing as unit tests (slow, I/O-bound)

#### Dependency Health
- Outdated dependencies (major versions behind)
- Dependencies with known CVEs
- Abandoned/unmaintained libraries
- Unnecessary dependencies (used for 1 function)

#### Documentation Debt
- Missing API documentation
- Outdated README
- Missing architecture decision records
- Undocumented environment setup

#### Security Debt
- Hardcoded credentials or API keys
- Missing input validation
- SQL injection risks (raw queries)
- Missing rate limiting
- Overly permissive CORS
- Missing authentication on endpoints

### Step 2: Categorize & Prioritize

Use a 4-quadrant model:

```
                    HIGH IMPACT
                        │
    ┌───────────────────┼───────────────────┐
    │                   │                   │
    │   Quick Wins      │   Strategic       │
    │   (Do Now)        │   (Plan Next)     │
    │                   │                   │
LOW ├───────────────────┼───────────────────┤ HIGH
EFFORT│                   │                   │ EFFORT
    │   Deprioritize    │   Avoid           │
    │   (Backlog)       │   (Unless Critical)│
    │                   │                   │
    └───────────────────┼───────────────────┘
                        │
                    LOW IMPACT
```

### Step 3: Generate Tech Debt Report

```markdown
## Technical Debt Report

**Repository**: [name]
**Date**: [date]
**Analyzed by**: @code-reviewer

### Executive Summary
- **Overall Health Score**: [X/10]
- **Critical Issues**: [count]
- **Total Debt Items**: [count]
- **Estimated Remediation**: [X] sprint(s)

### 🔴 Critical (Address This Sprint)

| # | Issue | Location | Impact | Effort | Type |
|---|-------|----------|--------|--------|------|
| 1 | Security: hardcoded API key | config.java:45 | High | S | Security |
| 2 | N+1 query in order listing | OrderService:89 | High | M | Performance |

### 🟡 High (Plan Next 2 Sprints)

| # | Issue | Location | Impact | Effort | Type |
|---|-------|----------|--------|--------|------|
| 3 | OrderService is 800 lines | OrderService.java | Medium | L | Code Smell |
| 4 | No tests for PaymentService | — | Medium | M | Testing |

### 🟢 Medium (Backlog)

| # | Issue | Location | Impact | Effort | Type |
|---|-------|----------|--------|--------|------|
| 5 | Outdated Spring Boot (2.x) | pom.xml | Medium | XL | Dependency |

### 📊 Metrics

| Metric | Current | Target | Gap |
|--------|---------|--------|-----|
| Test coverage | 45% | 80% | 35% |
| Avg method length | 35 lines | <20 lines | 15 |
| Cyclomatic complexity | 15 avg | <10 avg | 5 |
| Dependency freshness | 60% | 90% | 30% |
| Security vulnerabilities | 3 | 0 | 3 |

### Recommended Remediation Plan

#### Sprint N (Quick Wins)
- [ ] Fix security issues (items 1, 2)
- [ ] Add missing input validation

#### Sprint N+1 (Strategic)
- [ ] Refactor OrderService into smaller services
- [ ] Add unit tests for critical paths

#### Sprint N+2 (Deferred)
- [ ] Upgrade framework version
- [ ] Address remaining code smells
```

## Output

A structured markdown report that can be shared with:
- **Developers**: for sprint planning
- **Tech leads**: for prioritization
- **Stakeholders**: for understanding technical risk vs business value
