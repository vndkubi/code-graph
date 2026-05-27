# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS builder

WORKDIR /app

# Build dependencies are needed for native modules such as tree-sitter.
# The optional codegraph_ca BuildKit secret lets corporate/internal CA certs
# participate in npm TLS validation without committing certificates to git.
RUN apk add --no-cache ca-certificates python3 make g++
RUN --mount=type=secret,id=codegraph_ca,target=/tmp/codegraph-ca.crt,required=false \
    if [ -s /tmp/codegraph-ca.crt ]; then \
      cp /tmp/codegraph-ca.crt /usr/local/share/ca-certificates/codegraph-extra-ca.crt; \
      update-ca-certificates; \
      cat /tmp/codegraph-ca.crt >> /etc/ssl/certs/ca-certificates.crt; \
    fi
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
ENV NPM_CONFIG_CAFILE=/etc/ssl/certs/ca-certificates.crt

COPY package*.json ./
RUN npm config set cafile /etc/ssl/certs/ca-certificates.crt \
    && npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

FROM node:20-alpine AS runtime

WORKDIR /app

# git is required for branch/head detection, stale-index checks, and stable
# workspace identity when the source is mounted into Docker.
RUN apk add --no-cache ca-certificates git python3 make g++
RUN git config --system --add safe.directory '*'
RUN --mount=type=secret,id=codegraph_ca,target=/tmp/codegraph-ca.crt,required=false \
    if [ -s /tmp/codegraph-ca.crt ]; then \
      cp /tmp/codegraph-ca.crt /usr/local/share/ca-certificates/codegraph-extra-ca.crt; \
      update-ca-certificates; \
      cat /tmp/codegraph-ca.crt >> /etc/ssl/certs/ca-certificates.crt; \
    fi
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
ENV NPM_CONFIG_CAFILE=/etc/ssl/certs/ca-certificates.crt

COPY package*.json ./
RUN npm config set cafile /etc/ssl/certs/ca-certificates.crt \
    && npm ci --omit=dev \
    && apk del python3 make g++

COPY --from=builder /app/dist ./dist

ENV CODEGRAPH_HOME=/codegraph-home
VOLUME ["/workspace", "/codegraph-home"]

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["mcp", "--root", "/workspace"]
