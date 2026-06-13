use actix_governor::{Governor, GovernorConfigBuilder};
use actix_web::{
    cookie::{time::Duration as CookieDuration, Cookie, SameSite},
    web, HttpRequest, HttpResponse,
};
use sqlx::PgPool;
use validator::Validate;

use crate::config::Config;
use crate::dto::auth::*;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::middleware::rate_limit::TrustedProxyIpKeyExtractor;
use crate::services;

const REFRESH_COOKIE_NAME: &str = "cinetrack_refresh";
const REFRESH_COOKIE_PATH: &str = "/api/auth";

pub fn configure(cfg: &mut web::ServiceConfig) {
    let auth_governor = GovernorConfigBuilder::default()
        .requests_per_second(3)
        .burst_size(10)
        .key_extractor(TrustedProxyIpKeyExtractor)
        .finish()
        .expect("Failed to build auth rate limiter");

    cfg.service(
        web::scope("/auth")
            .wrap(Governor::new(&auth_governor))
            .route("/register", web::post().to(register))
            .route("/login", web::post().to(login))
            .route("/logout", web::post().to(logout))
            .route("/refresh", web::post().to(refresh))
            .route("/password", web::patch().to(change_password))
            .route("/me", web::get().to(me)),
    );
}

async fn register(
    pool: web::Data<PgPool>,
    config: web::Data<Config>,
    body: web::Json<RegisterRequest>,
) -> Result<HttpResponse, AppError> {
    body.validate()?;
    let (resp, refresh_token) =
        services::auth::register(pool.get_ref(), config.get_ref(), body.into_inner()).await?;
    Ok(HttpResponse::Created()
        .cookie(refresh_cookie(&refresh_token, config.get_ref()))
        .json(resp))
}

async fn login(
    pool: web::Data<PgPool>,
    config: web::Data<Config>,
    body: web::Json<LoginRequest>,
) -> Result<HttpResponse, AppError> {
    body.validate()?;
    let (resp, refresh_token) =
        services::auth::login(pool.get_ref(), config.get_ref(), body.into_inner()).await?;
    Ok(HttpResponse::Ok()
        .cookie(refresh_cookie(&refresh_token, config.get_ref()))
        .json(resp))
}

async fn logout(
    pool: web::Data<PgPool>,
    config: web::Data<Config>,
    req: HttpRequest,
    body: Option<web::Json<LogoutRequest>>,
) -> Result<HttpResponse, AppError> {
    if let Some(refresh_token) = refresh_token_from_request(&req, body.as_deref()) {
        services::auth::logout(pool.get_ref(), &refresh_token).await?;
    }

    Ok(HttpResponse::Ok()
        .cookie(clear_refresh_cookie(config.get_ref()))
        .json(serde_json::json!({"message": "Logged out successfully"})))
}

async fn refresh(
    pool: web::Data<PgPool>,
    config: web::Data<Config>,
    req: HttpRequest,
    body: Option<web::Json<RefreshRequest>>,
) -> Result<HttpResponse, AppError> {
    let refresh_token = refresh_token_from_request(&req, body.as_deref())
        .ok_or_else(|| AppError::Unauthorized("Missing refresh token".to_string()))?;
    let (resp, new_refresh_token) =
        services::auth::refresh_token(pool.get_ref(), config.get_ref(), &refresh_token).await?;
    Ok(HttpResponse::Ok()
        .cookie(refresh_cookie(&new_refresh_token, config.get_ref()))
        .json(resp))
}

async fn me(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let user = services::auth::get_current_user(pool.get_ref(), user_id).await?;
    Ok(HttpResponse::Ok().json(user))
}

async fn change_password(
    pool: web::Data<PgPool>,
    config: web::Data<Config>,
    req: HttpRequest,
    body: web::Json<ChangePasswordRequest>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    body.validate()?;
    let data = body.into_inner();
    services::auth::change_password(
        pool.get_ref(),
        user_id,
        &data.current_password,
        &data.new_password,
    )
    .await?;

    // All refresh tokens were revoked; drop the current session's cookie too.
    Ok(HttpResponse::Ok()
        .cookie(clear_refresh_cookie(config.get_ref()))
        .json(serde_json::json!({"message": "Password changed successfully"})))
}

