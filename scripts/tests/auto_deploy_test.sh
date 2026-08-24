#!/usr/bin/env bash
# Contract tests for scripts/auto_deploy.sh.
#
# This script deploys production without a person watching, so the decisions it
# makes on its own are the ones that need proving here: what it refuses to ship,
# and whether it can put back what it replaced.
#
# The rollback branch matters most. It runs only when a deploy has already
# failed, which is exactly when nobody wants to discover it was never exercised.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf -- "$WORK_DIR"; }
trap cleanup EXIT

FAILURES=0
fail() { printf 'FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf 'ok    %s\n' "$1"; }

# ── A fixture repository, so expectations are facts ─────────────────────
REPO="$WORK_DIR/repo"
mkdir -p "$REPO"/{backend/migrations,scripts,nginx}
git -C "$REPO" init --quiet
git -C "$REPO" config user.email deploy@test.invalid
git -C "$REPO" config user.name "Deploy Test"

printf 'services: {}\n' > "$REPO/docker-compose.prod.yml"
printf 'vhost\n' > "$REPO/nginx/vazute.micutu.com.conf"
cat > "$REPO/scripts/provision_db_role.sh" <<'PROV'
#!/usr/bin/env bash
exit 0
PROV
chmod +x "$REPO/scripts/provision_db_role.sh"
git -C "$REPO" add -A
git -C "$REPO" commit --quiet -m "base"
BASE="$(git -C "$REPO" rev-parse HEAD)"

printf 'fn main() {}\n' > "$REPO/backend/main.rs"
git -C "$REPO" add -A
git -C "$REPO" commit --quiet -m "code only, no schema"
CODE_ONLY="$(git -C "$REPO" rev-parse HEAD)"

printf 'ALTER TABLE t ADD COLUMN c int;\n' > "$REPO/backend/migrations/20260101_x.sql"
git -C "$REPO" add -A
git -C "$REPO" commit --quiet -m "adds a migration"
WITH_MIGRATION="$(git -C "$REPO" rev-parse HEAD)"

STUB_DIR="$WORK_DIR/bin"
mkdir -p "$STUB_DIR"

# `gh` answers with whatever the current case declares.
cat > "$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    */check-runs) cat "${STUB_CHECKS_FILE:-/dev/null}"; exit 0 ;;
    */status)     cat "${STUB_STATUS_FILE:-/dev/null}"; exit 0 ;;
  esac
done
exit 0
STUB
chmod +x "$STUB_DIR/gh"

# `docker` records what it was asked to do, so the test can assert on the
# actions taken rather than only on the final state.
cat > "$STUB_DIR/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_ACTIONS"
case "$1" in
  inspect) printf '%s' "${STUB_DEPLOYED_REVISION:-}"; exit 0 ;;
  image)   exit 0 ;;   # `image inspect`: the saved images exist
esac
exit 0
STUB
chmod +x "$STUB_DIR/docker"

# `curl` is the health check. Whether production comes back is the variable.
#
# `recover` is the realistic failure: the new revision is bad and putting the
# old image back fixes it. It is modelled by answering healthy only once the
# rollback has actually been performed, so the test cannot pass by reporting a
# rollback it never did.
cat > "$STUB_DIR/curl" <<'STUB'
#!/usr/bin/env bash
case "${STUB_HEALTHY:-1}" in
  1) exit 0 ;;
  recover)
    grep -q "tag cinetrack-backend:rollback cinetrack-backend:latest" "$STUB_ACTIONS" && exit 0
    exit 22 ;;
  *) exit 22 ;;
esac
STUB
chmod +x "$STUB_DIR/curl"

# Set here, not inside run_deploy: that runs in a command substitution, so any
# assignment it makes dies with the subshell.
ACTIONS="$WORK_DIR/actions.log"

