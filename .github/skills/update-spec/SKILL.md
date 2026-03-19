---
name: update-spec
description: 'Incrementally update existing specification documents when Change Requests arrive. Reads the CR and existing spec, performs impact analysis on spec sections, generates a Spec Delta (targeted patches), and applies changes to the existing file without rewriting it. Preserves spec structure, version history, and unchanged sections. Use when updating specs after a CR, adding new requirements to existing specs, or patching specs based on review feedback.'
---

# Update Spec — Incremental Spec Patching

Update existing specification documents incrementally instead of rewriting them. Preserves structure, history, and unchanged content.

## When to Use

- A Change Request (CR) requires updates to an existing spec
- `@spec-reviewer` found issues that need fixing in the spec
- New requirements need to be added to an existing PRD
- Scope change requires updating acceptance criteria
- Keywords: "update spec", "change request", "modify requirements", "patch spec", "add requirement", "spec delta"

## Workflow

### Step 1: Read the Change Request

Parse the CR / update request to extract:
- **What changed**: New requirement, modified requirement, removed requirement
- **Why**: Business justification for the change
- **Scope**: Which parts of the spec are affected

### Step 2: Read the Existing Spec

Read the full existing spec file and build a section map:

```
Section Map:
├── Document Info (line 1-10)
├── Executive Summary (line 12-16)
├── Problem Statement (line 18-30)
├── User Personas (line 32-40)
├── User Stories
│   ├── US-1: Create Order (line 42-58)
│   ├── US-2: Submit Order (line 60-75)
│   └── US-3: Approve Order (line 77-92)
├── Functional Requirements (line 94-110)
├── Non-Functional Requirements (line 112-125)
├── API Contract (line 127-200)
├── DB Schema (line 202-250)
├── Risks (line 252-265)
└── Changelog (line 267-275)
```

### Step 3: Impact Analysis on Spec Sections

For each CR item, determine which spec sections are affected:

```markdown
### Spec Impact Analysis

| CR Item | Affected Sections | Impact Type | Action |
|---------|------------------|-------------|--------|
| Add partial shipment | US-3, FR-4, API Contract, DB Schema, State Diagram | 🔴 Major | Add new user story US-4, modify FR-4, add API endpoint, add DB column, update state diagram |
| Change approval to 2-level | US-2, FR-3, API Contract | 🟡 Moderate | Modify US-2 ACs, update approval API |
| Fix typo in description | Executive Summary | 🟢 Minor | Text correction |
```

**Impact classification:**
- **🔴 Major**: New entities, new APIs, new states, cross-cutting changes
- **🟡 Moderate**: Modified ACs, updated business rules, adjusted constraints
- **🟢 Minor**: Text corrections, clarifications, formatting

### Step 4: Generate Spec Delta

Create a targeted change plan — NOT a full rewrite:

```markdown
### Spec Delta

#### MODIFY: User Story US-2 (line 60-75)
**Current:**
> AC-3: Given order is submitted, When manager approves, Then status changes to APPROVED

**New:**
> AC-3: Given order is submitted, When first-level manager approves, Then status changes to PENDING_FINAL_APPROVAL
> AC-3a: Given order is in PENDING_FINAL_APPROVAL, When director approves, Then status changes to APPROVED

**Rationale:** CR requires 2-level approval for orders > $10,000

---

#### ADD: User Story US-4 (after US-3, line 93)
**Content:**
> ### US-4: Partial Shipment
> **As a** warehouse operator
> **I want** to ship part of an order
> **So that** available items reach the customer without waiting for full stock
>
> **Acceptance Criteria:**
> - [ ] AC-1: Given an approved order with multiple items, When some items are available, Then operator can create a partial shipment
> - [ ] AC-2: Given a partial shipment is created, Then order status changes to PARTIALLY_SHIPPED

---

#### MODIFY: API Contract — Add endpoint (line 180)
**Add after** `PUT /orders/{id}`:
```yaml
  /orders/{id}/shipments:
    post:
      summary: Create partial shipment
      ...
```

---

#### MODIFY: DB Schema — Add column (line 220)
**Add to** orders table:
| `shipped_quantity` | INTEGER | YES | 0 | Quantity shipped so far |

---

#### ADD: Changelog entry (end of file)
| 1.1 | [date] | [author] | CR-123: Added partial shipment, 2-level approval |
```

### Step 5: Apply Delta to Spec File

Apply each delta operation to the existing file:

**Rules for patching:**
1. **ADD sections**: Insert at the correct location, maintaining document flow
2. **MODIFY sections**: Replace only the affected content, keep surrounding context
3. **REMOVE sections**: Delete content, add `[Removed in v1.1 — see changelog]` note if needed
4. **NEVER** rewrite unchanged sections
5. **ALWAYS** update the Changelog section at the end
6. **ALWAYS** increment the version number in Document Info

**Version tracking in Changelog:**

```markdown
## Changelog

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.1 | [date] | [author] | CR-123: Added partial shipment support (US-4), changed to 2-level approval (US-2 modified) |
| 1.0 | [date] | [author] | Initial draft |
```

### Step 6: Verify Integrity

After patching, verify the spec is still coherent:

- [ ] Section numbering is consistent (no gaps, no duplicates)
- [ ] Cross-references are valid (FR referencing correct US)
- [ ] New ACs don't contradict existing ACs
- [ ] State diagram (if present) includes new states
- [ ] API contract is consistent with user stories
- [ ] DB schema supports all new fields referenced in ACs
- [ ] Changelog is updated with version bump

### Step 7: Output Summary

```markdown
## Spec Update Report

### Change Request
- **CR**: [reference]
- **Description**: [summary]

### Changes Applied

| # | Section | Action | Description |
|---|---------|--------|-------------|
| 1 | US-2 | ✏️ Modified | Updated AC-3 for 2-level approval |
| 2 | US-4 | 🆕 Added | New user story for partial shipment |
| 3 | API Contract | 🆕 Added | POST /orders/{id}/shipments endpoint |
| 4 | DB Schema | ✏️ Modified | Added shipped_quantity column |
| 5 | Changelog | ✏️ Updated | v1.0 → v1.1 |

### Sections NOT Changed
- Executive Summary (still accurate)
- Problem Statement (unchanged)
- US-1, US-3 (not affected)
- NFRs (not affected)
- Risks (not affected)

### Version
- **Previous**: 1.0
- **Current**: 1.1

### Recommendation
- [ ] Run `review-spec` skill on updated spec to validate changes
- [ ] Update state diagram if entity lifecycle changed
- [ ] Notify consumer teams of API changes
```

## Handling Complex CRs

For CRs that affect 50%+ of the spec, assess whether patching or rewrite is better:

| Change Scope | Strategy |
|-------------|----------|
| ≤ 3 sections affected | **Patch** — use delta approach above |
| 4-6 sections, same structure | **Patch** — delta with section reordering |
| > 50% sections, structure change | **Rewrite** — regenerate spec using `analyze-requirements` skill, preserve Changelog |

**If rewriting**: Always carry forward the Changelog from the old spec and append the new version entry.

## Validation

- [ ] Only affected sections were modified
- [ ] Unchanged sections are byte-identical to original
- [ ] Cross-references are valid
- [ ] Changelog updated with version bump
- [ ] No contradictions between old and new ACs
- [ ] Spec still renders correctly as markdown
