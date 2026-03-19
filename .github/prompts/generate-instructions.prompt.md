---
agent: 'agent'
description: 'Generate coding standard instruction files from current codebase conventions. Scans source files to detect naming, error handling, import, and logging patterns, then creates .instructions.md files with applyTo glob patterns.'
---

# Generate Instruction Files

Create `.github/instructions/*.instructions.md` files by analyzing coding conventions in the current codebase.

## Step 1: Detect Languages & File Types

Scan the project for source files and categorize:
- Application code: `.java`, `.kt`, `.swift`, `.ts`, `.py`, `.go`, etc.
- Build/config: `pom.xml`, `build.gradle.kts`, `package.json`, etc.
- Database: `.sql`, migration files
- Test files: `*Test.java`, `*_test.go`, `*.test.ts`, etc.
- Infrastructure: `Dockerfile`, `docker-compose.yml`, `.yml` configs

## Step 2: Analyze Conventions Per Language

For each detected language, read **3-5 representative source files** and extract:

### Naming Conventions
- Class/type naming pattern (PascalCase, suffixes like Service/Repository/ViewModel)
- Method/function naming (camelCase, verb-first patterns)
- Variable naming (camelCase, prefixes like `_private`, `is`/`has` for booleans)
- Constant naming (UPPER_SNAKE_CASE, camelCase)
- Package/module naming (lowercase, dot-separated, feature-based)

### Error Handling
- Exception style: checked vs unchecked, custom hierarchy vs generic
- Result types: `Result<T>`, `Either`, `Optional`
- Try-catch patterns: specific vs generic catch
- Error responses: error codes, error DTOs

### Import Organization
- Grouped imports (java, javax, third-party, project)
- Wildcard imports: used or avoided
- Static imports: when used

### Logging
- Framework: SLF4J, Log4j, Timber, os_log, console
- Format: parameterized `{}` vs concatenation
- Levels used: DEBUG, INFO, WARN, ERROR
- What gets logged: method entry/exit, errors, business events

### Method Design
- Max method length (lines)
- Parameter count
- Return patterns (void, DTO, Result, Optional)
- Documentation approach (JavaDoc, KDoc, DocC, JSDoc)

## Step 3: Create Instruction Files

### File Format

```markdown
---
description: '[Language] coding standards for [framework/context]. [Key topics covered].'
applyTo: '[glob pattern]'
---

# [Language] Coding Standards

## Naming Conventions
[Rules detected with ✅/❌ examples]

## Error Handling
[Patterns detected]

## [Other sections as detected]
```

### Common applyTo Patterns

| Language/Context | applyTo Pattern |
|-----------------|----------------|
| Java source | `**/*.java` |
| Kotlin source | `**/*.kt` |
| Swift source | `**/*.swift` |
| TypeScript | `**/*.ts` |
| React/TSX | `**/*.tsx` |
| Python | `**/*.py` |
| SQL | `**/*.sql` |
| Maven POM | `**/pom.xml` |
| Gradle build | `**/*.gradle.kts` |
| Test files (Java) | `**/*Test*.java` |
| Test files (Kotlin) | `**/*Test*.kt` |
| Test files (Swift) | `**/*Tests*.swift` |
| WireMock stubs | `**/wiremock/**/*.json` |
| Docker | `**/Dockerfile` |
| CI/CD workflows | `.github/workflows/**/*.yml` |
| Android main | `**/src/main/**/*.kt` |

### Template for Each Section

```markdown
## Section Name

### Rule Name

[Brief rule description]

✅ **Correct:**
```[lang]
// Good example from codebase
```

❌ **Incorrect:**
```[lang]
// Anti-pattern to avoid
```
```

## Step 4: Framework-Specific Instructions

If a major framework is detected, create a separate instruction file:
- Jakarta EE → `jakartaee.instructions.md` (CDI, JPA, JAX-RS patterns)
- Spring Boot → `spring.instructions.md` (annotations, configs)
- Android → `android.instructions.md` (Compose, ViewModel, Hilt)
- iOS → `ios.instructions.md` (SwiftUI, @Observable)
- React → `react.instructions.md` (hooks, components)

## Step 5: Validate

For each instruction file:
- [ ] `description` clearly states what standards are covered
- [ ] `applyTo` is a valid glob pattern matching the right files
- [ ] Rules match actual conventions found in the codebase
- [ ] Examples use real patterns from the project, not generic ones
- [ ] No contradictions between instruction files
- [ ] ✅/❌ examples are clear and helpful

## Output

List all created instruction files:
```
📋 Instructions Generated:
├── [name].instructions.md (applyTo: [pattern]) — [key topics]
├── ...
```
