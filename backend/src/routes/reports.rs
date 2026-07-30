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

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/reports")
            .route("", web::post().to(create_report))
            .route("/me", web::get().to(my_reports)),
    );
}

async fn create_report(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<CreateReportRequest>,
) -> Result<HttpResponse, AppError> {
    let reporter_id = require_auth(&req).await?;
    body.validate()?;
    let data = body.into_inner();
    let details = data.details.map(|details| details.trim().to_string());

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

    let (subject_user_id, content_snapshot): (Uuid, Value) = match data.target_type.as_str() {
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
        .ok_or_else(|| AppError::NotFound("Report target not found".to_string()))?,
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
        .ok_or_else(|| AppError::NotFound("Report target not found".to_string()))?,
        _ => {
            return Err(AppError::BadRequest(
                "Report target must be user or list".to_string(),
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
            content_snapshot
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, target_type, target_id, reason, details, status, created_at"#,
    )
    .bind(reporter_id)
    .bind(subject_user_id)
    .bind(&data.target_type)
    .bind(data.target_id)
    .bind(&data.reason)
    .bind(details)
    .bind(content_snapshot)
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
