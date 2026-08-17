#!/usr/bin/env bash
# Verify that every secret-bearing file on this host is unreadable to anyone
# but its owner, untracked, and ignored.
#
# This exists because `r2_api_key.txt` sat at mode 0644 in the repository root
# for weeks. It was gitignored, so every scanner in the pipeline was happy:
# gitleaks reads the history, `git status` reads the index, and neither looks
# at a file mode. On a single-tenant box that is survivable. This host runs
# twenty-odd unrelated containers, so a world-readable credential is one
# `cat` away from any process that shares the filesystem.
#
# The checks are deliberately about the *filesystem*, not about content:
#
#   1. mode      — group and other bits must be clear (0600/0400).
#   2. tracked   — a secret must never be in the git index.
#   3. ignored   — a secret must be matched by .gitignore, so a future
#                  `git add -A` cannot stage it.
#   4. backups   — .env.prod.bak* are full copies of superseded secrets; keep
#                  the rolling window small.
#   5. PII       — bulk personal-data exports are working files, not fixtures.
#                  They must be 0700 while they exist, and should not exist
#                  once the import that needed them is finished.
#
# Never prints a file's contents — only paths, modes, and counts. Safe to run
# in CI, in a shared terminal, or with its output pasted into an issue.
#
#   scripts/check_secret_hygiene.sh              # audit this repository
#   scripts/check_secret_hygiene.sh --strict     # PII leftovers also fail
#   scripts/check_secret_hygiene.sh --root DIR   # audit another tree (tests)
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Keep in step with the rolling window in scripts/prune-env-backups.sh.
MAX_ENV_BACKUPS="${MAX_ENV_BACKUPS:-3}"
STRICT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --strict) STRICT=1; shift ;;
    --root) ROOT="$(cd "${2:?--root needs a directory}" && pwd)"; shift 2 ;;
    --root=*) ROOT="$(cd "${1#*=}" && pwd)"; shift ;;
    --max-backups) MAX_ENV_BACKUPS="${2:?--max-backups needs a number}"; shift 2 ;;
    -h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if ! [[ "$MAX_ENV_BACKUPS" =~ ^[0-9]+$ ]]; then
  echo "error: --max-backups must be a non-negative integer" >&2
  exit 2
fi

FAILURES=0
WARNINGS=0

fail() {
  printf 'FAIL  %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}

warn() {
  printf 'WARN  %s\n' "$1"
  WARNINGS=$((WARNINGS + 1))
}

pass() {
  printf 'ok    %s\n' "$1"
}

# Filenames that carry credentials. Patterns rather than literal names: the R2
# key arrived as `r2_api_key.txt`, a name nobody had predicted, and the next one
# will have a name nobody predicts either.
SECRET_PATTERNS=(
  '.env.prod'
  '.env.prod.bak*'
  '.env.local'
  '*api_key*.txt'
  '*_key.json'
  '*credentials*.json'
  '*.pem'
  '*.p12'
  '*.keystore'
  '*.age'
  '*.key'
)

# Directories holding bulk personal data pulled in for a one-off task.
PII_DIRS=(
  'tvtime_data'
)

# Build the find expression once: -name A -o -name B -o ...
find_args=()
for pattern in "${SECRET_PATTERNS[@]}"; do
  if [[ ${#find_args[@]} -gt 0 ]]; then
    find_args+=(-o)
  fi
  find_args+=(-name "$pattern")
done

# Generated trees are pruned rather than audited. `expo prebuild` writes
# mobile/android and mobile/ios from scratch on every run, and android/app
# ships the AOSP debug keystore — key alias `androiddebugkey`, store password
# the literal string `android`, published by Google and identical on every
# machine with an Android SDK. Flagging its mode is noise that trains the
# reader to skim past real findings. The real signing material is EAS-managed
# and never lands in the work tree.
mapfile -d '' -t secrets < <(
  find "$ROOT" \
    \( -name .git -o -name node_modules -o -name target -o -name dist \
       -o -path "$ROOT/mobile/android" -o -path "$ROOT/mobile/ios" \
       -o -name .expo \) -prune -o \
    -type f \( "${find_args[@]}" \) -print0 2>/dev/null
)

printf '=== Secret file hygiene (%s) ===\n' "$ROOT"

if [[ ${#secrets[@]} -eq 0 ]]; then
  pass "no secret-bearing files found"
fi

# `git check-ignore` and `git ls-files` only mean anything inside a work tree.
# The fixture trees the tests build are not repositories, so skip those two
# checks there rather than reporting a false pass.
in_git_worktree=0
if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  in_git_worktree=1
fi

for path in "${secrets[@]}"; do
  relative="${path#"$ROOT"/}"

  # 1. Mode: nothing for group, nothing for other.
  mode="$(stat -c '%a' "$path")"
  # Zero-pad so a 3-digit and a 4-digit (setuid) mode compare the same way.
  printf -v padded '%04d' "$((10#$mode))"
  if [[ "${padded:2:1}" != "0" || "${padded:3:1}" != "0" ]]; then
    fail "$relative is mode $mode — readable beyond its owner (want 600)"
  else
    pass "$relative mode $mode"
  fi

  if [[ $in_git_worktree -eq 1 ]]; then
    # 2. Tracked: a secret in the index is already shared with the remote.
    if git -C "$ROOT" ls-files --error-unmatch -- "$relative" >/dev/null 2>&1; then
      fail "$relative is TRACKED by git — remove it from the index and rotate the value"
    fi

    # 3. Ignored: without this, one `git add -A` stages it.
    if ! git -C "$ROOT" check-ignore -q -- "$relative"; then
      fail "$relative is not matched by .gitignore — a 'git add -A' would stage it"
    fi
  fi
done

# 4. Superseded copies of rotated secrets.
printf '\n=== Stale secret backups ===\n'
mapfile -d '' -t env_backups < <(
  find "$ROOT" -maxdepth 1 -type f -name '.env.prod.bak*' -print0 2>/dev/null
)
backup_count="${#env_backups[@]}"
if (( backup_count > MAX_ENV_BACKUPS )); then
  warn "$backup_count .env.prod.bak* copies (want <= $MAX_ENV_BACKUPS) — run scripts/prune-env-backups.sh --apply"
else
  pass "$backup_count .env.prod.bak* copies (limit $MAX_ENV_BACKUPS)"
fi

# 5. Bulk personal data left over from a completed task.
printf '\n=== Bulk personal data ===\n'
for name in "${PII_DIRS[@]}"; do
  directory="$ROOT/$name"
  if [[ ! -d "$directory" ]]; then
    pass "$name/ absent"
    continue
  fi

  mode="$(stat -c '%a' "$directory")"
  printf -v padded '%04d' "$((10#$mode))"
  if [[ "${padded:2:1}" != "0" || "${padded:3:1}" != "0" ]]; then
    fail "$name/ is mode $mode — personal data readable beyond its owner (want 700)"
  fi

  size="$(du -sh "$directory" 2>/dev/null | cut -f1)"
  message="$name/ still present ($size of personal data) — archive off-host and remove once the import is done"
  if (( STRICT == 1 )); then
    fail "$message"
  else
    warn "$message"
  fi
done

printf '\n=== Summary ===\n'
printf 'failures: %d   warnings: %d\n' "$FAILURES" "$WARNINGS"
if (( FAILURES > 0 )); then
  printf '\nSecret hygiene check FAILED. Fix the entries above; rotate any value\n'
  printf 'that was exposed, because tightening a mode does not un-read a file.\n'
  exit 1
fi
printf 'Secret hygiene check passed.\n'
