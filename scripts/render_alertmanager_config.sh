#!/usr/bin/env bash
# Render the Alertmanager config from its template.
#
# Alertmanager does not expand environment variables in its own config, and
# doing the substitution in the container entrypoint does not work either:
# compose interpolates ${...} in the command string before the shell ever sees
# it, which mangles the patterns. So it happens here, on the host, once.
#
# The rendered YAML contains no SMTP password. The password is written to a
# separate mode-640 file mounted read-only into Alertmanager. Both generated
# files are git-ignored. Re-run after changing any ALERT_* or SMTP_* value in
# .env.prod, then restart Alertmanager.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.prod}"
TEMPLATE="${TEMPLATE_FILE:-$ROOT_DIR/ops/alertmanager/alertmanager.yml.tmpl}"
OUTPUT="${OUTPUT_FILE:-$ROOT_DIR/ops/alertmanager/alertmanager.generated.yml}"
PASSWORD_OUTPUT="${PASSWORD_OUTPUT_FILE:-$ROOT_DIR/ops/alertmanager/smtp_password.generated}"

# Only well-formed KEY=VALUE lines, so an unquoted value elsewhere in the file
# cannot break this.
set -a
# shellcheck disable=SC1090
source <(grep -E '^(ALERT_|SMTP_)[A-Z_]+=' "$ENV_FILE")
set +a

: "${SMTP_HOST:?SMTP_HOST not set}"
: "${SMTP_USERNAME:?SMTP_USERNAME not set}"
: "${SMTP_PASSWORD:?SMTP_PASSWORD not set}"
: "${ALERT_EMAIL_TO:?ALERT_EMAIL_TO not set}"

export ALERT_SMTP_HOST="$SMTP_HOST"
export ALERT_SMTP_PORT="${SMTP_PORT:-465}"
export ALERT_SMTP_FROM="${ALERT_SMTP_FROM:-alerts@micutu.com}"
export ALERT_SMTP_USERNAME="$SMTP_USERNAME"

umask 027
envsubst < "$TEMPLATE" > "$OUTPUT"
printf '%s' "$SMTP_PASSWORD" > "$PASSWORD_OUTPUT"
chmod 0640 "$OUTPUT"
chmod 0640 "$PASSWORD_OUTPUT"
echo "rendered $OUTPUT and SMTP password file"
