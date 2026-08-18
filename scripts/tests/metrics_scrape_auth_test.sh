#!/usr/bin/env bash
# Contract tests for the /metrics scrape credential.
#
# Three separate pieces have to agree or monitoring silently breaks: the backend
# demands a bearer token, Prometheus reads that token from a mounted file, and a
# script writes that file from .env.prod. Each is individually plausible while
# the whole is wrong — the failure mode is a dashboard that goes flat, which
# nobody notices until they need it during an incident.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_DIR="$(mktemp -d)"

cleanup() {
  rm -rf -- "$TEST_DIR"
}
trap cleanup EXIT

fail() {
  echo "metrics scrape auth error: $1" >&2
  exit 1
}

# ── The renderer writes a usable credential file ────────────────────────

ENV_FILE="$TEST_DIR/metrics.env"
OUTPUT_FILE="$TEST_DIR/metrics_token"
# Long enough to satisfy the renderer's length floor, and deliberately
# low-entropy and self-describing so no scanner mistakes it for a real one.
TOKEN="not-a-real-token-fixture-for-tests-only-aaaaaaaaaaaaaaaa"

printf 'METRICS_BEARER_TOKEN=%s\n' "$TOKEN" > "$ENV_FILE"
ENV_FILE="$ENV_FILE" OUTPUT_FILE="$OUTPUT_FILE" \
  "$ROOT_DIR/scripts/render_metrics_token.sh" >/dev/null

mode="$(stat -c '%a' "$OUTPUT_FILE")"
[[ "$mode" == "640" ]] || fail "expected token file mode 640, got $mode"

# Byte-exact, with no trailing newline: Prometheus sends the file verbatim, so
# a stray newline would be part of the credential and every scrape would 401.
actual="$(cat "$OUTPUT_FILE")"
[[ "$actual" == "$TOKEN" ]] || fail "token file content does not match the configured token"
[[ "$(wc -c < "$OUTPUT_FILE")" -eq "${#TOKEN}" ]] || fail "token file has trailing bytes"

# ── The renderer refuses a weak or missing token ────────────────────────

printf 'METRICS_BEARER_TOKEN=short\n' > "$ENV_FILE"
if ENV_FILE="$ENV_FILE" OUTPUT_FILE="$TEST_DIR/rejected" \
  "$ROOT_DIR/scripts/render_metrics_token.sh" >/dev/null 2>&1; then
  fail "a short token was accepted"
fi

printf '# no token here\n' > "$ENV_FILE"
if ENV_FILE="$ENV_FILE" OUTPUT_FILE="$TEST_DIR/rejected" \
  "$ROOT_DIR/scripts/render_metrics_token.sh" >/dev/null 2>&1; then
  fail "a missing token was accepted"
fi

# ── Prometheus asks for the file the renderer writes ────────────────────

python3 - "$ROOT_DIR" <<'PY'
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
prometheus = (root / "ops/prometheus/prometheus.yml").read_text(encoding="utf-8")
monitoring = (root / "docker-compose.monitoring.yml").read_text(encoding="utf-8")
production = (root / "docker-compose.prod.yml").read_text(encoding="utf-8")
gitignore = (root / ".gitignore").read_text(encoding="utf-8")

CONTAINER_PATH = "/etc/prometheus/secrets/metrics_token"
HOST_PATH = "./ops/prometheus/metrics_token.generated"

assert "credentials_file: " + CONTAINER_PATH in prometheus, (
    "the backend scrape job does not read the credential file"
)
assert "type: Bearer" in prometheus, "the scrape job does not use bearer auth"
assert f"{HOST_PATH}:{CONTAINER_PATH}:ro" in monitoring, (
    "Prometheus does not mount the generated credential file read-only"
)
# Prometheus keeps the image's unprivileged user and adds the group that owns
# the mode-640 credential; without the group it cannot read its own token.
assert 'user: "nobody:${METRICS_GID:-1001}"' in monitoring, (
    "Prometheus cannot read a mode-640 credential without the metrics group"
)
assert "ops/prometheus/metrics_token.generated" in gitignore, (
    "the generated credential file is not gitignored"
)

# The backend must fail the deploy rather than start an unauthenticated
# endpoint, so the variable is required with `:?` rather than defaulted.
assert "METRICS_BEARER_TOKEN: \"${METRICS_BEARER_TOKEN:?" in production, (
    "production does not require METRICS_BEARER_TOKEN"
)

# The token itself must never be committed anywhere.
for name, text in (
    ("prometheus.yml", prometheus),
    ("docker-compose.monitoring.yml", monitoring),
):
    assert "credentials:" not in text, f"{name} carries an inline credential"
PY

echo "Metrics scrape credential checks passed"
