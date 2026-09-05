#!/usr/bin/env bash
# Deploy `main` to production when CI has passed, and undo it when it breaks.
#
# `check_deploy_drift.sh` measures the gap between `main` and production but
# deliberately does not close it. This closes it, without giving up the property
# that made deploying manual in the first place: there is still no GitHub
# Actions deploy workflow and no inbound path to the VPS. This runs *here*, from
# cron, and pulls. A compromised build action still cannot reach production; it
# can only produce a commit, which must then pass CI to be picked up.
#
# The repository is public, so everything this needs is a public read: the
# fetch is anonymous and so are the two GitHub API calls. It deliberately does
# not use `gh`, whose stored token carries `admin:org`, `repo` and `workflow`
# scopes — an unattended deploy path should not have a credential sitting in it
# that can write anything, when what it actually needs is two GETs.
#
# # What it will not ship
#
# Anything CI has not finished, has failed, or has not checked at all. Zero
# check runs is "not tested yet", never "nothing to object to" — that
# distinction is the whole gate.
#
# # What it cannot undo
#
# Images roll back by tag. Schema does not. Migrations run forward only and
# `ensure_migrations_current` refuses to start a binary against a database
# carrying a migration it does not know, so restoring the old image after a
# migration would replace a broken application with one that will not boot.
#
# When a failed deploy included a migration this stops and alerts instead of
# rolling back. Broken and running is recoverable by a person; broken and
# refusing to start at 03:00 is worse.
#
# The nginx vhost is not in any image and needs root to install, so a revision
# that changes it is refused rather than half-deployed. That reload is shared
# with every other site on this host, which is not a blast radius to take
# unattended.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${AUTO_DEPLOY_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
STATE_DIR="${AUTO_DEPLOY_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/cinetrack}"
METRICS_FILE="${AUTO_DEPLOY_METRICS_FILE:-$STATE_DIR/auto_deploy.prom}"
BRANCH="${AUTO_DEPLOY_BRANCH:-origin/main}"
ENV_FILE="${AUTO_DEPLOY_ENV_FILE:-$REPO_DIR/.env.prod}"
# Two different questions, and conflating them causes the wrong repair.
#
# The local ports are the containers answering for themselves; that is what a
# rollback can fix. The public URL additionally crosses nginx and Cloudflare,
# neither of which is in any image — if that fails while the containers are
# fine, replacing the images reverts a good release and repairs nothing.
#
# Readiness, not liveness. `/api/health` answers from the process and says only
# that it is running; `/api/health/ready` asks the database. A backend that
# starts and then cannot reach PostgreSQL serves nothing a member wants and
# still passes liveness, so a release like that was reported as deployed.
#
# Liveness stays the container's own healthcheck, deliberately: a probe that
# fails when the database is down would restart-loop the API during a database
# incident, which repairs nothing and removes the logs.
LOCAL_BACKEND_URL="${AUTO_DEPLOY_LOCAL_BACKEND_URL:-http://127.0.0.1:8090/api/health/ready}"
LOCAL_FRONTEND_URL="${AUTO_DEPLOY_LOCAL_FRONTEND_URL:-http://127.0.0.1:8091/}"
PUBLIC_HEALTH_URL="${AUTO_DEPLOY_HEALTH_URL:-https://vazute.micutu.com/api/health/ready}"
VHOST_DEPLOYED="${AUTO_DEPLOY_VHOST_DEPLOYED:-/etc/nginx/sites-available/vazute.micutu.com}"
# Resolved from the remote rather than written with gh's `{owner}/{repo}`
# placeholders: those are expanded by shelling out to git in the *current*
# directory, and cron runs this from $HOME. The placeholder form failed closed
# — it reported no CI results and therefore never deployed anything — which is
# the safe direction to be wrong in, and completely useless.
REPO_SLUG="${AUTO_DEPLOY_REPO_SLUG:-}"
# The build tree. Never the working checkout: that sits on whatever branch is
# being worked on, and merging under it would move somebody's branch. A
# detached worktree also means a half-edited file cannot reach an image.
BUILD_DIR="${AUTO_DEPLOY_BUILD_DIR:-$STATE_DIR/build}"

