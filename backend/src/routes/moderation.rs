use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;
use validator::Validate;

use crate::dto::report::{
    ModerationQueueParams, ModerationQueueResponse, ModerationReportResponse,
    ModerationStatusCounts, ModeratorStatusResponse, UpdateReportStatusRequest,
};
use crate::errors::AppError;
use crate::middleware::auth::require_auth;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/moderation")
            .route("/me", web::get().to(moderator_status))
            .route("/reports", web::get().to(list_reports))
            .route("/reports/{id}", web::patch().to(update_report_status)),
    );
}

async fn moderator_is_eligible(
    executor: impl sqlx::Executor<'_, Database = Postgres>,
    user_id: Uuid,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT EXISTS (
            SELECT 1
            FROM moderators moderator
            JOIN users account ON account.id = moderator.user_id
            WHERE moderator.user_id = $1
              AND account.email_verified
              AND account.totp_enabled
        )"#,
    )
    .bind(user_id)
    .fetch_one(executor)
    .await
}

async fn require_moderator(
    executor: impl sqlx::Executor<'_, Database = Postgres>,
    user_id: Uuid,
) -> Result<(), AppError> {
    if moderator_is_eligible(executor, user_id).await? {
        Ok(())
    } else {
        Err(AppError::Forbidden("Moderator access required".to_string()))
    }
}

fn no_store(mut response: actix_web::HttpResponseBuilder) -> actix_web::HttpResponseBuilder {
    response
        .insert_header(("Cache-Control", "no-store"))
        .insert_header(("Pragma", "no-cache"));
    response
}

async fn moderator_status(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let is_moderator = moderator_is_eligible(pool.get_ref(), user_id).await?;
    Ok(no_store(HttpResponse::Ok()).json(ModeratorStatusResponse { is_moderator }))
}

async fn list_reports(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<ModerationQueueParams>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    require_moderator(pool.get_ref(), user_id).await?;
    query.validate()?;

    let status = query.status_val();
    let limit = query.limit_val();
    let mut items = sqlx::query_as::<_, ModerationReportResponse>(
        r#"SELECT
            report.id,
            report.reporter_id,
            reporter.username AS reporter_username,
            report.subject_user_id,
            subject.username AS subject_username,
            report.target_type,
            report.target_id,
            report.reason,
            report.details,
            report.content_snapshot,
            report.status,
            report.moderated_by,
            moderator.username AS moderator_username,
            report.moderator_note,
            report.resolved_at,
            report.created_at,
            report.updated_at
        FROM user_reports report
        LEFT JOIN users reporter ON reporter.id = report.reporter_id
        LEFT JOIN users subject ON subject.id = report.subject_user_id
        LEFT JOIN users moderator ON moderator.id = report.moderated_by
        WHERE
            ($1 = 'all')
            OR ($1 = 'active' AND report.status IN ('open', 'reviewing'))
            OR report.status = $1
        ORDER BY
            CASE report.reason
                WHEN 'child_safety' THEN 0
                WHEN 'threatening' THEN 1
                ELSE 2
            END,
            CASE report.status WHEN 'open' THEN 0 ELSE 1 END,
            report.created_at,
            report.id
        LIMIT $2 OFFSET $3"#,
    )
    .bind(status)
    .bind(limit + 1)
    .bind(query.offset())
    .fetch_all(pool.get_ref())
    .await?;
    let has_more = items.len() > limit as usize;
    items.truncate(limit as usize);

    let counts = sqlx::query_as::<_, ModerationStatusCounts>(
        r#"SELECT
            COUNT(*) FILTER (WHERE status = 'open')::BIGINT AS open,
            COUNT(*) FILTER (WHERE status = 'reviewing')::BIGINT AS reviewing,
            COUNT(*) FILTER (WHERE status = 'actioned')::BIGINT AS actioned,
            COUNT(*) FILTER (WHERE status = 'dismissed')::BIGINT AS dismissed
        FROM user_reports"#,
    )
    .fetch_one(pool.get_ref())
    .await?;

    log::info!(
        "audit: moderation queue accessed actor_id={user_id} status={status} page={} returned={}",
        query.page_val(),
        items.len()
    );
    Ok(no_store(HttpResponse::Ok()).json(ModerationQueueResponse {
        items,
        counts,
        page: query.page_val(),
        has_more,
    }))
}

