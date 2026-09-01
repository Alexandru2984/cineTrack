#!/usr/bin/env bash
set -euo pipefail

# The Rust version must have exactly one home.
#
# It used to have two: the `FROM rust:` tags and `RUST_TOOLCHAIN` in the
# workflow. Dependabot can see the first and not the second, so every compiler
# bump arrived half applied — #165 failed precisely that way — and a check
# existed only to catch a mismatch the duplication made possible. Removing the
# copy removes the failure mode; these guards keep it removed.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/rust_toolchain.sh"
failures=0

# 1. The workflow must not write the version down a second time.
if grep -qE '^\s*RUST_TOOLCHAIN:\s*[0-9]' "$ROOT_DIR/.github/workflows/ci.yml"; then
  echo "rust toolchain: ci.yml pins the version again; Dependabot cannot see it there" >&2
  failures=$((failures + 1))
fi

# 2. Every job that installs Rust must read it first, or it installs nothing.
installs="$(grep -c 'rustup toolchain install' "$ROOT_DIR/.github/workflows/ci.yml")"
reads="$(grep -c 'scripts/rust_toolchain.sh' "$ROOT_DIR/.github/workflows/ci.yml")"
if [[ "$reads" -lt "$installs" ]]; then
  echo "rust toolchain: $installs job(s) install a toolchain but only $reads read the version" >&2
  failures=$((failures + 1))
fi

# 3. It reports what the production image actually pins.
expected="$(grep -oP '(?<=^FROM rust:)[0-9]+\.[0-9]+\.[0-9]+' "$ROOT_DIR/backend/Dockerfile.prod" | head -n 1)"
actual="$("$SCRIPT")"
if [[ "$actual" != "$expected" ]]; then
  echo "rust toolchain: script reports $actual, Dockerfile.prod pins $expected" >&2
  failures=$((failures + 1))
fi

# 4. Two Dockerfiles that disagree must fail rather than pick one.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/backend" "$WORK/scripts"
cp "$SCRIPT" "$WORK/scripts/"
printf 'FROM rust:1.98.0-slim-bookworm AS builder\n' > "$WORK/backend/Dockerfile.prod"
printf 'FROM rust:1.97.1-slim-bookworm\n' > "$WORK/backend/Dockerfile.dev"
if "$WORK/scripts/rust_toolchain.sh" >/dev/null 2>&1; then
  echo "rust toolchain: mismatched Dockerfiles were accepted" >&2
  failures=$((failures + 1))
fi

# 5. An unpinned image must fail rather than report an empty version, which
#    would install whatever `rustup` felt like.
printf 'FROM rust:slim-bookworm\n' > "$WORK/backend/Dockerfile.prod"
printf 'FROM rust:slim-bookworm\n' > "$WORK/backend/Dockerfile.dev"
if "$WORK/scripts/rust_toolchain.sh" >/dev/null 2>&1; then
  echo "rust toolchain: an unpinned image was accepted" >&2
  failures=$((failures + 1))
fi

if ((failures > 0)); then
  echo "rust toolchain: $failures check(s) failed" >&2
  exit 1
fi

echo "rust toolchain: one source, read by every job that installs it"