# Checks that cannot speak for what this deploys.
#
# The mobile app ships through EAS and the Play Store, never through this host.
# `check_deploy_drift.sh` already encodes that fact by measuring each artifact
# against the paths that affect it, and the same reasoning applies to the gate:
# a React Native build says nothing about a backend or frontend image. The two
# clients share their encryption implementation by copy rather than by import,
# so no change outside `mobile/` can alter what the mobile build produces.
#
# This does not change what CI verifies. `main` still gets its native build on
# every push; the web deploy simply stops waiting on it. Waived only when the
# revision range touches none of the check's own paths — touch `mobile/` and it
# is required again, whether it is pending or failing.
#
# Waiving covers failure as well as pending on purpose. A check that cannot bear
# on the artifacts is not evidence about them in either direction, and the
# mobile job has a documented history of failing on Expo's release schedule
# rather than on anything in this repository. Blocking every web deploy on that
# would hand an outside party a switch over this pipeline.
WAIVABLE_CHECKS=("Mobile")
# Read through `declare -n` below, which ShellCheck cannot follow.
# shellcheck disable=SC2034
Mobile_paths=(mobile/ .github/workflows/ci.yml)
HEALTH_ATTEMPTS="${AUTO_DEPLOY_HEALTH_ATTEMPTS:-30}"
HEALTH_INTERVAL="${AUTO_DEPLOY_HEALTH_INTERVAL:-4}"

# `--dry-run` runs every check and reports the decision without touching
# production or writing metrics. It is how this gets verified against the real
# repository and the real CI results before it is ever allowed to run itself.
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

mkdir -p "$STATE_DIR"

say() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$1" >&2; }

# Emitted for the node exporter textfile collector that already serves
# `deploy_drift.prom`, so a deploy that fails overnight raises an alert instead
# of waiting to be found in a log file.
#
# Every state is written every run, including the zeros. A series that only
# appears when it is true cannot be alerted on with `== 1` without also
# alerting the moment it goes away.
STATES=(idle deployed waiting_ci blocked_ci blocked_nginx rolled_back stuck edge_unhealthy blocked_api)
report() {
  local current="$1" revision="${2:-}"
  local tmp
  tmp="$(mktemp "${METRICS_FILE}.XXXXXX")"
  {
    printf '# HELP cinetrack_auto_deploy_state What the last auto-deploy run concluded.\n'
    printf '# TYPE cinetrack_auto_deploy_state gauge\n'
    local state
    for state in "${STATES[@]}"; do
      printf 'cinetrack_auto_deploy_state{state="%s"} %s\n' \
        "$state" "$([[ "$state" == "$current" ]] && echo 1 || echo 0)"
    done
    printf '# HELP cinetrack_auto_deploy_run_timestamp_seconds When auto-deploy last ran.\n'
    printf '# TYPE cinetrack_auto_deploy_run_timestamp_seconds gauge\n'
    printf 'cinetrack_auto_deploy_run_timestamp_seconds %s\n' "$(date -u +%s)"
    if [[ "$current" == deployed ]]; then
      printf '# HELP cinetrack_auto_deploy_success_timestamp_seconds When auto-deploy last shipped a revision.\n'
      printf '# TYPE cinetrack_auto_deploy_success_timestamp_seconds gauge\n'
      printf 'cinetrack_auto_deploy_success_timestamp_seconds %s\n' "$(date -u +%s)"
    fi
  } > "$tmp"
  chmod 0644 "$tmp"
  if (( DRY_RUN == 1 )); then
    rm -f "$tmp"
  else
    mv -f "$tmp" "$METRICS_FILE"
  fi
  say "state=$current revision=${revision:0:8}"
}

compose() {
  docker compose -p cinetrack -f "$BUILD_DIR/docker-compose.prod.yml" \
    --project-directory "$BUILD_DIR" --env-file "$ENV_FILE" "$@"
}

deployed_revision() {
  docker inspect cinetrack-backend-1 \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true
}

probe() { curl --fail --silent --max-time 10 "$1" >/dev/null 2>&1; }

# Anonymous, and rate-limited to 60 requests an hour per address as a result.
# This runs every ten minutes and spends two, so the margin is wide — but if it
# is ever exhausted the call fails, and a failed call must never read as
# approval.
github_api() {
  curl --fail --silent --max-time 20 \
    --header "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO_SLUG/$1"
}

# Both containers, on their own published ports. This is the rollback trigger.
healthy() {
  local attempt=0
  while (( attempt < HEALTH_ATTEMPTS )); do
    if probe "$LOCAL_BACKEND_URL" && probe "$LOCAL_FRONTEND_URL"; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}

# The whole path a real user takes. Not a rollback trigger — only a report.
edge_healthy() {
  local attempt=0
  while (( attempt < 5 )); do
    probe "$PUBLIC_HEALTH_URL" && return 0
    attempt=$((attempt + 1))
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}

cleanup_worktree() {
  if [[ -d "$BUILD_DIR" ]]; then
    git -C "$REPO_DIR" worktree remove --force "$BUILD_DIR" 2>/dev/null || rm -rf "$BUILD_DIR"
  fi
}

[[ -r "$ENV_FILE" ]] || { say "no readable $ENV_FILE; this is not the production host"; exit 0; }

