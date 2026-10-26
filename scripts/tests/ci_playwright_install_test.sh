#!/usr/bin/env bash
# Contracts for scripts/ci_playwright_install.sh, against stubbed `npx` and `sudo`.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
STUB_DIR="$WORK_DIR/bin"
mkdir -p "$STUB_DIR"

failures=0
pass() { printf 'ok    %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }

# `sudo tee <file>` writes into the work dir instead of /etc; anything else runs.
cat > "$STUB_DIR/sudo" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == tee ]]; then cat > "$STUB_WORLD/apt.conf"; else "$@"; fi
STUB
# Each call takes the next line of plan: ok, hang, or anything else to fail.
cat > "$STUB_DIR/npx" <<'STUB'
#!/usr/bin/env bash
n=$(( $(cat "$STUB_WORLD/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STUB_WORLD/count"
echo "$*" >> "$STUB_WORLD/args"
case "$(sed -n "${n}p" "$STUB_WORLD/plan")" in
  ok) exit 0 ;;
  hang) sleep 30 ;;
  *) exit 7 ;;
esac
STUB
chmod +x "$STUB_DIR/sudo" "$STUB_DIR/npx"

run() {
  rm -f "$WORK_DIR/count" "$WORK_DIR/args" "$WORK_DIR/apt.conf"
  printf '%s\n' "$@" > "$WORK_DIR/plan"
  set +e
  PATH="$STUB_DIR:$PATH" STUB_WORLD="$WORK_DIR" PLAYWRIGHT_INSTALL_ATTEMPT_SECONDS=2 \
    "$ROOT_DIR/scripts/ci_playwright_install.sh" chromium webkit > "$WORK_DIR/out" 2>&1
  code=$?
  set -e
  calls=$(cat "$WORK_DIR/count" 2>/dev/null || echo 0)
}

run ok
if (( code == 0 && calls == 1 )) && grep -qx 'playwright install --with-deps chromium webkit' "$WORK_DIR/args"; then
  pass "a clean install runs once and passes the browsers through"
else
  fail "a clean install: exit $code, calls $calls, args $(cat "$WORK_DIR/args" 2>/dev/null)"
fi

if grep -q 'Acquire::http::Timeout "30";' "$WORK_DIR/apt.conf" \
  && grep -q 'Acquire::Retries "3";' "$WORK_DIR/apt.conf"; then
  pass "apt is told to give up on a silent connection and retry each file"
else
  fail "apt network timeouts were not written"
fi

# The 2026-10-26 failure: the first attempt stalls instead of failing.
run hang ok
if (( code == 0 && calls == 2 )) && grep -q 'attempt 1/3 stalled' "$WORK_DIR/out"; then
  pass "a stalled attempt is cut off and retried"
else
  fail "a stalled attempt: exit $code, calls $calls, $(cat "$WORK_DIR/out")"
fi

run fail fail ok
if (( code == 0 && calls == 3 )) && grep -q 'attempt 2/3 exited 7' "$WORK_DIR/out"; then
  pass "failed attempts are retried with their exit status reported"
else
  fail "failed attempts: exit $code, calls $calls"
fi

run fail hang fail ok
if (( code == 1 && calls == 3 )) && grep -q '::error::Playwright install failed 3 times' "$WORK_DIR/out"; then
  pass "after the last attempt the step fails with a reason, not a cancellation"
else
  fail "exhausted attempts: exit $code, calls $calls"
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
