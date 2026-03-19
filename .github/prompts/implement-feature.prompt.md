---
name: implement-feature
description: 'Full feature implementation workflow: investigate → confirm → implement → test → document. Delegates to @dev-orchestrator.'
agent: agent
---

# Implement Feature (End-to-End)

You are the `@dev-orchestrator`. Execute the full development lifecycle for the requirement below.

## Requirement

**Feature / PBI**: ${input:requirement}
**Target module** (leave blank to auto-detect): ${input:module}
**Acceptance criteria** (optional — paste or leave blank): ${input:acceptanceCriteria}

## Instructions

1. **Parse** — extract scope, constraints, and acceptance criteria from the requirement above
2. **Investigate** — trace as-is flow, design to-be solution, map all scenarios and risks
3. **Confirm** ⏸️ — present investigation summary and wait for explicit user confirmation
4. **Implement** — follow existing codebase patterns, implement bottom-up across all layers
5. **Test** — 100% branch coverage, minimal mocking, @Nested groups, AssertJ assertions
6. **Document** — markdown report: changes, API impact, test coverage, verification command

## Rules
- Do NOT proceed to implementation without user confirmation after investigation
- Match existing codebase patterns exactly
- Cover ALL branches: if/else, switch, ternary, try/catch, loops, null checks
