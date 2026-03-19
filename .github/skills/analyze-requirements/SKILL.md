---
name: analyze-requirements
description: 'Requirements analysis and PBI writing workflow. Transforms user feature requests into structured User Stories with acceptance criteria, PBI breakdowns with story point estimates, impact assessments, and dependency maps. Analyzes actual codebase for feasibility and reuse opportunities. Outputs polished markdown documents saved to docs/requirements/. Use when asked to write a story, create PBIs, analyze requirements, or plan a feature.'
---

# Analyze Requirements — From Idea to Structured PBIs

Transform vague feature ideas into structured, implementable requirements by combining user intent with actual codebase analysis.

## When to Use

- User describes a feature idea and wants it formalized as a Story/PBI
- User asks "I want to add X" or "we need Y functionality"
- Backlog grooming — refining rough items into implementable PBIs
- Requirements clarification before sprint planning
- Keywords: "write story", "create PBI", "analyze requirement", "plan feature", "define scope"

## Workflow

### Step 1: Capture Intent

From the user's input, extract:
- **What** they want (capability)
- **Who** it's for (persona)
- **Why** it matters (business value)
- **Where** it fits (module, screen, API)
- Ask clarifying questions if any of these are unclear

### Step 2: Codebase Analysis

**Always analyze the codebase before writing requirements.**

1. Search for related entities, services, endpoints
2. Identify existing components that can be reused
3. Find existing patterns to follow
4. Map affected modules and dependencies
5. Check for conflicting business rules

Output a reuse assessment table:

| Component | Exists? | Action Needed |
|-----------|---------|--------------|
| [Entity] | ✅ Yes | Extend with new fields |
| [Service] | ✅ Yes | Add new method |
| [Endpoint] | ❌ No | Create new |
| [Tests] | ✅ Partial | Add new scenarios |

### Step 3: Write User Story

Use standard format:
- **As a** [persona] **I want** [capability] **So that** [benefit]
- Acceptance Criteria in Given/When/Then format
- Mark priority: Must Have / Should Have / Could Have
- Define what's Out of Scope

### Step 4: PBI Decomposition

Break the story into implementable PBIs:
- Each PBI ≤ 8 story points (split larger ones)
- Each PBI has: description, acceptance criteria, technical notes, DoD
- Map dependencies between PBIs
- Assign story points based on actual codebase complexity

### Step 5: Impact Assessment

Produce:
- Affected areas table (🔴🟡🟢 impact levels)
- PBI dependency graph
- Risk assessment with mitigations
- Estimation summary

### Step 6: Save as File

**Save output to**: `docs/requirements/[feature-name]-requirements.md`

## Validation

- [ ] Every user story has acceptance criteria
- [ ] Every PBI has Definition of Done
- [ ] Story points are realistic (based on codebase analysis)
- [ ] Dependencies are clearly mapped
- [ ] Out-of-scope items are explicitly listed
- [ ] Technical notes reference actual file paths
- [ ] Output is saved as markdown file
