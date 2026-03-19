#!/usr/bin/env bash
# Build and optionally run the mcp-code-graph Docker image.
# Works in WSL2, Linux, macOS.
#
# Usage:
#   ./docker-build.sh                    # build only
#   ./docker-build.sh --run /path/to/project   # build + run HTTP server
#   ./docker-build.sh --run /path/to/project --port 3100

set -euo pipefail

IMAGE="mcp-code-graph:latest"
PORT=3100
RUN_MODE=false
PROJECT_PATH=""

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --run)
      RUN_MODE=true
      PROJECT_PATH="$2"
      shift 2
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    --image)
      IMAGE="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [--run <project-path>] [--port <port>] [--image <name:tag>]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# ─── Build ────────────────────────────────────────────────────────────────────
echo "▶ Building Docker image: $IMAGE"
docker build -t "$IMAGE" .
echo "✓ Image built: $IMAGE"

# ─── Run ──────────────────────────────────────────────────────────────────────
if $RUN_MODE; then
  if [[ -z "$PROJECT_PATH" ]]; then
    echo "Error: --run requires a project path" >&2
    exit 1
  fi

  # Resolve absolute path and handle Windows-style paths from WSL
  # e.g.  /mnt/d/Projects/myapp  →  /mnt/d/Projects/myapp  (already good)
  ABS_PATH="$(realpath "$PROJECT_PATH")"

  echo ""
  echo "▶ Starting mcp-code-graph server"
  echo "  Project  : $ABS_PATH"
  echo "  HTTP port: $PORT"
  echo "  URL      : http://localhost:$PORT"
  echo ""

  docker run --rm -it \
    -v "${ABS_PATH}:/workspace:ro" \
    -p "${PORT}:3100" \
    "$IMAGE" \
    --root /workspace --transport http --port 3100

else
  echo ""
  echo "To run the container:"
  echo ""
  echo "  # Analyze a project via HTTP:"
  echo "  docker run --rm -v \"/path/to/project:/workspace:ro\" -p ${PORT}:3100 ${IMAGE}"
  echo ""
  echo "  # WSL example (Windows path /d/Projects/myapp = WSL /mnt/d/Projects/myapp):"
  echo "  docker run --rm -v \"/mnt/d/Projects/myapp:/workspace:ro\" -p ${PORT}:3100 ${IMAGE}"
  echo ""
  echo "Then add to VS Code .vscode/settings.json:"
  echo '  { "mcp": { "servers": { "code-graph": { "type": "http", "url": "http://localhost:'${PORT}'" } } } }'
fi
