# CineTrack Prometheus integration

The backend metrics endpoint is intentionally available only on the loopback
binding at `127.0.0.1:8090/metrics`. Add this scrape job to the host Prometheus:

```yaml
scrape_configs:
  - job_name: cinetrack-backend
    static_configs:
      - targets: ["127.0.0.1:8090"]
```

In production, nobody reloads the rules by hand. `docker-compose.monitoring.yml`
mounts the directory named by `CINETRACK_PROMETHEUS_CONFIG_DIR` (set in
`.env.prod` to `~/.local/state/cinetrack/monitoring/prometheus`).
`scripts/auto_deploy.sh` keeps that directory on the revision that is running
in production. On every run, and again right after a deploy, it takes
`prometheus.yml` and `cinetrack-alerts.yml` from that revision, validates the
rules with Prometheus's own promtool, swaps them in, and sends Prometheus a
SIGHUP. It then reads back `prometheus_config_last_reload_successful`, and
publishes the outcome as `cinetrack_monitoring_sync_success` and
`cinetrack_monitoring_sync_timestamp_seconds`.

Do not go back to mounting these files one at a time. A file bind mount keeps
the inode it started with, and `git pull` replaces files rather than editing
them. The container then keeps reading the old copy: that is how eight alerts
merged in August never reached the running Prometheus.

The rules carry unit tests in `cinetrack-alerts.test.yml`, and CI runs both:

```bash
promtool check rules ops/prometheus/cinetrack-alerts.yml
(cd ops/prometheus && promtool test rules cinetrack-alerts.test.yml)
```

Backup and release-worker metrics use the node exporter textfile collector.
`backup_to_r2.sh` and `sync_release_schedules.sh` default to the same
`${XDG_STATE_HOME:-$HOME/.local/state}/cinetrack` directory mounted by
`docker-compose.monitoring.yml`. Override `BACKUP_STATE_DIR` and
`RELEASE_SCHEDULE_STATE_DIR` together if the cron user uses a different state
path. Both scripts write their `.prom` files atomically with non-sensitive,
low-cardinality gauges.

`cinetrack_product_actions_total` is deliberately limited to eight
source-controlled action labels. It has no account, device, IP, media, search,
per-action timestamp, or arbitrary event labels. Prometheus samples the
aggregate counter over time and retains those samples for 30 days; do not add
identifying or free-form labels, and treat a request to do so as a
privacy-review change rather than a dashboard edit.

`cinetrack_security_events_total` follows the same rule: its event label comes
from a source-controlled enum, never request data. Security alerts identify a
time window; the protected backend audit log provides account-level context
only during incident triage.

Alertmanager's rendered YAML deliberately contains no SMTP password. Run
`scripts/render_alertmanager_config.sh` after changing mail settings; it writes
the non-secret YAML and a separate mode-640 password file. Both outputs are
git-ignored and mounted read-only by `docker-compose.monitoring.yml`.
