//! End-to-end encryption key directory and encrypted key backup.
//!
//! Two jobs, both deliberately narrow. The server answers "what is this
//! person's public key" so two clients can address each other, and it stores an
//! opaque blob so a lost phone does not mean a lost history. It never holds
//! anything that decrypts a message.
//!
//! # The directory is trusted, and that is visible
//!
//! Because the server answers the key question, it could answer with its own
//! key and read the conversation. Nothing here prevents that — no managed
//! directory can. What it does instead is make substitution *detectable*: the
//! fingerprint each client derives from the keys is served alongside them, and
//! comparing it out of band is what turns an undetectable attack into an
//! obvious one. Same trade as Signal's safety numbers.

use crate::config::Config;
use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;
use uuid::Uuid;
use validator::Validate;

use crate::dto::encryption::*;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::services::security_activity::{self, SecurityActivityKind};

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/encryption")
            .route("/keys", web::get().to(key_status))
            .route("/keys", web::put().to(publish_keys))
            .route("/keys/backup", web::get().to(get_key_backup))
            .route("/keys/backup", web::put().to(rewrap_key_backup))
            .route("/keys/{username}", web::get().to(peer_public_keys)),
    );
}

/// Whether this account has keys yet, so a client can tell first-time setup
/// from restoring an existing backup.
async fn key_status(pool: web::Data<PgPool>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let row = sqlx::query_as::<_, (String, i32)>(
        "SELECT key_fingerprint, generation FROM user_identity_keys WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;

    Ok(no_store(HttpResponse::Ok()).json(match row {
        Some((key_fingerprint, generation)) => KeyStatusResponse {
            has_keys: true,
            key_fingerprint: Some(key_fingerprint),
            generation: Some(generation),
        },
        None => KeyStatusResponse {
            has_keys: false,
            key_fingerprint: None,
            generation: None,
        },
    }))
}

/// Publish or replace this account's keys, together with the encrypted backup
/// of their private halves.
///
/// One request rather than two, because the two must never disagree: a
/// directory entry whose backup is missing or stale leaves the account able to
/// receive messages it can never read. They are written in a single transaction
/// for the same reason.
async fn publish_keys(
    pool: web::Data<PgPool>,
    config: web::Data<crate::config::Config>,
    req: HttpRequest,
    body: web::Json<PublishKeysRequest>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    body.validate()?;
    let data = body.into_inner();

    // Replacing keys costs a password; creating them for the first time does
    // not. The difference is what the route destroys. A first publication
    // overwrites nothing, and a password prompt during onboarding would buy
    // nothing. A second one replaces the identity and *both* wrapped copies of
    // the private key below — the password copy and the recovery copy — after
    // which no one, the owner included, can read a single message that was
    // encrypted to the old key. That is not something a fifteen-minute access
    // token should be able to do on its own.
    //
    // Checked before any work, so a request that cannot succeed does not first
    // spend an Argon2 verification or open a transaction.
    let replacing = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM user_identity_keys WHERE user_id = $1)",
    )
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await?;
    if replacing {
        let user = sqlx::query_as::<_, crate::models::User>("SELECT * FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(pool.get_ref())
            .await?
            .ok_or_else(|| AppError::NotFound("User not found".to_string()))?;
        let password = data.current_password.as_deref().ok_or_else(|| {
            AppError::BadRequest(
                "Replacing your encryption keys requires your account password".to_string(),
            )
        })?;
        crate::services::auth::confirm_sensitive_action(
            pool.get_ref(),
            &config,
            &user,
            password,
            data.totp_code.as_deref(),
        )
        .await?;
    }
    data.password_kdf
        .validate_cost()
        .map_err(|error| AppError::BadRequest(describe(&error)))?;

    // Decoded here rather than trusted as text: the database columns are BYTEA
    // with exact-length checks, and hex that passed validation cannot fail to
    // decode.
    let exchange = hex::decode(&data.exchange_public_key)
        .map_err(|_| AppError::BadRequest("Invalid exchange key encoding".to_string()))?;
    let signing = hex::decode(&data.signing_public_key)
        .map_err(|_| AppError::BadRequest("Invalid signing key encoding".to_string()))?;
    let password_wrapped = hex::decode(&data.password_wrapped_key)
        .map_err(|_| AppError::BadRequest("Invalid wrapped key encoding".to_string()))?;
    let password_salt = hex::decode(&data.password_kdf_salt)
        .map_err(|_| AppError::BadRequest("Invalid salt encoding".to_string()))?;
    let recovery_wrapped = hex::decode(&data.recovery_wrapped_key)
        .map_err(|_| AppError::BadRequest("Invalid wrapped key encoding".to_string()))?;
    let recovery_salt = hex::decode(&data.recovery_kdf_salt)
        .map_err(|_| AppError::BadRequest("Invalid salt encoding".to_string()))?;

    let mut tx = pool.begin().await?;

    // Replacing keys makes every message encrypted to the old ones unreadable
    // by anyone who has not kept the old private key. The generation counter is
    // what lets a peer notice, and the fingerprint is what lets a human notice.
    let generation = sqlx::query_scalar::<_, i32>(
        r#"INSERT INTO user_identity_keys
            (user_id, exchange_public_key, signing_public_key, key_fingerprint)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id) DO UPDATE SET
            exchange_public_key = EXCLUDED.exchange_public_key,
            signing_public_key = EXCLUDED.signing_public_key,
            key_fingerprint = EXCLUDED.key_fingerprint,
            generation = user_identity_keys.generation + 1,
            updated_at = NOW()
        RETURNING generation"#,
    )
    .bind(user_id)
    .bind(&exchange)
    .bind(&signing)
    .bind(&data.key_fingerprint)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        r#"INSERT INTO user_key_backups (
            user_id, password_wrapped_key, password_kdf_salt,
            password_kdf_memory_kib, password_kdf_iterations, password_kdf_parallelism,
            recovery_wrapped_key, recovery_kdf_salt
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (user_id) DO UPDATE SET
            password_wrapped_key = EXCLUDED.password_wrapped_key,
            password_kdf_salt = EXCLUDED.password_kdf_salt,
            password_kdf_memory_kib = EXCLUDED.password_kdf_memory_kib,
            password_kdf_iterations = EXCLUDED.password_kdf_iterations,
            password_kdf_parallelism = EXCLUDED.password_kdf_parallelism,
            recovery_wrapped_key = EXCLUDED.recovery_wrapped_key,
            recovery_kdf_salt = EXCLUDED.recovery_kdf_salt,
            updated_at = NOW()"#,
    )
    .bind(user_id)
    .bind(&password_wrapped)
    .bind(&password_salt)
    .bind(data.password_kdf.memory_kib)
    .bind(data.password_kdf.iterations)
    .bind(data.password_kdf.parallelism)
    .bind(&recovery_wrapped)
    .bind(&recovery_salt)
    .execute(&mut *tx)
    .await?;

    let client = crate::routes::auth::client_info(&req);
    security_activity::record_in_transaction(
        &mut tx,
        user_id,
        SecurityActivityKind::EncryptionKeysPublished,
        client.user_agent.as_deref(),
        client.ip_address.as_deref(),
    )
    .await?;
    tx.commit().await?;

    log::info!("audit: encryption keys published user_id={user_id} generation={generation}");
    Ok(no_store(HttpResponse::Ok()).json(KeyStatusResponse {
        has_keys: true,
        key_fingerprint: Some(data.key_fingerprint),
        generation: Some(generation),
    }))
}

