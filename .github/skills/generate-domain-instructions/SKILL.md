---
name: generate-domain-instructions
description: 'Generate domain-scoped .instructions.md files from codebase analysis results. Creates one instruction file per business domain with business rules, entity relationships, patterns, and glossary. Each file is ≤ 4KB with narrow applyTo patterns for efficient context loading.'
---

# Generate Domain Instructions

Auto-generate per-domain `.instructions.md` files from the codebase analysis report.

## When to Use

- After `@codebase-analyzer` produces a domain map
- For enterprise projects with 5+ business domains
- For multi-module projects with 3+ modules that form distinct groups
- For framework/library projects where modules have different conventions
- During bootstrap pipeline Phase 5
- Keywords: "generate domain instructions", "per-domain rules", "module group instructions"

## Prerequisites

- Codebase analysis report with domain map
- Domain registry (from `domain-registry` skill) — optional but recommended

## Workflow

### Step 1: Identify Domains from Analysis

From the analysis report, extract:
- Domain names and their package paths
- Entity lists per domain
- Key service classes per domain
- Cross-domain dependencies

### Step 2: Extract Per-Domain Content

For each domain, scan code to extract:

1. **Business Rules** — Read service classes, validators:
   - Explicit validations (field constraints, business checks)
   - Business calculations (pricing, discounts, fees)
   - State transition rules (entity lifecycle)
   - Authorization rules (who can do what)

2. **Entity Relationships** — Read entity/model classes:
   - One-to-many, many-to-many relationships
   - Key fields and their business meaning
   - Foreign key targets (cross-domain references)

3. **Domain Patterns** — Read implementation patterns:
   - How services are structured in this domain
   - Custom exceptions specific to this domain
   - Event publishing/consumption patterns

4. **Glossary** — Extract terminology:
   - Scan class names, enums, constants, JavaDoc
   - Identify domain-specific abbreviations

### Step 3: Generate Instruction Files

**For application projects**: `.github/instructions/[stack]-[domain]-domain.instructions.md`
**For framework/library projects**: `.github/instructions/[module-group]-domain.instructions.md`

For each domain or module group, write the instruction file:

Template:
```markdown
---
description: '[Domain] domain business rules, entity relationships, and patterns for [Stack]'
applyTo: '**/[domain-path]/**/*.[ext]'
---

# [Domain] Domain Conventions

## Business Rules
1. [rule] — enforced at [layer]
2. [rule] — enforced at [layer]

## Entity Relationships
- [EntityA] (1) ──── (N) [EntityB]: [business meaning]

## Key State Transitions
[Entity]: STATE_A → STATE_B (trigger: [condition])

## Domain Patterns
- [pattern specific to this domain]

## Glossary
| Term | Meaning |
|------|---------|
| [term] | [definition] |
```

### Step 4: Validate

- [ ] Each file ≤ 4 KB
- [ ] `applyTo` covers only that domain's paths
- [ ] No rules duplicated across domain files
- [ ] No rules duplicated between domain files and language instruction files
- [ ] Cross-domain dependencies noted where relevant
