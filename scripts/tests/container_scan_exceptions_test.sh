#!/usr/bin/env bash
# Check that each accepted container-image vulnerability still rests on a true
# claim.
#
# `.trivyignore` is a plain list with no way to express why, and a suppressed
# finding is invisible by design — precisely the combination that lets an
# exception outlive its reasoning. The reasoning is asserted here instead.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IGNORE_FILE="$ROOT_DIR/.trivyignore"

fail() {
  echo "container scan exception error: $1" >&2
  exit 1
}

[[ -f "$IGNORE_FILE" ]] || fail "$IGNORE_FILE is missing"

mapfile -t ignored < <(
  grep -oE '^(CVE|GHSA)-[A-Za-z0-9.-]+' "$IGNORE_FILE" | sort -u
)

for finding in "${ignored[@]}"; do
  case "$finding" in
    CVE-2026-14456)
      # Accepted because nothing in the image loads OpenSSL: every TLS client is
      # rustls. A dependency switching to native-tls or openssl-sys would make
      # the library reachable and the exception wrong.
      if grep -qE '(native-tls|openssl-sys|openssl =)' "$ROOT_DIR/backend/Cargo.toml"; then
        fail "$finding assumes no OpenSSL TLS backend, but Cargo.toml now names one"
      fi
      if grep -qE '^(name = "openssl-sys"|name = "native-tls")' "$ROOT_DIR/backend/Cargo.lock"; then
        fail "$finding assumes OpenSSL is absent, but it is in the lockfile"
      fi
      for feature in "tls-rustls" "rustls-tls" "tokio1-rustls-tls"; do
        grep -Fq "$feature" "$ROOT_DIR/backend/Cargo.toml" \
          || fail "$finding assumes $feature is in use; it is gone"
      done
      ;;
    *)
      fail "$finding has no justification check here; add one or remove the entry"
      ;;
  esac
done

echo "Container scan exceptions checked: ${#ignored[@]} finding(s) still justified"