run_deploy() {
  local metrics="$WORK_DIR/metrics.prom"
  rm -f "$metrics" "$ACTIONS"
  touch "$ACTIONS"
  PATH="$STUB_DIR:$PATH" \
  STUB_ACTIONS="$ACTIONS" \
  AUTO_DEPLOY_REPO_DIR="$REPO" \
  AUTO_DEPLOY_BRANCH="$1" \
  AUTO_DEPLOY_REPO_SLUG="owner/repo" \
  AUTO_DEPLOY_METRICS_FILE="$metrics" \
  AUTO_DEPLOY_STATE_DIR="$WORK_DIR/state" \
  AUTO_DEPLOY_BUILD_DIR="$WORK_DIR/state/build" \
  AUTO_DEPLOY_ENV_FILE="$WORK_DIR/env.prod" \
  AUTO_DEPLOY_VHOST_DEPLOYED="$WORK_DIR/vhost.deployed" \
  AUTO_DEPLOY_HEALTH_ATTEMPTS=2 \
  AUTO_DEPLOY_HEALTH_INTERVAL=0 \
  STUB_DEPLOYED_REVISION="$2" \
  STUB_CHECKS_FILE="$3" \
  STUB_STATUS_FILE="$4" \
  STUB_HEALTHY="$5" \
    "$ROOT_DIR/scripts/auto_deploy.sh" >/dev/null 2>&1 || true
  cat "$metrics" 2>/dev/null || true
}

state() { grep -F "state=\"$2\"" <<<"$1" | awk '{print $NF}' | head -1; }
is_state() { [[ "$(state "$1" "$2")" == "1" ]]; }

printf 'DATABASE_URL=x\n' > "$WORK_DIR/env.prod"
printf 'vhost\n' > "$WORK_DIR/vhost.deployed"

GREEN="$WORK_DIR/green.tsv"
printf 'CI Gate\tcompleted\tsuccess\nBackend\tcompleted\tsuccess\n' > "$GREEN"
RUNNING="$WORK_DIR/running.tsv"
printf 'CI Gate\tcompleted\tsuccess\nBackend\tin_progress\tnone\n' > "$RUNNING"
RED="$WORK_DIR/red.tsv"
printf 'CI Gate\tcompleted\tsuccess\nBackend\tcompleted\tfailure\n' > "$RED"
SKIPPED="$WORK_DIR/skipped.tsv"
printf 'CI Gate\tcompleted\tsuccess\nMobile\tcompleted\tskipped\n' > "$SKIPPED"
EMPTY="$WORK_DIR/empty.tsv"
: > "$EMPTY"
STATUS_RED="$WORK_DIR/status_red.tsv"
printf 'security/scan\tfailure\n' > "$STATUS_RED"

# ── An untested commit is not a passing one ─────────────────────────────
#
# Zero check runs is the case that must not be read as consent. It is what a
# commit looks like in the seconds before CI starts.
out="$(run_deploy "$CODE_ONLY" "$BASE" "$EMPTY" "$EMPTY" 1)"
if is_state "$out" waiting_ci; then
  pass "a commit with no CI results is not deployed"
else
  fail "a commit with no CI results was treated as deployable"
fi
if ! grep -q "build" "$ACTIONS"; then
  pass "nothing was built for an unchecked commit"
else
  fail "an unchecked commit reached the build step"
fi

# ── CI still running is not CI passed ───────────────────────────────────
out="$(run_deploy "$CODE_ONLY" "$BASE" "$RUNNING" "$EMPTY" 1)"
if is_state "$out" waiting_ci; then
  pass "a commit with CI in progress waits"
else
  fail "a commit was deployed while CI was still running"
fi

# ── A failing check blocks ──────────────────────────────────────────────
out="$(run_deploy "$CODE_ONLY" "$BASE" "$RED" "$EMPTY" 1)"
if is_state "$out" blocked_ci; then
  pass "a failed check blocks the deploy"
else
  fail "a failed check did not block the deploy"
fi

# ── A failing commit status blocks too ──────────────────────────────────
#
# Third-party scanners report through the older status API, which the check-run
# query cannot see at all.
out="$(run_deploy "$CODE_ONLY" "$BASE" "$GREEN" "$STATUS_RED" 1)"
if is_state "$out" blocked_ci; then
  pass "a failing commit status blocks even when every check run passed"
else
  fail "a failing commit status was ignored"
fi

