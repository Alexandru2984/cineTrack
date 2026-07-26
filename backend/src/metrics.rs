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

#[derive(Clone)]
struct CspReportMetrics {
    reports: IntCounterVec,
}

/// The bounded label set for CSP violation reports. `blocked-uri` and
/// `document-uri` are attacker-influenced and unbounded, so they never become
/// labels — only the violated directive (from a fixed CSP vocabulary) and the
/// disposition do, keeping metric cardinality fixed.
pub(crate) const CSP_REPORT_DIRECTIVES: &[&str] = &[
    "default-src",
    "script-src",
    "script-src-elem",
    "script-src-attr",
    "style-src",
    "style-src-elem",
    "style-src-attr",
    "img-src",
    "connect-src",
    "font-src",
    "media-src",
    "object-src",
    "frame-src",
    "child-src",
    "worker-src",
    "manifest-src",
    "frame-ancestors",
    "base-uri",
    "form-action",
    "other",
];

pub(crate) const CSP_REPORT_DISPOSITIONS: &[&str] = &["enforce", "report"];

/// Map an arbitrary reported directive (e.g. `"script-src 'self'"` or
/// `"script-src-elem"`) to one of the fixed labels above, or `"other"`.
pub(crate) fn normalize_csp_directive(raw: &str) -> &'static str {
    let token = raw.split_whitespace().next().unwrap_or_default();
    CSP_REPORT_DIRECTIVES
        .iter()
        .copied()
        .find(|directive| directive.eq_ignore_ascii_case(token))
        .unwrap_or("other")
}

/// Map the report `disposition` to `"enforce"` (default) or `"report"`.
pub(crate) fn normalize_csp_disposition(raw: Option<&str>) -> &'static str {
    match raw {
        Some(value) if value.eq_ignore_ascii_case("report") => "report",
        _ => "enforce",
    }
}

#[derive(Clone)]
struct ProductMetrics {
    actions: IntCounterVec,
}

#[derive(Clone, Copy)]
pub(crate) enum ProductAction {
    AccountDataExported,
    AnnualRecapViewed,
    AvatarRemoved,
    AvatarUploaded,
    ReleaseAlertsDisabled,
    ReleaseAlertsEnabled,
    TvTimeImportStarted,
    WatchProvidersViewed,
}

const PRODUCT_ACTIONS: [ProductAction; 8] = [
    ProductAction::AccountDataExported,
    ProductAction::AnnualRecapViewed,
    ProductAction::AvatarRemoved,
    ProductAction::AvatarUploaded,
    ProductAction::ReleaseAlertsDisabled,
    ProductAction::ReleaseAlertsEnabled,
    ProductAction::TvTimeImportStarted,
    ProductAction::WatchProvidersViewed,
];

impl ProductAction {
    const fn as_str(self) -> &'static str {
        match self {
            Self::AccountDataExported => "account_data_exported",
            Self::AnnualRecapViewed => "annual_recap_viewed",
            Self::AvatarRemoved => "avatar_removed",
            Self::AvatarUploaded => "avatar_uploaded",
            Self::ReleaseAlertsDisabled => "release_alerts_disabled",
            Self::ReleaseAlertsEnabled => "release_alerts_enabled",
            Self::TvTimeImportStarted => "tv_time_import_started",
            Self::WatchProvidersViewed => "watch_providers_viewed",
        }
    }
}

