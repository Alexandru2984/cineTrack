use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{NaiveDate, Utc};
use sqlx::{PgPool, Postgres, Transaction};
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
            .route("/{id}", web::delete().to(delete_tracking)),
    );
}

async fn list_tracking(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    query: web::Query<TrackingQueryParams>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    query.validate()?;
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

    let response: Vec<TrackingResponse> = rows
        .into_iter()
        .map(
            |(
                id,
                media_id,
                tmdb_id,
                media_type,
                title,
                poster_path,
                status,
                rating,
                review,
                is_favorite,
                started_at,
                completed_at,
            )| {
                TrackingResponse {
                    id,
                    media_id,
                    tmdb_id,
                    media_type,
                    title,
                    poster_path,
                    status,
                    rating,
                    review,
                    is_favorite,
                    started_at,
                    completed_at,
                }
            },
        )
        .collect();

    Ok(HttpResponse::Ok().json(response))
}

async fn create_tracking(
    pool: web::Data<PgPool>,
    tmdb: web::Data<TmdbService>,
    req: HttpRequest,
    body: web::Json<CreateTrackingRequest>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    body.validate()?;
    let data = body.into_inner();

    let media = tmdb
        .get_or_cache_media(pool.get_ref(), data.tmdb_id, &data.media_type)
        .await?;

    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))")
        .bind(user_id)
        .bind(media.id)
        .execute(&mut *tx)
        .await?;

    let previous_status = sqlx::query_scalar::<_, String>(
        "SELECT status FROM user_media WHERE user_id = $1 AND media_id = $2",
    )
    .bind(user_id)
    .bind(media.id)
    .fetch_optional(&mut *tx)
    .await?;

    let user_media = sqlx::query_as::<_, crate::models::UserMedia>(
        r#"INSERT INTO user_media (user_id, media_id, status, started_at, completed_at)
        VALUES ($1, $2, $3,
            CASE WHEN $3 IN ('watching', 'completed') THEN CURRENT_DATE END,
            CASE WHEN $3 = 'completed' THEN CURRENT_DATE END
        )
        ON CONFLICT (user_id, media_id) DO UPDATE SET status = $3, updated_at = NOW(),
            started_at = COALESCE(user_media.started_at, CASE WHEN $3 IN ('watching', 'completed') THEN CURRENT_DATE END),
            completed_at = CASE
                WHEN $3 = 'completed' THEN COALESCE(user_media.completed_at, CURRENT_DATE)
                ELSE NULL
            END
        RETURNING *"#
    )
    .bind(user_id)
    .bind(media.id)
    .bind(&data.status)
    .fetch_one(&mut *tx)
    .await?;

    if data.status == "completed" && previous_status.as_deref() != Some("completed") {
        record_completion_history(&mut tx, user_id, media.id, &media.media_type).await?;
    }
    tx.commit().await?;

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

    let today = Utc::now().date_naive();
    validate_supplied_dates(data.started_at, data.completed_at, today)?;

    let mut tx = pool.begin().await?;
    let current = sqlx::query_as::<_, crate::models::UserMedia>(
        "SELECT * FROM user_media WHERE id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(tracking_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound("Tracking entry not found".to_string()))?;

    let effective_status = data
        .status
        .as_deref()
        .unwrap_or(&current.status)
        .to_string();
    if data.completed_at.is_some() && effective_status != "completed" {
        return Err(AppError::BadRequest(
            "completed_at requires completed status".to_string(),
        ));
    }

    let effective_started_at = data
        .started_at
        .or(current.started_at)
        .or_else(|| matches!(effective_status.as_str(), "watching" | "completed").then_some(today));
    let effective_completed_at = (effective_status == "completed")
        .then(|| data.completed_at.or(current.completed_at).unwrap_or(today));

    if let (Some(started_at), Some(completed_at)) = (effective_started_at, effective_completed_at) {
        if completed_at < started_at {
            return Err(AppError::BadRequest(
                "completed_at cannot be before started_at".to_string(),
            ));
        }
    }

    let entering_completed = current.status != "completed" && effective_status == "completed";
    let updated = sqlx::query_as::<_, crate::models::UserMedia>(
        r#"UPDATE user_media SET
            status = $3,
            rating = COALESCE($4, rating),
            review = COALESCE($5, review),
            is_favorite = COALESCE($6, is_favorite),
            started_at = $7,
            completed_at = $8,
            updated_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING *"#,
    )
    .bind(tracking_id)
    .bind(user_id)
    .bind(&effective_status)
    .bind(data.rating)
    .bind(&data.review)
    .bind(data.is_favorite)
    .bind(effective_started_at)
    .bind(effective_completed_at)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound("Tracking entry not found".to_string()))?;

    let media = sqlx::query_as::<_, crate::models::Media>("SELECT * FROM media WHERE id = $1")
        .bind(updated.media_id)
        .fetch_one(&mut *tx)
        .await?;

    if entering_completed {
        record_completion_history(&mut tx, user_id, media.id, &media.media_type).await?;
    }
    tx.commit().await?;

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

fn validate_supplied_dates(
    started_at: Option<NaiveDate>,
    completed_at: Option<NaiveDate>,
    today: NaiveDate,
) -> Result<(), AppError> {
    if started_at.is_some_and(|date| date > today) || completed_at.is_some_and(|date| date > today)
    {
        return Err(AppError::BadRequest(
            "Tracking dates cannot be in the future".to_string(),
        ));
    }
    Ok(())
}

async fn record_completion_history(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    media_id: Uuid,
    media_type: &str,
) -> Result<(), AppError> {
    if media_type == "movie" {
        sqlx::query(
            r#"INSERT INTO watch_history (user_id, media_id, watched_at)
            SELECT $1, $2, NOW()
            WHERE NOT EXISTS (
                SELECT 1 FROM watch_history
                WHERE user_id = $1 AND media_id = $2 AND episode_id IS NULL
            )"#,
        )
        .bind(user_id)
        .bind(media_id)
        .execute(&mut **tx)
        .await?;
        return Ok(());
    }

    let inserted = sqlx::query(
        r#"INSERT INTO watch_history (user_id, media_id, episode_id, watched_at)
        SELECT $1, $2, e.id, NOW()
        FROM episodes e
        JOIN seasons s ON e.season_id = s.id
        WHERE s.media_id = $2 AND s.season_number > 0
        AND NOT EXISTS (
            SELECT 1 FROM watch_history wh
            WHERE wh.user_id = $1 AND wh.media_id = $2 AND wh.episode_id = e.id
        )"#,
    )
    .bind(user_id)
    .bind(media_id)
    .execute(&mut **tx)
    .await?
    .rows_affected();

    if inserted == 0 {
        sqlx::query(
            r#"INSERT INTO watch_history (user_id, media_id, watched_at)
            SELECT $1, $2, NOW()
            WHERE NOT EXISTS (
                SELECT 1 FROM watch_history
                WHERE user_id = $1 AND media_id = $2
            )"#,
        )
        .bind(user_id)
        .bind(media_id)
        .execute(&mut **tx)
        .await?;
    }

    Ok(())
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
