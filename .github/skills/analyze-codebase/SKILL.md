---
name: analyze-codebase
description: 'Deep multi-stack codebase analysis that thoroughly scans project structure, build configs, source code, architecture patterns, domain boundaries, coding conventions, testing approaches, CI/CD pipelines, and external dependencies. Produces a structured analysis report used by all downstream agents and skills. Supports Java/Maven/Gradle, .NET/C#, Python/Django/FastAPI, TypeScript/React, PHP/Laravel/Symfony, Android/Kotlin, iOS/Swift. Use when bootstrapping Copilot config, onboarding to a new project, or understanding codebase structure.'
---

# Analyze Codebase — Deep Multi-Stack Scan

Perform a **thorough** analysis of the target codebase. This is Phase 1 of the bootstrap pipeline and determines the quality of ALL downstream output.

> **Quality rule**: Read actual files, don't guess. Every claim in the report must be backed by a specific file you read.

## Minimum Scan Requirements

Before producing the report, ensure you have:
- [ ] Read ALL build config files (every module's pom.xml, every csproj, every package.json)
- [ ] Sampled ≥ 10 source files per detected domain (not 5 total)
- [ ] Read ALL entity/model classes in the project
- [ ] Read ≥ 3 service classes per domain to understand business logic patterns
- [ ] Read ≥ 3 test classes to detect testing patterns and conventions
- [ ] Checked for CI/CD, Docker, devcontainer configurations
- [ ] Scanned for external service integrations

## Workflow

### Step 1: Project Structure Discovery

1. List root directory — identify top-level layout
2. Check for monorepo indicators: multiple build files, `packages/`, workspace configs
3. Count source files per directory to gauge project size
4. Identify key directories: `src/`, `lib/`, `config/`, `docs/`, `.github/`, `scripts/`
5. Check for existing Copilot config: `.github/copilot-instructions.md`, `.github/agents/`

### Step 2: Tech Stack Detection — Per-Stack Recipe

#### Java/Maven
Read `pom.xml` (root AND every module):
- `<java.version>`, compiler source/target
- `<modules>` section → list all submodules
- Dependencies: Jakarta EE (`jakarta.*`), Spring (`spring-boot-starter-*`), Quarkus, MicroProfile
- Test deps: JUnit 5, Mockito, WireMock, Arquillian, Testcontainers
- Plugins: surefire, failsafe, JaCoCo, checkstyle, spotbugs, spotless
- Profiles: dev, test, prod, integration
- BOM / dependency management

#### Java/Gradle
Read `build.gradle` or `build.gradle.kts` (root AND every subproject):
- Java/Kotlin version, source compatibility
- `settings.gradle(.kts)` → `include` statements for subprojects
- Dependencies: same as Maven detection
- Plugins: application, java-library, spring-boot, android

#### .NET / C#
Read `*.sln` → list all `*.csproj` files:
- Target framework (`.net8.0`, `.net6.0`)
- NuGet packages: EF Core, ASP.NET Core, MediatR, FluentValidation, AutoMapper
- Test projects: xUnit, NUnit, MSTest, FluentAssertions, Moq
- Project references (inter-project dependencies)
- `Program.cs` / `Startup.cs` → DI registration, middleware pipeline

#### Python
Read `pyproject.toml`, `requirements.txt`, `setup.py`, or `Pipfile`:
- Python version, package manager (pip, poetry, pipenv)
- Framework: Django (`INSTALLED_APPS` in `settings.py`), FastAPI (`main.py` router includes), Flask
- ORM: SQLAlchemy, Django ORM, Tortoise
- Test: pytest, unittest, pytest-asyncio, factory_boy, faker
- Linting: ruff, black, flake8, mypy, isort
- Scan `manage.py` commands for Django projects
- Scan `alembic/` or `migrations/` for DB migration patterns

#### TypeScript / React / Node.js
Read `package.json` (root AND workspace packages if monorepo):
- Node version, package manager (npm, yarn, pnpm)
- Framework: React, Next.js, Vue, Angular, Express, NestJS, Fastify
- `tsconfig.json` → strict mode, module resolution, paths
- State management: Redux, Zustand, React Query, MobX
- Testing: Jest, Vitest, React Testing Library, Cypress, Playwright
- Linting: ESLint config, Prettier config
- Build: webpack, vite, esbuild, turbopack
- Scan `src/` for: `components/`, `hooks/`, `services/`, `utils/`, `api/`, `store/`, `pages/`, `features/`

#### PHP
Read `composer.json`:
- PHP version, framework: Laravel, Symfony, CodeIgniter
- `config/app.php` (Laravel) or `config/services.yaml` (Symfony)
- ORM: Eloquent, Doctrine
- Testing: PHPUnit, Pest, Mockery
- Scan `app/Models/`, `app/Http/Controllers/`, `database/migrations/`
- Check for FormRequest, Policy, Event/Listener patterns

#### Mobile — Android
Read `build.gradle.kts` with Android plugins:
- Kotlin version, Compose version, minSdk/targetSdk
- Dependencies: Hilt/Dagger, Room, Retrofit, Coroutines, Navigation
- Module structure: `:app`, `:core`, `:feature-*`, `:data`
- Scan for ViewModel, Repository, UseCase patterns

#### Mobile — iOS
Read `Package.swift` or `*.xcodeproj/project.pbxproj`:
- Swift version, iOS deployment target
- Dependencies: Alamofire, Kingfisher, SwiftData, CoreData
- Architecture: MVVM, VIPER, TCA
- Scan for ObservableObject, @Observable, async/await patterns

### Step 3: Architecture Pattern Detection

Scan source directory structure:
- `controller/service/repository/model` → **Layered Architecture**
- `port/adapter/domain` → **Hexagonal**
- `usecase/gateway/entity` → **Clean Architecture**
- `features/` or `modules/` with self-contained dirs → **Feature Modules**
- Multiple independent service directories → **Microservices**
- `presentation/domain/data` layers → **MVVM / Clean (Mobile)**

### Step 4: Domain Mapping

For projects with multiple business domains:

1. Scan package/directory hierarchy under main source root
2. Identify domain boundaries (e.g., `orders/`, `customers/`, `payments/`)
3. For EACH domain, count and list:
   - Entities/models (exact names)
   - APIs/endpoints (exact routes)
   - Services (exact class names)
   - Repository/DAO classes
   - External calls to other domains (import analysis)
4. Map inter-domain dependencies: which domain calls which
5. Classify complexity: `low` (≤3 entities), `medium` (4-8), `high` (9+)

### Step 5: Coding Conventions

Sample ≥ 10 source files across different domains and identify:
- Naming conventions (variables, classes, methods, constants, packages/namespaces)
- File organization within packages/directories
- Import ordering and grouping
- Error handling patterns (exception types, error responses)
- Logging patterns (framework, structured/unstructured, log levels)
- Documentation style (JavaDoc, JSDoc, docstrings, inline comments)
- Null handling (Optional, nullable types, null checks)

### Step 6: Testing Patterns

Scan test directories:
- Test framework and runner (JUnit 5, pytest, Jest, xUnit, PHPUnit)
- Mocking approach (Mockito, unittest.mock, Jest mocks, Moq, Fakes)
- Test naming convention (should_X_when_Y, test_X, descriptive names)
- Test data patterns (builders, fixtures, factories, faker)
- Integration test setup (Testcontainers, Docker, in-memory DB)
- Coverage tools and targets
- Test organization (by class, by feature, nested classes)

### Step 7: Infrastructure & DevOps

Check for:
- **CI/CD**: `.github/workflows/`, `Jenkinsfile`, `.gitlab-ci.yml`, `.azure-pipelines.yml`
- **Containerization**: `Dockerfile`, `docker-compose.yml`, `.devcontainer/`
- **Database**: migration files (Flyway, Liquibase, Alembic, Laravel migrations), schema definitions
- **Configuration**: `application.yml`, `appsettings.json`, `.env` files, config profiles
- **API Documentation**: Swagger/OpenAPI specs, Postman collections
- **Agile references**: Jira project keys in comments/commits, Azure DevOps work item IDs

## Output

Structured markdown report:

1. **Project overview** — name, purpose, size classification
2. **Tech stack** — languages, frameworks, build tools, with versions
3. **Architecture** — detected pattern, layer structure
4. **Module map** — all modules with sizes and inter-dependencies
5. **Domain map** — business domains with entities, services, complexity
6. **Coding conventions** — naming, patterns, documentation style
7. **Testing approach** — framework, mocking, coverage
8. **Infrastructure** — CI/CD, containers, databases, config management
9. **Recommendations** — which agents, skills, instructions to generate and WHY

## Validation Checklist

- [ ] ALL build config files were actually read (not guessed from file extension alone)
- [ ] At least 10 source files were sampled for conventions (state which files)
- [ ] Domain map covers ALL major packages/directories
- [ ] Entity list is COMPLETE (every entity class was found and listed)
- [ ] Recommendations are justified by specific findings from analysis
- [ ] No placeholder text like "TBD" or "to be determined" in report
