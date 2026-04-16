use actix_web::{HttpResponse, ResponseError};
use serde::Serialize;
use std::fmt;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Bad request: {0}")]
    BadRequest(String),

    #[error("Unauthorized: {0}")]
    Unauthorized(String),

    #[error("Forbidden: {0}")]
    Forbidden(String),

    #[error("Conflict: {0}")]
    Conflict(String),

    #[error("Internal server error")]
    InternalError(#[from] anyhow::Error),

    #[error("Database error")]
    DatabaseError(#[from] sqlx::Error),

    #[error("Validation error: {0}")]
    ValidationError(String),

    #[error("TMDB API error: {0}")]
    TmdbError(String),
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
    message: String,
}

impl ResponseError for AppError {
    fn error_response(&self) -> HttpResponse {
        let (status, message) = match self {
            AppError::NotFound(msg) => (actix_web::http::StatusCode::NOT_FOUND, msg.clone()),
            AppError::BadRequest(msg) => (actix_web::http::StatusCode::BAD_REQUEST, msg.clone()),
            AppError::Unauthorized(msg) => (actix_web::http::StatusCode::UNAUTHORIZED, msg.clone()),
            AppError::Forbidden(msg) => (actix_web::http::StatusCode::FORBIDDEN, msg.clone()),
            AppError::Conflict(msg) => (actix_web::http::StatusCode::CONFLICT, msg.clone()),
            AppError::ValidationError(msg) => (actix_web::http::StatusCode::BAD_REQUEST, msg.clone()),
            AppError::TmdbError(msg) => (actix_web::http::StatusCode::BAD_GATEWAY, msg.clone()),
            AppError::InternalError(_) | AppError::DatabaseError(_) => {
                eprintln!("Internal error: {:?}", self);
                log::error!("Internal error: {:?}", self);
                (
                    actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
        };

        HttpResponse::build(status).json(ErrorResponse {
            error: status.to_string(),
            message,
        })
    }
}

impl From<validator::ValidationErrors> for AppError {
    fn from(err: validator::ValidationErrors) -> Self {
        AppError::ValidationError(err.to_string())
    }
}

impl From<jsonwebtoken::errors::Error> for AppError {
    fn from(err: jsonwebtoken::errors::Error) -> Self {
        AppError::Unauthorized(format!("Invalid token: {}", err))
    }
}

impl From<reqwest::Error> for AppError {
    fn from(err: reqwest::Error) -> Self {
        AppError::TmdbError(err.to_string())
    }
}
