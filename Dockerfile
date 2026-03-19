# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for native modules (tree-sitter uses node-gyp)
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Only install production dependencies
COPY package*.json ./
RUN apk add --no-cache python3 make g++ \
    && npm ci --omit=dev \
    && apk del python3 make g++

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Default mount point for the project being analyzed
VOLUME ["/workspace"]

EXPOSE 3100

# Use HTTP transport by default in Docker (stdio is for direct Copilot integration)
# Override via CMD or environment variables
ENTRYPOINT ["node", "dist/server.js"]
CMD ["--root", "/workspace", "--transport", "http", "--port", "3100"]
