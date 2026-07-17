use actix_web_prom::{PrometheusMetrics, PrometheusMetricsBuilder};
use prometheus::{HistogramOpts, HistogramVec, IntCounterVec, Opts};
use std::sync::LazyLock;
use std::time::Duration;

#[derive(Clone)]
struct TmdbMetrics {
    requests: IntCounterVec,
    request_duration: HistogramVec,
    cache_events: IntCounterVec,
}

#[derive(Clone)]
struct EmailMetrics {
    sends: IntCounterVec,
    send_duration: HistogramVec,
}

#[derive(Clone)]
struct ClientErrorMetrics {
    reports: IntCounterVec,
}

impl ClientErrorMetrics {
    fn new() -> Self {
        let reports = IntCounterVec::new(
            Opts::new(
                "client_error_reports_total",
                "Accepted mobile client error reports",
            )
            .namespace("cinetrack"),
            &["platform", "fatal"],
        )
        .expect("Client error report metric must be valid");
        for platform in ["android", "ios"] {
            for fatal in ["true", "false"] {
                reports.with_label_values(&[platform, fatal]);
            }
        }
        Self { reports }
    }
}

impl EmailMetrics {
    fn new() -> Self {
        let sends = IntCounterVec::new(
            Opts::new("email_send_total", "Transactional email send outcomes")
                .namespace("cinetrack"),
            &["kind", "outcome"],
        )
        .expect("Email send metric must be valid");
        let send_duration = HistogramVec::new(
            HistogramOpts::new(
                "email_send_duration_seconds",
                "SMTP transaction duration for transactional email",
            )
            .namespace("cinetrack")
            .buckets(vec![0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 15.0, 30.0, 60.0]),
            &["kind"],
        )
        .expect("Email duration metric must be valid");

        let metrics = Self {
            sends,
            send_duration,
        };
        for outcome in [
            "smtp_accepted",
            "smtp_error",
            "not_configured",
            "invalid_message",
        ] {
            metrics
                .sends
                .with_label_values(&["password_reset", outcome]);
        }
        metrics.send_duration.with_label_values(&["password_reset"]);
        metrics
    }
}

impl TmdbMetrics {
    fn new() -> Self {
        let requests = IntCounterVec::new(
            Opts::new(
                "tmdb_requests_total",
                "TMDB upstream requests by endpoint and outcome",
            )
            .namespace("cinetrack"),
            &["endpoint", "outcome"],
        )
        .expect("TMDB request metric must be valid");
        let request_duration = HistogramVec::new(
            HistogramOpts::new(
                "tmdb_request_duration_seconds",
                "TMDB upstream request duration by endpoint",
            )
            .namespace("cinetrack")
            .buckets(vec![0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0]),
            &["endpoint"],
        )
        .expect("TMDB request duration metric must be valid");
        let cache_events = IntCounterVec::new(
            Opts::new(
                "tmdb_cache_events_total",
                "TMDB cache outcomes by cache kind and result",
            )
            .namespace("cinetrack"),
            &["cache", "result"],
        )
        .expect("TMDB cache metric must be valid");

        Self {
            requests,
            request_duration,
            cache_events,
        }
    }
}

static TMDB_METRICS: LazyLock<TmdbMetrics> = LazyLock::new(TmdbMetrics::new);
static EMAIL_METRICS: LazyLock<EmailMetrics> = LazyLock::new(EmailMetrics::new);
static CLIENT_ERROR_METRICS: LazyLock<ClientErrorMetrics> = LazyLock::new(ClientErrorMetrics::new);

pub fn record_tmdb_request(endpoint: &'static str, outcome: &'static str, duration: Duration) {
    TMDB_METRICS
        .requests
        .with_label_values(&[endpoint, outcome])
        .inc();
    TMDB_METRICS
        .request_duration
        .with_label_values(&[endpoint])
        .observe(duration.as_secs_f64());
}

pub fn record_tmdb_cache(cache: &'static str, result: &'static str) {
    TMDB_METRICS
        .cache_events
        .with_label_values(&[cache, result])
        .inc();
}

pub fn record_email_send(kind: &'static str, outcome: &'static str) {
    EMAIL_METRICS
        .sends
        .with_label_values(&[kind, outcome])
        .inc();
}

pub fn record_email_send_duration(kind: &'static str, duration: Duration) {
    EMAIL_METRICS
        .send_duration
        .with_label_values(&[kind])
        .observe(duration.as_secs_f64());
}

pub fn record_client_error(platform: &'static str, fatal: bool) {
    CLIENT_ERROR_METRICS
        .reports
        .with_label_values(&[platform, if fatal { "true" } else { "false" }])
        .inc();
}

/// Build the Prometheus metrics middleware. It records per-request count and
/// latency and serves them at `/metrics`. That endpoint lives on the app's own
/// port and is not proxied by nginx (which only forwards `/api/`), so it stays
/// reachable only from inside the deployment network for a scraper to pull.
pub fn build() -> PrometheusMetrics {
    let prometheus = PrometheusMetricsBuilder::new("cinetrack")
        .endpoint("/metrics")
        .mask_unmatched_patterns("UNMATCHED")
        .build()
        .expect("Failed to build Prometheus metrics middleware");
    prometheus
        .registry
        .register(Box::new(TMDB_METRICS.requests.clone()))
        .expect("Failed to register TMDB request metric");
    prometheus
        .registry
        .register(Box::new(TMDB_METRICS.request_duration.clone()))
        .expect("Failed to register TMDB duration metric");
    prometheus
        .registry
        .register(Box::new(TMDB_METRICS.cache_events.clone()))
        .expect("Failed to register TMDB cache metric");
    prometheus
        .registry
        .register(Box::new(EMAIL_METRICS.sends.clone()))
        .expect("Failed to register email send metric");
    prometheus
        .registry
        .register(Box::new(EMAIL_METRICS.send_duration.clone()))
        .expect("Failed to register email duration metric");
    prometheus
        .registry
        .register(Box::new(CLIENT_ERROR_METRICS.reports.clone()))
        .expect("Failed to register client error report metric");
    prometheus
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_tmdb_metrics_are_registered() {
        record_tmdb_request("search", "2xx", Duration::from_millis(20));
        record_tmdb_cache("search", "hit");
        record_email_send("password_reset", "smtp_accepted");
        record_email_send_duration("password_reset", Duration::from_millis(20));
        record_client_error("android", false);
        let prometheus = build();
        let names = prometheus
            .registry
            .gather()
            .into_iter()
            .map(|family| family.get_name().to_string())
            .collect::<Vec<_>>();

        assert!(names
            .iter()
            .any(|name| name == "cinetrack_tmdb_requests_total"));
        assert!(names
            .iter()
            .any(|name| name == "cinetrack_tmdb_request_duration_seconds"));
        assert!(names
            .iter()
            .any(|name| name == "cinetrack_tmdb_cache_events_total"));
        assert!(names
            .iter()
            .any(|name| name == "cinetrack_email_send_total"));
        assert!(names
            .iter()
            .any(|name| name == "cinetrack_email_send_duration_seconds"));
        assert!(names
            .iter()
            .any(|name| name == "cinetrack_client_error_reports_total"));
    }

    #[test]
    fn email_metrics_exist_before_the_first_send() {
        let prometheus = build();
        let encoded = prometheus
            .registry
            .gather()
            .into_iter()
            .map(|family| family.get_name().to_string())
            .collect::<Vec<_>>();

        assert!(encoded
            .iter()
            .any(|name| name == "cinetrack_email_send_total"));
        assert!(encoded
            .iter()
            .any(|name| name == "cinetrack_email_send_duration_seconds"));
    }
}
