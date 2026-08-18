#!/usr/bin/env bash
# Contract tests for scripts/check_deploy_drift.sh.
#
# The check reports on three artifacts deployed independently: the backend
# image, the frontend image, and the host nginx vhost. Judging all three by one
# label was wrong in both directions, and both were observed in production — a
# frontend-only release raised an alert with nothing to fix, and a backend-only
# release after a frontend change would have reported "up to date" over a stale
# bundle. Both directions are asserted here.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="$(mktemp -d)"

cleanup() {
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

FAILURES=0

fail() {
  printf 'FAIL  %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}

pass() {
  printf 'ok    %s\n' "$1"
}

# A fixture repository whose history is known, so the expected counts are facts
# rather than whatever this checkout looks like today.
REPO="$WORK_DIR/repo"
mkdir -p "$REPO"/{backend,frontend,nginx}
git -C "$REPO" init --quiet
git -C "$REPO" config user.email drift@test.invalid
git -C "$REPO" config user.name "Drift Test"

commit() {
  printf '%s\n' "$2" > "$REPO/$1"
  git -C "$REPO" add -A
  git -C "$REPO" commit --quiet -m "$3"
  git -C "$REPO" rev-parse HEAD
}

BASE="$(commit backend/main.rs one 'backend: base')"
commit frontend/app.tsx one 'frontend: a change' >/dev/null
HEAD_REV="$(git -C "$REPO" rev-parse HEAD)"
# The checker compares against a remote-tracking ref; point it at a local
# branch instead so the fixture needs no remote.
git -C "$REPO" branch -f drift-target HEAD

# A `docker` stub that reports whatever revision each test asks for.
STUB_DIR="$WORK_DIR/bin"
mkdir -p "$STUB_DIR"
cat > "$STUB_DIR/docker" <<'STUB'
#!/usr/bin/env bash
# Args: inspect <container> --format <...>
container="$2"
case "$container" in
  cinetrack-backend-1) printf '%s' "${STUB_BACKEND_REVISION:-}" ;;
  cinetrack-frontend-1) printf '%s' "${STUB_FRONTEND_REVISION:-}" ;;
  *) printf '' ;;
esac
STUB
chmod +x "$STUB_DIR/docker"

run_check() {
  local metrics="$WORK_DIR/metrics.prom"
  rm -f "$metrics"
  PATH="$STUB_DIR:$PATH" \
  DEPLOY_DRIFT_REPO_DIR="$REPO" \
  DEPLOY_DRIFT_BRANCH="drift-target" \
  DEPLOY_DRIFT_METRICS_FILE="$metrics" \
  DEPLOY_DRIFT_STATE_DIR="$WORK_DIR/state" \
  DEPLOY_DRIFT_VHOST_SOURCE="$1" \
  DEPLOY_DRIFT_VHOST_DEPLOYED="$2" \
  STUB_BACKEND_REVISION="$3" \
  STUB_FRONTEND_REVISION="$4" \
    "$ROOT_DIR/scripts/check_deploy_drift.sh" >/dev/null 2>&1 || true
  cat "$metrics"
}

metric() {
  grep -F "$2" <<<"$1" | awk '{print $NF}' | head -1
}

printf '%s\n' "vhost" > "$WORK_DIR/vhost.conf"
cp "$WORK_DIR/vhost.conf" "$WORK_DIR/vhost.deployed"

# ── A frontend-only release must not accuse the backend ─────────────────
#
# The backend is at BASE and the only newer commit touches frontend/ alone, so
# the backend has nothing to deploy. Reporting otherwise is the false alarm
# that was live in production.

out="$(run_check "$WORK_DIR/vhost.conf" "$WORK_DIR/vhost.deployed" "$BASE" "$HEAD_REV")"
if [[ "$(metric "$out" 'cinetrack_deploy_pending_commits{artifact="backend"}')" == "0" ]]; then
  pass "a frontend-only commit does not make the backend look behind"
else
  fail "the backend was reported behind over a frontend-only commit"
fi
if [[ "$(metric "$out" 'cinetrack_deploy_pending_commits{artifact="frontend"}')" == "0" ]]; then
  pass "a deployed frontend reports current"
else
  fail "an up-to-date frontend was reported behind"
fi

# ── A stale frontend must be caught ─────────────────────────────────────
#
# The inverse, and the one a single backend label could never see: backend
# current, frontend left at the older commit.

out="$(run_check "$WORK_DIR/vhost.conf" "$WORK_DIR/vhost.deployed" "$HEAD_REV" "$BASE")"
if [[ "$(metric "$out" 'cinetrack_deploy_pending_commits{artifact="frontend"}')" == "1" ]]; then
  pass "a stale frontend is reported behind"
else
  fail "a stale frontend went unnoticed"
fi
if [[ "$(metric "$out" 'cinetrack_deploy_pending_commits{artifact="backend"}')" == "0" ]]; then
  pass "the current backend is not blamed for it"
else
  fail "the backend was blamed for a stale frontend"
fi

# ── An unstamped image is reported, not assumed current ─────────────────

out="$(run_check "$WORK_DIR/vhost.conf" "$WORK_DIR/vhost.deployed" "$HEAD_REV" "")"
if [[ "$(metric "$out" 'cinetrack_deploy_revision_known{artifact="frontend"}')" == "0" ]]; then
  pass "an unstamped image reports an unknown revision"
else
  fail "an unstamped image passed as known"
fi

# ── An undeployed vhost is drift too ────────────────────────────────────
#
# Not an image, so there is no label to compare — and the artifact easiest to
# forget, because installing it is a separate manual step.

printf '%s\n' "vhost changed" > "$WORK_DIR/vhost.conf"
out="$(run_check "$WORK_DIR/vhost.conf" "$WORK_DIR/vhost.deployed" "$HEAD_REV" "$HEAD_REV")"
if [[ "$(metric "$out" 'cinetrack_deploy_pending_commits{artifact="nginx"}')" == "1" ]]; then
  pass "an uninstalled vhost is reported"
else
  fail "an uninstalled vhost went unnoticed"
fi

# Off the production host the file does not exist; report nothing rather than a
# drift nobody there can act on.
out="$(run_check "$WORK_DIR/vhost.conf" "$WORK_DIR/absent" "$HEAD_REV" "$HEAD_REV")"
if [[ "$(metric "$out" 'cinetrack_deploy_pending_commits{artifact="nginx"}')" == "0" ]]; then
  pass "an absent vhost file is not reported as drift"
else
  fail "a missing vhost file was reported as drift"
fi

printf '\n'
if (( FAILURES > 0 )); then
  printf 'deploy drift contract: %d failure(s)\n' "$FAILURES"
  exit 1
fi
printf 'deploy drift contract: all checks passed\n'
