#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_MAIN="$ROOT_DIR/backend/src/main.rs"
EDGE_CONFIG="$ROOT_DIR/nginx/vazute.micutu.com.conf"
FIXTURE_CONFIG="$ROOT_DIR/nginx/nginx.conf"

assert_contains() {
  local file="$1"
  local expected="$2"
  if ! grep -Fq -- "$expected" "$file"; then
    echo "expected $file to contain: $expected" >&2
    exit 1
  fi
}

assert_contains "$BACKEND_MAIN" \
  'r"^/api/calendar/feed/"'
assert_contains "$BACKEND_MAIN" \
  '.exclude_regex(CALENDAR_FEED_LOG_EXCLUDE_REGEX)'

for config in "$EDGE_CONFIG" "$FIXTURE_CONFIG"; do
  assert_contains "$config" \
    'location ^~ /api/calendar/feed/'
  assert_contains "$config" 'access_log off;'
  assert_contains "$config" 'error_log /dev/null crit;'
done

# The scrape endpoint is excluded too, and for a different reason: what it
# logged was false. The metrics middleware answers /metrics with 200 while the
# router never matches the path, so the logger recorded a 404 for a request that
# had already succeeded — about 3,900 invented 404s a day at a 15s interval.
assert_contains "$BACKEND_MAIN" 'METRICS_LOG_EXCLUDE_REGEX: &str = r"^/metrics$"'
assert_contains "$BACKEND_MAIN" '.exclude_regex(METRICS_LOG_EXCLUDE_REGEX)'

echo "Calendar feed log safety checks passed"
