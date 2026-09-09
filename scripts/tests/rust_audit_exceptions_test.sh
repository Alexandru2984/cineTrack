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

for advisory in ${ignored[@]+"${ignored[@]}"}; do
  case "$advisory" in
    *)
      fail "$advisory has no justification check here; add one or remove the ignore"
      ;;
  esac
done

# RUSTSEC-2026-0258 (h2) was retired from the ignore list by dropping the
# dependency: `actix-web` is taken without default features and without
# `http2`, so no h2 codec is compiled in. Turning the feature back on would
# reintroduce a vulnerable crate that no ignore entry covers any more, and
# `cargo audit` would start failing — but it would fail in CI, after the fact.
# Catch it at the declaration instead.
MANIFEST="$ROOT_DIR/backend/Cargo.toml"
actix_web_line="$(grep -E '^actix-web = ' "$MANIFEST" || true)"
[[ -n "$actix_web_line" ]] || fail "no actix-web dependency line in backend/Cargo.toml"

case "$actix_web_line" in
  *'default-features = false'*) ;;
  *) fail "actix-web must be declared with default-features = false, or the http2 feature (and vulnerable h2 0.3) comes back" ;;
esac

case "$actix_web_line" in
  *'"http2"'*) fail "actix-web enables the http2 feature, which pulls in h2 0.3 (RUSTSEC-2026-0258); the server only ever serves HTTP/1.x" ;;
esac

# The feature list is what keeps h2 out, so prove it against the built tree
# rather than trusting the manifest text alone.
if command -v cargo >/dev/null 2>&1; then
  if (cd "$ROOT_DIR/backend" && cargo tree --offline --prefix none 2>/dev/null | grep -qE '^h2 v0\.3'); then
    fail "h2 0.3 is back in the dependency tree (RUSTSEC-2026-0258)"
  fi
fi

echo "Rust audit exceptions checked: ${#ignored[@]} advisory/advisories still justified; h2 stays out of the tree"
