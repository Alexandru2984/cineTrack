#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

mkdir -p "$TEST_DIR/bin" "$TEST_DIR/runtime" "$TEST_DIR/state"

cat > "$TEST_DIR/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$1" == "inspect" ]]; then
  printf 'true\n'
  exit 0
fi

if [[ "$1" == "exec" && "$2" == "fake-backend" ]]; then
  if [[ "${FAKE_SYNC_FAIL:-0}" == 1 ]]; then
    exit 23
  fi
  exit 0
fi

if [[ "$1" == "exec" && "$2" == "fake-db" ]]; then
  printf '%s\n' "${FAKE_DB_METRICS:-2,3,4,5}"
  exit 0
fi

exit 1
SH
chmod +x "$TEST_DIR/bin/docker"

run_sync() {
  PATH="$TEST_DIR/bin:$PATH" \
    BACKEND_CONTAINER=fake-backend \
    DB_CONTAINER=fake-db \
    XDG_RUNTIME_DIR="$TEST_DIR/runtime" \
    RELEASE_SCHEDULE_STATE_DIR="$TEST_DIR/state" \
    "$ROOT_DIR/scripts/sync_release_schedules.sh"
}

run_sync
METRICS_FILE="$TEST_DIR/state/release-schedule.prom"
grep -qx 'cinetrack_release_worker_last_run_success 1' "$METRICS_FILE"
grep -qx 'cinetrack_release_worker_database_metrics_valid 1' "$METRICS_FILE"
grep -qx 'cinetrack_release_schedule_stale_active_titles 2' "$METRICS_FILE"
grep -qx 'cinetrack_release_schedule_repeated_failures 3' "$METRICS_FILE"
grep -qx 'cinetrack_release_push_failed_last_run 4' "$METRICS_FILE"
grep -qx 'cinetrack_release_push_overdue_deliveries 5' "$METRICS_FILE"
first_success="$(awk '/^cinetrack_release_worker_last_success_timestamp_seconds / { print $2 }' "$METRICS_FILE")"
[[ "$first_success" =~ ^[0-9]+$ ]] && (( first_success > 0 ))

if FAKE_SYNC_FAIL=1 run_sync; then
  echo "expected the failed worker run to return a non-zero status" >&2
  exit 1
fi
grep -qx 'cinetrack_release_worker_last_run_success 0' "$METRICS_FILE"
grep -qx "cinetrack_release_worker_last_success_timestamp_seconds ${first_success}" "$METRICS_FILE"

FAKE_DB_METRICS=invalid run_sync
grep -qx 'cinetrack_release_worker_last_run_success 1' "$METRICS_FILE"
grep -qx 'cinetrack_release_worker_database_metrics_valid 0' "$METRICS_FILE"

echo "release schedule metrics tests passed"
