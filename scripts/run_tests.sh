#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "=== Backend Unit Tests ==="
cd backend
cargo test 2>&1 | grep -E "test |test result:|running"
echo ""

echo "=== Frontend Tests ==="
cd ../frontend
npx vitest run 2>&1 | grep -E "✓|✗|Test Files|Tests|Duration"
echo ""

echo "=== Backend Integration Tests ==="
echo "Starting test database..."
cd ..
docker compose -f docker-compose.test.yml up -d --wait 2>/dev/null

echo "Running integration tests..."
cd backend
TEST_DATABASE_URL="postgres://test_user:test_pass@127.0.0.1:5433/cinetrack_test" \
  cargo test --test api_tests -- --ignored --test-threads=1 2>&1 | grep -E "test |test result:|running"

echo ""
echo "Cleaning up test database..."
cd ..
docker compose -f docker-compose.test.yml down 2>/dev/null

echo ""
echo "=== All tests complete ==="