/// The caller's own encrypted backup, for restoring on a new device.
/// Re-seal the private key under a new password.
///
/// Called when the account password changes. Without it the stored copy still
/// opens under the *old* password, so the next device to restore would be
/// refused with the password its owner believes is correct, and only the
/// recovery code would work — a state that is recoverable but bewildering.
///
/// Only the password copy moves. The identity row is untouched, so the
/// generation counter does not advance and no peer is told to re-verify a
/// safety number that has not changed.
///
/// Refused when the account has no backup: there is nothing to re-seal, and
/// silently creating one from a request the server cannot inspect would store a
/// blob nothing can open.
async fn rewrap_key_backup(
    pool: web::Data<PgPool>,
    config: web::Data<Config>,
    req: HttpRequest,
    body: web::Json<RewrapBackupRequest>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    body.validate()?;
    let data = body.into_inner();
    data.password_kdf
        .validate_cost()
        .map_err(|error| AppError::BadRequest(describe(&error)))?;

    // Step up before destroying anything. This route replaces the only copy of
    // the identity a password can open, and validating the shape of a blob is
    // not evidence that it still holds the key — a stolen access token was the
    // entire authorisation, so it could sabotage restoration for an account it
    // had never held the identity for.
    //
    // The ordinary path no longer comes through here at all: re-sealing after a
    // password change now travels with the change itself, in one transaction.
    let user = sqlx::query_as::<_, crate::models::User>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool.get_ref())
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".to_string()))?;
    crate::services::auth::confirm_sensitive_action(
        pool.get_ref(),
        config.get_ref(),
        &user,
        &data.current_password,
        data.totp_code.as_deref(),
    )
    .await?;

    let wrapped = hex::decode(&data.password_wrapped_key)
        .map_err(|_| AppError::BadRequest("Invalid wrapped key encoding".to_string()))?;
    let salt = hex::decode(&data.password_kdf_salt)
        .map_err(|_| AppError::BadRequest("Invalid salt encoding".to_string()))?;

    let mut tx = pool.begin().await?;
    let updated = sqlx::query(
        r#"UPDATE user_key_backups SET
            password_wrapped_key = $2,
            password_kdf_salt = $3,
            password_kdf_memory_kib = $4,
            password_kdf_iterations = $5,
            password_kdf_parallelism = $6,
            updated_at = NOW()
        WHERE user_id = $1"#,
    )
    .bind(user_id)
    .bind(&wrapped)
    .bind(&salt)
    .bind(data.password_kdf.memory_kib)
    .bind(data.password_kdf.iterations)
    .bind(data.password_kdf.parallelism)
    .execute(&mut *tx)
    .await?;

    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound(
            "No key backup for this account".to_string(),
        ));
    }

    let client = crate::routes::auth::client_info(&req);
    security_activity::record_in_transaction(
        &mut tx,
        user_id,
        SecurityActivityKind::EncryptionBackupRewrapped,
        client.user_agent.as_deref(),
        client.ip_address.as_deref(),
    )
    .await?;
    tx.commit().await?;

    Ok(no_store(HttpResponse::NoContent()).finish())
}

