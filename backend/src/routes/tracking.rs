use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;
use uuid::Uuid;
use validator::Validate;

use crate::dto::tracking::*;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::services::tmdb::TmdbService;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/tracking")
            .route("", web::get().to(list_tracking))
            .route("", web::post().to(create_tracking))
            .route("/{id}", web::patch().to(update_tracking))
            .route("/{id}", web::delete().to(delete_tracking))
    );
}

async fn list_tracking(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<TrackingQueryParams>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let params = query.into_inner();
    let limit = params.limit.unwrap_or(50).min(100) as i64;
    let offset = ((params.page.unwrap_or(1).max(1) - 1) as i64) * limit;

    let rows = if let Some(status) = params.status {
        sqlx::query_as::<_, (Uuid, Uuid, i32, String, String, Option<String>, String, Option<i16>, Option<String>, bool, Option<chrono::NaiveDate>, Option<chrono::NaiveDate>)>(
            r#"SELECT um.id, um.media_id, m.tmdb_id, m.media_type, m.title, m.poster_path, um.status, um.rating, um.review, um.is_favorite, um.started_at, um.completed_at
            FROM user_media um JOIN media m ON um.media_id = m.id
            WHERE um.user_id = $1 AND um.status = $2
            ORDER BY um.updated_at DESC
            LIMIT $3 OFFSET $4"#
        )
        .bind(user_id)
        .bind(status)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool.get_ref())
        .await?
    } else {
        sqlx::query_as::<_, (Uuid, Uuid, i32, String, String, Option<String>, String, Option<i16>, Option<String>, bool, Option<chrono::NaiveDate>, Option<chrono::NaiveDate>)>(
            r#"SELECT um.id, um.media_id, m.tmdb_id, m.media_type, m.title, m.poster_path, um.status, um.rating, um.review, um.is_favorite, um.started_at, um.completed_at
            FROM user_media um JOIN media m ON um.media_id = m.id
            WHERE um.user_id = $1
            ORDER BY um.updated_at DESC
            LIMIT $2 OFFSET $3"#
        )
        .bind(user_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool.get_ref())
        .await?
    };

    let response: Vec<TrackingResponse> = rows.into_iter().map(|(id, media_id, tmdb_id, media_type, title, poster_path, status, rating, review, is_favorite, started_at, completed_at)| {
        TrackingResponse {
            id, media_id, tmdb_id, media_type, title, poster_path, status, rating, review, is_favorite, started_at, completed_at,
        }
    }).collect();

    Ok(HttpResponse::Ok().json(response))
}

async fn create_tracking(
    pool: web::Data<PgPool>,
    tmdb: web::Data<TmdbService>,
    req: HttpRequest,
    body: web::Json<CreateTrackingRequest>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let data = body.into_inner();

    // Validate status
    let valid_statuses = ["watching", "completed", "plan_to_watch", "dropped", "on_hold"];
    if !valid_statuses.contains(&data.status.as_str()) {
        return Err(AppError::BadRequest(format!("Invalid status. Must be one of: {}", valid_statuses.join(", "))));
    }

    // Ensure media exists in cache
    let media = tmdb.get_or_cache_media(pool.get_ref(), data.tmdb_id, &data.media_type).await?;

    // Create tracking entry
    let user_media = sqlx::query_as::<_, crate::models::UserMedia>(
        r#"INSERT INTO user_media (user_id, media_id, status, started_at, completed_at)
        VALUES ($1, $2, $3,
            CASE WHEN $3 IN ('watching', 'completed') THEN CURRENT_DATE END,
            CASE WHEN $3 = 'completed' THEN CURRENT_DATE END
        )
        ON CONFLICT (user_id, media_id) DO UPDATE SET status = $3, updated_at = NOW(),
            started_at = COALESCE(user_media.started_at, CASE WHEN $3 IN ('watching', 'completed') THEN CURRENT_DATE END),
            completed_at = CASE WHEN $3 = 'completed' THEN CURRENT_DATE ELSE user_media.completed_at END
        RETURNING *"#
    )
    .bind(user_id)
    .bind(media.id)
    .bind(&data.status)
    .fetch_one(pool.get_ref())
    .await?;

    // Auto-create watch_history entry for tracking activity (for heatmap)
    let _ = sqlx::query(
        r#"INSERT INTO watch_history (user_id, media_id, watched_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT DO NOTHING"#
    )
    .bind(user_id)
    .bind(media.id)
    .execute(pool.get_ref())
    .await;

    // If completed TV show, also mark all cached episodes as watched
    if data.status == "completed" && media.media_type == "tv" {
        let _ = sqlx::query(
            r#"INSERT INTO watch_history (user_id, media_id, episode_id, watched_at)
            SELECT $1, $2, e.id, NOW()
            FROM episodes e
            JOIN seasons s ON e.season_id = s.id
            WHERE s.media_id = $2
            ON CONFLICT DO NOTHING"#
        )
        .bind(user_id)
        .bind(media.id)
        .execute(pool.get_ref())
        .await;
    }

    Ok(HttpResponse::Created().json(TrackingResponse {
        id: user_media.id,
        media_id: media.id,
        tmdb_id: media.tmdb_id,
        media_type: media.media_type,
        title: media.title,
        poster_path: media.poster_path,
        status: user_media.status,
        rating: user_media.rating,
        review: user_media.review,
        is_favorite: user_media.is_favorite,
        started_at: user_media.started_at,
        completed_at: user_media.completed_at,
    }))
}

async fn update_tracking(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<Uuid>,
    body: web::Json<UpdateTrackingRequest>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let tracking_id = path.into_inner();
    body.validate()?;
    let data = body.into_inner();

    if let Some(ref status) = data.status {
        let valid_statuses = ["watching", "completed", "plan_to_watch", "dropped", "on_hold"];
        if !valid_statuses.contains(&status.as_str()) {
            return Err(AppError::BadRequest("Invalid status".to_string()));
        }
    }

    if let Some(rating) = data.rating {
        if !(1..=10).contains(&rating) {
            return Err(AppError::BadRequest("Rating must be between 1 and 10".to_string()));
        }
    }

    let updated = sqlx::query_as::<_, crate::models::UserMedia>(
        r#"UPDATE user_media SET
            status = COALESCE($3, status),
            rating = COALESCE($4, rating),
            review = COALESCE($5, review),
            is_favorite = COALESCE($6, is_favorite),
            started_at = COALESCE($7, started_at),
            completed_at = COALESCE($8, completed_at),
            updated_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING *"#
    )
    .bind(tracking_id)
    .bind(user_id)
    .bind(&data.status)
    .bind(data.rating)
    .bind(&data.review)
    .bind(data.is_favorite)
    .bind(data.started_at)
    .bind(data.completed_at)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("Tracking entry not found".to_string()))?;

    let media = sqlx::query_as::<_, crate::models::Media>(
        "SELECT * FROM media WHERE id = $1"
    )
    .bind(updated.media_id)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(TrackingResponse {
        id: updated.id,
        media_id: media.id,
        tmdb_id: media.tmdb_id,
        media_type: media.media_type,
        title: media.title,
        poster_path: media.poster_path,
        status: updated.status,
        rating: updated.rating,
        review: updated.review,
        is_favorite: updated.is_favorite,
        started_at: updated.started_at,
        completed_at: updated.completed_at,
    }))
}

async fn delete_tracking(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    path: web::Path<Uuid>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    let tracking_id = path.into_inner();

    let result = sqlx::query("DELETE FROM user_media WHERE id = $1 AND user_id = $2")
        .bind(tracking_id)
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Tracking entry not found".to_string()));
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({"message": "Deleted successfully"})))
}
