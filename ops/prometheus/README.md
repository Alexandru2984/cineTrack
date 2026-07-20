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

Backup metrics use the node exporter textfile collector. Set
`BACKUP_METRICS_FILE` to a path in its configured directory. The script writes
the file atomically, but the cron user needs write permission to that directory.
On this host the collector directory is `/var/lib/prometheus/node-exporter`;
grant access to a dedicated subdirectory or install a root-owned atomic copy
step instead of making the entire collector directory writable.
