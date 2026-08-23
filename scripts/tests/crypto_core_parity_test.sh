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
# Everything that must agree byte for byte. `core.ts` is the cryptography
# itself; `messages.ts` decides which envelope field goes where and `cache.ts`
# how long plaintext lives, and a difference in either produces exactly the same
# silent, late failure as a difference in the primitives.
#
# Deliberately not on this list: storage and session. Keys live in IndexedDB on
# one platform and the keychain on the other, and pretending those are the same
# file would be a fiction the test would have to keep working around.
SHARED_FILES=(
  "src/lib/crypto/core.ts"
  "src/lib/crypto/cache.ts"
  "src/lib/crypto/messages.ts"
)

for relative in "${SHARED_FILES[@]}"; do
  WEB="$ROOT_DIR/frontend/$relative"
  NATIVE="$ROOT_DIR/mobile/$relative"

  for copy in "$WEB" "$NATIVE"; do
    [[ -f "$copy" ]] || {
      echo "crypto parity error: $copy is missing" >&2
      exit 1
    }
  done

  if ! cmp -s "$WEB" "$NATIVE"; then
    echo "crypto parity error: $relative differs between the web and native clients." >&2
    echo "Edit one, copy it to the other, and run both test suites:" >&2
    echo "  cp frontend/$relative mobile/$relative" >&2
    echo >&2
    diff -u "$WEB" "$NATIVE" | head -40 >&2
    exit 1
  fi
done

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
