use actix_web::{web, HttpRequest, HttpResponse};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;
use validator::Validate;

use crate::dto::common::PaginationParams;
use crate::dto::report::{CreateReportRequest, ReportResponse};
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::services::community_safety::MAX_REPORTS_PER_24_HOURS;
use crate::services::franking;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/reports")
            .route("", web::post().to(create_report))
            .route("/me", web::get().to(my_reports)),
    );
}

/// Resolve a reported direct message, verifying franking evidence when the
/// message is encrypted.
///
/// The two cases are genuinely different and the difference matters:
///
/// * a plaintext message is snapshotted by the server, exactly as before —
///   nothing to prove, because the server read it itself;
/// * an encrypted message cannot be read here at all, so the reporter supplies
///   the plaintext and the key that opens the sender's commitment to it.
///
/// Evidence that fails to verify does not silently become an unverified report.
/// It is refused, because an accepted-but-unverified report against an
/// encrypted message is indistinguishable from an accusation somebody typed —
/// which is precisely what franking exists to prevent.
async fn report_message_target(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    reporter_id: Uuid,
    data: &CreateReportRequest,
) -> Result<(Uuid, Value, Option<String>, Option<Vec<u8>>, Option<bool>), AppError> {
    let row = sqlx::query_as::<
        _,
        (
            Uuid,
            Option<String>,
            Option<Vec<u8>>,
            Option<Vec<u8>>,
            Uuid,
            Option<chrono::DateTime<chrono::Utc>>,
            chrono::DateTime<chrono::Utc>,
        ),
    >(
        r#"SELECT message.sender_id, message.body,
                  message.franking_commitment, message.franking_signature,
                  message.client_nonce, message.read_at, message.created_at
        FROM direct_messages message
        WHERE message.id = $1 AND message.recipient_id = $2"#,
    )
    .bind(data.target_id)
    .bind(reporter_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| AppError::NotFound("Report target not found".to_string()))?;

    let (sender_id, body, commitment, signature, client_nonce, read_at, created_at) = row;

    // Plaintext: unchanged behaviour, and no evidence is expected.
    let Some(commitment) = commitment else {
        return Ok((
            sender_id,
            serde_json::json!({
                "id": data.target_id,
                "sender_id": sender_id,
                "recipient_id": reporter_id,
                "body": body,
                "read_at": read_at,
                "created_at": created_at,
                "encrypted": false,
            }),
            None,
            None,
            None,
        ));
    };

    let (Some(plaintext), Some(key_hex)) = (&data.revealed_plaintext, &data.franking_key) else {
        return Err(AppError::BadRequest(
            "Reporting an encrypted message requires the message text and its franking key"
                .to_string(),
        ));
    };
    let franking_key = hex::decode(key_hex)
        .map_err(|_| AppError::BadRequest("Invalid franking key encoding".to_string()))?;

    let signing_key = sqlx::query_scalar::<_, Vec<u8>>(
        "SELECT signing_public_key FROM user_identity_keys WHERE user_id = $1",
    )
    .bind(sender_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| {
        // The sender encrypted a message, so their keys existed. If they are
        // gone the evidence cannot be checked, and an unverifiable report must
        // not be recorded as if it had been.
        AppError::BadRequest(
            "The sender's signing key is no longer published, so this report cannot be verified"
                .to_string(),
        )
    })?;

    let signature = signature.ok_or_else(|| {
        AppError::BadRequest("This message carries no sender signature".to_string())
    })?;

    // The nonce, not `data.target_id`: the sender signed before the row had an
    // id to sign over. See `franking::signing_payload`.
    if let Err(failure) = franking::verify(
        &commitment,
        &signature,
        &signing_key,
        client_nonce,
        plaintext,
        &franking_key,
    ) {
        // Logged with the specific reason, answered with a uniform one: a
        // reporter learns their evidence did not hold, not which half failed.
        log::warn!(
            "safety report franking verification failed reporter_id={reporter_id} \
             message_id={} reason={}",
            data.target_id,
            failure.as_str()
        );
        return Err(AppError::BadRequest(failure.public_message().to_string()));
    }

    Ok((
        sender_id,
        serde_json::json!({
            "id": data.target_id,
            "sender_id": sender_id,
            "recipient_id": reporter_id,
            "read_at": read_at,
            "created_at": created_at,
            "encrypted": true,
            // The moderator sees text the sender provably wrote, not text the
            // reporter typed.
            "verified_plaintext": plaintext,
        }),
        Some(plaintext.clone()),
        Some(franking_key),
        Some(true),
    ))
}