if [[ -z "$REPO_SLUG" ]]; then
  origin_url="$(git -C "$REPO_DIR" remote get-url origin)"
  # Both forms the remote can take: git@github.com:owner/repo.git and
  # https://github.com/owner/repo.git
  REPO_SLUG="$(sed -E 's#^.*github\.com[:/]##; s#\.git$##' <<<"$origin_url")"
fi
[[ "$REPO_SLUG" == */* ]] || { say "cannot determine the GitHub repository from origin"; exit 1; }

# Tolerated, like the drift check does: a transient network failure should not
# abort before anything has been reported. `origin/main` then keeps its last
# known value, which is a commit that already passed the same gate, and the
# drift metric shows the gap.
git -C "$REPO_DIR" fetch --quiet origin main 2>/dev/null || say "fetch failed; using the last known $BRANCH"
target="$(git -C "$REPO_DIR" rev-parse "$BRANCH")"
current="$(deployed_revision)"

if [[ "$target" == "$current" ]]; then
  report idle "$target"
  exit 0
fi

# Ask GitHub what it thinks of this commit. Read-only, and the answer must be
# unambiguous in the affirmative — anything else waits.
if ! checks_json="$(github_api "commits/$target/check-runs?per_page=100")"; then
  say "cannot read CI results from GitHub for ${target:0:8} (rate limit or network)"
  report blocked_api "$target"
  exit 0
fi

# A partial answer is not an answer. If more check runs exist than came back,
# the missing ones could be the failing ones, and approving on the visible
# subset is exactly the mistake this whole gate exists to prevent.
total_checks="$(jq -r '.total_count // 0' <<<"$checks_json")"
returned_checks="$(jq -r '.check_runs | length' <<<"$checks_json")"
if [[ "$total_checks" != "$returned_checks" ]]; then
  say "GitHub returned $returned_checks of $total_checks check runs for ${target:0:8}; not deciding on a partial answer"
  report blocked_api "$target"
  exit 0
fi

checks="$(jq -r '.check_runs[] | [.name, .status, (.conclusion // "none")] | @tsv' <<<"$checks_json")"

if [[ -z "$checks" ]]; then
  # No check runs at all. Either CI has not started yet or this commit is not
  # covered by any workflow. Both mean "unverified", and unverified never ships.
  say "no CI results yet for ${target:0:8}"
  report waiting_ci "$target"
  exit 0
fi

# Drop the checks this revision cannot have affected, before judging the rest.
waived=()
if [[ -n "$current" && "$current" != unknown ]] \
  && git -C "$REPO_DIR" cat-file -e "${current}^{commit}" 2>/dev/null; then
  for check in "${WAIVABLE_CHECKS[@]}"; do
    declare -n check_paths="${check}_paths"
    if [[ -z "$(git -C "$REPO_DIR" rev-list "${current}..${target}" --max-count=1 \
      -- "${check_paths[@]}" 2>/dev/null)" ]]; then
      waived+=("$check")
    fi
    unset -n check_paths
  done
fi

if (( ${#waived[@]} > 0 )); then
  # Exact names, not a regex: a check name is free text and could contain
  # anything a pattern would treat as syntax.
  # The trailing `-` is load-bearing: given only a filename, awk reads that
  # file and never touches stdin, so the here-string would be silently
  # discarded and every check would vanish along with it.
  checks="$(awk -F'\t' 'NR==FNR { skip[$0]=1; next } !($1 in skip)' \
    <(printf '%s\n' "${waived[@]}") - <<<"$checks")"
  say "not waiting on ${waived[*]}: this revision touches none of their paths"
fi

# Everything was waived, which means nothing actually examined this revision.
# However unlikely that is, it must not read as approval.
if [[ -z "$checks" ]]; then
  say "every check for ${target:0:8} was waived; nothing verified it"
  report waiting_ci "$target"
  exit 0
fi

pending="$(awk -F'\t' '$2 != "completed"' <<<"$checks" || true)"
if [[ -n "$pending" ]]; then
  say "CI still running for ${target:0:8}: $(awk -F'\t' '{print $1}' <<<"$pending" | paste -sd' ')"
  report waiting_ci "$target"
  exit 0
fi

# `neutral` and `skipped` are passes: a job that correctly decided it had
# nothing to do is not a failure. Everything else — failure, cancelled,
# timed_out, action_required — blocks.
bad="$(awk -F'\t' '$3 != "success" && $3 != "neutral" && $3 != "skipped"' <<<"$checks" || true)"
if [[ -n "$bad" ]]; then
  say "CI not green for ${target:0:8}: $(awk -F'\t' '{print $1"="$3}' <<<"$bad" | paste -sd' ')"
  report blocked_ci "$target"
  exit 0
fi

# Check runs are not the only verdict GitHub carries. The older commit-status
# API is what third-party integrations post to, and a scanner reporting there
# would be invisible to the query above.
#
# The combined `state` cannot be used directly: with no statuses at all GitHub
# reports the combination as `pending`, which is indistinguishable from a real
# one still running. Requiring it green would have blocked every deploy
# permanently. So the individual statuses are read instead, and an empty list
# means nothing to satisfy.
if ! status_json="$(github_api "commits/$target/status?per_page=100")"; then
  say "cannot read commit statuses from GitHub for ${target:0:8}"
  report blocked_api "$target"
  exit 0
fi
statuses="$(jq -r '.statuses[] | [.context, .state] | @tsv' <<<"$status_json")"
if [[ -n "$statuses" ]]; then
  bad_status="$(awk -F'\t' '$2 != "success"' <<<"$statuses" || true)"
  if [[ -n "$bad_status" ]]; then
    say "commit status not green for ${target:0:8}: $(awk -F'\t' '{print $1"="$2}' <<<"$bad_status" | paste -sd' ')"
    report blocked_ci "$target"
    exit 0
  fi
fi

# The vhost ships by hand. Refuse the whole revision rather than deploy the
# images and leave the edge behaving as it did before — that failure is silent,
# which is exactly how the event-stream release went out half-applied.
if [[ -r "$VHOST_DEPLOYED" ]] \
  && ! git -C "$REPO_DIR" show "$target:nginx/vazute.micutu.com.conf" 2>/dev/null \
     | cmp -s - "$VHOST_DEPLOYED"; then
  say "${target:0:8} changes the nginx vhost; that needs root and a shared reload. deploy it by hand."
  report blocked_nginx "$target"
  exit 0
fi

# Does this revision add schema? Decide before anything is replaced, because it
# determines whether a rollback is available at all.
migrations_added=0
if [[ -n "$current" && "$current" != unknown ]] \
  && git -C "$REPO_DIR" cat-file -e "${current}^{commit}" 2>/dev/null; then
  migrations_added="$(git -C "$REPO_DIR" rev-list --count "${current}..${target}" \
    -- backend/migrations/ 2>/dev/null || echo 0)"
else
  # Unknown starting point: assume the worst and keep the rollback path closed.
  migrations_added=1
fi

if (( DRY_RUN == 1 )); then
  say "would deploy ${target:0:8} (production has ${current:0:8}); migrations=$migrations_added; rollback=$( (( migrations_added > 0 )) && echo unavailable || echo available)"
  exit 0
fi

say "deploying ${target:0:8} (production has ${current:0:8}); migrations=$migrations_added"

cleanup_worktree
git -C "$REPO_DIR" worktree add --detach --quiet "$BUILD_DIR" "$target"
trap cleanup_worktree EXIT

# Keep what is running, so there is something to return to.
rollback_ready=1
for image in cinetrack-backend cinetrack-frontend; do
  if docker image inspect "$image:latest" >/dev/null 2>&1; then
    docker tag "$image:latest" "$image:rollback"
  else
    rollback_ready=0
  fi
done

# The sequence from docs/release-process.md, in that order and complete.
compose up -d db
"$BUILD_DIR/scripts/provision_db_role.sh" "$ENV_FILE"
GIT_REVISION="$target" compose build backend frontend
compose run --rm --no-deps backend /usr/local/bin/cinetrack --check-config
compose run --rm --no-deps backend /usr/local/bin/cinetrack --check-smtp
compose --profile ops run --rm migrate
"$BUILD_DIR/scripts/provision_db_role.sh" "$ENV_FILE"
compose up -d

if healthy; then
  if edge_healthy; then
    say "healthy on ${target:0:8}"
    report deployed "$target"
    exit 0
  fi
  # The release itself is good. Something between the containers and the
  # public name is not, and no image swap addresses that.
  say "containers are healthy on ${target:0:8} but $PUBLIC_HEALTH_URL is not answering; not rolling back"
  report edge_unhealthy "$target"
  exit 1
fi

say "containers unhealthy after deploying ${target:0:8}"

if (( migrations_added > 0 )); then
  say "this revision applied $migrations_added migration(s): the previous image would refuse to start against the new schema. leaving it up for a human."
  report stuck "$target"
  exit 1
fi
if (( rollback_ready == 0 )); then
  say "no saved images to return to."
  report stuck "$target"
  exit 1
fi

say "rolling back"
for image in cinetrack-backend cinetrack-frontend; do
  docker tag "$image:rollback" "$image:latest"
done
compose up -d

if healthy; then
  say "rolled back to ${current:0:8} and healthy"
  report rolled_back "$target"
else
  say "still unhealthy after rollback"
  report stuck "$target"
fi
exit 1
