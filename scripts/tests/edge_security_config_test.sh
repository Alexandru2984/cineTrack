#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

for config in \
  "$ROOT_DIR/nginx/vazute.micutu.com.conf" \
  "$ROOT_DIR/nginx/nginx.conf"; do
  grep -Fq 'location = /.well-known/security.txt' "$config"
  grep -Fq 'Contact: mailto:' "$config"
  grep -Fq 'Expires: 2027-07-27T23:59:59Z' "$config"
  grep -Fq 'Canonical: https://vazute.micutu.com/.well-known/security.txt' "$config"
  grep -Fq 'Policy: https://vazute.micutu.com/privacy' "$config"
done

echo "Edge security contact checks passed"
