---
name: generate-sequence-diagram
description: 'Generate detailed Mermaid sequence diagrams by tracing code flows through Java/Jakarta EE applications. Identifies all participants across layers (REST resources, services, repositories, databases, external services, message queues). Creates both as-is and to-be diagrams with visual change markers for new, modified, and removed components. Use when asked to create a sequence diagram, visualize a flow, or document request processing.'
---

# Generate Sequence Diagram

Create accurate Mermaid sequence diagrams from codebase analysis.

## When to Use

- Documenting a request flow for a PBI
- Visualizing as-is state before changes
- Creating to-be diagrams showing proposed changes
- Understanding complex multi-service interactions
- Documenting API flows for review

## Workflow

### Step 1: Identify Entry Point

Find the starting point:
- REST endpoint (`@Path`, `@GET`, `@POST`)
- JMS listener (`@MessageDriven`, `@JmsListener`)
- Scheduler (`@Schedule`, `@Scheduled`)
- Event observer (`@Observes`)

### Step 2: Trace the Call Chain

Follow each method call from entry to database/external:
1. Read the entry point method
2. For each called method, read its implementation
3. Continue until reaching terminal operations (DB query, HTTP call, message send)
4. Note all conditional branches (if/switch)
5. Note all error/exception paths

### Step 3: Map Participants

| Code Component | Participant Label |
|---------------|------------------|
| HTTP client/browser | `Client` |
| REST Resource class | `[ClassName]` |
| Service class | `[ClassName]` |
| Repository/DAO | `[ClassName]` |
| EntityManager/DB | `Oracle DB` |
| External HTTP call | `External: [Name]` |
| JMS queue/topic | `MQ: [Name]` |
| Cache | `Cache` |

### Step 4: Create Mermaid Diagram

Use these Mermaid features:
- `autonumber` — number all interactions
- `activate`/`deactivate` — show processing time
- `alt`/`else` — conditional paths
- `opt` — optional steps
- `loop` — repeated operations
- `par` — parallel operations
- `rect rgb(R,G,B)` — colored boxes for change markers

### Step 5: Mark Changes (To-Be Only)

| Marker | Color | Meaning |
|--------|-------|---------|
| 🆕 | `rect rgb(200,255,200)` green | New component/interaction |
| ✏️ | `rect rgb(255,255,200)` yellow | Modified interaction |
| ❌ | `rect rgb(255,200,200)` red | Removed interaction |

### Step 6: Output

Produce markdown with:
1. Description of the flow
2. Participants table with class paths
3. Mermaid diagram
4. Change summary table (for to-be)
5. Notes on performance, error handling

## Validation

- [ ] Diagram traced from actual code (not assumed)
- [ ] All layers represented (Resource → Service → Repository → DB)
- [ ] Error paths included
- [ ] Change markers clearly distinguish new/modified/removed
- [ ] Diagram renders correctly in Mermaid
