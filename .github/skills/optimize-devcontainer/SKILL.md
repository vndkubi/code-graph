---
name: optimize-devcontainer
description: 'Analyze and optimize dev container configurations (devcontainer.json, Dockerfile, Docker Compose) for performance, security, and developer experience. Reviews base images, Features, lifecycle scripts, volume mounts, port forwarding, extensions, and resource limits. Generates optimized configurations for any tech stack. Use when asked to review devcontainer, improve container performance, optimize docker setup, fix slow container startup, reduce image size, or generate devcontainer configuration. Keywords: devcontainer, dev container, docker, container, optimize, performance, startup, image, volume, mount, feature.'
---

# Optimize DevContainer Skill

## When to Use

- User asks to review or optimize an existing devcontainer configuration
- User wants to generate a new devcontainer.json for their project
- User reports slow container startup, large images, or performance issues
- User wants to add or organize docker compose services
- User is setting up a devcontainer for the first time
- User asks about devcontainer best practices or troubleshooting

## Workflow

### Phase 0: Requirements Gathering — Ask Before You Act

**CRITICAL: Always start by understanding the developer's needs.** Never jump straight to generating or optimizing without asking.

#### If devcontainer EXISTS → Review Mode Questions

Ask the user:
1. "What issues are you experiencing? (slow startup, high memory, missing tools, build failures)"
2. "What's your host OS? (Windows/WSL2, macOS Intel/Apple Silicon, Linux) — this affects volume strategy"
3. "How many developers share this devcontainer config?"
4. "What are the typical machine specs on your team? (RAM, CPU, disk available for Docker)"
5. "Any tools you keep installing manually that should be baked in?"

#### If devcontainer does NOT exist → Creation Mode Questions

**You MUST ask ALL of these before generating any config:**

**Stack & Framework:**
1. "Primary language and version? (e.g., Java 21, Python 3.12, Node 20, .NET 8)"
2. "Framework? (Spring Boot, Django, FastAPI, Laravel, Express, ASP.NET Core)"
3. "Build tool? (Maven, Gradle, npm/yarn/pnpm, pip/poetry, Composer)"
4. "Additional languages needed? (e.g., Node for frontend alongside Java backend)"

**Services & Databases:**
5. "Databases needed? (PostgreSQL, MySQL, MongoDB, Redis, Oracle, SQL Server, SQLite)"
6. "Database versions? Seed data or migrations to run on creation?"
7. "Message queues? (RabbitMQ, Kafka, NATS)"
8. "Other services? (Elasticsearch, MinIO, Keycloak, Nginx, Mailpit, Prometheus)"

**Host & Resources:**
9. "Host OS? (Windows/WSL2, macOS, Linux)"
10. "RAM available for Docker? CPU cores? Disk space?"
11. "Network constraints? (proxy, VPN, air-gapped)"

**DX Preferences:**
12. "Preferred shell? (bash, zsh + oh-my-zsh, fish)"
13. "Must-have VS Code extensions beyond standard language pack?"
14. "Dotfiles repository?"
15. "Docker-in-Docker needed? (for building images inside container)"
16. "CI tools needed locally? (GitHub CLI, Azure CLI, AWS CLI)"

#### Resource Estimation

After gathering requirements, calculate and present resource needs:

| Stack | RAM (Min) | RAM (Recommended) | RAM (Peak) | CPU (Min) | Disk |
|-------|-----------|-------------------|------------|-----------|------|
| Java/Maven | 4 GB | 8 GB | 12+ GB | 2 cores | 5-10 GB |
| Java/Gradle | 4 GB | 8 GB | 14+ GB | 2 cores | 8-15 GB |
| .NET | 3 GB | 6 GB | 10+ GB | 2 cores | 4-8 GB |
| Python | 2 GB | 4 GB | 8+ GB | 1 core | 3-6 GB |
| Python (ML/AI) | 8 GB | 16 GB | 32+ GB | 4 cores | 10-30 GB |
| Node.js | 2 GB | 4 GB | 8 GB | 1 core | 2-5 GB |
| PHP | 2 GB | 4 GB | 6 GB | 1 core | 2-5 GB |
| Go | 2 GB | 4 GB | 8 GB | 2 cores | 3-8 GB |

