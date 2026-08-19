#!/usr/bin/env bash
# The two clients' encryption core must be byte-identical.
#
# Cryptography that disagrees across platforms fails silently and late: a
# message written on a phone that will not open on a laptop, because one side
# padded, ordered or encoded something differently. Nothing in either test suite
# would catch that — each passes against itself.
#
# Sharing the file through a package would be cleaner, but these are two
# independent npm projects with no workspace between them, and introducing one
# to move a single file is a larger change than checking the copies agree.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WEB="$ROOT_DIR/frontend/src/lib/crypto/core.ts"
NATIVE="$ROOT_DIR/mobile/src/lib/crypto/core.ts"

for copy in "$WEB" "$NATIVE"; do
  [[ -f "$copy" ]] || {
    echo "crypto parity error: $copy is missing" >&2
    exit 1
  }
done

if ! cmp -s "$WEB" "$NATIVE"; then
  echo "crypto parity error: the web and native encryption cores differ." >&2
  echo "Edit one, copy it to the other, and run both test suites:" >&2
  echo "  cp frontend/src/lib/crypto/core.ts mobile/src/lib/crypto/core.ts" >&2
  echo >&2
  diff -u "$WEB" "$NATIVE" | head -40 >&2
  exit 1
fi

# A copied file is not enough on its own: both projects must actually be able to
# run it, and a dependency present in one and missing from the other produces a
# core that imports nothing on the platform that lacks it.
for project in frontend mobile; do
  for package in @noble/curves @noble/ciphers @noble/hashes; do
    grep -Fq "\"$package\"" "$ROOT_DIR/$project/package.json" || {
      echo "crypto parity error: $project does not depend on $package" >&2
      exit 1
    }
  done
done

echo "Crypto core parity checked: both clients share one implementation"
