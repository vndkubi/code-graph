#!/usr/bin/env bash
# Build, export, and optionally run the mcp-code-graph Docker image.
# Works in WSL2, Linux, macOS.
#
# Usage:
#   ./docker-build.sh                              # build only
#   ./docker-build.sh --export                     # build + export to mcp-code-graph.tar.gz
#   ./docker-build.sh --export --out /tmp/img.tar.gz
#   ./docker-build.sh --run /path/to/project       # build + run HTTP server
#   ./docker-build.sh --run /path/to/project --port 3100
#
# Load exported image on another machine (WSL / Linux):
#   docker load -i mcp-code-graph.tar.gz

set -euo pipefail

IMAGE="mcp-code-graph:latest"
PORT=3100
RUN_MODE=false
EXPORT_MODE=false
PROJECT_PATH=""
OUT_FILE=""

# ─── Parse args ───────────────────────────────────────────────────────────────
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
    --port)
      PORT="$2"
      shift 2
      ;;
    --image)
      IMAGE="$2"
      shift 2
      ;;
    --help|-h)
      cat <<EOF
Usage: $0 [OPTIONS]

Options:
  --run <path>       Build then start HTTP server, mounting <path> as the project
  --export           Build then export image to tar.gz (transfer to WSL/Linux)
  --out <file>       Output path for --export (default: ./mcp-code-graph.tar.gz)
  --port <port>      HTTP port for --run (default: 3100)
  --image <name:tag> Docker image name (default: mcp-code-graph:latest)
  -h, --help         Show this help

Examples:
  ./docker-build.sh --export
  ./docker-build.sh --export --out /mnt/d/transfer/mcp-code-graph.tar.gz
  ./docker-build.sh --run /mnt/d/Projects/myapp
  ./docker-build.sh --run /mnt/d/Projects/myapp --port 3200
EOF
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

# ─── Export ───────────────────────────────────────────────────────────────────
if $EXPORT_MODE; then
  # Default output filename: <image-name>-<tag>.tar.gz next to this script
  if [[ -z "$OUT_FILE" ]]; then
    SAFE_NAME="${IMAGE//:/-}"          # mcp-code-graph:latest → mcp-code-graph-latest
    SAFE_NAME="${SAFE_NAME//\//-}"     # handle slashes in image names
    OUT_FILE="$(dirname "$0")/${SAFE_NAME}.tar.gz"
  fi

  # Ensure output directory exists
  mkdir -p "$(dirname "$OUT_FILE")"

  echo ""
  echo "▶ Exporting image to: $OUT_FILE"
  docker save "$IMAGE" | gzip > "$OUT_FILE"
  SIZE=$(du -sh "$OUT_FILE" | cut -f1)
  echo "✓ Exported: $OUT_FILE  ($SIZE)"
  echo ""
  echo "To load on another machine (WSL / Linux / CI):"
  echo "  docker load -i \"$OUT_FILE\""
  echo ""
  echo "To run after loading:"
  echo "  docker run --rm -v \"/path/to/project:/workspace:ro\" -p ${PORT}:3100 ${IMAGE}"
fi

# ─── Run ──────────────────────────────────────────────────────────────────────
if $RUN_MODE; then
  if [[ -z "$PROJECT_PATH" ]]; then
    echo "Error: --run requires a project path" >&2
    exit 1
  fi

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
fi

# ─── Usage hint (build-only mode) ─────────────────────────────────────────────
if ! $RUN_MODE && ! $EXPORT_MODE; then
  echo ""
  echo "Next steps:"
  echo ""
  echo "  Export image for transfer to WSL / another machine:"
  echo "    $0 --export"
  echo "    $0 --export --out /mnt/d/transfer/mcp-code-graph.tar.gz"
  echo ""
  echo "  Run directly:"
  echo "    docker run --rm -v \"/path/to/project:/workspace:ro\" -p ${PORT}:3100 ${IMAGE}"
  echo ""
  echo "  WSL example (D:\\Projects\\myapp → /mnt/d/Projects/myapp):"
  echo "    docker run --rm -v \"/mnt/d/Projects/myapp:/workspace:ro\" -p ${PORT}:3100 ${IMAGE}"
  echo ""
  echo "  VS Code .vscode/settings.json:"
  echo '    { "mcp": { "servers": { "code-graph": { "type": "http", "url": "http://localhost:'${PORT}'" } } } }'
fi
