#!/bin/sh
# Container entrypoint for the MRI Experimental Design Planner.
#
# Runs as the unprivileged application user - there is no privilege drop step
# because the process never holds privileges in the first place.  Its only job
# is to make sure the data directory is usable before handing control to the
# server, so that an empty volume still starts a working planner.
set -eu

PROTOCOL_DIR="${PLANNER_PROTOCOL_DIR:-/data/scanner-parameters}"
PRESET_DIR="${PLANNER_PRESET_DIR:-/data/presets}"
EXPORT_DIR="${PLANNER_EXPORT_DIR:-/data/exports}"
AUTH_DIR="${PLANNER_AUTH_DIR:-/data/accounts}"
DEMO_BANK_DIR="${PLANNER_DEMO_BANK_DIR:-/data/demo-banks}"
SEED_DIR="${PLANNER_SEED_DIR:-/app/seed}"

die() {
  echo "planner: $1" >&2
  exit 1
}

ensure_dir() {
  target="$1"
  [ -d "$target" ] || mkdir -p "$target" 2>/dev/null \
    || die "cannot create $target. Mount a writable volume at /data, or run with --user \$(id -u):\$(id -g)."
  [ -w "$target" ] \
    || die "$target is not writable by uid $(id -u). Check the ownership of the mounted directory."
}

is_empty() {
  [ -z "$(ls -A "$1" 2>/dev/null)" ]
}

# A directory the server only ever reads, and can do without.  It is mounted
# read-only, so it must not be tested for writability - and when it is not
# there at all the demo player simply uses the bank inside the image.
optional_dir() {
  [ -d "$1" ] || echo "planner: no $1; the demo player will use its built-in bank" >&2
}

ensure_dir "$PROTOCOL_DIR"
ensure_dir "$PRESET_DIR"
ensure_dir "$EXPORT_DIR"
ensure_dir "$AUTH_DIR"
optional_dir "$DEMO_BANK_DIR"

# First start against an empty volume: lay down the protocol cards that shipped
# with the image.  An existing card set is never touched.
if is_empty "$PROTOCOL_DIR" && [ -d "$SEED_DIR/scanner-parameters" ]; then
  echo "planner: seeding $PROTOCOL_DIR from the image" >&2
  cp -R "$SEED_DIR/scanner-parameters/." "$PROTOCOL_DIR/"
fi

if is_empty "$PROTOCOL_DIR"; then
  die "no scanner parameter cards in $PROTOCOL_DIR and nothing to seed from."
fi

exec python /app/server.py "$@"
