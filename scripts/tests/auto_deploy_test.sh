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
mkdir -p "$REPO"/{backend/migrations,scripts,nginx,mobile}
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

printf 'export default {}\n' > "$REPO/mobile/App.tsx"
git -C "$REPO" add -A
git -C "$REPO" commit --quiet -m "touches the mobile app"
TOUCHES_MOBILE="$(git -C "$REPO" rev-parse HEAD)"

STUB_DIR="$WORK_DIR/bin"
mkdir -p "$STUB_DIR"

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
# `curl` is now the only thing the script talks to the outside with: the GitHub
# API and both health probes. A file named "FAIL" makes the call fail the way a
# rate limit or a network error would.
cat > "$STUB_DIR/curl" <<'STUB'
#!/usr/bin/env bash
url="${*: -1}"
case "$url" in
  *check-runs*)
    [[ "$(cat "$STUB_CHECKS_FILE")" == FAIL ]] && exit 22
    cat "$STUB_CHECKS_FILE"; exit 0 ;;
  *api.github.com*/status*)
    [[ "$(cat "$STUB_STATUS_FILE")" == FAIL ]] && exit 22
    cat "$STUB_STATUS_FILE"; exit 0 ;;
  http://127.0.0.1:*) mode="${STUB_HEALTHY:-1}" ;;
  *)                  mode="${STUB_EDGE_HEALTHY:-1}" ;;
esac
case "$mode" in
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
  STUB_EDGE_HEALTHY="${6:-1}" \
    "$ROOT_DIR/scripts/auto_deploy.sh" >/dev/null 2>&1 || true
  cat "$metrics" 2>/dev/null || true
}

state() { grep -F "state=\"$2\"" <<<"$1" | awk '{print $NF}' | head -1; }
is_state() { [[ "$(state "$1" "$2")" == "1" ]]; }

printf 'DATABASE_URL=x\n' > "$WORK_DIR/env.prod"
printf 'vhost\n' > "$WORK_DIR/vhost.deployed"

# `total_count` is written to match the array, because the script rejects a
# response where it does not — a truncated page could be hiding the failure.
checks_fixture() {
  local file="$1"; shift
  python3 - "$file" "$@" <<'PY'
import json, sys
path, *pairs = sys.argv[1:]
runs = []
for pair in pairs:
    name, status, conclusion = pair.split(":")
    runs.append({
        "name": name,
        "status": status,
        "conclusion": None if conclusion == "none" else conclusion,
    })
with open(path, "w") as fh:
    json.dump({"total_count": len(runs), "check_runs": runs}, fh)
PY
}

status_fixture() {
  local file="$1"; shift
  python3 - "$file" "$@" <<'PY'
import json, sys
path, *pairs = sys.argv[1:]
statuses = [{"context": c, "state": st} for c, st in (p.split(":") for p in pairs)]
with open(path, "w") as fh:
    json.dump({"state": "pending", "statuses": statuses}, fh)
PY
}

GREEN="$WORK_DIR/green.json"
checks_fixture "$GREEN" "CI Gate:completed:success" "Backend:completed:success"
RUNNING="$WORK_DIR/running.json"
checks_fixture "$RUNNING" "CI Gate:completed:success" "Backend:in_progress:none"
RED="$WORK_DIR/red.json"
checks_fixture "$RED" "CI Gate:completed:success" "Backend:completed:failure"
SKIPPED="$WORK_DIR/skipped.json"
checks_fixture "$SKIPPED" "CI Gate:completed:success" "Mobile:completed:skipped"
NO_CHECKS="$WORK_DIR/no_checks.json"
checks_fixture "$NO_CHECKS"

NO_STATUS="$WORK_DIR/no_status.json"
status_fixture "$NO_STATUS"
STATUS_RED="$WORK_DIR/status_red.json"
status_fixture "$STATUS_RED" "security/scan:failure"

MOBILE_RUNNING="$WORK_DIR/mobile_running.json"
checks_fixture "$MOBILE_RUNNING" "CI Gate:completed:success" "Mobile:in_progress:none"
MOBILE_FAILED="$WORK_DIR/mobile_failed.json"
checks_fixture "$MOBILE_FAILED" "CI Gate:completed:success" "Mobile:completed:failure"
ONLY_MOBILE="$WORK_DIR/only_mobile.json"
checks_fixture "$ONLY_MOBILE" "Mobile:completed:success"

API_DOWN="$WORK_DIR/api_down"
printf 'FAIL' > "$API_DOWN"
TRUNCATED="$WORK_DIR/truncated.json"
printf '{"total_count": 12, "check_runs": [{"name":"CI Gate","status":"completed","conclusion":"success"}]}' > "$TRUNCATED"

