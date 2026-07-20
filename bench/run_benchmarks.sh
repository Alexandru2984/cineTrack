#!/usr/bin/env bash
# Run the whole benchmark suite against an isolated, seeded stack.
#
# Nothing here touches production: the backend is built in release mode, pointed
# at the disposable test database, and given its own port. The account it
# benchmarks is created fresh each run and seeded with a heavy library, so the
# numbers describe a loaded user rather than an empty one.
#
# Usage: bench/run_benchmarks.sh [--skip-micro] [--skip-api] [--skip-db]
#        bench/run_benchmarks.sh --capacity   (load ramp instead of the above)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BENCH_PORT="${BENCH_PORT:-18120}"
BASE_URL="http://127.0.0.1:${BENCH_PORT}"
DB_URL="${BENCH_DATABASE_URL:-postgres://test_user:test_pass@127.0.0.1:55433/cinetrack_test}"
RESULTS_DIR="$ROOT_DIR/bench/results"
STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_DIR="$RESULTS_DIR/$STAMP"

RUN_MICRO=1 RUN_API=1 RUN_DB=1 RUN_CAPACITY=0
for arg in "$@"; do
  case "$arg" in
    --skip-micro) RUN_MICRO=0 ;;
    --skip-api) RUN_API=0 ;;
    --skip-db) RUN_DB=0 ;;
    # Capacity is a load test, not a latency measurement, so it replaces the
    # other layers rather than running alongside and perturbing them.
    --capacity) RUN_CAPACITY=1; RUN_MICRO=0; RUN_API=0; RUN_DB=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

mkdir -p "$RUN_DIR"
BACKEND_PID=""

cleanup() {
  if [[ -n "$BACKEND_PID" ]]; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

require() {
  command -v "$1" >/dev/null || { echo "missing required tool: $1" >&2; exit 1; }
}

# ── Micro-benchmarks ────────────────────────────────────────────
# These need no server, so they run first and stand on their own.
if [[ "$RUN_MICRO" == 1 ]]; then
  log "Micro-benchmarks (crypto on the auth path)"
  ( cd "$ROOT_DIR/backend" && cargo bench --bench hot_paths ) \
    2>&1 | tee "$RUN_DIR/micro.txt"
fi

if [[ "$RUN_API" == 0 && "$RUN_DB" == 0 && "$RUN_CAPACITY" == 0 ]]; then
  echo "results in $RUN_DIR"
  exit 0
fi

require docker
if [[ -z "$(docker ps -qf publish=55433)" ]]; then
  echo "test database is not running; start it with docker compose -f docker-compose.test.yml up -d" >&2
  exit 1
fi

# ── Release backend against the test database ───────────────────
log "Building the backend in release mode"
# Debug builds are several times slower and would make every number meaningless.
( cd "$ROOT_DIR/backend" && cargo build --release --quiet )

log "Starting the benchmark backend on port $BENCH_PORT"
# Generated per run rather than written in the file: a literal here is a
# high-entropy string in version control, which secret scanning flags and
# which nobody should be tempted to copy. The tokens it signs live and die
# with this process.
BENCH_JWT_SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n=+/')"
env \
  APP_ENV=development APP_HOST=127.0.0.1 APP_PORT="$BENCH_PORT" \
  DATABASE_URL="$DB_URL" \
  JWT_SECRET="$BENCH_JWT_SECRET" \
  JWT_EXPIRY_MINUTES=60 JWT_REFRESH_EXPIRY_DAYS=30 \
  TMDB_API_KEY='dummy-not-used' TMDB_READ_ACCESS_TOKEN='' \
  FRONTEND_URL="$BASE_URL" CORS_ALLOWED_ORIGINS="$BASE_URL" \
  SMTP_HOST='' SMTP_USERNAME='' SMTP_PASSWORD='' \
  R2_S3_API='' R2_ENDPOINT='' R2_ACCESS_KEY_ID='' R2_SECRET_ACCESS_KEY='' \
  R2_BUCKET='' R2_PUBLIC_BASE_URL='' \
  RATE_LIMIT_REQUESTS_PER_SECOND=100 RATE_LIMIT_BURST_SIZE=1000 \
  RUST_LOG=warn \
  "$ROOT_DIR/backend/target/release/cinetrack" >"$RUN_DIR/backend.log" 2>&1 &
BACKEND_PID=$!

for _ in $(seq 1 60); do
  curl -fsS "$BASE_URL/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "$BASE_URL/api/health" >/dev/null || {
  echo "backend did not become healthy; see $RUN_DIR/backend.log" >&2
  exit 1
}

# ── Benchmark account ───────────────────────────────────────────
log "Creating and seeding the benchmark account"
SUFFIX="$(date +%s)"
REGISTER="$(curl -fsS -X POST "$BASE_URL/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"bench$SUFFIX\",\"email\":\"bench$SUFFIX@example.com\",\"password\":\"Benchmark123!\"}")"

TOKEN="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])' <<<"$REGISTER")"
USER_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["user"]["id"])' <<<"$REGISTER")"
echo "account $USER_ID"

docker exec -i "$(docker ps -qf publish=55433)" \
  psql -U test_user -d cinetrack_test -X -q -v user_id="'$USER_ID'" \
  < "$ROOT_DIR/bench/db/seed_bench_data.sql" | tee "$RUN_DIR/seed.txt"

# A seeded show for the browse scenario.
SHOW_ID="$(docker exec -i "$(docker ps -qf publish=55433)" psql -U test_user -d cinetrack_test -X -t -A \
  -c "SELECT tmdb_id FROM media WHERE media_type='tv' AND tmdb_id BETWEEN 9000001 AND 9000080 ORDER BY tmdb_id LIMIT 1;")"

# ── API benchmark ───────────────────────────────────────────────
if [[ "$RUN_API" == 1 ]]; then
  require k6
  log "API benchmark (mobile screens: latency and payload size)"
  ( cd "$RUN_DIR" && BASE_URL="$BASE_URL" TOKEN="$TOKEN" SHOW_ID="$SHOW_ID" \
      k6 run --summary-trend-stats='avg,min,med,p(95),p(99),max' \
      "$ROOT_DIR/bench/api/mobile_session.js" 2>&1 | tee api.txt )
fi

# ── Capacity ────────────────────────────────────────────────────
if [[ "$RUN_CAPACITY" == 1 ]]; then
  require k6
  require python3
  log "Capacity ramp (finding the point where the budget breaks)"
  ( cd "$RUN_DIR" && BASE_URL="$BASE_URL" TOKEN="$TOKEN" SHOW_ID="$SHOW_ID" \
      PEAK_RPS="${PEAK_RPS:-600}" \
      k6 run --out "csv=capacity.csv" "$ROOT_DIR/bench/api/capacity.js" 2>&1 | tee capacity.txt )
  log "Per-window breakdown"
  python3 "$ROOT_DIR/bench/analyze_capacity.py" "$RUN_DIR/capacity.csv" \
    | tee "$RUN_DIR/capacity-windows.txt"
fi

# ── Query plans ─────────────────────────────────────────────────
if [[ "$RUN_DB" == 1 ]]; then
  log "Query plans for the hot read paths"
  "$ROOT_DIR/bench/db/explain_hot_queries.sh" "$USER_ID" "$RUN_DIR/db.txt" >/dev/null
  sed -n '1,/^Full plans:/p' "$RUN_DIR/db.txt" | sed '$d'
fi

log "Results: $RUN_DIR"
