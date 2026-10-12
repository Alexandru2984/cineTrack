#!/usr/bin/env bash
set -euo pipefail
umask 077

CONTAINER="${BACKEND_CONTAINER:-cinetrack-backend-1}"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-$HOME/.cache/cinetrack}"
LOCK_FILE="${CATALOG_HYDRATION_LOCK_FILE:-$RUNTIME_DIR/catalog-hydration.lock}"
LOCK_DIR="$(dirname "$LOCK_FILE")"
STATE_DIR="${BACKUP_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/cinetrack}"
METRICS_FILE="${CATALOG_HYDRATION_METRICS_FILE:-$STATE_DIR/catalog_hydration.prom}"

mkdir -p "$LOCK_DIR"
chmod 700 "$LOCK_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "catalog hydration already running; skipping"
  exit 0
fi

# Hydration failed every day from August to October 2026, behind a catalog
# sync that never succeeded, and nothing noticed. The outcome of every run that
# got past the lock is published for the node exporter now.
STARTED_AT="$(date +%s)"
SUCCESS=0

write_metrics() {
  local finished_at tmp
  finished_at="$(date +%s)"
  mkdir -p "$(dirname "$METRICS_FILE")" || return 0
  tmp="$(mktemp "${METRICS_FILE}.tmp.XXXXXX")" || return 0
  {
    printf '# HELP cinetrack_catalog_hydration_success Whether the last catalog hydration run completed.\n'
    printf '# TYPE cinetrack_catalog_hydration_success gauge\n'
    printf 'cinetrack_catalog_hydration_success %s\n' "$SUCCESS"
    printf '# HELP cinetrack_catalog_hydration_timestamp_seconds Start time of the last catalog hydration run.\n'
    printf '# TYPE cinetrack_catalog_hydration_timestamp_seconds gauge\n'
    printf 'cinetrack_catalog_hydration_timestamp_seconds %s\n' "$STARTED_AT"
    printf '# HELP cinetrack_catalog_hydration_duration_seconds Duration of the last catalog hydration run.\n'
    printf '# TYPE cinetrack_catalog_hydration_duration_seconds gauge\n'
    printf 'cinetrack_catalog_hydration_duration_seconds %s\n' "$((finished_at - STARTED_AT))"
  } > "$tmp"
  if ! mv "$tmp" "$METRICS_FILE"; then
    rm -f "$tmp"
  fi
}
trap write_metrics EXIT

if [[ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]]; then
  echo "catalog backend container is not running" >&2
  exit 1
fi

docker exec "$CONTAINER" /usr/local/bin/cinetrack --hydrate-catalog
SUCCESS=1
