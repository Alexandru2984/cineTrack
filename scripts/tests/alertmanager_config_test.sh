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
PASSWORD_OUTPUT_FILE="$TEST_DIR/smtp_password"

printf '%s\n' \
  'SMTP_HOST=smtp.example.com' \
  'SMTP_PORT=465' \
  'SMTP_USERNAME=alerts@example.com' \
  'SMTP_PASSWORD=test-password' \
  'ALERT_EMAIL_TO=operator@example.com' \
  > "$ENV_FILE"

ENV_FILE="$ENV_FILE" OUTPUT_FILE="$OUTPUT_FILE" \
  PASSWORD_OUTPUT_FILE="$PASSWORD_OUTPUT_FILE" \
  "$ROOT_DIR/scripts/render_alertmanager_config.sh" >/dev/null

for generated_file in "$OUTPUT_FILE" "$PASSWORD_OUTPUT_FILE"; do
  mode="$(stat -c '%a' "$generated_file")"
  if [[ "$mode" != "640" ]]; then
    echo "expected $generated_file mode 640, got $mode" >&2
    exit 1
  fi
done

if ! grep -Fq 'smtp.example.com:465' "$OUTPUT_FILE" || \
   ! grep -Fq 'smtp_auth_password_file: "/etc/alertmanager/secrets/smtp_password"' \
     "$OUTPUT_FILE"; then
  echo "rendered Alertmanager config did not contain the expected settings" >&2
  exit 1
fi

if grep -Fq 'test-password' "$OUTPUT_FILE" || \
   grep -Fq 'smtp_auth_password:' "$OUTPUT_FILE"; then
  echo "rendered Alertmanager config contains an inline SMTP password" >&2
  exit 1
fi

if [[ "$(cat "$PASSWORD_OUTPUT_FILE")" != "test-password" ]]; then
  echo "SMTP password file did not contain the expected value" >&2
  exit 1
fi

echo "Alertmanager config and secret-file checks passed"
