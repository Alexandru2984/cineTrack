use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;
use validator::Validate;

use crate::config::Config;
use crate::dto::auth::*;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::services;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/auth")
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

async fn logout() -> Result<HttpResponse, AppError> {
    // In a full implementation, we'd invalidate the refresh token
    Ok(HttpResponse::Ok().json(serde_json::json!({"message": "Logged out successfully"})))
}

async fn refresh(
    pool: web::Data<PgPool>,
    config: web::Data<Config>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let resp = services::auth::refresh_token(pool.get_ref(), config.get_ref(), user_id).await?;
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
