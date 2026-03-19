---
agent: 'agent'
description: 'Deep analysis of current codebase — detects languages, frameworks, architecture, domain boundaries, coding conventions, testing patterns, and external dependencies. Produces a structured analysis report.'
---

# Analyze Current Project

Perform a comprehensive codebase analysis and produce a structured report.

## Analysis Steps

### 1. Project Overview

Scan root directory for:
- `README.md` — project description
- Build files: `pom.xml`, `build.gradle.kts`, `package.json`, `Cargo.toml`, `go.mod`, `*.xcodeproj`
- Config files: `application.yml`, `.env`, `docker-compose.yml`, `Dockerfile`
- CI/CD: `.github/workflows/`, `Jenkinsfile`, `.gitlab-ci.yml`

### 2. Languages & Frameworks

Count files by extension and read build files to determine:
- Primary/secondary languages and versions
- Frameworks and their versions
- Build tool and dependency management approach
- Runtime environment (JVM, Node, .NET, etc.)

### 3. Architecture Pattern

Analyze directory structure and source organization:
- **Module structure**: mono-module, multi-module, monorepo
- **Package/directory layout**: layer-based (`service/`, `repository/`, `controller/`) vs feature-based (`orders/`, `customers/`)
- **Pattern**: MVC, MVVM, Clean Architecture, Hexagonal, Event-Driven
- **API type**: REST, GraphQL, gRPC, WebSocket
- **DI approach**: CDI, Spring, Hilt, Koin, manual

### 4. Domain Map

For multi-module or multi-domain projects:
- List bounded contexts / feature domains
- Map dependencies between domains
- Identify shared/core modules
- Note domain-specific conventions

### 5. Coding Conventions

Read 3-5 representative files per language to detect:
- Class naming: `PascalCase`, prefixes/suffixes (`Service`, `Repository`, `ViewModel`)
- Method naming: `camelCase`, verb-first patterns
- Import organization: grouped, alphabetical, wildcard use
- Error handling: exceptions, Result types, error codes
- Null handling: Optional, nullable types, null checks
- Logging: framework used, format, levels
- Comments/documentation style: JavaDoc, KDoc, DocC, JSDoc

### 6. Testing Approach

Scan test directories and test files:
- Test framework: JUnit 5, TestNG, XCTest, Swift Testing, Jest, pytest
- Mocking: Mockito, MockK, mocks, fakes, stubs
- Assertion library: AssertJ, Truth, Hamcrest, native
- Test organization: mirror source, nested, `@Nested`
- Integration tests: testcontainers, WireMock, in-memory DB
- Coverage approach: branch, line, method

### 7. External Dependencies

Identify integrations:
- HTTP clients: Retrofit, RestTemplate, WebClient, URLSession
- Message queues: Kafka, RabbitMQ, JMS
- Caching: Redis, Ehcache, in-memory
- Cloud: AWS, Azure, GCP SDKs
- Monitoring: Prometheus, Micrometer, OpenTelemetry
- Mock servers: WireMock, MockServer, json-server

## Output Format

Produce a clean markdown report:

```markdown
# Codebase Analysis Report

## Project: [name]
**Generated**: [date]

## Tech Stack
| Category | Technology | Version |
|----------|-----------|---------|
| Language | [detected] | [version] |
| Framework | [detected] | [version] |
| Build Tool | [detected] | [version] |
| Database | [detected] | [version] |
| Test Framework | [detected] | [version] |

## Architecture
- **Pattern**: [detected]
- **Module Structure**: [detected]
- **Package Organization**: [detected]

## Domain Map
| Domain | Modules/Packages | Dependencies |
|--------|-----------------|--------------|
| [domain] | [packages] | [depends on] |

## Coding Conventions
| Convention | Standard Detected |
|-----------|------------------|
| Class naming | [pattern] |
| Error handling | [approach] |
| DI | [framework/approach] |
| Logging | [framework] |

## Testing
| Aspect | Detail |
|--------|--------|
| Framework | [detected] |
| Mocking | [approach] |
| Organization | [pattern] |
| Coverage | [approach] |

## External Integrations
| Service | Client/Library | Purpose |
|---------|---------------|---------|
| [service] | [library] | [purpose] |

## Recommendations
- [Suggested agents to create]
- [Suggested skills to create]
- [Suggested instructions to create]
```