# ── An empty status list must not deadlock ──────────────────────────────
#
# GitHub reports the combined state of no statuses as `pending`. Treating that
# as a verdict would block every deploy forever, which is a failure that looks
# exactly like working correctly.
out="$(run_deploy "$CODE_ONLY" "$BASE" "$GREEN" "$EMPTY" 1)"
if is_state "$out" deployed; then
  pass "no commit statuses does not block a green commit"
else
  fail "a green commit was blocked by an empty status list"
fi

# ── `skipped` and `neutral` are passes ──────────────────────────────────
out="$(run_deploy "$CODE_ONLY" "$BASE" "$SKIPPED" "$EMPTY" 1)"
if is_state "$out" deployed; then
  pass "a skipped job does not count as a failure"
else
  fail "a skipped job was treated as a failure"
fi

# ── Already deployed is not a deploy ────────────────────────────────────
out="$(run_deploy "$CODE_ONLY" "$CODE_ONLY" "$GREEN" "$EMPTY" 1)"
if is_state "$out" idle; then
  pass "the deployed revision is left alone"
else
  fail "the currently deployed revision was redeployed"
fi

# ── A vhost change is refused, not half-applied ─────────────────────────
#
# nginx config is not in any image. Shipping the images alone leaves the edge
# on the old behaviour while the site looks updated.
printf 'a different vhost\n' > "$WORK_DIR/vhost.deployed"
out="$(run_deploy "$CODE_ONLY" "$BASE" "$GREEN" "$EMPTY" 1)"
if is_state "$out" blocked_nginx; then
  pass "a revision needing a vhost change is refused"
else
  fail "a vhost change was silently skipped"
fi
printf 'vhost\n' > "$WORK_DIR/vhost.deployed"

# ── A bad deploy with no schema change is put back ──────────────────────
out="$(run_deploy "$CODE_ONLY" "$BASE" "$GREEN" "$EMPTY" recover)"
if is_state "$out" rolled_back; then
  pass "an unhealthy deploy without migrations rolls back"
else
  fail "an unhealthy deploy without migrations did not roll back"
fi
if grep -q "tag cinetrack-backend:rollback cinetrack-backend:latest" "$ACTIONS"; then
  pass "the saved image was actually restored"
else
  fail "rollback was reported but the image was never restored"
fi

# ── A rollback that does not help is not called a success ───────────────
#
# The images went back and the site is still down, so the problem was never in
# the image. Reporting `rolled_back` here would close the alert on an outage
# that is still happening.
out="$(run_deploy "$CODE_ONLY" "$BASE" "$GREEN" "$EMPTY" 0)"
if is_state "$out" stuck; then
  pass "a rollback that does not restore health reports stuck"
else
  fail "a rollback that left the site down was reported as recovered"
fi

# ── A bad deploy that migrated is left alone ────────────────────────────
#
# The old binary refuses to start against a schema carrying a migration it does
# not know, so putting it back turns a broken site into one that will not boot.
out="$(run_deploy "$WITH_MIGRATION" "$CODE_ONLY" "$GREEN" "$EMPTY" 0)"
if is_state "$out" stuck; then
  pass "an unhealthy deploy that applied a migration reports stuck"
else
  fail "an unhealthy deploy that applied a migration did not report stuck"
fi
if ! grep -q "tag cinetrack-backend:rollback cinetrack-backend:latest" "$ACTIONS"; then
  pass "no rollback was attempted into a migrated schema"
else
  fail "it rolled back into a migrated schema, which cannot start"
fi

# ── An unknown starting point keeps the rollback path closed ────────────
#
# Without a known previous revision there is no way to tell whether schema
# moved, and guessing "it did not" is the guess that cannot be recovered from.
out="$(run_deploy "$CODE_ONLY" "" "$GREEN" "$EMPTY" 0)"
if is_state "$out" stuck; then
  pass "an unknown deployed revision is treated as unsafe to roll back"
else
  fail "an unknown deployed revision was rolled back on a guess"
fi

if (( FAILURES > 0 )); then
  printf '\n%d contract(s) failed\n' "$FAILURES"
  exit 1
fi
printf '\nall auto-deploy contracts hold\n'