fn transition_allowed(old_status: &str, new_status: &str) -> bool {
    matches!(
        (old_status, new_status),
        ("open", "reviewing" | "actioned" | "dismissed")
            | ("reviewing", "open" | "actioned" | "dismissed")
    )
}

async fn lock_report(
    tx: &mut Transaction<'_, Postgres>,
    report_id: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT status FROM user_reports WHERE id = $1 FOR UPDATE")
        .bind(report_id)
        .fetch_optional(&mut **tx)
        .await
}

async fn update_report_status(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<Uuid>,
    body: web::Json<UpdateReportStatusRequest>,
) -> Result<HttpResponse, AppError> {
    let actor_id = require_auth(&req).await?;
    body.validate()?;
    let report_id = path.into_inner();
    let data = body.into_inner();
    let note = data.note.trim().to_string();

    let mut tx = pool.begin().await?;
    require_moderator(&mut *tx, actor_id).await?;
    let old_status = lock_report(&mut tx, report_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Report not found".to_string()))?;
    if !transition_allowed(&old_status, &data.status) {
        return Err(AppError::Conflict(format!(
            "Report cannot move from {old_status} to {}",
            data.status
        )));
    }

    let report = sqlx::query_as::<_, ModerationReportResponse>(
        r#"WITH changed AS (
            UPDATE user_reports
            SET
                status = $2,
                moderated_by = $3,
                moderator_note = $4,
                resolved_at = CASE
                    WHEN $2 IN ('actioned', 'dismissed') THEN NOW()
                    ELSE NULL
                END,
                updated_at = NOW()
            WHERE id = $1
            RETURNING *
        )
        SELECT
            changed.id,
            changed.reporter_id,
            reporter.username AS reporter_username,
            changed.subject_user_id,
            subject.username AS subject_username,
            changed.target_type,
            changed.target_id,
            changed.reason,
            changed.details,
            changed.content_snapshot,
            changed.status,
            changed.moderated_by,
            moderator.username AS moderator_username,
            changed.moderator_note,
            changed.resolved_at,
            changed.created_at,
            changed.updated_at
        FROM changed
        LEFT JOIN users reporter ON reporter.id = changed.reporter_id
        LEFT JOIN users subject ON subject.id = changed.subject_user_id
        LEFT JOIN users moderator ON moderator.id = changed.moderated_by"#,
    )
    .bind(report_id)
    .bind(&data.status)
    .bind(actor_id)
    .bind(&note)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        r#"INSERT INTO moderation_audit_log (
            report_id, actor_id, old_status, new_status, note
        )
        VALUES ($1, $2, $3, $4, $5)"#,
    )
    .bind(report_id)
    .bind(actor_id)
    .bind(&old_status)
    .bind(&data.status)
    .bind(&note)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    crate::metrics::record_moderation_action(&data.status);
    if let Err(error) = crate::metrics::refresh_moderation_queue(pool.get_ref()).await {
        log::error!("Failed to refresh moderation queue metrics after status change: {error}");
    }
    log::warn!(
        "audit: moderation report status changed report_id={report_id} actor_id={actor_id} old_status={old_status} new_status={}",
        data.status
    );

    Ok(no_store(HttpResponse::Ok()).json(report))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn final_reports_cannot_be_reopened_or_rewritten() {
        assert!(transition_allowed("open", "reviewing"));
        assert!(transition_allowed("reviewing", "open"));
        assert!(transition_allowed("open", "actioned"));
        assert!(!transition_allowed("actioned", "reviewing"));
        assert!(!transition_allowed("dismissed", "open"));
        assert!(!transition_allowed("open", "open"));
    }
}
