#!/usr/bin/env bash
# Watch the thing that watches everything else.
#
# Every alert in ops/prometheus/cinetrack-alerts.yml reaches a person only if
# Prometheus is running, has the rules loaded, and can hand them to
# Alertmanager. None of that can alert on itself: a Prometheus that is not
# running evaluates nothing, including a rule about Prometheus not running.
#
# That is not hypothetical. The host rebooted on 2026-10-20 and Docker brought
# every container back except cinetrack-monitoring-prometheus-1, despite its
# `unless-stopped` policy. For four and a half days nothing was evaluated, no
# mail went out, and a release blocked by CI for eight hours was noticed only
# by hand.
#
# So this runs from cron, outside Prometheus, and does two things:
#
#   1. A monitoring container that is down because the host went down — it
#      stopped before the current boot, and its policy says it should have come
#      back — is started. Docker failed to do it; that is all this repeats.
#      One stopped by hand after the boot is left alone.
#   2. If Prometheus is still not running, unhealthy, missing its rules or
#      without an Alertmanager, an alert is posted straight to Alertmanager's
#      API, which mails it like any other. It carries an end time a little
#      past the next run, so it resolves by itself once the checks pass.
#
# If Alertmanager itself is down there is nobody to tell from here; that is
# logged, and step 1 is what brings it back.
set -euo pipefail

PROMETHEUS="${WATCHDOG_PROMETHEUS_CONTAINER:-cinetrack-monitoring-prometheus-1}"
ALERTMANAGER="${WATCHDOG_ALERTMANAGER_CONTAINER:-cinetrack-monitoring-alertmanager-1}"
# Cron runs this every five minutes; the alert outlives one missed run.
ALERT_TTL_SECONDS="${WATCHDOG_ALERT_TTL_SECONDS:-900}"

say() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

running() {
  [[ "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null)" == true ]]
}

boot_epoch() {
  local uptime
  uptime="$(cut -d. -f1 /proc/uptime)"
  echo $(( $(date +%s) - uptime ))
}

# Start a container that went down with the host and was not brought back.
recover() {
  local container="$1" policy finished finished_epoch
  running "$container" && return 0
  if ! policy="$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$container" 2>/dev/null)"; then
    say "$container does not exist; recreate it from docker-compose.monitoring.yml"
    return 1
  fi
  if [[ "$policy" != unless-stopped && "$policy" != always ]]; then
    say "$container is stopped and its restart policy is '$policy'; leaving it"
    return 1
  fi
  finished="$(docker inspect --format '{{.State.FinishedAt}}' "$container")"
  finished_epoch="$(date -d "$finished" +%s 2>/dev/null || echo 0)"
  if (( finished_epoch >= $(boot_epoch) )); then
    say "$container was stopped at $finished, after this boot; assuming that was deliberate"
    return 1
  fi
  if docker start "$container" >/dev/null 2>&1; then
    say "$container had been down since $finished, before this boot; started it"
    started+=("$container")
    return 0
  fi
  say "$container is down since $finished and would not start"
  return 1
}

prometheus_api() {
  docker exec "$PROMETHEUS" wget -qO- "http://127.0.0.1:9090$1" 2>/dev/null
}

started=()
recover "$ALERTMANAGER" || true
recover "$PROMETHEUS" || true
# A container started a moment ago needs time before it answers; that is a
# reason to look again next run, not to page.
if [[ " ${started[*]} " == *" $PROMETHEUS "* ]]; then
  exit 0
fi

problems=()
if ! running "$PROMETHEUS"; then
  problems+=("Prometheus is not running")
else
  if ! prometheus_api /-/healthy >/dev/null; then
    problems+=("Prometheus is running but not healthy")
  else
    groups="$(prometheus_api /api/v1/rules | jq -r '.data.groups | length' 2>/dev/null || echo 0)"
    (( groups > 0 )) || problems+=("Prometheus has no alert rules loaded")
    managers="$(prometheus_api /api/v1/alertmanagers | jq -r '.data.activeAlertmanagers | length' 2>/dev/null || echo 0)"
    (( managers > 0 )) || problems+=("Prometheus has no Alertmanager to send to")
  fi
fi

if (( ${#problems[@]} == 0 )); then
  exit 0
fi

summary="$(printf '%s; ' "${problems[@]}")"
summary="${summary%; }"
say "monitoring is broken: $summary"

if ! running "$ALERTMANAGER"; then
  say "$ALERTMANAGER is not running either; nothing can be mailed from here"
  exit 1
fi

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ends="$(date -u -d "@$(( $(date +%s) + ALERT_TTL_SECONDS ))" +%Y-%m-%dT%H:%M:%SZ)"
payload="$(jq -cn --arg summary "$summary" --arg starts "$now" --arg ends "$ends" '[{
  labels: {alertname: "CineTrackMonitoringDown", severity: "critical"},
  annotations: {
    summary: "Văzute monitoring is not evaluating alerts",
    description: ($summary + ". Every other alert is silent until this is fixed. Raised by scripts/monitoring_watchdog.sh, outside Prometheus.")
  },
  startsAt: $starts,
  endsAt: $ends
}]')"
if docker exec "$ALERTMANAGER" wget -qO- --header 'Content-Type: application/json' \
    --post-data "$payload" http://127.0.0.1:9093/api/v2/alerts >/dev/null 2>&1; then
  say "posted CineTrackMonitoringDown to Alertmanager"
else
  say "could not post CineTrackMonitoringDown to Alertmanager"
fi
exit 1
