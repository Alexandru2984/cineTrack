use chrono::{Duration, Utc};
use rand::TryRng;
use sqlx::PgPool;
use std::time::Duration as StdDuration;
use tokio::time::Instant;
use uuid::Uuid;

use crate::config::Config;
use crate::dto::auth::*;
use crate::errors::AppError;
use crate::models::{EmailVerificationToken, PasswordResetToken, RefreshToken, User};
use crate::services::email::EmailService;
use crate::utils::{jwt, password, totp, totp_secret};

const PASSWORD_RESET_RESPONSE_FLOOR: StdDuration = StdDuration::from_millis(250);
const PASSWORD_RESET_COOLDOWN_SECONDS: i64 = 10 * 60;
const EMAIL_VERIFICATION_TTL_HOURS: i64 = 24;
const EMAIL_VERIFICATION_COOLDOWN_SECONDS: i64 = 2 * 60;
const LOGIN_FAILURE_LIMIT: i32 = 5;
const LOGIN_FAILURE_WINDOW_SECONDS: i64 = 15 * 60;
const LOGIN_LOCK_SECONDS: i64 = 15 * 60;

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
    email_service: &EmailService,
    client: &ClientInfo,
    req: RegisterRequest,
) -> Result<(AuthResponse, String), AppError> {
    let email = normalize_email(&req.email);
    // Perform the expensive work for duplicate and new accounts alike so the
    // generic conflict response does not expose account existence by timing.
    let password_hash = password::hash_password(&req.password).await?;

    let user = sqlx::query_as::<_, User>(
        r#"INSERT INTO users (username, email, password_hash, is_public)
        VALUES ($1, $2, $3, FALSE)
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

    // Best-effort: a verification email failure must not block account creation;
    // the user can request a fresh link later from the app.
    if let Err(error) =
        issue_email_verification(pool, config, email_service, user.id, &user.email).await
    {
        log::warn!(
            "failed to issue email verification at register user_id={}: {error}",
            user.id
        );
    }

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
        if let Some(user) = &user {
            record_login_failure(pool, user.id).await?;
        }
        return Err(AppError::Unauthorized(
            "Invalid email or password".to_string(),
        ));
    }
    let user =
        user.ok_or_else(|| AppError::Unauthorized("Invalid email or password".to_string()))?;

    if user
        .login_locked_until
        .is_some_and(|locked_until| locked_until > Utc::now())
    {
        return Err(AppError::TooManyRequests(
            "Too many failed sign-in attempts. Try again later.".to_string(),
        ));
    }

    // Second factor: only revealed after the password is confirmed, so it never
    // discloses whether an address has 2FA before credentials are correct.
    if user.totp_enabled {
        match req
            .totp_code
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
        {
            None => return Err(AppError::TwoFactorRequired),
            Some(code) => {
                if !verify_second_factor(pool, config, &user, code).await? {
                    record_login_failure(pool, user.id).await?;
                    return Err(AppError::Unauthorized(
                        "Invalid two-factor code".to_string(),
                    ));
                }
            }
        }
    }

    clear_login_failures(pool, user.id).await?;

    sqlx::query(
        r#"DELETE FROM refresh_tokens
        WHERE refresh_tokens.user_id = $1
        AND (
            expires_at < NOW()
            OR (consumed_at IS NOT NULL AND consumed_at < NOW() - INTERVAL '7 days')
            OR (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '7 days')
        )
        AND NOT EXISTS (
            SELECT 1 FROM refresh_tokens active
            WHERE active.family_id = refresh_tokens.family_id
              AND active.consumed_at IS NULL
              AND active.revoked_at IS NULL
              AND active.expires_at >= NOW()
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
        "INSERT INTO refresh_tokens
            (user_id, token_hash, expires_at, user_agent, ip_address, last_used_at, family_id)
         VALUES ($1, $2, $3, $4, $5, NOW(), $6)",
    )
    .bind(user.id)
    .bind(&new_token_hash)
    .bind(expires_at)
    .bind(&client.user_agent)
    .bind(&client.ip_address)
    .bind(stored.family_id)
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
    let mut tx = pool.begin().await?;
    let family_id = sqlx::query_scalar::<_, Uuid>(
        "SELECT family_id FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE",
    )
    .bind(&token_hash)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(family_id) = family_id {
        sqlx::query(
            "UPDATE refresh_tokens SET revoked_at = NOW()
             WHERE family_id = $1 AND revoked_at IS NULL",
        )
        .bind(family_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
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
    sqlx::query(
        "UPDATE password_reset_tokens SET consumed_at = NOW()
         WHERE user_id = $1 AND consumed_at IS NULL",
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

    // The unique user index and conditional upsert make concurrent requests
    // atomic. A recent active token remains valid instead of generating more
    // email, while consumed or expired tokens can be replaced immediately.
    let issued = sqlx::query_as::<_, PasswordResetToken>(
        "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE
         SET token_hash = EXCLUDED.token_hash,
             expires_at = EXCLUDED.expires_at,
             consumed_at = NULL,
             created_at = NOW()
         WHERE password_reset_tokens.consumed_at IS NOT NULL
            OR password_reset_tokens.expires_at <= NOW()
            OR password_reset_tokens.created_at
               <= NOW() - ($4 * INTERVAL '1 second')
         RETURNING *",
    )
    .bind(user.id)
    .bind(&token_hash)
    .bind(expires_at)
    .bind(PASSWORD_RESET_COOLDOWN_SECONDS)
    .fetch_optional(pool)
    .await?;

    if issued.is_none() {
        tokio::time::sleep_until(respond_at).await;
        return Ok(());
    }

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

/// Issue (or refresh) a one-time email-verification token and send the link.
/// Returns whether a new email was dispatched; a still-active token inside the
/// cooldown window is preserved and reported as `false` so callers can stay
/// uniform without generating repeat mail. Best-effort delivery (spawned).
pub async fn issue_email_verification(
    pool: &PgPool,
    config: &Config,
    email_service: &EmailService,
    user_id: Uuid,
    email: &str,
) -> Result<bool, AppError> {
    let token = jwt::generate_refresh_token();
    let token_hash = jwt::hash_refresh_token(&token);
    let expires_at = Utc::now() + Duration::hours(EMAIL_VERIFICATION_TTL_HOURS);

    let issued = sqlx::query_as::<_, EmailVerificationToken>(
        "INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE
         SET token_hash = EXCLUDED.token_hash,
             expires_at = EXCLUDED.expires_at,
             consumed_at = NULL,
             created_at = NOW()
         WHERE email_verification_tokens.consumed_at IS NOT NULL
            OR email_verification_tokens.expires_at <= NOW()
            OR email_verification_tokens.created_at
               <= NOW() - ($4 * INTERVAL '1 second')
         RETURNING *",
    )
    .bind(user_id)
    .bind(&token_hash)
    .bind(expires_at)
    .bind(EMAIL_VERIFICATION_COOLDOWN_SECONDS)
    .fetch_optional(pool)
    .await?;

    if issued.is_none() {
        return Ok(false);
    }

    let verify_url = format!(
        "{}/verify-email#token={}",
        config.frontend_url.trim_end_matches('/'),
        token
    );
    let email_service = email_service.clone();
    let recipient = email.to_string();
    actix_web::rt::spawn(async move {
        email_service
            .send_email_verification(&recipient, &verify_url)
            .await;
    });

    Ok(true)
}

/// Confirm an email address from a one-time token. Consumes the token and marks
/// the account verified. Invalid, consumed, or expired tokens are rejected with
/// the same generic error.
pub async fn verify_email(pool: &PgPool, token: &str) -> Result<(), AppError> {
    if !jwt::is_valid_refresh_token(token) {
        return Err(AppError::BadRequest(
            "Invalid or expired verification token".to_string(),
        ));
    }
    let token_hash = jwt::hash_refresh_token(token);
    let mut tx = pool.begin().await?;

    let stored = sqlx::query_as::<_, EmailVerificationToken>(
        "SELECT * FROM email_verification_tokens WHERE token_hash = $1 FOR UPDATE",
    )
    .bind(&token_hash)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::BadRequest("Invalid or expired verification token".to_string()))?;

    if stored.consumed_at.is_some() || stored.expires_at < Utc::now() {
        return Err(AppError::BadRequest(
            "Invalid or expired verification token".to_string(),
        ));
    }

    sqlx::query("UPDATE email_verification_tokens SET consumed_at = NOW() WHERE id = $1")
        .bind(stored.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE users SET email_verified = TRUE, updated_at = NOW() WHERE id = $1")
        .bind(stored.user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    log::info!("audit: email verified user_id={}", stored.user_id);

    Ok(())
}

/// Re-send a verification link for the authenticated user. Already-verified
/// accounts are a no-op so the response cannot be used to probe account state.
pub async fn resend_email_verification(
    pool: &PgPool,
    config: &Config,
    email_service: &EmailService,
    user_id: Uuid,
) -> Result<(), AppError> {
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".to_string()))?;

    if user.email_verified {
        return Ok(());
    }

    issue_email_verification(pool, config, email_service, user.id, &user.email).await?;
    Ok(())
}

/// Gate actions that expose an account or its data to other users. Unverified
/// accounts can still use private tracking and finish account recovery.
pub async fn require_verified_email(pool: &PgPool, user_id: Uuid) -> Result<(), AppError> {
    let verified = sqlx::query_scalar::<_, bool>("SELECT email_verified FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".to_string()))?;

    if !verified {
        return Err(AppError::Forbidden(
            "Confirm your email before using this feature".to_string(),
        ));
    }
    Ok(())
}

const TOTP_ISSUER: &str = "Văzute";
const RECOVERY_CODE_COUNT: usize = 10;

async fn record_login_failure(pool: &PgPool, user_id: Uuid) -> Result<(), AppError> {
    sqlx::query(
        "WITH next_attempt AS (
            SELECT id,
                CASE
                    WHEN login_last_failed_at IS NULL
                      OR login_last_failed_at < NOW() - ($2 * INTERVAL '1 second')
                    THEN 1
                    ELSE LEAST(login_failed_attempts + 1, $3)
                END AS attempts
            FROM users
            WHERE id = $1
              AND (login_locked_until IS NULL OR login_locked_until <= NOW())
            FOR UPDATE
        )
        UPDATE users AS target
        SET login_failed_attempts = next_attempt.attempts,
            login_last_failed_at = NOW(),
            login_locked_until = CASE
                WHEN next_attempt.attempts >= $3
                THEN NOW() + ($4 * INTERVAL '1 second')
                ELSE NULL
            END
        FROM next_attempt
        WHERE target.id = next_attempt.id",
    )
    .bind(user_id)
    .bind(LOGIN_FAILURE_WINDOW_SECONDS)
    .bind(LOGIN_FAILURE_LIMIT)
    .bind(LOGIN_LOCK_SECONDS)
    .execute(pool)
    .await?;
    Ok(())
}

async fn clear_login_failures(pool: &PgPool, user_id: Uuid) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE users
         SET login_failed_attempts = 0,
             login_last_failed_at = NULL,
             login_locked_until = NULL
         WHERE id = $1
           AND (login_failed_attempts <> 0
             OR login_last_failed_at IS NOT NULL
             OR login_locked_until IS NOT NULL)",
    )
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(())
}

fn decode_stored_totp_secret(
    config: &Config,
    user: &User,
) -> Result<(Vec<u8>, Option<String>), AppError> {
    let stored = user.totp_secret.as_deref().ok_or_else(|| {
        AppError::InternalError(anyhow::anyhow!("2FA enabled without a stored secret"))
    })?;
    let (secret, migrated) = if totp_secret::is_encrypted(stored) {
        (
            totp_secret::decrypt(&config.totp_encryption_key, user.id, stored)?,
            None,
        )
    } else {
        let secret = hex::decode(stored).map_err(|_| {
            AppError::InternalError(anyhow::anyhow!("legacy TOTP secret is not valid hex"))
        })?;
        let encrypted = totp_secret::encrypt(&config.totp_encryption_key, user.id, &secret)?;
        (secret, Some(encrypted))
    };
    if secret.len() != 20 {
        return Err(AppError::InternalError(anyhow::anyhow!(
            "stored TOTP secret has the wrong length"
        )));
    }
    Ok((secret, migrated))
}

/// Verify a submitted second factor: a 6-digit TOTP code, or otherwise a
/// single-use recovery code (consumed atomically on success).
async fn verify_second_factor(
    pool: &PgPool,
    config: &Config,
    user: &User,
    code: &str,
) -> Result<bool, AppError> {
    let (secret, migrated_secret) = decode_stored_totp_secret(config, user)?;

    let is_totp_shape = code.len() == 6 && code.bytes().all(|byte| byte.is_ascii_digit());
    if is_totp_shape {
        let now = Utc::now().timestamp().max(0) as u64;
        let Some(step) = totp::matching_step(&secret, code, now) else {
            return Ok(false);
        };
        let step = i64::try_from(step).map_err(|_| {
            AppError::InternalError(anyhow::anyhow!("TOTP counter does not fit the database"))
        })?;
        let accepted = sqlx::query(
            "UPDATE users
             SET totp_last_used_step = $2,
                 totp_secret = COALESCE($3, totp_secret),
                 updated_at = NOW()
             WHERE id = $1
               AND (totp_last_used_step IS NULL OR totp_last_used_step < $2)",
        )
        .bind(user.id)
        .bind(step)
        .bind(migrated_secret)
        .execute(pool)
        .await?
        .rows_affected();
        return Ok(accepted == 1);
    }

    // Recovery code: mark the matching unconsumed row consumed in one statement.
    let code_hash = jwt::hash_refresh_token(code.trim());
    let mut tx = pool.begin().await?;
    let consumed = sqlx::query(
        "UPDATE two_factor_recovery_codes SET consumed_at = NOW()
         WHERE user_id = $1 AND code_hash = $2 AND consumed_at IS NULL",
    )
    .bind(user.id)
    .bind(&code_hash)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if consumed == 1 {
        if let Some(encrypted) = migrated_secret {
            sqlx::query("UPDATE users SET totp_secret = $2, updated_at = NOW() WHERE id = $1")
                .bind(user.id)
                .bind(encrypted)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
    }
    Ok(consumed == 1)
}

/// Begin TOTP enrollment: store a fresh pending secret and return the base32
/// secret plus the otpauth URI for the authenticator app. Re-running before
/// activation simply rotates the pending secret.
pub async fn setup_two_factor(
    pool: &PgPool,
    config: &Config,
    user_id: Uuid,
    password_input: &str,
) -> Result<TwoFactorSetupResponse, AppError> {
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".to_string()))?;

    if !user.email_verified {
        return Err(AppError::Forbidden(
            "Confirm your email before enabling two-factor authentication".to_string(),
        ));
    }

    // Re-confirm the password so a stolen access token alone cannot enroll a
    // second factor and lock the real owner out.
    let password_hash = user
        .password_hash
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("Password login is not enabled".to_string()))?;
    if !password::verify_password(password_input, password_hash).await? {
        return Err(AppError::Unauthorized("Password is incorrect".to_string()));
    }

    if user.totp_enabled {
        return Err(AppError::Conflict(
            "Two-factor authentication is already enabled".to_string(),
        ));
    }

    let secret = totp::generate_secret();
    let encrypted = totp_secret::encrypt(&config.totp_encryption_key, user_id, &secret)?;
    let updated = sqlx::query(
        "UPDATE users
         SET totp_secret = $2, totp_last_used_step = NULL, updated_at = NOW()
         WHERE id = $1
           AND totp_enabled = FALSE
           AND totp_secret IS NOT DISTINCT FROM $3",
    )
    .bind(user_id)
    .bind(encrypted)
    .bind(&user.totp_secret)
    .execute(pool)
    .await?
    .rows_affected();
    if updated != 1 {
        return Err(AppError::Conflict(
            "Two-factor setup changed. Start setup again.".to_string(),
        ));
    }

    Ok(TwoFactorSetupResponse {
        secret: totp::base32_encode(&secret),
        otpauth_uri: totp::otpauth_uri(TOTP_ISSUER, &user.email, &secret),
    })
}

/// Activate TOTP once the user proves possession with a valid code. Generates a
/// fresh set of one-time recovery codes (returned in plaintext exactly here).
pub async fn enable_two_factor(
    pool: &PgPool,
    config: &Config,
    user_id: Uuid,
    code: &str,
) -> Result<Vec<String>, AppError> {
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".to_string()))?;

    if !user.email_verified {
        return Err(AppError::Forbidden(
            "Confirm your email before enabling two-factor authentication".to_string(),
        ));
    }

    if user.totp_enabled {
        return Err(AppError::Conflict(
            "Two-factor authentication is already enabled".to_string(),
        ));
    }
    let stored_secret = user.totp_secret.clone().ok_or_else(|| {
        AppError::BadRequest("Start two-factor setup before confirming a code".to_string())
    })?;
    let (secret, _) = decode_stored_totp_secret(config, &user)?;
    let now = Utc::now().timestamp().max(0) as u64;
    let Some(step) = totp::matching_step(&secret, code, now) else {
        return Err(AppError::BadRequest(
            "That code is incorrect. Check your authenticator and try again.".to_string(),
        ));
    };
    let step = i64::try_from(step).map_err(|_| {
        AppError::InternalError(anyhow::anyhow!("TOTP counter does not fit the database"))
    })?;
    let encrypted = totp_secret::encrypt(&config.totp_encryption_key, user_id, &secret)?;

    let codes: Vec<String> = (0..RECOVERY_CODE_COUNT)
        .map(|_| generate_recovery_code())
        .collect();

    let mut tx = pool.begin().await?;
    let enabled = sqlx::query(
        "UPDATE users
         SET totp_enabled = TRUE,
             totp_secret = $2,
             totp_last_used_step = $3,
             updated_at = NOW()
         WHERE id = $1
           AND totp_enabled = FALSE
           AND totp_secret = $4
           AND (totp_last_used_step IS NULL OR totp_last_used_step < $3)",
    )
    .bind(user_id)
    .bind(encrypted)
    .bind(step)
    .bind(stored_secret)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if enabled != 1 {
        return Err(AppError::Conflict(
            "Two-factor setup changed. Start setup again.".to_string(),
        ));
    }
    sqlx::query("DELETE FROM two_factor_recovery_codes WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    for code in &codes {
        sqlx::query("INSERT INTO two_factor_recovery_codes (user_id, code_hash) VALUES ($1, $2)")
            .bind(user_id)
            .bind(jwt::hash_refresh_token(code))
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    log::info!("audit: two-factor enabled user_id={user_id}");

    Ok(codes)
}

/// Turn off TOTP after re-confirming the account password, clearing the secret
/// and all recovery codes.
pub async fn disable_two_factor(
    pool: &PgPool,
    user_id: Uuid,
    password_input: &str,
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
    if !password::verify_password(password_input, password_hash).await? {
        return Err(AppError::Unauthorized("Password is incorrect".to_string()));
    }

    let mut tx = pool.begin().await?;
    sqlx::query(
        "UPDATE users
         SET totp_enabled = FALSE,
             totp_secret = NULL,
             totp_last_used_step = NULL,
             updated_at = NOW()
         WHERE id = $1",
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM two_factor_recovery_codes WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    log::info!("audit: two-factor disabled user_id={user_id}");

    Ok(())
}

/// A grouped, human-legible recovery code (64 bits of entropy as
/// `xxxx-xxxx-xxxx-xxxx`), so the global unique index on the code hash has a
/// negligible collision probability across accounts.
fn generate_recovery_code() -> String {
    let mut bytes = [0u8; 8];
    rand::rngs::SysRng
        .try_fill_bytes(&mut bytes)
        .expect("OS RNG unavailable while generating a recovery code");
    let hex = hex::encode(bytes);
    format!(
        "{}-{}-{}-{}",
        &hex[0..4],
        &hex[4..8],
        &hex[8..12],
        &hex[12..16]
    )
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

/// Resolve a mobile session from its active refresh token, then return all
/// active sessions while marking that exact token as current.
pub async fn list_sessions_for_refresh_token(
    pool: &PgPool,
    refresh_token: &str,
) -> Result<Vec<SessionResponse>, AppError> {
    if !jwt::is_valid_refresh_token(refresh_token) {
        return Err(AppError::Unauthorized("Invalid refresh token".to_string()));
    }

    let token_hash = jwt::hash_refresh_token(refresh_token);
    let user_id = sqlx::query_scalar::<_, Uuid>(
        r#"SELECT user_id FROM refresh_tokens
        WHERE token_hash = $1
          AND consumed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > NOW()"#,
    )
    .bind(&token_hash)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::Unauthorized("Invalid refresh token".to_string()))?;

    let sessions = list_sessions(pool, user_id, Some(refresh_token)).await?;
    if !sessions.iter().any(|session| session.current) {
        return Err(AppError::Unauthorized("Invalid refresh token".to_string()));
    }
    Ok(sessions)
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
