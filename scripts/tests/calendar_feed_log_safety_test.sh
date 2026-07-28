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

echo "Calendar feed log safety checks passed"
