#!/usr/bin/env bash
set -euo pipefail

# Install Playwright browsers and their system libraries on a CI runner,
# without letting a slow apt mirror take the whole job.
#
# `playwright install --with-deps` apt-installs about 119 MB of fonts and media
# libraries on every run; the browser cache does not cover them. Usually that
# takes 30 seconds. On 2026-10-26 azure.archive.ubuntu.com served it at about
# 45 KB/s, for an estimated 45 minutes, and the job was cancelled at its
# 40-minute limit before a single test ran.
#
# So:
#
#   1. The downloaded packages are kept in a directory the workflow caches next
#      to the browsers, and put back into apt's archive before installing, so a
#      warm run downloads nothing.
#   2. The system libraries are installed as root, under a time cap enforced by
#      root. The first version capped `npx` as the runner user; a timeout cannot
#      signal a root process, so apt-get outlived it, kept the dpkg lock, and the
#      retries all failed on that lock.
#   3. Each step is capped and retried, and reports why an attempt failed.
#   4. A retry of the system libraries leaves Azure's mirror out. The cold run
#      on main after the cache landed met the same 45 KB/s twice more; apt
#      resumes partial downloads, but at that rate three capped attempts still
#      fetched only half. The runner's mirror list falls back to
#      archive.ubuntu.com, which is a different path from the same machine.
#
# Usage: ci_playwright_install.sh <browser>...   (run from the Playwright project)

ATTEMPTS="${PLAYWRIGHT_INSTALL_ATTEMPTS:-3}"
ATTEMPT_SECONDS="${PLAYWRIGHT_INSTALL_ATTEMPT_SECONDS:-480}"
DEB_CACHE="${PLAYWRIGHT_DEB_CACHE:-$HOME/.cache/playwright-apt}"
APT_ARCHIVES="${PLAYWRIGHT_APT_ARCHIVES:-/var/cache/apt/archives}"
APT_MIRRORS="${PLAYWRIGHT_APT_MIRRORS:-/etc/apt/apt-mirrors.txt}"

if (( $# == 0 )); then
  echo "usage: $0 <browser>..." >&2
  exit 2
fi

# A connection that stops sending is dropped instead of waited on, and the
# packages apt-get fetches stay in its archive for step 1 to keep.
printf '%s\n' \
  'Acquire::http::Timeout "30";' \
  'Acquire::https::Timeout "30";' \
  'Acquire::Retries "3";' \
  'APT::Keep-Downloaded-Packages "true";' \
  'Binary::apt-get::APT::Keep-Downloaded-Packages "true";' \
  | sudo tee /etc/apt/apt.conf.d/99ci-playwright >/dev/null

mkdir -p "$DEB_CACHE"
cached=("$DEB_CACHE"/*.deb)
if [[ -e "${cached[0]}" ]]; then
  sudo cp "${cached[@]}" "$APT_ARCHIVES/"
  echo "restored ${#cached[@]} cached system packages"
fi

# Take Azure's mirror out of the runner's mirror list, if there is anything
# else in it to fall back to.
skip_azure_mirror() {
  [[ -f "$APT_MIRRORS" ]] || return 0
  grep -q 'azure\.archive\.ubuntu\.com' "$APT_MIRRORS" || return 0
  local others
  others="$(grep -v 'azure\.archive\.ubuntu\.com' "$APT_MIRRORS" || true)"
  [[ -n "$others" ]] || return 0
  printf '%s\n' "$others" | sudo tee "$APT_MIRRORS" >/dev/null
  echo "::notice::retrying without azure.archive.ubuntu.com: $(head -n1 <<< "$others")"
}

# retry <what> <command>...: run the command until it succeeds, at most
# ATTEMPTS times, saying each time why it did not.
retry() {
  local what="$1" attempt status reason
  shift
  for (( attempt = 1; attempt <= ATTEMPTS; attempt++ )); do
    status=0
    "$@" || status=$?
    if (( status == 0 )); then
      return 0
    fi
    if (( status == 124 || status == 137 )); then
      reason="stalled past ${ATTEMPT_SECONDS}s"
    else
      reason="exited $status"
    fi
    echo "::warning::Playwright $what attempt $attempt/$ATTEMPTS $reason"
    # A killed apt-get can leave dpkg half way through; the next attempt
    # cannot start until that is finished.
    if [[ "$what" == "system libraries" ]]; then
      sudo dpkg --configure -a >/dev/null 2>&1 || true
      skip_azure_mirror
    fi
  done
  echo "::error::Playwright $what failed $ATTEMPTS times; see the attempts above"
  return 1
}

retry "system libraries" \
  sudo env "PATH=$PATH" timeout --kill-after=15 "$ATTEMPT_SECONDS" \
  npx playwright install-deps "$@"
retry "browsers" \
  timeout --kill-after=15 "$ATTEMPT_SECONDS" npx playwright install "$@"

# Keep this run's packages for the next one, minus any that are no longer
# current, so a cache restored across lockfile changes does not only grow. Best
# effort: a run that cannot save them has still installed everything it needs.
sudo apt-get autoclean -qq >/dev/null 2>&1 || true
fetched=("$APT_ARCHIVES"/*.deb)
if [[ -e "${fetched[0]}" ]]; then
  rm -f "$DEB_CACHE"/*.deb
  cp "${fetched[@]}" "$DEB_CACHE/" 2>/dev/null || true
fi
