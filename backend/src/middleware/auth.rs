use actix_web::{dev::ServiceRequest, web, HttpMessage, HttpRequest};
use uuid::Uuid;

use crate::config::Config;
use crate::errors::AppError;
use crate::services::revocation;
use crate::utils::jwt;

/// Verify a decoded token against the revocation cache.
///
/// A valid signature only proves the token was minted by us; it says nothing
/// about whether the session behind it still exists. Signing out, changing a
/// password, or revoking a session must take effect now rather than whenever
/// the token happens to expire, so every authenticated entry point runs this.
///
/// The lookup is in-process (see `services::revocation`), so this costs no
/// query and nothing on the hot path.
fn reject_revoked(claims: jwt::Claims) -> Result<Uuid, AppError> {
    if revocation::is_revoked(claims.sid, claims.sub, claims.iat) {
        // Deliberately indistinguishable from any other rejected token: a
        // caller holding a revoked credential learns that it no longer works,
        // not why, and not that the account still exists.
        return Err(AppError::Unauthorized("Not authenticated".to_string()));
    }
    Ok(claims.sub)
}

pub fn extract_user_id(req: &HttpRequest) -> Result<Uuid, AppError> {
    req.extensions()
        .get::<Uuid>()
        .copied()
        .ok_or_else(|| AppError::Unauthorized("Not authenticated".to_string()))
}

pub fn extract_optional_user_id(req: &HttpRequest) -> Option<Uuid> {
    req.extensions().get::<Uuid>().copied()
}

pub async fn validate_token_from_request(
    req: &ServiceRequest,
    config: &Config,
) -> Result<Uuid, AppError> {
    let auth_header = req
        .headers()
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("Missing Authorization header".to_string()))?;

    let token = auth_header
        .strip_prefix("Bearer ")
        .ok_or_else(|| AppError::Unauthorized("Invalid Authorization format".to_string()))?;

    let claims = jwt::validate_token(token, &config.jwt_secret)?;
    reject_revoked(claims)
}

