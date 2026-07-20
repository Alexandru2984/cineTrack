use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{NaiveDate, Utc};
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::HashSet;
use uuid::Uuid;
use validator::Validate;

use crate::dto::tracking::*;
use crate::errors::AppError;
use crate::middleware::auth::require_auth;
use crate::services::quota;
use crate::services::tmdb::TmdbService;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/tracking")
            .route("", web::get().to(list_tracking))
            .route("", web::post().to(create_tracking))
            .route("/lookup", web::post().to(lookup_tracking))
            .route("/{id}", web::patch().to(update_tracking))
            .route("/{id}", web::delete().to(delete_tracking)),
    );
}

type TrackingRow = (
    Uuid,
    Uuid,
    i32,
    String,
    String,
    Option<String>,
    String,
    Option<i16>,
    Option<String>,
    bool,
    Option<NaiveDate>,
    Option<NaiveDate>,
);

fn tracking_response(
    (
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
    ): TrackingRow,
) -> TrackingResponse {
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
        sqlx::query_as::<_, TrackingRow>(
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
        sqlx::query_as::<_, TrackingRow>(
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

    let response: Vec<TrackingResponse> = rows.into_iter().map(tracking_response).collect();

    Ok(HttpResponse::Ok().json(response))
}

async fn lookup_tracking(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    body: web::Json<TrackingLookupRequest>,
) -> Result<HttpResponse, AppError> {
    let user_id = require_auth(&req).await?;
    body.validate()?;
    for item in &body.items {
        item.validate()?;
    }

    let mut seen = HashSet::with_capacity(body.items.len());
    let mut tmdb_ids = Vec::with_capacity(body.items.len());
    let mut media_types = Vec::with_capacity(body.items.len());
    for item in &body.items {
        if seen.insert((item.tmdb_id, item.media_type.as_str())) {
            tmdb_ids.push(item.tmdb_id);
            media_types.push(item.media_type.clone());
        }
    }

    let rows = sqlx::query_as::<_, TrackingRow>(
        r#"WITH requested AS (
            SELECT *
            FROM UNNEST($2::integer[], $3::text[]) AS item(tmdb_id, media_type)
        )
        SELECT um.id, um.media_id, m.tmdb_id, m.media_type, m.title, m.poster_path,
               um.status, um.rating, um.review, um.is_favorite, um.started_at, um.completed_at
        FROM requested item
        JOIN media m ON m.tmdb_id = item.tmdb_id AND m.media_type = item.media_type
        JOIN user_media um ON um.media_id = m.id AND um.user_id = $1"#,
    )
    .bind(user_id)
    .bind(&tmdb_ids)
    .bind(&media_types)
    .fetch_all(pool.get_ref())
    .await?;

    let response: Vec<TrackingResponse> = rows.into_iter().map(tracking_response).collect();
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

    // Reject obviously full libraries before an upstream lookup can populate
    // the shared TMDB cache. The transaction below repeats this atomically.
    let (tracking_count, already_tracked) = sqlx::query_as::<_, (i64, bool)>(
        r#"SELECT
            (SELECT COUNT(*) FROM user_media WHERE user_id = $1),
            EXISTS(
                SELECT 1
                FROM user_media um
                JOIN media m ON m.id = um.media_id
                WHERE um.user_id = $1 AND m.tmdb_id = $2 AND m.media_type = $3
            )"#,
    )
    .bind(user_id)
    .bind(data.tmdb_id)
    .bind(&data.media_type)
    .fetch_one(pool.get_ref())
    .await?;
    quota::ensure_tracking_capacity(tracking_count, if already_tracked { 0 } else { 1 })?;

    let media = tmdb
        .get_or_cache_media(pool.get_ref(), data.tmdb_id, &data.media_type)
        .await?;

    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))")
        .bind(user_id)
        .bind(media.id)
        .execute(&mut *tx)
        .await?;

    let tracking_count = quota::lock_and_count_tracking(&mut tx, user_id).await?;
    let previous_status = sqlx::query_scalar::<_, String>(
        "SELECT status FROM user_media WHERE user_id = $1 AND media_id = $2",
    )
    .bind(user_id)
    .bind(media.id)
    .fetch_optional(&mut *tx)
    .await?;
    quota::ensure_tracking_capacity(
        tracking_count,
        if previous_status.is_some() { 0 } else { 1 },
    )?;

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
    // All tracking mutations use the same first lock. In particular, this
    // keeps row locks and history quota locks ordered consistently with imports.
    quota::lock_tracking_writes(&mut tx, user_id).await?;
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
    let rating_supplied = data.rating.is_some();
    let rating = data.rating.flatten();
    let review_supplied = data.review.is_some();
    let review = data.review.flatten();
    let updated = sqlx::query_as::<_, crate::models::UserMedia>(
        r#"UPDATE user_media SET
            status = $3,
            rating = CASE WHEN $4 THEN $5 ELSE rating END,
            review = CASE WHEN $6 THEN $7 ELSE review END,
            is_favorite = COALESCE($8, is_favorite),
            started_at = $9,
            completed_at = $10,
            updated_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING *"#,
    )
    .bind(tracking_id)
    .bind(user_id)
    .bind(&effective_status)
    .bind(rating_supplied)
    .bind(rating)
    .bind(review_supplied)
    .bind(&review)
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
    let history_count = quota::lock_and_count_history(tx, user_id).await?;

    if media_type == "movie" {
        let already_recorded = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(
                SELECT 1 FROM watch_history
                WHERE user_id = $1 AND media_id = $2 AND episode_id IS NULL
            )",
        )
        .bind(user_id)
        .bind(media_id)
        .fetch_one(&mut **tx)
        .await?;
        quota::ensure_history_capacity(history_count, if already_recorded { 0 } else { 1 })?;

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

    let (missing_episodes, catalog_episode_count) = sqlx::query_as::<_, (i64, i64)>(
        r#"SELECT
            COUNT(*) FILTER (
                WHERE (e.air_date IS NULL OR e.air_date <= CURRENT_DATE)
                AND NOT EXISTS (
                    SELECT 1 FROM watch_history wh
                    WHERE wh.user_id = $1 AND wh.media_id = $2 AND wh.episode_id = e.id
                )
            ),
            COUNT(*)
        FROM episodes e
        JOIN seasons s ON e.season_id = s.id
        WHERE s.media_id = $2 AND s.season_number > 0
        "#,
    )
    .bind(user_id)
    .bind(media_id)
    .fetch_one(&mut **tx)
    .await?;
    let has_title_history = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM watch_history WHERE user_id = $1 AND media_id = $2
        )",
    )
    .bind(user_id)
    .bind(media_id)
    .fetch_one(&mut **tx)
    .await?;
    let fallback_rows = if catalog_episode_count == 0 && !has_title_history {
        1
    } else {
        0
    };
    quota::ensure_history_capacity(history_count, missing_episodes + fallback_rows)?;

    let inserted = sqlx::query(
        r#"INSERT INTO watch_history (user_id, media_id, episode_id, watched_at)
        SELECT $1, $2, e.id, NOW()
        FROM episodes e
        JOIN seasons s ON e.season_id = s.id
        WHERE s.media_id = $2 AND s.season_number > 0
        AND (e.air_date IS NULL OR e.air_date <= CURRENT_DATE)
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

    let mut tx = pool.begin().await?;
    quota::lock_tracking_writes(&mut tx, user_id).await?;
    let result = sqlx::query("DELETE FROM user_media WHERE id = $1 AND user_id = $2")
        .bind(tracking_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Tracking entry not found".to_string()));
    }
    tx.commit().await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({"message": "Deleted successfully"})))
}
