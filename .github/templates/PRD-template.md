# Product Requirements Document (PRD)

## Document Info

| Field | Value |
|-------|-------|
| **Title** | [Feature/Product Name] |
| **Author** | [Name] |
| **Date** | [YYYY-MM-DD] |
| **Version** | 1.0 |
| **Status** | Draft / In Review / Approved |
| **Reviewers** | [Names] |

## 1. Executive Summary

[2-3 sentences: What is being built, for whom, and why it matters to the business.]

## 2. Problem Statement

### Current State
[Describe the current situation, pain points, and limitations.]

### Desired State
[Describe what success looks like after this feature is delivered.]

### Business Impact
| Metric | Current | Target | Improvement |
|--------|---------|--------|-------------|
| [KPI] | [value] | [value] | [%] |

## 3. User Personas

| Persona | Role | Goal | Pain Point |
|---------|------|------|-----------|
| [Name] | [Role] | [What they want] | [What frustrates them] |

## 4. User Stories

### US-1: [Title]
**As a** [persona]
**I want** [capability]
**So that** [benefit]

**Acceptance Criteria:**
- [ ] AC-1: Given [context] When [action] Then [outcome]
- [ ] AC-2: Given [context] When [action] Then [outcome]
- [ ] AC-3: Given [context] When [action] Then [outcome]

**Priority:** Must Have / Should Have / Could Have

### US-2: [Title]
<!-- Repeat structure -->

## 5. Functional Requirements

| ID | Requirement | Priority | User Story |
|----|------------|----------|-----------|
| FR-1 | [Description] | Must Have | US-1 |
| FR-2 | [Description] | Must Have | US-1, US-2 |
| FR-3 | [Description] | Should Have | US-2 |

## 6. Non-Functional Requirements

| ID | Category | Requirement | Target | Measurement |
|----|----------|------------|--------|-------------|
| NFR-1 | Performance | API response time | < 200ms (P95) | APM monitoring |
| NFR-2 | Scalability | Concurrent users | [N] users | Load test |
| NFR-3 | Security | [Specific requirement] | [Standard] | Security scan |
| NFR-4 | Availability | Uptime SLA | 99.9% | Monitoring |
| NFR-5 | Compliance | [Regulation] | Compliant | Audit |

## 7. System Context

### Architecture Overview
[Describe where this feature fits in the system architecture. Reference C4 context diagram if available.]

### External Dependencies
| System | Integration Type | Purpose | Owner |
|--------|-----------------|---------|-------|
| [System] | REST API / MQ / DB | [Purpose] | [Team] |

### Data Flow
[Describe or reference a sequence diagram showing the main data flow.]

## 8. UI/UX Requirements

### Wireframes
[Link to wireframes or describe key screens]

### User Flow
[Step-by-step flow through the feature]

## 9. Scope

### In Scope
- [Feature/capability included]
- [Feature/capability included]

### Out of Scope
- [What is deliberately excluded]
- [Deferred to future iterations]

### Assumptions
- [Assumption 1]
- [Assumption 2]

### Constraints
- [Technical constraint]
- [Business constraint]
- [Timeline constraint]

## 10. Risks & Mitigations

| # | Risk | Probability | Impact | Mitigation |
|---|------|------------|--------|-----------|
| 1 | [Risk] | High/Med/Low | High/Med/Low | [Plan] |

## 11. Success Criteria

| Criterion | Metric | Target | How to Measure |
|-----------|--------|--------|---------------|
| [Criterion] | [Metric] | [Value] | [Tool/Method] |

## 12. Timeline & Milestones

| Milestone | Target Date | Dependencies |
|-----------|------------|-------------|
| Spec approved | [date] | — |
| Development complete | [date] | Spec approved |
| QA sign-off | [date] | Dev complete |
| Production release | [date] | QA sign-off |

## Changelog

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | [date] | [name] | Initial draft |
