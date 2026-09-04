#!/usr/bin/env bash
# Build and run the MRI Experimental Design Planner in a hardened container.
#
#   ./dockerRun.sh                 build if needed, start detached, print the URL
#   ./dockerRun.sh --foreground    run in the terminal, Ctrl-C to stop
#   ./dockerRun.sh --rebuild       force a fresh image build first
#   ./dockerRun.sh --port 9000     publish on a different host port
#   ./dockerRun.sh --bind 0.0.0.0  expose beyond localhost (see the warning below)
#   ./dockerRun.sh --logs          follow the running container's logs
#   ./dockerRun.sh --stop          stop and remove the container
#
# The container runs as your own uid/gid with a read-only root filesystem, no
# capabilities and no ability to gain privileges.  Protocol cards, presets and
# exports are bind-mounted from this checkout, so the container and a local
# ./run.sh see exactly the same files.
set -euo pipefail
cd "$(dirname "$0")"

IMAGE="${PLANNER_IMAGE:-mri-planner:latest}"
CONTAINER="${PLANNER_CONTAINER:-mri-planner}"
HOST_PORT="${PLANNER_PORT:-8761}"
CONTAINER_PORT=8761
# Loopback only by default: the planner has no authentication, and its API can
# rewrite the protocol cards.  Only widen this on a network you control.
BIND_ADDR="${PLANNER_BIND:-127.0.0.1}"
DATA_DIR="${PLANNER_DATA_DIR:-$PWD}"
MEMORY="${PLANNER_MEMORY:-1g}"
CPUS="${PLANNER_CPUS:-2}"

REBUILD=0
FOREGROUND=0
ACTION="run"

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --rebuild)     REBUILD=1 ;;
    --foreground|--fg) FOREGROUND=1 ;;
    --port)        HOST_PORT="$2"; shift ;;
    --bind)        BIND_ADDR="$2"; shift ;;
    --data)        DATA_DIR="$2"; shift ;;
    --image)       IMAGE="$2"; shift ;;
    --name)        CONTAINER="$2"; shift ;;
    --build)       ACTION="build" ;;
    --stop)        ACTION="stop" ;;
    --logs)        ACTION="logs" ;;
    --shell)       ACTION="shell" ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

if command -v docker >/dev/null 2>&1; then
  ENGINE=docker
elif command -v podman >/dev/null 2>&1; then
  ENGINE=podman
else
  echo "neither docker nor podman is on PATH" >&2
  exit 1
fi

$ENGINE info >/dev/null 2>&1 || {
  echo "$ENGINE is installed but not responding - is the daemon running?" >&2
  exit 1
}

# Run as the invoking user so that files written into the bind mounts stay
# owned by you.  Falling back to the image's own unprivileged user when this
# script is run as root keeps the container non-root either way.
RUN_UID="$(id -u)"
RUN_GID="$(id -g)"
if [ "$RUN_UID" = "0" ]; then
  RUN_USER="10001:10001"
else
  RUN_USER="${RUN_UID}:${RUN_GID}"
fi

build() {
  echo "==> building $IMAGE"
  $ENGINE build --pull -t "$IMAGE" .
}

running() {
  [ -n "$($ENGINE ps -q -f "name=^${CONTAINER}$" 2>/dev/null)" ]
}

exists() {
  [ -n "$($ENGINE ps -aq -f "name=^${CONTAINER}$" 2>/dev/null)" ]
}

case "$ACTION" in
  build) build; exit 0 ;;
  stop)
    exists && $ENGINE rm -f "$CONTAINER" >/dev/null && echo "removed $CONTAINER" \
      || echo "no container named $CONTAINER"
    exit 0
    ;;
  logs)  exec $ENGINE logs -f "$CONTAINER" ;;
  shell)
    # The image has no shell for the app user by design; this opens one as root
    # in a throwaway container for inspection only.
    exec $ENGINE run --rm -it --entrypoint /bin/sh --user 0:0 "$IMAGE"
    ;;
esac

if [ "$REBUILD" = "1" ] || ! $ENGINE image inspect "$IMAGE" >/dev/null 2>&1; then
  build
fi

mkdir -p "$DATA_DIR/scanner-parameters" "$DATA_DIR/presets" "$DATA_DIR/exports"

exists && $ENGINE rm -f "$CONTAINER" >/dev/null

ARGS=(
  --name "$CONTAINER"
  --user "$RUN_USER"
  --publish "${BIND_ADDR}:${HOST_PORT}:${CONTAINER_PORT}"

  # --- hardening -------------------------------------------------------
  --read-only                                   # nothing writable but the mounts
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m  # scratch space, never executable
  --cap-drop ALL                                # no capabilities at all
  --security-opt no-new-privileges              # setuid binaries cannot escalate
  --pids-limit 256                              # bound runaway process creation
  --memory "$MEMORY" --memory-swap "$MEMORY"    # no swap, hard ceiling
  --cpus "$CPUS"

  # --- state ------------------------------------------------------------
  --volume "$DATA_DIR/scanner-parameters:/data/scanner-parameters"
  --volume "$DATA_DIR/presets:/data/presets"
  --volume "$DATA_DIR/exports:/data/exports"

  --env HOME=/tmp
  --env PLANNER_PORT="$CONTAINER_PORT"
)

if [ "$FOREGROUND" = "1" ]; then
  ARGS+=(--rm -it)
else
  ARGS+=(--detach --restart unless-stopped)
fi

if [ "$BIND_ADDR" != "127.0.0.1" ] && [ "$BIND_ADDR" != "localhost" ]; then
  echo "!! publishing on ${BIND_ADDR}: the planner has no authentication and its"
  echo "!! API can rewrite the protocol cards. Put it behind a proxy you trust."
fi

$ENGINE run "${ARGS[@]}" "$IMAGE"

if [ "$FOREGROUND" != "1" ]; then
  printf '\n  MRI Experimental Design Planner\n'
  printf '  ---------------------------------------------\n'
  printf '  container : %s (%s)\n' "$CONTAINER" "$IMAGE"
  printf '  user      : %s, read-only rootfs, no capabilities\n' "$RUN_USER"
  printf '  data      : %s/{scanner-parameters,presets,exports}\n' "$DATA_DIR"
  printf '  open      : http://%s:%s\n\n' "$BIND_ADDR" "$HOST_PORT"
  printf '  logs: ./dockerRun.sh --logs    stop: ./dockerRun.sh --stop\n\n'
fi