# ── An untested commit is not a passing one ─────────────────────────────
#
# Zero check runs is the case that must not be read as consent. It is what a
# commit looks like in the seconds before CI starts.
out="$(run_deploy "$CODE_ONLY" "$BASE" "$NO_CHECKS" "$NO_STATUS" 1)"
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
out="$(run_deploy "$CODE_ONLY" "$BASE" "$RUNNING" "$NO_STATUS" 1)"
if is_state "$out" waiting_ci; then
  pass "a commit with CI in progress waits"
else
  fail "a commit was deployed while CI was still running"
fi

# ── A failing check blocks ──────────────────────────────────────────────
out="$(run_deploy "$CODE_ONLY" "$BASE" "$RED" "$NO_STATUS" 1)"
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
out="$(run_deploy "$CODE_ONLY" "$BASE" "$GREEN" "$NO_STATUS" 1)"
if is_state "$out" deployed; then
  pass "no commit statuses does not block a green commit"
else
  fail "a green commit was blocked by an empty status list"
fi

# ── `skipped` and `neutral` are passes ──────────────────────────────────
out="$(run_deploy "$CODE_ONLY" "$BASE" "$SKIPPED" "$NO_STATUS" 1)"
if is_state "$out" deployed; then
  pass "a skipped job does not count as a failure"
else
  fail "a skipped job was treated as a failure"
fi

# ── Already deployed is not a deploy ────────────────────────────────────
out="$(run_deploy "$CODE_ONLY" "$CODE_ONLY" "$GREEN" "$NO_STATUS" 1)"
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
out="$(run_deploy "$CODE_ONLY" "$BASE" "$GREEN" "$NO_STATUS" 1)"
if is_state "$out" blocked_nginx; then
  pass "a revision needing a vhost change is refused"
else
  fail "a vhost change was silently skipped"
fi
printf 'vhost\n' > "$WORK_DIR/vhost.deployed"

# ── A bad deploy with no schema change is put back ──────────────────────
out="$(run_deploy "$CODE_ONLY" "$BASE" "$GREEN" "$NO_STATUS" recover)"
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
out="$(run_deploy "$CODE_ONLY" "$BASE" "$GREEN" "$NO_STATUS" 0)"
if is_state "$out" stuck; then
  pass "a rollback that does not restore health reports stuck"
else
  fail "a rollback that left the site down was reported as recovered"
fi

# ── A bad deploy that migrated is left alone ────────────────────────────
#
# The old binary refuses to start against a schema carrying a migration it does
# not know, so putting it back turns a broken site into one that will not boot.
out="$(run_deploy "$WITH_MIGRATION" "$CODE_ONLY" "$GREEN" "$NO_STATUS" 0)"
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

# ── An edge failure is not an image failure ─────────────────────────────
#
# The containers answer on their own ports; only the public URL is down, which
# means nginx or Cloudflare. Rolling back would revert a working release and
# fix nothing, so this must report rather than repair.
out="$(run_deploy "$CODE_ONLY" "$BASE" "$GREEN" "$NO_STATUS" 1 0)"
if is_state "$out" edge_unhealthy; then
  pass "a healthy release behind a broken edge is reported, not rolled back"
else
  fail "an edge failure was misread as a bad release"
fi
if ! grep -q "tag cinetrack-backend:rollback cinetrack-backend:latest" "$ACTIONS"; then
  pass "no rollback was attempted for an edge failure"
else
  fail "a good release was rolled back because the edge was down"
fi

# ── A check that cannot speak for the artifacts does not hold them up ───
#
# The mobile app ships through EAS and the Play Store, never through this host,
# and a revision that touches no mobile file cannot change what its build
# produces. Waiting on it delays a web deploy for a verdict about something
# else entirely.
out="$(run_deploy "$CODE_ONLY" "$BASE" "$MOBILE_RUNNING" "$NO_STATUS" 1)"
if is_state "$out" deployed; then
  pass "a still-running mobile build does not delay a web-only revision"
else
  fail "a web-only revision waited on a mobile build"
fi

# Waiving covers failure too: a result that cannot bear on these artifacts is
# not evidence about them in either direction, and this job has failed on
# Expo's release schedule rather than on anything in the repository.
out="$(run_deploy "$CODE_ONLY" "$BASE" "$MOBILE_FAILED" "$NO_STATUS" 1)"
if is_state "$out" deployed; then
  pass "a failing mobile build does not block a web-only revision"
else
  fail "a web-only revision was blocked by a mobile failure"
fi

# ── But it holds them up the moment it is relevant ──────────────────────
out="$(run_deploy "$TOUCHES_MOBILE" "$CODE_ONLY" "$MOBILE_RUNNING" "$NO_STATUS" 1)"
if is_state "$out" waiting_ci; then
  pass "a revision touching mobile/ waits for the mobile build again"
else
  fail "a revision touching mobile/ skipped its own build"
fi

out="$(run_deploy "$TOUCHES_MOBILE" "$CODE_ONLY" "$MOBILE_FAILED" "$NO_STATUS" 1)"
if is_state "$out" blocked_ci; then
  pass "a revision touching mobile/ is blocked by a failing mobile build"