Additional per-service: PostgreSQL +512MB, MySQL +512MB, MongoDB +1GB, Redis +256MB, Elasticsearch +2GB, Kafka +2GB, Keycloak +1GB, Oracle XE +4GB.

Present a **total resource summary** to the user and ask for confirmation before proceeding:

```
## Your Environment Estimate
| Component | RAM | CPU | Disk |
|-----------|-----|-----|------|
| Java 21 + Maven | 4-8 GB | 2 | 5 GB |
| PostgreSQL 16 | 512 MB | 0.5 | 2 GB |
| Redis 7 | 256 MB | 0.25 | 100 MB |
| **TOTAL (Min / Recommended)** | **~5 GB / ~9 GB** | **~3 / ~5** | **~7 GB** |

⚠️ Docker Desktop overhead adds ~1-2 GB. Recommend allocating 10-12 GB RAM to Docker.
```

If resources are tight, propose alternatives:
- Use SQLite instead of PostgreSQL for local dev
- Use shared remote services instead of local containers
- Use lighter alternatives (Mailpit vs full mail server)
- On-demand service startup scripts instead of always-running

**Wait for user confirmation before proceeding to Phase 1.**

### Phase 1: Discovery — Find All DevContainer Files

Search for configuration files:

```
# Primary configuration
.devcontainer/devcontainer.json
.devcontainer.json (root-level)
.devcontainer/*/devcontainer.json (named configurations)

# Docker files
.devcontainer/Dockerfile
.devcontainer/docker-compose.yml
.devcontainer/docker-compose.*.yml
Dockerfile (root, if referenced)
docker-compose*.yml (root, if referenced)

# Supporting files
.devcontainer/.dockerignore
.devcontainer/library-scripts/*.sh
.devcontainer/scripts/*.sh
.devcontainer/.env
.devcontainer/noop.txt
```

Read ALL discovered files to understand the complete configuration.

### Phase 2: Tech Stack Detection

Analyze the project to determine tech stack and requirements:

| Indicator Files | Stack | Recommended Base Image |
|----------------|-------|----------------------|
| `pom.xml`, `build.gradle` | Java | `mcr.microsoft.com/devcontainers/java:1-21-bookworm` |
| `*.csproj`, `*.sln` | .NET | `mcr.microsoft.com/devcontainers/dotnet:1-8.0-bookworm` |
| `pyproject.toml`, `requirements.txt`, `manage.py` | Python | `mcr.microsoft.com/devcontainers/python:1-3.12-bookworm` |
| `composer.json`, `artisan` | PHP | `mcr.microsoft.com/devcontainers/php:1-8.3-bookworm` |
| `package.json`, `tsconfig.json` | Node.js/TypeScript | `mcr.microsoft.com/devcontainers/typescript-node:1-20-bookworm` |
| `go.mod`, `go.sum` | Go | `mcr.microsoft.com/devcontainers/go:1-1.22-bookworm` |
| `Cargo.toml` | Rust | `mcr.microsoft.com/devcontainers/rust:1-bookworm` |
| Multiple stacks | Polyglot | `mcr.microsoft.com/devcontainers/base:1-bookworm` + Features |

Also detect:
- Database needs (PostgreSQL, MySQL, MongoDB, Redis, Oracle)
- Message queues (RabbitMQ, Kafka)
- External services (Elasticsearch, MinIO, Keycloak)
- CI/CD tools (GitHub Actions, Azure DevOps)

### Phase 3: Configuration Audit

#### 3.1 Image & Build Audit

| Check | Severity | Description |
|-------|----------|-------------|
| Image pinning | 🔴 Critical | `latest` tag → pin to specific version |
| Official images | 🟡 Warning | Custom image → prefer `mcr.microsoft.com/devcontainers/` |
| `.dockerignore` | 🟡 Warning | Missing → add to reduce build context |
| Multi-stage build | 🔵 Info | Single stage → consider multi-stage for compiled languages |
| Build cache | 🔵 Info | No `cacheFrom` → add for CI builds |
| Image size | 🟡 Warning | Image > 2GB → identify reduction opportunities |

