#!/usr/bin/env bash
# Prune stale .env.prod backups, keeping the N most recent by modification time.
#
# Every edit to .env.prod (rotation, new variable) leaves a .env.prod.bak*
# behind. Those accumulate as full copies of the secrets — old JWT/TOTP/DB/R2
# credentials sitting in cleartext on the host long after they were replaced.
# This keeps a small rolling window and removes the rest.
#
# SAFE BY DEFAULT: prints what it would delete and exits. Pass --apply to delete.
# Never prints file contents.
#
#   scripts/prune-env-backups.sh                # dry run, keep newest 3
#   scripts/prune-env-backups.sh --keep 5       # dry run, keep newest 5
#   scripts/prune-env-backups.sh --apply        # actually delete
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

KEEP="${KEEP:-3}"
APPLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --keep) KEEP="${2:?--keep needs a number}"; shift 2 ;;
    --keep=*) KEEP="${1#*=}"; shift ;;
    -h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if ! [[ "$KEEP" =~ ^[0-9]+$ ]]; then
  echo "error: --keep must be a non-negative integer" >&2
  exit 2
fi

# Newest first, by mtime. Null-delimited so odd filenames are safe.
mapfile -d '' -t backups < <(
  find "$REPO_ROOT" -maxdepth 1 -type f -name '.env.prod.bak*' -printf '%T@\t%p\0' \
    | sort -z -rn \
    | cut -z -f2-
)

total="${#backups[@]}"
if (( total == 0 )); then
  echo "No .env.prod.bak* files found in $REPO_ROOT — nothing to do."
  exit 0
fi

echo "Found $total backup(s); keeping the $KEEP most recent."
doomed=("${backups[@]:KEEP}")

if (( ${#doomed[@]} == 0 )); then
  echo "Nothing to prune."
  exit 0
fi

for path in "${doomed[@]}"; do
  if (( APPLY == 1 )); then
    rm -f -- "$path"
    echo "deleted  $(basename "$path")"
  else
    echo "would delete  $(basename "$path")"
  fi
done

if (( APPLY == 0 )); then
  echo
  echo "Dry run only. Re-run with --apply to delete the ${#doomed[@]} file(s) above."
fi
