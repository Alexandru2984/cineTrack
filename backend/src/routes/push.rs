use actix_governor::governor::middleware::NoOpMiddleware;
use actix_governor::{Governor, GovernorConfig, GovernorConfigBuilder};
use actix_web::{web, HttpRequest, HttpResponse};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use validator::Validate;

use crate::dto::push::{RegisterPushDeviceRequest, RevokePushDeviceRequest};
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::middleware::rate_limit::TrustedProxyIpKeyExtractor;

const MAX_PUSH_DEVICES_PER_USER: i64 = 10;

pub type PushGovernorConfig = GovernorConfig<TrustedProxyIpKeyExtractor, NoOpMiddleware>;

pub fn build_rate_limiter() -> PushGovernorConfig {
    GovernorConfigBuilder::default()
        .requests_per_second(2)
        .burst_size(10)
        .key_extractor(TrustedProxyIpKeyExtractor)
        .finish()
        .expect("Failed to build push device rate limiter")
}

fn scope() -> actix_web::Scope {
    web::scope("/push")
        .route("/devices", web::put().to(register_device))
        .route("/devices/revoke", web::post().to(revoke_device))
}

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(scope());
}

pub fn configure_rate_limited(cfg: &mut web::ServiceConfig, rate_limiter: &PushGovernorConfig) {
    cfg.service(scope().wrap(Governor::new(rate_limiter)));
}

fn hash_unregister_secret(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}

async fn register_device(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<RegisterPushDeviceRequest>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    body.validate()?;
    let data = body.into_inner();
    let unregister_secret_hash = hash_unregister_secret(&data.unregister_secret);
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE")
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;

    // Serialize ownership changes for this opaque token even when no row exists yet.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(&data.expo_push_token)
        .execute(&mut *tx)
        .await?;

    let existing = sqlx::query_as::<_, (uuid::Uuid, String)>(
        "SELECT user_id, unregister_secret_hash
         FROM push_devices WHERE expo_push_token = $1 FOR UPDATE",
    )
    .bind(&data.expo_push_token)
    .fetch_optional(&mut *tx)
    .await?;
    let same_installation = existing.as_ref().is_some_and(|(owner_id, secret_hash)| {
        *owner_id == user_id && secret_hash == &unregister_secret_hash
    });

    if same_installation {
        sqlx::query(
            "UPDATE push_devices SET
                platform = $2, app_version = $3, utc_offset_minutes = $4,
                last_seen_at = NOW(), updated_at = NOW()
             WHERE expo_push_token = $1",
        )
        .bind(&data.expo_push_token)
        .bind(data.platform.as_str())
        .bind(&data.app_version)
        .bind(data.utc_offset_minutes)
        .execute(&mut *tx)
        .await?;
    } else {
        if existing.is_some() {
            // A new account or installation must never inherit the old outbox.
            sqlx::query("DELETE FROM push_devices WHERE expo_push_token = $1")
                .bind(&data.expo_push_token)
                .execute(&mut *tx)
                .await?;
        }
        let device_count =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM push_devices WHERE user_id = $1")
                .bind(user_id)
                .fetch_one(&mut *tx)
                .await?;
        if device_count >= MAX_PUSH_DEVICES_PER_USER {
            return Err(AppError::Conflict(
                "Push notification device limit reached".to_string(),
            ));
        }
        sqlx::query(
            "INSERT INTO push_devices
                (user_id, expo_push_token, unregister_secret_hash, platform,
                 app_version, utc_offset_minutes)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(user_id)
        .bind(&data.expo_push_token)
        .bind(unregister_secret_hash)
        .bind(data.platform.as_str())
        .bind(&data.app_version)
        .bind(data.utc_offset_minutes)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "enabled": true })))
}

async fn revoke_device(
    pool: web::Data<PgPool>,
    body: web::Json<RevokePushDeviceRequest>,
) -> Result<HttpResponse, AppError> {
    body.validate()?;
    let data = body.into_inner();
    sqlx::query(
        "DELETE FROM push_devices
         WHERE expo_push_token = $1 AND unregister_secret_hash = $2",
    )
    .bind(&data.expo_push_token)
    .bind(hash_unregister_secret(&data.unregister_secret))
    .execute(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "enabled": false })))
}
