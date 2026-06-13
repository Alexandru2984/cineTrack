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
use crate::services;

const REFRESH_COOKIE_NAME: &str = "cinetrack_refresh";
const REFRESH_COOKIE_PATH: &str = "/api/auth";

pub fn configure(cfg: &mut web::ServiceConfig) {
    let auth_governor = GovernorConfigBuilder::default()
        .requests_per_second(3)
        .burst_size(10)
        .finish()
        .expect("Failed to build auth rate limiter");

    cfg.service(
        web::scope("/auth")
            .wrap(Governor::new(&auth_governor))
            .route("/register", web::post().to(register))
            .route("/login", web::post().to(login))
            .route("/logout", web::post().to(logout))
            .route("/refresh", web::post().to(refresh))
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