fn refresh_token_from_request<T>(req: &HttpRequest, body: Option<&T>) -> Option<String>
where
    T: RefreshTokenPayload,
{
    req.cookie(REFRESH_COOKIE_NAME)
        .map(|cookie| cookie.value().to_owned())
        .filter(|token| !token.is_empty())
        .or_else(|| body.map(|payload| payload.refresh_token().to_owned()))
}

trait RefreshTokenPayload {
    fn refresh_token(&self) -> &str;
}

impl RefreshTokenPayload for RefreshRequest {
    fn refresh_token(&self) -> &str {
        &self.refresh_token
    }
}

impl RefreshTokenPayload for LogoutRequest {
    fn refresh_token(&self) -> &str {
        &self.refresh_token
    }
}

fn refresh_cookie(token: &str, config: &Config) -> Cookie<'static> {
    Cookie::build(REFRESH_COOKIE_NAME, token.to_string())
        .http_only(true)
        .secure(config.is_production())
        .same_site(SameSite::Lax)
        .path(REFRESH_COOKIE_PATH)
        .max_age(CookieDuration::days(config.jwt_refresh_expiry_days))
        .finish()
}

fn clear_refresh_cookie(config: &Config) -> Cookie<'static> {
    Cookie::build(REFRESH_COOKIE_NAME, "")
        .http_only(true)
        .secure(config.is_production())
        .same_site(SameSite::Lax)
        .path(REFRESH_COOKIE_PATH)
        .max_age(CookieDuration::seconds(0))
        .finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config(app_env: &str) -> Config {
        Config {
            app_env: app_env.to_string(),
            app_host: "127.0.0.1".to_string(),
            app_port: 0,
            frontend_url: "http://localhost:5173".to_string(),
            database_url: "postgres://example".to_string(),
            jwt_secret: "test_secret_must_be_64_chars_long_so_we_pad_it_here_abcdefghijklmnopq"
                .to_string(),
            jwt_expiry_hours: 1,
            jwt_refresh_expiry_days: 30,
            tmdb_api_key: "fake".to_string(),
            tmdb_base_url: "https://api.themoviedb.org/3".to_string(),
            tmdb_image_base_url: "https://image.tmdb.org/t/p".to_string(),
            tmdb_timeout_seconds: 10,
            cors_allowed_origins: vec!["http://localhost:5173".to_string()],
            rate_limit_rps: 10,
            rate_limit_burst: 50,
        }
    }

    #[test]
    fn refresh_cookie_uses_http_only_lax_and_auth_path() {
        let config = test_config("development");
        let cookie = refresh_cookie("refresh-token", &config);

        assert_eq!(cookie.name(), REFRESH_COOKIE_NAME);
        assert_eq!(cookie.value(), "refresh-token");
        assert_eq!(cookie.path(), Some(REFRESH_COOKIE_PATH));
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(cookie.secure(), Some(false));
        assert_eq!(cookie.same_site(), Some(SameSite::Lax));
    }

    #[test]
    fn refresh_cookie_is_secure_in_production() {
        let config = test_config("production");
        let cookie = refresh_cookie("refresh-token", &config);

        assert_eq!(cookie.secure(), Some(true));
    }

    #[test]
    fn clear_refresh_cookie_expires_cookie() {
        let config = test_config("development");
        let cookie = clear_refresh_cookie(&config);

        assert_eq!(cookie.name(), REFRESH_COOKIE_NAME);
        assert_eq!(cookie.value(), "");
        assert_eq!(cookie.path(), Some(REFRESH_COOKIE_PATH));
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(cookie.max_age(), Some(CookieDuration::seconds(0)));
    }
}
