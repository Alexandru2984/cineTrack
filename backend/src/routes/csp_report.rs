//! Content-Security-Policy violation report sink.
//!
//! The browser POSTs here (via the policy's `report-uri` / `report-to`
//! directives) whenever a resource is blocked. It is intentionally
//! **unauthenticated** — the browser sends these reports with no credentials
//! and no way to attach a bearer token — so the endpoint is defended by an IP
//! rate limiter, a hard body-size cap, and by never reflecting anything back.
//! Reports are structured-logged (with URIs stripped of query/fragment so a
//! token that leaked into a URL is not re-logged here) and counted by a
//! fixed-cardinality metric. The response is always 204 with no body.

use actix_governor::governor::middleware::NoOpMiddleware;
use actix_governor::{Governor, GovernorConfig, GovernorConfigBuilder};
use actix_web::{web, HttpResponse};
use serde::Deserialize;
use serde_json::json;

use crate::middleware::rate_limit::TrustedProxyIpKeyExtractor;

/// Cap the accepted body well below the global JSON limit: a CSP report is a
/// few hundred bytes, and `script-sample` is truncated by the browser to 40
/// characters, so anything larger is not a real report.
const MAX_BODY_BYTES: usize = 8 * 1024;
const MAX_URI_LEN: usize = 512;
const MAX_SAMPLE_LEN: usize = 256;
const MAX_DIRECTIVE_LEN: usize = 128;

pub type CspReportGovernorConfig = GovernorConfig<TrustedProxyIpKeyExtractor, NoOpMiddleware>;

pub fn build_rate_limiter() -> CspReportGovernorConfig {
    GovernorConfigBuilder::default()
        // A single navigation can trip several directives at once, so the burst
        // is generous while the sustained rate stays low.
        .requests_per_second(2)
        .burst_size(20)
        .key_extractor(TrustedProxyIpKeyExtractor)
        .finish()
        .expect("Failed to build CSP report rate limiter")
}

fn scope() -> actix_web::Scope {
    web::scope("/csp-report").route("", web::post().to(receive_csp_report))
}

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(scope());
}

pub fn configure_rate_limited(
    cfg: &mut web::ServiceConfig,
    rate_limiter: &CspReportGovernorConfig,
) {
    cfg.service(scope().wrap(Governor::new(rate_limiter)));
}

/// Legacy `report-uri` payload: `{ "csp-report": { ... } }` with hyphenated keys.
#[derive(Debug, Deserialize)]
struct ReportUriEnvelope {
    #[serde(rename = "csp-report")]
    csp_report: Option<ReportUriBody>,
}

#[derive(Debug, Default, Deserialize)]
struct ReportUriBody {
    #[serde(rename = "document-uri")]
    document_uri: Option<String>,
    #[serde(rename = "violated-directive")]
    violated_directive: Option<String>,
    #[serde(rename = "effective-directive")]
    effective_directive: Option<String>,
    #[serde(rename = "blocked-uri")]
    blocked_uri: Option<String>,
    #[serde(rename = "source-file")]
    source_file: Option<String>,
    #[serde(rename = "line-number")]
    line_number: Option<i64>,
    #[serde(rename = "script-sample")]
    script_sample: Option<String>,
    disposition: Option<String>,
}

/// Modern Reporting-API payload: a JSON array of `{ "type", "body": { ... } }`
/// with camelCase keys.
#[derive(Debug, Deserialize)]
struct ReportToEntry {
    #[serde(rename = "type")]
    report_type: Option<String>,
    body: Option<ReportToBody>,
}

#[derive(Debug, Default, Deserialize)]
struct ReportToBody {
    #[serde(rename = "documentURL")]
    document_url: Option<String>,
    #[serde(rename = "effectiveDirective")]
    effective_directive: Option<String>,
    #[serde(rename = "violatedDirective")]
    violated_directive: Option<String>,
    #[serde(rename = "blockedURL")]
    blocked_url: Option<String>,
    #[serde(rename = "sourceFile")]
    source_file: Option<String>,
    #[serde(rename = "lineNumber")]
    line_number: Option<i64>,
    sample: Option<String>,
    disposition: Option<String>,
}

