#!/usr/bin/env bash
set -euo pipefail
umask 077

CONTAINER="${BACKEND_CONTAINER:-cinetrack-backend-1}"
DB_CONTAINER="${DB_CONTAINER:-cinetrack-db-1}"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-$HOME/.cache/cinetrack}"
LOCK_FILE="${RELEASE_SCHEDULE_LOCK_FILE:-$RUNTIME_DIR/release-schedule-sync.lock}"
LOCK_DIR="$(dirname "$LOCK_FILE")"
STATE_DIR="${RELEASE_SCHEDULE_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/cinetrack}"
METRICS_FILE="${RELEASE_SCHEDULE_METRICS_FILE:-$STATE_DIR/release-schedule.prom}"
LAST_SUCCESS_FILE="$STATE_DIR/release-schedule.last_success"

mkdir -p "$LOCK_DIR"
chmod 700 "$LOCK_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "release schedule sync already running; skipping"
  exit 0
fi

mkdir -p "$STATE_DIR"
STARTED_AT="$(date +%s)"
SUCCESS=0
DB_METRICS_VALID=0
STALE_ACTIVE_TITLES=0
REPEATED_FAILURES=0
PUSH_FAILED_LAST_RUN=0
PUSH_OVERDUE_DELIVERIES=0

collect_database_metrics() {
  local query row
  query="
    WITH tracked AS (
      SELECT DISTINCT media.id, media.media_type, media.status
      FROM media
      WHERE (
        media.media_type = 'tv'
        AND EXISTS (
          SELECT 1 FROM user_media tracked
          WHERE tracked.media_id = media.id AND tracked.status <> 'dropped'
        )
      ) OR (
        media.media_type = 'movie'
        AND EXISTS (
          SELECT 1 FROM user_media tracked
          WHERE tracked.media_id = media.id AND tracked.status = 'plan_to_watch'
        )
      )
    )
    SELECT
      COUNT(*) FILTER (
        WHERE tracked.media_type = 'tv'
          AND LOWER(COALESCE(tracked.status, '')) NOT IN ('ended', 'canceled')
          -- A confirmed provider 404 is already retried with multi-day
          -- backoff. It is catalog state, not a stale refresh failure.
          AND COALESCE(state.outcome, '') <> 'not_found'
          AND (
            state.last_success_at IS NULL
            OR state.last_success_at < NOW() - INTERVAL '12 hours'
          )
      ),
      COUNT(*) FILTER (
        WHERE state.consecutive_failures >= 3
          -- A confirmed 404 is intentionally retried with multi-day backoff;
          -- it is catalog state, not an active provider failure.
          AND state.outcome <> 'not_found'
      ),
      (
        SELECT COUNT(*) FROM release_push_deliveries
        WHERE status = 'failed' AND updated_at >= TO_TIMESTAMP(${STARTED_AT})
      ),
      (
        SELECT COUNT(*) FROM release_push_deliveries
        WHERE (
          status = 'pending' AND next_attempt_at < NOW() - INTERVAL '2 hours'
        ) OR (
          status = 'ticketed' AND ticketed_at < NOW() - INTERVAL '24 hours'
        )
      )
    FROM tracked
    LEFT JOIN release_schedule_sync_state state ON state.media_id = tracked.id;
  "

  if row="$(
    docker exec "$DB_CONTAINER" sh -eu -c \
      'exec psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-psqlrc --tuples-only --no-align --field-separator=, --command "$1"' \
      sh "$query" 2>/dev/null
  )" && [[ "$row" =~ ^[0-9]+,[0-9]+,[0-9]+,[0-9]+$ ]]; then
    IFS=, read -r STALE_ACTIVE_TITLES REPEATED_FAILURES \
      PUSH_FAILED_LAST_RUN PUSH_OVERDUE_DELIVERIES <<< "$row"
    DB_METRICS_VALID=1
  else
    echo "release schedule database metrics could not be collected" >&2
  fi
}

write_metrics() {
  local last_success tmp
  last_success=0
  if [[ -r "$LAST_SUCCESS_FILE" ]]; then
    read -r last_success < "$LAST_SUCCESS_FILE" || last_success=0
  fi
  [[ "$last_success" =~ ^[0-9]+$ ]] || last_success=0

  tmp="$(mktemp "${METRICS_FILE}.tmp.XXXXXX")"
  {
    printf '# HELP cinetrack_release_worker_last_run_success Whether the last completed release worker run succeeded.\n'
    printf '# TYPE cinetrack_release_worker_last_run_success gauge\n'
    printf 'cinetrack_release_worker_last_run_success %s\n' "$SUCCESS"
    printf '# HELP cinetrack_release_worker_last_run_timestamp_seconds Start time of the last release worker run.\n'
    printf '# TYPE cinetrack_release_worker_last_run_timestamp_seconds gauge\n'
    printf 'cinetrack_release_worker_last_run_timestamp_seconds %s\n' "$STARTED_AT"
    printf '# HELP cinetrack_release_worker_last_success_timestamp_seconds Completion time of the last successful release worker run.\n'
    printf '# TYPE cinetrack_release_worker_last_success_timestamp_seconds gauge\n'
    printf 'cinetrack_release_worker_last_success_timestamp_seconds %s\n' "$last_success"
    printf '# HELP cinetrack_release_worker_database_metrics_valid Whether database health gauges were collected successfully.\n'
    printf '# TYPE cinetrack_release_worker_database_metrics_valid gauge\n'
    printf 'cinetrack_release_worker_database_metrics_valid %s\n' "$DB_METRICS_VALID"
    printf '# HELP cinetrack_release_schedule_stale_active_titles Active tracked TV titles without a successful refresh in 12 hours.\n'
    printf '# TYPE cinetrack_release_schedule_stale_active_titles gauge\n'
    printf 'cinetrack_release_schedule_stale_active_titles %s\n' "$STALE_ACTIVE_TITLES"
    printf '# HELP cinetrack_release_schedule_repeated_failures Tracked titles with at least three consecutive refresh failures.\n'
    printf '# TYPE cinetrack_release_schedule_repeated_failures gauge\n'
    printf 'cinetrack_release_schedule_repeated_failures %s\n' "$REPEATED_FAILURES"
    printf '# HELP cinetrack_release_push_failed_last_run Push deliveries that became terminal failures during the last worker run.\n'
    printf '# TYPE cinetrack_release_push_failed_last_run gauge\n'
    printf 'cinetrack_release_push_failed_last_run %s\n' "$PUSH_FAILED_LAST_RUN"
    printf '# HELP cinetrack_release_push_overdue_deliveries Push deliveries overdue for submission or receipt processing.\n'
    printf '# TYPE cinetrack_release_push_overdue_deliveries gauge\n'
    printf 'cinetrack_release_push_overdue_deliveries %s\n' "$PUSH_OVERDUE_DELIVERIES"
  } > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$METRICS_FILE"
}

finish() {
  local status=$?
  trap - EXIT
  collect_database_metrics
  if ! write_metrics; then
    echo "release schedule metrics could not be written to ${METRICS_FILE}" >&2
  fi
  exit "$status"
}
trap finish EXIT

if [[ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]]; then
  echo "release schedule backend container is not running" >&2
  exit 1
fi

docker exec "$CONTAINER" /usr/local/bin/cinetrack --sync-release-schedules
completed_at="$(date +%s)"
last_success_tmp="$(mktemp "${LAST_SUCCESS_FILE}.tmp.XXXXXX")"
printf '%s\n' "$completed_at" > "$last_success_tmp"
mv -f "$last_success_tmp" "$LAST_SUCCESS_FILE"
SUCCESS=1
