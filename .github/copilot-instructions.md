# Copilot Bootstrap Toolkit

Bootstrap Toolkit — analyzes codebases and generates complete GitHub Copilot configurations (agents, skills, instructions, hooks, agentic workflows).

## Tech Stack

Java/Jakarta EE | .NET/C# | Python | PHP | Android/Kotlin | iOS/Swift | TypeScript/React

## Architecture

Conductor agent orchestrates a pipeline: `Analyze → Generate Instructions → Generate Agents → Generate Skills → Generate Hooks → Validate → Cleanup`

## Golden Rules

1. **Read code flow first** — trace Controller → Service → Repository → DB before changing anything
2. **No duplicate validation** — each layer validates only what it owns (REST: format, Service: business, DB: integrity)
3. **Match existing patterns** — follow the codebase conventions, don't introduce new patterns
4. **Explain decisions** — state WHY before each significant change, provide structured summary after
5. **Ask when unclear** — ask 3-5 targeted questions, provide defaults, skip obvious ones

For full detail on all 7 principles, see the `core-principles` skill.

## Available Agents

### Core Development

| Agent | Purpose |
|-------|---------|
| `@dev-orchestrator` | **Start here** — auto-routes to correct sub-agent based on intent |
| `@conductor` | Orchestrates the full bootstrap pipeline |
| `@codebase-analyzer` | Deep codebase analysis, domain mapping, tech stack detection |
| `@investigator` | PBI investigation, as-is/to-be analysis, impact assessment |
| `@implementor` | Java/Jakarta EE implementation |
| `@dotnet-implementor` | .NET/C# implementation (ASP.NET Core, EF Core) |
| `@python-implementor` | Python implementation (Django/FastAPI) |
| `@php-implementor` | PHP implementation (Laravel/Symfony) |
| `@frontend-implementor` | TypeScript/React/Vue/Angular implementation |
| `@test-specialist` | Unit tests with 100% branch coverage target |
| `@code-reviewer` | Code review orchestrator (multi-stage pipeline) |
| `@functional-reviewer` | Business logic review, AC traceability, data integrity |
| `@technical-reviewer` | Architecture, migration safety, domain boundaries, NFRs |

### Bootstrap & Analysis

| Agent | Purpose |
|-------|---------|
| `@agent-generator` | Meta-agent: generates Copilot agents, skills, instructions from codebase analysis |
| `@business-analyst` | Requirements analysis, PBI writing, acceptance criteria |

### Specialized

| Agent | Purpose |
|-------|---------|
| `@sequence-diagrammer` | Mermaid sequence diagrams |
| `@spec-reviewer` | Spec review with Security + Testability lenses |
| `@mock-data-specialist` | WireMock stubs, test fixtures |
| `@sprint-planner` | Sprint planning, PBI decomposition, estimation |
| `@refactoring-specialist` | Code smell detection, safe refactoring |
| `@pr-manager` | PR descriptions, merge strategy |
| `@dependency-analyzer` | Cross-module impact analysis, dependency graphs |
| `@database-specialist` | Schema review, migration strategy, query optimization |
| `@devcontainer-reviewer` | DevContainer optimization and generation |

### Mobile

| Agent | Purpose |
|-------|---------|
| `@mobile-implementor` | Android (Kotlin/Compose) and iOS (Swift/SwiftUI) |
| `@mobile-test-specialist` | Mobile unit and UI tests |
| `@mobile-architect` | Mobile architecture review |

## Common Workflows

- **Implement a feature**: `@dev-orchestrator Implement [description]`
- **Investigate a PBI**: `@investigator Investigate [description]`
- **Review a spec**: `@spec-reviewer Review spec at docs/requirements/[name].md`
- **Write tests**: `@test-specialist Write tests for [class]`
- **Code review**: `@code-reviewer Review changes in [branch]` (runs Functional → Technical pipeline)
- **Sprint planning**: `@sprint-planner Break down PBI-123`

## Prompts

| Prompt | Purpose |
|--------|---------|
| `/bootstrap-copilot` | Full bootstrap pipeline for a new project |
| `/analyze-project` | Deep codebase analysis report |
| `/learn-codebase` | Interactive business domain onboarding |
| `/implement-feature` | End-to-end feature implementation |

## Domain Context

See domain-scoped `.instructions.md` files for per-domain business rules, entity relationships, and glossary. For enterprise projects (5+ domains), each domain has its own instruction file that auto-loads when editing files in that domain.
