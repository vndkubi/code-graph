---
description: 'Dev container configuration standards for devcontainer.json, Dockerfiles, and Docker Compose in development environments. Covers image selection, Features, lifecycle scripts, volume mounts, port forwarding, extensions, security, and performance optimization.'
applyTo: '**/.devcontainer/**, **/devcontainer.json'
---

# DevContainer Configuration Standards

## devcontainer.json Conventions

### Image Selection

- **Prefer official devcontainer images**: `mcr.microsoft.com/devcontainers/{language}:{version}-{os}`
- **Always pin versions**: Use `1-21-bookworm` not `latest`
- **Match project stack**: Java → `devcontainers/java`, Python → `devcontainers/python`
- **Use `base` for polyglot**: `mcr.microsoft.com/devcontainers/base:1-bookworm` + Features

```jsonc
// ✅ Good — pinned, official image
"image": "mcr.microsoft.com/devcontainers/java:1-21-bookworm"

// ❌ Bad — unpinned, non-official
"image": "ubuntu:latest"
```

### Features

- **Pin to major version**: `"ghcr.io/devcontainers/features/node:1"` (not `:latest`)
- **Prefer official Features**: `ghcr.io/devcontainers/features/` registry
- **Don't duplicate base image content**: If base has Java, don't add Java Feature
- **Keep minimal**: Install only what the project needs
- **Order for cache**: Put stable Features first, changing ones last

```jsonc
// ✅ Good — pinned, minimal, ordered
"features": {
  "ghcr.io/devcontainers/features/github-cli:1": {},
  "ghcr.io/devcontainers/features/docker-in-docker:2": {},
  "ghcr.io/devcontainers/features/node:1": { "version": "20" }
}
```

### Lifecycle Scripts

Follow this execution order and placement guidance:

| Script | Runs | Use For |
|--------|------|---------|
| `initializeCommand` | On host, before container | Host-side validation only |
| `onCreateCommand` | First container creation | Heavy installs, system packages |
| `updateContentCommand` | After git clone/pull | `npm ci`, `pip install`, `mvn dependency:resolve` |
| `postCreateCommand` | After create + update | Dev setup, DB seeding, env validation |
| `postStartCommand` | Every container start | Background services, health checks |
| `postAttachCommand` | Every VS Code session | UI-related setup, notifications |

```jsonc
// ✅ Good — proper script placement
{
  "onCreateCommand": "sudo apt-get update && sudo apt-get install -y libpq-dev",
  "updateContentCommand": "npm ci --prefer-offline",
  "postCreateCommand": ".devcontainer/setup.sh",
  "postStartCommand": "echo 'Container ready'"
}

// ❌ Bad — heavy install on every start
{
  "postStartCommand": "npm install && pip install -r requirements.txt"
}
```

### Scripts Best Practices

- **Make idempotent**: Scripts must be safe to re-run
- **Use `set -e`**: Fail fast on errors in bash scripts
- **Use object format for parallel execution**:
  ```jsonc
  "postCreateCommand": {
    "install-deps": "npm ci",
    "setup-db": ".devcontainer/setup-db.sh",
    "install-tools": "pip install pre-commit && pre-commit install"
  }
  ```

### Port Forwarding

- **Forward only needed ports**: Don't use `forwardPorts: [3000, 3001, 5432, 8080, 8443, 9090]` if not all needed
- **Add labels via `portsAttributes`**: Makes forwarded ports identifiable
- **Set `onAutoForward`**: Control automatic forwarding behavior

```jsonc
"forwardPorts": [3000, 5432],
"portsAttributes": {
  "3000": {
    "label": "Web App",
    "onAutoForward": "notify"
  },
  "5432": {
    "label": "PostgreSQL",
    "onAutoForward": "silent"
  }
}
```

### Volume Mounts

- **Use named volumes for package caches** (critical on macOS/Windows):
  ```jsonc
  "mounts": [
    "source=project-node-modules,target=${containerWorkspaceFolder}/node_modules,type=volume",
    "source=npm-cache,target=/home/vscode/.npm,type=volume"
  ]
  ```
- **Use `consistency=cached`** for source code bind mounts on macOS
- **Use `${localWorkspaceFolder}`** for host paths, `${containerWorkspaceFolder}` for container paths
- **Don't mount secrets directly**: Use Docker secrets or environment variables

### Extensions

- **Include only project-relevant extensions**: Don't add personal preferences
- **Group by purpose**: Linting, formatting, language support, debugging
- **Use opt-out for unwanted defaults**: Prefix with `-` to remove from base image

```jsonc
"customizations": {
  "vscode": {
    "extensions": [
      // Language support
      "vscjava.vscode-java-pack",
      // Linting & formatting
      "dbaeumer.vscode-eslint",
      "esbenp.prettier-vscode",
      // Opt out of unwanted base image extension
      "-ms-vscode.vscode-typescript-tslint-plugin"
    ]
  }
}
```