#### 3.2 Features Audit

| Check | Severity | Description |
|-------|----------|-------------|
| Version pinning | 🟡 Warning | Unpinned → pin to major: `"ghcr.io/.../node:1"` |
| Redundancy | 🟡 Warning | Feature already in base image → remove |
| Official registry | 🔵 Info | Third-party Feature → verify trustworthiness |
| Feature count | 🔵 Info | > 8 Features → consider custom Dockerfile instead |

#### 3.3 Lifecycle Scripts Audit

| Check | Severity | Description |
|-------|----------|-------------|
| Script placement | 🟡 Warning | Heavy installs in `postStartCommand` → move to `onCreateCommand` |
| Idempotency | 🟡 Warning | Scripts not idempotent → ensure safe re-run |
| Error handling | 🔵 Info | No error checking in scripts → add `set -e` |
| Parallel execution | 🔵 Info | Sequential installs → use parallel where possible |
| `waitFor` optimization | 🔵 Info | Pre-build not optimized → set `"waitFor": "updateContentCommand"` |

#### 3.4 Performance Audit

| Check | Severity | Description |
|-------|----------|-------------|
| Bind mount on macOS/Windows | 🔴 Critical | Heavy I/O on bind mount → use named volume |
| Missing cache volumes | 🟡 Warning | No package manager cache mount → add named volume |
| `consistency` flag | 🔵 Info | No mount consistency set → add `consistency=cached` |
| Resource limits | 🔵 Info | No limits set → add `--memory` and `--cpus` |
| `shutdownAction` | 🔵 Info | Rebuilds are expensive → consider `"shutdownAction": "none"` |
| Pre-build strategy | 🔵 Info | No pre-build → recommend image pre-building for teams |

#### 3.5 Security Audit

| Check | Severity | Description |
|-------|----------|-------------|
| Root user | 🔴 Critical | Running as root → set `"remoteUser": "vscode"` |
| Privileged mode | 🔴 Critical | `"privileged": true` without justification → remove |
| Hardcoded secrets | 🔴 Critical | Secrets in config → use `.env` file or secrets mount |
| Excessive capabilities | 🟡 Warning | Unnecessary `capAdd` → remove unneeded caps |
| Network exposure | 🟡 Warning | All ports exposed → limit to needed ports |

#### 3.6 Developer Experience Audit

| Check | Severity | Description |
|-------|----------|-------------|
| Missing extensions | 🟡 Warning | No project extensions → add stack-relevant extensions |
| Missing settings | 🟡 Warning | No formatter/linter settings → add defaults |
| Port labels | 🔵 Info | No `portsAttributes` → add labels and autoforward settings |
| Git setup | 🔵 Info | No git credential sharing → configure dotfiles or git helper |
| Shell customization | 🔵 Info | Default shell → consider zsh with oh-my-zsh |

### Phase 4: Performance Optimization

#### Named Volume Recommendations by Stack

```jsonc
// Java / Maven
"mounts": [
  "source=maven-cache,target=/home/vscode/.m2/repository,type=volume",
  "source=gradle-cache,target=/home/vscode/.gradle/caches,type=volume"
]

// .NET
"mounts": [
  "source=nuget-cache,target=/home/vscode/.nuget/packages,type=volume"
]

// Python
"mounts": [
  "source=pip-cache,target=/home/vscode/.cache/pip,type=volume",
  "source=venv,target=/workspace/.venv,type=volume"
]

// PHP / Composer
"mounts": [
  "source=composer-cache,target=/home/vscode/.composer/cache,type=volume"
]

// Node.js (CRITICAL on macOS/Windows)
"mounts": [
  "source=node-modules,target=/workspace/node_modules,type=volume",
  "source=npm-cache,target=/home/vscode/.npm,type=volume"
]

// Go
"mounts": [
  "source=go-cache,target=/home/vscode/go,type=volume",
  "source=go-build-cache,target=/home/vscode/.cache/go-build,type=volume"
]
```

