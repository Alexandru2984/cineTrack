#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_PROJECT="cinetrack-test"

cleanup() {
  docker compose -p "$TEST_PROJECT" -f "$ROOT_DIR/docker-compose.test.yml" down >/dev/null 2>&1 || true
}

trap cleanup EXIT
cd "$ROOT_DIR"

echo "=== Backend Unit Tests ==="
cd backend
cargo test 2>&1 | grep -E "test |test result:|running"
echo ""

echo "=== Frontend Tests ==="
cd ../frontend
npx vitest run 2>&1 | grep -E "✓|✗|Test Files|Tests|Duration"
echo ""

echo "=== Mobile Checks ==="
cd ../mobile
CI=1 npm run verify
CI=1 npm run export:android
echo ""

echo "=== Backend Integration Tests ==="
echo "Starting test database..."
cd ..
docker compose -p "$TEST_PROJECT" -f docker-compose.test.yml up -d --wait 2>/dev/null

echo "Running integration tests..."
cd backend
export TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgres://test_user:test_pass@127.0.0.1:${TEST_DB_PORT:-55433}/cinetrack_test}"
cargo test --test api_tests -- --ignored --test-threads=1 2>&1 | grep -E "test |test result:|running"

echo ""
echo "Cleaning up test database..."
cd ..
cleanup
trap - EXIT

echo ""
echo "=== All tests complete ==="
