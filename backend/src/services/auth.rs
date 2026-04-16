use chrono::{Duration, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::config::Config;
use crate::dto::auth::*;
use crate::errors::AppError;
use crate::models::User;
use crate::utils::{jwt, password};

pub async fn register(
    pool: &PgPool,
    config: &Config,
    req: RegisterRequest,
) -> Result<AuthResponse, AppError> {
    // Check if email or username already exists
    let existing = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM users WHERE email = $1 OR username = $2"
    )
    .bind(&req.email)
    .bind(&req.username)
    .fetch_one(pool)
    .await?;

    if existing > 0 {
        return Err(AppError::Conflict("Email or username already taken".to_string()));
    }

    let password_hash = password::hash_password(&req.password)?;

    let user = sqlx::query_as::<_, User>(
        r#"INSERT INTO users (username, email, password_hash)
        VALUES ($1, $2, $3)
        RETURNING *"#
    )
    .bind(&req.username)
    .bind(&req.email)
    .bind(&password_hash)
    .fetch_one(pool)
    .await?;

    let access_token = jwt::generate_access_token(user.id, &config.jwt_secret, config.jwt_expiry_hours)?;

    // Generate refresh token
    let refresh_token = jwt::generate_refresh_token();
    let refresh_hash = password::hash_password(&refresh_token)?;
    let expires_at = Utc::now() + Duration::days(config.jwt_refresh_expiry_days);

    sqlx::query(
        "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)"
    )
    .bind(user.id)
    .bind(&refresh_hash)
    .bind(expires_at)
    .execute(pool)
    .await?;

    Ok(AuthResponse {
        access_token,
        token_type: "Bearer".to_string(),
        expires_in: config.jwt_expiry_hours * 3600,
        user: UserResponse::from(user),
    })
}

pub async fn login(
    pool: &PgPool,
    config: &Config,
    req: LoginRequest,
) -> Result<AuthResponse, AppError> {
    let user = sqlx::query_as::<_, User>(
        "SELECT * FROM users WHERE email = $1"
    )
    .bind(&req.email)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::Unauthorized("Invalid email or password".to_string()))?;

    let password_hash = user.password_hash.as_ref()
        .ok_or_else(|| AppError::Unauthorized("This account uses OAuth login".to_string()))?;

    if !password::verify_password(&req.password, password_hash)? {
        return Err(AppError::Unauthorized("Invalid email or password".to_string()));
    }

    let access_token = jwt::generate_access_token(user.id, &config.jwt_secret, config.jwt_expiry_hours)?;

    let refresh_token = jwt::generate_refresh_token();
    let refresh_hash = password::hash_password(&refresh_token)?;
    let expires_at = Utc::now() + Duration::days(config.jwt_refresh_expiry_days);

    sqlx::query(
        "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)"
    )
    .bind(user.id)
    .bind(&refresh_hash)
    .bind(expires_at)
    .execute(pool)
    .await?;

    Ok(AuthResponse {
        access_token,
        token_type: "Bearer".to_string(),
        expires_in: config.jwt_expiry_hours * 3600,
        user: UserResponse::from(user),
    })
}

pub async fn refresh_token(
    pool: &PgPool,
    config: &Config,
    user_id: Uuid,
) -> Result<AuthResponse, AppError> {
    let user = sqlx::query_as::<_, User>(
        "SELECT * FROM users WHERE id = $1"
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("User not found".to_string()))?;

    let access_token = jwt::generate_access_token(user.id, &config.jwt_secret, config.jwt_expiry_hours)?;

    Ok(AuthResponse {
        access_token,
        token_type: "Bearer".to_string(),
        expires_in: config.jwt_expiry_hours * 3600,
        user: UserResponse::from(user),
    })
}

pub async fn get_current_user(
    pool: &PgPool,
    user_id: Uuid,
) -> Result<UserResponse, AppError> {
    let user = sqlx::query_as::<_, User>(
        "SELECT * FROM users WHERE id = $1"
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("User not found".to_string()))?;

    Ok(UserResponse::from(user))
}
