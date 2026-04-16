use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;
use uuid::Uuid;

use crate::dto::tracking::*;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/history")
            .route("", web::get().to(list_history))
            .route("", web::post().to(create_history))
            .route("/{id}", web::delete().to(delete_history))
    );
}

async fn list_history(
    pool: web::Data<PgPool>,
    req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;

    let rows = sqlx::query_as::<_, (Uuid, Uuid, String, String, Option<String>, Option<Uuid>, Option<String>, chrono::DateTime<chrono::Utc>)>(
        r#"SELECT wh.id, wh.media_id, m.title, m.media_type, m.poster_path, wh.episode_id, e.name as episode_name, wh.watched_at
        FROM watch_history wh
        JOIN media m ON wh.media_id = m.id
        LEFT JOIN episodes e ON wh.episode_id = e.id
        WHERE wh.user_id = $1
        ORDER BY wh.watched_at DESC
        LIMIT 100"#
    )
    .bind(user_id)
    .fetch_all(pool.get_ref())
    .await?;

    let response: Vec<HistoryResponse> = rows.into_iter().map(|(id, media_id, media_title, media_type, poster_path, episode_id, episode_name, watched_at)| {
        HistoryResponse {
            id, media_id, media_title, media_type, poster_path, episode_id, episode_name, watched_at,
        }
    }).collect();

    Ok(HttpResponse::Ok().json(response))
}

async fn create_history(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<CreateHistoryRequest>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let data = body.into_inner();

    let watched_at = data.watched_at.unwrap_or_else(chrono::Utc::now);

    let history = sqlx::query_as::<_, crate::models::WatchHistory>(
        r#"INSERT INTO watch_history (user_id, media_id, episode_id, watched_at)
        VALUES ($1, $2, $3, $4)
        RETURNING *"#
    )
    .bind(user_id)
    .bind(data.media_id)
    .bind(data.episode_id)
    .bind(watched_at)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Created().json(history))
}

async fn delete_history(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<Uuid>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let history_id = path.into_inner();

    let result = sqlx::query("DELETE FROM watch_history WHERE id = $1 AND user_id = $2")
        .bind(history_id)
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("History entry not found".to_string()));
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({"message": "Deleted"})))
}
