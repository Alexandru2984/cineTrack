use chrono::{Duration, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::config::Config;
use crate::dto::auth::*;
use crate::errors::AppError;
use crate::models::{RefreshToken, User};
use crate::utils::{jwt, password};

/// Normalize an email for storage and lookup: trimmed and lowercased, so
/// `Test@X.com ` and `test@x.com` resolve to the same account.
pub fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

pub async fn register(
    pool: &PgPool,
    config: &Config,
    req: RegisterRequest,
) -> Result<(AuthResponse, String), AppError> {
    let email = normalize_email(&req.email);

    let existing = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM users WHERE email = $1 OR username = $2",
    )
    .bind(&email)
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
        RETURNING *"#,
    )
    .bind(&req.username)
    .bind(&email)
    .bind(&password_hash)
    .fetch_one(pool)
    .await?;

    let (access_token, refresh_token) = issue_token_pair(pool, config, &user).await?;

    let resp = AuthResponse {
        access_token,
        token_type: "Bearer".to_string(),
        expires_in: config.jwt_expiry_hours * 3600,
        user: UserResponse::from(user),
    };

    Ok((resp, refresh_token))
}

pub async fn login(
    pool: &PgPool,
    config: &Config,
    req: LoginRequest,
) -> Result<(AuthResponse, String), AppError> {
    let email = normalize_email(&req.email);
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE email = $1")
        .bind(&email)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::Unauthorized("Invalid email or password".to_string()))?;

    let password_hash = user
        .password_hash
        .as_ref()
        .ok_or_else(|| AppError::Unauthorized("Invalid email or password".to_string()))?;

    if !password::verify_password(&req.password, password_hash)? {
        return Err(AppError::Unauthorized(
            "Invalid email or password".to_string(),
        ));
    }

    sqlx::query(
        r#"DELETE FROM refresh_tokens
        WHERE user_id = $1
        AND (
            expires_at < NOW()
            OR (consumed_at IS NOT NULL AND consumed_at < NOW() - INTERVAL '7 days')
            OR (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '7 days')
        )"#,
    )
    .bind(user.id)
    .execute(pool)
    .await?;

    let (access_token, refresh_token) = issue_token_pair(pool, config, &user).await?;

    let resp = AuthResponse {
        access_token,
        token_type: "Bearer".to_string(),
        expires_in: config.jwt_expiry_hours * 3600,
        user: UserResponse::from(user),
    };

    Ok((resp, refresh_token))
}

pub async fn refresh_token(
    pool: &PgPool,
    config: &Config,
    refresh_token: &str,
) -> Result<(AuthResponse, String), AppError> {
    let token_hash = jwt::hash_refresh_token(refresh_token);
    let mut tx = pool.begin().await?;

    let stored = sqlx::query_as::<_, RefreshToken>(
        "SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE",
    )
    .bind(&token_hash)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::Unauthorized("Invalid refresh token".to_string()))?;

    if stored.consumed_at.is_some() {
        sqlx::query("DELETE FROM refresh_tokens WHERE user_id = $1")
            .bind(stored.user_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Err(AppError::Unauthorized(
            "Refresh token reuse detected".to_string(),
        ));
    }

    if stored.revoked_at.is_some() {
        tx.commit().await?;
        return Err(AppError::Unauthorized("Invalid refresh token".to_string()));
    }

    if stored.expires_at < Utc::now() {
        sqlx::query("DELETE FROM refresh_tokens WHERE id = $1")
            .bind(stored.id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Err(AppError::Unauthorized("Refresh token expired".to_string()));
    }

    sqlx::query("UPDATE refresh_tokens SET consumed_at = NOW() WHERE id = $1")
        .bind(stored.id)
        .execute(&mut *tx)
        .await?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(stored.user_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::Unauthorized("User not found".to_string()))?;

    let access_token =
        jwt::generate_access_token(user.id, &config.jwt_secret, config.jwt_expiry_hours)?;
    let new_refresh_token = jwt::generate_refresh_token();
    let new_token_hash = jwt::hash_refresh_token(&new_refresh_token);
    let expires_at = Utc::now() + Duration::days(config.jwt_refresh_expiry_days);

    sqlx::query("INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)")
        .bind(user.id)
        .bind(&new_token_hash)
        .bind(expires_at)
        .execute(&mut *tx)
        .await?;

    cap_active_refresh_tokens(&mut *tx, user.id).await?;
    tx.commit().await?;

    let resp = AuthResponse {
        access_token,
        token_type: "Bearer".to_string(),
        expires_in: config.jwt_expiry_hours * 3600,
        user: UserResponse::from(user),
    };

    Ok((resp, new_refresh_token))
}

pub async fn logout(pool: &PgPool, refresh_token: &str) -> Result<(), AppError> {
    let token_hash = jwt::hash_refresh_token(refresh_token);
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL",
    )
    .bind(&token_hash)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_current_user(pool: &PgPool, user_id: Uuid) -> Result<UserResponse, AppError> {
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
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
    let access_token =
        jwt::generate_access_token(user.id, &config.jwt_secret, config.jwt_expiry_hours)?;
    let refresh_token = jwt::generate_refresh_token();
    let token_hash = jwt::hash_refresh_token(&refresh_token);
    let expires_at = Utc::now() + Duration::days(config.jwt_refresh_expiry_days);

    sqlx::query("INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)")
        .bind(user.id)
        .bind(&token_hash)
        .bind(expires_at)
        .execute(pool)
        .await?;

    cap_active_refresh_tokens(pool, user.id).await?;

    Ok((access_token, refresh_token))
}

async fn cap_active_refresh_tokens<'e, E>(executor: E, user_id: Uuid) -> Result<(), AppError>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    sqlx::query(
        r#"DELETE FROM refresh_tokens WHERE id IN (
            SELECT id FROM refresh_tokens
            WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL
            ORDER BY created_at DESC
            OFFSET 5
        )"#,
    )
    .bind(user_id)
    .execute(executor)
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_email_lowercases_and_trims() {
        assert_eq!(normalize_email("  Test@Example.COM  "), "test@example.com");
    }

    #[test]
    fn test_normalize_email_idempotent() {
        let once = normalize_email("user@example.com");
        assert_eq!(normalize_email(&once), once);
    }
}
