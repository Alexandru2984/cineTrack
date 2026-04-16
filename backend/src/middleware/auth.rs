use actix_web::{dev::ServiceRequest, Error, HttpMessage, HttpRequest, web};
use uuid::Uuid;

use crate::config::Config;
use crate::errors::AppError;
use crate::utils::jwt;

pub fn extract_user_id(req: &HttpRequest) -> Result<Uuid, AppError> {
    req.extensions()
        .get::<Uuid>()
        .copied()
        .ok_or_else(|| AppError::Unauthorized("Not authenticated".to_string()))
}

pub fn extract_optional_user_id(req: &HttpRequest) -> Option<Uuid> {
    req.extensions().get::<Uuid>().copied()
}

pub async fn validate_token_from_request(req: &ServiceRequest, config: &Config) -> Result<Uuid, AppError> {
    let auth_header = req
        .headers()
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("Missing Authorization header".to_string()))?;

    let token = auth_header
        .strip_prefix("Bearer ")
        .ok_or_else(|| AppError::Unauthorized("Invalid Authorization format".to_string()))?;

    let claims = jwt::validate_token(token, &config.jwt_secret)?;
    Ok(claims.sub)
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
    Ok(claims.sub)
}
