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
    // nothing. A second one replaces the identity and the wrapped copy of the
    // private key below, after which no one, the owner included, can read a
    // single message that was encrypted to the old key. That is not something a
    // fifteen-minute access token should be able to do on its own.
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
    data.recovery_kdf
        .validate_cost()
        .map_err(|error| AppError::BadRequest(describe(&error)))?;

    // Decoded here rather than trusted as text: the database columns are BYTEA
    // with exact-length checks, and hex that passed validation cannot fail to
    // decode.
    let exchange = hex::decode(&data.exchange_public_key)
        .map_err(|_| AppError::BadRequest("Invalid exchange key encoding".to_string()))?;
    let signing = hex::decode(&data.signing_public_key)
        .map_err(|_| AppError::BadRequest("Invalid signing key encoding".to_string()))?;
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

    // One copy, wrapped under the recovery code. A publication also clears any
    // password copy the account still carried: it is replacing the identity, so
    // the old wrap opens nothing anyway, and leaving it would keep a blob this
    // server can open against keys nobody uses.
    sqlx::query(
        r#"INSERT INTO user_key_backups (
            user_id, recovery_wrapped_key, recovery_kdf_salt,
            recovery_kdf_memory_kib, recovery_kdf_iterations, recovery_kdf_parallelism
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (user_id) DO UPDATE SET
            recovery_wrapped_key = EXCLUDED.recovery_wrapped_key,
            recovery_kdf_salt = EXCLUDED.recovery_kdf_salt,
            recovery_kdf_memory_kib = EXCLUDED.recovery_kdf_memory_kib,
            recovery_kdf_iterations = EXCLUDED.recovery_kdf_iterations,
            recovery_kdf_parallelism = EXCLUDED.recovery_kdf_parallelism,
            password_wrapped_key = NULL,
            password_kdf_salt = NULL,
            password_kdf_memory_kib = NULL,
            password_kdf_iterations = NULL,
            password_kdf_parallelism = NULL,
            updated_at = NOW()"#,
    )
    .bind(user_id)
    .bind(&recovery_wrapped)
    .bind(&recovery_salt)
    .bind(data.recovery_kdf.memory_kib)
    .bind(data.recovery_kdf.iterations)
    .bind(data.recovery_kdf.parallelism)
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

/// Re-seal the private key under a new recovery code.
///
/// Two things at once, because they are one operation. It rotates a code whose
/// owner thinks somebody has seen it, and it completes the upgrade for an
/// account set up while the key was also sealed under the account password —
/// dropping that copy in the same statement, once its owner holds a code they
/// have saved.
///
/// The identity row is untouched, so the generation counter does not advance
/// and no peer is told to re-verify a safety number that has not changed.
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
    data.recovery_kdf
        .validate_cost()
        .map_err(|error| AppError::BadRequest(describe(&error)))?;

    // Step up before destroying anything. This route replaces the only copy of
    // the identity there is, and validating the shape of a blob is not evidence
    // that it still holds the key — a stolen access token was the entire
    // authorisation, so it could sabotage restoration for an account whose
    // identity it had never held.
    //
    // It is also the upgrade path: an account set up before the password copy
    // was removed keeps that copy until its owner has a recovery code they have
    // saved. Writing a new one here is that moment, so the password copy goes
    // in the same statement.
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

    let wrapped = hex::decode(&data.recovery_wrapped_key)
        .map_err(|_| AppError::BadRequest("Invalid wrapped key encoding".to_string()))?;
    let salt = hex::decode(&data.recovery_kdf_salt)
        .map_err(|_| AppError::BadRequest("Invalid salt encoding".to_string()))?;

    let mut tx = pool.begin().await?;
    let updated = sqlx::query(
        r#"UPDATE user_key_backups SET
            recovery_wrapped_key = $2,
            recovery_kdf_salt = $3,
            recovery_kdf_memory_kib = $4,
            recovery_kdf_iterations = $5,
            recovery_kdf_parallelism = $6,
            password_wrapped_key = NULL,
            password_kdf_salt = NULL,
            password_kdf_memory_kib = NULL,
            password_kdf_iterations = NULL,
            password_kdf_parallelism = NULL,
            updated_at = NOW()
        WHERE user_id = $1"#,
    )
    .bind(user_id)
    .bind(&wrapped)
    .bind(&salt)
    .bind(data.recovery_kdf.memory_kib)
    .bind(data.recovery_kdf.iterations)
    .bind(data.recovery_kdf.parallelism)
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

/// The caller's own encrypted backup, for restoring on a new device.
async fn get_key_backup(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let row = sqlx::query_as::<
        _,
        (
            // The password copy is nullable now: present only for accounts that
            // predate its removal and have not yet completed the upgrade.
            Option<Vec<u8>>,
            Option<Vec<u8>>,
            Option<i32>,
            Option<i32>,
            Option<i32>,
            Vec<u8>,
            Vec<u8>,
            i32,
            i32,
            i32,
            chrono::DateTime<chrono::Utc>,
        ),
    >(
        r#"SELECT password_wrapped_key, password_kdf_salt,
                  password_kdf_memory_kib, password_kdf_iterations, password_kdf_parallelism,
                  recovery_wrapped_key, recovery_kdf_salt,
                  recovery_kdf_memory_kib, recovery_kdf_iterations, recovery_kdf_parallelism,
                  updated_at
        FROM user_key_backups WHERE user_id = $1"#,
    )
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("No key backup for this account".to_string()))?;

    // The password copy is served only while it exists. An account set up since
    // it was removed has none, and one that has completed the upgrade has had
    // its cleared — in both cases the client offers the recovery code only.
    let password_copy = match (row.0, row.1, row.2, row.3, row.4) {
        (Some(wrapped), Some(salt), Some(memory_kib), Some(iterations), Some(parallelism)) => {
            Some((
                hex::encode(wrapped),
                hex::encode(salt),
                KdfParameters {
                    memory_kib,
                    iterations,
                    parallelism,
                },
            ))
        }
        _ => None,
    };

    Ok(no_store(HttpResponse::Ok()).json(KeyBackupResponse {
        password_wrapped_key: password_copy.as_ref().map(|copy| copy.0.clone()),
        password_kdf_salt: password_copy.as_ref().map(|copy| copy.1.clone()),
        password_kdf: password_copy.map(|copy| copy.2),
        recovery_wrapped_key: hex::encode(row.5),
        recovery_kdf_salt: hex::encode(row.6),
        recovery_kdf: KdfParameters {
            memory_kib: row.7,
            iterations: row.8,
            parallelism: row.9,
        },
        updated_at: row.10,
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
