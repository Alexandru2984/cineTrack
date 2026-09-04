#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_PROJECT="cinetrack-test-local-${BASHPID}"
REALSTACK_PROJECT="cinetrack-e2e-local-${BASHPID}"
INTEGRATION_DB_PORT=""
REALSTACK_DB_PORT=""
FULL=false
TEMP_DIR=""
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.62.0-noble@sha256:baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07"

usage() {
  cat <<'EOF'
Usage: ./scripts/run_tests.sh [--full]

Runs the reproducible local CI gate. The default covers static analysis, unit
and integration tests, dependency audits, web/mobile builds, native config,
and operational security checks.

--full additionally runs every Playwright suite and production-container
build, vulnerability, misconfiguration, and SBOM validation.
EOF
}

case "${1:-}" in
  "") ;;
  --full) FULL=true ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

cleanup() {
  if [ -n "$INTEGRATION_DB_PORT" ]; then
    TEST_DB_PORT="$INTEGRATION_DB_PORT" docker compose -p "$TEST_PROJECT" \
      -f "$ROOT_DIR/docker-compose.test.yml" down >/dev/null 2>&1 || true
  fi
  if [ -n "$REALSTACK_DB_PORT" ]; then
    TEST_DB_PORT="$REALSTACK_DB_PORT" docker compose -p "$REALSTACK_PROJECT" \
      -f "$ROOT_DIR/docker-compose.test.yml" down >/dev/null 2>&1 || true
  fi
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf -- "$TEMP_DIR"
  fi
}