async fn get_key_backup(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let row = sqlx::query_as::<
        _,
        (
            Vec<u8>,
            Vec<u8>,
            i32,
            i32,
            i32,
            Vec<u8>,
            Vec<u8>,
            chrono::DateTime<chrono::Utc>,
        ),
    >(
        r#"SELECT password_wrapped_key, password_kdf_salt,
                  password_kdf_memory_kib, password_kdf_iterations, password_kdf_parallelism,
                  recovery_wrapped_key, recovery_kdf_salt, updated_at
        FROM user_key_backups WHERE user_id = $1"#,
    )
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("No key backup for this account".to_string()))?;

    Ok(no_store(HttpResponse::Ok()).json(KeyBackupResponse {
        password_wrapped_key: hex::encode(row.0),
        password_kdf_salt: hex::encode(row.1),
        password_kdf: KdfParameters {
            memory_kib: row.2,
            iterations: row.3,
            parallelism: row.4,
        },
        recovery_wrapped_key: hex::encode(row.5),
        recovery_kdf_salt: hex::encode(row.6),
        updated_at: row.7,
    }))
}

/// A peer's public keys, so the caller can encrypt to them.
///
/// Deliberately not restricted to mutual followers, unlike messaging itself.
/// A public key is public by definition, and gating it would leak the follow
/// graph through a 403 while protecting nothing — the same key is handed to
/// anyone the moment a conversation becomes possible.
async fn peer_public_keys(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let viewer_id = require_auth(&req).await?;
    let username = path.into_inner();

    let row = sqlx::query_as::<
        _,
        (
            Uuid,
            String,
            Vec<u8>,
            Vec<u8>,
            String,
            i32,
            chrono::DateTime<chrono::Utc>,
        ),
    >(
        r#"SELECT users.id, users.username,
                  keys.exchange_public_key, keys.signing_public_key,
                  keys.key_fingerprint, keys.generation, keys.updated_at
        FROM users
        JOIN user_identity_keys keys ON keys.user_id = users.id
        WHERE LOWER(users.username) = LOWER($1)"#,
    )
    .bind(&username)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("No published keys for that user".to_string()))?;

    // A blocked peer is invisible everywhere else; the key directory must not
    // become the one place that confirms an account exists.
    if crate::services::community_safety::interaction_is_blocked(pool.get_ref(), viewer_id, row.0)
        .await?
    {
        return Err(AppError::NotFound(
            "No published keys for that user".to_string(),
        ));
    }

    Ok(no_store(HttpResponse::Ok()).json(PublicKeysResponse {
        user_id: row.0,
        username: row.1,
        exchange_public_key: hex::encode(row.2),
        signing_public_key: hex::encode(row.3),
        key_fingerprint: row.4,
        generation: row.5,
        updated_at: row.6,
    }))
}

fn describe(error: &validator::ValidationError) -> String {
    error
        .message
        .as_ref()
        .map_or_else(|| error.code.to_string(), std::string::ToString::to_string)
}

fn no_store(mut response: actix_web::HttpResponseBuilder) -> actix_web::HttpResponseBuilder {
    response
        .insert_header((actix_web::http::header::CACHE_CONTROL, "no-store"))
        .insert_header((actix_web::http::header::PRAGMA, "no-cache"));
    response
}
