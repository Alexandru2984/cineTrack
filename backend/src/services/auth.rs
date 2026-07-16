use chrono::{Duration, Utc};
use sqlx::PgPool;
use std::time::Duration as StdDuration;
use tokio::time::Instant;
use uuid::Uuid;

use crate::config::Config;
use crate::dto::auth::*;
use crate::errors::AppError;
use crate::models::{PasswordResetToken, RefreshToken, User};
use crate::services::email::EmailService;
use crate::utils::{jwt, password};

const PASSWORD_RESET_RESPONSE_FLOOR: StdDuration = StdDuration::from_millis(250);

/// Normalize an email for storage and lookup: trimmed and lowercased, so
/// `Test@X.com ` and `test@x.com` resolve to the same account.
pub fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

/// Best-effort client metadata attached to a refresh token so users can review
/// their active sessions. Populated from request headers / peer address.
#[derive(Debug, Clone, Default)]
pub struct ClientInfo {
    pub user_agent: Option<String>,
    pub ip_address: Option<String>,
}

pub async fn register(
    pool: &PgPool,
    config: &Config,
    client: &ClientInfo,
    req: RegisterRequest,
) -> Result<(AuthResponse, String), AppError> {
    let email = normalize_email(&req.email);
    // Perform the expensive work for duplicate and new accounts alike so the
    // generic conflict response does not expose account existence by timing.
    let password_hash = password::hash_password(&req.password).await?;

    let user = sqlx::query_as::<_, User>(
        r#"INSERT INTO users (username, email, password_hash)
        VALUES ($1, $2, $3)
        ON CONFLICT DO NOTHING
        RETURNING *"#,
    )
    .bind(&req.username)
    .bind(&email)
    .bind(&password_hash)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| {
        AppError::BadRequest(
            "Unable to create account. Please check your details and try again.".to_string(),
        )
    })?;

    log::info!("audit: account registered user_id={}", user.id);

    let (access_token, refresh_token) = issue_token_pair(pool, config, client, &user).await?;

    let resp = AuthResponse {
        access_token,
        token_type: "Bearer".to_string(),
        expires_in: config.jwt_expiry_minutes * 60,
        user: UserResponse::from(user),
    };

    Ok((resp, refresh_token))
}

pub async fn login(
    pool: &PgPool,
    config: &Config,
    client: &ClientInfo,
    req: LoginRequest,
) -> Result<(AuthResponse, String), AppError> {
    let email = normalize_email(&req.email);
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE email = $1")
        .bind(&email)
        .fetch_optional(pool)
        .await?;
    let password_hash = user
        .as_ref()
        .and_then(|candidate| candidate.password_hash.as_deref());

    if !password::verify_password_or_dummy(&req.password, password_hash).await? {
        return Err(AppError::Unauthorized(
            "Invalid email or password".to_string(),
        ));
    }
    let user =
        user.ok_or_else(|| AppError::Unauthorized("Invalid email or password".to_string()))?;

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

    let (access_token, refresh_token) = issue_token_pair(pool, config, client, &user).await?;

    let resp = AuthResponse {
        access_token,
        token_type: "Bearer".to_string(),
        expires_in: config.jwt_expiry_minutes * 60,
        user: UserResponse::from(user),
    };

    Ok((resp, refresh_token))
}

