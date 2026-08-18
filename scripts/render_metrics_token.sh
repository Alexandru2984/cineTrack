#!/usr/bin/env bash
# Write the Prometheus scrape credential to the file Prometheus mounts.
#
# `/metrics` is served on the backend's own port. nginx does not proxy it, which
# on a dedicated host is protection enough; this host publishes that port on
# 127.0.0.1 alongside roughly twenty unrelated containers, so the endpoint needs
# a credential rather than an assumption. The backend reads the token from
# METRICS_BEARER_TOKEN in .env.prod; Prometheus cannot read that file, and
# putting the token in its config would commit a secret, so it goes into a
# separate mode-640 file mounted read-only — the same shape already used for the
# Alertmanager SMTP password.
#
# Re-run after rotating METRICS_BEARER_TOKEN, then restart Prometheus. The
# generated file is git-ignored. Never prints the token.
#
#   scripts/render_metrics_token.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.prod}"
OUTPUT="${OUTPUT_FILE:-$ROOT_DIR/ops/prometheus/metrics_token.generated}"

# Only well-formed KEY=VALUE lines, so an unquoted value elsewhere in the file
# cannot break this.
set -a
# shellcheck disable=SC1090
source <(grep -E '^METRICS_BEARER_TOKEN=' "$ENV_FILE")
set +a

: "${METRICS_BEARER_TOKEN:?METRICS_BEARER_TOKEN not set in $ENV_FILE — generate one with: openssl rand -hex 32}"

if [ "${#METRICS_BEARER_TOKEN}" -lt 32 ]; then
  echo "error: METRICS_BEARER_TOKEN must be at least 32 characters" >&2
  exit 1
fi

umask 027
# No trailing newline: Prometheus sends the file's bytes verbatim as the
# credential, so a stray \n would be part of the token and every scrape would
# come back 401.
printf '%s' "$METRICS_BEARER_TOKEN" > "$OUTPUT"
chmod 0640 "$OUTPUT"
echo "wrote $OUTPUT (mode 0640)"
