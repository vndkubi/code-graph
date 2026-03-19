---
name: review-spec
description: 'Review specifications (PRDs, User Stories, API contracts, DB schemas) for completeness, security gaps, testability, ambiguity, and NFR coverage. Applies Security Assessment and QA Testability lenses. Produces severity-rated review report. Use when asked to review a spec, check requirements quality, or validate spec before development.'
---

# Review Spec — Security + Testability Analysis

Review specifications through two critical lenses before they reach development. Catch expensive problems at the cheapest point to fix them.

## When to Use

- Before development starts on a new feature
- After `@business-analyst` generates a spec
- When reviewing external vendor specifications
- When updating existing specs (review changed sections)
- Keywords: "review spec", "check requirements", "validate spec", "spec quality", "is this spec ready"

## Prerequisites

- A spec document (PRD, User Story, API contract, DB schema, or technical design)
- Optionally: project domain context from `.github/instructions/` or `domain-registry.json`
- Optionally: standardized templates from `.github/templates/` for completeness comparison

## Workflow

### Step 1: Parse the Spec

Read the spec and extract structured data:

1. **Entities**: All business objects mentioned (Order, Payment, User, etc.)
2. **APIs**: All endpoints with methods, paths, request/response
3. **Data flows**: How data moves between components
4. **User actions**: What users can do
5. **Business rules**: Validation, calculations, state transitions
6. **Status fields**: Any entity with lifecycle states
7. **External dependencies**: Third-party services, APIs, databases

### Step 2: Apply Security Lens

For each extracted element, run security checks:

**API Endpoints:**
- [ ] Auth method specified (JWT, OAuth2, API key)?
- [ ] Authorization rules per endpoint (who can access)?
- [ ] Rate limits defined?
- [ ] Input validation constraints for all fields?
- [ ] Error response format (no stack traces, no sensitive data)?

**Data Flows:**
- [ ] PII identified and protection specified?
- [ ] Data at rest encryption requirements?
- [ ] Data in transit encryption (TLS)?
- [ ] Audit logging for sensitive operations?

**Business Logic:**
- [ ] State transition guards (can't skip states)?
- [ ] Idempotency for mutating operations?
- [ ] Race condition handling (concurrent updates)?
- [ ] Financial precision (decimal, not float)?

**Domain-Specific (auto-detect from domain context):**

| Domain | Auto-Check |
|--------|-----------|
| Finance | PCI DSS, SOX audit trail, transaction atomicity, decimal precision |
| Healthcare | HIPAA, PHI encryption, consent, access logging |
| E-commerce | Payment security, inventory consistency, cart expiration |
| Logistics | Geolocation security, real-time SLA, offline sync |
| Multi-tenant SaaS | Tenant isolation, data segregation, per-tenant limits |

### Step 3: Apply Testability Lens

For each acceptance criterion and business rule:

**Clarity:**
- [ ] Is it in Given/When/Then format (or equally precise)?
- [ ] Are success conditions measurable (specific values)?
- [ ] Are error scenarios explicit (which error code, which message)?
- [ ] Are boundary values defined (min, max, empty)?

**Edge Cases — check each is addressed:**
- [ ] Empty/null inputs
- [ ] Boundary values (at exact limits)
- [ ] Concurrent access (two users, same resource)
- [ ] Partial failure (external service down mid-flow)
- [ ] Duplicate submission (user double-clicks)
- [ ] Large data sets (pagination at scale)
- [ ] Timezone/locale handling
- [ ] Unicode/special characters

**Test Prerequisites:**
- [ ] Test data requirements specified?
- [ ] Prerequisite entity states defined?
- [ ] External service mock requirements clear?

### Step 4: Completeness Check

Compare spec against template structure (`.github/templates/PRD-template.md`):

| Section | Required For |
|---------|-------------|
| Problem statement | All specs |
| User personas | PRD |
| User stories + ACs | PRD, User Stories |
| Functional requirements | PRD |
| Non-functional requirements | PRD, API Contract |
| API contract (OpenAPI) | API features |
| DB schema (DBML) | Data model features |
| State diagram | Entities with status/lifecycle |
| Error handling | API features |
| Out of scope | All specs |
| Risk assessment | Complex features |
| Dependencies | Multi-system features |

Flag missing sections as findings.

### Step 5: Generate Review Report

Produce the report following the output format defined in `@spec-reviewer` agent.

**Severity classification:**
- **🔴 Critical**: Will cause bugs, security vulnerabilities, or ambiguous implementation
- **🟡 Warning**: May cause rework, inconsistency, or missed edge cases
- **🔵 Suggestion**: Would improve spec quality but not blocking

**Quality scoring:**
Rate each dimension 1-5:
- **Completeness**: Are all required sections present and filled?
- **Security Coverage**: Are auth, input validation, rate limiting, data protection addressed?
- **Testability**: Can automated tests be written from the ACs as-is?
- **Clarity**: Is there zero ambiguity? Would two developers implement it the same way?

### Step 6: Save Review Report

**Save to**: `docs/reviews/[spec-name]-review.md`

## Integration with Other Skills

| After Review | Invoke |
|-------------|--------|
| Missing state diagram | `generate-state-diagram` skill |
| Missing API contract | Reference `.github/templates/API-contract-template.md` |
| Missing DB schema | Reference `.github/templates/DB-schema-template.md` |
| Missing NFRs | `extract-nfrs` skill (if available) or flag as finding |
| Spec needs update | `update-spec` skill for incremental patching |

## Validation

- [ ] Every finding has a concrete recommendation (not just "fix this")
- [ ] Security lens covered: auth, rate-limiting, input validation, data exposure
- [ ] Testability lens covered: clarity, edge cases, measurability
- [ ] Completeness compared against template structure
- [ ] Domain-specific NFRs checked
- [ ] Quality score assigned (1-5 per dimension)
- [ ] Report saved as markdown file
