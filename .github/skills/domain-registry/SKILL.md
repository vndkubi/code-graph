---
name: domain-registry
description: 'Auto-detect and register business domains from source code analysis. Scans package/module structure, entities, services, and cross-domain dependencies to generate domain-registry.json and domain-scoped .instructions.md files. Use for projects with 5+ business domains or 10+ modules.'
---

# Domain Registry — Auto-Detection from Source Code

Automatically scan the codebase to detect, map, and register business domains. **The agent reads the source code directly** — no manual input needed.

## When to Use

- Enterprise project with 5+ business domains or 10+ modules
- During bootstrap pipeline Phase 9 (Generate Domain-Scoped Instructions)
- Keywords: "domain registry", "domain map", "domain instructions"

## Workflow

### Step 1: Auto-Detect Domains from Source Code

Scan the codebase using these detection strategies (by tech stack):

**Java/Jakarta EE/Spring Boot** — Scan `pom.xml` modules + package structure:
```
1. Parse root pom.xml → <modules> list (e.g., order-api, order-core, payment-service)
2. Group modules by domain prefix (order-*, payment-*, customer-*)
3. Scan each module's src/main/java for:
   - @Entity classes → domain entities
   - @Service / @ApplicationScoped classes → domain services
   - @Path / @RestController classes → domain APIs
   - Cross-module imports → domain dependencies
```

**.NET** — Scan `*.sln` + `*.csproj` project references:
```
1. Parse .sln → list of projects
2. Group by namespace prefix (Company.Orders, Company.Payments)
3. Scan for DbContext entities, Controllers, Services
```

**Python** — Scan Django `apps/` or FastAPI package structure:
```
1. Find Django: INSTALLED_APPS in settings.py
2. Find FastAPI: router include patterns in main.py
3. Group by app/package directory
4. Scan for models.py, services.py, views.py per app
```

**TypeScript/React** — Scan `src/` directory structure:
```
1. Find feature/domain directories under src/
2. Scan for types, hooks, services, components per domain
3. Map shared vs domain-specific modules
```

### Step 2: Build Domain Map

For each detected domain, extract automatically:

| Field | How to Detect |
|-------|---------------|
| `name` | Module/package prefix (e.g., `order` from `order-api`, `order-core`) |
| `description` | From README, JavaDoc, class-level comments in main service class |
| `packages` | Package paths containing domain entities/services |
| `modules` | Build system modules belonging to this domain |
| `entities` | Classes annotated with `@Entity`, `models.Model`, or in `models/` directory |
| `services` | Classes annotated with `@Service`, `@ApplicationScoped`, or in `services/` directory |
| `dependsOn` | Detected from import statements of other domain's classes |
| `complexity` | `low` (≤3 entities), `medium` (4-8), `high` (9+) |

### Step 3: Detect Cross-Domain Dependencies

Scan import statements to map inter-domain calls:

```
For each domain A:
  For each source file in domain A:
    Find imports from other domains (B, C, ...)
    Classify:
      - Direct class import → "sync-api" dependency
      - Event class import → "event" dependency
      - Shared DTO import → "shared-contract" dependency
```

### Step 4: Generate domain-registry.json

Write `.github/domains/domain-registry.json`:

```json
{
  "generatedAt": "2025-01-15T10:30:00Z",
  "generatedBy": "domain-registry skill (auto-detected)",
  "projectSize": "enterprise",
  "totalModules": 45,
  "totalDomains": 8,
  "domains": [
    {
      "name": "order",
      "description": "Order lifecycle management and pricing",
      "packages": ["com.company.order"],
      "modules": ["order-api", "order-core", "order-persistence"],
      "entities": ["Order", "OrderItem", "Discount"],
      "services": ["OrderService", "PricingService", "OrderValidator"],
      "instructionFile": "java-order-domain.instructions.md",
      "dependsOn": ["customer", "payment", "inventory"],
      "entityCount": 5,
      "serviceCount": 4,
      "complexity": "high"
    }
  ],
  "crossDomainDependencies": [
    {"from": "order", "to": "payment", "type": "sync-api", "via": "PaymentService.processPayment()"},
    {"from": "order", "to": "inventory", "type": "event", "via": "OrderCreatedEvent"}
  ]
}
```

### Step 5: Generate Domain-Scoped Instructions

For each domain in the registry, use `generate-domain-instructions` skill to create `.instructions.md` files.

Each file is auto-populated from the source code:
- **Business rules** → extracted from service validations, @PreAuthorize, if/throw patterns
- **Entity relationships** → from @ManyToOne, ForeignKey, relationship() annotations
- **Domain patterns** → from service class structure, event handlers
- **Glossary** → from class names, enum values, constants, JavaDoc

### Step 6: Update copilot-instructions.md

Append domain index to `copilot-instructions.md`:

```markdown
## Domain Map
| Domain | Modules | Entities | Instruction File |
|--------|---------|----------|-----------------|
| order | order-api, order-core | 5 | java-order-domain.instructions.md |
| payment | payment-api, payment-gateway | 3 | java-payment-domain.instructions.md |
```

## Validation

- [ ] All domains auto-detected (compare with actual module list)
- [ ] Entity counts match actual entity classes
- [ ] Cross-domain dependencies match actual import patterns
- [ ] Each domain instruction file ≤ 4 KB
- [ ] `applyTo` patterns are narrow (domain-specific paths only)
- [ ] No business rules duplicated across domain files
- [ ] `domain-registry.json` is valid JSON and matches codebase
