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
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="${DEPLOY_DRIFT_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/cinetrack}"
METRICS_FILE="${DEPLOY_DRIFT_METRICS_FILE:-$STATE_DIR/deploy_drift.prom}"
CONTAINER="${DEPLOY_DRIFT_CONTAINER:-cinetrack-backend-1}"
BRANCH="${DEPLOY_DRIFT_BRANCH:-origin/main}"

# Paths whose changes require a deploy to take effect. A commit that only
# touches the mobile app ships through EAS and Play, never through this host, so
# counting it would raise an alert no deploy can clear — and an alert that
# cannot be cleared is one people learn to ignore.
DEPLOYABLE_PATHS=(backend/ frontend/ nginx/ ops/ docker-compose.prod.yml)

mkdir -p "$STATE_DIR"

pending=0
revision_known=0

deployed_revision() {
  docker inspect "$CONTAINER" \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true
}

revision="$(deployed_revision)"

if [[ -n "$revision" && "$revision" != "unknown" ]] \
  && git -C "$REPO_DIR" cat-file -e "${revision}^{commit}" 2>/dev/null; then
  revision_known=1
  # Read-only: fetch updates the remote-tracking ref and touches nothing the
  # person working in this checkout can see.
  git -C "$REPO_DIR" fetch --quiet origin main 2>/dev/null || true
  pending="$(git -C "$REPO_DIR" rev-list --count "${revision}..${BRANCH}" \
    -- "${DEPLOYABLE_PATHS[@]}" 2>/dev/null || echo 0)"
fi

tmp="$(mktemp "${METRICS_FILE}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
{
  printf '# HELP cinetrack_deploy_pending_commits Deployable commits on %s that production has not received.\n' "$BRANCH"
  printf '# TYPE cinetrack_deploy_pending_commits gauge\n'
  printf 'cinetrack_deploy_pending_commits %s\n' "$pending"
  printf '# HELP cinetrack_deploy_revision_known Whether the running container reports the commit it was built from.\n'
  printf '# TYPE cinetrack_deploy_revision_known gauge\n'
  printf 'cinetrack_deploy_revision_known %s\n' "$revision_known"
  printf '# HELP cinetrack_deploy_drift_checked_timestamp_seconds When this check last ran.\n'
  printf '# TYPE cinetrack_deploy_drift_checked_timestamp_seconds gauge\n'
  printf 'cinetrack_deploy_drift_checked_timestamp_seconds %s\n' "$(date -u +%s)"
} > "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$METRICS_FILE"
trap - EXIT

if (( revision_known == 0 )); then
  echo "[$(date -u +%FT%TZ)] the running image carries no usable revision label; deploy once with GIT_REVISION set." >&2
elif (( pending > 0 )); then
  echo "[$(date -u +%FT%TZ)] production is $pending deployable commit(s) behind $BRANCH." >&2
fi
