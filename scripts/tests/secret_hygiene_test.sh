#!/usr/bin/env bash
# Contract tests for scripts/check_secret_hygiene.sh.
#
# The checker is only worth having if it actually fails on the shape of the
# problem that motivated it: a credential file readable by the whole host.
# These build throwaway trees and assert both directions — that a bad tree is
# rejected and, just as importantly, that a good one is not, because a check
# that cries wolf gets disabled.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECKER="$ROOT_DIR/scripts/check_secret_hygiene.sh"
WORK_DIR="$(mktemp -d)"

cleanup() {
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

FAILURES=0
# Assigned indirectly by run_checker via `printf -v`, which ShellCheck cannot
# follow. Declaring it here keeps SC2154 quiet without a blanket disable.
output=''

check() {
  local description="$1"
  if [[ "$2" == "$3" ]]; then
    printf 'ok    %s\n' "$description"
  else
    printf 'FAIL  %s (expected %s, got %s)\n' "$description" "$3" "$2"
    FAILURES=$((FAILURES + 1))
  fi
}

# Run the checker against a fixture, returning its exit status and capturing
# output for content assertions.
run_checker() {
  local output_var="$1"
  shift
  # Deliberately not named `output`: `local output` would shadow the caller's
  # variable of that name, and printf -v would then write to the local copy
  # that vanishes when the function returns.
  local captured status
  set +e
  captured="$("$CHECKER" "$@" 2>&1)"
  status=$?
  set -e
  printf -v "$output_var" '%s' "$captured"
  return "$status"
}

# A fixture tree that is a real git repository, since three of the five checks
# only mean anything inside a work tree.
new_repo() {
  local name="$1"
  local dir="$WORK_DIR/$name"
  mkdir -p "$dir"
  git -C "$dir" init --quiet
  git -C "$dir" config user.email hygiene@test.invalid
  git -C "$dir" config user.name "Hygiene Test"
  printf '%s\n' '.env.prod' '*api_key*.txt' >"$dir/.gitignore"
  printf '%s' "$dir"
}

# ── A world-readable credential must fail ───────────────────────────────

repo="$(new_repo world-readable)"
printf 'secret-value\n' >"$repo/r2_api_key.txt"
chmod 644 "$repo/r2_api_key.txt"

status=0
run_checker output --root "$repo" || status=$?
check "world-readable credential exits non-zero" "$status" "1"
case "$output" in
  *"mode 644"*) printf 'ok    reports the offending mode\n' ;;
  *) printf 'FAIL  did not report the offending mode\n'; FAILURES=$((FAILURES + 1)) ;;
esac
case "$output" in
  *secret-value*)
    printf 'FAIL  LEAKED FILE CONTENTS INTO OUTPUT\n'
    FAILURES=$((FAILURES + 1))
    ;;
  *) printf 'ok    never prints file contents\n' ;;
esac

# ── The same file at 0600 must pass ─────────────────────────────────────

chmod 600 "$repo/r2_api_key.txt"
status=0
run_checker output --root "$repo" || status=$?
check "0600 credential exits zero" "$status" "0"

# ── Rendered container credentials may be group-readable, never world ───
#
# Prometheus and Alertmanager read their credentials as `nobody` plus the host
# metrics group, so 0640 is the correct mode and demanding 0600 would fail a
# working deployment. The other-bits are still the line that must not move.

repo="$(new_repo generated)"
printf '%s\n' '*.generated' >"$repo/.gitignore"
printf 'secret-value' >"$repo/metrics_token.generated"

chmod 640 "$repo/metrics_token.generated"
status=0
run_checker output --root "$repo" || status=$?
check "a 0640 rendered credential is accepted" "$status" "0"
case "$output" in
  *"metrics_token.generated mode 640"*) printf 'ok    audits the rendered credential\n' ;;
  *)
    printf 'FAIL  rendered credential was not audited at all\n'
    FAILURES=$((FAILURES + 1))
    ;;
esac

chmod 644 "$repo/metrics_token.generated"
status=0
run_checker output --root "$repo" || status=$?
check "a world-readable rendered credential is refused" "$status" "1"
case "$output" in
  *"world readable"*) printf 'ok    names the world-readable problem\n' ;;
  *)
    printf 'FAIL  did not name the world-readable problem\n'
    FAILURES=$((FAILURES + 1))
    ;;
