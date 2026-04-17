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
        log::debug!("JWT validation failed: {}", err);
        AppError::Unauthorized("Invalid or expired token".to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(err: reqwest::Error) -> Self {
        log::error!("TMDB request error: {}", err);
        AppError::TmdbError("External API request failed".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::body::to_bytes;
    use actix_web::http::StatusCode;

    fn status_of(err: &AppError) -> StatusCode {
        err.error_response().status()
    }

    #[test]
    fn test_not_found_is_404() {
        assert_eq!(status_of(&AppError::NotFound("x".into())), StatusCode::NOT_FOUND);
    }

    #[test]
    fn test_bad_request_is_400() {
        assert_eq!(status_of(&AppError::BadRequest("x".into())), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn test_unauthorized_is_401() {
        assert_eq!(status_of(&AppError::Unauthorized("x".into())), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn test_forbidden_is_403() {
        assert_eq!(status_of(&AppError::Forbidden("x".into())), StatusCode::FORBIDDEN);
    }

    #[test]
    fn test_conflict_is_409() {
        assert_eq!(status_of(&AppError::Conflict("x".into())), StatusCode::CONFLICT);
    }

    #[test]
    fn test_validation_error_is_400() {
        assert_eq!(status_of(&AppError::ValidationError("x".into())), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn test_tmdb_error_is_502() {
        assert_eq!(status_of(&AppError::TmdbError("x".into())), StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn test_internal_error_is_500() {
        let err = AppError::InternalError(anyhow::anyhow!("boom"));
        assert_eq!(status_of(&err), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn test_internal_error_hides_details() {
        let err = AppError::InternalError(anyhow::anyhow!("secret database details"));
        let resp = err.error_response();
        let body = actix_web::rt::System::new().block_on(to_bytes(resp.into_body())).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["message"], "Internal server error");
        // Must NOT contain the actual error details
        assert!(!json["message"].as_str().unwrap().contains("secret"));
    }

    #[test]
    fn test_error_response_json_format() {
        let err = AppError::NotFound("Item not found".into());
        let resp = err.error_response();
        let body = actix_web::rt::System::new().block_on(to_bytes(resp.into_body())).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json.get("error").is_some());
        assert!(json.get("message").is_some());
        assert_eq!(json["message"], "Item not found");
    }

    #[test]
    fn test_jwt_error_generic_message() {
        // Simulate what happens when a JWT error is converted
        let jwt_err: AppError = jsonwebtoken::errors::Error::from(
            jsonwebtoken::errors::ErrorKind::ExpiredSignature
        ).into();
        match &jwt_err {
            AppError::Unauthorized(msg) => {
                assert_eq!(msg, "Invalid or expired token");
                assert!(!msg.contains("Expired"));
            }
            _ => panic!("Expected Unauthorized"),
        }
    }

    #[test]
    fn test_validation_errors_conversion() {
        use validator::Validate;
        #[derive(Validate)]
        struct Test {
            #[validate(length(min = 5))]
            name: String,
        }
        let t = Test { name: "ab".into() };
        let err: AppError = t.validate().unwrap_err().into();
        match err {
            AppError::ValidationError(msg) => assert!(!msg.is_empty()),
            _ => panic!("Expected ValidationError"),
        }
    }
}
