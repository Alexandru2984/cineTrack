#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_DIR="$(mktemp -d)"

cleanup() {
  rm -rf -- "$TEST_DIR"
}
trap cleanup EXIT

ENV_FILE="$TEST_DIR/compose.env"
printf '%s\n' \
  'POSTGRES_DB=cinetrack' \
  'POSTGRES_USER=cinetrack_admin' \
  'POSTGRES_PASSWORD=test-password' \
  'APP_DATABASE_URL=postgres://app:test@db/cinetrack' \
  'MIGRATION_DATABASE_URL=postgres://migrator:test@db/cinetrack' \
  'FRONTEND_URL=https://example.test' \
  'JWT_SECRET=test-secret-that-is-at-least-32-bytes' \
  'TOTP_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000' \
  'TMDB_API_KEY=test-key' \
  'CORS_ALLOWED_ORIGINS=https://example.test' \
  'VITE_API_URL=https://example.test/api' \
  >"$ENV_FILE"

docker compose -f "$ROOT_DIR/docker-compose.prod.yml" --env-file "$ENV_FILE" \
  config --format json >"$TEST_DIR/prod.json"
docker compose -f "$ROOT_DIR/docker-compose.monitoring.yml" --env-file "$ENV_FILE" \
  config --format json >"$TEST_DIR/monitoring.json"

python3 - "$TEST_DIR/prod.json" "$TEST_DIR/monitoring.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    prod = json.load(source)
with open(sys.argv[2], encoding="utf-8") as source:
    monitoring = json.load(source)

for name in ("database", "metrics"):
    assert prod["networks"][name]["internal"] is True, name

assert set(prod["services"]["db"]["networks"]) == {"database"}
assert set(prod["services"]["backend"]["networks"]) == {
    "backend_egress",
    "database",
    "metrics",
}
assert set(prod["services"]["frontend"]["networks"]) == {"frontend_isolated"}

services = monitoring["services"]
assert set(services["prometheus"]["networks"]) == {"metrics", "monitoring"}
assert set(services["alertmanager"]["networks"]) == {"monitoring"}
assert set(services["node-exporter"]["networks"]) == {"monitoring"}

for name in ("prometheus", "alertmanager", "node-exporter"):
    service = services[name]
    assert "@sha256:" in service["image"], name
    assert service["read_only"] is True, name
    assert "ALL" in service["cap_drop"], name
    assert "no-new-privileges:true" in service["security_opt"], name
    assert service["pids_limit"] > 0, name
    assert service["logging"]["options"]["max-size"] == "10m", name
    assert service["logging"]["options"]["max-file"] == "3", name
    limits = service["deploy"]["resources"]["limits"]
    assert limits["memory"], name
    assert limits["cpus"], name
PY

echo "Deployment isolation and hardening checks passed"
