#!/usr/bin/env bash
# Contracts for scripts/monitoring_watchdog.sh, against a stubbed `docker`.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
STUB_DIR="$WORK_DIR/bin"
mkdir -p "$STUB_DIR"

failures=0
pass() { printf 'ok    %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }

# The stub reads its world from files: <container>.running (true/false),
# <container>.finished (RFC 3339), <container>.policy, and prometheus answers.
# Every call is appended to calls.log.
cat > "$STUB_DIR/docker" <<'STUB'
#!/usr/bin/env bash
world="$STUB_WORLD"
echo "$*" >> "$world/calls.log"
case "$1" in
  inspect)
    format="$3"; container="$4"
    [[ -f "$world/$container.running" ]] || exit 1
    case "$format" in
      *State.Running*) cat "$world/$container.running" ;;
      *RestartPolicy*) cat "$world/$container.policy" ;;
      *FinishedAt*) cat "$world/$container.finished" ;;
    esac ;;
  start)
    [[ -f "$world/start-fails" ]] && exit 1
    echo true > "$world/$2.running"; echo "$2" ;;
  exec)
    container="$2"; shift 2
    url="${*: -1}"
    case "$url" in
      */-/healthy) [[ -f "$world/unhealthy" ]] && exit 1; echo ok ;;
      */api/v1/rules) printf '{"data":{"groups":[%s]}}' "$(cat "$world/groups")" ;;
      */api/v1/alertmanagers) printf '{"data":{"activeAlertmanagers":[%s]}}' "$(cat "$world/managers")" ;;
      */api/v2/alerts) for arg in "$@"; do [[ "$prev" == --post-data ]] && printf '%s' "$arg" > "$world/posted.json"; prev="$arg"; done ;;
    esac ;;
esac
STUB
chmod +x "$STUB_DIR/docker"

PROM=cinetrack-monitoring-prometheus-1
AM=cinetrack-monitoring-alertmanager-1
before_boot="2000-01-01T00:00:00Z"
after_boot="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# A healthy world; each case breaks one thing.
world() {
  WORLD="$WORK_DIR/world.$RANDOM"
  mkdir -p "$WORLD"
  : > "$WORLD/calls.log"
  for c in "$PROM" "$AM"; do
    echo true > "$WORLD/$c.running"
    echo unless-stopped > "$WORLD/$c.policy"
    echo "$before_boot" > "$WORLD/$c.finished"
  done
  echo '{"name":"cinetrack"}' > "$WORLD/groups"
  echo '{"url":"http://alertmanager:9093"}' > "$WORLD/managers"
}

run() {
  set +e
  PATH="$STUB_DIR:$PATH" STUB_WORLD="$WORLD" "$ROOT_DIR/scripts/monitoring_watchdog.sh" > "$WORLD/out.log" 2>&1
  code=$?
  set -e
}

posted() { [[ -f "$WORLD/posted.json" ]]; }
started() { grep -q "^start $1$" "$WORLD/calls.log"; }

world; run
if (( code == 0 )) && ! posted && ! started "$PROM"; then
  pass "a healthy monitoring stack is left alone and nothing is posted"
else
  fail "a healthy stack: exit $code, posted=$(posted && echo yes || echo no)"
fi

# The 2026-10-20 failure: down since before this boot, never brought back.
world; echo false > "$WORLD/$PROM.running"; run
if started "$PROM" && ! posted && (( code == 0 )); then
  pass "a Prometheus that went down with the host is started, and checked next run"
else
  fail "a Prometheus down since before the boot was not restarted: $(cat "$WORLD/out.log")"
fi

world; echo false > "$WORLD/$PROM.running"; echo "$after_boot" > "$WORLD/$PROM.finished"; run
if ! started "$PROM" && posted && (( code == 1 )); then
  pass "a Prometheus stopped after the boot is not restarted, but it is reported"
else
  fail "a deliberately stopped Prometheus: started=$(started "$PROM" && echo yes || echo no) posted=$(posted && echo yes || echo no)"
fi

world; echo false > "$WORLD/$PROM.running"; echo no > "$WORLD/$PROM.policy"; run
if ! started "$PROM" && posted; then
  pass "a container without a restart policy is reported rather than started"
else
  fail "a container without a restart policy was started or not reported"
fi

world; echo false > "$WORLD/$PROM.running"; touch "$WORLD/start-fails"; run
if posted && (( code == 1 )); then
  pass "a Prometheus that will not start is reported"
else
  fail "a Prometheus that would not start went unreported"
fi

world; touch "$WORLD/unhealthy"; run
if posted && grep -q "not healthy" "$WORLD/posted.json"; then
  pass "an unhealthy Prometheus is reported"
else
  fail "an unhealthy Prometheus was not reported"
fi

world; : > "$WORLD/groups"; run
if posted && grep -q "no alert rules" "$WORLD/posted.json"; then
  pass "a Prometheus with no rules loaded is reported"
else
  fail "a Prometheus with no rules loaded was not reported"
fi

world; : > "$WORLD/managers"; run
if posted && grep -q "no Alertmanager" "$WORLD/posted.json"; then
  pass "a Prometheus with no Alertmanager is reported"
else
  fail "a Prometheus with no Alertmanager was not reported"
fi

# The alert has to resolve by itself once the checks pass, so it must end.
world; touch "$WORLD/unhealthy"; run
if posted && python3 - "$WORLD/posted.json" <<'PY'
import json, sys
from datetime import datetime
alert = json.load(open(sys.argv[1]))[0]
assert alert["labels"]["alertname"] == "CineTrackMonitoringDown"
assert alert["labels"]["severity"] == "critical"
starts = datetime.fromisoformat(alert["startsAt"].replace("Z", "+00:00"))
ends = datetime.fromisoformat(alert["endsAt"].replace("Z", "+00:00"))
assert 300 < (ends - starts).total_seconds() <= 3600
PY
then
  pass "the posted alert is critical and ends a little after the next run"
else
  fail "the posted alert is malformed or never ends"
fi

world; echo false > "$WORLD/$PROM.running"; echo "$after_boot" > "$WORLD/$PROM.finished"
echo false > "$WORLD/$AM.running"; echo "$after_boot" > "$WORLD/$AM.finished"; run
if ! posted && (( code == 1 )) && grep -q "nothing can be mailed" "$WORLD/out.log"; then
  pass "with Alertmanager down too, the failure is logged and the exit is non-zero"
else
  fail "with both down: exit $code, $(cat "$WORLD/out.log")"
fi

if (( failures > 0 )); then
  printf '\n%d monitoring watchdog contract(s) broken\n' "$failures"
  exit 1
fi
printf '\nall monitoring watchdog contracts hold\n'
