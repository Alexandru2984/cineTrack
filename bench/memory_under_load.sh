#!/usr/bin/env bash
# What the API costs in memory when several large requests arrive together.
#
# M11 of the September audit: the request budgets bound one payload each, not
# the memory of all of them at once. The import reads up to 24 MiB and parses it
# before taking one of the two job slots, and an export materialises whole
# collections. The container is capped, so the question is not whether a single
# request is bounded — it is how many concurrent ones fit under the cap.
#
# Nothing in bench/ measured memory. This does, by sampling the process RSS
# while driving the two paths that hold the most at once.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${BENCH_PORT:-18121}"
BASE="http://127.0.0.1:${PORT}"
DB_URL="${BENCH_DATABASE_URL:-postgres://test_user:test_pass@127.0.0.1:55433/cinetrack_test}"
CONCURRENCY="${CONCURRENCY:-12}"
CURLS=""
RUN_DIR="$(mktemp -d)"
trap 'rm -rf "$RUN_DIR"' EXIT

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

log "building the release binary"
( cd "$ROOT_DIR/backend" && cargo build --release --quiet )

SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n=+/')"
env \
  APP_ENV=development APP_HOST=127.0.0.1 APP_PORT="$PORT" \
  DATABASE_URL="$DB_URL" JWT_SECRET="$SECRET" \
  JWT_EXPIRY_MINUTES=60 JWT_REFRESH_EXPIRY_DAYS=30 \
  TMDB_API_KEY='dummy-not-used' TMDB_READ_ACCESS_TOKEN='' \
  FRONTEND_URL="$BASE" CORS_ALLOWED_ORIGINS="$BASE" \
  SMTP_HOST='' SMTP_USERNAME='' SMTP_PASSWORD='' \
  R2_S3_API='' R2_ENDPOINT='' R2_ACCESS_KEY_ID='' R2_SECRET_ACCESS_KEY='' \
  R2_BUCKET='' R2_PUBLIC_BASE_URL='' \
  RATE_LIMIT_REQUESTS_PER_SECOND=100 RATE_LIMIT_BURST_SIZE=1000 \
  RUST_LOG=warn \
  "$ROOT_DIR/backend/target/release/cinetrack" >"$RUN_DIR/backend.log" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; rm -rf "$RUN_DIR"' EXIT

for _ in $(seq 1 40); do
  curl -fsS "$BASE/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "$BASE/api/health" >/dev/null || { cat "$RUN_DIR/backend.log"; exit 1; }

rss_kb() { awk '/^VmRSS:/ {print $2}' "/proc/$PID/status" 2>/dev/null || echo 0; }
peak_kb() { awk '/^VmHWM:/ {print $2}' "/proc/$PID/status" 2>/dev/null || echo 0; }

log "idle RSS: $(( $(rss_kb) / 1024 )) MiB"

SUFFIX="$RANDOM$RANDOM"
EMAIL="memload${SUFFIX}@mailbox.dev"
TOKEN="$(curl -fsS -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"memload${SUFFIX}\",\"email\":\"${EMAIL}\",\"password\":\"Pass1234\",\"accepted_terms\":true,\"confirmed_minimum_age\":true}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')"

# A payload at the ceiling the route accepts, so each request holds as much as
# it is ever allowed to.
log "building a ~24 MiB import payload"
python3 - "$RUN_DIR/shows.json" <<'PY'
import json, sys

