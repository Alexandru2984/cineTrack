#!/usr/bin/env bash
set -euo pipefail

# The one place the Rust version is written down: the backend images.
#
# CI used to keep a second copy in `RUST_TOOLCHAIN` in the workflow. Dependabot
# bumps the `FROM rust:` tags but cannot see a workflow variable, so every
# compiler bump arrived half applied — #165 failed exactly this way — and a
# consistency check existed solely to catch a mismatch the duplication created.
# Reading the version from the image removes the second copy, so the bump is
# complete on its own and there is no drift left to detect.
#
# `Dockerfile.dev` and `Dockerfile.prod` are still two files, and they still have
# to agree, so that is what this checks.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

read_tag() {
  local file="$1" version
  version="$(grep -oP '(?<=^FROM rust:)[0-9]+\.[0-9]+\.[0-9]+' "$file" | head -n 1)"
  if [[ -z "$version" ]]; then
    echo "rust toolchain: no pinned 'FROM rust:<version>' in $file" >&2
    exit 1
  fi
  printf '%s' "$version"
}

prod="$(read_tag "$ROOT_DIR/backend/Dockerfile.prod")"
dev="$(read_tag "$ROOT_DIR/backend/Dockerfile.dev")"

if [[ "$prod" != "$dev" ]]; then
  echo "rust toolchain: Dockerfile.prod pins $prod but Dockerfile.dev pins $dev" >&2
  exit 1
fi

printf '%s\n' "$prod"
