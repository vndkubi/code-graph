---
name: generate-adr
description: 'Generate Architecture Decision Records (ADRs) for significant technical decisions. Creates structured markdown documents capturing context, decision, alternatives considered, consequences, and status. Use when making architecture choices, selecting technologies, changing patterns, or documenting why a specific approach was chosen. Keywords: ADR, architecture decision, design decision, technical decision, why we chose.'
---

# Generate Architecture Decision Record

Create structured ADRs to document significant technical decisions.

## When to Use

- Choosing a technology, framework, or library
- Changing architecture patterns (e.g., monolith → microservices)
- Selecting communication patterns (sync vs async, REST vs gRPC)
- Deciding on database schema design trade-offs
- Choosing between competing approaches for a feature
- Keywords: "ADR", "architecture decision", "why did we", "design decision"

## ADR Template

```markdown
# ADR-{number}: {Title}

## Status
{Proposed | Accepted | Deprecated | Superseded by ADR-XXX}

## Date
{YYYY-MM-DD}

## Context
What is the issue that we're seeing that is motivating this decision or change?
Include technical and business context. Describe the forces at play.

## Decision
What is the change that we're proposing and/or doing?
State the decision clearly and concisely.

## Alternatives Considered

### Alternative 1: {Name}
- **Pros**: ...
- **Cons**: ...
- **Why rejected**: ...

### Alternative 2: {Name}
- **Pros**: ...
- **Cons**: ...
- **Why rejected**: ...

## Consequences

### Positive
- [benefit 1]
- [benefit 2]

### Negative
- [trade-off 1]
- [trade-off 2]

### Risks
- [risk 1 with mitigation]

## References
- [link to relevant documentation]
- [link to related ADRs]
```

## Workflow

### Step 1: Understand the Decision
- What problem are we solving?
- What constraints exist? (performance, cost, team expertise, timeline)
- Who are the stakeholders?

### Step 2: Research Alternatives
- Search the codebase for existing patterns and precedents
- Identify at least 2-3 viable alternatives
- Evaluate each against the constraints

### Step 3: Analyze Trade-offs
- Compare alternatives on: complexity, performance, maintainability, cost, team familiarity
- Consider long-term implications and migration paths
- Assess reversibility of the decision

### Step 4: Write the ADR
- Use the template above
- Be specific and factual — avoid vague justifications
- Include concrete evidence (benchmarks, metrics, PoC results)
- Reference related ADRs if they exist

### Step 5: File Placement
- Save as `docs/adr/ADR-{number}-{kebab-case-title}.md`
- Number sequentially: ADR-001, ADR-002, etc.
- Update `docs/adr/README.md` index if it exists

## Validation
- ADR has all required sections filled
- At least 2 alternatives were considered
- Consequences (both positive and negative) are documented
- Decision is stated clearly and unambiguously
- Context provides enough information for future readers
