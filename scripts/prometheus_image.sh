#!/usr/bin/env bash
set -euo pipefail

# Print the Prometheus image docker-compose.monitoring.yml runs, so the CI and
# local rule checks use the promtool production will load the rules with.
#
# The compose file holds the one pin, because it is the file Dependabot
# updates. Copies elsewhere did not move with it: on 2026-11-01 the checks
# still ran promtool 3.6.0 while Prometheus was on 3.15.
#
# Usage: prometheus_image.sh [compose file | -]

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose="${1:-$ROOT_DIR/docker-compose.monitoring.yml}"

image="$(awk '$1 == "image:" && $2 ~ /^prom\/prometheus:/ { print $2; exit }' "$compose")"
if [[ -z "$image" ]]; then
  echo "no prom/prometheus image in ${compose}" >&2
  exit 1
fi
printf '%s\n' "$image"