impl ProductMetrics {
    fn new() -> Self {
        let actions = IntCounterVec::new(
            Opts::new(
                "product_actions_total",
                "Successful product actions without user or device identifiers",
            )
            .namespace("cinetrack"),
            &["action"],
        )
        .expect("Product action metric must be valid");
        for action in PRODUCT_ACTIONS {
            actions.with_label_values(&[action.as_str()]);
        }
        Self { actions }
    }
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

impl CspReportMetrics {
    fn new() -> Self {
        let reports = IntCounterVec::new(
            Opts::new(
                "csp_reports_total",
                "Content-Security-Policy violation reports by violated directive and disposition",
            )
            .namespace("cinetrack"),
            &["directive", "disposition"],
        )
        .expect("CSP report metric must be valid");
        for directive in CSP_REPORT_DIRECTIVES {
            for disposition in CSP_REPORT_DISPOSITIONS {
                reports.with_label_values(&[directive, disposition]);
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
        for kind in ["password_reset", "email_verification"] {
            for outcome in [
                "smtp_accepted",
                "smtp_error",
                "not_configured",
                "invalid_message",
            ] {
                metrics.sends.with_label_values(&[kind, outcome]);
            }
            metrics.send_duration.with_label_values(&[kind]);
        }
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
static CSP_REPORT_METRICS: LazyLock<CspReportMetrics> = LazyLock::new(CspReportMetrics::new);
static PRODUCT_METRICS: LazyLock<ProductMetrics> = LazyLock::new(ProductMetrics::new);

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

pub fn record_csp_report(directive: &'static str, disposition: &'static str) {
    CSP_REPORT_METRICS
        .reports
        .with_label_values(&[directive, disposition])
        .inc();
}

pub(crate) fn record_product_action(action: ProductAction) {
    PRODUCT_METRICS
        .actions
        .with_label_values(&[action.as_str()])
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
        .registry
        .register(Box::new(CSP_REPORT_METRICS.reports.clone()))
        .expect("Failed to register CSP report metric");
    prometheus
        .registry
        .register(Box::new(PRODUCT_METRICS.actions.clone()))
        .expect("Failed to register product action metric");
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
        record_csp_report("script-src", "enforce");
        record_product_action(ProductAction::AnnualRecapViewed);
        let prometheus = build();
        let names = prometheus
            .registry
            .gather()
            .into_iter()
            .map(|family| family.name().to_string())
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
        assert!(names.iter().any(|name| name == "cinetrack_csp_reports_total"));
        assert!(names
            .iter()
            .any(|name| name == "cinetrack_product_actions_total"));
    }

    #[test]
    fn csp_directive_normalization_is_bounded() {
        assert_eq!(normalize_csp_directive("script-src 'self'"), "script-src");
        assert_eq!(normalize_csp_directive("IMG-SRC"), "img-src");
        assert_eq!(normalize_csp_directive("some-future-directive"), "other");
        assert_eq!(normalize_csp_directive(""), "other");
        assert_eq!(normalize_csp_disposition(Some("report")), "report");
        assert_eq!(normalize_csp_disposition(Some("enforce")), "enforce");
        assert_eq!(normalize_csp_disposition(None), "enforce");
    }

    #[test]
    fn email_metrics_exist_before_the_first_send() {
        let prometheus = build();
        let encoded = prometheus
            .registry
            .gather()
            .into_iter()
            .map(|family| family.name().to_string())
            .collect::<Vec<_>>();

        assert!(encoded
            .iter()
            .any(|name| name == "cinetrack_email_send_total"));
        assert!(encoded
            .iter()
            .any(|name| name == "cinetrack_email_send_duration_seconds"));
    }

    #[test]
    fn product_metrics_have_only_fixed_action_labels() {
        let prometheus = build();
        let family = prometheus
            .registry
            .gather()
            .into_iter()
            .find(|family| family.name() == "cinetrack_product_actions_total")
            .expect("product action metric is registered");
        let mut actions = family
            .get_metric()
            .iter()
            .flat_map(|metric| metric.get_label())
            .filter(|label| label.name() == "action")
            .map(|label| label.value().to_string())
            .collect::<Vec<_>>();
        actions.sort();

        let mut expected = PRODUCT_ACTIONS
            .into_iter()
            .map(|action| action.as_str().to_string())
            .collect::<Vec<_>>();
        expected.sort();
        assert_eq!(actions, expected);
    }
}
