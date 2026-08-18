#!/usr/bin/env bash
# Report how far production has fallen behind `main`.
#
# There is no deploy workflow on purpose: the threat model treats a compromised
# CI action as something that must not be able to reach the VPS, so releases are
# run by hand. The cost of that choice is the failure it caused — two days of
# backend fixes sat on `main` while production ran the commit before them, and
# nothing anywhere said so. Neither the person who wrote them nor the person who
# merged them could see it.
#
# This measures the gap instead of closing it. Deploying stays manual and
# deliberate; forgetting stops being silent.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Overridable so the contract test can point this at a fixture repository with
# known commits, rather than asserting against whatever this checkout happens to
# contain today.
REPO_DIR="${DEPLOY_DRIFT_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
STATE_DIR="${DEPLOY_DRIFT_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/cinetrack}"
METRICS_FILE="${DEPLOY_DRIFT_METRICS_FILE:-$STATE_DIR/deploy_drift.prom}"
BRANCH="${DEPLOY_DRIFT_BRANCH:-origin/main}"
VHOST_SOURCE="${DEPLOY_DRIFT_VHOST_SOURCE:-$REPO_DIR/nginx/vazute.micutu.com.conf}"
VHOST_DEPLOYED="${DEPLOY_DRIFT_VHOST_DEPLOYED:-/etc/nginx/sites-available/vazute.micutu.com}"

# Production is not one artifact. The backend image, the frontend image and the
# host nginx vhost are built and installed separately, and each can be left
# behind on its own.
#
# Judging all three by the backend's label was wrong in both directions, and
# both were observed: a frontend-only release left the backend label behind and
# raised an alert with nothing to fix, and a backend-only release after a
# frontend change would have reported "up to date" over a stale bundle. An alert
# that cannot be cleared and an alert that never fires are the same failure —
# nobody acts on either.
#
# Each artifact is therefore measured against the paths that actually affect it.
# A commit touching only the mobile app ships through EAS and Play, never
# through this host, so it appears in no list.
ARTIFACT_CONTAINERS=(
  "backend:cinetrack-backend-1"
  "frontend:cinetrack-frontend-1"
)
# Read indirectly through `declare -n paths="${artifact}_paths"` below, which
# ShellCheck cannot follow — hence the disable rather than a real unused array.
# shellcheck disable=SC2034
backend_paths=(backend/ docker-compose.prod.yml ops/)
# shellcheck disable=SC2034
frontend_paths=(frontend/)

mkdir -p "$STATE_DIR"

deployed_revision() {
  docker inspect "$1" \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true
}

# Read-only, and done once rather than per artifact: fetch updates the
# remote-tracking ref and touches nothing the person working in this checkout
# can see.
git -C "$REPO_DIR" fetch --quiet origin main 2>/dev/null || true

declare -A artifact_pending=()
declare -A artifact_known=()
total_pending=0
all_known=1

for entry in "${ARTIFACT_CONTAINERS[@]}"; do
  artifact="${entry%%:*}"
  container="${entry#*:}"
  declare -n paths="${artifact}_paths"

  pending=0
  known=0
  revision="$(deployed_revision "$container")"
  if [[ -n "$revision" && "$revision" != "unknown" ]] \
    && git -C "$REPO_DIR" cat-file -e "${revision}^{commit}" 2>/dev/null; then
    known=1
    pending="$(git -C "$REPO_DIR" rev-list --count "${revision}..${BRANCH}" \
      -- "${paths[@]}" 2>/dev/null || echo 0)"
  fi

  artifact_pending["$artifact"]="$pending"
  artifact_known["$artifact"]="$known"
  total_pending=$((total_pending + pending))
  (( known == 1 )) || all_known=0
  unset -n paths
done

# The vhost is not an image, so there is no label to compare — only the file
# that is actually loaded. It is the artifact easiest to forget precisely
# because deploying it is a separate manual step, and until now the hourly check
# did not look at it at all: drift was caught only when somebody happened to run
# the local gate.
vhost_pending=0
if [[ -r "$VHOST_DEPLOYED" ]]; then
  cmp -s "$VHOST_SOURCE" "$VHOST_DEPLOYED" || vhost_pending=1
else
  # Unreadable means this is not the production host; report nothing rather
  # than a drift nobody here can act on.
  vhost_pending=0
fi
total_pending=$((total_pending + vhost_pending))

tmp="$(mktemp "${METRICS_FILE}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
{
  # The unlabelled total is kept so the existing alert and any dashboard keep
  # working unchanged; the labelled series is what says which artifact to
  # actually deploy.
  printf '# HELP cinetrack_deploy_pending_commits Deployable commits on %s that production has not received.\n' "$BRANCH"
  printf '# TYPE cinetrack_deploy_pending_commits gauge\n'
  printf 'cinetrack_deploy_pending_commits %s\n' "$total_pending"
  for artifact in "${!artifact_pending[@]}"; do
    printf 'cinetrack_deploy_pending_commits{artifact="%s"} %s\n' \
      "$artifact" "${artifact_pending[$artifact]}"
  done
  printf 'cinetrack_deploy_pending_commits{artifact="nginx"} %s\n' "$vhost_pending"

  printf '# HELP cinetrack_deploy_revision_known Whether the running container reports the commit it was built from.\n'
  printf '# TYPE cinetrack_deploy_revision_known gauge\n'
  printf 'cinetrack_deploy_revision_known %s\n' "$all_known"
  for artifact in "${!artifact_known[@]}"; do
    printf 'cinetrack_deploy_revision_known{artifact="%s"} %s\n' \
      "$artifact" "${artifact_known[$artifact]}"
  done

  printf '# HELP cinetrack_deploy_drift_checked_timestamp_seconds When this check last ran.\n'
  printf '# TYPE cinetrack_deploy_drift_checked_timestamp_seconds gauge\n'
  printf 'cinetrack_deploy_drift_checked_timestamp_seconds %s\n' "$(date -u +%s)"
} > "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$METRICS_FILE"
trap - EXIT

# Name the artifact in the message. "Production is 1 commit behind" sends
# somebody to redeploy everything to find out what; "frontend is 1 behind" does
# not.
for artifact in "${!artifact_known[@]}"; do
  if (( artifact_known[$artifact] == 0 )); then
    echo "[$(date -u +%FT%TZ)] the running $artifact image carries no usable revision label; deploy it once with GIT_REVISION set." >&2
  elif (( artifact_pending[$artifact] > 0 )); then
    echo "[$(date -u +%FT%TZ)] $artifact is ${artifact_pending[$artifact]} deployable commit(s) behind $BRANCH." >&2
  fi
done
if (( vhost_pending > 0 )); then
  echo "[$(date -u +%FT%TZ)] the deployed nginx vhost differs from $VHOST_SOURCE." >&2
fi
