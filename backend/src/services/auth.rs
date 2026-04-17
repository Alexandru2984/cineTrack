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
    let existing = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM users WHERE email = $1 OR username = $2"
    )
    .bind(&req.email)
    .bind(&req.username)
    .fetch_one(pool)
    .await?;

    if existing > 0 {
        return Err(AppError::BadRequest(
            "Unable to create account. Please check your details and try again.".to_string(),
        ));
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

    let (access_token, refresh_token) = issue_token_pair(pool, config, &user).await?;

    Ok(AuthResponse {
        access_token,
        refresh_token,
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
        .ok_or_else(|| AppError::Unauthorized("Invalid email or password".to_string()))?;

    if !password::verify_password(&req.password, password_hash)? {
        return Err(AppError::Unauthorized("Invalid email or password".to_string()));
    }

    // Clean up expired refresh tokens for this user
    sqlx::query("DELETE FROM refresh_tokens WHERE user_id = $1 AND expires_at < NOW()")
        .bind(user.id)
        .execute(pool)
        .await?;

    let (access_token, refresh_token) = issue_token_pair(pool, config, &user).await?;

    Ok(AuthResponse {
        access_token,
        refresh_token,
        token_type: "Bearer".to_string(),
        expires_in: config.jwt_expiry_hours * 3600,
        user: UserResponse::from(user),
    })
}

pub async fn refresh_token(
    pool: &PgPool,
    config: &Config,
    req: RefreshRequest,
) -> Result<AuthResponse, AppError> {
    let token_hash = jwt::hash_refresh_token(&req.refresh_token);

    let stored = sqlx::query_as::<_, crate::models::RefreshToken>(
        "SELECT * FROM refresh_tokens WHERE token_hash = $1"
    )
    .bind(&token_hash)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::Unauthorized("Invalid refresh token".to_string()))?;

    if stored.expires_at < Utc::now() {
        sqlx::query("DELETE FROM refresh_tokens WHERE id = $1")
            .bind(stored.id)
            .execute(pool)
            .await?;
        return Err(AppError::Unauthorized("Refresh token expired".to_string()));
    }

    // Delete the used refresh token (rotation)
    sqlx::query("DELETE FROM refresh_tokens WHERE id = $1")
        .bind(stored.id)
        .execute(pool)
        .await?;

    let user = sqlx::query_as::<_, User>(
        "SELECT * FROM users WHERE id = $1"
    )
    .bind(stored.user_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::Unauthorized("User not found".to_string()))?;

    let (access_token, new_refresh_token) = issue_token_pair(pool, config, &user).await?;

    Ok(AuthResponse {
        access_token,
        refresh_token: new_refresh_token,
        token_type: "Bearer".to_string(),
        expires_in: config.jwt_expiry_hours * 3600,
        user: UserResponse::from(user),
    })
}

pub async fn logout(pool: &PgPool, req: LogoutRequest) -> Result<(), AppError> {
    let token_hash = jwt::hash_refresh_token(&req.refresh_token);
    sqlx::query("DELETE FROM refresh_tokens WHERE token_hash = $1")
        .bind(&token_hash)
        .execute(pool)
        .await?;
    Ok(())
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

/// Issue a new access + refresh token pair, storing the refresh token in DB.
/// Caps active refresh tokens at 5 per user — oldest are deleted when exceeded.
async fn issue_token_pair(
    pool: &PgPool,
    config: &Config,
    user: &User,
) -> Result<(String, String), AppError> {
    let access_token = jwt::generate_access_token(user.id, &config.jwt_secret, config.jwt_expiry_hours)?;
    let refresh_token = jwt::generate_refresh_token();
    let token_hash = jwt::hash_refresh_token(&refresh_token);
    let expires_at = Utc::now() + Duration::days(config.jwt_refresh_expiry_days);

    sqlx::query(
        "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)"
    )
    .bind(user.id)
    .bind(&token_hash)
    .bind(expires_at)
    .execute(pool)
    .await?;

    // Keep at most 5 active tokens per user — delete oldest beyond that
    sqlx::query(
        r#"DELETE FROM refresh_tokens WHERE id IN (
            SELECT id FROM refresh_tokens
            WHERE user_id = $1
            ORDER BY created_at DESC
            OFFSET 5
        )"#
    )
    .bind(user.id)
    .execute(pool)
    .await?;

    Ok((access_token, refresh_token))
}
