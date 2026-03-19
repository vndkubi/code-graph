---
description: 'Cross-module dependency rules for enterprise multi-module projects. API boundary conventions, shared types, circular dependency prevention.'
applyTo: '**/pom.xml, **/build.gradle*, **/settings.gradle*, **/*.csproj, **/pyproject.toml, **/composer.json'
---

# Module Boundary Conventions

## Cross-Module Dependency Rules

- **API modules** (`*-api`) expose interfaces and DTOs only — no implementation classes
- **Core modules** (`*-core`, `*-impl`) contain business logic — depend on API modules, not other core modules
- **Shared modules** (`shared-*`, `common-*`) contain cross-cutting utilities — NO business logic
- A module must NEVER import internal/implementation classes from another module
- Cross-module communication goes through **API interfaces only**

## Dependency Direction

```
presentation-layer → service-layer → persistence-layer → domain
     ↓                    ↓                  ↓
  depends on          depends on         depends on
  service-api         domain             shared-types
```

- Dependencies flow **inward** (outer layers depend on inner layers)
- Inner layers must NOT depend on outer layers
- If bidirectional communication is needed, use **events** or **callback interfaces**

## Circular Dependency Prevention

- If module A depends on module B, module B must NOT depend on module A
- Break cycles by extracting a shared API module or using event-driven patterns
- Use dependency analysis tools: `mvn dependency:tree`, `gradle dependencies`

## Shared Types Rules

- Shared DTOs, exceptions, and utilities go in a dedicated shared module
- Shared module must have **zero business logic** — only data structures and utilities
- Version shared modules independently if consumed by external teams

## Multi-Module Build

- Parent POM/build file defines common dependency versions (BOM)
- Each module declares only the dependencies it directly uses
- Use dependency management (not dependency) in parent for version control
- Profile-specific modules: exclude test-only modules from production builds
