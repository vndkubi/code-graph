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

# v2 is stdio-proxy/daemon based. Use `index` to prewarm a mounted workspace,
# or `mcp` when an MCP client launches the container over stdio.
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["mcp", "--root", "/workspace"]
