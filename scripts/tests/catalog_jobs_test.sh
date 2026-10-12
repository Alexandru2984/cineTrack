#!/usr/bin/env bash
# The daily TMDB catalog jobs: which export the sync picks, and that both jobs
# publish their outcome. Both failed every day from August to October 2026 and
# wrote only to a log, so these guard the two things that would have caught it.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

python3 "$ROOT_DIR/scripts/tests/catalog_sync_test.py"

mkdir -p "$TEST_DIR/bin" "$TEST_DIR/runtime" "$TEST_DIR/state"
cat > "$TEST_DIR/bin/docker" <<'SH'
#!/usr/bin/env bash
if [[ "$1" == "inspect" ]]; then
  printf 'true\n'
  exit 0
fi
if [[ "$1" == "exec" && "$2" == "fake-backend" ]]; then
  [[ "${FAKE_HYDRATION_FAIL:-0}" == 1 ]] && exit 23
  exit 0
fi
exit 1
SH
chmod +x "$TEST_DIR/bin/docker"

METRICS_FILE="$TEST_DIR/state/catalog_hydration.prom"
run_hydration() {
  PATH="$TEST_DIR/bin:$PATH" \
    BACKEND_CONTAINER=fake-backend \
    XDG_RUNTIME_DIR="$TEST_DIR/runtime" \
    CATALOG_HYDRATION_METRICS_FILE="$METRICS_FILE" \
    "$ROOT_DIR/scripts/hydrate_tmdb_catalog.sh"
}

run_hydration
grep -qx 'cinetrack_catalog_hydration_success 1' "$METRICS_FILE"
grep -qE '^cinetrack_catalog_hydration_timestamp_seconds [0-9]+$' "$METRICS_FILE"

if FAKE_HYDRATION_FAIL=1 run_hydration; then
  echo "a failed hydration must exit non-zero" >&2
  exit 1
fi
grep -qx 'cinetrack_catalog_hydration_success 0' "$METRICS_FILE"

# A run that finds another one holding the lock did nothing, so it must not
# overwrite the outcome of the run that is actually working.
before="$(cat "$METRICS_FILE")"
exec 9>"$TEST_DIR/runtime/catalog-hydration.lock"
flock -n 9
run_hydration
exec 9>&-
[[ "$(cat "$METRICS_FILE")" == "$before" ]]

# Nothing is left half-written beside the metrics file.
if compgen -G "$METRICS_FILE.tmp.*" >/dev/null; then
  echo "temporary metrics files were left behind" >&2
  exit 1
fi

# Both cron entries must start after TMDB has published the day's exports.
grep -qF '15 11 * * * /path/to/cineTrack/scripts/sync_tmdb_catalog.py' "$ROOT_DIR/README.md"
grep -qF '0 12 * * * /path/to/cineTrack/scripts/hydrate_tmdb_catalog.sh' "$ROOT_DIR/README.md"

echo "Catalog job checks passed"
