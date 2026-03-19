---
agent: 'agent'
description: 'Generate custom Copilot agents tailored to the current codebase. Detects tech stack and creates agent files with proper frontmatter, role instructions, and patterns from the existing source code.'
---

# Generate Custom Agents

Create `.github/agents/*.agent.md` files tailored to this project's tech stack and patterns.

## Step 1: Detect Tech Stack

Analyze the codebase to determine which agents are needed:

### Language Detection
| Check | Agent to Create |
|-------|----------------|
| `.java` files + `pom.xml` | Java implementor, test-specialist |
| `.kt` files + `build.gradle.kts` | Mobile/Kotlin implementor |
| `.swift` files + `*.xcodeproj` | iOS/Swift implementor |
| `.ts`/`.tsx` files | TypeScript/React implementor |
| `.py` files | Python implementor |
| `.go` files | Go implementor |

### Framework Detection
| Check | Agent to Create |
|-------|----------------|
| Jakarta EE / Spring dependencies | investigator, sequence-diagrammer |
| REST endpoints detected | api-specialist |
| Database entities/migrations | database-specialist |
| WireMock / MockServer | mock-data-specialist |
| Complex multi-layer architecture | sequence-diagrammer |
| CI/CD pipelines | devops-engineer |

## Step 2: Read Existing Patterns

For each detected tech stack, read 3-5 representative source files to understand:
- Code style, naming conventions, patterns
- Architecture layers and how they connect
- Error handling approach
- Testing approach

## Step 3: Create Agent Files

### Agent File Format

```markdown
---
name: 'Agent Name'
description: 'Clear, concise description of the agent role and expertise. Include tech stack and when to use. (10-1024 characters)'
---

You are a [Role Name] — [one-sentence description of expertise].

## Expertise
[List specific technologies, frameworks, and patterns this agent knows]

## Approach
[Step-by-step instructions for how this agent works]

## Code Quality Rules
[Standards detected from the codebase]

## Guidelines
[Project-specific patterns and anti-patterns]
```

> **IMPORTANT:** Do NOT include `tools` field in frontmatter — this gives agents ALL available tools.

### Always Create These Core Agents

#### 1. Implementor
- Writes production code following project patterns
- Covers all architecture layers detected
- Uses the project's actual DI, error handling, logging patterns

#### 2. Test Specialist
- Uses the project's test framework (JUnit/MockK/XCTest/etc.)
- Follows mock minimization: real objects > fakes > stubs > mocks
- Covers all business branches and edge cases

#### 3. Code Reviewer
- Reviews against project conventions
- Checks business logic correctness
- Outputs structured markdown report

### Conditionally Create

#### 4. Investigator (if complex business logic)
- As-is/to-be analysis
- Impact assessment
- Scenario mapping with edge cases

#### 5. Sequence Diagrammer (if multi-layer architecture)
- Mermaid sequence diagrams
- Change markers (🆕/✏️/❌)

#### 6. Mock Data Specialist (if WireMock/MockServer detected)
- Mock stubs, test fixtures
- Response templating

#### 7. Conductor (if 3+ agents created)
- Orchestrates other agents
- Delegates based on task type
- References all sub-agents

## Step 4: Validate

For each agent file:
- [ ] `name` is a clear, descriptive title
- [ ] `description` is 10-1024 characters
- [ ] No `tools` field in frontmatter
- [ ] Instructions reference patterns actually found in this codebase
- [ ] Role is clearly defined and non-overlapping with other agents
- [ ] Includes project-specific conventions detected in Step 2

## Output

List all created agents with a brief summary of each.