esac

# The relaxation must not leak into the strict class: 0640 on an ordinary
# secret is still too wide.
repo="$(new_repo group-readable-secret)"
printf 'secret-value\n' >"$repo/deploy.pem"
chmod 640 "$repo/deploy.pem"
printf '%s\n' '*.pem' >"$repo/.gitignore"
status=0
run_checker output --root "$repo" || status=$?
check "a 0640 ordinary secret is still refused" "$status" "1"

# ── A tracked secret must fail even at 0600 ─────────────────────────────

repo="$(new_repo tracked)"
printf 'secret-value\n' >"$repo/deploy.pem"
chmod 600 "$repo/deploy.pem"
git -C "$repo" add --force deploy.pem
status=0
run_checker output --root "$repo" || status=$?
check "tracked secret exits non-zero" "$status" "1"
case "$output" in
  *TRACKED*) printf 'ok    names the tracking problem\n' ;;
  *) printf 'FAIL  did not name the tracking problem\n'; FAILURES=$((FAILURES + 1)) ;;
esac

# ── A 0600, untracked, but UNIGNORED secret must fail ───────────────────
#
# This is the near miss: correct mode, not committed yet, and exactly one
# `git add -A` away from being published.

repo="$(new_repo unignored)"
printf 'secret-value\n' >"$repo/service_credentials.json"
chmod 600 "$repo/service_credentials.json"
status=0
run_checker output --root "$repo" || status=$?
check "unignored secret exits non-zero" "$status" "1"
case "$output" in
  *gitignore*) printf 'ok    names the gitignore gap\n' ;;
  *) printf 'FAIL  did not name the gitignore gap\n'; FAILURES=$((FAILURES + 1)) ;;
esac

# ── Stale backups warn but do not fail ──────────────────────────────────
#
# Old secret copies are a cleanup task, not an exposure: they are already at
# 0600 and ignored. Failing the build on them would make the gate noisy.

repo="$(new_repo backups)"
for suffix in 1 2 3 4 5; do
  printf 'old-secret\n' >"$repo/.env.prod.bak.$suffix"
  chmod 600 "$repo/.env.prod.bak.$suffix"
done
printf '%s\n' '.env.prod*' >"$repo/.gitignore"
status=0
run_checker output --root "$repo" || status=$?
check "stale backups exit zero (warning only)" "$status" "0"
case "$output" in
  *"5 .env.prod.bak"*) printf 'ok    counts the stale backups\n' ;;
  *) printf 'FAIL  did not count the stale backups\n'; FAILURES=$((FAILURES + 1)) ;;
esac

status=0
run_checker output --root "$repo" --max-backups 10 || status=$?
check "a raised backup limit stops warning" "$status" "0"

# ── Bulk PII warns by default, fails under --strict ─────────────────────

repo="$(new_repo pii)"
mkdir -p "$repo/tvtime_data"
chmod 700 "$repo/tvtime_data"
printf 'email,ip\n' >"$repo/tvtime_data/user.csv"
printf '%s\n' 'tvtime_data/' >"$repo/.gitignore"

status=0
run_checker output --root "$repo" || status=$?
check "leftover PII warns by default" "$status" "0"

status=0
run_checker output --root "$repo" --strict || status=$?
check "leftover PII fails under --strict" "$status" "1"

# A world-readable PII directory is an exposure, not a cleanup task, so it
# fails even without --strict.
chmod 755 "$repo/tvtime_data"
status=0
run_checker output --root "$repo" || status=$?
check "world-readable PII directory fails without --strict" "$status" "1"

# ── A clean tree passes ─────────────────────────────────────────────────

repo="$(new_repo clean)"
status=0
run_checker output --root "$repo" || status=$?
check "clean tree exits zero" "$status" "0"

printf '\n'
if (( FAILURES > 0 )); then
  printf 'secret hygiene contract: %d failure(s)\n' "$FAILURES"
  exit 1
fi
printf 'secret hygiene contract: all checks passed\n'
