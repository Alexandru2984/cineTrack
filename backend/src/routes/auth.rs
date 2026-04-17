use actix_governor::{Governor, GovernorConfigBuilder};
use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;
use validator::Validate;

use crate::config::Config;
use crate::dto::auth::*;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::services;

pub fn configure(cfg: &mut web::ServiceConfig) {
    let auth_governor = GovernorConfigBuilder::default()
        .per_second(3)
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
            .route("/me", web::get().to(me))
    );
}

async fn register(
    pool: web::Data<PgPool>,
    config: web::Data<Config>,
    body: web::Json<RegisterRequest>,
) -> Result<HttpResponse, AppError> {
    body.validate()?;
    let resp = services::auth::register(pool.get_ref(), config.get_ref(), body.into_inner()).await?;
    Ok(HttpResponse::Created().json(resp))
}

async fn login(
    pool: web::Data<PgPool>,
    config: web::Data<Config>,
    body: web::Json<LoginRequest>,
) -> Result<HttpResponse, AppError> {
    let resp = services::auth::login(pool.get_ref(), config.get_ref(), body.into_inner()).await?;
    Ok(HttpResponse::Ok().json(resp))
}

async fn logout(
    pool: web::Data<PgPool>,
    body: web::Json<LogoutRequest>,
) -> Result<HttpResponse, AppError> {
    services::auth::logout(pool.get_ref(), body.into_inner()).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({"message": "Logged out successfully"})))
}

async fn refresh(
    pool: web::Data<PgPool>,
    config: web::Data<Config>,
    body: web::Json<RefreshRequest>,
) -> Result<HttpResponse, AppError> {
    let resp = services::auth::refresh_token(pool.get_ref(), config.get_ref(), body.into_inner()).await?;
    Ok(HttpResponse::Ok().json(resp))
}

async fn me(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let user = services::auth::get_current_user(pool.get_ref(), user_id).await?;
    Ok(HttpResponse::Ok().json(user))
}
