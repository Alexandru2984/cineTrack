#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_DIR="$(mktemp -d)"

cleanup() {
  rm -rf -- "$TEST_DIR"
}
trap cleanup EXIT

ENV_FILE="$TEST_DIR/alertmanager.env"
OUTPUT_FILE="$TEST_DIR/alertmanager.yml"

printf '%s\n' \
  'SMTP_HOST=smtp.example.com' \
  'SMTP_PORT=465' \
  'SMTP_USERNAME=alerts@example.com' \
  'SMTP_PASSWORD=test-password' \
  'ALERT_EMAIL_TO=operator@example.com' \
  > "$ENV_FILE"

ENV_FILE="$ENV_FILE" OUTPUT_FILE="$OUTPUT_FILE" \
  "$ROOT_DIR/scripts/render_alertmanager_config.sh" >/dev/null

mode="$(stat -c '%a' "$OUTPUT_FILE")"
if [[ "$mode" != "640" ]]; then
  echo "expected rendered Alertmanager config mode 640, got $mode" >&2
  exit 1
fi

if ! grep -Fq 'smtp.example.com:465' "$OUTPUT_FILE" || \
   ! grep -Fq 'test-password' "$OUTPUT_FILE"; then
  echo "rendered Alertmanager config did not contain the substituted values" >&2
  exit 1
fi

echo "Alertmanager config permissions passed"