### Settings

- **Set formatter defaults**: Avoid formatting conflicts in team
- **Configure linter rules**: Match project configuration
- **Set editor defaults**: Tab size, line endings, file associations

```jsonc
"customizations": {
  "vscode": {
    "settings": {
      "editor.formatOnSave": true,
      "editor.defaultFormatter": "esbenp.prettier-vscode",
      "editor.tabSize": 2,
      "files.eol": "\n",
      "files.trimTrailingWhitespace": true
    }
  }
}
```

### Security

- **Always set `remoteUser`**: Don't run as root
  ```jsonc
  "remoteUser": "vscode"
  ```
- **Avoid `privileged: true`**: Use `capAdd` for specific capabilities
- **Never hardcode secrets**: Use `.env` files, environment variables, or secrets mounts
- **Set `updateRemoteUserUID: true`**: Match host UID on Linux
- **Minimize `capAdd`**: Only add required capabilities
  ```jsonc
  // ✅ Only for debugging
  "capAdd": ["SYS_PTRACE"]

  // ❌ Don't add unless Docker-in-Docker is needed
  "privileged": true
  ```

### Environment Variables

- **Use `containerEnv` for build-time**: Available to all processes
- **Use `remoteEnv` for VS Code sessions**: Available in terminals and extensions
- **Use `${localEnv:VAR}`** to pass host env vars
- **Never put secrets in devcontainer.json**: Use `.env` file

```jsonc
"containerEnv": {
  "JAVA_HOME": "/usr/lib/jvm/java-21-openjdk",
  "TZ": "UTC"
},
"remoteEnv": {
  "DATABASE_URL": "${localEnv:DATABASE_URL}",
  "DOTNET_CLI_TELEMETRY_OPTOUT": "1"
}
```

### Resource Management

- **Set host requirements** for predictable experience:
  ```jsonc
  "hostRequirements": {
    "cpus": 4,
    "memory": "8gb",
    "storage": "32gb"
  }
  ```
- **Use `runArgs` for runtime limits**:
  ```jsonc
  "runArgs": ["--memory=8g", "--cpus=4"]
  ```
- **Set `shutdownAction`** based on rebuild cost:
  - `"stopContainer"` (default) — for quick-rebuild containers
  - `"none"` — for expensive-to-rebuild containers

### Pre-Build Variables

Use predefined variables for portable configurations:

| Variable | Description |
|----------|-------------|
| `${localWorkspaceFolder}` | Host path to workspace |
| `${containerWorkspaceFolder}` | Container path to workspace |
| `${localWorkspaceFolderBasename}` | Workspace folder name |
| `${localEnv:VARIABLE}` | Host environment variable |
| `${containerEnv:VARIABLE}` | Container environment variable |

## Dockerfile Conventions

### Layer Ordering (for cache efficiency)

```dockerfile
# 1. Base image (rarely changes)
FROM mcr.microsoft.com/devcontainers/base:1-bookworm

# 2. System packages (rarely change)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget git \
    && rm -rf /var/lib/apt/lists/*

# 3. Language runtime (changes on upgrades)
# Prefer using Features instead

# 4. Dependencies (changes on package updates)
COPY package.json package-lock.json ./
RUN npm ci --prefer-offline

# 5. Source code (changes frequently — do NOT COPY in devcontainer)
# Source is mounted via devcontainer.json
```

### Best Practices

- **Use `--no-install-recommends`**: Reduce image size
- **Clean cache in same layer**: `&& rm -rf /var/lib/apt/lists/*`
- **Combine RUN commands**: Reduce layer count
- **Use `ARG` for versions**: Parameterize for easy updates
- **Create non-root user**: If not using devcontainer base images
- **Add `.dockerignore`**: Exclude `.git`, `node_modules`, build artifacts

## Docker Compose Conventions

### Service Configuration

```yaml
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    volumes:
      - ..:/workspace:cached
    command: sleep infinity

  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: devdb
      POSTGRES_USER: devuser
      POSTGRES_PASSWORD: devpassword
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U devuser -d devdb"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  postgres-data:
```

### Best Practices

- **Add healthchecks** for databases and services
- **Use named volumes** for persistent data (databases, caches)
- **Set `restart: unless-stopped`** for supporting services
- **Use Alpine variants** where possible for smaller images
- **Don't expose ports unnecessarily**: Use Docker networking between services
- **Use `depends_on` with conditions**:
  ```yaml
  depends_on:
    db:
      condition: service_healthy
  ```

## .dockerignore

Always create a `.dockerignore` in the `.devcontainer/` directory:

```
# Version control
.git
.gitignore

# Dependencies (installed in container)
node_modules
vendor
.venv
__pycache__

# Build outputs
dist
build
target
bin
obj
out

# IDE
.vscode
.idea
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Test & coverage
coverage
.nyc_output
htmlcov
```
