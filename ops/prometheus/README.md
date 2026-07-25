# CineTrack Prometheus integration

The backend metrics endpoint is intentionally available only on the loopback
binding at `127.0.0.1:8090/metrics`. Add this scrape job to the host Prometheus:

```yaml
scrape_configs:
  - job_name: cinetrack-backend
    static_configs:
      - targets: ["127.0.0.1:8090"]
```

Load `cinetrack-alerts.yml` through Prometheus `rule_files`. Validate the live
configuration before reloading it:

```bash
promtool check rules /path/to/cineTrack/ops/prometheus/cinetrack-alerts.yml
promtool check config /etc/prometheus/prometheus.yml
```

Backup and release-worker metrics use the node exporter textfile collector.
`backup_to_r2.sh` and `sync_release_schedules.sh` default to the same
`${XDG_STATE_HOME:-$HOME/.local/state}/cinetrack` directory mounted by
`docker-compose.monitoring.yml`. Override `BACKUP_STATE_DIR` and
`RELEASE_SCHEDULE_STATE_DIR` together if the cron user uses a different state
path. Both scripts write their `.prom` files atomically with non-sensitive,
low-cardinality gauges.
