#!/usr/bin/env bash
set -euo pipefail

# Install Playwright browsers and their system libraries on a CI runner,
# without letting a stalled mirror take the whole job.
#
# `playwright install --with-deps` runs apt-get, and apt's default is to wait
# on a connection that has stopped sending for as long as the job lets it. On
# 2026-10-26 one did: the download from azure.archive.ubuntu.com stopped at
# package 150, and forty minutes later the job was cancelled with no test run.
# Earlier runs of the same step took 404 s and 1,664 s where 30 s is normal.
#
# So apt gives up on a silent connection after 30 seconds and retries each file,
# and each whole attempt is capped and repeated. A slow mirror costs minutes;
# a dead one fails the step with a reason instead of a cancellation.
#
# Usage: ci_playwright_install.sh <browser>...   (run from the Playwright project)

ATTEMPTS="${PLAYWRIGHT_INSTALL_ATTEMPTS:-3}"
ATTEMPT_SECONDS="${PLAYWRIGHT_INSTALL_ATTEMPT_SECONDS:-360}"

if (( $# == 0 )); then
  echo "usage: $0 <browser>..." >&2
  exit 2
fi

printf '%s\n' \
  'Acquire::http::Timeout "30";' \
  'Acquire::https::Timeout "30";' \
  'Acquire::Retries "3";' \
  | sudo tee /etc/apt/apt.conf.d/99ci-network-timeouts >/dev/null

for (( attempt = 1; attempt <= ATTEMPTS; attempt++ )); do
  status=0
  timeout "$ATTEMPT_SECONDS" npx playwright install --with-deps "$@" || status=$?
  if (( status == 0 )); then
    exit 0
  fi
  if (( status == 124 )); then
    reason="stalled past ${ATTEMPT_SECONDS}s"
  else
    reason="exited $status"
  fi
  echo "::warning::Playwright install attempt $attempt/$ATTEMPTS $reason"
done

echo "::error::Playwright install failed $ATTEMPTS times; see the attempts above"
exit 1
