//! Bearer authentication for the Prometheus scrape endpoint.
//!
//! `/metrics` is served by the metrics middleware on the application's own
//! port, and nginx only forwards `/api/`, so for a long time the endpoint's
//! protection was simply that nothing routed to it from outside. That reasoning
//! holds on a dedicated host. This one is shared: the backend port is published
//! on `127.0.0.1:8090` and roughly twenty unrelated containers run beside it,
//! so "not proxied" means "reachable by anything else on the box" — the same
//! shape of assumption that left a credential file world-readable.
//!
//! The exposure is not catastrophic on its own; request counts, latencies and
//! queue depths are operational data, not user data. But it maps the service's
//! internals for free, and the fix is one header.
//!
//! Only `/metrics` is guarded. Everything else passes straight through, so this
//! costs one path comparison per request and nothing else.

use actix_web::{
    body::{EitherBody, MessageBody},
    dev::{ServiceRequest, ServiceResponse},
    http::header,
    middleware::Next,
    web, Error, HttpResponse,
};

use crate::config::Config;

pub const METRICS_PATH: &str = "/metrics";

/// Compare two secrets without leaking their common prefix through timing.
///
/// A scraper's token is a fixed value an attacker can guess byte by byte if the
/// comparison short-circuits. The length is compared first and separately,
/// which does leak the length — that is inherent to any equality check and is
/// not useful against a random token of known size.
fn tokens_match(provided: &str, expected: &str) -> bool {
    if provided.len() != expected.len() {
        return false;
    }
    provided
        .bytes()
        .zip(expected.bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn unauthorized() -> HttpResponse {
    // `Bearer` without a realm: this endpoint has exactly one credential and no
    // interactive login, and a WWW-Authenticate challenge is what a scraper
    // expects to see when its token is wrong.
    HttpResponse::Unauthorized()
        .insert_header((header::WWW_AUTHENTICATE, "Bearer"))
        .finish()
}

pub async fn require_metrics_token(
    req: ServiceRequest,
    next: Next<impl MessageBody>,
) -> Result<ServiceResponse<EitherBody<impl MessageBody>>, Error> {
    if req.path() != METRICS_PATH {
        return next
            .call(req)
            .await
            .map(ServiceResponse::map_into_left_body);
    }

    let expected = req
        .app_data::<web::Data<Config>>()
        .and_then(|config| config.metrics_bearer_token.clone());

    let Some(expected) = expected else {
        // No token configured. Production refuses to start in that state
        // (config.rs), so this is a development or test process, where an
        // unauthenticated scrape endpoint on localhost is the useful default.
        return next
            .call(req)
            .await
            .map(ServiceResponse::map_into_left_body);
    };

    let presented = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));

    match presented {
        Some(token) if tokens_match(token, &expected) => next
            .call(req)
            .await
            .map(ServiceResponse::map_into_left_body),
        _ => Ok(req.into_response(unauthorized()).map_into_right_body()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{middleware::from_fn, test as actix_test, App};

    fn config_with_token(token: Option<&str>) -> Config {
        let mut config = crate::config::Config::for_test();
        config.metrics_bearer_token = token.map(str::to_owned);
        config
    }

    async fn call(
        config: Config,
        path: &str,
        authorization: Option<&str>,
    ) -> actix_web::http::StatusCode {
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(config))
                .wrap(from_fn(require_metrics_token))
                .route(
                    METRICS_PATH,
                    web::get().to(|| async { HttpResponse::Ok().body("# metrics") }),
                )
                .route(
                    "/api/health",
                    web::get().to(|| async { HttpResponse::Ok().finish() }),
                ),
        )
        .await;

        let mut request = actix_test::TestRequest::get().uri(path);
        if let Some(value) = authorization {
            request = request.insert_header((header::AUTHORIZATION, value.to_string()));
        }
        actix_test::call_service(&app, request.to_request())
            .await
            .status()
    }

    #[actix_web::test]
    async fn the_configured_token_is_accepted() {
        let status = call(
            config_with_token(Some("scrape-token")),
            METRICS_PATH,
            Some("Bearer scrape-token"),
        )
        .await;
        assert_eq!(status, 200);
    }

    #[actix_web::test]
    async fn a_missing_or_wrong_token_is_refused() {
        for authorization in [
            None,
            Some("Bearer wrong-token"),
            Some("Bearer scrape-toke"),   // prefix of the real one
            Some("Bearer scrape-tokenn"), // real one plus a byte
            Some("scrape-token"),         // no scheme
            Some("Basic scrape-token"),   // wrong scheme
            Some("bearer scrape-token"),  // lowercase scheme
        ] {
            let status = call(
                config_with_token(Some("scrape-token")),
                METRICS_PATH,
                authorization,
            )
            .await;
            assert_eq!(status, 401, "expected {authorization:?} to be refused");
        }
    }

    #[actix_web::test]
    async fn the_guard_only_covers_the_metrics_path() {
        // A guard that accidentally caught the whole application would take the
        // site down rather than protect it.
        let status = call(config_with_token(Some("scrape-token")), "/api/health", None).await;
        assert_eq!(status, 200);
    }

    #[actix_web::test]
    async fn an_unconfigured_token_leaves_the_endpoint_open() {
        // Development and test only; production cannot reach this state because
        // the configuration refuses to load without a token.
        let status = call(config_with_token(None), METRICS_PATH, None).await;
        assert_eq!(status, 200);
    }

    #[test]
    fn token_comparison_rejects_length_and_content_differences() {
        assert!(tokens_match("abc", "abc"));
        assert!(!tokens_match("abc", "abd"));
        assert!(!tokens_match("ab", "abc"));
        assert!(!tokens_match("abcd", "abc"));
        assert!(!tokens_match("", "abc"));
        assert!(tokens_match("", ""));
    }
}