#### Pre-Build Strategy

```jsonc
// devcontainer.json optimized for pre-builds
{
  "image": "ghcr.io/your-org/your-project-devcontainer:latest",
  "waitFor": "updateContentCommand",

  // Only runs on fresh container creation (not pre-build)
  "postCreateCommand": "echo 'Container ready'",

  // Runs after git clone/pull — handles project-specific deps
  "updateContentCommand": "npm ci --prefer-offline",

  // Quick checks on every start
  "postStartCommand": "npm run validate-env || true"
}
```

### Phase 5: Generate Optimized Configuration

When generating new or optimized config, output:

1. **`devcontainer.json`** — Complete, optimized configuration with comments
2. **`Dockerfile`** (if needed) — Multi-stage, cached, minimal
3. **`docker-compose.yml`** (if multi-service) — With healthchecks, volumes, networking
4. **`.dockerignore`** — Exclude unnecessary files
5. **Migration notes** — What changed from current config and why

### Phase 6: Generate Report

Output a structured markdown report:

```markdown
# DevContainer Optimization Report

## Health Score: X/10

## Configuration Summary
| Property | Value |
|----------|-------|
| Config path | `.devcontainer/devcontainer.json` |
| Base image | `mcr.microsoft.com/devcontainers/...` |
| Features | X installed |
| Extensions | Y configured |
| Services | Z (if compose) |

## Findings by Severity

### 🔴 Critical (X findings)
[table with findings]

### 🟡 Warning (X findings)
[table with findings]

### 🔵 Info (X findings)
[table with findings]

### 🟢 Good Practices (X detected)
[list of good practices found]

## Performance Impact
| Optimization | Before | After | Impact |
|-------------|--------|-------|--------|
| Named volume for node_modules | 45s npm install | 8s npm install | -82% |
| Pre-built image | 3min first open | 20s first open | -89% |
| Layer caching | 5min rebuild | 30s rebuild | -90% |

## Optimized Configuration
[Full devcontainer.json with inline comments explaining each property]

## Migration Steps
1. [Step-by-step instructions to apply changes]
```

## Validation Checklist

After generating or optimizing a configuration, verify:

- [ ] `devcontainer.json` is valid JSON (with comments allowed — jsonc format)
- [ ] All referenced files exist (Dockerfile, scripts, docker-compose)
- [ ] Base image or Dockerfile exists and is accessible
- [ ] Features reference valid IDs from the registry
- [ ] Extensions use correct marketplace IDs
- [ ] Ports don't conflict with each other
- [ ] Environment variables don't contain secrets
- [ ] Non-root user is configured
- [ ] Named volumes use descriptive names
- [ ] Lifecycle scripts are idempotent
- [ ] `.dockerignore` exists and excludes build artifacts
- [ ] `forwardPorts` matches application requirements
- [ ] `portsAttributes` has meaningful labels

## Anti-Patterns to Flag

| Anti-Pattern | Better Practice |
|-------------|-----------------|
| `"image": "ubuntu:latest"` | Use official devcontainer images |
| `RUN apt-get update && apt-get install -y nodejs npm` | Use Node.js Feature instead |
| `"postStartCommand": "npm install"` | Move to `onCreateCommand` or `updateContentCommand` |
| `"privileged": true` (without Docker-in-Docker) | Remove, use `capAdd` for specific caps |
| Hardcoded paths: `/home/vscode` | Use `${containerWorkspaceFolder}` variable |
| `"shutdownAction": "none"` on cheap containers | Use `"stopContainer"` (default) |
| Install language runtime in Dockerfile | Use devcontainer Features instead |
| `COPY . .` in Dockerfile | Use specific COPY or `.dockerignore` |
| Multiple `RUN apt-get update` | Combine into single RUN layer |
| No `.dockerignore` | Always create with sensible defaults |