async fn create_report(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<CreateReportRequest>,
) -> Result<HttpResponse, AppError> {
    let reporter_id = require_auth(&req).await?;
    body.validate()?;
    let data = body.into_inner();
    // Borrowed rather than moved: the franking path below needs the rest of
    // `data`, and moving one field out would partially move the whole value.
    let details = data
        .details
        .as_ref()
        .map(|details| details.trim().to_string());

    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('report:' || $1::text, 0))")
        .bind(reporter_id)
        .execute(&mut *tx)
        .await?;

    let existing = sqlx::query_as::<_, ReportResponse>(
        r#"SELECT id, target_type, target_id, reason, details, status, created_at
        FROM user_reports
        WHERE reporter_id = $1
          AND target_type = $2
          AND target_id = $3
          AND status IN ('open', 'reviewing')"#,
    )
    .bind(reporter_id)
    .bind(&data.target_type)
    .bind(data.target_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(report) = existing {
        tx.commit().await?;
        return Ok(HttpResponse::Ok()
            .insert_header(("Cache-Control", "no-store"))
            .insert_header(("Pragma", "no-cache"))
            .json(report));
    }

    let recent_count = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*)
        FROM user_reports
        WHERE reporter_id = $1
          AND created_at >= NOW() - INTERVAL '24 hours'"#,
    )
    .bind(reporter_id)
    .fetch_one(&mut *tx)
    .await?;
    if recent_count >= MAX_REPORTS_PER_24_HOURS {
        return Err(AppError::TooManyRequests(
            "Too many reports submitted. Try again later.".to_string(),
        ));
    }

    // For encrypted messages the fourth element carries the verified evidence;
    // for everything else the server snapshots the content itself and there is
    // nothing to verify.
    let (subject_user_id, content_snapshot, revealed_plaintext, franking_key, franking_verified): (
        Uuid,
        Value,
        Option<String>,
        Option<Vec<u8>>,
        Option<bool>,
    ) = match data.target_type.as_str() {
        "user" => sqlx::query_as(
            r#"SELECT id, jsonb_build_object(
                    'id', id,
                    'username', username,
                    'avatar_url', avatar_url,
                    'bio', bio,
                    'is_public', is_public
                )
                FROM users
                WHERE id = $1"#,
        )
        .bind(data.target_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound("Report target not found".to_string()))
        .map(|(subject, snapshot): (Uuid, Value)| (subject, snapshot, None, None, None))?,
        "list" => sqlx::query_as(
            r#"SELECT list.user_id, jsonb_build_object(
                    'id', list.id,
                    'owner_id', owner.id,
                    'owner_username', owner.username,
                    'name', list.name,
                    'description', list.description,
                    'is_public', list.is_public
                )
                FROM lists list
                JOIN users owner ON owner.id = list.user_id
                WHERE list.id = $1 AND list.is_public"#,
        )
        .bind(data.target_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound("Report target not found".to_string()))
        .map(|(subject, snapshot): (Uuid, Value)| (subject, snapshot, None, None, None))?,
        "message" => report_message_target(&mut tx, reporter_id, &data).await?,
        _ => {
            return Err(AppError::BadRequest(
                "Report target must be user, list, or message".to_string(),
            ));
        }
    };

    if subject_user_id == reporter_id {
        return Err(AppError::BadRequest(
            "You cannot report your own content".to_string(),
        ));
    }

    let report = sqlx::query_as::<_, ReportResponse>(
        r#"INSERT INTO user_reports (
            reporter_id,
            subject_user_id,
            target_type,
            target_id,
            reason,
            details,
            content_snapshot,
            revealed_plaintext,
            franking_key,
            franking_verified
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, target_type, target_id, reason, details, status, created_at"#,
    )
    .bind(reporter_id)
    .bind(subject_user_id)
    .bind(&data.target_type)
    .bind(data.target_id)
    .bind(&data.reason)
    .bind(details)
    .bind(content_snapshot)
    .bind(revealed_plaintext.as_ref())
    .bind(franking_key.as_ref())
    .bind(franking_verified)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    crate::metrics::record_safety_report(&report.reason);
    log::warn!(
        "audit: safety report submitted report_id={} reporter_id={reporter_id} subject_user_id={subject_user_id} target_type={} reason={}",
        report.id,
        report.target_type,
        report.reason
    );
    Ok(HttpResponse::Created()
        .insert_header(("Cache-Control", "no-store"))
        .insert_header(("Pragma", "no-cache"))
        .json(report))
}

async fn my_reports(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    pagination: web::Query<PaginationParams>,
) -> Result<HttpResponse, AppError> {
    let reporter_id = require_auth(&req).await?;
    let reports = sqlx::query_as::<_, ReportResponse>(
        r#"SELECT id, target_type, target_id, reason, details, status, created_at
        FROM user_reports
        WHERE reporter_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2 OFFSET $3"#,
    )
    .bind(reporter_id)
    .bind(pagination.limit_val())
    .bind(pagination.offset())
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .insert_header(("Pragma", "no-cache"))
        .json(reports))
}