section() {
  printf '\n=== %s ===\n' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

free_loopback_port() {
  python3 - <<'PY'
import socket

with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    print(listener.getsockname()[1])
PY
}

run_containerized_playwright() {
  docker run --rm --init --ipc=host --network host \
    --volume "$ROOT_DIR:/repo:ro" \
    --tmpfs /repo/frontend/node_modules/.tmp:rw,exec,mode=1777 \
    --tmpfs /repo/frontend/node_modules/.vite:rw,exec,mode=1777 \
    --tmpfs /repo/frontend/node_modules/.vite-temp:rw,exec,mode=1777 \
    --workdir /repo/frontend --env CI=1 --env PLAYWRIGHT_EPHEMERAL_OUTPUT=true \
    "$PLAYWRIGHT_IMAGE" "$@"
}

trap cleanup EXIT
cd "$ROOT_DIR"

for command in cargo cargo-audit cargo-deny docker node npm npx python3; do
  require_command "$command"
done
if [ "$FULL" = true ]; then
  require_command jq
fi
INTEGRATION_DB_PORT="${TEST_DB_PORT:-$(free_loopback_port)}"
REALSTACK_DB_PORT="${E2E_TEST_DB_PORT:-$(free_loopback_port)}"

section "Release metadata"
scripts/check_release_metadata.sh

section "Backend"
(
  cd backend
  cargo fmt --check
  cargo clippy --all-targets -- -D warnings
  cargo test
  cargo audit
  cargo deny check --hide-inclusion-graph licenses sources bans
)

section "Frontend"
(
  cd frontend
  npm run lint
  npm test
  npm run build
  npm run check:bundle
  npm audit --audit-level=moderate
)

section "Mobile"
(
  cd mobile
  CI=1 npm run verify
  npm run audit:high
  CI=1 npm run export:android

  config_dir="$(mktemp -d)"
  trap 'rm -rf -- "$config_dir"' EXIT
  production_config="$config_dir/production.json"
  preview_config="$config_dir/preview.json"
  EAS_BUILD_PROFILE=production EXPO_UPDATES_ENABLED=true \
    npx expo config --type public --json >"$production_config"
  node -e 'const fs=require("node:fs"); const c=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if(c.updates?.enabled !== false) process.exit(1)' \
    "$production_config"
  EAS_BUILD_PROFILE=preview EXPO_UPDATES_ENABLED=true \
    npx expo config --type public --json >"$preview_config"
  node -e 'const fs=require("node:fs"); const c=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if(c.updates?.enabled !== true) process.exit(1)' \
    "$preview_config"
  rm -rf -- "$config_dir"
  trap - EXIT

  EAS_BUILD_PROFILE=production EXPO_UPDATES_ENABLED=false EXPO_USE_DEV_CLIENT=0 \
    npx expo prebuild --platform all --no-install --clean
  python3 scripts/validate_native_config.py
)

section "Operations and workflow security"
bash -n scripts/*.sh scripts/tests/*.sh
python3 scripts/check_dependency_policy.py
python3 scripts/tests/dependency_policy_test.py
python3 scripts/tests/advisory_sweep_resolved_test.py
python3 scripts/tests/capacity_analysis_test.py
python3 scripts/tests/check_embedded_python.py \
  scripts/backup_to_r2.sh scripts/restore_from_r2.sh \
  scripts/tests/deployment_hardening_test.sh \
  scripts/tests/ci_contract_test.sh \
  scripts/tests/edge_security_config_test.sh \
  scripts/tests/nginx_unfurl_routing_test.sh \
  scripts/tests/auto_deploy_test.sh
scripts/tests/ci_contract_test.sh
scripts/tests/backup_restore_test.sh
scripts/tests/release_schedule_metrics_test.sh
scripts/tests/alertmanager_config_test.sh
scripts/tests/metrics_scrape_auth_test.sh
scripts/tests/rust_audit_exceptions_test.sh
scripts/tests/container_scan_exceptions_test.sh
scripts/tests/deploy_drift_test.sh
scripts/tests/auto_deploy_test.sh
scripts/tests/crypto_core_parity_test.sh
scripts/tests/client_type_parity_test.py
scripts/tests/mobile_accessibility_test.py
scripts/tests/calendar_feed_log_safety_test.sh
scripts/tests/edge_security_config_test.sh
scripts/tests/nginx_unfurl_routing_test.sh
scripts/tests/spa_public_pages_test.sh
scripts/tests/rust_toolchain_test.sh
scripts/tests/deployment_hardening_test.sh
scripts/tests/secret_hygiene_test.sh
# Unlike the contract test above, this audits the real tree. It only means
# something where the secrets actually live, so a missing .env.prod (a fresh
# clone, a CI runner) is not a failure — the checker simply finds nothing.
scripts/check_secret_hygiene.sh
docker run --rm --volume "$ROOT_DIR:$ROOT_DIR:ro" --workdir "$ROOT_DIR" \
  rhysd/actionlint:1.7.7@sha256:1d74bfc9fd1963af8f89a7c22afaaafd42f49aad711a09951d02cb996398f61d \
  -color
docker run --rm --volume "$ROOT_DIR:$ROOT_DIR:ro" --workdir "$ROOT_DIR" \
  koalaman/shellcheck:v0.10.0@sha256:0fa384f2a6171aef8aab2999a531c8c8158727d54a8f20157a5c3c51a734d6b2 \
  --external-sources scripts/*.sh scripts/tests/*.sh bench/*.sh bench/db/*.sh
docker run --rm --volume "$ROOT_DIR:/repo:ro" --entrypoint promtool \
  prom/prometheus:v3.6.0@sha256:d9a702d3f7f398540e7190c4d80dbb8a0dc95c1e481e8ebd8a08e5bcf83cf735 \
  check rules /repo/ops/prometheus/cinetrack-alerts.yml

section "Backend integration"
TEST_DB_PORT="$INTEGRATION_DB_PORT" docker compose -p "$TEST_PROJECT" \
  -f docker-compose.test.yml up -d --wait
(
  cd backend
  TEST_DATABASE_URL="postgres://test_user:test_pass@127.0.0.1:$INTEGRATION_DB_PORT/cinetrack_test" \
    cargo test --test api_tests -- --ignored --test-threads=1
)
TEST_DB_PORT="$INTEGRATION_DB_PORT" docker compose -p "$TEST_PROJECT" \
  -f docker-compose.test.yml down

if [ "$FULL" = true ]; then
  section "Frontend browser E2E"
  # Keep Chromium/WebKit and their system libraries reproducible without
  # installing browser packages into the host. Source and dependencies are
  # read-only; generated output remains inside the disposable container.
  run_containerized_playwright npm run test:e2e
  run_containerized_playwright npm run test:e2e:pwa

  section "Frontend real-stack E2E"
  TEST_DB_PORT="$REALSTACK_DB_PORT" docker compose -p "$REALSTACK_PROJECT" \
    -f docker-compose.test.yml up -d --wait
  (
    cd frontend
    CI=1 E2E_DATABASE_URL="postgres://test_user:test_pass@127.0.0.1:$REALSTACK_DB_PORT/cinetrack_test" \
      npm run test:e2e:realstack
  )
  TEST_DB_PORT="$REALSTACK_DB_PORT" docker compose -p "$REALSTACK_PROJECT" \
    -f docker-compose.test.yml down

  section "Production container security"
  docker build --tag cinetrack-backend:local-ci --file backend/Dockerfile.prod backend
  docker build --tag cinetrack-frontend:local-ci --file frontend/Dockerfile.prod frontend

  TEMP_DIR="$(mktemp -d)"
  docker save --output "$TEMP_DIR/backend.tar" cinetrack-backend:local-ci
  docker save --output "$TEMP_DIR/frontend.tar" cinetrack-frontend:local-ci

  TRIVY_IMAGE="aquasec/trivy@sha256:cffe3f5161a47a6823fbd23d985795b3ed72a4c806da4c4df16266c02accdd6f"
  for image in backend frontend; do
    # `.trivyignore` has to be mounted and named. Trivy looks for it in the
    # working directory, which inside this container is not the repository, so
    # without both it is never read — and the scan then fails on findings CI
    # accepts through `trivyignores:` in the workflow.
    #
    # That divergence is worse than either behaviour on its own: the gate the
    # release process tells you to run locally rejects what the gate that
    # actually blocks the merge allows, and the reasoning recorded next to each
    # exception is invisible to the person staring at the failure.
    docker run --rm --volume "$TEMP_DIR:/evidence" \
      --volume "$ROOT_DIR/.trivyignore:/repo/.trivyignore:ro" "$TRIVY_IMAGE" image \
      --input "/evidence/$image.tar" --scanners vuln --severity HIGH,CRITICAL \
      --ignorefile /repo/.trivyignore --exit-code 1
    docker run --rm --volume "$TEMP_DIR:/evidence" "$TRIVY_IMAGE" image \
      --input "/evidence/$image.tar" --scanners vuln --format cyclonedx \
      --output "/evidence/$image.cdx.json"
    jq --exit-status '
      .bomFormat == "CycloneDX" and
      (.specVersion | type == "string") and
      (.components | type == "array" and length > 0)
    ' "$TEMP_DIR/$image.cdx.json" >/dev/null
  done
  docker run --rm --volume "$ROOT_DIR:/repo:ro" "$TRIVY_IMAGE" config \
    --severity HIGH,CRITICAL --exit-code 1 /repo
fi

trap - EXIT
cleanup
section "All local CI checks passed"
