#!/usr/bin/env bash
# Contracts for scripts/ci_playwright_install.sh, against stubbed `npx`,
# `sudo` and `dpkg`.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="$(mktemp -d)"
STUB_DIR="$WORK_DIR/bin"
mkdir -p "$STUB_DIR"
cleanup() {
  # A stub child that survived would outlive the test; that is a failure below,
  # but it must not be left running.
  if [[ -f "$WORK_DIR/child.pid" ]]; then kill "$(cat "$WORK_DIR/child.pid")" 2>/dev/null || true; fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

failures=0
pass() { printf 'ok    %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }

# `sudo tee <file>` writes into the world instead of /etc; every sudo call is
# logged, then run as the current user.
cat > "$STUB_DIR/sudo" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_WORLD/sudo.log"
if [[ "$1" == tee ]]; then
  # /etc stays untouched; anything else (the world's mirror list) is written.
  if [[ "$2" == /etc/* ]]; then cat > "$STUB_WORLD/apt.conf"; else cat > "$2"; fi
else
  exec "$@"
fi
STUB
cat > "$STUB_DIR/dpkg" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_WORLD/dpkg.log"
STUB
# Never the real apt-get: autoclean drops the world's stale package.
cat > "$STUB_DIR/apt-get" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_WORLD/apt-get.log"
rm -f "$STUB_WORLD"/archives/*_0.9.deb
STUB
# `npx playwright install-deps` and `npx playwright install` each take the next
# line of their own plan: ok, hang, orphan, or anything else to fail. `orphan`
# hangs with a child process, the way playwright's apt-get hangs under it.
cat > "$STUB_DIR/npx" <<'STUB'
#!/usr/bin/env bash
kind=browsers
[[ "$2" == install-deps ]] && kind=deps
n=$(( $(cat "$STUB_WORLD/$kind.count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STUB_WORLD/$kind.count"
echo "$*" >> "$STUB_WORLD/npx.log"
case "$(sed -n "${n}p" "$STUB_WORLD/$kind.plan")" in
  ok)
    [[ "$kind" == deps ]] && echo deb > "$STUB_WORLD/archives/libfresh_1.0.deb"
    exit 0 ;;
  hang) sleep 30 ;;
  orphan) sleep 300 & echo $! > "$STUB_WORLD/child.pid"; wait ;;
  *) exit 7 ;;
esac
STUB
chmod +x "$STUB_DIR"/*

# run "<deps plan>" "<browsers plan>"
run() {
  rm -rf "$WORK_DIR"/*.log "$WORK_DIR"/*.count "$WORK_DIR/apt.conf" "$WORK_DIR/archives"
  mkdir -p "$WORK_DIR/archives" "$WORK_DIR/debs"
  printf '%s\n' \
    $'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1' \
    $'https://archive.ubuntu.com/ubuntu/\tpriority:2' > "$WORK_DIR/mirrors"
  tr ' ' '\n' <<< "$1" > "$WORK_DIR/deps.plan"
  tr ' ' '\n' <<< "$2" > "$WORK_DIR/browsers.plan"
  set +e
  PATH="$STUB_DIR:$PATH" STUB_WORLD="$WORK_DIR" \
    PLAYWRIGHT_INSTALL_ATTEMPT_SECONDS=2 \
    PLAYWRIGHT_DEB_CACHE="$WORK_DIR/debs" PLAYWRIGHT_APT_ARCHIVES="$WORK_DIR/archives" \
    PLAYWRIGHT_APT_MIRRORS="$WORK_DIR/mirrors" \
    "$ROOT_DIR/scripts/ci_playwright_install.sh" chromium webkit > "$WORK_DIR/out" 2>&1
  code=$?
  set -e
  deps=$(cat "$WORK_DIR/deps.count" 2>/dev/null || echo 0)
  browsers=$(cat "$WORK_DIR/browsers.count" 2>/dev/null || echo 0)
}

run ok ok
if (( code == 0 && deps == 1 && browsers == 1 )) \
  && grep -qx 'playwright install-deps chromium webkit' "$WORK_DIR/npx.log" \
  && grep -qx 'playwright install chromium webkit' "$WORK_DIR/npx.log"; then
  pass "a clean run installs the libraries, then the browsers, once each"
else
  fail "a clean run: exit $code, deps $deps, browsers $browsers, $(cat "$WORK_DIR/out")"
fi

# The capped command has to run as root, or the cap cannot reach apt-get.
if grep -qE '^env PATH=.* timeout --kill-after=15 2 npx playwright install-deps' "$WORK_DIR/sudo.log"; then
  pass "the system libraries are installed under a time cap that runs as root"
else
  fail "install-deps is not capped from inside sudo: $(cat "$WORK_DIR/sudo.log")"
fi

if grep -q 'Acquire::http::Timeout "30";' "$WORK_DIR/apt.conf" \
  && grep -q 'Binary::apt-get::APT::Keep-Downloaded-Packages "true";' "$WORK_DIR/apt.conf"; then
  pass "apt drops silent connections and keeps what it downloads"
else
  fail "apt configuration was not written"
fi

if grep -q azure "$WORK_DIR/mirrors" && ! grep -q '::notice::' "$WORK_DIR/out"; then
  pass "a run that needs no retry leaves the mirror list alone"
else
  fail "a clean run changed the mirror list"
fi

if [[ -f "$WORK_DIR/debs/libfresh_1.0.deb" ]]; then
  pass "packages apt downloaded are kept for the workflow cache"
else
  fail "downloaded packages were not copied to the cache directory"
fi

# A warm cache goes back into apt's archive before anything is installed.
rm -rf "$WORK_DIR/debs"; mkdir -p "$WORK_DIR/debs"
echo deb > "$WORK_DIR/debs/libcached_1.0.deb"
mkdir -p "$WORK_DIR/archives"
rm -f "$WORK_DIR"/*.count "$WORK_DIR"/*.log
printf 'ok\n' > "$WORK_DIR/deps.plan"; printf 'ok\n' > "$WORK_DIR/browsers.plan"
PATH="$STUB_DIR:$PATH" STUB_WORLD="$WORK_DIR" PLAYWRIGHT_INSTALL_ATTEMPT_SECONDS=2 \
  PLAYWRIGHT_DEB_CACHE="$WORK_DIR/debs" PLAYWRIGHT_APT_ARCHIVES="$WORK_DIR/archives" \
  PLAYWRIGHT_APT_MIRRORS="$WORK_DIR/mirrors" \
  "$ROOT_DIR/scripts/ci_playwright_install.sh" chromium > "$WORK_DIR/out" 2>&1
if [[ -f "$WORK_DIR/archives/libcached_1.0.deb" ]] && grep -q 'restored 1 cached' "$WORK_DIR/out"; then
  pass "cached packages are restored into apt's archive first"
else
  fail "cached packages were not restored: $(cat "$WORK_DIR/out")"
fi

# Restored across a lockfile change, the cache must not keep superseded files.
rm -rf "$WORK_DIR/debs" "$WORK_DIR/archives"; mkdir -p "$WORK_DIR/debs" "$WORK_DIR/archives"
echo deb > "$WORK_DIR/debs/libold_0.9.deb"
rm -f "$WORK_DIR"/*.count "$WORK_DIR"/*.log
printf 'ok\n' > "$WORK_DIR/deps.plan"; printf 'ok\n' > "$WORK_DIR/browsers.plan"
PATH="$STUB_DIR:$PATH" STUB_WORLD="$WORK_DIR" PLAYWRIGHT_INSTALL_ATTEMPT_SECONDS=2 \
  PLAYWRIGHT_DEB_CACHE="$WORK_DIR/debs" PLAYWRIGHT_APT_ARCHIVES="$WORK_DIR/archives" \
  PLAYWRIGHT_APT_MIRRORS="$WORK_DIR/mirrors" \
  "$ROOT_DIR/scripts/ci_playwright_install.sh" chromium > "$WORK_DIR/out" 2>&1
if [[ -f "$WORK_DIR/debs/libfresh_1.0.deb" && ! -f "$WORK_DIR/debs/libold_0.9.deb" ]] \
  && grep -q autoclean "$WORK_DIR/apt-get.log"; then
  pass "superseded packages are dropped before the cache is saved"
else
  fail "the cache kept a superseded package: $(ls "$WORK_DIR/debs")"
fi

# The 2026-10-26 failure, second time round: the attempt hangs with a child
# holding on. The whole group must go, or the retry meets its lock.
run "orphan ok" ok
child_alive=no
if [[ -f "$WORK_DIR/child.pid" ]] && kill -0 "$(cat "$WORK_DIR/child.pid")" 2>/dev/null; then
  child_alive=yes
fi
if (( code == 0 && deps == 2 )) && [[ "$child_alive" == no ]] \
  && grep -q 'system libraries attempt 1/3 stalled' "$WORK_DIR/out" \
  && grep -q -- '--configure -a' "$WORK_DIR/dpkg.log"; then
  pass "a stalled attempt is killed with its children, dpkg is repaired, and it is retried"
else
  fail "a stalled attempt: exit $code, deps $deps, child alive $child_alive, $(cat "$WORK_DIR/out")"
fi

run "fail fail ok" "hang ok"
if (( code == 0 && deps == 3 && browsers == 2 )) \
  && grep -q 'system libraries attempt 2/3 exited 7' "$WORK_DIR/out" \
  && grep -q 'browsers attempt 1/3 stalled' "$WORK_DIR/out"; then
  pass "each step is retried on its own, with the reason reported"
else
  fail "retries: exit $code, deps $deps, browsers $browsers"
fi

# The cold run on main: Azure's mirror crawls, so a retry goes elsewhere.
run "fail ok" ok
if (( code == 0 )) && ! grep -q azure "$WORK_DIR/mirrors" \
  && grep -q '^https://archive.ubuntu.com/ubuntu/' "$WORK_DIR/mirrors" \
  && grep -q '::notice::retrying without azure.archive.ubuntu.com' "$WORK_DIR/out"; then
  pass "a retry of the system libraries leaves Azure's mirror out"
else
  fail "mirror fallback: exit $code, mirrors $(cat "$WORK_DIR/mirrors")"
fi

# With nothing to fall back to, the list is not emptied.
rm -f "$WORK_DIR"/*.count "$WORK_DIR"/*.log
printf 'fail\nok\n' > "$WORK_DIR/deps.plan"; printf 'ok\n' > "$WORK_DIR/browsers.plan"
printf '%s\n' $'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1' > "$WORK_DIR/mirrors"
PATH="$STUB_DIR:$PATH" STUB_WORLD="$WORK_DIR" PLAYWRIGHT_INSTALL_ATTEMPT_SECONDS=2 \
  PLAYWRIGHT_DEB_CACHE="$WORK_DIR/debs" PLAYWRIGHT_APT_ARCHIVES="$WORK_DIR/archives" \
  PLAYWRIGHT_APT_MIRRORS="$WORK_DIR/mirrors" \
  "$ROOT_DIR/scripts/ci_playwright_install.sh" chromium > "$WORK_DIR/out" 2>&1 || true
if grep -q azure "$WORK_DIR/mirrors"; then
  pass "a mirror list with only Azure in it is kept"
else
  fail "the only mirror was removed"
fi

run "fail hang fail ok" ok
if (( code == 1 && deps == 3 && browsers == 0 )) \
  && grep -q '::error::Playwright system libraries failed 3 times' "$WORK_DIR/out"; then
  pass "after the last attempt the step fails with a reason, before the browsers"
else
  fail "exhausted attempts: exit $code, deps $deps, browsers $browsers"
fi

set +e
"$ROOT_DIR/scripts/ci_playwright_install.sh" > /dev/null 2>&1
code=$?
set -e
if (( code == 2 )); then
  pass "no browsers named is a usage error"
else
  fail "no browsers named exited $code"
fi

if (( failures > 0 )); then
  printf '\n%d Playwright install contract(s) broken\n' "$failures"
  exit 1
fi
printf '\nall Playwright install contracts hold\n'
