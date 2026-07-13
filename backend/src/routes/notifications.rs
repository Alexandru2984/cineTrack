use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;
use validator::Validate;

use crate::dto::notification::{NotificationItem, NotificationListResponse, NotificationQuery};
use crate::errors::AppError;
use crate::middleware::auth::require_auth;

#[derive(sqlx::FromRow)]
struct NotificationRow {
    id: Uuid,
    kind: String,
    actor_id: Uuid,
    actor_username: String,
    actor_avatar_url: Option<String>,
    read_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

impl From<NotificationRow> for NotificationItem {
    fn from(row: NotificationRow) -> Self {
        Self {
            id: row.id,
            kind: row.kind,
            actor_id: row.actor_id,
            actor_username: row.actor_username,
            actor_avatar_url: row.actor_avatar_url,
            read_at: row.read_at,
            created_at: row.created_at,
        }
    }
}

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/notifications")
            .route("", web::get().to(list_notifications))
            .route("/read-all", web::post().to(mark_all_read))
            .route("/{id}/read", web::post().to(mark_read)),
    );
}

async fn list_notifications(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<NotificationQuery>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    query.validate()?;
    let cursor = query.cursor()?;
    let (before, before_id) = cursor.unzip();
    let limit = query.limit_val();

    let unread_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL",
    )
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await?;

    let mut rows = sqlx::query_as::<_, NotificationRow>(
        r#"SELECT notification.id, notification.kind,
            actor.id AS actor_id, actor.username AS actor_username,
            CASE
                WHEN actor.is_public OR visibility.status = 'accepted'
                THEN actor.avatar_url
                ELSE NULL
            END AS actor_avatar_url,
            notification.read_at, notification.created_at
        FROM notifications notification
        JOIN users actor ON actor.id = notification.actor_id
        LEFT JOIN follows visibility
            ON visibility.follower_id = $1
            AND visibility.following_id = actor.id
            AND visibility.status = 'accepted'
        WHERE notification.user_id = $1
          AND (
            $2::timestamptz IS NULL
            OR (notification.created_at, notification.id) < ($2::timestamptz, $3::uuid)
          )
        ORDER BY notification.created_at DESC, notification.id DESC
        LIMIT $4"#,
    )
    .bind(user_id)
    .bind(before)
    .bind(before_id)
    .bind(limit + 1)
    .fetch_all(pool.get_ref())
    .await?;

    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    Ok(HttpResponse::Ok().json(NotificationListResponse {
        items: rows.into_iter().map(Into::into).collect(),
        unread_count,
        has_more,
    }))
}

async fn mark_read(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<Uuid>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let notification_id = path.into_inner();
    let updated = sqlx::query_scalar::<_, Uuid>(
        "UPDATE notifications SET read_at = COALESCE(read_at, NOW())
         WHERE id = $1 AND user_id = $2 RETURNING id",
    )
    .bind(notification_id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;

    if updated.is_none() {
        return Err(AppError::NotFound("Notification not found".to_string()));
    }
    Ok(HttpResponse::Ok().json(serde_json::json!({"message": "Notification marked as read"})))
}

async fn mark_all_read(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let updated = sqlx::query(
        "UPDATE notifications SET read_at = NOW()
         WHERE user_id = $1 AND read_at IS NULL",
    )
    .bind(user_id)
    .execute(pool.get_ref())
    .await?
    .rows_affected();

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "message": "Notifications marked as read",
        "updated": updated,
    })))
}
