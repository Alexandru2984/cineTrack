#!/usr/bin/env bash
# Check that each accepted RustSec advisory still rests on a true claim.
#
# An ignore entry is a statement about this deployment, not a judgement that the
# advisory is unimportant. Statements go stale: the code changes, and the
# exception keeps suppressing a finding that has quietly become real. cargo-audit
# has no way to notice that, so the reasoning is asserted here instead.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AUDIT_CONFIG="$ROOT_DIR/backend/.cargo/audit.toml"

fail() {
  echo "rust audit exception error: $1" >&2
  exit 1
}

[[ -f "$AUDIT_CONFIG" ]] || fail "$AUDIT_CONFIG is missing"

# Every ignored advisory must be listed below with its own justification check.
# An unrecognised entry fails: adding an exception has to mean writing down why.
mapfile -t ignored < <(
  grep -oE '"RUSTSEC-[0-9]{4}-[0-9]{4}"' "$AUDIT_CONFIG" | tr -d '"' | sort -u
)

for advisory in "${ignored[@]}"; do
  case "$advisory" in
    RUSTSEC-2026-0258)
      # Accepted because the h2 codec is unreachable: actix-web serves HTTP/2
      # only over a TLS bind or an explicit h2c bind, and nginx proxies to the
      # backend over HTTP/1.1. Both halves are asserted.
      if grep -qE '\.bind_(rustls|openssl|auto_h2c)' "$ROOT_DIR/backend/src/main.rs"; then
        fail "$advisory assumes no TLS or h2c bind, but main.rs now has one"
      fi
      grep -qE '^\s*\.bind\(' "$ROOT_DIR/backend/src/main.rs" \
        || fail "$advisory assumes a plain .bind(); main.rs no longer has one"
      # shellcheck disable=SC2016 # literal nginx directive, not a shell variable
      grep -Fq 'proxy_http_version 1.1;' "$ROOT_DIR/nginx/vazute.micutu.com.conf" \
        || fail "$advisory assumes nginx proxies over HTTP/1.1; the vhost changed"
      ;;
    *)
      fail "$advisory has no justification check here; add one or remove the ignore"
      ;;
  esac
done

echo "Rust audit exceptions checked: ${#ignored[@]} advisory/advisories still justified"