/// The unified shape both wire formats collapse to before logging.
#[derive(Debug, Default)]
struct Violation {
    document: Option<String>,
    directive: String,
    blocked: Option<String>,
    source_file: Option<String>,
    line_number: Option<i64>,
    sample: Option<String>,
    disposition: Option<String>,
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// Drop the query and fragment from a URI so a credential that ended up in one
/// (`?token=...`, `#access_token=...`) is not persisted into these logs, then
/// truncate. Mirrors the URL handling in the client-error sink.
fn strip_uri_secrets(value: &str) -> String {
    let cut = value
        .char_indices()
        .find_map(|(index, character)| matches!(character, '?' | '#').then_some(index));
    let base = cut.map_or(value, |index| &value[..index]);
    truncate(base, MAX_URI_LEN)
}

impl From<ReportUriBody> for Violation {
    fn from(body: ReportUriBody) -> Self {
        let directive = body
            .effective_directive
            .or(body.violated_directive)
            .unwrap_or_default();
        Violation {
            document: body.document_uri,
            directive,
            blocked: body.blocked_uri,
            source_file: body.source_file,
            line_number: body.line_number,
            sample: body.script_sample,
            disposition: body.disposition,
        }
    }
}

impl From<ReportToBody> for Violation {
    fn from(body: ReportToBody) -> Self {
        let directive = body
            .effective_directive
            .or(body.violated_directive)
            .unwrap_or_default();
        Violation {
            document: body.document_url,
            directive,
            blocked: body.blocked_url,
            source_file: body.source_file,
            line_number: body.line_number,
            sample: body.sample,
            disposition: body.disposition,
        }
    }
}

/// Parse whichever of the two wire formats the payload is. Unknown/garbage
/// bodies yield an empty list rather than an error — the sink swallows them.
///
/// Dispatch is on the first non-whitespace byte (`[` = Reporting-API array,
/// `{` = legacy envelope) rather than by attempting each type in turn: serde
/// happily deserializes a struct from a JSON array *positionally*, so trying
/// the envelope first would consume an array's first element instead of failing.
fn parse_violations(raw: &[u8]) -> Vec<Violation> {
    match raw.iter().copied().find(|byte| !byte.is_ascii_whitespace()) {
        Some(b'[') => serde_json::from_slice::<Vec<ReportToEntry>>(raw)
            .map(|entries| {
                entries
                    .into_iter()
                    .filter(|entry| {
                        entry
                            .report_type
                            .as_deref()
                            .is_none_or(|kind| kind.eq_ignore_ascii_case("csp-violation"))
                    })
                    .filter_map(|entry| entry.body)
                    .map(Violation::from)
                    .collect()
            })
            .unwrap_or_default(),
        Some(b'{') => serde_json::from_slice::<ReportUriEnvelope>(raw)
            .ok()
            .and_then(|envelope| envelope.csp_report)
            .map(|body| vec![body.into()])
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

async fn receive_csp_report(body: web::Bytes) -> HttpResponse {
    if body.len() > MAX_BODY_BYTES {
        return HttpResponse::BadRequest().finish();
    }

    for violation in parse_violations(&body) {
        if violation.directive.is_empty() {
            continue;
        }
        let directive = crate::metrics::normalize_csp_directive(&violation.directive);
        let disposition =
            crate::metrics::normalize_csp_disposition(violation.disposition.as_deref());
        crate::metrics::record_csp_report(directive, disposition);
        log::warn!(
            target: "cinetrack::csp",
            "{}",
            json!({
                "event": "csp_violation",
                "directive": directive,
                "raw_directive": truncate(&violation.directive, MAX_DIRECTIVE_LEN),
                "disposition": disposition,
                "document": violation.document.as_deref().map(strip_uri_secrets),
                "blocked": violation.blocked.as_deref().map(strip_uri_secrets),
                "source_file": violation.source_file.as_deref().map(strip_uri_secrets),
                "line_number": violation.line_number,
                "sample": violation.sample.as_deref().map(|value| truncate(value, MAX_SAMPLE_LEN)),
            })
        );
    }

    HttpResponse::NoContent().finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{http::StatusCode, test as actix_test, App};

    #[test]
    fn strip_uri_secrets_drops_query_and_fragment() {
        assert_eq!(
            strip_uri_secrets("https://vazute.micutu.com/reset?token=secret"),
            "https://vazute.micutu.com/reset"
        );
        assert_eq!(
            strip_uri_secrets("https://vazute.micutu.com/#access_token=secret"),
            "https://vazute.micutu.com/"
        );
    }

    #[test]
    fn parses_legacy_report_uri_payload() {
        let raw = br#"{"csp-report":{"document-uri":"https://vazute.micutu.com/","violated-directive":"script-src 'self'","effective-directive":"script-src","blocked-uri":"https://evil.example/x.js","disposition":"enforce"}}"#;
        let violations = parse_violations(raw);
        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].directive, "script-src");
        assert_eq!(
            violations[0].blocked.as_deref(),
            Some("https://evil.example/x.js")
        );
    }

    #[test]
    fn parses_modern_reporting_api_payload() {
        let raw = br#"[{"type":"csp-violation","body":{"documentURL":"https://vazute.micutu.com/","effectiveDirective":"img-src","blockedURL":"https://evil.example/p.png","disposition":"report"}}]"#;
        let violations = parse_violations(raw);
        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].directive, "img-src");
        assert_eq!(violations[0].disposition.as_deref(), Some("report"));
    }

    #[test]
    fn ignores_non_csp_reporting_api_entries() {
        let raw = br#"[{"type":"deprecation","body":{"id":"x"}}]"#;
        assert!(parse_violations(raw).is_empty());
    }

    #[test]
    fn garbage_body_yields_no_violations() {
        assert!(parse_violations(b"not json").is_empty());
        assert!(parse_violations(b"{}").is_empty());
    }

    #[actix_web::test]
    async fn accepts_a_report_with_204() {
        let app = actix_test::init_service(App::new().configure(configure)).await;
        let request = actix_test::TestRequest::post()
            .uri("/csp-report")
            .insert_header(("content-type", "application/csp-report"))
            .set_payload(
                &br#"{"csp-report":{"effective-directive":"script-src","blocked-uri":"inline"}}"#[..],
            )
            .to_request();
        let response = actix_test::call_service(&app, request).await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }

    #[actix_web::test]
    async fn rejects_an_oversized_body() {
        let app = actix_test::init_service(App::new().configure(configure)).await;
        let oversized = vec![b'a'; MAX_BODY_BYTES + 1];
        let request = actix_test::TestRequest::post()
            .uri("/csp-report")
            .set_payload(oversized)
            .to_request();
        let response = actix_test::call_service(&app, request).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[actix_web::test]
    async fn rate_limiter_is_shared_between_app_workers() {
        let limiter = build_rate_limiter();
        let app = actix_test::init_service(
            App::new().configure(|cfg| configure_rate_limited(cfg, &limiter)),
        )
        .await;
        let peer = "198.51.100.23:4321".parse().unwrap();

        for _ in 0..20 {
            let request = actix_test::TestRequest::post()
                .uri("/csp-report")
                .peer_addr(peer)
                .set_payload(&br#"{"csp-report":{"effective-directive":"img-src"}}"#[..])
                .to_request();
            let response = actix_test::call_service(&app, request).await;
            assert_eq!(response.status(), StatusCode::NO_CONTENT);
        }

        let request = actix_test::TestRequest::post()
            .uri("/csp-report")
            .peer_addr(peer)
            .set_payload(&br#"{"csp-report":{"effective-directive":"img-src"}}"#[..])
            .to_request();
        let response = actix_test::call_service(&app, request).await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    }
}