# The route caps titles at 5 000, so the bytes come from padding each one
# rather than from adding more: the aim is a request at the size ceiling, not
# a rejected one.
target = 23 * 1024 * 1024
titles = 5_000
pad = max(1, (target // titles) - 220)
rows = [
    {
        "id": {"tvdb": 100000 + i},
        "title": "A Show " + str(i) + " " + ("x" * pad),
        "seasons": [{"number": 1, "episodes": [{"number": 1, "watched_at": "2024-05-01T10:00:00Z"}]}],
    }
    for i in range(titles)
]
open(sys.argv[1], "w").write(json.dumps(rows))
PY
log "payload: $(( $(stat -c %s "$RUN_DIR/shows.json") / 1024 / 1024 )) MiB"

# Sampled from a background loop, so the peak is caught while the requests are
# in flight rather than after them.
HIGH_FILE="$RUN_DIR/high"
echo 0 >"$HIGH_FILE"
(
  while :; do
    CUR="$(rss_kb)"
    HIGH="$(cat "$HIGH_FILE" 2>/dev/null || echo 0)"
    if [ "$CUR" -gt "$HIGH" ]; then echo "$CUR" >"$HIGH_FILE"; fi
    sleep 0.1
  done
) &
SAMPLER=$!

log "firing $CONCURRENCY concurrent imports"
: >"$RUN_DIR/codes"
for _ in $(seq 1 "$CONCURRENCY"); do
  curl -s -o /dev/null -w "%{http_code}\n" --max-time 180 \
    -X POST "$BASE/api/import/tvtime" \
    -H "Authorization: Bearer $TOKEN" \
    -F "shows=@$RUN_DIR/shows.json;type=application/json" >>"$RUN_DIR/codes" &
  CURLS="$CURLS $!"
done
for job in $CURLS; do wait "$job" 2>/dev/null || true; done
sleep 1
kill "$SAMPLER" 2>/dev/null || true

log "responses: $(sort "$RUN_DIR/codes" | uniq -c | tr '\n' ' ')"
HIGH="$(cat "$HIGH_FILE")"

log "import peak RSS: $(( HIGH / 1024 )) MiB"

# The other half of M11, and the one still unbounded: an export materialises
# whole collections as JSON. Imports hold at most two payloads and object reads
# at most eight, both by semaphore — nothing limits how many exports run at
# once.
log "seeding a large history"
MEDIA_ID="$(psql "$DB_URL" -qtAX -c "INSERT INTO media (tmdb_id, media_type, title, status)
  VALUES (987654, 'tv', 'Export Load Show', 'Returning Series')
  ON CONFLICT DO NOTHING" -c "SELECT id FROM media WHERE tmdb_id = 987654 LIMIT 1" | tail -1)"
USER_ID="$(psql "$DB_URL" -qtAX -c "SELECT id FROM users WHERE email = '${EMAIL}'")"
psql "$DB_URL" -q -c "INSERT INTO watch_history (user_id, media_id, watched_at)
  SELECT '${USER_ID}'::uuid, '${MEDIA_ID}'::uuid, NOW() - (n || ' minutes')::interval
  FROM generate_series(1, ${EXPORT_ROWS:-60000}) n" >/dev/null
log "history rows: $(psql "$DB_URL" -qtAX -c "SELECT count(*) FROM watch_history WHERE user_id = '${USER_ID}'")"

echo 0 >"$HIGH_FILE"
(
  while :; do
    CUR="$(rss_kb)"
    HIGH="$(cat "$HIGH_FILE" 2>/dev/null || echo 0)"
    if [ "$CUR" -gt "$HIGH" ]; then echo "$CUR" >"$HIGH_FILE"; fi
    sleep 0.1
  done
) &
SAMPLER=$!

log "firing ${EXPORT_CONCURRENCY:-8} concurrent exports"
: >"$RUN_DIR/export_codes"
EXPORTS=""
for _ in $(seq 1 "${EXPORT_CONCURRENCY:-8}"); do
  curl -s -o /dev/null -w "%{http_code}\n" --max-time 180 \
    -X POST "$BASE/api/users/me/export" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"password":"Pass1234"}' >>"$RUN_DIR/export_codes" &
  EXPORTS="$EXPORTS $!"
done
for job in $EXPORTS; do wait "$job" 2>/dev/null || true; done
sleep 1
kill "$SAMPLER" 2>/dev/null || true

log "export responses: $(sort "$RUN_DIR/export_codes" | uniq -c | tr '\n' ' ')"
log "export peak RSS: $(( $(cat "$HIGH_FILE") / 1024 )) MiB"
log "process high-water mark: $(( $(peak_kb) / 1024 )) MiB"
log "container limit in production: 512 MiB"
