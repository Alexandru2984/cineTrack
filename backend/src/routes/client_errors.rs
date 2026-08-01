use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{Duration, Utc};
use serde_json::json;
use sha2::{Digest, Sha256};
use validator::Validate;

use crate::dto::client_error::ClientErrorReport;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::middleware::rate_limit::{RateLimit, RateLimitConfig};

const MAX_REPORT_AGE: Duration = Duration::days(7);
const MAX_FUTURE_SKEW: Duration = Duration::minutes(5);

pub type ClientErrorGovernorConfig = RateLimitConfig;

pub fn build_rate_limiter() -> ClientErrorGovernorConfig {
    RateLimitConfig::new(2, 10).expect("Failed to build client error rate limiter")
}

fn scope() -> actix_web::Scope {
    web::scope("/client-errors").route("", web::post().to(report_client_error))
}

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(scope());
}

pub fn configure_rate_limited(
    cfg: &mut web::ServiceConfig,
    rate_limiter: &ClientErrorGovernorConfig,
) {
    cfg.service(scope().wrap(RateLimit::new(rate_limiter)));
}

fn strip_url_secrets_from_word(value: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    let url_start = ["https://", "http://"]
        .into_iter()
        .filter_map(|scheme| lower.find(scheme))
        .min()?;
    let secret_start = value[url_start..]
        .char_indices()
        .find_map(|(index, character)| matches!(character, '?' | '#').then_some(url_start + index));

    Some(secret_start.map_or_else(|| value.to_string(), |index| value[..index].to_string()))
}

fn sanitized_log_text(value: &str, max_chars: usize) -> String {
    let mut output = Vec::new();
    let mut output_chars = 0;
    let mut redact_credential = false;
    for raw_word in value.split_whitespace() {
        if output_chars >= max_chars {
            break;
        }
        let lower = raw_word.to_ascii_lowercase();
        let word = if redact_credential {
            if lower == "bearer" {
                redact_credential = true;
                raw_word.to_string()
            } else {
                redact_credential = false;
                "[redacted]".to_string()
            }
        } else if lower == "authorization:" {
            redact_credential = true;
            raw_word.to_string()
        } else if lower == "authorization:bearer" {
            redact_credential = true;
            "Authorization: Bearer".to_string()
        } else if lower.starts_with("authorization:") {
            "Authorization: [redacted]".to_string()
        } else if lower == "bearer" {
            redact_credential = true;
            raw_word.to_string()
        } else if lower.starts_with("bearer") {
            "Bearer [redacted]".to_string()
        } else if raw_word.contains('@') && raw_word.contains('.') {
            "[redacted-email]".to_string()
        } else if let Some(sanitized_url) = strip_url_secrets_from_word(raw_word) {
            sanitized_url
        } else {
            let token_candidate = raw_word.trim_matches(|character: char| {
                !character.is_ascii_alphanumeric() && !matches!(character, '_' | '-' | '.')
            });
            let is_token = token_candidate.len() >= 32
                && token_candidate
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'));
            if is_token {
                "[redacted-token]".to_string()
            } else {
                raw_word.to_string()
            }
        };
        output_chars += word.chars().count() + usize::from(!output.is_empty());
        output.push(word);
    }
    output.join(" ").chars().take(max_chars).collect()
}