pub async fn refresh_token(
    pool: &PgPool,
    config: &Config,
    client: &ClientInfo,
    refresh_token: &str,
) -> Result<(AuthResponse, String), AppError> {
    if !jwt::is_valid_refresh_token(refresh_token) {
        return Err(AppError::Unauthorized("Invalid refresh token".to_string()));
    }
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
        // Reusing an already-rotated token means it was likely stolen; nuke every
        // session for the account and flag it loudly for monitoring.
        log::warn!(
            "security: refresh token reuse detected, revoking all sessions user_id={}",
            stored.user_id
        );
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
        jwt::generate_access_token(user.id, &config.jwt_secret, config.jwt_expiry_minutes)?;
    let new_refresh_token = jwt::generate_refresh_token();
    let new_token_hash = jwt::hash_refresh_token(&new_refresh_token);
    let expires_at = Utc::now() + Duration::days(config.jwt_refresh_expiry_days);

    sqlx::query(
        "INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address, last_used_at)
         VALUES ($1, $2, $3, $4, $5, NOW())",
    )
    .bind(user.id)
    .bind(&new_token_hash)
    .bind(expires_at)
    .bind(&client.user_agent)
    .bind(&client.ip_address)
    .execute(&mut *tx)
    .await?;

    cap_active_refresh_tokens(&mut *tx, user.id).await?;
    tx.commit().await?;

    let resp = AuthResponse {
        access_token,
        token_type: "Bearer".to_string(),
        expires_in: config.jwt_expiry_minutes * 60,
        user: UserResponse::from(user),
    };

    Ok((resp, new_refresh_token))
}

pub async fn logout(pool: &PgPool, refresh_token: &str) -> Result<(), AppError> {
    if !jwt::is_valid_refresh_token(refresh_token) {
        return Ok(());
    }
    let token_hash = jwt::hash_refresh_token(refresh_token);
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL",
    )
    .bind(&token_hash)
    .execute(pool)
    .await?;
    Ok(())
}

/// Change the password of an authenticated user after verifying the current
/// one, then revoke every refresh token so other sessions must re-authenticate.
pub async fn change_password(
    pool: &PgPool,
    user_id: Uuid,
    current_password: &str,
    new_password: &str,
) -> Result<(), AppError> {
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".to_string()))?;

    let password_hash = user
        .password_hash
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("Password login is not enabled".to_string()))?;

    if !password::verify_password(current_password, password_hash).await? {
        return Err(AppError::Unauthorized(
            "Current password is incorrect".to_string(),
        ));
    }

    let new_hash = password::hash_password(new_password).await?;

    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1")
        .bind(user_id)
        .bind(&new_hash)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    log::info!("audit: password changed user_id={user_id}");

    Ok(())
}

/// Start a password reset. Always succeeds from the caller's perspective so the
/// response cannot be used to enumerate registered addresses. When the email
/// exists, a one-time token is stored (hashed) and a reset link is emailed.
pub async fn forgot_password(
    pool: &PgPool,
    config: &Config,
    email_service: &EmailService,
    email: &str,
) -> Result<(), AppError> {
    let respond_at = Instant::now() + PASSWORD_RESET_RESPONSE_FLOOR;
    let email = normalize_email(email);
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE email = $1")
        .bind(&email)
        .fetch_optional(pool)
        .await?;

    let Some(user) = user else {
        tokio::time::sleep_until(respond_at).await;
        return Ok(());
    };

    let token = jwt::generate_refresh_token();
    let token_hash = jwt::hash_refresh_token(&token);
    let expires_at = Utc::now() + Duration::hours(1);

    // Invalidate any outstanding reset tokens before issuing a fresh one.
    sqlx::query("DELETE FROM password_reset_tokens WHERE user_id = $1")
        .bind(user.id)
        .execute(pool)
        .await?;
    sqlx::query(
        "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
    )
    .bind(user.id)
    .bind(&token_hash)
    .bind(expires_at)
    .execute(pool)
    .await?;

    let reset_url = format!(
        "{}/reset-password#token={}",
        config.frontend_url.trim_end_matches('/'),
        token
    );
    let email_service = email_service.clone();
    let recipient = user.email.clone();
    actix_web::rt::spawn(async move {
        email_service
            .send_password_reset(&recipient, &reset_url)
            .await;
    });

    log::info!("audit: password reset requested user_id={}", user.id);

    tokio::time::sleep_until(respond_at).await;
    Ok(())
}

