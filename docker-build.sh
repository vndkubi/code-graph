#!/usr/bin/env bash
# Build, export, and optionally run the mcp-code-graph Docker image.
# Works in WSL2, Linux, and macOS.
#
# Usage:
#   ./docker-build.sh
#   ./docker-build.sh --export
#   ./docker-build.sh --export --out /tmp/img.tar.gz
#   ./docker-build.sh --ca-cert /path/to/corp-root-ca.crt --export
#   ./docker-build.sh --run /path/to/project

set -euo pipefail

IMAGE="mcp-code-graph:latest"
RUN_MODE=false
EXPORT_MODE=false
PROJECT_PATH=""
OUT_FILE=""
CA_CERT=""
NO_CACHE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run)
      RUN_MODE=true
      PROJECT_PATH="$2"
      shift 2
      ;;
    --export)
      EXPORT_MODE=true
      shift
      ;;
    --out)
      OUT_FILE="$2"
      shift 2
      ;;
    --image)
      IMAGE="$2"
      shift 2
      ;;
    --ca-cert)
      CA_CERT="$2"
      shift 2
      ;;
    --no-cache)
      NO_CACHE=true
      shift
      ;;
    --help|-h)
      cat <<EOF
Usage: $0 [OPTIONS]

Options:
  --run <path>       Build then start v2 MCP stdio proxy, mounting <path> as the project.
  --export           Build then export image to tar.gz.
  --out <file>       Output path for --export.
  --image <name:tag> Docker image name. Default: mcp-code-graph:latest.
  --ca-cert <file>   Add a PEM/CRT corporate CA certificate to the build/runtime image.
  --no-cache         Build without Docker layer cache.
  -h, --help         Show this help.

Examples:
  $0 --export
  $0 --ca-cert /mnt/c/temp/corp-root-ca.crt --export
  $0 --export --out /mnt/d/transfer/mcp-code-graph.tar.gz
  $0 --run /mnt/d/Projects/myapp
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

BUILD_ARGS=()
if $NO_CACHE; then
  BUILD_ARGS+=(--no-cache)
fi
if [[ -n "$CA_CERT" ]]; then
  CA_CERT="$(realpath "$CA_CERT")"
  if [[ ! -f "$CA_CERT" ]]; then
    echo "Error: --ca-cert file does not exist: $CA_CERT" >&2
    exit 1
  fi
  export DOCKER_BUILDKIT=1
  BUILD_ARGS+=(--secret "id=codegraph_ca,src=$CA_CERT")
fi

print_certificate_build_help() {
  cat >&2 <<'EOF'

Docker build failed with UNABLE_TO_GET_ISSUER_CERT_LOCALLY.
The container does not trust the HTTPS issuer used for npm downloads.

If the failing URL is unofficial-builds.nodejs.org, pull the latest Dockerfile.
It forces native addons such as better-sqlite3 to use local Node headers
with NPM_CONFIG_NODEDIR=/usr/local instead of downloading headers.

Fix:
  1. Export your corporate/root CA as PEM or CRT.
  2. Rebuild with:
     ./docker-build.sh --ca-cert /path/to/corp-root-ca.crt

Do not use npm strict-ssl=false; pass the issuer CA into the image instead.
EOF
}

echo "Building Docker image: $IMAGE"
BUILD_LOG="$(mktemp "${TMPDIR:-/tmp}/codegraph-docker-build.XXXXXX")"
trap 'rm -f "$BUILD_LOG"' EXIT
if ! docker build "${BUILD_ARGS[@]}" -t "$IMAGE" . 2>&1 | tee "$BUILD_LOG"; then
  if grep -q "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" "$BUILD_LOG"; then
    print_certificate_build_help
  fi
  exit 1
fi
echo "Image built: $IMAGE"

if $EXPORT_MODE; then
  if [[ -z "$OUT_FILE" ]]; then
    SAFE_NAME="${IMAGE//:/-}"
    SAFE_NAME="${SAFE_NAME//\//-}"
    OUT_FILE="$(dirname "$0")/${SAFE_NAME}.tar.gz"
  fi

  mkdir -p "$(dirname "$OUT_FILE")"

  echo ""
  echo "Exporting image to: $OUT_FILE"
  docker save "$IMAGE" | gzip > "$OUT_FILE"
  SIZE=$(du -sh "$OUT_FILE" | cut -f1)
  echo "Exported: $OUT_FILE ($SIZE)"
  echo ""
  echo "To load on another machine:"
  echo "  docker load -i \"$OUT_FILE\""
  echo ""
  echo "To run after loading:"
  echo "  docker run --rm -i -v \"/path/to/project:/workspace:ro\" -v codegraph-cache:/codegraph-home -e CODEGRAPH_WORKSPACE_KEY=\"/path/to/project\" -e CODEGRAPH_DATABASE_URL=\"postgres://codegraph:codegraph_local@host.docker.internal:54329/codegraph\" -e CODEGRAPH_PG_POOL_MAX=10 $IMAGE mcp --root /workspace --auto-refresh"
fi

if $RUN_MODE; then
  if [[ -z "$PROJECT_PATH" ]]; then
    echo "Error: --run requires a project path" >&2
    exit 1
  fi

  ABS_PATH="$(realpath "$PROJECT_PATH")"

  echo ""
  echo "Starting mcp-code-graph v2 MCP proxy"
  echo "  Project: $ABS_PATH"
  echo ""

  docker run --rm -i \
    -v "${ABS_PATH}:/workspace:ro" \
    -v codegraph-cache:/codegraph-home \
    -e "CODEGRAPH_WORKSPACE_KEY=${ABS_PATH}" \
    -e "CODEGRAPH_DATABASE_URL=postgres://codegraph:codegraph_local@host.docker.internal:54329/codegraph" \
    -e "CODEGRAPH_PG_POOL_MAX=10" \
    "$IMAGE" \
    mcp --root /workspace --auto-refresh
fi

if ! $RUN_MODE && ! $EXPORT_MODE; then
  echo ""
  echo "Next steps:"
  echo ""
  echo "  Export image for transfer:"
  echo "    $0 --export"
  echo "    $0 --ca-cert /mnt/c/temp/corp-root-ca.crt --export"
  echo ""
  echo "  Run MCP stdio proxy directly:"
  echo "    docker run --rm -i -v \"/path/to/project:/workspace:ro\" -v codegraph-cache:/codegraph-home -e CODEGRAPH_WORKSPACE_KEY=\"/path/to/project\" -e CODEGRAPH_DATABASE_URL=\"postgres://codegraph:codegraph_local@host.docker.internal:54329/codegraph\" -e CODEGRAPH_PG_POOL_MAX=10 $IMAGE mcp --root /workspace --auto-refresh"
  echo ""
  echo "  VS Code .vscode/settings.json:"
  echo '    { "mcp": { "servers": { "code-graph": { "type": "stdio", "command": "docker", "args": ["run", "--rm", "-i", "-v", "${workspaceFolder}:/workspace:ro", "-v", "codegraph-cache:/codegraph-home", "-e", "CODEGRAPH_WORKSPACE_KEY=${workspaceFolder}", "-e", "CODEGRAPH_DATABASE_URL=postgres://codegraph:codegraph_local@host.docker.internal:54329/codegraph", "-e", "CODEGRAPH_PG_POOL_MAX=10", "'${IMAGE}'", "mcp", "--root", "/workspace", "--auto-refresh"] } } } }'
fi