/// Middleware extractor: call this at the start of protected route handlers
pub async fn require_auth(req: &HttpRequest) -> Result<Uuid, AppError> {
    let config = req
        .app_data::<web::Data<Config>>()
        .ok_or_else(|| AppError::Unauthorized("Server configuration error".to_string()))?;

    let auth_header = req
        .headers()
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("Missing Authorization header".to_string()))?;

    let token = auth_header
        .strip_prefix("Bearer ")
        .ok_or_else(|| AppError::Unauthorized("Invalid Authorization format".to_string()))?;

    let claims = jwt::validate_token(token, &config.jwt_secret)?;
    reject_revoked(claims)
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::test::TestRequest;

    const SECRET: &str = "test_secret_must_be_64_chars_long_so_we_pad_it_here_abcdefghijklmnopq";

    fn test_config() -> Config {
        Config {
            jwt_secret: SECRET.to_string(),
            ..Config::for_test()
        }
    }

    fn token_for(user_id: Uuid, expiry_minutes: i64) -> String {
        jwt::generate_access_token(user_id, Uuid::new_v4(), SECRET, expiry_minutes).unwrap()
    }

    fn token_for_session(user_id: Uuid, session_id: Uuid) -> String {
        jwt::generate_access_token(user_id, session_id, SECRET, 15).unwrap()
    }

    /// An HttpRequest carrying the config plus an optional Authorization
    /// header, which is all `require_auth` reads.
    fn request_with_auth(header: Option<&str>) -> HttpRequest {
        let mut builder = TestRequest::default().app_data(web::Data::new(test_config()));
        if let Some(value) = header {
            builder = builder.insert_header(("Authorization", value));
        }
        builder.to_http_request()
    }

    // ── require_auth ────────────────────────────────────────────

    #[actix_web::test]
    async fn require_auth_accepts_a_valid_bearer_token() {
        let user_id = Uuid::new_v4();
        let req = request_with_auth(Some(&format!("Bearer {}", token_for(user_id, 15))));
        assert_eq!(require_auth(&req).await.unwrap(), user_id);
    }

    #[actix_web::test]
    async fn require_auth_rejects_a_missing_header() {
        assert!(require_auth(&request_with_auth(None)).await.is_err());
    }

    #[actix_web::test]
    async fn require_auth_rejects_a_non_bearer_scheme() {
        let token = token_for(Uuid::new_v4(), 15);
        for header in [
            format!("Basic {token}"),
            format!("Token {token}"),
            token.clone(),
        ] {
            assert!(
                require_auth(&request_with_auth(Some(&header)))
                    .await
                    .is_err(),
                "expected {header} to be rejected"
            );
        }
    }

    #[actix_web::test]
    async fn require_auth_scheme_match_is_case_sensitive() {
        // `strip_prefix("Bearer ")` is exact, so a lowercase scheme is refused.
        // RFC 7235 treats the scheme as case-insensitive, so this is stricter
        // than the spec. It fails closed, and pinning it means any future
        // relaxation has to be deliberate.
        let header = format!("bearer {}", token_for(Uuid::new_v4(), 15));
        assert!(require_auth(&request_with_auth(Some(&header)))
            .await
            .is_err());
    }

    #[actix_web::test]
    async fn require_auth_rejects_a_bearer_prefix_without_a_token() {
        for header in ["Bearer", "Bearer ", "Bearer  "] {
            assert!(
                require_auth(&request_with_auth(Some(header)))
                    .await
                    .is_err(),
                "expected {header:?} to be rejected"
            );
        }
    }

    #[actix_web::test]
    async fn require_auth_rejects_a_token_signed_with_another_secret() {
        let foreign =
            jwt::generate_access_token(Uuid::new_v4(), Uuid::new_v4(), "a_different_secret", 15)
                .unwrap();
        let req = request_with_auth(Some(&format!("Bearer {foreign}")));
        assert!(require_auth(&req).await.is_err());
    }

    #[actix_web::test]
    async fn require_auth_rejects_an_expired_token() {
        let req = request_with_auth(Some(&format!("Bearer {}", token_for(Uuid::new_v4(), -60))));
        assert!(require_auth(&req).await.is_err());
    }

    #[actix_web::test]
    async fn require_auth_rejects_a_tampered_token() {
        let token = token_for(Uuid::new_v4(), 15);
        // Flip the final signature character; the header and payload still parse.
        let mut tampered = token[..token.len() - 1].to_string();
        tampered.push(if token.ends_with('a') { 'b' } else { 'a' });
        let req = request_with_auth(Some(&format!("Bearer {tampered}")));
        assert!(require_auth(&req).await.is_err());
    }

    #[actix_web::test]
    async fn require_auth_rejects_a_non_ascii_header() {
        // to_str() fails on opaque bytes, which must deny rather than panic.
        let req = TestRequest::default()
            .app_data(web::Data::new(test_config()))
            .insert_header((
                "Authorization",
                actix_web::http::header::HeaderValue::from_bytes(b"Bearer \xff\xfe").unwrap(),
            ))
            .to_http_request();
        assert!(require_auth(&req).await.is_err());
    }

    #[actix_web::test]
    async fn require_auth_fails_closed_without_config() {
        // No Data<Config> registered: the gate must deny rather than admit the
        // request unauthenticated.
        let token = token_for(Uuid::new_v4(), 15);
        let req = TestRequest::default()
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_http_request();
        assert!(require_auth(&req).await.is_err());
    }

    // ── revocation ──────────────────────────────────────────────

    #[actix_web::test]
    async fn require_auth_rejects_a_revoked_session() {
        // The token is signed correctly and nowhere near expiry. The only
        // reason to refuse it is that its session was revoked — which is the
        // entire point: "sign out everywhere" has to mean now, not in fifteen
        // minutes.
        let user_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let token = token_for_session(user_id, session_id);

        let before = request_with_auth(Some(&format!("Bearer {token}")));
        assert_eq!(require_auth(&before).await.unwrap(), user_id);

        revocation::revoke_session_in_memory(session_id);

        let after = request_with_auth(Some(&format!("Bearer {token}")));
        assert!(require_auth(&after).await.is_err());
    }

    #[actix_web::test]
    async fn revoking_one_session_leaves_the_users_other_session_working() {
        // Revoking a single device must not sign the account out everywhere.
        let user_id = Uuid::new_v4();
        let revoked_session = Uuid::new_v4();
        let kept_session = Uuid::new_v4();
        let revoked_token = token_for_session(user_id, revoked_session);
        let kept_token = token_for_session(user_id, kept_session);

        revocation::revoke_session_in_memory(revoked_session);

        let revoked = request_with_auth(Some(&format!("Bearer {revoked_token}")));
        let kept = request_with_auth(Some(&format!("Bearer {kept_token}")));
        assert!(require_auth(&revoked).await.is_err());
        assert_eq!(require_auth(&kept).await.unwrap(), user_id);
    }

    #[actix_web::test]
    async fn validate_token_from_request_also_rejects_a_revoked_session() {
        // Both entry points must apply the check; a gap in either is a bypass.
        let session_id = Uuid::new_v4();
        let token = token_for_session(Uuid::new_v4(), session_id);
        revocation::revoke_session_in_memory(session_id);

        let req = TestRequest::default()
            .insert_header(("Authorization", format!("Bearer {token}")))
            .to_srv_request();
        assert!(validate_token_from_request(&req, &test_config())
            .await
            .is_err());
    }

    // ── validate_token_from_request ─────────────────────────────

    #[actix_web::test]
    async fn validate_token_from_request_accepts_a_valid_token() {
        let user_id = Uuid::new_v4();
        let req = TestRequest::default()
            .insert_header((
                "Authorization",
                format!("Bearer {}", token_for(user_id, 15)),
            ))
            .to_srv_request();
        assert_eq!(
            validate_token_from_request(&req, &test_config())
                .await
                .unwrap(),
            user_id
        );
    }

    #[actix_web::test]
    async fn validate_token_from_request_rejects_expired_and_missing() {
        let config = test_config();

        let expired = TestRequest::default()
            .insert_header((
                "Authorization",
                format!("Bearer {}", token_for(Uuid::new_v4(), -60)),
            ))
            .to_srv_request();
        assert!(validate_token_from_request(&expired, &config)
            .await
            .is_err());

        let missing = TestRequest::default().to_srv_request();
        assert!(validate_token_from_request(&missing, &config)
            .await
            .is_err());
    }

    // ── extract_user_id / extract_optional_user_id ──────────────

    #[actix_web::test]
    async fn extract_user_id_reads_the_request_extension() {
        let user_id = Uuid::new_v4();
        let req = TestRequest::default().to_http_request();
        req.extensions_mut().insert(user_id);

        assert_eq!(extract_user_id(&req).unwrap(), user_id);
        assert_eq!(extract_optional_user_id(&req), Some(user_id));
    }

    #[actix_web::test]
    async fn extract_user_id_without_an_extension_is_unauthenticated() {
        let req = TestRequest::default().to_http_request();

        assert!(extract_user_id(&req).is_err());
        assert_eq!(extract_optional_user_id(&req), None);
    }
}