/// Complete a password reset using a one-time token. Consumes the token, sets
/// the new password and revokes all refresh tokens for the account.
pub async fn reset_password(
    pool: &PgPool,
    token: &str,
    new_password: &str,
) -> Result<(), AppError> {
    if !jwt::is_valid_refresh_token(token) {
        return Err(AppError::BadRequest(
            "Invalid or expired reset token".to_string(),
        ));
    }
    let token_hash = jwt::hash_refresh_token(token);
    let mut tx = pool.begin().await?;

    let stored = sqlx::query_as::<_, PasswordResetToken>(
        "SELECT * FROM password_reset_tokens WHERE token_hash = $1 FOR UPDATE",
    )
    .bind(&token_hash)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::BadRequest("Invalid or expired reset token".to_string()))?;

    if stored.consumed_at.is_some() || stored.expires_at < Utc::now() {
        return Err(AppError::BadRequest(
            "Invalid or expired reset token".to_string(),
        ));
    }

    let new_hash = password::hash_password(new_password).await?;

    sqlx::query("UPDATE password_reset_tokens SET consumed_at = NOW() WHERE id = $1")
        .bind(stored.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1")
        .bind(stored.user_id)
        .bind(&new_hash)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
    )
    .bind(stored.user_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    log::info!("audit: password reset completed user_id={}", stored.user_id);

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
    client: &ClientInfo,
    user: &User,
) -> Result<(String, String), AppError> {
    let access_token =
        jwt::generate_access_token(user.id, &config.jwt_secret, config.jwt_expiry_minutes)?;
    let refresh_token = jwt::generate_refresh_token();
    let token_hash = jwt::hash_refresh_token(&refresh_token);
    let expires_at = Utc::now() + Duration::days(config.jwt_refresh_expiry_days);

    sqlx::query(
        "INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address, last_used_at)
         VALUES ($1, $2, $3, $4, $5, NOW())",
    )
    .bind(user.id)
    .bind(&token_hash)
    .bind(expires_at)
    .bind(&client.user_agent)
    .bind(&client.ip_address)
    .execute(pool)
    .await?;

    cap_active_refresh_tokens(pool, user.id).await?;

    Ok((access_token, refresh_token))
}

/// List a user's active sessions (unconsumed, unrevoked, unexpired refresh
/// tokens). The session matching `current_refresh_token` is flagged.
pub async fn list_sessions(
    pool: &PgPool,
    user_id: Uuid,
    current_refresh_token: Option<&str>,
) -> Result<Vec<SessionResponse>, AppError> {
    let current_hash = current_refresh_token.map(jwt::hash_refresh_token);

    let tokens = sqlx::query_as::<_, RefreshToken>(
        r#"SELECT * FROM refresh_tokens
        WHERE user_id = $1
          AND consumed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > NOW()
        ORDER BY last_used_at DESC NULLS LAST, created_at DESC"#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    Ok(tokens
        .into_iter()
        .map(|t| SessionResponse {
            current: current_hash.as_deref() == Some(t.token_hash.as_str()),
            id: t.id,
            user_agent: t.user_agent,
            ip_address: t.ip_address,
            created_at: t.created_at,
            last_used_at: t.last_used_at,
        })
        .collect())
}

/// Revoke a single session by id. Scoped to the owner so one user cannot revoke
/// another's session; a missing/foreign id yields NotFound (no enumeration).
pub async fn revoke_session(
    pool: &PgPool,
    user_id: Uuid,
    session_id: Uuid,
) -> Result<(), AppError> {
    let result = sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = NOW()
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
    )
    .bind(session_id)
    .bind(user_id)
    .execute(pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Session not found".to_string()));
    }

    log::info!("audit: session revoked user_id={user_id} session_id={session_id}");

    Ok(())
}

/// Revoke every active session for the user ("sign out everywhere").
pub async fn logout_all_sessions(pool: &PgPool, user_id: Uuid) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
    )
    .bind(user_id)
    .execute(pool)
    .await?;

    log::info!("audit: all sessions revoked user_id={user_id}");

    Ok(())
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
