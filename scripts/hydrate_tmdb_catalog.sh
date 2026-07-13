#!/usr/bin/env bash
set -euo pipefail
umask 077

CONTAINER="${BACKEND_CONTAINER:-cinetrack-backend-1}"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-$HOME/.cache/cinetrack}"
LOCK_FILE="${CATALOG_HYDRATION_LOCK_FILE:-$RUNTIME_DIR/catalog-hydration.lock}"

mkdir -p -m 700 "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "catalog hydration already running; skipping"
  exit 0
fi

if [[ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]]; then
  echo "catalog backend container is not running" >&2
  exit 1
fi

docker exec "$CONTAINER" /usr/local/bin/cinetrack --hydrate-catalog
