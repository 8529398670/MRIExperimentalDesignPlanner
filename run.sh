#!/usr/bin/env bash
# Launch the MRI Experimental Design Planner on the waitress production server.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PLANNER_PORT:-8760}"
HOST="${PLANNER_HOST:-127.0.0.1}"

if [ -x ".venv/bin/python" ]; then
  PY=".venv/bin/python"
else
  PY="$(command -v python3)"
fi

exec "$PY" server.py --host "$HOST" --port "$PORT" "$@"