async fn report_client_error(
    req: HttpRequest,
    body: web::Json<ClientErrorReport>,
) -> Result<HttpResponse, AppError> {
    require_auth(&req).await?;
    body.validate()?;
    let report = body.into_inner();
    let now = Utc::now();
    if report.occurred_at < now - MAX_REPORT_AGE || report.occurred_at > now + MAX_FUTURE_SKEW {
        return Err(AppError::BadRequest(
            "Invalid client error timestamp".to_string(),
        ));
    }

    let message = sanitized_log_text(&report.message, 1000);
    let stack = report
        .stack
        .as_deref()
        .map(|value| sanitized_log_text(value, 16_000));
    let component_stack = report
        .component_stack
        .as_deref()
        .map(|value| sanitized_log_text(value, 8_000));
    let mut hasher = Sha256::new();
    hasher.update(report.error_name.as_bytes());
    hasher.update(b"\n");
    hasher.update(message.as_bytes());
    if let Some(stack) = &stack {
        hasher.update(b"\n");
        hasher.update(stack.lines().next().unwrap_or_default().as_bytes());
    }
    let fingerprint = hex::encode(&hasher.finalize()[..12]);

    crate::metrics::record_client_error(report.platform.as_str(), report.is_fatal);
    log::error!(
        target: "cinetrack::mobile_client",
        "{}",
        json!({
            "event": "mobile_client_error",
            "fingerprint": fingerprint,
            "platform": report.platform.as_str(),
            "app_version": sanitized_log_text(&report.app_version, 32),
            "is_fatal": report.is_fatal,
            "occurred_at": report.occurred_at,
            "error_name": sanitized_log_text(&report.error_name, 120),
            "message": message,
            "stack": stack,
            "component_stack": component_stack,
        })
    );

    Ok(HttpResponse::Accepted().json(json!({ "message": "Report accepted" })))
}

#[cfg(test)]
mod tests {
    use super::{build_rate_limiter, sanitized_log_text};
    use crate::middleware::rate_limit::RateLimit;
    use actix_web::{http::StatusCode, test as actix_test, web, App, HttpResponse};

    #[test]
    fn log_sanitizer_removes_common_credentials_and_contact_data() {
        let value = "Authorization: Bearer secret-token alex@example.com \
                     https://example.com/path?token=secret \
                     abcdefghijklmnopqrstuvwxyz1234567890";
        let sanitized = sanitized_log_text(value, 1000);
        assert_eq!(
            sanitized,
            "Authorization: Bearer [redacted] [redacted-email] \
             https://example.com/path [redacted-token]"
        );
    }

    #[test]
    fn log_sanitizer_handles_compact_credentials_and_url_fragments() {
        let value = "Authorization:Bearer token Bearer=secret https://example.com/#private";
        assert_eq!(
            sanitized_log_text(value, 1000),
            "Authorization: Bearer [redacted] Bearer [redacted] https://example.com/"
        );
    }

    #[test]
    fn log_sanitizer_removes_secrets_from_decorated_stack_urls() {
        let value = "at render (https://example.com/app.js?token=secret:12:4) \
                     source=https://example.com/reset#access_token=private";
        let sanitized = sanitized_log_text(value, 1000);
        assert_eq!(
            sanitized,
            "at render (https://example.com/app.js source=https://example.com/reset"
        );
        assert!(!sanitized.contains("secret"));
        assert!(!sanitized.contains("private"));
    }

    #[actix_web::test]
    async fn rate_limiter_is_shared_between_app_workers() {
        async fn ok() -> HttpResponse {
            HttpResponse::Ok().finish()
        }

        let limiter = build_rate_limiter();
        let app_one = actix_test::init_service(
            App::new()
                .wrap(RateLimit::new(&limiter))
                .route("/", web::post().to(ok)),
        )
        .await;
        let app_two = actix_test::init_service(
            App::new()
                .wrap(RateLimit::new(&limiter))
                .route("/", web::post().to(ok)),
        )
        .await;
        let peer = "198.51.100.11:4321".parse().unwrap();

        for index in 0..10 {
            let request = actix_test::TestRequest::post()
                .uri("/")
                .peer_addr(peer)
                .to_request();
            let response = if index % 2 == 0 {
                actix_test::call_service(&app_one, request).await
            } else {
                actix_test::call_service(&app_two, request).await
            };
            assert_eq!(response.status(), StatusCode::OK);
        }

        let request = actix_test::TestRequest::post()
            .uri("/")
            .peer_addr(peer)
            .to_request();
        let response = actix_test::call_service(&app_two, request).await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    }
}