else
  fail "a revision touching mobile/ ignored its own failing build"
fi

# ── Waiving everything is not approval ──────────────────────────────────
#
# If the only check present is one that gets waived, nothing examined this
# revision at all, and that must read the same as having no checks.
out="$(run_deploy "$CODE_ONLY" "$BASE" "$ONLY_MOBILE" "$NO_STATUS" 1)"
if is_state "$out" waiting_ci; then
  pass "a revision whose only check was waived is not deployed"
else
  fail "a revision deployed with every check waived"
fi

# ── An unknown starting point waives nothing ────────────────────────────
#
# Without a previous revision there is no range to test paths against, so
# relevance cannot be established and nothing is skipped.
out="$(run_deploy "$CODE_ONLY" "" "$MOBILE_RUNNING" "$NO_STATUS" 1)"
if is_state "$out" waiting_ci; then
  pass "nothing is waived when the deployed revision is unknown"
else
  fail "a check was waived without a range to justify it"
fi

# ── An unreadable API is not a pass ─────────────────────────────────────
#
# Anonymous calls are rate limited. When the answer cannot be obtained, the
# commit is unverified, and unverified never ships.
out="$(run_deploy "$CODE_ONLY" "$BASE" "$API_DOWN" "$NO_STATUS" 1)"
if is_state "$out" blocked_api; then
  pass "an unreadable GitHub API blocks the deploy"
else
  fail "a deploy went ahead without being able to read CI results"
fi

out="$(run_deploy "$CODE_ONLY" "$BASE" "$GREEN" "$API_DOWN" 1)"
if is_state "$out" blocked_api; then
  pass "an unreadable status API blocks the deploy"
else
  fail "a deploy went ahead without being able to read commit statuses"
fi

# ── A truncated page is not a verdict ───────────────────────────────────
#
# Twelve checks exist and one came back. The eleven missing could be the
# failing ones, so the visible subset must not be mistaken for the whole.
out="$(run_deploy "$CODE_ONLY" "$BASE" "$TRUNCATED" "$NO_STATUS" 1)"
if is_state "$out" blocked_api; then
  pass "a partial check-run page is refused rather than judged"
else
  fail "a deploy was approved on an incomplete list of checks"
fi

# ── An unknown starting point keeps the rollback path closed ────────────
#
# Without a known previous revision there is no way to tell whether schema
# moved, and guessing "it did not" is the guess that cannot be recovered from.
out="$(run_deploy "$CODE_ONLY" "" "$GREEN" "$NO_STATUS" 0)"
if is_state "$out" stuck; then
  pass "an unknown deployed revision is treated as unsafe to roll back"
else
  fail "an unknown deployed revision was rolled back on a guess"
fi

# A release is only healthy if the product works, not if the process answers.
#
# The probes defaulted to `/api/health`, which is liveness: it reports from the
# process and never touches PostgreSQL. A backend that starts and then loses the
# database passes it, so a release that could serve nobody was recorded as
# deployed. Readiness asks the database.
DEPLOY_SCRIPT="$ROOT_DIR/scripts/auto_deploy.sh"
for variable in LOCAL_BACKEND_URL PUBLIC_HEALTH_URL; do
  if grep -qE "^$variable=.*/api/health\"" "$DEPLOY_SCRIPT"; then
    fail "$variable still defaults to liveness; a backend that cannot reach the database would pass"
  elif grep -qE "^$variable=.*/api/health/ready" "$DEPLOY_SCRIPT"; then
    pass "$variable probes readiness, not just the process"
  else
    fail "$variable does not probe readiness"
  fi
done

# A release verdict must exist and must be a real pass.
#
# M13. The gate accepted any non-empty set of good verdicts, so a window where
# only a scanner had registered read as approval. These two fixtures are the
# shapes that used to pass and must not.
ONLY_SCANNER="$WORK_DIR/only-scanner.json"
checks_fixture "$ONLY_SCANNER" "Secret Scan:completed:success"
out="$(run_deploy "$CODE_ONLY" "$BASE" "$ONLY_SCANNER" "$NO_STATUS" 1)"
if is_state "$out" waiting_ci; then
  pass "a green set without the release verdict does not ship"
else
  fail "a green set without the release verdict was accepted"
fi

SKIPPED_GATE="$WORK_DIR/skipped-gate.json"
checks_fixture "$SKIPPED_GATE" "CI Gate:completed:skipped" "Backend:completed:success"
out="$(run_deploy "$CODE_ONLY" "$BASE" "$SKIPPED_GATE" "$NO_STATUS" 1)"
if is_state "$out" blocked_ci; then
  pass "a skipped release verdict does not ship"
else
  fail "a skipped release verdict was accepted"
fi

if (( FAILURES > 0 )); then
  printf '\n%d contract(s) failed\n' "$FAILURES"
  exit 1
fi
printf '\nall auto-deploy contracts hold\n'
