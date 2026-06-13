use actix_web_prom::{PrometheusMetrics, PrometheusMetricsBuilder};

/// Build the Prometheus metrics middleware. It records per-request count and
/// latency and serves them at `/metrics`. That endpoint lives on the app's own
/// port and is not proxied by nginx (which only forwards `/api/`), so it stays
/// reachable only from inside the deployment network for a scraper to pull.
pub fn build() -> PrometheusMetrics {
    PrometheusMetricsBuilder::new("cinetrack")
        .endpoint("/metrics")
        .build()
        .expect("Failed to build Prometheus metrics middleware")
}
