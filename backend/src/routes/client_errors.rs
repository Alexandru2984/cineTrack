use actix_governor::governor::middleware::NoOpMiddleware;
use actix_governor::{Governor, GovernorConfig, GovernorConfigBuilder};
use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{Duration, Utc};
use serde_json::json;
use sha2::{Digest, Sha256};
use validator::Validate;

use crate::dto::client_error::ClientErrorReport;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::middleware::rate_limit::TrustedProxyIpKeyExtractor;

const MAX_REPORT_AGE: Duration = Duration::days(7);
const MAX_FUTURE_SKEW: Duration = Duration::minutes(5);

pub type ClientErrorGovernorConfig = GovernorConfig<TrustedProxyIpKeyExtractor, NoOpMiddleware>;

pub fn build_rate_limiter() -> ClientErrorGovernorConfig {
    GovernorConfigBuilder::default()
        .requests_per_second(2)
        .burst_size(10)
        .key_extractor(TrustedProxyIpKeyExtractor)
        .finish()
        .expect("Failed to build client error rate limiter")
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
    cfg.service(scope().wrap(Governor::new(rate_limiter)));
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
        } else if lower.starts_with("http://") || lower.starts_with("https://") {
            let secret_start = raw_word
                .char_indices()
                .find_map(|(index, character)| matches!(character, '?' | '#').then_some(index));
            secret_start
                .map_or(raw_word, |index| &raw_word[..index])
                .to_string()
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
    use actix_governor::Governor;
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

    #[actix_web::test]
    async fn rate_limiter_is_shared_between_app_workers() {
        async fn ok() -> HttpResponse {
            HttpResponse::Ok().finish()
        }

        let limiter = build_rate_limiter();
        let app_one = actix_test::init_service(
            App::new()
                .wrap(Governor::new(&limiter))
                .route("/", web::post().to(ok)),
        )
        .await;
        let app_two = actix_test::init_service(
            App::new()
                .wrap(Governor::new(&limiter))
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
